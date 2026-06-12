import { messagingApi, validateSignature, webhook } from '@line/bot-sdk'
import type { Button, Channel, MessageHandler, InboundMessage, InboundImage, ThemeHint } from './types.js'
import { PIN_NEUTRAL, PIN_SIGNATURE, resolveTheme } from './design.js'

const { MessagingApiClient, MessagingApiBlobClient } = messagingApi
type WebhookEvent = webhook.Event

/** Identify nav buttons (back / home) so we render them subtly. */
function isNavButton(b: Button): boolean {
  return typeof b.callback_data === 'string' && (b.callback_data === 'm:root' || /^s:[^:]+$/.test(b.callback_data))
}

/**
 * Build a LINE outbound message from Pin's channel-agnostic shape, themed
 * with the skill's brand color + icon. Returns 1 message.
 *
 * Layout (Flex bubble):
 *   [ header  — primary_color background, icon + title + ·Pin ]
 *   [ body    — cream background, text + buttons ]
 */
function buildMessages(text: string, buttons?: Button[][], theme?: ThemeHint): any[] {
  const plain = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')

  // No buttons → plain text (LINE caps at 5000 chars). Theme is wasted here, skip Flex.
  if (!buttons || buttons.length === 0) {
    return [{ type: 'text', text: plain.slice(0, 5000) }]
  }

  const t = resolveTheme(theme)
  const flat = buttons.flat()

  // Strip the title line from body text if it duplicates the header title.
  // (Our skillMenu emits "🧵 mindthread\n\ndesc" — the first line becomes the
  // Flex header, so we don't double-render it in the body.)
  let bodyText = plain
  if (t.title) {
    const titlePrefix1 = `${t.icon} ${t.title}`
    const titlePrefix2 = t.title
    if (bodyText.startsWith(titlePrefix1)) bodyText = bodyText.slice(titlePrefix1.length).trimStart()
    else if (bodyText.startsWith(titlePrefix2)) bodyText = bodyText.slice(titlePrefix2.length).trimStart()
  }

  // ── Body components ─────────────────────────────────────────
  const bodyComponents: any[] = []
  if (bodyText.trim()) {
    bodyComponents.push({
      type: 'text',
      text: bodyText.slice(0, 2000),
      wrap: true,
      size: 'sm',
      color: PIN_NEUTRAL.mutedText,
    })
    bodyComponents.push({ type: 'separator', margin: 'md', color: PIN_NEUTRAL.border })
  }

  // ── Buttons ─────────────────────────────────────────────────
  for (const b of flat) {
    const label = (b.text ?? '').slice(0, 40) || '·'
    if (b.url) {
      // External link → outline style, neutral
      bodyComponents.push({
        type: 'button',
        style: 'secondary',
        color: PIN_NEUTRAL.secondaryBg,
        height: 'sm',
        action: { type: 'uri', label, uri: b.url.slice(0, 1000) },
      })
    } else if (b.callback_data) {
      const isNav = isNavButton(b)
      if (isNav) {
        bodyComponents.push({
          type: 'button',
          style: 'link',
          height: 'sm',
          action: { type: 'postback', label, data: b.callback_data.slice(0, 300), displayText: label },
        })
      } else {
        bodyComponents.push({
          type: 'button',
          style: 'primary',
          color: t.primaryColor,
          height: 'sm',
          action: { type: 'postback', label, data: b.callback_data.slice(0, 300), displayText: label },
        })
      }
    }
  }

  // ── Header (skill icon + name + Pin signature) ─────────────
  const headerTitle = t.title ? `${t.icon} ${t.title}` : t.icon
  const header = {
    type: 'box',
    layout: 'horizontal',
    paddingAll: 'md',
    backgroundColor: t.primaryColor,
    contents: [
      { type: 'text', text: headerTitle, weight: 'bold', color: t.headerTextColor, size: 'md', flex: 4 },
      { type: 'text', text: PIN_SIGNATURE, color: t.headerTextColor, size: 'xs', align: 'end', flex: 1, gravity: 'center' },
    ],
  }

  return [{
    type: 'flex',
    altText: plain.slice(0, 400) || `${t.title} ${PIN_SIGNATURE}`,
    contents: {
      type: 'bubble',
      header,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        backgroundColor: PIN_NEUTRAL.cream,
        paddingAll: 'md',
        contents: bodyComponents.length ? bodyComponents : [{ type: 'text', text: ' ', size: 'xs' }],
      },
    },
  }]
}

export class LineChannel implements Channel {
  readonly id = 'line'
  readonly name = 'LINE'
  private client: InstanceType<typeof MessagingApiClient>
  private blobClient: InstanceType<typeof MessagingApiBlobClient>
  private handler: MessageHandler | null = null
  private profileCache = new Map<string, { displayName: string; cachedAt: number }>()

