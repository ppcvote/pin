import 'dotenv/config'
import dns from 'node:dns'

// Force IPv4 DNS first — mindthread.tw fails on IPv6 default (undici timeout)
dns.setDefaultResultOrder('ipv4first')

import cron from 'node-cron'
import { bootRegistry, allSkills } from './platform/registry.js'
import { findDueReminders, markReminderFired } from './skills/reminders.js'
import { TelegramChannel } from './channels/telegram.js'
import { handlePinMessage } from './core/handle.js'
import { brainName } from './brain/index.js'
import { startWebhookServer } from './server/webhooks.js'
import type { Channel } from './channels/types.js'

// Boot the skill registry (loads ./skills/*/SKILL.md)
bootRegistry()

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN missing in .env')
  process.exit(1)
}

// Channels — TG today; Discord/LINE/Web later just `channels.push(...)` here
const channels: Channel[] = [new TelegramChannel(TOKEN)]

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

// HTTP webhook receiver — products → Pin → user channel
startWebhookServer(channels)

const skillNames = allSkills().map(s => s.name).join(', ')
const totalWebhooks = allSkills().reduce((n, s) => n + (s.pin?.webhooks?.length ?? 0), 0)
console.log(`Pin online · channels=${channels.map(c => c.name).join('+')} · brain=${brainName} · skills=[${skillNames}] · webhooks=${totalWebhooks}`)

// Cron — reminders (channel-agnostic outbound)
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date()
    const due = await findDueReminders(now)
    for (const { chatId, reminder } of due) {
      // Push reminder via the first channel (TG today). When users have multi-channel
      // preference, this'll lookup their preferred channel from their user record.
      for (const ch of channels) {
        try {
          await ch.sendDirect(String(chatId), `🔔 提醒:\n${reminder.text}`)
          await markReminderFired(chatId, reminder.id)
          console.log(`[fire] user=${chatId} via=${ch.id} reminder=${reminder.id}`)
          break
        } catch (e) {
          console.error(`[fire error] user=${chatId} via=${ch.id}`, e)
        }
      }
    }
  } catch (err) {
    console.error('[cron error]', err)
  }
})
