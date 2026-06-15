import http from 'node:http'
import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findWebhook } from '../platform/registry.js'
import { render } from '../platform/template.js'
import { deliverWithRetry } from '../runtime/deliver.js'
import { consumeBindingToken } from '../platform/binding.js'
import { createBindToken } from '../storage/bindTokens.js'
import { shortenCallback } from '../runtime/callbackRefs.js'
import { findSkill } from '../platform/registry.js'
import { readByName } from '../runtime/tempStore.js'
import type { Channel, Button } from '../channels/types.js'
import type { LineChannel } from '../channels/line.js'
import type { WhatsAppChannel } from '../channels/whatsapp.js'

const PORT = parseInt(process.env.PIN_HTTP_PORT ?? '3000', 10)

// §A: /bind/token issuance is capped at 60/hour per skill (in-memory —
// single-process runtime, resets on restart, which is acceptable here).
const BIND_TOKEN_HOURLY_CAP = 60
const bindTokenRate = new Map<string, { hourBucket: string; count: number }>()

function bindTokenRateExceeded(skillName: string): boolean {
  const hourBucket = new Date().toISOString().slice(0, 13)
  const rl = bindTokenRate.get(skillName)
  const count = rl?.hourBucket === hourBucket ? rl.count : 0
  if (count >= BIND_TOKEN_HOURLY_CAP) return true
  bindTokenRate.set(skillName, { hourBucket, count: count + 1 })
  return false
}

interface InboundPayload {
  /** Pin user identifier — channel-qualified: "tg:781284060", "discord:abc" */
  pin_user_id: string
  /** Event-specific payload — referenced by webhook.notify.template as {{data.X}} */
  data: Record<string, any>
}

function parseUserKey(pinUserId: string): { channelId: string; userId: string } | null {
  const idx = pinUserId.indexOf(':')
  if (idx < 1) return null
  return { channelId: pinUserId.slice(0, idx), userId: pinUserId.slice(idx + 1) }
}

/**
 * Webhook signature verification — MANDATORY per PIN_DIRECTION §P1.
 * A skill that declares a webhook MUST also declare a `secret:` env var name,
 * and that secret MUST be set + match the signed body. No opt-out.
 */
function verifySignature(secretEnvName: string | undefined, bodyBuf: Buffer, headerSig: string | undefined): { ok: boolean; reason?: string } {
  if (!secretEnvName) {
    console.error(`[webhook] CONFIG: webhook spec missing required "secret:" field — rejecting`)
    return { ok: false, reason: 'webhook_secret_not_declared' }
  }
  const secret = process.env[secretEnvName]
  if (!secret) {
    console.error(`[webhook] CONFIG: env var "${secretEnvName}" not set — rejecting`)
    return { ok: false, reason: 'webhook_secret_missing' }
  }
  if (!headerSig) {
    console.error(`[webhook] missing X-Pin-Signature header`)
    return { ok: false, reason: 'missing_signature' }
  }
  const expected = crypto.createHmac('sha256', secret).update(bodyBuf).digest('hex')
  const provided = headerSig.replace(/^sha256=/, '')
  // Timing-safe compare — equal-length Buffers required, so length-check first
  // (a length mismatch is already a mismatch, and timingSafeEqual throws on it).
  const expBuf = Buffer.from(expected, 'hex')
  const provBuf = Buffer.from(provided, 'hex')
  if (expBuf.length !== provBuf.length || !crypto.timingSafeEqual(expBuf, provBuf)) {
    console.error(`[webhook] sig mismatch: bytes=${bodyBuf.length}`)
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}

/**
 * Verify Meta's X-Hub-Signature-256 header (PIN_WHATSAPP §2).
 * Must be called with raw body bytes, before any JSON parsing.
 * Uses timing-safe comparison to resist HMAC oracle attacks.
 */
export function verifyWaSignature(
  appSecret: string,
  rawBody: Buffer,
  hubSig: string | undefined,
): boolean {
  if (!hubSig) return false
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const provided = hubSig.startsWith('sha256=') ? hubSig.slice(7) : hubSig
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(provided, 'utf-8'))
  } catch {
    return false
  }
}

