import * as chrono from 'chrono-node'
import { saveUser, type Reminder } from '../storage/jsonStore.js'
import type { Skill, SkillContext } from './types.js'

const TRIGGER_PATTERNS = [
  /^提醒我/, /^記得/, /^別忘/,
  /^remind\s+me/i, /^don'?t\s+forget/i,
]

const LIST_PATTERNS = [
  /^我.{0,5}提醒/, /^列出.{0,5}提醒/, /^還有什麼提醒/,
  /^list.+reminders?/i, /^my\s+reminders?/i,
]

function newId(): string {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

const reminders: Skill = {
  id: 'reminders',
  name: 'Reminders',
  description: 'Schedule reminders that fire at a specified time, or list upcoming reminders.',
  examples: [
    '提醒我 明天9點 開會',
    '提醒我 30分鐘後 回客戶',
    '列出我的提醒',
    'remind me to call at 3pm',
  ],

  match(ctx: SkillContext): boolean {
    const t = ctx.text.trim()
    return TRIGGER_PATTERNS.some(re => re.test(t)) || LIST_PATTERNS.some(re => re.test(t))
  },

  async handle(ctx: SkillContext): Promise<string> {
    const t = ctx.text.trim()

    // List intent
    if (LIST_PATTERNS.some(re => re.test(t))) {
      const pending = ctx.user.reminders
        .filter(r => !r.fired)
        .sort((a, b) => a.when.localeCompare(b.when))
      if (pending.length === 0) return '目前沒有待提醒的事 📭'
      const lines = pending.slice(0, 10).map((r, i) => {
        const when = new Date(r.when)
        const fmt = when.toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })
        return `${i + 1}. ${fmt} — ${r.text}`
      })
      return `📅 待辦提醒 (${pending.length}):\n${lines.join('\n')}`
    }

    // Create intent — parse time + content
    const cleaned = t.replace(/^(提醒我|記得|別忘了?|remind\s+me\s+to?|don'?t\s+forget\s+to?)\s*/i, '')
    const parsed = chrono.zh.parse(cleaned, ctx.now, { forwardDate: true })
      .concat(chrono.parse(cleaned, ctx.now, { forwardDate: true }))

    if (parsed.length === 0) {
      return '我抓不到時間 🤔 試試「提醒我 明天9點 開會」或「提醒我 30分鐘後 回客戶」'
    }

    const first = parsed[0]
    const when = first.start.date()
    const content = (cleaned.slice(0, first.index) + cleaned.slice(first.index + first.text.length))
      .trim()
      .replace(/^[,，、的]/, '')
      .trim()

    if (!content) {
      return '時間有了但不知道要提醒什麼 🤔 完整講一次「提醒我 明天9點 開會」'
    }

    const r: Reminder = {
      id: newId(),
      when: when.toISOString(),
      text: content,
      fired: false,
      createdAt: ctx.now.toISOString(),
    }
    ctx.user.reminders.push(r)
    await saveUser(ctx.user)

    const whenFmt = when.toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
    return `✅ 記住了\n⏰ ${whenFmt}\n📝 ${content}`
  },
}

export default reminders

/** Find all reminders due now (or earlier) across all users and not yet fired. */
export async function findDueReminders(now: Date): Promise<Array<{ chatId: number; reminder: Reminder }>> {
  const { iterAllUsers } = await import('../storage/jsonStore.js')
  const due: Array<{ chatId: number; reminder: Reminder }> = []
  for await (const user of iterAllUsers()) {
    for (const r of user.reminders) {
      if (!r.fired && new Date(r.when).getTime() <= now.getTime()) {
        due.push({ chatId: user.chatId, reminder: r })
      }
    }
  }
  return due
}

/** Mark a reminder as fired and persist. */
export async function markReminderFired(chatId: number, reminderId: string): Promise<void> {
  const { loadUser, saveUser } = await import('../storage/jsonStore.js')
  const user = await loadUser(chatId)
  if (!user) return
  const r = user.reminders.find(x => x.id === reminderId)
  if (!r) return
  r.fired = true
  await saveUser(user)
}
