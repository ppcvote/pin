import { ensureUser, loadUser } from '../storage/jsonStore.js'
import { route as legacyRoute } from '../router.js'
import { appendHistory } from '../brain/memory.js'
import { findAction, findSkill, allSkills, skillVisibleTo, isPlatformOwner } from '../platform/registry.js'
import { startApply, appsConsole, inApply, applyText, applyCallback } from './applyFlow.js'
import { rootMenu, skillMenu, parseCallback } from '../platform/menuRenderer.js'
import { probeAdminAccess } from '../products/udhouse.js'
import { executeAction } from '../platform/actionExecutor.js'
import { startWizard, processWizardCallback, processWizardText, processWizardImage, processWizardImages, type WizardOutcome } from '../platform/wizard.js'
import { createBindingToken } from '../platform/binding.js'
import { buildAgentCardData, renderAgentCardText } from '../platform/agentCard.js'
import { incrementStat, incrementAgentStat } from '../runtime/stats.js'
import { redeemBindToken, peekBindToken } from '../storage/bindTokens.js'
import { resolveCallback } from '../runtime/callbackRefs.js'
import { saveUser } from '../storage/jsonStore.js'
import { reportBound } from '../runtime/flywheelReporter.js'
import { agentRoute, isAgentModeEnabled } from '../brain/agentRouter.js'
import { recentHistory } from '../brain/memory.js'
import { scanRedline, reportRedlineViolation } from '../persona/redline.js'
import { resolveMode, contextFromAction } from '../persona/mode.js'
import type { InboundMessage, OutboundReply, Button, ThemeHint } from '../channels/types.js'

const NAV_ROW = (skillId?: string): Button[] => skillId
  ? [{ text: `⬅️ 返回`, callback_data: `s:${skillId}` }, { text: '🏠 主選單', callback_data: 'm:root' }]
  : [{ text: '🏠 主選單', callback_data: 'm:root' }]

/**
 * Probe admin access for any requires_admin skills that haven't been checked yet.
 * Result is persisted to user.admin_probe_cache so subsequent messages are instant.
 * Fail-safe: any probe error → isAdmin=false (non-admin).
 */
async function ensureAdminProbeCache(user: import('../storage/jsonStore.js').UserRecord, userKey: string): Promise<void> {
  const adminSkills = allSkills().filter(s => s.pin?.requires_admin)
  if (adminSkills.length === 0) return
  let dirty = false
  for (const skill of adminSkills) {
    if (user.admin_probe_cache?.[skill.id] !== undefined) continue
    let isAdmin = false
    try {
      isAdmin = await probeAdminAccess()
    } catch {
      isAdmin = false
    }
    if (!user.admin_probe_cache) user.admin_probe_cache = {}
    user.admin_probe_cache[skill.id] = { isAdmin, checkedAt: new Date().toISOString() }
    dirty = true
    console.log(`[admin-gate] probed skill=${skill.id} isAdmin=${isAdmin} user=${userKey}`)
  }
  if (dirty) await saveUser(user)
}

/** Derive admin-granted skill IDs from the cached probe results on the user record. */
function adminGrantsFromCache(user: import('../storage/jsonStore.js').UserRecord): string[] {
  return Object.entries(user.admin_probe_cache ?? {})
    .filter(([, v]) => v.isAdmin)
    .map(([k]) => k)
}

/** Render the platform's main onboarding screen. */
function welcomeScreen(displayName: string, adminGrants: string[] = [], viewerKey?: string): OutboundReply {
  const adminGranted = new Set(adminGrants)
  const skills = allSkills().filter(s => !s.pin?.hide_from_root && (!s.pin?.requires_admin || adminGranted.has(s.id)) && skillVisibleTo(s, viewerKey))
  const skillNames = skills.map(s => `${s.pin?.icon ?? '•'} ${s.name}`).join('  ')
  const text = [
    `👋 Hi ${displayName}, 我是 **Pin**`,
    '',
    'Ultra Lab 全產品的 AI 入口 — 一個介面操控所有工具',
    '',
    `現有 skill (${skills.length} 個):`,
    skillNames,
    '',
    '點下面任一個直接試 ↓',
  ].join('\n')

  const buttons: Button[][] = []
  for (const s of skills) {
    buttons.push([{ text: `${s.pin?.icon ?? '•'} ${s.name}`, callback_data: `s:${s.id}` }])
  }
  buttons.push([{ text: '📖 完整指令說明', callback_data: 'sys:help' }])

  return { text, buttons, parseMode: 'markdown' }
}

