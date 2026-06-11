import { messagingApi, validateSignature, webhook } from '@line/bot-sdk'
import type { Button, Channel, MessageHandler, InboundMessage } from './types.js'

const { MessagingApiClient } = messagingApi
type WebhookEvent = webhook.Event

/**
 * Build a LINE outbound message from Pin's channel-agnostic Button[][] shape.
 *
 * Single text → text message.
 * Text + buttons → Flex bubble (text + button stack). Buttons are stacked
 * vertically (LINE Flex). markdown is stripped (LINE doesn't render it).
 */
function buildMessages(text: string, buttons?: Button[][]): any[] {
  const plain = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
  if (!buttons || buttons.length === 0) {
    // Plain text — LINE caps a text message at 5000 chars
    return [{ type: 'text', text: plain.slice(0, 5000) }]
  }

  const flat = buttons.flat()
  const components: any[] = [{ type: 'text', text: plain.slice(0, 2000), wrap: true, size: 'sm' }]

  for (const b of flat) {
    const label = (b.text ?? '').slice(0, 40) || '·'
    if (b.url) {
      components.push({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: { type: 'uri', label, uri: b.url.slice(0, 1000) },
      })
    } else if (b.callback_data) {
      components.push({
        type: 'button',
        style: 'primary',
        height: 'sm',
        action: { type: 'postback', label, data: b.callback_data.slice(0, 300), displayText: label },
      })
    }
  }

  return [{
    type: 'flex',
    altText: plain.slice(0, 400),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: components,
      },
    },
  }]
}

export class LineChannel implements Channel {
  readonly id = 'line'
  readonly name = 'LINE'
  private client: InstanceType<typeof MessagingApiClient>
  private handler: MessageHandler | null = null
  private profileCache = new Map<string, { displayName: string; cachedAt: number }>()

  constructor(token: string, public readonly secret: string) {
    this.client = new MessagingApiClient({ channelAccessToken: token })
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler
    // Inbound comes via the shared HTTP server's /line/webhook path —
    // see src/server/webhooks.ts. Nothing to start here.
  }

  async stop(): Promise<void> {}

  async sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void> {
    const messages = buildMessages(text, buttons)
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
    let replyToken: string | undefined

    if (event.type === 'message' && event.message.type === 'text') {
      text = event.message.text
      replyToken = (event as any).replyToken
    } else if (event.type === 'postback') {
      callback = event.postback.data
      replyToken = (event as any).replyToken
    } else if (event.type === 'follow') {
      // User added the bot → treat like /start
      text = '/start'
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
      rawCtx: event,
    }

    const reply = await this.handler(inbound)
    if (!reply) return

    const messages = buildMessages(reply.text, reply.buttons)

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