  constructor(token: string, public readonly secret: string) {
    this.client = new MessagingApiClient({ channelAccessToken: token })
    this.blobClient = new MessagingApiBlobClient({ channelAccessToken: token })
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler
    // Inbound comes via the shared HTTP server's /line/webhook path —
    // see src/server/webhooks.ts. Nothing to start here.
  }

  async stop(): Promise<void> {}

  async sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void> {
    // sendDirect is used for unsolicited webhook notifications. No theme passed
    // here; if we wanted webhook themes too the Channel interface would need to
    // carry them — keep that for when push notifications need branding.
    const messages = buildMessages(text, buttons)
    await this.client.pushMessage({ to: userId, messages })
  }

  /** LINE image message requires HTTPS URLs (no bytes). Caller passes the URL. */
  async sendImage(userId: string, _png: Buffer, imageUrl: string, caption?: string): Promise<void> {
    const messages: any[] = [
      {
        type: 'image',
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      },
    ]
    if (caption) messages.push({ type: 'text', text: caption.slice(0, 400) })
    await this.client.pushMessage({ to: userId, messages })
  }

  /**
   * Called by the HTTP server when /line/webhook receives a POST.
   * `rawBody` MUST be the unmodified bytes for signature validation.
   */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<{ ok: boolean; reason?: string }> {
    if (!signature) return { ok: false, reason: 'missing_signature' }
    if (!validateSignature(rawBody, this.secret, signature)) {
      return { ok: false, reason: 'bad_signature' }
    }
    let parsed: { events?: WebhookEvent[] }
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return { ok: false, reason: 'invalid_json' }
    }
    for (const event of parsed.events ?? []) {
      try {
        await this.handleEvent(event)
      } catch (err) {
        console.error('[line event]', err)
      }
    }
    return { ok: true }
  }

  private async handleEvent(event: WebhookEvent): Promise<void> {
    if (!this.handler) return
    // We only care about user-driven events in 1:1 chats for now.
    if (!event.source || event.source.type !== 'user') return
    const userId = (event.source as { userId?: string }).userId
    if (!userId) return

    let text: string | undefined
    let callback: string | undefined
    let image: InboundImage | undefined
    let replyToken: string | undefined

    if (event.type === 'message' && event.message.type === 'text') {
      text = event.message.text
      replyToken = (event as any).replyToken
    } else if (event.type === 'message' && event.message.type === 'image') {
      // Photo upload — download from LINE's data CDN
      replyToken = (event as any).replyToken
      try {
        const messageId = event.message.id
        const stream = await this.blobClient.getMessageContent(messageId)
        const chunks: Buffer[] = []
        for await (const chunk of stream as any) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer))
        }
        image = {
          data: Buffer.concat(chunks),
          mime: 'image/jpeg',  // LINE images are JPEG; refine when we accept others
        }
      } catch (err) {
        console.error('[line image fetch failed]', err)
        return
      }
    } else if (event.type === 'postback') {
      callback = event.postback.data
      replyToken = (event as any).replyToken
    } else if (event.type === 'follow') {
      // User added the bot → welcome + bind-recovery hint (§A: the
      // add-friend interstitial can swallow a product deep link's
      // prefilled "bind <token>" message)
      text = '/follow'
      replyToken = (event as any).replyToken
    } else {
      return
    }

    const display = await this.getDisplayName(userId)
    const inbound: InboundMessage = {
      channelId: this.id,
      userId,
      userDisplayName: display,
      text,
      callback,
      image,
      rawCtx: event,
    }

    const reply = await this.handler(inbound)
    if (!reply) return

    const messages = buildMessages(reply.text, reply.buttons, reply.theme)

    // LINE doesn't support edit-in-place; reply.edit is ignored.
    // Prefer replyToken (free + within 30s window); fall back to push.
    if (replyToken) {
      try {
        await this.client.replyMessage({ replyToken, messages })
        return
      } catch (err) {
        console.warn('[line reply failed, falling back to push]', (err as Error).message)
      }
    }
    try {
      await this.client.pushMessage({ to: userId, messages })
    } catch (err) {
      console.error('[line push failed]', err)
    }
  }

  private async getDisplayName(userId: string): Promise<string> {
    const cached = this.profileCache.get(userId)
    const now = Date.now()
    if (cached && now - cached.cachedAt < 3600_000) return cached.displayName
    try {
      const profile = await this.client.getProfile(userId)
      const displayName = profile.displayName ?? 'user'
      this.profileCache.set(userId, { displayName, cachedAt: now })
      return displayName
    } catch {
      return 'user'
    }
  }
}
