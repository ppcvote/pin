/**
 * Wizard runtime — drives multi-step actions whose args need to be collected
 * one at a time (button choice or free text input).
 *
 * Designed channel-agnostic: returns prompts as plain text + button arrays.
 * The active wizard state lives on the user record (jsonStore.wizard).
 *
 * Lifecycle:
 *   1. handle.ts notices the tapped action has args → calls startWizard()
 *   2. user replies (text or button tap) → handle.ts calls processInput()
 *   3. when all args collected, main action runs
 *      - if action has a preview, show + wait for confirm/retry/cancel
 *      - if confirmed, the confirm_action runs (with content from preview)
 *   4. wizard cleared
 */

import { saveUser, loadUser, type UserRecord, type WizardState } from '../storage/jsonStore.js'
import { executeAction } from './actionExecutor.js'
import { findSkill, findAction } from './registry.js'
import { render } from './template.js'
import type { ActionDef, ArgSpec, Skill } from './types.js'

export type WizardButton = { text: string; callback_data?: string; url?: string }

/** What the channel layer should send back to the user this turn. */
export type WizardOutcome =
  | { kind: 'prompt_text'; text: string; buttons?: WizardButton[] }
  | { kind: 'prompt_choice'; text: string; buttons: WizardButton[] }
  | { kind: 'preview'; text: string; buttons: WizardButton[] }
  | { kind: 'done'; text: string; buttons?: WizardButton[] }
  | { kind: 'cancelled'; text: string }
  | { kind: 'error'; text: string }

const NAV_BTN = (): WizardButton => ({ text: '❌ 取消', callback_data: 'wz:cancel' })

function pathLookup(obj: any, path: string): any {
  if (!path) return obj
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p] }
  return cur
}

/** Pull the array referenced by a from_action arg, so we can render choice buttons. */
async function fetchChoiceArray(skill: Skill, fromActionId: string, args: Record<string, string>): Promise<any[]> {
  const sourceAction = skill.pin?.actions.find(a => a.id === fromActionId)
  if (!sourceAction) return []
  const r = await executeAction(skill, sourceAction, args)
  if (!r.ok) return []
  const path = sourceAction.respond?.choices?.from
  const data = (r.raw && typeof r.raw === 'object' && 'data' in r.raw) ? r.raw.data : r.raw
  if (!path) return Array.isArray(data) ? data : []
  return pathLookup(data, path) ?? pathLookup(r.raw, path) ?? []
}

/** Build the prompt for whichever arg we're currently collecting. */
async function promptForArg(skill: Skill, action: ActionDef, arg: ArgSpec, args: Record<string, string>): Promise<WizardOutcome> {
  // Choice arg — fetch options + render buttons
  if (arg.from_action) {
    const arr = await fetchChoiceArray(skill, arg.from_action, args)
    if (!Array.isArray(arr) || arr.length === 0) {
      return { kind: 'error', text: `沒找到「${arg.label ?? arg.name}」可選的選項` }
    }
    const buttons: WizardButton[] = []
    for (const item of arr.slice(0, 13)) {
      const value = arg.select_key ? String(item?.[arg.select_key] ?? '') : String(item)
      if (!value) continue
      const text = arg.display_key
        ? String(item?.[arg.display_key] ?? value).slice(0, 40)
        : value.slice(0, 40)
      const cb = `wz:${arg.name}:${encodeURIComponent(value)}`
      if (Buffer.byteLength(cb) > 64) continue  // skip too-long callbacks
      buttons.push({ text, callback_data: cb })
    }
    buttons.push(NAV_BTN())
    return { kind: 'prompt_choice', text: `${arg.label ?? arg.name} (${buttons.length - 1} 選 1):`, buttons }
  }

  // Text arg — ask user to type
  if (arg.input === 'text') {
    const hint = arg.placeholder ? `\n💡 例如: ${arg.placeholder}` : ''
    return { kind: 'prompt_text', text: `📝 ${arg.label ?? arg.name}:${hint}`, buttons: [NAV_BTN()] }
  }

  return { kind: 'error', text: `arg "${arg.name}" 沒有可收集的 UI 方式 (缺 from_action 或 input)` }
}

/** Execute the action with collected args; handle preview if declared. */
async function executeAndMaybePreview(user: UserRecord, skill: Skill, action: ActionDef, state: WizardState): Promise<WizardOutcome> {
  const result = await executeAction(skill, action, state.collected)
  if (!result.ok) {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'error', text: `${action.label} 失敗 😢\n${result.error ?? 'unknown'}` }
  }

  // No preview → done
  if (!action.preview) {
    user.wizard = undefined
    await saveUser(user)
    const out: WizardOutcome = { kind: 'done', text: result.rendered ?? '✅ 完成' }
    return out
  }

  // Preview → store generated content for the confirm step, then prompt
  const previewText = render(action.preview.template, {
    response: result.raw,
    data: (result.raw && typeof result.raw === 'object' && 'data' in result.raw) ? result.raw.data : result.raw,
    args: state.collected,
    found: undefined,
    more_count: 0,
  })
  state.preview = {
    content: (result.raw && typeof result.raw === 'object' && 'content' in result.raw) ? (result.raw as any).content : result.raw,
    rawText: previewText,
  }
  user.wizard = state
  await saveUser(user)

  return {
    kind: 'preview',
    text: previewText,
    buttons: [
      { text: '✅ 確認發', callback_data: 'wz:confirm' },
      { text: '🔄 重生', callback_data: 'wz:retry' },
      { text: '❌ 取消', callback_data: 'wz:cancel' },
    ],
  }
}

