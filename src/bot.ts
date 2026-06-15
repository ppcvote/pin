import 'dotenv/config'
import dns from 'node:dns'

// Force IPv4 DNS first — mindthread.tw fails on IPv6 default (undici timeout)
dns.setDefaultResultOrder('ipv4first')

import cron from 'node-cron'
import { bootRegistry, allSkills } from './platform/registry.js'
import { initSkillThreatScan } from './platform/skillThreatScan.js'
import { findDueReminders, markReminderFired } from './skills/reminders.js'
import { TelegramChannel } from './channels/telegram.js'
import { LineChannel } from './channels/line.js'
import { WhatsAppChannel } from './channels/whatsapp.js'
import { handlePinMessage } from './core/handle.js'
import { brainName } from './brain/index.js'
import { startWebhookServer } from './server/webhooks.js'
import { deliverWithRetry } from './runtime/deliver.js'
import { reportWeeklyActive } from './runtime/flywheelReporter.js'
import { setChannels } from './runtime/notifier.js'
import type { Channel } from './channels/types.js'

// Arm the ATR threat scanner first, then boot the skill registry
// (loads ./skills/*/SKILL.md —每份 skill 載入前先過 ATR 掃描)
await initSkillThreatScan()
bootRegistry()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN missing in .env')
  process.exit(1)
}

// Channels — TG is primary; LINE adds if env configured.
const channels: Channel[] = [new TelegramChannel(TOKEN)]
if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) {
  channels.push(new LineChannel(
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
    process.env.LINE_CHANNEL_SECRET,
  ))
}
if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
  channels.push(new WhatsAppChannel(
    process.env.WHATSAPP_PHONE_NUMBER_ID,
    process.env.WHATSAPP_ACCESS_TOKEN,
  ))
}

process.on('uncaughtException', err => console.error('[uncaught]', err))
process.on('unhandledRejection', err => console.error('[unhandled]', err))

for (const ch of channels) {
  try {
    await ch.start(handlePinMessage)
  } catch (err) {
    console.error(`[channel ${ch.name} failed]`, err)
    process.exit(1)
  }
}

// Wire channels into the notifier so the apply/approval flow can push to a
// different user than the current turn (owner on submit, applicant on decision).
setChannels(channels)

// HTTP webhook receiver — products → Pin → user channel
startWebhookServer(channels)

const skillNames = allSkills().map(s => s.name).join(', ')
const totalWebhooks = allSkills().reduce((n, s) => n + (s.pin?.webhooks?.length ?? 0), 0)
console.log(`Pin online · channels=${channels.map(c => c.name).join('+')} · brain=${brainName} · skills=[${skillNames}] · webhooks=${totalWebhooks}`)

// Cron — FLYWHEEL §3 weekly active rollup (Sunday 23:00 server time)
cron.schedule('0 23 * * 0', async () => {
  try {
    await reportWeeklyActive()
  } catch (err) {
    console.error('[flywheel weekly cron]', err)
  }
})

// Cron — reminders (channel-agnostic outbound)
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date()
    const due = await findDueReminders(now)
    for (const { chatId, reminder } of due) {
      // chatId is "<channel>:<userId>" composite. Route to the matching channel adapter.
      const colonIdx = chatId.indexOf(':')
      if (colonIdx < 0) {
        console.warn(`[fire skip] chatId without channel prefix: ${chatId}`)
        continue
      }
      const channelId = chatId.slice(0, colonIdx)
      const userId = chatId.slice(colonIdx + 1)
      const ch = channels.find(c => c.id === channelId)
      if (!ch) {
        console.warn(`[fire skip] channel not available: ${channelId}`)
        continue
      }
      const delivery = await deliverWithRetry(ch, chatId, userId, `🔔 提醒:\n${reminder.text}`)
      if (delivery.ok) {
        await markReminderFired(chatId, reminder.id)
        console.log(`[fire] user=${chatId} via=${ch.id} reminder=${reminder.id} attempts=${delivery.attempts}`)
      } else {
        // Keep the reminder un-fired so it'll retry next cron tick — eventually
        // the user may unblock the bot. The push itself is already dead-lettered
        // (see deliver.ts) for the user-visible queue.
        console.error(`[fire failed] user=${chatId} reminder=${reminder.id} after ${delivery.attempts} attempts`)
      }
    }
  } catch (err) {
    console.error('[cron error]', err)
  }
})