function helpScreen(): OutboundReply {
  const agentOn = process.env.PIN_AGENT_MODE === 'true' || process.env.PIN_AGENT_MODE === '1'
  return {
    text: [
      '📖 Pin 指令一覽',
      '',
      '🔘 主操作:',
      '  /menu     開所有 skill 選單',
      '  /start    歡迎畫面',
      '  /apply    把你的網頁變成 Pin 選單（送審後上線）',
      '  /card     看我的 Agent 卡 (含分享圖)',
      '  /stats    本週 dogfood 數字 + Agent 決策分布',
      '  /version  Pin runtime 版本資訊',
      '  /help     這頁',
      '',
      `🤖 Agent Mode: ${agentOn ? 'ON ✅ 你可以直接打自然語言' : 'OFF · 走規則路由'}`,
      '  例 (when ON):',
      '    「看一下我的物件」     → 直接執行',
      '    「這個月成效如何」     → 直接執行',
      '    「幫我發文」          → 問你發到哪個帳號',
      '',
      '🔗 綁定 (產品端 deep link):',
      '  從產品後台點「📱 用 LINE 管理」→ 一鍵連接',
      '  詳見 ultralab.tw/pin (即將上線)',
      '',
      '🧩 開發者:',
      '  Pin 跑在 SKILL.md 標準 (Anthropic Agent Skills)',
      '  任何產品寫 SKILL.md 就接入 LINE/TG/MCP',
      '  Spec: https://agentskills.io/specification',
      '  Pin: https://github.com/ppcvote/pin',
    ].join('\n'),
    buttons: [[{ text: '🏠 回主選單', callback_data: 'm:root' }]],
  }
}

/**
 * The channel-agnostic Pin message handler.
 * Returns a reply or null (when nothing to send).
 */
/** Insert a "🔓 解除連接" button on a skill menu when the user has it bound. */
function withUnbindButton(buttons: Button[][], skillId: string, isBound: boolean): Button[][] {
  if (!isBound) return buttons
  const out = buttons.map(row => [...row])
  // Insert before the trailing nav row (last row)
  const navRow = out.pop()
  out.push([{ text: '🔓 解除連接', callback_data: `unbind:${skillId}` }])
  if (navRow) out.push(navRow)
  return out
}

function wizardOutcomeToReply(outcome: WizardOutcome, skill?: { pin?: { primary_color?: string; icon?: string }; name?: string }): OutboundReply {
  const theme: ThemeHint | undefined = skill ? {
    primaryColor: skill.pin?.primary_color,
    icon: skill.pin?.icon,
    title: skill.name,
  } : undefined
  const buttons = (outcome as any).buttons as Button[] | undefined
  // Lay wizard buttons out 2-per-row instead of one cramped row — a single
  // long row shrinks each button so its label (esp. Chinese) is unreadable.
  const keyboard = buttons && buttons.length > 0 ? chunkButtons(buttons, 2) : undefined
  return { text: outcome.text, buttons: keyboard, theme }
}

/** Split a flat button list into rows of at most `perRow` (keeps labels readable). */
function chunkButtons(arr: Button[], perRow: number): Button[][] {
  const rows: Button[][] = []
  for (let i = 0; i < arr.length; i += perRow) rows.push(arr.slice(i, i + perRow))
  return rows
}

// 統一的「我的名片」中樞（PPC 6/16：agent 分享頁＝名片，一個就好）。
// 看／分享走 /card/{slug}（那頁顯示卡＋轉傳），編輯走 /edit。是 owner 在 Pin 裡的唯一一張卡。
function myCardReply(us: { slug: string; editToken: string; name?: string }, edit = false): OutboundReply {
  const cardUrl = `https://ultralab.tw/card/${us.slug}`
  const editUrl = `https://ultralab.tw/edit/${us.slug}?t=${us.editToken}`
  return {
    text: `🪪 ${us.name ? us.name + ' 的名片卡' : '你的名片卡'}\n\n別人來找你，我第一時間轉給你。看一下、改一下、或轉傳給朋友 👇`,
    buttons: [
      [{ text: '🔗 看 / 分享名片卡', url: cardUrl }],
      [{ text: '✏️ 編輯名片', url: editUrl }],
      [{ text: '🏠 主選單', callback_data: 'm:root' }],
    ],
    theme: { title: 'Pin', icon: '🪪' },
    edit,
  }
}

