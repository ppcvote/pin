import { ensureUser, loadUser } from '../storage/jsonStore.js'
import { route as legacyRoute } from '../router.js'
import { appendHistory } from '../brain/memory.js'
import { findAction, findSkill, allSkills } from '../platform/registry.js'
import { rootMenu, skillMenu, parseCallback } from '../platform/menuRenderer.js'
import { executeAction } from '../platform/actionExecutor.js'
import { startWizard, processWizardCallback, processWizardText, type WizardOutcome } from '../platform/wizard.js'
import { createBindingToken } from '../platform/binding.js'
import type { InboundMessage, OutboundReply, Button, ThemeHint } from '../channels/types.js'

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
function wizardOutcomeToReply(outcome: WizardOutcome, skill?: { pin?: { primary_color?: string; icon?: string }; name?: string }): OutboundReply {
  const theme: ThemeHint | undefined = skill ? {
    primaryColor: skill.pin?.primary_color,
    icon: skill.pin?.icon,
    title: skill.name,
  } : undefined
  const buttons = (outcome as any).buttons as Button[] | undefined
  const keyboard = buttons && buttons.length > 0 ? [buttons] : undefined
  return { text: outcome.text, buttons: keyboard, theme }
}

export async function handlePinMessage(msg: InboundMessage): Promise<OutboundReply | null> {
  // Composite user key for cross-channel isolation. TG digits, LINE alphanumeric, etc.
  // Stored as the jsonStore filename directly — channel prefix prevents collisions.
  const userKey = `${msg.channelId}:${msg.userId}`
  let user = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)

  // ── Active wizard takes priority — intercept text + wizard callbacks ──
  if (user.wizard) {
    const skill = findSkill(user.wizard.skillId)
    if (msg.callback?.startsWith('wz:')) {
      // Reload to avoid stale state across concurrent turns
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardCallback(user, msg.callback)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    }
    if (msg.text && !msg.text.startsWith('/')) {
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardText(user, msg.text)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    }
    // If user typed a slash command or non-wizard callback mid-wizard, fall through to normal flow.
    // Most non-wizard callbacks (m:root, s:..., a:...) silently cancel the wizard:
    if (msg.callback && !msg.callback.startsWith('wz:')) {
      user.wizard = undefined
      const { saveUser } = await import('../storage/jsonStore.js')
      await saveUser(user)
    }
  }

  // ── Callback (button tap) ────────────────────────────────────────────
  if (msg.callback) {
    const data = msg.callback

    // System callbacks
    if (data === 'sys:help') return { ...helpScreen(), edit: true }

    const parsed = parseCallback(data)

    if (parsed.kind === 'root') {
      const { title, buttons } = rootMenu()
      return { text: title, buttons, edit: true, theme: { title: 'Pin' } }
    }
    if (parsed.kind === 'skill') {
      const view = skillMenu(parsed.skillId)
      if (!view) return { text: 'Skill not found', edit: true }
      const skill = findSkill(parsed.skillId)
      const theme: ThemeHint = {
        primaryColor: skill?.pin?.primary_color,
        icon: skill?.pin?.icon,
        title: skill?.name,
      }
      return { text: view.title, buttons: view.buttons, edit: true, theme }
    }

    // System-injected: binding code
    if (data.startsWith('bind:')) {
      const skillId = data.slice(5)
      const skill = findSkill(skillId)
      if (!skill?.pin?.webhooks?.length) {
        return { text: '此 skill 沒有可綁定的通知事件' }
      }
      try {
        const token = await createBindingToken(userKey, skillId)
        const eventLines = skill.pin.webhooks.map(w => `· ${w.event}`).join('\n')
        const text = [
          `🔔 ${skill.name} 通知綁定`,
          '',
          `你的綁定碼:`,
          `\`${token}\``,
          '',
          `⏱ 10 分鐘內有效, 單次使用`,
          '',
          `做法:`,
          `1. 到 ${skill.name} 後台`,
          `2. 找「Pin 綁定」設定`,
          `3. 貼上上面這串`,
          `4. 之後這些事件會推到你 ${msg.channelId === 'line' ? 'LINE' : 'TG'}:`,
          eventLines,
        ].join('\n')
        const theme: ThemeHint = {
          primaryColor: skill.pin?.primary_color,
          icon: skill.pin?.icon,
          title: skill.name,
        }
        return {
          text,
          buttons: [[
            { text: `⬅️ ${skill.name}`, callback_data: `s:${skill.id}` },
            { text: '🏠 主選單', callback_data: 'm:root' },
          ]],
          theme,
        }
      } catch (err) {
        console.error('[bind error]', err)
        return { text: `綁定失敗: ${(err as Error).message}` }
      }
    }
    if (parsed.kind === 'action') {
      const found = findAction(parsed.skillId, parsed.actionId)
      if (!found) return { text: 'Action not found' }
      const { skill, action } = found

      // Args still needed? Pre-filled args (from a choices/follow-up button)
      // count as satisfied. Anything else triggers the wizard.
      const missing = (action.args ?? []).filter(a => !(a.name in parsed.args))
      if (missing.length > 0) {
        user = (await loadUser(userKey)) ?? user
        const outcome = await startWizard(user, parsed.skillId, parsed.actionId)
        // Pre-seed any args the user did supply via callback
        if (Object.keys(parsed.args).length > 0 && user.wizard) {
          Object.assign(user.wizard.collected, parsed.args)
          const { saveUser } = await import('../storage/jsonStore.js')
          await saveUser(user)
        }
        return wizardOutcomeToReply(outcome, skill)
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
      const theme: ThemeHint = {
        primaryColor: skill.pin?.primary_color,
        icon: skill.pin?.icon,
        title: skill.name,
      }
      return { text, buttons: keyboard, theme }
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
  await appendHistory(userKey, 'user', text, msg.userDisplayName, msg.userHandle)
  const result = await legacyRoute({ chatId: userKey, user, text, now: new Date() })
  await appendHistory(userKey, 'assistant', result.reply, msg.userDisplayName, msg.userHandle)
  console.log(`[route] user=${userKey} via=${result.via} skill=${result.skill?.id ?? 'none'} text="${text.slice(0, 60)}"`)
  return { text: result.reply }
}
