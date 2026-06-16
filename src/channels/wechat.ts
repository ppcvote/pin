/**
 * WeChat Official Account (服務號) adapter — PIN_PLATFORM_SPEC §6 channel adapter.
 *
 * Target: an overseas-verified Service Account (海外服務號, registered under a
 * Hong Kong / Taiwan entity, US$99/yr WeChat Verification). Audience = Hong Kong
 * (UD market), so the reply path stays reactive customer-service framing.
 *
 * Protocol (明文模式 / plaintext):
 *   - GET  /wechat  — server-config handshake: verify sha1(token,timestamp,nonce)
 *                     against `signature`, echo back `echostr`.
 *   - POST /wechat  — inbound message as XML. Verify signature, parse, route to
 *                     the channel-agnostic MessageHandler, reply.
 *
 * Reply strategy:
 *   - PASSIVE REPLY (this file's handleWebhook): respond to the POST with reply
 *     XML. Must return within ~5s — fine for deterministic Pin replies (menu,
 *     welcome, card flows).
 *   - 客服 ASYNC (sendCustomText / sendDirect): for slow LLM replies, return ''
 *     to the POST immediately and push via the Customer Service Message API
 *     within the 48-hour window. Implemented here; production wiring chooses.
 *
 * Encrypted mode (安全模式, AES + msg_signature) is a Phase-2 add; plaintext is
 * sufficient to prove the path and to run a verified account behind HTTPS.
 */
import crypto from 'node:crypto'
import type { Button, Channel, MessageHandler, InboundMessage } from './types.js'
import { loadUser, saveUser, ensureUser } from '../storage/jsonStore.js'

const API_BASE = 'https://api.weixin.qq.com/cgi-bin'
const WINDOW_MS = 48 * 60 * 60 * 1000 // 客服訊息 48 小時自由回覆窗

// ── Signature ────────────────────────────────────────────────────────────────
/** WeChat server-config + message signature: sha1 of sorted [token,timestamp,nonce]. */
export function checkSignature(token: string, signature: string, timestamp: string, nonce: string): boolean {
  if (!token || !signature || !timestamp || !nonce) return false
  const expected = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  if (expected.length !== signature.length) return false
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase())) } catch { return false }
}

// ── Minimal XML (明文模式) ────────────────────────────────────────────────────
/** Extract a single tag's inner text, unwrapping CDATA. */
export function xmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`))
  return (m ? (m[1] ?? m[2] ?? '') : '').trim()
}

export interface WxInbound {
  fromUser: string   // sender openid (stable per-account user id)
  toUser: string     // the OA's id
  msgType: string    // text | image | event | voice ...
  content: string    // text body
  event?: string     // subscribe | unsubscribe | CLICK ...
  eventKey?: string
  createTime: string
  msgId?: string
}

export function parseInboundXml(xml: string): WxInbound {
  return {
    fromUser: xmlField(xml, 'FromUserName'),
    toUser: xmlField(xml, 'ToUserName'),
    msgType: xmlField(xml, 'MsgType'),
    content: xmlField(xml, 'Content'),
    event: xmlField(xml, 'Event') || undefined,
    eventKey: xmlField(xml, 'EventKey') || undefined,
    createTime: xmlField(xml, 'CreateTime'),
    msgId: xmlField(xml, 'MsgId') || undefined,
  }
}

/** Passive-reply text XML (the OA replies as `fromUser`, to the `toUser` openid). */
export function buildReplyXml(toUser: string, fromUser: string, text: string, createTime = Math.floor(Date.now() / 1000)): string {
  const safe = text.replace(/]]>/g, ']]&gt;')
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName>` +
    `<CreateTime>${createTime}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${safe}]]></Content></xml>`
}

/**
 * Downgrade Pin's channel-agnostic buttons into WeChat text.
 * WeChat 客服/passive text has no inline callback buttons — url buttons become
 * links (auto-linkified in-app), callback buttons become typeable hint lines.
 */
export function flattenButtons(text: string, buttons?: Button[][]): string {
  if (!buttons?.length) return text
  let out = text
  for (const b of buttons.flat()) {
    if (b.url) out += `\n${b.text}：${b.url}`
    else out += `\n• ${b.text}`
  }
  return out
}

