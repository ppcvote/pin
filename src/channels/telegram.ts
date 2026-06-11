import { Telegraf } from 'telegraf'
import type { Button, Channel, MessageHandler } from './types.js'

/** Convert Pin generic Button to Telegraf's strict InlineKeyboardButton shape. */
function toTgKeyboard(buttons: Button[][]): any[][] {
  return buttons.map(row => row.map(b => {
    if (b.url) return { text: b.text, url: b.url }
    return { text: b.text, callback_data: b.callback_data ?? '' }
  }))
}

export class TelegramChannel implements Channel {
  readonly id = 'tg'
  readonly name = 'Telegram'
  private bot: Telegraf
  private handler: MessageHandler | null = null

  constructor(token: string) {
    this.bot = new Telegraf(token)
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler

    // /start treated same as any text command — Pin core decides what to do
    this.bot.start(async (ctx) => {
      await this.dispatch(ctx, { text: '/start' })
    })

    this.bot.command('menu', async (ctx) => {
      await this.dispatch(ctx, { text: '/menu' })
    })

    this.bot.on('text', async (ctx) => {
      if (ctx.chat.type !== 'private') return
      const text = ctx.message.text
      await this.dispatch(ctx, { text })
    })

    this.bot.on('callback_query', async (ctx) => {
      const cq = ctx.callbackQuery
      const data = (cq as any).data as string | undefined
      if (!data) { await ctx.answerCbQuery(); return }
      await ctx.answerCbQuery()
      await this.dispatch(ctx, { callback: data, isCallback: true })
    })

    // Don't await — telegraf.launch() in long-polling mode resolves only when bot stops.
    // We just want to kick it off and let it run in the background.
    this.bot.launch().catch(err => console.error('[tg launch]', err))
    process.once('SIGINT', () => this.bot.stop('SIGINT'))
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'))
  }

  async stop(): Promise<void> {
    this.bot.stop('manual')
  }

  async sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void> {
    const id = Number(userId)
    if (Number.isNaN(id)) return
    await this.bot.telegram.sendMessage(id, text, buttons ? { reply_markup: { inline_keyboard: toTgKeyboard(buttons) } } : undefined)
  }

  /** TG accepts raw image bytes via sendPhoto. */
  async sendImage(userId: string, png: Buffer, _imageUrl: string, caption?: string): Promise<void> {
    const id = Number(userId)
    if (Number.isNaN(id)) return
    await this.bot.telegram.sendPhoto(id, { source: png }, caption ? { caption: caption.slice(0, 1024) } : undefined)
  }

  private async dispatch(
    ctx: any,
    payload: { text?: string; callback?: string; isCallback?: boolean }
  ): Promise<void> {
    if (!this.handler) return
    const chat = ctx.chat
    if (chat?.type !== 'private') return
    const from = ctx.from
    try {
      const reply = await this.handler({
        channelId: this.id,
        userId: String(chat.id),
        userDisplayName: from.first_name ?? 'user',
        userHandle: from.username,
        text: payload.text,
        callback: payload.callback,
        rawCtx: ctx,
      })
      if (!reply) return
      const replyMarkup = reply.buttons ? { reply_markup: { inline_keyboard: toTgKeyboard(reply.buttons) } } : undefined
      const opts: any = { ...replyMarkup }
      if (reply.parseMode === 'markdown') opts.parse_mode = 'Markdown'
      if (payload.isCallback && reply.edit) {
        try {
          await ctx.editMessageText(reply.text, opts)
          return
        } catch {
          // fallback to plain reply
        }
      }
      await ctx.reply(reply.text, opts)
    } catch (err) {
      console.error('[tg dispatch]', err)
      try { await ctx.reply('內部錯誤 😢') } catch {}
    }
  }
}
