/**
 * SSRF-guarded page fetcher for the self-serve apply flow.
 *
 * The ONLY point where a user-supplied URL makes the Pin host send an outbound
 * request *before* a human has approved anything. Everything here exists to stop
 * that becoming an internal-network probe / open proxy / metadata-endpoint leak.
 *
 * Guarantees:
 *   - https only
 *   - DNS-resolve the host, reject if it (or any redirect hop) resolves to a
 *     private / loopback / link-local / CGNAT / cloud-metadata range
 *   - response size cap + timeout
 *   - at most MAX_REDIRECTS hops, each re-validated
 *
 * Returns extracted, bounded signals (title / description / same-origin links) —
 * NOT raw full HTML — to keep the downstream LLM's injection surface small.
 */

import { lookup } from 'node:dns/promises'
import https from 'node:https'
import { URL } from 'node:url'

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 2
const MAX_LINKS = 40

export interface PageSignals {
  origin: string          // "https://host" (no trailing slash)
  finalUrl: string
  title: string
  description: string
  /** Same-origin absolute URLs discovered on the page (deduped, capped). */
  links: { href: string; text: string }[]
}

export class UnsafeUrlError extends Error {}

/** True if an IPv4/IPv6 literal is in a range we must never fetch. */
export function isBlockedAddress(addr: string): boolean {
  const a = addr.toLowerCase()
  // IPv6
  if (a.includes(':')) {
    if (a === '::1' || a === '::') return true                 // loopback / unspecified
    if (a.startsWith('fe80')) return true                      // link-local
    if (a.startsWith('fc') || a.startsWith('fd')) return true  // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) → check the embedded v4
    const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (m) return isBlockedAddress(m[1])
    return false
  }
  // IPv4
  const o = a.split('.').map(Number)
  if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed → block
  const [p, q] = o
  if (p === 0) return true                       // 0.0.0.0/8
  if (p === 10) return true                      // 10/8
  if (p === 127) return true                     // loopback
  if (p === 169 && q === 254) return true        // link-local + cloud metadata 169.254.169.254
  if (p === 172 && q >= 16 && q <= 31) return true // 172.16/12
  if (p === 192 && q === 168) return true        // 192.168/16
  if (p === 100 && q >= 64 && q <= 127) return true // CGNAT 100.64/10
  if (p >= 224) return true                      // multicast / reserved
  return false
}

/** Parse + validate a candidate URL, resolving DNS and checking every address. */
async function assertFetchable(rawUrl: string): Promise<URL> {
  let u: URL
  try { u = new URL(rawUrl) } catch { throw new UnsafeUrlError('網址格式不正確') }
  if (u.protocol !== 'https:') throw new UnsafeUrlError('只接受 https 網址')
  if (!u.hostname) throw new UnsafeUrlError('網址缺少主機名')
  // Literal IPs are checked directly; hostnames are DNS-resolved (all addresses).
  const records = await lookup(u.hostname, { all: true }).catch(() => {
    throw new UnsafeUrlError('無法解析這個網址的主機')
  })
  if (!records.length) throw new UnsafeUrlError('無法解析這個網址的主機')
  for (const r of records) {
    if (isBlockedAddress(r.address)) throw new UnsafeUrlError('這個網址指向內部位址，不能接受')
  }
  return u
}

function getRaw(url: URL): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'PinApplyBot/1.0', Accept: 'text/html' } }, res => {
      const status = res.statusCode ?? 0
      const ct = String(res.headers['content-type'] ?? '')
      // Redirects are handled by the caller (must re-validate the target).
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, headers: res.headers, body: '' }); return }
      if (status !== 200) { res.resume(); reject(new UnsafeUrlError(`網站回應 ${status}`)); return }
      if (ct && !ct.includes('text/html') && !ct.includes('text/plain')) { res.resume(); reject(new UnsafeUrlError('這個網址不是網頁')); return }
      let size = 0
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BYTES) { req.destroy(); reject(new UnsafeUrlError('網頁太大')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('timeout', () => { req.destroy(); reject(new UnsafeUrlError('讀取網頁逾時')) })
    req.on('error', err => reject(new UnsafeUrlError(`讀取失敗: ${err.message}`)))
  })
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
}

function extract(html: string, origin: string): Omit<PageSignals, 'origin' | 'finalUrl'> {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const ogTitleM = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
  const title = decodeEntities(ogTitleM?.[1] ?? titleM?.[1] ?? '').slice(0, 120)
  const description = decodeEntities(descM?.[1] ?? '').slice(0, 240)

  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  const anchorRe = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) && links.length < MAX_LINKS) {
    let href = m[1].trim()
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    let abs: string
    try { abs = new URL(href, origin + '/').toString() } catch { continue }
    if (!abs.startsWith(origin)) continue          // same-origin only
    abs = abs.split('#')[0]
    if (seen.has(abs)) continue
    seen.add(abs)
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).slice(0, 60)
    links.push({ href: abs, text })
  }
  return { title, description, links }
}

/** Fetch + validate + extract. Throws UnsafeUrlError with a user-safe message. */
export async function fetchPageSignals(rawUrl: string): Promise<PageSignals> {
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertFetchable(current)
    const res = await getRaw(u)
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers['location']
      if (!loc) throw new UnsafeUrlError('網站回應異常的轉址')
      current = new URL(String(loc), u).toString()
      continue
    }
    const origin = `${u.protocol}//${u.host}`
    return { origin, finalUrl: u.toString(), ...extract(res.body, origin) }
  }
  throw new UnsafeUrlError('轉址太多次')
}