// ── Channel ──────────────────────────────────────────────────────────────────
export class WeChatChannel implements Channel {
  readonly id = 'wechat'
  readonly name = 'WeChat'
  private handler: MessageHandler | null = null
  private tokenCache: { token: string; exp: number } | null = null

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly verifyToken: string,
  ) {}

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler // inbound arrives via /wechat webhook (wired in server)
  }
  async stop(): Promise<void> {}

  /** GET handshake — returns echostr to echo back, or null to reject. */
  verify(signature: string, timestamp: string, nonce: string, echostr: string): string | null {
    return checkSignature(this.verifyToken, signature, timestamp, nonce) ? echostr : null
  }

  /**
   * POST inbound → passive-reply XML (or '' to ack with no reply).
   * Verifies the signature first; '' is returned for unverified / non-text / no-reply.
   */
  async handleWebhook(rawXml: string, q: { signature: string; timestamp: string; nonce: string }): Promise<string> {
    if (!checkSignature(this.verifyToken, q.signature, q.timestamp, q.nonce)) return ''
    const inb = parseInboundXml(rawXml)
    if (!this.handler) return ''

    // Events: greet on subscribe, ack the rest.
    if (inb.msgType === 'event') {
      if (inb.event === 'subscribe') {
        const reply = await this.handler(this.toInbound(inb, '哈囉')).catch(() => null)
        if (reply) return buildReplyXml(inb.fromUser, inb.toUser, flattenButtons(reply.text, reply.buttons))
      }
      return ''
    }
    if (inb.msgType !== 'text') return '' // image/voice/etc. — Phase 2

    await this.recordInbound(inb.fromUser).catch(err => console.error('[wx inbound record]', err))
    const reply = await this.handler(this.toInbound(inb, inb.content))
    if (!reply) return ''
    return buildReplyXml(inb.fromUser, inb.toUser, flattenButtons(reply.text, reply.buttons))
  }

  private toInbound(inb: WxInbound, text: string): InboundMessage {
    return { channelId: this.id, userId: inb.fromUser, userDisplayName: inb.fromUser, text, rawCtx: inb }
  }

  /** Unsolicited push (reminders / lead-notify). 客服 API, requires the 48h window open. */
  async sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void> {
    if (!(await this.isWindowOpen(userId))) {
      // 48h window closed → 模板訊息 (template message) required; Phase 2.
      console.warn(`[wx] 48h window closed for ${userId}; template message needed (Phase 2)`)
      return
    }
    await this.sendCustomText(userId, flattenButtons(text, buttons))
  }

  /** WeChat needs a media_id (upload first) for images — Phase 2; stub keeps the interface. */
  async sendImage(_userId: string, _png: Buffer, _imageUrl: string, _caption?: string): Promise<void> {
    console.warn('[wx] sendImage not implemented (needs media upload) — Phase 2')
  }

  // ── 客服 Customer Service Message API ──
  private async sendCustomText(openid: string, content: string): Promise<void> {
    const token = await this.getAccessToken()
    const res = await fetch(`${API_BASE}/message/custom/send?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content: content.slice(0, 2048) } }),
    })
    const d = await res.json().catch(() => ({} as any))
    if (d.errcode && d.errcode !== 0) throw new Error(`wx custom send ${d.errcode}: ${d.errmsg}`)
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.exp > Date.now() + 60_000) return this.tokenCache.token
    const res = await fetch(`${API_BASE}/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`)
    const d = await res.json() as any
    if (!d.access_token) throw new Error(`wx token error: ${JSON.stringify(d)}`)
    this.tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in ?? 7200) * 1000 }
    return d.access_token
  }

  // ── 48h window state (mirrors the WhatsApp 24h pattern) ──
  private async recordInbound(openid: string): Promise<void> {
    const u = await ensureUser(`wechat:${openid}`, openid)
    u.wx_last_inbound = new Date().toISOString()
    await saveUser(u)
  }
  private async isWindowOpen(openid: string): Promise<boolean> {
    const u = await loadUser(`wechat:${openid}`)
    if (!u?.wx_last_inbound) return false
    return Date.now() - new Date(u.wx_last_inbound).getTime() < WINDOW_MS
  }
}
