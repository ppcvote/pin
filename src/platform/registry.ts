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

export function findSkill(id: string): Skill | undefined {
  return SKILLS.find(s => s.id === id || s.name === id)
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
