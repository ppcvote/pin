import http from 'node:http'
import crypto from 'node:crypto'
import { findWebhook } from '../platform/registry.js'
import { render } from '../platform/template.js'
import { deliverWithRetry } from '../runtime/deliver.js'
import { consumeBindingToken } from '../platform/binding.js'
import type { Channel, Button } from '../channels/types.js'
import type { LineChannel } from '../channels/line.js'

const PORT = parseInt(process.env.PIN_HTTP_PORT ?? '3000', 10)

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
  if (expected !== provided) {
    console.error(`[webhook] sig mismatch: expected=${expected.slice(0,16)}... provided=${provided.slice(0,16)}... bytes=${bodyBuf.length}`)
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
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
    if (Buffer.byteLength(cb) > 64) cb = cb.slice(0, 64)
    return { text: render(b.label, scope), callback_data: cb }
  }
  return { text: render(b.label, scope), callback_data: 'm:root' }
}

export function startWebhookServer(channels: Channel[]): http.Server {
  const channelById = new Map(channels.map(c => [c.id, c]))

  const server = http.createServer(async (req, res) => {
    console.log(`[http] ${req.method} ${req.url} ua=${(req.headers['user-agent'] ?? '').slice(0, 60)}`)

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'pin', version: '0.1.0' }))
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

  server.listen(PORT, () => {
    console.log(`[webhook] HTTP server listening on :${PORT}`)
    console.log(`[webhook] events:`)
    // We can't import registry here without circular — caller can list separately
  })

  return server
}
