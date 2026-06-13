import { allSkills, findSkill } from './registry.js'
import type { Skill } from './types.js'

export interface InlineButton {
  text: string
  callback_data: string
}

/** Top-level menu — agent card up top + bound skills + 🧭 探索 (un-bound).
 *  adminGrantedSkillIds: skill IDs confirmed admin by the identity probe.
 *  Skills with requires_admin: true are invisible unless the skill ID is in this set. */
export function rootMenu(
  boundSkillIds: string[] = [],
  adminGrantedSkillIds: string[] = [],
): { title: string; buttons: InlineButton[][] } {
  const skills = allSkills()
  const bound = new Set(boundSkillIds)
  const adminGranted = new Set(adminGrantedSkillIds)
  // Admin-gated skills are always filtered, regardless of binding state
  const visibleSkills = skills.filter(s => !s.pin?.requires_admin || adminGranted.has(s.id))

  const buttons: InlineButton[][] = []
  buttons.push([{ text: '🃏 看我的 Agent', callback_data: 'card' }])

  // Bound (or, if nothing is bound yet, show all so dogfood users aren't stranded)
  const showAll = bound.size === 0
  const myskills = showAll ? visibleSkills : visibleSkills.filter(s => bound.has(s.id))
  for (const s of myskills) {
    const icon = s.pin?.icon ?? '•'
    buttons.push([{ text: `${icon} ${s.name}`, callback_data: `s:${s.id}` }])
  }

  // 🧭 探索 — show only when there are un-bound visible skills to surface
  if (!showAll) {
    const explore = visibleSkills.filter(s => !bound.has(s.id))
    if (explore.length > 0) {
      buttons.push([{ text: '🧭 探索 (還沒連接)', callback_data: 'explore' }])
    }
  }

  return { title: '選一個吧 👇', buttons }
}

/** Skill action menu — primary actions one-per-row, secondary 2-per-row. */
export function skillMenu(skillId: string): { title: string; buttons: InlineButton[][] } | null {
  const skill = findSkill(skillId)
  if (!skill) return null

  // Forward compatibility (PIN_SKILL_SPEC): a standard Agent Skill without
  // metadata.pin still gets a single-entry view instead of a dead end. It
  // has no structured actions to render, so the honest offer is free text.
  if (!skill.pin) {
    return {
      title: [
        `• ${skill.name}`,
        '',
        skill.description.split('\n')[0].slice(0, 200),
        '',
        '這是標準 Agent Skill(沒有宣告 metadata.pin 選單),所以這裡沒有按鈕可按。',
        '直接打字描述你想做的事,我會盡力路由;要長出完整選單,請 skill 作者補上 metadata.pin。',
      ].join('\n'),
      buttons: [[{ text: '⬅️ 返回', callback_data: 'm:root' }]],
    }
  }

  const primary = skill.pin.actions.filter(a => a.visibility === 'primary')
  const secondary = skill.pin.actions.filter(a => a.visibility === 'secondary')
  const hasWebhooks = (skill.pin.webhooks?.length ?? 0) > 0

  const buttons: InlineButton[][] = []
  for (const a of primary) {
    buttons.push([{ text: a.label, callback_data: `a:${skill.id}:${a.id}` }])
  }
  for (let i = 0; i < secondary.length; i += 2) {
    const row: InlineButton[] = [{ text: secondary[i].label, callback_data: `a:${skill.id}:${secondary[i].id}` }]
    if (secondary[i + 1]) row.push({ text: secondary[i + 1].label, callback_data: `a:${skill.id}:${secondary[i + 1].id}` })
    buttons.push(row)
  }
  // System-injected: binding code (only if the skill exposes webhooks)
  if (hasWebhooks) {
    buttons.push([{ text: '🔔 綁定通知', callback_data: `bind:${skill.id}` }])
  }
  buttons.push([{ text: '⬅️ 返回', callback_data: 'm:root' }])
  const icon = skill.pin.icon ?? ''
  const title = `${icon} ${skill.name}\n\n${skill.description.split('\n')[0].slice(0, 200)}`
  return { title, buttons }
}

/** Callback data parsing. */
export type CallbackParsed =
  | { kind: 'root' }
  | { kind: 'skill'; skillId: string }
  | { kind: 'action'; skillId: string; actionId: string; args: Record<string, string> }
  | { kind: 'unknown' }

export function parseCallback(data: string): CallbackParsed {
  if (data === 'm:root') return { kind: 'root' }
  if (data.startsWith('s:')) return { kind: 'skill', skillId: data.slice(2) }
  if (data.startsWith('a:')) {
    const rest = data.slice(2)
    // Split off args
    let core = rest
    let args: Record<string, string> = {}
    const q = rest.indexOf('?')
    if (q >= 0) {
      core = rest.slice(0, q)
      const qstr = rest.slice(q + 1)
      for (const pair of qstr.split('&')) {
        if (!pair) continue
        const [k, v] = pair.split('=')
        args[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
      }
    }
    const idx = core.indexOf(':')
    if (idx < 0) return { kind: 'unknown' }
    return { kind: 'action', skillId: core.slice(0, idx), actionId: core.slice(idx + 1), args }
  }
  return { kind: 'unknown' }
}
