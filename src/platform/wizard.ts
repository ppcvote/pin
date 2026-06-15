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
import { saveTempBlob } from '../runtime/tempStore.js'
import type { InboundImage } from '../channels/types.js'
import type { ActionDef, ArgSpec, Skill } from './types.js'
import { shortenCallback } from '../runtime/callbackRefs.js'

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

/** Max photos per image arg — mirrors backend MAX_PHOTOS. */
const MAX_WIZARD_PHOTOS = 8

function pathLookup(obj: any, path: string): any {
  if (!path) return obj
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p] }
  return cur
}

/** Set a nested dot-path on an object, creating intermediate objects as needed. */
function setPath(obj: any, path: string, value: any): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

/** Re-render a preview's template from the (possibly edited) content object. */
function renderPreviewText(action: ActionDef, content: any, collected: Record<string, string>): string {
  if (!action.preview) return ''
  const data = (content && typeof content === 'object' && 'data' in content) ? content.data : content
  return render(action.preview.template, { response: content, data, args: collected, found: undefined, more_count: 0 })
}

/** Buttons shown under a preview. Adds「✏️ 修改」when the action declares editable_fields. */
function previewButtons(action: ActionDef): WizardButton[] {
  const btns: WizardButton[] = [{ text: '✅ 確認發', callback_data: 'wz:confirm' }]
  if (action.preview?.editable_fields?.length) btns.push({ text: '✏️ 修改', callback_data: 'wz:edit' })
  btns.push({ text: '🔄 重生', callback_data: 'wz:retry' })
  btns.push({ text: '❌ 取消', callback_data: 'wz:cancel' })
  return btns
}

/** The tap-to-edit field menu: one button per editable field + publish/cancel. */
function editMenuButtons(action: ActionDef): WizardButton[] {
  const fields = action.preview?.editable_fields ?? []
  const btns: WizardButton[] = fields.map((f, i) => ({
    text: f.label.slice(0, 40),
    callback_data: shortenCallback(`wz:ef:${i}`),
  }))
  btns.push({ text: '✅ 改完發佈', callback_data: 'wz:confirm' })
  btns.push({ text: '❌ 取消', callback_data: 'wz:cancel' })
  return btns
}

/** Pull the array referenced by a from_action arg, so we can render choice buttons.
 *  Path resolution order: arg.from_path → source action's respond.choices.from → top-level. */
async function fetchChoiceArray(skill: Skill, fromActionId: string, overridePath: string | undefined, args: Record<string, string>): Promise<any[]> {
  const sourceAction = skill.pin?.actions.find(a => a.id === fromActionId)
  if (!sourceAction) return []
  const r = await executeAction(skill, sourceAction, args)
  if (!r.ok) return []
  const path = overridePath ?? sourceAction.respond?.choices?.from
  const data = (r.raw && typeof r.raw === 'object' && 'data' in r.raw) ? r.raw.data : r.raw
  if (!path) return Array.isArray(data) ? data : []
  return pathLookup(data, path) ?? pathLookup(r.raw, path) ?? []
}

/** Render a "已選" header summarising args collected so far. */
function collectedHeader(action: ActionDef, state: WizardState): string {
  const lines: string[] = []
  for (let i = 0; i < state.argIdx; i++) {
    const a = action.args[i]
    if (!a) continue
    const label = state.collected_labels?.[a.name] ?? state.collected[a.name] ?? ''
    if (!label) continue
    lines.push(`  ${a.label ?? a.name}: ${label}`)
  }
  if (lines.length === 0) return ''
  return `✅ 已選:\n${lines.join('\n')}\n\n`
}

