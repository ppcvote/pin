/**
 * Domain service — the interface layer behind skills/domain (GENESIS P0).
 *
 * Architecture: Pin's SKILL.md only ever talks to THIS stable API. The
 * upstream registrar lives behind the DomainProvider contract below, so the
 * upstream is swappable without touching the skill: Cloudflare today,
 * UDomain/Porkbun tomorrow (GENESIS_BLUEPRINT P1/P2 — the .hk/.tw rail).
 *
 * Money-safety model (環二: real money never moves without the human key):
 *   1. /register demands `confirmed: true` AND a one-time `confirm_token`
 *      minted by a prior single-domain quote (binds domain+years+price shown
 *      in the Pin preview to the order — no token, no charge; price drift
 *      voids the token).
 *   2. The only SKILL.md action that sends those fields is the wizard's
 *      confirm_action, reachable solely via the ✅ button (visibility: hidden
 *      keeps it out of menus, MCP, and Agent Mode).
 *   3. Real charging additionally requires DOMAIN_ALLOW_REAL_REGISTRATION=1;
 *      otherwise /register simulates and says so (sandbox dry-run).
 *
 * Endpoints (bearer DOMAIN_API_KEY on all):
 *   GET  /api/v1/availability?domain=<fqdn>
 *   GET  /api/v1/quote?name=<sld-or-fqdn>            → multi-TLD comparison
 *   GET  /api/v1/quote?domain=<fqdn>&years=<n>       → single quote + confirm_token
 *   POST /api/v1/register {domain, years, confirmed, confirm_token}
 *
 * Run: npm run domain   (requires DOMAIN_API_KEY; provider via DOMAIN_PROVIDER)
 */

import http from 'node:http'
import crypto from 'node:crypto'

const PORT = parseInt(process.env.DOMAIN_PORT ?? '3211', 10)
const API_KEY = process.env.DOMAIN_API_KEY
const PROVIDER_NAME = (process.env.DOMAIN_PROVIDER ?? 'cloudflare').toLowerCase()
const QUOTE_TLDS = (process.env.DOMAIN_QUOTE_TLDS ?? 'com,net,org,io,dev,app,ai')
  .split(',').map(t => t.trim().replace(/^\./, '')).filter(Boolean)
const ALLOW_REAL = process.env.DOMAIN_ALLOW_REAL_REGISTRATION === '1'
const REGISTER_DAILY_CAP = parseInt(process.env.DOMAIN_REGISTER_DAILY_CAP ?? '5', 10)
const TOKEN_TTL_MS = 10 * 60_000

if (!API_KEY) { console.error('[domain] DOMAIN_API_KEY missing'); process.exit(1) }

const DOMAIN_RE = /^(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,}$/i

class ProviderError extends Error {
  constructor(code, detail, status = 503) {
    super(detail)
    this.code = code
    this.status = status
  }
}

// ── Provider contract ─────────────────────────────────────────────────────
// Every provider implements:
//   name                                   string
//   availability(domain) → { available, premium, currency, register_price, renew_price }
//   register(domain, years) → { order_id, status, expires_at }   (REAL MONEY)
// Prices are per-year numbers in `currency`. Throw ProviderError on anything
// the caller should surface verbatim (esp. provider_not_configured).

// ── Cloudflare provider ───────────────────────────────────────────────────
// ⚠ INTEGRATION POINT — currently BLOCKED on credentials:
//   CLOUDFLARE_API_TOKEN   (API token with Registrar permissions)
//   CLOUDFLARE_ACCOUNT_ID  (account that owns the Registrar)
// The endpoint paths below follow the Cloudflare Registrar API surface as
// referenced by GENESIS_BLUEPRINT §0 (2026-H1 agent-ready registrar APIs).
// Before the FIRST real call, verify both paths and the response field
// mapping against the current docs (developers.cloudflare.com/api →
// Registrar) — mapCfAvailability() throws loudly on unrecognized shapes
// instead of guessing.
const CF_API = 'https://api.cloudflare.com/client/v4'

function cfEnv() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const missing = []
  if (!token) missing.push('CLOUDFLARE_API_TOKEN')
  if (!account) missing.push('CLOUDFLARE_ACCOUNT_ID')
  if (missing.length) {
    throw new ProviderError('provider_not_configured', `Cloudflare 憑證未設定: ${missing.join(', ')}`)
  }
  return { token, account }
}

