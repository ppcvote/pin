import { Telegraf } from 'telegraf'
import type { Button, Channel, MessageHandler, InboundImage } from './types.js'

/** TG album (media_group) debounce buffer — collects photos from the same album. */
const ALBUM_DEBOUNCE_MS = 1200
const ALBUM_MAX_PHOTOS = 8

type AlbumEntry = {
  images: InboundImage[]
  ctx: any
  timer: ReturnType<typeof setTimeout>
}
const pendingAlbums = new Map<string, AlbumEntry>()

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

    this.bot.on('photo', async (ctx) => {
      if (ctx.chat.type !== 'private') return
      const msg = ctx.message
      const photos = msg.photo
      if (!photos || photos.length === 0) return

      // TG sends photos sorted smallest→largest; pick the largest that bots can access.
      const best = photos[photos.length - 1]
      let image: InboundImage
      try {
        const link = await ctx.telegram.getFileLink(best.file_id)
        const res = await fetch(link.href)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        image = { data: buf, mime: 'image/jpeg' }
      } catch (err) {
        console.error('[tg photo download]', err)
        try { await ctx.reply('照片下載失敗 😢，請重試') } catch {}
        return
      }

      await this.routeImage(ctx, msg, image)
    })

    // Image sent as a FILE/document (uncompressed original) — full-resolution
    // path so realtors can send 原圖 for sharper vision recognition than the
    // compressed photo TG produces on a normal send.
    this.bot.on('document', async (ctx) => {
      if (ctx.chat.type !== 'private') return
      const msg = ctx.message
      const doc = (msg as any).document
      const mime: string = doc?.mime_type ?? ''
      if (!doc || !mime.startsWith('image/')) return  // only image files; ignore other docs
      let image: InboundImage
      try {
        const link = await ctx.telegram.getFileLink(doc.file_id)
        const res = await fetch(link.href)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        image = { data: buf, mime }
      } catch (err) {
        console.error('[tg document download]', err)
        try { await ctx.reply('檔案下載失敗 😢，請重試') } catch {}
        return
      }
      await this.routeImage(ctx, msg, image)
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

  /** Route one inbound image — album-debounce if part of a media_group, else
   *  dispatch immediately. Shared by the photo and document (file) handlers. */
  private async routeImage(ctx: any, msg: any, image: InboundImage): Promise<void> {
    const mediaGroupId: string | undefined = msg?.media_group_id
    if (mediaGroupId) {
      const key = `${ctx.chat.id}:${mediaGroupId}`
      const existing = pendingAlbums.get(key)
      if (existing) {
        clearTimeout(existing.timer)
        existing.images.push(image)
        if (existing.images.length >= ALBUM_MAX_PHOTOS) {
          pendingAlbums.delete(key)
          await this.dispatch(existing.ctx, { images: existing.images }).catch(e => console.error('[tg album dispatch]', e))
          return
        }
        existing.timer = setTimeout(async () => {
          pendingAlbums.delete(key)
          await this.dispatch(existing.ctx, { images: existing.images }).catch(e => console.error('[tg album dispatch]', e))
        }, ALBUM_DEBOUNCE_MS)
      } else {
        const entry: AlbumEntry = {
          images: [image],
          ctx,
          timer: setTimeout(async () => {
            const e = pendingAlbums.get(key)
            if (!e) return
            pendingAlbums.delete(key)
            await this.dispatch(e.ctx, { images: e.images }).catch(err => console.error('[tg album dispatch]', err))
          }, ALBUM_DEBOUNCE_MS),
        }
        pendingAlbums.set(key, entry)
      }
    } else {
      await this.dispatch(ctx, { image })
    }
  }

  private async dispatch(
    ctx: any,
    payload: { text?: string; callback?: string; isCallback?: boolean; image?: InboundImage; images?: InboundImage[] }
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
        image: payload.image,
        images: payload.images,
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
