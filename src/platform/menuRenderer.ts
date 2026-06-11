import { allSkills, findSkill } from './registry.js'
import type { Skill } from './types.js'

export interface InlineButton {
  text: string
  callback_data: string
}

/** Top-level menu — one row per skill. */
export function rootMenu(): { title: string; buttons: InlineButton[][] } {
  const skills = allSkills()
  const buttons: InlineButton[][] = []
  for (const s of skills) {
    const icon = s.pin?.icon ?? '•'
    const label = `${icon} ${s.name}`
    buttons.push([{ text: label, callback_data: `s:${s.id}` }])
  }
  return { title: '選一個吧 👇', buttons }
}

/** Skill action menu — primary actions one-per-row, secondary 2-per-row. */
export function skillMenu(skillId: string): { title: string; buttons: InlineButton[][] } | null {
  const skill = findSkill(skillId)
  if (!skill?.pin) return null

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