async function cfFetch(path, init = {}) {
  const { token } = cfEnv()
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.success === false) {
    const msg = body?.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`
    throw new ProviderError('upstream_error', `Cloudflare: ${msg}`, res.status >= 500 ? 503 : 502)
  }
  return body
}

function mapCfAvailability(domain, body) {
  const r = body?.result
  // Expected fields per the registrar availability surface; if Cloudflare
  // ships a different shape, fail loudly so the operator updates THIS mapper
  // (the SKILL.md and the rest of this server stay untouched).
  if (!r || typeof r.available !== 'boolean') {
    throw new ProviderError('provider_response_unrecognized',
      `Cloudflare availability response for ${domain} 不是預期形狀 — 更新 mapCfAvailability() 的欄位對應`, 502)
  }
  return {
    available: r.available,
    premium: !!r.premium,
    currency: r.currency ?? 'USD',
    register_price: numOrNull(r.registration_fee ?? r.price),
    renew_price: numOrNull(r.renewal_fee ?? r.renewal_price ?? r.price),
  }
}

const cloudflareProvider = {
  name: 'cloudflare',
  async availability(domain) {
    const { account } = cfEnv()
    const body = await cfFetch(`/accounts/${account}/registrar/domains/${encodeURIComponent(domain)}/availability`)
    return mapCfAvailability(domain, body)
  },
  async register(domain, years) {
    const { account } = cfEnv()
    // ⚠ REAL MONEY. Only reachable with confirmed+confirm_token+ALLOW_REAL.
    const body = await cfFetch(`/accounts/${account}/registrar/domains/${encodeURIComponent(domain)}/register`, {
      method: 'POST',
      body: JSON.stringify({ years, auto_renew: false }),
    })
    const r = body?.result ?? {}
    return {
      order_id: r.id ?? r.order_id ?? 'cf-unknown',
      status: r.status ?? 'submitted',
      expires_at: r.expires_at ?? null,
    }
  },
}

// ── Mock provider (sandbox dogfood — deterministic, no network, no money) ──
const MOCK_PRICES = { com: 10.44, net: 11.71, org: 11.21, io: 48.0, dev: 12.5, app: 16.0, ai: 79.98 }

function mockHash(domain) {
  return crypto.createHash('sha1').update(domain.toLowerCase()).digest()
}

const mockProvider = {
  name: 'mock',
  async availability(domain) {
    const [sld, ...rest] = domain.toLowerCase().split('.')
    const tld = rest.join('.')
    const price = MOCK_PRICES[tld] ?? 19.99
    // Deterministic pseudo-availability (~60%); short names skew premium.
    const available = mockHash(domain)[0] % 5 < 3
    const premium = sld.length <= 3
    return { available, premium, currency: 'USD', register_price: price, renew_price: price }
  },
  async register(domain, _years) {
    return {
      order_id: `mock-${mockHash(domain).toString('hex').slice(0, 12)}`,
      status: 'registered',
      expires_at: null,
    }
  },
}

const PROVIDERS = { cloudflare: cloudflareProvider, mock: mockProvider }
const provider = PROVIDERS[PROVIDER_NAME]
if (!provider) {
  console.error(`[domain] unknown DOMAIN_PROVIDER "${PROVIDER_NAME}" (have: ${Object.keys(PROVIDERS).join(', ')})`)
  process.exit(1)
}

// ── Quote tokens: one-time, short-lived, bound to domain+years+price ──────
const quoteTokens = new Map()

function mintToken(quote) {
  const token = crypto.randomBytes(16).toString('hex')
  quoteTokens.set(token, { ...quote, expiresAt: Date.now() + TOKEN_TTL_MS, used: false })
  // Opportunistic GC
  for (const [t, q] of quoteTokens) if (q.expiresAt < Date.now()) quoteTokens.delete(t)
  return token
}

function consumeToken(token, domain, years) {
  const q = quoteTokens.get(token)
  if (!q || q.used || q.expiresAt < Date.now()) return null
  if (q.domain !== domain || q.years !== years) return null
  q.used = true
  return q
}

// ── Register daily cap ────────────────────────────────────────────────────
let capDay = ''
let capCount = 0
function registerCapExceeded() {
  const today = new Date().toISOString().slice(0, 10)
  if (capDay !== today) { capDay = today; capCount = 0 }
  if (capCount >= REGISTER_DAILY_CAP) return true
  capCount++
  return false
}

// ── Display helpers (precomputed so Pin templates stay tiny) ──────────────
function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function money(currency, n) {
  return n == null ? '?' : `${currency} ${n.toFixed(2)}`
}

function quoteRow(domain, a) {
  if (!a.available) return { domain, available: false, icon: '❌', price_line: '已被註冊' }
  const star = a.premium ? ' ⭐premium' : ''
  return {
    domain,
    available: true,
    icon: '✅',
    price_line: `${money(a.currency, a.register_price)}/年 (續約 ${money(a.currency, a.renew_price)})${star}`,
  }
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────
function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function fail(res, err) {
  if (err instanceof ProviderError) {
    return send(res, err.status, { error: err.code, detail: err.message })
  }
  console.error('[domain] unexpected:', err)
  return send(res, 500, { error: 'internal', detail: String(err?.message ?? err).slice(0, 200) })
}

function normalizeDomain(raw) {
  const d = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return DOMAIN_RE.test(d) ? d : null
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, provider: provider.name, real_registration: ALLOW_REAL })
  }

  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${API_KEY}`) return send(res, 401, { error: 'unauthorized' })

  try {
    // ── availability ──
    if (req.method === 'GET' && url.pathname === '/api/v1/availability') {
      const domain = normalizeDomain(url.searchParams.get('domain'))
      if (!domain) return send(res, 400, { error: 'bad_domain', detail: '請給完整域名, 例如 ultracafe.com' })
      const a = await provider.availability(domain)
      return send(res, 200, {
        data: {
          domain,
          available: a.available,
          taken: !a.available,
          premium: a.premium,
          currency: a.currency,
          register_price: a.register_price,
          renew_price: a.renew_price,
          price_line: quoteRow(domain, a).price_line,
          provider: provider.name,
        },
      })
    }

    // ── quote: single (?domain=&years=) or comparison (?name=) ──
    if (req.method === 'GET' && url.pathname === '/api/v1/quote') {
      const domainParam = url.searchParams.get('domain')
      if (domainParam) {
        const domain = normalizeDomain(domainParam)
        if (!domain) return send(res, 400, { error: 'bad_domain', detail: '請給完整域名, 例如 ultracafe.com' })
        const years = Math.min(Math.max(parseInt(url.searchParams.get('years') ?? '1', 10) || 1, 1), 10)
        const a = await provider.availability(domain)
        if (!a.available) {
          return send(res, 200, { data: { domain, available: false, taken: true, provider: provider.name } })
        }
        const total = a.register_price == null ? null : Math.round(a.register_price * years * 100) / 100
        const confirm_token = mintToken({ domain, years, total, currency: a.currency })
        return send(res, 200, {
          data: {
            domain, years, available: true, taken: false, premium: a.premium,
            currency: a.currency,
            register_price: a.register_price,
            renew_price: a.renew_price,
            total,
            total_line: `${money(a.currency, total)} (${years} 年)`,
            renew_line: `${money(a.currency, a.renew_price)}/年`,
            sandbox: !ALLOW_REAL,
            provider: provider.name,
            confirm_token,
          },
        })
      }

      const rawName = String(url.searchParams.get('name') ?? '').trim().toLowerCase()
      const sld = rawName.replace(/^https?:\/\//, '').split('/')[0].split('.')[0]
      if (!/^[a-z0-9¡-￿][a-z0-9¡-￿-]{0,62}$/.test(sld)) {
        return send(res, 400, { error: 'bad_name', detail: '請給一個名字, 例如 ultracafe' })
      }
      const quotes = []
      for (const tld of QUOTE_TLDS) {
        const domain = `${sld}.${tld}`
        try {
          quotes.push(quoteRow(domain, await provider.availability(domain)))
        } catch (err) {
          if (err instanceof ProviderError && err.code === 'provider_not_configured') throw err
          quotes.push({ domain, available: false, icon: '⚠️', price_line: '查詢失敗' })
        }
      }
      return send(res, 200, { data: { name: sld, provider: provider.name, quotes } })
    }

    // ── register (REAL MONEY behind three locks) ──
    if (req.method === 'POST' && url.pathname === '/api/v1/register') {
      const body = await readJson(req)
      const domain = normalizeDomain(body?.domain)
      const years = Math.min(Math.max(parseInt(body?.years ?? '1', 10) || 1, 1), 10)
      if (!domain) return send(res, 400, { error: 'bad_domain' })
      if (body?.confirmed !== true) {
        return send(res, 409, { error: 'confirmation_required', detail: '註冊必須帶 confirmed:true — 由 Pin 確認鍵發出' })
      }
      const quote = consumeToken(String(body?.confirm_token ?? ''), domain, years)
      if (!quote) {
        return send(res, 409, { error: 'quote_expired', detail: '報價已過期或不符 — 請重新跑一次註冊流程拿新預覽' })
      }
      if (registerCapExceeded()) {
        return send(res, 429, { error: 'daily_cap', detail: `今天的註冊次數已達上限 (${REGISTER_DAILY_CAP})` })
      }
      if (!ALLOW_REAL) {
        console.log(`[domain] SANDBOX register ${domain} x${years}y (${money(quote.currency, quote.total)})`)
        return send(res, 200, {
          data: {
            domain, years, sandbox: true, registered: false,
            order_id: `sandbox-${crypto.randomBytes(4).toString('hex')}`,
            total_line: `${money(quote.currency, quote.total)} (${years} 年)`,
            provider: provider.name,
          },
        })
      }
      const r = await provider.register(domain, years)
      console.log(`[domain] REGISTERED ${domain} x${years}y via ${provider.name} order=${r.order_id}`)
      return send(res, 200, {
        data: {
          domain, years, sandbox: false, registered: true,
          order_id: r.order_id, status: r.status, expires_at: r.expires_at,
          total_line: `${money(quote.currency, quote.total)} (${years} 年)`,
          provider: provider.name,
        },
      })
    }

    return send(res, 404, { error: 'not_found' })
  } catch (err) {
    return fail(res, err)
  }
})

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 64_000) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[domain] online :${PORT} · provider=${provider.name} · real_registration=${ALLOW_REAL ? 'ARMED' : 'sandbox'}`)
})
