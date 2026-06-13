import type { Button, Channel, MessageHandler, InboundMessage } from './types.js'
import { loadUser, saveUser, ensureUser } from '../storage/jsonStore.js'

const GRAPH_API_VERSION = 'v19.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

// ── Formatting ────────────────────────────────────────────────────────────────

/** Map Pin markdown to WhatsApp native formatting (minimal subset). */
export function toWaText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')  // **bold** → *bold*
    .replace(/__(.+?)__/g, '_$1_')        // __italic__ → _italic_
}

// ── Button downgrade ──────────────────────────────────────────────────────────

/**
 * Build a WhatsApp API message body from Pin's channel-agnostic reply shape.
 *
 * Button downgrade rules (PIN_WHATSAPP §2):
 *  - URL buttons → "title: url" appended to body text (no interactive equivalent)
 *  - ≤3 callback buttons → reply buttons  (interactive.type="button")
 *  - 4–10 callback buttons → list message (interactive.type="list")
 *  - >10 callback buttons → first 9 + "更多 ▸" sentinel (pagination Phase 2)
 */
export function buildPayload(
  to: string,
  text: string,
  buttons?: Button[][],
): Record<string, unknown> {
  const waText = toWaText(text)

  if (!buttons || buttons.length === 0) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: waText.slice(0, 4096) },
    }
  }

  const flat = buttons.flat()
  const urlBtns = flat.filter(b => !!b.url)
  const cbBtns  = flat.filter(b => !b.url)

  // URL buttons → plain text links appended to the body; skill is unaware
  let bodyText = waText
  for (const b of urlBtns) {
    bodyText += `\n${b.text}: ${b.url}`
  }

  if (cbBtns.length === 0) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: bodyText.slice(0, 4096) },
    }
  }

  // Paginate if >10 callback buttons
  let display = cbBtns
  let hasMore = false
  if (cbBtns.length > 10) {
    display = cbBtns.slice(0, 9)
    hasMore = true
  }

  if (display.length <= 3) {
    // Reply buttons (≤3)
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText.slice(0, 1024) },
        action: {
          buttons: display.map(b => ({
            type: 'reply',
            reply: {
              id: (b.callback_data ?? '').slice(0, 256),
              title: b.text.slice(0, 20),
            },
          })),
        },
      },
    }
  }

  // List message (4–10)
  const rows: Array<{ id: string; title: string }> = display.map(b => ({
    id: (b.callback_data ?? '').slice(0, 200),
    title: b.text.slice(0, 24),
  }))
  if (hasMore) {
    rows.push({ id: '__more__', title: '更多 ▸' })
  }
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText.slice(0, 4096) },
      action: {
        button: '選單',
        sections: [{ rows }],
      },
    },
  }
}

// ── 24-hour window state machine (Phase 2) ───────────────────────────────────

export interface WaTemplate {
  name: string
  language: string
  /** 'approved' = Meta accepted; 'pending' = under review; 'rejected' = refused */
  status: 'approved' | 'pending' | 'rejected'
  /** Number of {{N}} body variable placeholders in the Meta template */
  bodyParamCount: number
}

/**
 * Template catalog — flip status to 'approved' once Meta reviews each entry.
 * Exported so tests can temporarily patch the status field.
 */
export const TEMPLATE_CATALOG: WaTemplate[] = [
  {
    name: 'pin_push_notification',
    language: 'zh_TW',
    status: 'pending',  // update to 'approved' after Meta review
    bodyParamCount: 1,  // {{1}} = notification body text
  },
]

export function findApprovedTemplate(): WaTemplate | undefined {
  return TEMPLATE_CATALOG.find(t => t.status === 'approved')
}

export function buildTemplatePayload(
  to: string,
  template: WaTemplate,
  text: string,
): Record<string, unknown> {
  const components: unknown[] = template.bodyParamCount > 0
    ? [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1024) }] }]
    : []
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components,
    },
  }
}

const WINDOW_MS = 24 * 60 * 60 * 1000

/** Store the timestamp of a user's inbound message, opening/refreshing the 24-hour window. */
export async function recordInbound(waUserId: string, displayName: string): Promise<void> {
  const userKey = `wa:${waUserId}`
  const user = await ensureUser(userKey, displayName)
  user.wa_last_inbound = new Date().toISOString()
  await saveUser(user)
}

/** True when the user has sent an inbound message within the past 24 hours. */
export async function isWindowOpen(waUserId: string): Promise<boolean> {
  const user = await loadUser(`wa:${waUserId}`)
  if (!user?.wa_last_inbound) return false
  return Date.now() - new Date(user.wa_last_inbound).getTime() < WINDOW_MS
}

