import { allSkills, findSkill, skillVisibleTo, isPlatformOwner } from './registry.js'
import type { Skill } from './types.js'

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string                       // 外部連結（單一入口 skill 從首頁直接開）
}

/** 單一入口的 skill（一個 action、一個 follow_up url）→ 回那個 url，讓首頁按鈕直接開、不用點進選單。 */
function skillRootUrl(s: Skill): string | null {
  const acts = s.pin?.actions ?? []
  if (acts.length !== 1) return null
  const urls = acts[0].respond?.follow_up_urls ?? []
  return urls.length === 1 && urls[0]?.url ? urls[0].url : null
}

/** Top-level menu — agent card up top + bound skills + 🧭 探索 (un-bound).
 *  adminGrantedSkillIds: skill IDs confirmed admin by the identity probe.
 *  Skills with requires_admin: true are invisible unless the skill ID is in this set. */
export function rootMenu(
  boundSkillIds: string[] = [],
  adminGrantedSkillIds: string[] = [],
  viewerKey?: string,
  grantedSkillIds: string[] = [],
): { title: string; buttons: InlineButton[][] } {
  const skills = allSkills()
  const bound = new Set(boundSkillIds)
  const adminGranted = new Set(adminGrantedSkillIds)
  const granted = new Set(grantedSkillIds) // 透過分享連結採用的私人 skill
  // Admin-gated skills are always filtered, regardless of binding state.
  // hide_from_root skills never list at root (reached via a hub, e.g. admin-hub).
  // Owner-private skills (apply flow) only show to their owner / platform owner / 被分享授權者.
  const visibleSkills = skills.filter(s =>
    !s.pin?.hide_from_root
    && (!s.pin?.requires_admin || adminGranted.has(s.id))
    && (skillVisibleTo(s, viewerKey) || granted.has(s.id)))

  const buttons: InlineButton[][] = []
  buttons.push([{ text: '🃏 看我的 Agent', callback_data: 'card' }])

  // owner 本人＝全顯示（dogfood 所有產品）；其他人＝只顯示「你綁的」＋ admin-granted hub。
  // 授權修補 6/16：避免陌生人看到/點到產品 skill，但別把 owner 自己也鎖住。
  const isOwner = isPlatformOwner(viewerKey)
  // 在首頁顯示：平台 owner（全部）／你綁的／admin hub／**你自己上架的 skill**（apply 通過的，owner===你）。
  const atRoot = (s: Skill) =>
    isOwner
    || bound.has(s.id)
    || granted.has(s.id)
    || (!!s.pin?.requires_admin && adminGranted.has(s.id))
    || (!!s.pin?.owner && !!viewerKey && s.pin.owner === viewerKey)
  const myskills = visibleSkills.filter(atRoot)
  for (const s of myskills) {
    const icon = s.pin?.icon ?? '•'
    const label = `${icon} ${s.pin?.display_name ?? s.name}`
    // 擁有者保留選單入口（才能管理/分享）；其他人（採用者/平台 owner）單一入口直接開。
    const isSkillOwner = !!s.pin?.owner && !!viewerKey && s.pin.owner === viewerKey
    const direct = isSkillOwner ? null : skillRootUrl(s)
    buttons.push([direct ? { text: label, url: direct } : { text: label, callback_data: `s:${s.id}` }])
  }

  // 🧭 探索 — 列出還沒連接的 skill（去連接，不是直接操作）。
  const explore = visibleSkills.filter(s => !atRoot(s))
  if (explore.length > 0) {
    buttons.push([{ text: '🧭 更多功能', callback_data: 'explore' }])
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
        '這個功能還在準備中，暫時沒有按鈕。',
        '直接打字告訴我你想做什麼，我盡量幫你。',
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
    buttons.push([{ text: '🔔 連接通知', callback_data: `bind:${skill.id}` }])
  }
  buttons.push([{ text: '⬅️ 返回', callback_data: 'm:root' }])
  const icon = skill.pin.icon ?? ''
  const title = `${icon} ${skill.pin.display_name ?? skill.name}\n\n${skill.description.split('\n')[0].slice(0, 200)}`
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