/** Build the prompt for whichever arg we're currently collecting. */
async function promptForArg(skill: Skill, action: ActionDef, arg: ArgSpec, args: Record<string, string>, state: WizardState): Promise<WizardOutcome> {
  const header = collectedHeader(action, state)

  // Static enum
  if (arg.options && arg.options.length > 0) {
    const buttons: WizardButton[] = []
    for (const opt of arg.options) {
      if (!opt.value || !opt.label) continue
      // Oversized values (TG 64-byte cap) go through callback indirection —
      // previously they were silently dropped from the menu.
      const cb = shortenCallback(`wz:${arg.name}:${encodeURIComponent(opt.value)}`)
      buttons.push({ text: opt.label.slice(0, 40), callback_data: cb })
    }
    buttons.push(NAV_BTN())
    return { kind: 'prompt_choice', text: `${header}${arg.label ?? arg.name} (${buttons.length - 1} 選 1):`, buttons }
  }

  // Dynamic enum
  if (arg.from_action) {
    const arr = await fetchChoiceArray(skill, arg.from_action, arg.from_path, args)
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
      const cb = shortenCallback(`wz:${arg.name}:${encodeURIComponent(value)}`)
      buttons.push({ text, callback_data: cb })
    }
    buttons.push(NAV_BTN())
    return { kind: 'prompt_choice', text: `${header}${arg.label ?? arg.name} (${buttons.length - 1} 選 1):`, buttons }
  }

  // Text arg
  if (arg.input === 'text') {
    const hint = arg.placeholder ? `\n💡 例如: ${arg.placeholder}` : ''
    return { kind: 'prompt_text', text: `${header}📝 ${arg.label ?? arg.name}:${hint}`, buttons: [NAV_BTN()] }
  }

  // Image arg
  if (arg.type === 'image' || arg.input === 'attachment') {
    const hint = arg.placeholder ? `\n💡 ${arg.placeholder}` : ''
    const pendingCount = state.pending_images?.length ?? 0
    if (pendingCount > 0) {
      return {
        kind: 'prompt_text',
        text: `${header}📸 已收到 ${pendingCount} 張照片。可繼續傳，或按「開始分析」${hint}`,
        buttons: [
          { text: `📊 開始分析 (${pendingCount} 張)`, callback_data: 'wz:img:commit' },
          NAV_BTN(),
        ],
      }
    }
    return { kind: 'prompt_text', text: `${header}📸 ${arg.label ?? arg.name} — 可一次傳多張（相簿），或傳單張${hint}`, buttons: [NAV_BTN()] }
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

  // No preview → done. Carry the action's follow-up/choice buttons through —
  // a result like a download link lives in followUps, not the text.
  if (!action.preview) {
    user.wizard = undefined
    await saveUser(user)
    const buttons: WizardButton[] = [
      ...(result.followUps ?? []).map(f => ({ text: f.text, callback_data: f.callback_data, url: f.url })),
      ...(result.choices ?? []).map(c => ({ text: c.text, callback_data: c.callback_data })),
    ]
    const out: WizardOutcome = { kind: 'done', text: result.rendered ?? '✅ 完成', buttons: buttons.length ? buttons : undefined }
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
  // Resolve content: walk content_path if provided, else fall back to a few heuristics
  let extractedContent: any = result.raw
  if (action.preview.content_path) {
    extractedContent = pathLookup(result.raw, action.preview.content_path)
  } else if (result.raw && typeof result.raw === 'object') {
    extractedContent = (result.raw as any).content ?? result.raw
  }
  state.preview = {
    content: extractedContent,
    rawText: previewText,
  }
  user.wizard = state
  await saveUser(user)

  return {
    kind: 'preview',
    text: previewText,
    buttons: previewButtons(action),
  }
}

/** Run the next step of the wizard (or execute if all args collected). */
async function continueWizard(user: UserRecord, skill: Skill, action: ActionDef, state: WizardState): Promise<WizardOutcome> {
  if (state.argIdx < action.args.length) {
    const arg = action.args[state.argIdx]
    return promptForArg(skill, action, arg, state.collected, state)
  }
  return executeAndMaybePreview(user, skill, action, state)
}

/** Look up the display label for a chosen value — same logic the prompt uses. */
async function resolveDisplayLabel(skill: Skill, arg: ArgSpec, value: string, args: Record<string, string>): Promise<string> {
  if (arg.options && arg.options.length > 0) {
    const opt = arg.options.find(o => o.value === value)
    return opt?.label ?? value
  }
  if (arg.from_action) {
    const arr = await fetchChoiceArray(skill, arg.from_action, arg.from_path, args)
    const item = arr.find((it: any) => {
      const v = arg.select_key ? String(it?.[arg.select_key] ?? '') : String(it)
      return v === value
    })
    if (!item) return value
    return arg.display_key ? String(item?.[arg.display_key] ?? value) : String(value)
  }
  return value
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

  // Commit accumulated single-image uploads (LINE/WA path)
  if (callbackData === 'wz:img:commit') {
    if (!state.pending_images?.length) {
      user.wizard = undefined
      await saveUser(user)
      return { kind: 'error', text: '沒有收到照片 — 請先傳一張照片' }
    }
    const currentArg = action.args[state.argIdx]
    if (!currentArg || (currentArg.type !== 'image' && currentArg.input !== 'attachment')) {
      user.wizard = undefined
      await saveUser(user)
      return { kind: 'error', text: '目前步驟不需要照片' }
    }
    return commitPendingImages(user, state, skill, action, currentArg)
  }

  // Confirm — run the confirm_action with collected args + preview content
  if (callbackData === 'wz:confirm' && action.preview) {
    const confirmAction = skill.pin?.actions.find(a => a.id === action.preview!.confirm_action)
    if (!confirmAction) {
      user.wizard = undefined
      await saveUser(user)
      return { kind: 'error', text: `confirm_action "${action.preview.confirm_action}" not found` }
    }
    // Forward the preview content to the confirm action. content_path can extract
    // a structured object (e.g. udhouse from-photo draft) — JSON-stringify it so the
    // backend can parse it; only fall back to the rendered text when there's no object.
    const _pc = state.preview?.content
    const confirmArgs: Record<string, string> = {
      ...state.collected,
      content: typeof _pc === 'string'
        ? _pc
        : (_pc != null ? JSON.stringify(_pc) : (state.preview?.rawText ?? '')),
    }
    const r = await executeAction(skill, confirmAction, confirmArgs)
    user.wizard = undefined
    await saveUser(user)
    if (!r.ok) return { kind: 'error', text: `${confirmAction.label} 失敗: ${r.error}` }
    // Carry the confirm action's follow-up / choice buttons (e.g. a one-tap
    // "✍️ AI 生廣告文" after creating the listing).
    const doneButtons: WizardButton[] = [
      ...(r.followUps ?? []).map(f => ({ text: f.text, callback_data: f.callback_data, url: f.url })),
      ...(r.choices ?? []).map(c => ({ text: c.text, callback_data: c.callback_data })),
    ]
    return { kind: 'done', text: r.rendered ?? '✅ 完成', buttons: doneButtons.length ? doneButtons : undefined }
  }

  // Retry — re-run main action with same collected args
  if (callbackData === 'wz:retry') {
    return executeAndMaybePreview(user, skill, action, state)
  }

  // ── Tap-to-edit a preview field (when the action declares editable_fields) ──
  const editable = action.preview?.editable_fields
  // Open the edit menu: show the current (possibly edited) draft + a field picker.
  if (callbackData === 'wz:edit' && editable?.length && state.preview) {
    state.editing_field = undefined
    user.wizard = state
    await saveUser(user)
    const text = renderPreviewText(action, state.preview.content, state.collected) + '\n\n✏️ 揀要改邊一項:'
    return { kind: 'preview', text, buttons: editMenuButtons(action) }
  }
  // Pick a field to edit → show value buttons (or prompt for free text/number).
  if (callbackData.startsWith('wz:ef:') && editable?.length && state.preview) {
    const idx = parseInt(callbackData.slice(6), 10)
    const field = editable[idx]
    if (!field) return null
    if (field.options?.length) {
      const buttons: WizardButton[] = field.options
        .filter(o => o.value && o.label)
        .map(o => ({ text: o.label.slice(0, 40), callback_data: shortenCallback(`wz:sv:${idx}:${encodeURIComponent(o.value)}`) }))
      buttons.push({ text: '↩️ 返回', callback_data: 'wz:edit' })
      return { kind: 'prompt_choice', text: `${field.label} — 揀一個:`, buttons }
    }
    // Free text / number field
    state.editing_field = field.path
    user.wizard = state
    await saveUser(user)
    const hint = field.placeholder ? `\n💡 ${field.placeholder}` : ''
    return { kind: 'prompt_text', text: `📝 ${field.label}:${hint}`, buttons: [{ text: '↩️ 返回', callback_data: 'wz:edit' }] }
  }
  // Set a field's value via a tapped option → merge into the draft, re-preview.
  if (callbackData.startsWith('wz:sv:') && editable?.length && state.preview) {
    const rest = callbackData.slice(6)
    const ci = rest.indexOf(':')
    if (ci < 0) return null
    const idx = parseInt(rest.slice(0, ci), 10)
    const value = decodeURIComponent(rest.slice(ci + 1))
    const field = editable[idx]
    if (!field) return null
    setPath(state.preview.content, field.path, value)
    state.editing_field = undefined
    user.wizard = state
    await saveUser(user)
    const text = renderPreviewText(action, state.preview.content, state.collected) + '\n\n✅ 已更新。仲要改就揀，改完撳「確認發」:'
    return { kind: 'preview', text, buttons: editMenuButtons(action) }
  }

  // Choice arg — format: wz:<arg>:<value>
  if (callbackData.startsWith('wz:')) {
    const rest = callbackData.slice(3)
    const idx = rest.indexOf(':')
    if (idx < 0) return null
    const argName = rest.slice(0, idx)
    const value = decodeURIComponent(rest.slice(idx + 1))
    const currentArg = action.args[state.argIdx]
    if (currentArg.name !== argName) return null  // stale button
    state.collected[argName] = value
    // Stash the human label so subsequent prompts can show "已選"
    const label = await resolveDisplayLabel(skill, currentArg, value, state.collected)
    if (!state.collected_labels) state.collected_labels = {}
    state.collected_labels[argName] = label
    state.argIdx += 1
    user.wizard = state
    await saveUser(user)
    return continueWizard(user, skill, action, state)
  }
  return null
}

/** Commit accumulated pending_images to collected and advance the wizard. */
async function commitPendingImages(user: UserRecord, state: import('../storage/jsonStore.js').WizardState, skill: Skill, action: ActionDef, arg: ArgSpec): Promise<WizardOutcome> {
  const refs = state.pending_images ?? []
  state.collected[arg.name] = refs.join(',')
  if (!state.collected_labels) state.collected_labels = {}
  state.collected_labels[arg.name] = `📸 ${refs.length} 張`
  state.pending_images = undefined
  state.argIdx += 1
  user.wizard = state
  await saveUser(user)
  return continueWizard(user, skill, action, state)
}

/**
 * Process a single inbound image while wizard is active.
 * Accumulates into pending_images (LINE/WA path).
 * User must tap「開始分析」(wz:img:commit) or reach MAX_WIZARD_PHOTOS to trigger extraction.
 */
export async function processWizardImage(user: UserRecord, image: InboundImage): Promise<WizardOutcome | null> {
  if (!user.wizard) return null
  const state = user.wizard
  const found = findAction(state.skillId, state.actionId)
  if (!found) {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'error', text: 'Wizard state invalid. Cleared.' }
  }
  const { skill, action } = found

  if (state.argIdx >= action.args.length) return null
  const currentArg = action.args[state.argIdx]
  if (currentArg.type !== 'image' && currentArg.input !== 'attachment') return null

  // Accumulate into pending_images (do not advance argIdx until commit)
  const ref = saveTempBlob(image.data, image.mime)
  if (!state.pending_images) state.pending_images = []
  state.pending_images.push(ref)

  const count = state.pending_images.length
  if (count >= MAX_WIZARD_PHOTOS) {
    // Auto-commit at max
    return commitPendingImages(user, state, skill, action, currentArg)
  }

  if (!state.collected_labels) state.collected_labels = {}
  state.collected_labels[currentArg.name] = `📸 ${count} 張`
  user.wizard = state
  await saveUser(user)

  return {
    kind: 'prompt_text',
    text: `📸 已收到 ${count} 張照片。可繼續傳，或按「開始分析」`,
    buttons: [
      { text: `📊 開始分析 (${count} 張)`, callback_data: 'wz:img:commit' },
      NAV_BTN(),
    ],
  }
}

