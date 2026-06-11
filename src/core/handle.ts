import { ensureUser } from '../storage/jsonStore.js'
import { route as legacyRoute } from '../router.js'
import { appendHistory } from '../brain/memory.js'
import { findAction, allSkills } from '../platform/registry.js'
import { rootMenu, skillMenu, parseCallback } from '../platform/menuRenderer.js'
import { executeAction } from '../platform/actionExecutor.js'
import type { InboundMessage, OutboundReply, Button } from '../channels/types.js'

const NAV_ROW = (skillId?: string): Button[] => skillId
  ? [{ text: `⬅️ 返回`, callback_data: `s:${skillId}` }, { text: '🏠 主選單', callback_data: 'm:root' }]
  : [{ text: '🏠 主選單', callback_data: 'm:root' }]

/** Render the platform's main onboarding screen. */
function welcomeScreen(displayName: string): OutboundReply {
  const skills = allSkills()
  const skillNames = skills.map(s => `${s.pin?.icon ?? '•'} ${s.name}`).join('  ')
  const text = [
    `👋 Hi ${displayName}, 我是 **Pin**`,
    '',
    'Ultra Lab 全產品的 AI 入口 — 一個介面操控所有工具',
    '',
    `現有 skill (${skills.length} 個):`,
    skillNames,
    '',
    '點下面任一個馬上試 ↓',
  ].join('\n')

  const buttons: Button[][] = []
  for (const s of skills) {
    buttons.push([{ text: `${s.pin?.icon ?? '•'} ${s.name}`, callback_data: `s:${s.id}` }])
  }
  buttons.push([{ text: '📖 完整指令說明', callback_data: 'sys:help' }])

  return { text, buttons, parseMode: 'markdown' }
}

function helpScreen(): OutboundReply {
  return {
    text: [
      '📖 Pin 指令一覽',
      '',
      '🔘 主操作:',
      '  /menu — 開所有 skill 選單',
      '  /start — 歡迎畫面',
      '',
      '💬 自然語言快速通道:',
      '  「提醒我 30 分鐘後 X」',
      '  「午餐 NT$120」',
      '  「記一下: X」',
      '  「列出我的提醒」',
      '',
      '🧩 給開發者:',
      '  Pin 跑在 SKILL.md 標準 (Anthropic Agent Skills)',
      '  任何產品寫 SKILL.md 就可以接入',
      '  Spec: https://agentskills.io/specification',
    ].join('\n'),
    buttons: [[{ text: '🏠 回主選單', callback_data: 'm:root' }]],
  }
}

/**
 * The channel-agnostic Pin message handler.
 * Returns a reply or null (when nothing to send).
 */
export async function handlePinMessage(msg: InboundMessage): Promise<OutboundReply | null> {
  // Ensure user record exists in our store (using channel-prefixed id for cross-channel uniqueness later)
  const userKey = Number(msg.userId) || 0  // for now jsonStore keys are numbers (TG-only legacy)
  if (!userKey) return { text: 'unsupported user id format' }
  await ensureUser(userKey, msg.userDisplayName, msg.userHandle)

  // ── Callback (button tap) ────────────────────────────────────────────
  if (msg.callback) {
    const data = msg.callback

    // System callbacks
    if (data === 'sys:help') return { ...helpScreen(), edit: true }

    const parsed = parseCallback(data)

    if (parsed.kind === 'root') {
      const { title, buttons } = rootMenu()
      return { text: title, buttons, edit: true }
    }
    if (parsed.kind === 'skill') {
      const view = skillMenu(parsed.skillId)
      if (!view) return { text: 'Skill not found', edit: true }
      return { text: view.title, buttons: view.buttons, edit: true }
    }
    if (parsed.kind === 'action') {
      const found = findAction(parsed.skillId, parsed.actionId)
      if (!found) return { text: 'Action not found' }
      const { skill, action } = found

      // Args check (wizard comes later)
      const missing = (action.args ?? []).filter(a => !(a.name in parsed.args))
      if (missing.length > 0) {
        return { text: `此 action (${action.label}) 需要: ${missing.map(a => a.label).join(', ')} — wizard 還在做` }
      }

      const result = await executeAction(skill, action, parsed.args)
      const text = result.ok
        ? (result.rendered ?? JSON.stringify(result.raw).slice(0, 1000))
        : `${action.label} 失敗 😢\n${result.error}`

      const keyboard: Button[][] = []
      // Follow-up action / url buttons go above choices (more important)
      if (result.followUps) {
        for (let i = 0; i < result.followUps.length; i += 2) {
          const row: Button[] = [{
            text: result.followUps[i].text,
            callback_data: result.followUps[i].callback_data,
            url: result.followUps[i].url,
          }]
          if (result.followUps[i + 1]) row.push({
            text: result.followUps[i + 1].text,
            callback_data: result.followUps[i + 1].callback_data,
            url: result.followUps[i + 1].url,
          })
          keyboard.push(row)
        }
      }
      if (result.choices) for (const c of result.choices) keyboard.push([c])
      keyboard.push(NAV_ROW(skill.id))
      return { text, buttons: keyboard }
    }
    return { text: 'unknown button' }
  }

  // ── Text input ────────────────────────────────────────────────────────
  const text = (msg.text ?? '').trim()
  if (!text) return null

  // Slash commands
  if (text === '/start') {
    return welcomeScreen(msg.userDisplayName)
  }
  if (text === '/menu') {
    const { title, buttons } = rootMenu()
    return { text: title, buttons }
  }
  if (text === '/help') {
    return helpScreen()
  }
  if (text.startsWith('/')) {
    return { text: '我看不懂這個指令 — 試 /menu 或自然語言' }
  }

  // Free-form text — go through legacy skill router (regex first, LLM fallback)
  const user = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)
  await appendHistory(userKey, 'user', text, msg.userDisplayName, msg.userHandle)
  const result = await legacyRoute({ chatId: userKey, user, text, now: new Date() })
  await appendHistory(userKey, 'assistant', result.reply, msg.userDisplayName, msg.userHandle)
  console.log(`[route] user=${userKey} via=${result.via} skill=${result.skill?.id ?? 'none'} text="${text.slice(0, 60)}"`)
  return { text: result.reply }
}
