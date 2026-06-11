import http from 'node:http'
import crypto from 'node:crypto'
import { findWebhook } from '../platform/registry.js'
import { render } from '../platform/template.js'
import type { Channel, Button } from '../channels/types.js'

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

function verifySignature(secretEnvName: string | undefined, body: string, headerSig: string | undefined): boolean {
  if (!secretEnvName) return true  // no secret required → accept (dev mode)
  const secret = process.env[secretEnvName]
  if (!secret) {
    console.warn(`[webhook] secret env var "${secretEnvName}" missing — rejecting`)
    return false
  }
  if (!headerSig) {
    console.warn(`[webhook] missing X-Pin-Signature header`)
    return false
  }
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  const provided = headerSig.replace(/^sha256=/, '')
  if (expected !== provided) {
    console.warn(`[webhook] sig mismatch: expected=${expected.slice(0,16)}... provided=${provided.slice(0,16)}... bodyLen=${body.length}`)
    return false
  }
  return true
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
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'pin', version: '0.1.0' }))
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

    // Read body
    let body = ''
    for await (const chunk of req) body += chunk
    if (body.length > 1_000_000) {  // 1 MB cap
      res.writeHead(413)
      res.end()
      return
    }

    // Lookup webhook spec
    const found = findWebhook(skillId, event)
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown_webhook', skill: skillId, event }))
      return
    }
    const { skill, webhook } = found

    // Verify signature
    const sig = req.headers['x-pin-signature'] as string | undefined
    if (!verifySignature(webhook.secret, body, sig)) {
      console.warn(`[webhook] bad sig: skill=${skillId} event=${event}`)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad_signature' }))
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

    try {
      await channel.sendDirect(userKey.userId, text, buttons)
      console.log(`[webhook] delivered skill=${skillId} event=${event} → ${userKey.channelId}:${userKey.userId}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, delivered_to: payload.pin_user_id }))
    } catch (err) {
      console.error('[webhook] delivery error', err)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'delivery_failed' }))
    }
  })

  server.listen(PORT, () => {
    console.log(`[webhook] HTTP server listening on :${PORT}`)
    console.log(`[webhook] events:`)
    // We can't import registry here without circular — caller can list separately
  })

  return server
}
