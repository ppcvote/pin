import { loadAllSkills } from './skillLoader.js'
import type { Skill, ActionDef, WebhookSpec } from './types.js'

const SKILLS: Skill[] = []

export function bootRegistry(): void {
  const loaded = loadAllSkills()
  SKILLS.length = 0
  SKILLS.push(...loaded)
  console.log(`[registry] loaded ${SKILLS.length} skill(s): ${SKILLS.map(s => s.name).join(', ')}`)
}

export function allSkills(): Skill[] {
  return SKILLS
}

/** Hot-add a single already-loaded skill (apply approval) without a reboot.
 *  Menus read allSkills() live, so it appears immediately. Replaces any skill
 *  with the same id. */
export function hotAddSkill(skill: Skill): void {
  const i = SKILLS.findIndex(s => s.id === skill.id)
  if (i >= 0) SKILLS[i] = skill
  else SKILLS.push(skill)
  console.log(`[registry] hot-added skill: ${skill.id} (now ${SKILLS.length})`)
}

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find(s => s.id === id || s.name === id)
}

/** The platform owner (sole approver) is identified by OWNER_CHAT_ID. Tolerates
 *  both the composite "<channel>:<id>" form and a bare channel-native id. */
export function isPlatformOwner(viewerKey: string | undefined): boolean {
  const owner = process.env.OWNER_CHAT_ID
  if (!owner || !viewerKey) return false
  if (viewerKey === owner) return true
  const idx = viewerKey.indexOf(':')
  const nativeId = idx >= 0 ? viewerKey.slice(idx + 1) : viewerKey
  return nativeId === owner
}

/** Owner-private skills (apply flow) are visible only to their owner and the
 *  platform owner. Built-in skills have no owner and are visible to everyone. */
export function skillVisibleTo(skill: Skill, viewerKey: string | undefined): boolean {
  if (!skill.pin?.owner) return true
  if (viewerKey && skill.pin.owner === viewerKey) return true
  return isPlatformOwner(viewerKey)
}

export function findAction(skillId: string, actionId: string): { skill: Skill; action: ActionDef } | undefined {
  const skill = findSkill(skillId)
  if (!skill?.pin) return undefined
  const action = skill.pin.actions.find(a => a.id === actionId)
  if (!action) return undefined
  return { skill, action }
}

export function findWebhook(skillId: string, event: string): { skill: Skill; webhook: WebhookSpec } | undefined {
  const skill = findSkill(skillId)
  if (!skill?.pin?.webhooks) return undefined
  const webhook = skill.pin.webhooks.find(w => w.event === event)
  if (!webhook) return undefined
  return { skill, webhook }
}