export async function handlePinMessage(msg: InboundMessage): Promise<OutboundReply | null> {
  // Composite user key for cross-channel isolation. TG digits, LINE alphanumeric, etc.
  // Stored as the jsonStore filename directly — channel prefix prevents collisions.
  const userKey = `${msg.channelId}:${msg.userId}`
  let user = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)

  // Admin gate: probe requires_admin skills once per user; cache result in user record.
  // Fast no-op after first probe. Fail-safe: any error → non-admin.
  await ensureAdminProbeCache(user, userKey)
  const adminGrants = adminGrantsFromCache(user)

  // Resolve callback indirection (`cb:<hash>` → full callback) before ANY
  // routing — including the wizard branch below, which must see the real
  // `wz:` prefix or it would mis-cancel an active wizard.
  if (msg.callback?.startsWith('cb:')) {
    const full = resolveCallback(msg.callback)
    if (!full) {
      return { text: '⌛ 這個選單放太久過期了, 請重新操作一次', buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]] }
    }
    msg = { ...msg, callback: full }
  }

  // ── Active wizard takes priority — intercept text + wizard callbacks ──
  if (user.wizard) {
    const skill = findSkill(user.wizard.skillId)
    if (msg.callback?.startsWith('wz:')) {
      // Reload to avoid stale state across concurrent turns
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardCallback(user, msg.callback)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    }
    if (msg.images && msg.images.length > 0) {
      // TG album: multiple images delivered at once → commit immediately
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardImages(user, msg.images)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    } else if (msg.image) {
      // Single image (LINE, WA, TG single) → accumulate, show "done" button
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardImage(user, msg.image)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    }
    if (msg.text && !msg.text.startsWith('/')) {
      user = (await loadUser(userKey)) ?? user
      const outcome = await processWizardText(user, msg.text)
      if (outcome) return wizardOutcomeToReply(outcome, skill)
    }
    // If user typed a slash command (/menu, /card, /stats, /help) or a
    // non-wizard callback mid-wizard, silently cancel the wizard and fall
    // through to normal flow. Otherwise the wizard would re-engage on the
    // user's next text input, which is unexpected after they explicitly
    // navigated away.
    const slashCommand = !!msg.text && msg.text.startsWith('/')
    const nonWizardCallback = !!msg.callback && !msg.callback.startsWith('wz:')
    if (slashCommand || nonWizardCallback) {
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

    // Self-serve apply (applicant apply:* + owner ap:*) — handled before the
    // generic callback parser so its prefixes never collide with skill routing.
    if (data.startsWith('apply:') || data.startsWith('ap:')) {
      const r = await applyCallback(user, userKey, msg.userDisplayName, data)
      if (r) return r
    }

    const parsed = parseCallback(data)

    if (parsed.kind === 'root') {
      const boundIds = Object.keys(user.bindings ?? {})
      const { title, buttons } = rootMenu(boundIds, adminGrants, userKey)
      return { text: title, buttons, edit: true, theme: { title: 'Pin' } }
    }
    if (data === 'explore') {
      const adminGranted = new Set(adminGrants)
      const boundIds = new Set(Object.keys(user.bindings ?? {}))
      const unbound = allSkills()
        .filter(s => !s.pin?.hide_from_root)
        .filter(s => !s.pin?.requires_admin || adminGranted.has(s.id))
        .filter(s => skillVisibleTo(s, userKey))
        .filter(s => !boundIds.has(s.id))
      if (unbound.length === 0) {
        return { text: '所有 skill 都已連接 🎉', buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]] }
      }
      const buttons: Button[][] = []
      for (const s of unbound) {
        const icon = s.pin?.icon ?? '•'
        const desc = (s.description ?? '').split('\n')[0].slice(0, 60)
        // If skill declares connect_url, expose an outbound link straight to it
        if (s.pin?.connect_url) {
          buttons.push([{ text: `${icon} ${s.name}`, url: s.pin.connect_url }])
        } else {
          buttons.push([{ text: `${icon} ${s.name} — 從產品端綁定`, callback_data: `s:${s.id}` }])
        }
      }
      buttons.push([{ text: '🏠 主選單', callback_data: 'm:root' }])
      const lines = unbound.map(s => `${s.pin?.icon ?? '•'} ${s.name} — ${(s.description ?? '').split('\n')[0].slice(0, 60)}`)
      return {
        text: `🧭 探索\n\n你還沒連接這些 skills:\n\n${lines.join('\n')}\n\n從產品後台點「📱 用 LINE 管理」就能一鍵連接。`,
        buttons,
        edit: true,
      }
    }
    if (parsed.kind === 'skill') {
      const view = skillMenu(parsed.skillId)
      if (!view) return { text: 'Skill not found', edit: true }
      const skill = findSkill(parsed.skillId)
      const isBound = !!user.bindings?.[parsed.skillId]
      const buttons = withUnbindButton(view.buttons, parsed.skillId, isBound)
      const theme: ThemeHint = {
        primaryColor: skill?.pin?.primary_color,
        icon: skill?.pin?.icon,
        title: skill?.name,
      }
      return { text: view.title, buttons, edit: true, theme }
    }

    // System-injected: agent-mode mutation confirmation
    if (data.startsWith('agent_confirm:')) {
      const pendingId = data.slice('agent_confirm:'.length)
      user = (await loadUser(userKey)) ?? user
      const pending = user.agent_pending
      if (!pending || pending.pendingId !== pendingId) {
        return { text: '⏰ 確認已失效, 請重新對 agent 下指令' }
      }
      if (new Date(pending.expiresAt).getTime() < Date.now()) {
        user.agent_pending = undefined
        await saveUser(user)
        return { text: '⏰ 確認已過期, 請重新對 agent 下指令' }
      }
      const found = findAction(pending.skillId, pending.actionId)
      if (!found) {
        user.agent_pending = undefined
        await saveUser(user)
        return { text: 'Action 已不存在' }
      }
      const { skill, action } = found
      user.agent_pending = undefined
      await saveUser(user)
      const result = await executeAction(skill, action, pending.args)
      await incrementStat(userKey, 'actions')
      const replyText = result.ok
        ? (result.rendered ?? '✅ 完成')
        : `${action.label} 失敗: ${result.error}`
      const theme: ThemeHint = { primaryColor: skill.pin?.primary_color, icon: skill.pin?.icon, title: skill.name }
      return {
        text: replyText,
        buttons: [[
          { text: `⬅️ ${skill.name}`, callback_data: `s:${skill.id}` },
          { text: '🏠 主選單', callback_data: 'm:root' },
        ]],
        theme,
      }
    }

    // System-injected: unbind flow (confirm → delete binding)
    if (data.startsWith('unbind:')) {
      const skillId = data.slice('unbind:'.length)
      const skill = findSkill(skillId)
      if (!skill) return { text: 'Skill not found' }
      if (!user.bindings?.[skillId]) {
        return { text: '此 skill 目前沒有綁定' }
      }
      const icon = skill.pin?.icon ?? '•'
      return {
        text: `⚠️ 確定要解除連接 ${icon} ${skill.name}?\n\n之後該產品的通知會停止推送,直到你重新從產品端綁定。`,
        buttons: [[
          { text: '✅ 確定解除', callback_data: `unbind_confirm:${skillId}` },
          { text: '❌ 取消', callback_data: `s:${skillId}` },
        ]],
        theme: { primaryColor: skill.pin?.primary_color, icon, title: skill.name },
      }
    }
    if (data.startsWith('unbind_confirm:')) {
      const skillId = data.slice('unbind_confirm:'.length)
      const skill = findSkill(skillId)
      if (!skill) return { text: 'Skill not found' }
      const u = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)
      if (u.bindings && skillId in u.bindings) {
        delete u.bindings[skillId]
        await saveUser(u)
      }
      console.log(`[unbind] user=${userKey} skill=${skillId}`)
      return {
        text: `🔓 已解除 ${skill.pin?.icon ?? '•'} ${skill.name} 連接`,
        buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]],
      }
    }

    // System-injected: agent card ＝ 名片（PPC：一個就好）。有名片＝顯示名片中樞；沒有＝agent 卡 + 做一張。
    if (data === 'card') {
      if (user.ultrasite?.slug && user.ultrasite.editToken) {
        return myCardReply(user.ultrasite, true)
      }
      const cardData = await buildAgentCardData(userKey)
      const text = renderAgentCardText(cardData)
      return {
        text: text + '\n\n還沒有自己的名片？做一張，就能在這看、改、分享。',
        buttons: [[
          { text: '＋ 做一張我的名片', url: 'https://ultralab.tw/me' },
        ], [
          { text: '🖼️ 產生分享圖', callback_data: 'card_share' },
        ], [
          { text: '⬅️ 主選單', callback_data: 'm:root' },
        ]],
        theme: { title: 'Pin' },
        edit: true,
      }
    }

    // System-injected: share PNG card
    if (data === 'card_share') {
      try {
        const { renderCardPng } = await import('../runtime/cardRenderer.js')
        const { saveTempBlob } = await import('../runtime/tempStore.js')
        const cardData = await buildAgentCardData(userKey)
        const png = renderCardPng(cardData, userKey)
        const ref = saveTempBlob(png, 'image/png')
        const filename = ref.slice(4)  // strip "tmp:"
        const baseUrl = process.env.PIN_PUBLIC_URL ?? ''
        if (!baseUrl) {
          return { text: '⚠️ 分享圖需要 PIN_PUBLIC_URL 設定 (公網 URL). 請聯絡管理員。' }
        }
        const imageUrl = `${baseUrl.replace(/\/$/, '')}/image/${filename}`
        const caption = `我的 agent 本週零幻覺完成 ${cardData.stats.actions} 次操作 ⚡ pin`
        // Render via the active channel adapter (we don't have channel ref here in handle.ts;
        // returning a special OutboundReply.kind would be cleaner — but channels can also
        // pull the image via the URL in the reply. For now, fall through with a public link.)
        return {
          text: `📸 分享圖好了\n${caption}\n\n🔗 ${imageUrl}\n(連結 30 分鐘內有效)`,
          buttons: [[
            { text: '🔗 開分享圖', url: imageUrl },
            { text: '⬅️ 返回卡片', callback_data: 'card' },
          ]],
          theme: { title: 'Pin' },
        }
      } catch (err) {
        console.error('[card_share]', err)
        return { text: '產生分享圖失敗 😢' }
      }
    }

    // System-injected: binding code
    if (data.startsWith('bind:')) {
      const skillId = data.slice(5)
      const skill = findSkill(skillId)
      if (!skill?.pin?.webhooks?.length) {
        return { text: '此 skill 沒有可綁定的通知事件' }
      }
      try {
        const eventLines = skill.pin.webhooks.map(w => `· ${w.event}`).join('\n')
        const chLabel = msg.channelId === 'line' ? 'LINE' : 'TG'
        const theme: ThemeHint = {
          primaryColor: skill.pin?.primary_color,
          icon: skill.pin?.icon,
          title: skill.name,
        }

        // Preferred path: the product has a 後台「整合/連接 Pin」page that runs the
        // bind itself (one tap). Give a direct link there — no paste-this-code.
        if (skill.pin?.bind_url) {
          const text = [
            `🔔 ${skill.name} 通知綁定`,
            '',
            `到 ${skill.name} 後台一鍵連接 Pin 👇`,
            `（已登入後台的話，點「連接 Pin」就好）`,
            '',
            `連接後，這些事件會推到你 ${chLabel}:`,
            eventLines,
          ].join('\n')
          return {
            text,
            buttons: [
              [{ text: '🔗 去後台連接 Pin', url: skill.pin.bind_url }],
              [
                { text: `⬅️ ${skill.name}`, callback_data: `s:${skill.id}` },
                { text: '🏠 主選單', callback_data: 'm:root' },
              ],
            ],
            theme,
          }
        }

        // Legacy fallback: skills without a 後台 bind page get the paste-a-code flow.
        const token = await createBindingToken(userKey, skillId)
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
          `4. 之後這些事件會推到你 ${chLabel}:`,
          eventLines,
        ].join('\n')
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
      // Count button-driven actions only (wizard ones get counted when finalized)
      await incrementStat(userKey, 'actions')
      // PIN_PERSONA §1 — resolve mode from action context (already scanned in actionExecutor)
      const _mode = resolveMode(contextFromAction({
        hasPreview: !!action.preview,
        httpMethod: action.api?.method,
        renderedText: result.rendered,
      }))
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

  // ULTRASITE 名片認領 — TG 走 /start us_{token}；LINE 沒有 /start，用預填訊息帶 us_{token}（夾在中文裡也接）。
  const usMatch = text.match(/us_([a-f0-9]{12,32})/i)
  if (usMatch) {
    const token = usMatch[1].toLowerCase()
    try {
      const r = await fetch('https://ultralab.tw/api/probe-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ultrasite-claim', token,
          channelType: msg.channelId === 'tg' ? 'telegram' : msg.channelId,
          channelId: msg.userId,
        }),
      })
      const d: any = await r.json().catch(() => ({}))
      if (r.ok && d?.ok) {
        // 存 slug+editToken → 之後「改名片」一鍵開編輯器（放照片/改字都在這）
        if (d.editToken) {
          try {
            const u = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)
            u.ultrasite = { slug: d.slug, editToken: d.editToken, name: d.name || '', boundAt: new Date().toISOString() }
            await saveUser(u)
          } catch { /* 存失敗不擋認領；改名片時會再退回提示 */ }
        }
        return {
          text: `✅ 這頁現在歸你了${d.name ? `（${d.name}）` : ''}。有人在上面留訊息，我第一時間轉給你。\n\n想改內容、換照片？跟我說「改名片」，或直接點下面 👇`,
          buttons: d.editToken ? [[{ text: '✏️ 編輯我的名片', url: `https://ultralab.tw/edit/${d.slug}?t=${d.editToken}` }]] : undefined,
        }
      }
      return { text: '🔒 這個連結已失效或已被認領。回名片頁重新點「把 Pin 留下」就好。' }
    } catch {
      return { text: '網絡有點不順，等一下再點一次。' }
    }
  }

  // 域名升級 — /start domain：開 GENESIS 域名 skill（查 / 比價 / 註冊）。
  if (/^\/start\s+domain\s*$/i.test(text)) {
    const skill = findSkill('domain')
    if (skill) {
      const view = skillMenu(skill.id)
      return {
        text: '🌐 想要自己的網域？我幫你查可不可以用、比個價，要的話直接幫你註冊。',
        buttons: view?.buttons,
        theme: { primaryColor: skill.pin?.primary_color, icon: skill.pin?.icon ?? '🌐', title: skill.name },
      }
    }
    return { text: '🌐 域名功能正在上線中，晚點再來。' }
  }

  // Bind-token redemption — supports two forms:
  //   - LINE: user opens prefilled message "bind <token>"
  //   - TG:   /start <token> (telegraf passes the payload as the message text)
  const bindMatch = text.match(/^(?:bind|\/start)\s+([a-f0-9]{32})\s*$/i)
  if (bindMatch) {
    // Rate limit: 10 attempts/hour per user. Silently swallow above the cap.
    const u = await ensureUser(userKey, msg.userDisplayName, msg.userHandle)
    const hourBucket = new Date().toISOString().slice(0, 13)  // "2026-06-12T01"
    if (u.bind_attempts && u.bind_attempts.hourBucket === hourBucket && u.bind_attempts.count >= 10) {
      console.warn(`[bind redeem] rate-limited user=${userKey}`)
      return null  // silent ignore
    }
    u.bind_attempts = { hourBucket,
      count: (u.bind_attempts?.hourBucket === hourBucket ? u.bind_attempts.count : 0) + 1 }
    await saveUser(u)

    const token = bindMatch[1].toLowerCase()
    const entry = await redeemBindToken(token, userKey)
    if (!entry) {
      // Double-tap: LINE keeps the prefilled message around, so users often
      // send "bind <token>" twice. If THIS user already consumed this token
      // and still holds the binding, answer idempotently instead of scaring
      // them with "link expired" right after a successful bind.
      const prior = await peekBindToken(token)
      if (prior?.used && prior.usedBy === userKey && u.bindings?.[prior.skillName]) {
        const skill = findSkill(prior.skillName)
        if (skill) {
          const icon = skill.pin?.icon ?? '•'
          const view = skillMenu(skill.id)
          return {
            text: `✅ 已連接 ${icon} ${skill.name}, 不用再按一次囉`,
            buttons: view ? withUnbindButton(view.buttons, skill.id, true) : undefined,
            theme: { primaryColor: skill.pin?.primary_color, icon, title: skill.name },
          }
        }
      }
      return { text: '🔒 連結已失效, 請回到產品頁面重新點擊' }
    }
    const skill = findSkill(entry.skillName)
    if (!skill) return { text: '🔒 連結已失效, 請回到產品頁面重新點擊' }
    // Rebind (re-click from product page / device change): keep the flow
    // silent-success but say so, and don't double-count the flywheel event.
    const prevBinding = u.bindings?.[entry.skillName]
    u.bindings = { ...(u.bindings ?? {}), [entry.skillName]: { tenantKey: entry.tenantKey, boundAt: new Date().toISOString() } }
    await saveUser(u)
    // Flywheel §3 — fire-and-forget pin_bound event (first bind only)
    if (!prevBinding) reportBound(userKey, entry.skillName)
    const icon = skill.pin?.icon ?? '•'
    const view = skillMenu(skill.id)
    const buttons = view ? withUnbindButton(view.buttons, skill.id, true) : undefined

    // FLYWHEEL §2 — UltraGrowth bind-ceremony: lead with the AVS before/after
    // shipped in the token's meta. First impression is the value proof.
    if (entry.skillName === 'ultragrowth' && entry.meta?.avs_before != null && entry.meta?.avs_after != null) {
      const before = Number(entry.meta.avs_before)
      const after = Number(entry.meta.avs_after)
      const delta = after - before
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—'
      return {
        text: [
          `✅ 已連接 ${icon} ${skill.name}`,
          ``,
          `📊 你的 AVS 病歷對比 (來自 UltraGrowth 服務介入前 → 現在):`,
          ``,
          `  服務前  ${before}/100`,
          `  現在    ${after}/100   ${arrow} ${Math.abs(delta)} 分`,
          ``,
          `這就是你每月 NT$2,990 換到的數字。`,
          `之後每週 Pin 會在這裡更新你的成效 → 從不卡頓 → 從不忘記。`,
        ].join('\n'),
        buttons,
        theme: { primaryColor: skill.pin?.primary_color, icon, title: skill.name },
      }
    }

    // First-message experience (§A 工單): real customers see this, so no
    // internal identifiers (tenantKey) — say what just happened + what's next.
    const lines = [
      prevBinding ? `✅ 已重新連接 ${icon} ${skill.name}` : `✅ 已連接 ${icon} ${skill.name}`,
      '',
    ]
    if (prevBinding && prevBinding.tenantKey !== entry.tenantKey) {
      lines.push('已切換到新的帳號連結。', '')
    } else if (prevBinding) {
      lines.push('你原本的設定與通知都還在。', '')
    }
    const eventCount = skill.pin?.webhooks?.length ?? 0
    if (eventCount > 0) lines.push(`${skill.name} 的通知之後會直接推到這裡。`)
    lines.push('用下面的選單馬上開始 ↓')
    return {
      text: lines.join('\n'),
      buttons,
      theme: { primaryColor: skill.pin?.primary_color, icon, title: skill.name },
    }
  }

  // Slash commands
  // Deep-link entry: t.me/UltraPinaibot?start=apply → straight into the apply flow.
  if (/^\/start\s+apply$/.test(text)) {
    return startApply(user)
  }
  if (text === '/start') {
    return welcomeScreen(msg.userDisplayName, adminGrants, userKey)
  }
  // LINE follow event — same welcome + bind-recovery hint, because the
  // add-friend interstitial can swallow the product deep link's prefilled
  // "bind <token>" message.
  if (text === '/follow') {
    const w = welcomeScreen(msg.userDisplayName, adminGrants, userKey)
    w.text += '\n\n🔗 從產品頁面點「用 LINE 管理」過來的嗎?\n加好友完成了, 請回到產品頁面**再點一次**那顆按鈕, 就會完成綁定。'
    return w
  }
  if (text === '/menu') {
    const boundIds = Object.keys(user.bindings ?? {})
    const { title, buttons } = rootMenu(boundIds, adminGrants, userKey)
    return { text: title, buttons }
  }
  if (text === '/card') {
    const cardData = await buildAgentCardData(userKey)
    return {
      text: renderAgentCardText(cardData),
      buttons: [[{ text: '⬅️ 主選單', callback_data: 'm:root' }]],
      theme: { title: 'Pin' },
    }
  }
  if (text === '/version') {
    const skills = allSkills()
    const totalActions = skills.reduce((n, s) => n + (s.pin?.actions?.length ?? 0), 0)
    const totalWebhooks = skills.reduce((n, s) => n + (s.pin?.webhooks?.length ?? 0), 0)
    return {
      text: [
        '🃏 Pin runtime',
        '━━━━━━━━━━━━━━━━━',
        `Brain:       ${process.env.BRAIN_MODE ?? 'gemini'}`,
        `Agent Mode:  ${process.env.PIN_AGENT_MODE === 'true' ? 'ON' : 'off'}`,
        `Channels:    LINE + Telegram`,
        `Skills:      ${skills.map(s => `${s.pin?.icon ?? '•'} ${s.id}`).join(', ')}`,
        `  → ${totalActions} actions, ${totalWebhooks} webhooks`,
        `Repo:        github.com/ppcvote/pin`,
      ].join('\n'),
      buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]],
    }
  }
  if (text === '/stats') {
    const { getCurrentWeekStats, getCurrentWeekAgentStats } = await import('../runtime/stats.js')
    const s = await getCurrentWeekStats(userKey)
    const a = await getCurrentWeekAgentStats(userKey)
    const total = a.execute + a.clarify + a.none + a.fallback + a.blocked
    const downgrade = total > 0 ? Math.round(((a.clarify + a.none + a.fallback) / total) * 100) : 0
    return {
      text: [
        '📈 本週 dogfood 數字',
        '━━━━━━━━━━━━━━━━━',
        `🛠 按鈕操作: ${s.actions}`,
        `📨 推播送達: ${s.pushes}`,
        `🧠 LLM 介入: ${s.llmFallbacks}`,
        '',
        '🤖 Agent 模式分布:',
        `   ✅ execute  ${a.execute}`,
        `   🤔 clarify  ${a.clarify}`,
        `   💬 none     ${a.none}`,
        `   🛡 blocked  ${a.blocked}`,
        `   ⚠ fallback ${a.fallback}`,
        total > 0 ? `   降級率: ${downgrade}%  (clarify+none+fallback)` : '   (尚無 agent 樣本)',
      ].join('\n'),
      buttons: [[
        { text: '🃏 看卡片', callback_data: 'card' },
        { text: '🏠 主選單', callback_data: 'm:root' },
      ]],
    }
  }
  if (text === '/apply') {
    return startApply(user)
  }
  if (text === '/apps') {
    if (!isPlatformOwner(userKey)) return { text: '我看不懂這個指令 — 試 /menu 或自然語言' }
    return appsConsole()
  }
  if (text === '/help') {
    return helpScreen()
  }
  if (text.startsWith('/')) {
    return { text: '我看不懂這個指令 — 試 /menu 或自然語言' }
  }

  // Self-serve apply: if the user is mid-application, a pasted (non-slash) URL
  // continues the flow. Slash commands above already escaped it.
  if (inApply(user)) {
    return applyText(user, text)
  }

  // ULTRASITE「我的名片 / 看名片」—— 顯示名片中樞（看/分享 + 編輯，agent 卡＝名片，一個就好）。
  if (/^(我的|看|查看|顯示|秀).{0,2}(名片|卡片|agent|代理)$|^(名片|我的卡|我的agent)$/i.test(text.trim())) {
    if (user.ultrasite?.slug && user.ultrasite.editToken) return myCardReply(user.ultrasite)
    return {
      text: '你還沒有名片卡。做一張，就能在這看、改、分享 👇',
      buttons: [[{ text: '＋ 做一張我的名片', url: 'https://ultralab.tw/me' }]],
    }
  }

  // ULTRASITE「改名片」—— 一鍵開視覺編輯器（放照片/改字/換色，所見即所得）。
  if (/(改|編輯|換|修改).{0,3}(名片|卡片|網頁|頁面|照片|大頭照)|名片.{0,2}(怎麼|要)?(改|編輯)/.test(text)) {
    if (user.ultrasite?.slug && user.ultrasite.editToken) {
      const us = user.ultrasite
      return {
        text: `改你的名片頁${us.name ? `（${us.name}）` : ''} —— 點下面開編輯器，名字／頭銜／標語／介紹／顏色／**照片**都能改，改完按「儲存」就即時更新，網址不變。`,
        buttons: [[{ text: '✏️ 開啟編輯器', url: `https://ultralab.tw/edit/${us.slug}?t=${us.editToken}` }]],
      }
    }
    return {
      text: '你還沒有用 Pin 做的名片頁喔。要不要先做一個？幾個問題就好，做完就能改、能放照片。',
      buttons: [[{ text: '做一張我的名片', url: 'https://ultralab.tw/me' }]],
    }
  }

  // Free-form text routing
  await appendHistory(userKey, 'user', text, msg.userDisplayName, msg.userHandle)

  // PIN_AGENT_MODE — LLM picks one registered action; everything still flows
  // through the deterministic pipeline (wizard / args / preview / confirm).
  if (isAgentModeEnabled()) {
    user = (await loadUser(userKey)) ?? user
    const history = await recentHistory(userKey, 6)
    const decision = await agentRoute(user, text, history)
    if (decision.kind === 'blocked') {
      console.warn(`[shield blocked] user=${userKey} threats=${decision.threats.map(t => t.type).join(',')}`)
      await incrementAgentStat(userKey, 'blocked')
      return {
        text: `🛡️ Pin 偵測到這段話可能在繞 agent 邊界 (${decision.threats[0]?.type ?? decision.reason})\n\n從選單操作完全不受影響 👇`,
        buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]],
      }
    }
    // Block didn't call the LLM at all, so don't count it.
    await incrementStat(userKey, 'llmFallbacks')
    await incrementAgentStat(userKey, decision.kind)
    if (decision.kind === 'execute') {
      // Re-use the existing action call path so wizard / preview behave the same.
      const found = findAction(decision.tool.skillId, decision.tool.actionId)
      if (!found) {
        return { text: 'agent picked an action that no longer exists — falling back to menu',
                 buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]] }
      }
      const { skill, action } = found

      // PIN_AGENT_MODE §4.2 — force preview on agent-triggered mutations.
      const isMutation = ['POST', 'PUT', 'DELETE'].includes(action.api?.method ?? '')
      const hasNativePreview = !!action.preview
      if (isMutation && !hasNativePreview) {
        const crypto = await import('node:crypto')
        const pendingId = crypto.randomBytes(4).toString('hex')
        user = (await loadUser(userKey)) ?? user
        user.agent_pending = {
          pendingId,
          skillId: skill.id,
          actionId: action.id,
          args: decision.args ?? {},
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }
        await saveUser(user)
        const argLines = Object.entries(decision.args ?? {})
          .map(([k, v]) => `   • ${k}: ${String(v).slice(0, 100)}`)
          .join('\n')
        return {
          text: `🤖 我打算執行: ${skill.pin?.icon ?? ''} ${action.label}\n\n參數:\n${argLines || '   (無)'}\n\n⚠️ 這個動作會寫入資料, 先確定再動?\n\n🧠×1`,
          buttons: [[
            { text: '✅ 確定執行', callback_data: `agent_confirm:${pendingId}` },
            { text: '❌ 取消', callback_data: 'm:root' },
          ]],
          theme: { primaryColor: skill.pin?.primary_color, icon: skill.pin?.icon, title: skill.name },
        }
      }

      const missing = (action.args ?? []).filter(a => !(a.name in (decision.args ?? {})))
      if (missing.length > 0) {
        // Start wizard pre-seeded with what the LLM did supply
        user = (await loadUser(userKey)) ?? user
        const outcome = await startWizard(user, skill.id, action.id)
        if (user.wizard) {
          Object.assign(user.wizard.collected, decision.args ?? {})
          await saveUser(user)
        }
        const reply = wizardOutcomeToReply(outcome, skill)
        return { ...reply, text: `${reply.text}\n\n🧠×1` }
      }
      const result = await executeAction(skill, action, decision.args ?? {})
      await incrementStat(userKey, 'actions')
      // PIN_PERSONA §1 — determine mode from this action's context (result already scanned)
      const _agentMode = resolveMode(contextFromAction({
        hasPreview: !!action.preview,
        httpMethod: action.api?.method,
        renderedText: result.rendered,
      }))
      const replyText = result.ok
        ? (result.rendered ?? '✅ 完成')
        : `${action.label} 失敗: ${result.error}`
      const theme: ThemeHint = { primaryColor: skill.pin?.primary_color, icon: skill.pin?.icon, title: skill.name }
      await appendHistory(userKey, 'assistant', replyText, msg.userDisplayName, msg.userHandle)
      return { text: `${replyText}\n\n🧠×1`, theme,
               buttons: [[{ text: `⬅️ ${skill.name}`, callback_data: `s:${skill.id}` }, { text: '🏠 主選單', callback_data: 'm:root' }]] }
    }
    if (decision.kind === 'clarify') {
      // Render candidate buttons with friendly action labels (with skill icon)
      // instead of raw tool names like "mindthread__post". The compiled tool's
      // description carries "<skill icon> <skill name>: <action label> — <desc>".
      const candidateButtons: Button[][] = decision.candidates.map(c => {
        const found = findAction(c.skillId, c.actionId)
        const icon = found?.skill?.pin?.icon ?? '•'
        const label = found?.action?.label ?? c.actionId
        return [{ text: `${icon} ${label}`, callback_data: `a:${c.skillId}:${c.actionId}` }]
      })
      candidateButtons.push([{ text: '🏠 主選單', callback_data: 'm:root' }])
      await appendHistory(userKey, 'assistant', decision.question, msg.userDisplayName, msg.userHandle)
      // PIN_PERSONA §8 — scan LLM clarification text for redline violations
      const _clarifyScan = scanRedline(decision.question)
      if (!_clarifyScan.passed) reportRedlineViolation(`agent:clarify user=${userKey}`, _clarifyScan.hits)
      return { text: `${decision.question}\n\n🧠×1`, buttons: candidateButtons }
    }
    if (decision.kind === 'none') {
      await appendHistory(userKey, 'assistant', decision.reply, msg.userDisplayName, msg.userHandle)
      // PIN_PERSONA §8 — scan LLM none-reply text for redline violations
      const _noneScan = scanRedline(decision.reply)
      if (!_noneScan.passed) reportRedlineViolation(`agent:none user=${userKey}`, _noneScan.hits)
      return { text: `${decision.reply}\n\n或從選單操作 👇  🧠×1`,
               buttons: [[{ text: '🏠 主選單', callback_data: 'm:root' }]] }
    }
    // fallback — show menu
    const boundIds = Object.keys(user.bindings ?? {})
    const root = rootMenu(boundIds, [], userKey)
    await incrementAgentStat(userKey, 'fallback')
    return { text: `(我這邊路由曖昧, 給你選單 — ${decision.reason})`, buttons: root.buttons }
  }

  // Legacy free-form path (regex first, optional LLM fallback) — used when
  // PIN_AGENT_MODE is off. Keeps old behaviour for users who haven't opted in.
  const result = await legacyRoute({ chatId: userKey, user, text, now: new Date() })
  await appendHistory(userKey, 'assistant', result.reply, msg.userDisplayName, msg.userHandle)
  if (result.via === 'llm' || result.via === 'fallback') {
    await incrementStat(userKey, 'llmFallbacks')
  }
  // Log routing metadata only — never the message body (may contain PII).
  console.log(`[route] user=${userKey} via=${result.via} skill=${result.skill?.id ?? 'none'} text_len=${text.length}`)
  return { text: result.reply }
}