function renderButtons(buttons: any[] | undefined, skillId: string, scope: any): Button[][] | undefined {
  if (!buttons || buttons.length === 0) return undefined
  const out: Button[][] = []
  for (let i = 0; i < buttons.length; i += 2) {
    const row: Button[] = [renderButton(buttons[i], skillId, scope)]
    if (buttons[i + 1]) row.push(renderButton(buttons[i + 1], skillId, scope))
    out.push(row)
  }
  return out
}

function renderButton(b: any, skillId: string, scope: any): Button {
  if (b.url) {
    return { text: render(b.label, scope), url: render(b.url, scope) }
  }
  if (b.action) {
    const argsEntries = Object.entries(b.args ?? {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(render(v as string, scope))}`)
    let cb = `a:${skillId}:${b.action}`
    if (argsEntries.length) cb += `?${argsEntries.join('&')}`
    return { text: render(b.label, scope), callback_data: shortenCallback(cb) }
  }
  return { text: render(b.label, scope), callback_data: 'm:root' }
}

export function startWebhookServer(channels: Channel[], port: number = PORT): http.Server {
  const channelById = new Map(channels.map(c => [c.id, c]))

  const server = http.createServer(async (req, res) => {
    console.log(`[http] ${req.method} ${req.url} ua=${(req.headers['user-agent'] ?? '').slice(0, 60)}`)

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'pin', version: '0.1.0' }))
      return
    }

    // Anchor endpoint for link-menu skills (apply flow). The executor requires a
    // 2xx-JSON api call before rendering buttons; user skills point here so they
    // need no backend of their own. Loopback-only; carries no data.
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // Public scratch-blob endpoint — serves files written by tempStore.saveTempBlob.
    // Used by LINE image messaging (it can't accept raw bytes, needs an HTTPS URL).
    // Random filenames + 30-min TTL provide adequate URL-as-secret protection;
    // the path-traversal guard sits inside readByName.
    // Generated decks (skills/slides) — shareable artifacts with a 7-day
    // life, served from data/decks (slides-server owns cleanup).
    const deckPath = (req.url ?? '').split('?')[0]
    const deckMatch = req.method === 'GET' && deckPath.match(/^\/deck\/([a-z0-9._-]+)$/i)
    if (deckMatch) {
      const name = deckMatch[1]
      const file = join(process.cwd(), 'data', 'decks', name)
      const mime = name.endsWith('.html') ? 'text/html; charset=utf-8'
        : name.endsWith('.pdf') ? 'application/pdf'
        : name.endsWith('.png') ? 'image/png'
        : null
      if (!mime || name.includes('..') || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'deck_not_found_or_expired' }))
        return
      }
      const data = readFileSync(file)
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=3600',
      })
      res.end(data)
      return
    }

    // Match on pathname only — cache-busting query strings (?v=) must not 404.
    const imgPath = (req.url ?? '').split('?')[0]
    const imgMatch = req.method === 'GET' && imgPath.match(/^\/image\/([a-z0-9._-]+)$/i)
    if (imgMatch) {
      const blob = readByName(imgMatch[1])
      if (!blob) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': blob.mime,
        'Content-Length': blob.data.length,
        'Cache-Control': 'public, max-age=600',
      })
      res.end(blob.data)
      return
    }

    // PIN_ONBOARDING §A — product-initiated bind token. Returns {token, expiresAt}.
    // Auth: productApiKey must match the skill's webhook secret env var.
    if (req.method === 'POST' && req.url === '/bind/token') {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer)
        total += buf.length
        if (total > 4096) { res.writeHead(413); res.end(); return }
        chunks.push(buf)
      }
      let payload: { skillName?: string; tenantKey?: string; productApiKey?: string; meta?: Record<string, any> }
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      if (!payload.skillName || !payload.tenantKey || !payload.productApiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'skillName_tenantKey_productApiKey_required' }))
        return
      }
      const skill = findSkill(payload.skillName)
      if (!skill) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown_skill' }))
        return
      }
      // Verify the productApiKey: use the first declared webhook secret on the skill
      // (skills that don't ship webhooks can't issue bind tokens — they have nothing to push)
      const secretEnvName = skill.pin?.webhooks?.[0]?.secret
      if (!secretEnvName) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'skill_does_not_support_binding' }))
        return
      }
      const expected = process.env[secretEnvName]
      if (!expected || expected !== payload.productApiKey) {
        console.warn(`[bind/token] auth fail skill=${payload.skillName}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad_product_api_key' }))
        return
      }
      // Rate limit counts only authenticated requests, so a key-less
      // attacker can't exhaust a legit product's quota.
      if (bindTokenRateExceeded(payload.skillName)) {
        console.warn(`[bind/token] rate-limited skill=${payload.skillName} (${BIND_TOKEN_HOURLY_CAP}/hr)`)
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 3600 }))
        return
      }
      const entry = await createBindToken(payload.skillName, payload.tenantKey, payload.meta)
      // tenantKey is a per-tenant secret — log only its presence, never the value.
      console.log(`[bind/token] issued skill=${entry.skillName} tenant=${entry.tenantKey ? 'set' : 'none'} ttl_min=10${payload.meta ? ' (with meta)' : ''}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token: entry.token, expiresAt: entry.expiresAt }))
      return
    }

    // Binding code consumption — POST /webhooks/_bind {token}
    if (req.method === 'POST' && req.url === '/webhooks/_bind') {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer)
        total += buf.length
        if (total > 4096) { res.writeHead(413); res.end(); return }
        chunks.push(buf)
      }
      let body: { token?: string }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      if (!body.token || typeof body.token !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'token_required' }))
        return
      }
      const result = await consumeBindingToken(body.token.trim())
      if (!result) {
        console.warn(`[bind] invalid or expired token: ${body.token.slice(0, 4)}...`)
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_or_expired_token' }))
        return
      }
      console.log(`[bind] consumed token → pin_user_id=${result.pin_user_id} skill=${result.skill_id}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    // WhatsApp verify handshake — GET /whatsapp/webhook
    // Meta pings this endpoint to confirm webhook ownership (hub.challenge round-trip).
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/whatsapp/webhook') {
      const qs = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      const mode = qs.get('hub.mode')
      const token = qs.get('hub.verify_token')
      const challenge = qs.get('hub.challenge')
      const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN
      if (mode === 'subscribe' && verifyToken && token === verifyToken && challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(challenge)
      } else {
        res.writeHead(403)
        res.end()
      }
      return
    }

    // WhatsApp inbound — POST /whatsapp/webhook
    // Sig verification (X-Hub-Signature-256) uses raw body bytes, then dispatches to the adapter.
    if (req.method === 'POST' && req.url === '/whatsapp/webhook') {
      const waCh = channelById.get('whatsapp') as WhatsAppChannel | undefined
      if (!waCh) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'whatsapp_channel_not_configured' }))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer)
        total += buf.length
        if (total > 1_000_000) { res.writeHead(413); res.end(); return }
        chunks.push(buf)
      }
      const rawBody = Buffer.concat(chunks)
      const appSecret = process.env.WHATSAPP_APP_SECRET
      if (!appSecret) {
        console.error('[wa webhook] WHATSAPP_APP_SECRET not set — rejecting')
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'configuration_error' }))
        return
      }
      const hubSig = req.headers['x-hub-signature-256'] as string | undefined
      if (!verifyWaSignature(appSecret, rawBody, hubSig)) {
        console.warn('[wa webhook] signature rejected')
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad_signature' }))
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody.toString('utf-8'))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      const result = await waCh.handleWebhook(parsed)
      if (!result.ok) {
        console.warn(`[wa webhook] dispatch error: ${result.reason}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: result.reason }))
        return
      }
      res.writeHead(200)
      res.end('OK')
      return
    }

    // LINE inbound — POST /line/webhook
    if (req.method === 'POST' && req.url === '/line/webhook') {
      const lineCh = channelById.get('line') as LineChannel | undefined
      if (!lineCh) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'line_channel_not_configured' }))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer)
        total += buf.length
        if (total > 1_000_000) { res.writeHead(413); res.end(); return }
        chunks.push(buf)
      }
      const bodyStr = Buffer.concat(chunks).toString('utf-8')
      const sig = req.headers['x-line-signature'] as string | undefined
      const result = await lineCh.handleWebhook(bodyStr, sig)
      if (!result.ok) {
        console.warn(`[line webhook] rejected: ${result.reason}`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: result.reason }))
        return
      }
      res.writeHead(200)
      res.end('OK')
      return
    }

    // POST /webhooks/:skill/:event
    const match = req.url?.match(/^\/webhooks\/([a-z0-9-]+)\/([a-z0-9._-]+)$/i)
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    const [, skillId, event] = match

    // Read body as raw bytes (avoid mid-codepoint UTF-8 corruption + preserve exact bytes for HMAC)
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer)
      total += buf.length
      if (total > 1_000_000) {  // 1 MB cap
        res.writeHead(413)
        res.end()
        return
      }
      chunks.push(buf)
    }
    const bodyBuf = Buffer.concat(chunks)
    const body = bodyBuf.toString('utf-8')

    // Lookup webhook spec
    const found = findWebhook(skillId, event)
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown_webhook', skill: skillId, event }))
      return
    }
    const { skill, webhook } = found

    // Verify signature (over raw bytes, not the decoded string)
    const sig = req.headers['x-pin-signature'] as string | undefined
    const sigResult = verifySignature(webhook.secret, bodyBuf, sig)
    if (!sigResult.ok) {
      console.error(`[webhook] REJECTED: skill=${skillId} event=${event} reason=${sigResult.reason}`)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: sigResult.reason }))
      return
    }

    let payload: InboundPayload
    try {
      payload = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_json' }))
      return
    }

    const userKey = parseUserKey(payload.pin_user_id ?? '')
    if (!userKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_pin_user_id', hint: 'use "<channel>:<id>" format e.g. "tg:781284060"' }))
      return
    }

    const channel = channelById.get(userKey.channelId)
    if (!channel) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'channel_not_supported', channel: userKey.channelId }))
      return
    }

    // Render notification text + buttons from scope
    const scope = { data: payload.data ?? {}, ...payload.data ?? {} }
    let text: string
    let buttons: Button[][] | undefined
    try {
      text = render(webhook.notify.template, scope)
      buttons = renderButtons(webhook.notify.buttons, skill.id, scope)
    } catch (err) {
      console.error('[webhook] render error', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'render_failed' }))
      return
    }

    const composite = `${userKey.channelId}:${userKey.userId}`
    const delivery = await deliverWithRetry(channel, composite, userKey.userId, text, buttons)
    if (delivery.ok) {
      console.log(`[webhook] delivered skill=${skillId} event=${event} → ${composite} (attempts=${delivery.attempts})`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, delivered_to: payload.pin_user_id, attempts: delivery.attempts }))
    } else {
      console.error(`[webhook] dead-letter skill=${skillId} event=${event} → ${composite}: ${delivery.error}`)
      res.writeHead(202, { 'Content-Type': 'application/json' })  // accepted but queued
      res.end(JSON.stringify({ ok: false, queued: true, attempts: delivery.attempts, error: delivery.error }))
    }
  })

  server.listen(port, () => {
    console.log(`[webhook] HTTP server listening on :${port}`)
    console.log(`[webhook] events:`)
    // We can't import registry here without circular — caller can list separately
  })

  return server
}