/**
 * Process a batch of inbound images (TG album path).
 * Commits all at once and advances the wizard immediately — no "done" button needed.
 */
export async function processWizardImages(user: UserRecord, images: InboundImage[]): Promise<WizardOutcome | null> {
  if (!user.wizard) return null
  const state = user.wizard
  const found = findAction(state.skillId, state.actionId)
  if (!found) {
    user.wizard = undefined
    await saveUser(user)
    return { kind: 'error', text: 'Wizard state invalid. Cleared.' }
  }
  const { skill, action } = found

  if (state.argIdx >= action.args.length) return null
  const currentArg = action.args[state.argIdx]
  if (currentArg.type !== 'image' && currentArg.input !== 'attachment') return null

  // Cap at MAX_WIZARD_PHOTOS (preserves user selection order)
  const capped = images.slice(0, MAX_WIZARD_PHOTOS)
  const refs = capped.map(img => saveTempBlob(img.data, img.mime))
  // Merge with any already-pending singles (edge case: user pre-sent 1 photo before the album)
  const existing = state.pending_images ?? []
  const merged = [...existing, ...refs].slice(0, MAX_WIZARD_PHOTOS)

  state.collected[currentArg.name] = merged.join(',')
  if (!state.collected_labels) state.collected_labels = {}
  state.collected_labels[currentArg.name] = `📸 ${merged.length} 張`
  state.pending_images = undefined
  state.argIdx += 1
  user.wizard = state
  await saveUser(user)
  return continueWizard(user, skill, action, state)
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

  // Editing a preview field via free text (e.g. price / sqft).
  if (state.editing_field && state.preview) {
    const field = action.preview?.editable_fields?.find(f => f.path === state.editing_field)
    const value = text.trim()
    if (!value) return { kind: 'error', text: '請輸入內容' }
    if (field?.input === 'number' && !/\d/.test(value)) {
      const hint = field.placeholder ? `（例如 ${field.placeholder}）` : ''
      return { kind: 'prompt_text', text: `📝 ${field.label} 請輸入數字${hint}:`, buttons: [{ text: '↩️ 返回', callback_data: 'wz:edit' }] }
    }
    const clean = field?.input === 'number' ? value.replace(/[^\d]/g, '') : value
    setPath(state.preview.content, state.editing_field, clean)
    state.editing_field = undefined
    user.wizard = state
    await saveUser(user)
    const t = renderPreviewText(action, state.preview.content, state.collected) + '\n\n✅ 已更新。仲要改就揀，改完撳「確認發」:'
    return { kind: 'preview', text: t, buttons: editMenuButtons(action) }
  }

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
  // For text args, the label IS what they typed (truncated for display)
  if (!state.collected_labels) state.collected_labels = {}
  state.collected_labels[currentArg.name] = value.length > 40 ? value.slice(0, 37) + '...' : value
  state.argIdx += 1
  user.wizard = state
  await saveUser(user)
  return continueWizard(user, skill, action, state)
}
