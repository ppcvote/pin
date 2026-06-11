/**
 * Channel abstraction — lets Pin core stay channel-agnostic.
 * TG, Discord, LINE, Web, etc. all implement this.
 */

export interface InboundImage {
  /** Binary content downloaded from the channel CDN */
  data: Buffer
  /** Reported MIME type (e.g., "image/jpeg") */
  mime: string
  /** Optional original filename */
  filename?: string
}

export interface InboundMessage {
  channelId: string         // "tg", "discord", "line", "web"
  userId: string            // stable id within that channel (e.g., TG chat_id as string)
  userDisplayName: string   // for greeting + memory
  userHandle?: string       // optional @username
  text?: string             // free-form text (null if it's a button tap)
  callback?: string         // button callback_data (null if it's text)
  image?: InboundImage      // photo/file upload from the user
  rawCtx?: unknown          // adapter-specific original message ctx (for edits etc.)
}

export interface Button {
  text: string
  /** For tap-to-callback buttons */
  callback_data?: string
  /** For external link buttons (opens browser) — TG-style url button */
  url?: string
}

export interface ThemeHint {
  /** Skill's brand color (hex) — drives header bg + primary button color */
  primaryColor?: string
  /** Skill's icon (emoji or short mark) for the header */
  icon?: string
  /** Title to show in header (e.g. skill name) */
  title?: string
}

export interface OutboundReply {
  text: string
  buttons?: Button[][]              // inline keyboard
  parseMode?: 'markdown' | 'plain'  // optional formatting hint
  edit?: boolean                    // true → edit the previous message in place
  theme?: ThemeHint                 // brand color / icon / title for the response
}

export type MessageHandler = (msg: InboundMessage) => Promise<OutboundReply | null>

export interface Channel {
  /** Unique short id ("tg", "discord", etc.) */
  id: string
  /** Human-readable name */
  name: string
  /** Start listening for inbound messages. Calls `handler` for each. */
  start(handler: MessageHandler): Promise<void>
  /** Stop. */
  stop(): Promise<void>
  /** Send an unsolicited message (used by cron jobs like reminders). */
  sendDirect(userId: string, text: string, buttons?: Button[][]): Promise<void>
}