// ── Bind deep link (PIN_WHATSAPP §2) ─────────────────────────────────────────

/**
 * Build the wa.me pre-fill deep link for channel-initiated binding.
 * The pre-filled "bind {token}" text is user-initiated, which opens the 24h
 * free-form window — the entire bind flow requires no template approval.
 */
export function buildWaBindLink(phoneNumber: string, token: string): string {
  const digits = phoneNumber.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(`bind ${token}`)}`
}

// ── Channel ───────────────────────────────────────────────────────────────────

export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp'
  readonly name = 'WhatsApp'
  private handler: MessageHandler | null = null

  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler
    // Inbound arrives via /whatsapp/webhook — wired in Phase 3.
  }

  async stop(): Promise<void> {}

  async sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void> {
    if (await isWindowOpen(userId)) {
      // 24-hour window open: free-form message allowed
      await this.post(buildPayload(userId, text, buttons))
      return
    }
    // Window closed (≥ 24h since last inbound or never): template required
    const tpl = findApprovedTemplate()
    if (!tpl) {
      await this.deadLetterTemplate(userId, text, 'no approved template available')
      return
    }
    await this.post(buildTemplatePayload(userId, tpl, text))
  }

  /** WhatsApp requires an HTTPS image URL (no raw bytes). Caller passes the URL. */
  async sendImage(userId: string, _png: Buffer, imageUrl: string, caption?: string): Promise<void> {
    const image: Record<string, string> = { link: imageUrl }
    if (caption) image.caption = caption.slice(0, 1024)
    await this.post({
      messaging_product: 'whatsapp',
      to: userId,
      type: 'image',
      image,
    })
  }

  /**
   * Called by the HTTP server when /whatsapp/webhook receives a POST.
   * Signature verification (X-Hub-Signature-256) is Phase 3.
   */
  async handleWebhook(body: unknown): Promise<{ ok: boolean; reason?: string }> {
    try {
      const parsed = body as any
      for (const entry of parsed?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value
          if (!value?.messages) continue
          for (const msg of value.messages) {
            try {
              await this.handleMessage(msg, value.contacts ?? [])
            } catch (err) {
              console.error('[wa message]', err)
            }
          }
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: String(err) }
    }
  }

  private async handleMessage(msg: any, contacts: any[]): Promise<void> {
    if (!this.handler) return

    const from: string = msg.from
    const contact = contacts.find((c: any) => c.wa_id === from)
    const displayName: string = contact?.profile?.name ?? from

    let text: string | undefined
    let callback: string | undefined

    if (msg.type === 'text') {
      text = msg.text?.body
    } else if (msg.type === 'interactive') {
      const ia = msg.interactive
      if (ia?.type === 'button_reply') {
        callback = ia.button_reply?.id
      } else if (ia?.type === 'list_reply') {
        callback = ia.list_reply?.id
      }
    } else {
      return  // audio, video, document, etc. — skip Phase 1
    }

    if (!text && !callback) return

    // Refresh the 24-hour free-form window on every valid inbound
    await recordInbound(from, displayName).catch(err =>
      console.error('[wa inbound record]', err)
    )

    const inbound: InboundMessage = {
      channelId: this.id,
      userId: from,
      userDisplayName: displayName,
      text,
      callback,
      rawCtx: msg,
    }

    const reply = await this.handler(inbound)
    if (!reply) return

    // WhatsApp has no edit-in-place; edit:true falls back to a new message.
    await this.post(buildPayload(from, reply.text, reply.buttons))
  }

  private async deadLetterTemplate(userId: string, text: string, reason: string): Promise<void> {
    const userKey = `wa:${userId}`
    console.error(`[wa dead-letter] user=${userKey} reason=${reason}`)
    try {
      const user = await loadUser(userKey)
      if (!user) return
      if (!user.failed_pushes) user.failed_pushes = []
      user.failed_pushes.push({
        text: text.slice(0, 500),
        channelId: 'whatsapp',
        attempts: 0,
        lastError: `template_routing: ${reason}`,
        ts: new Date().toISOString(),
      })
      if (user.failed_pushes.length > 100) {
        user.failed_pushes = user.failed_pushes.slice(-100)
      }
      await saveUser(user)
    } catch (err) {
      console.error('[wa dead-letter write failed]', err)
    }
  }

  private async post(payload: unknown): Promise<void> {
    const url = `${GRAPH_BASE}/${this.phoneNumberId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`WhatsApp API ${res.status}: ${detail}`)
    }
  }
}
