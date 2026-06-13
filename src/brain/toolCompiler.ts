/**
 * Tool compiler — registry actions → function-calling tool definitions.
 *
 * Per PIN_AGENT_MODE §1.1:
 *   - prefix tool name with skill: "{skillId}__{actionId}"
 *   - description ← action.description ?? action.label
 *   - args → JSON schema parameters (enum / from_action / input: text|attachment)
 *   - exclude visibility: hidden + visibility: callback_only
 *   - filter to skills the user has a binding for (empty bindings → empty tool set)
 *
 * The compiled output never reaches the API caller; it's serialized into the
 * LLM prompt to constrain its picks. Execution always goes through the
 * deterministic pipeline (action callbacks + wizard + zod), so we never need
 * to call these "tools" — we just need the LLM to name one of them.
 */

import { allSkills } from '../platform/registry.js'
import type { ActionDef, ArgSpec, Skill } from '../platform/types.js'
import type { UserRecord } from '../storage/jsonStore.js'

export interface CompiledTool {
  name: string                      // "mindthread__post"
  skillId: string
  actionId: string
  description: string
  /** JSON-schema parameters object */
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required: string[]
  }
}

function compileArg(arg: ArgSpec): any {
  // Static enum — easy
  if (arg.options && arg.options.length > 0) {
    return {
      type: 'string',
      description: arg.label ?? arg.name,
      enum: arg.options.map(o => o.value),
    }
  }
  // Dynamic enum from another action — flag the LLM that we'll look this up
  if (arg.from_action) {
    return {
      type: 'string',
      description: `${arg.label ?? arg.name} — resolved at runtime via ${arg.from_action}`,
    }
  }
  // Image input — describe semantically; the LLM should USUALLY pick clarify
  // (it can't supply a real image), but if the user already attached one,
  // executeAction will receive the tmp:<...> ref via the wizard's image arg.
  if (arg.type === 'image' || arg.input === 'attachment') {
    return {
      type: 'string',
      description: `${arg.label ?? arg.name} (image attachment — user must send a photo)`,
    }
  }
  // Number
  if (arg.type === 'number') {
    return { type: 'number', description: arg.label ?? arg.name }
  }
  // Default text
  const out: any = { type: 'string', description: arg.label ?? arg.name }
  if (arg.placeholder) out.examples = [arg.placeholder]
  return out
}

function compileAction(skill: Skill, action: ActionDef): CompiledTool {
  const props: Record<string, any> = {}
  const required: string[] = []
  for (const a of action.args ?? []) {
    props[a.name] = compileArg(a)
    required.push(a.name)
  }
  const description = [action.description, action.label].filter(Boolean).join(' — ')
  return {
    name: `${skill.id}__${action.id}`,
    skillId: skill.id,
    actionId: action.id,
    description,
    parameters: { type: 'object', properties: props, required },
  }
}

/** Compile tools the LLM is allowed to pick for a given user. */
export function compileToolsForUser(user: UserRecord): CompiledTool[] {
  const skills = allSkills()
  const bindings = user.bindings ?? {}
  const hasAnyBinding = Object.keys(bindings).length > 0
  const tools: CompiledTool[] = []
  for (const skill of skills) {
    // If the user has any bindings at all, filter to those skills only.
    // Otherwise (dogfood / pre-Phase-A users) expose all skills.
    if (hasAnyBinding && !(skill.id in bindings)) continue
    // Admin gate: requires_admin skills only for confirmed admins (probe cache must say isAdmin=true)
    if (skill.pin?.requires_admin && !user.admin_probe_cache?.[skill.id]?.isAdmin) continue
    for (const action of skill.pin?.actions ?? []) {
      if (action.visibility === 'hidden') continue
      if (action.visibility === 'callback_only') continue
      tools.push(compileAction(skill, action))
    }
  }
  return tools
}