/** Run the next step of the wizard (or execute if all args collected). */
async function continueWizard(user: UserRecord, skill: Skill, action: ActionDef, state: WizardState): Promise<WizardOutcome> {
  // If we still have args to collect, prompt the next one
  if (state.argIdx < action.args.length) {
    const arg = action.args[state.argIdx]
    return promptForArg(skill, action, arg, state.collected)
  }
  // All collected → execute
  return executeAndMaybePreview(user, skill, action, state)
}

// ── Public API ────────────────────────────────────────────────────────

/** Kick off a wizard for the given (skill, action). Saves state + returns first prompt. */
export async function startWizard(user: UserRecord, skillId: string, actionId: string): Promise<WizardOutcome> {
  const found = findAction(skillId, actionId)
  if (!found) return { kind: 'error', text: 'Action not found' }
  const { skill, action } = found
  if (!action.args || action.args.length === 0) {
    return { kind: 'error', text: 'This action does not need a wizard' }
  }
  const state: WizardState = {
    skillId,
    actionId,
    argIdx: 0,
    collected: {},
    startedAt: new Date().toISOString(),
  }
  user.wizard = state
  await saveUser(user)
  return continueWizard(user, skill, action, state)
}

/** Process a callback while wizard is active. Returns the next outcome. */
export async function processWizardCallback(user: UserRecord, callbackData: string): Promise<WizardOutcome | null> {
  if (!user.wizard) return null
  const state = user.wizard
  const found = findAction(state.skillId, state.actionId)
  if (!found) {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'error', text: 'Wizard state invalid (skill/action gone). Cleared.' }
  }
  const { skill, action } = found

  // Cancel
  if (callbackData === 'wz:cancel') {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'cancelled', text: '已取消' }
  }

  // Confirm — run the confirm_action with collected args + preview content
  if (callbackData === 'wz:confirm' && action.preview) {
    const confirmAction = skill.pin?.actions.find(a => a.id === action.preview!.confirm_action)
    if (!confirmAction) {
      user.wizard = undefined
      await saveUser(user)
      return { kind: 'error', text: `confirm_action "${action.preview.confirm_action}" not found` }
    }
    const confirmArgs: Record<string, string> = {
      ...state.collected,
      content: typeof state.preview?.content === 'string' ? state.preview.content : (state.preview?.rawText ?? ''),
    }
    const r = await executeAction(skill, confirmAction, confirmArgs)
    user.wizard = undefined
    await saveUser(user)
    if (!r.ok) return { kind: 'error', text: `${confirmAction.label} 失敗: ${r.error}` }
    return { kind: 'done', text: r.rendered ?? '✅ 完成' }
  }

  // Retry — re-run main action with same collected args
  if (callbackData === 'wz:retry') {
    return executeAndMaybePreview(user, skill, action, state)
  }

  // Choice arg — format: wz:<arg>:<value>
  if (callbackData.startsWith('wz:')) {
    const rest = callbackData.slice(3)
    const idx = rest.indexOf(':')
    if (idx < 0) return null
    const argName = rest.slice(0, idx)
    const value = decodeURIComponent(rest.slice(idx + 1))
    const currentArg = action.args[state.argIdx]
    if (currentArg.name !== argName) {
      // Stale button from a previous step — ignore
      return null
    }
    state.collected[argName] = value
    state.argIdx += 1
    user.wizard = state
    await saveUser(user)
    return continueWizard(user, skill, action, state)
  }
  return null
}

/** Process a free-text reply while wizard is active. */
export async function processWizardText(user: UserRecord, text: string): Promise<WizardOutcome | null> {
  if (!user.wizard) return null
  const state = user.wizard
  const found = findAction(state.skillId, state.actionId)
  if (!found) {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'error', text: 'Wizard state invalid. Cleared.' }
  }
  const { skill, action } = found

  if (state.argIdx >= action.args.length) {
    // Wizard already collected args but expecting confirm callback, not text
    return { kind: 'error', text: '請用下方按鈕確認 / 取消' }
  }

  const currentArg = action.args[state.argIdx]
  if (currentArg.input !== 'text') {
    // Current step wants a button choice, not text
    return null
  }
  const value = text.trim()
  if (!value) return { kind: 'error', text: '請輸入內容' }

  state.collected[currentArg.name] = value
  state.argIdx += 1
  user.wizard = state
  await saveUser(user)
  return continueWizard(user, skill, action, state)
}
