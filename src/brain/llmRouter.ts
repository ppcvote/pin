import { generate } from './index.js'
import { renderHistoryForLLM, type HistoryEntry } from './memory.js'
import type { Skill, SkillContext } from '../skills/types.js'

export interface LLMRouteDecision {
  intent: string | null   // skill id, or null if no skill fits
  rewritten?: string      // optional cleaned-up text to feed to skill
  reply?: string          // direct reply if intent === null
}

function buildPrompt(skills: Skill[], history: HistoryEntry[], userText: string): string {
  const skillBlock = skills.map(s => {
    const ex = s.examples.map(e => `   - "${e}"`).join('\n')
    return `- ${s.id} (${s.name}): ${s.description}\n${ex}`
  }).join('\n\n')

  const memBlock = renderHistoryForLLM(history)

  return `You are Pin, an AI life secretary. Decide if the user's current message needs a SKILL call or a direct REPLY.

# Skills (only invoke if user clearly wants this action):
${skillBlock}

# Recent conversation:
${memBlock}

# Current user message:
${JSON.stringify(userText)}

# Your decision

Output ONE of these two shapes:

A) Direct reply (preferred). Use this when:
   - Short input ("2", "那個", "用 X") that references previous Pin reply → answer using history info, quote specific items
   - Ambiguous → ask ONE short clarifying question
   - Greeting / chitchat / general question
   - User wants to drill into a previously-shown item
   Shape: {"intent": null, "reply": "<answer in user's language, ≤200 chars>"}

B) Skill call. Only when user clearly requests a NEW action:
   - "提醒我 X" / "記一下 Y" / "MindThread 帳號" etc.
   Shape: {"intent": "<skill_id>", "rewritten": "<one-line text in skill example style>"}

Important: if you just routed to skill X last turn and the user is following up vaguely, DO NOT route to skill X again — use shape A and ask what they want to do with the result.`
}

/** Parse model output — handles json fences and stray text. */
function extractJson(raw: string): LLMRouteDecision | null {
  let s = raw.trim()
  // Strip fences
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  // Find first { ... } block
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = s.slice(start, end + 1)
  try {
    const obj = JSON.parse(slice) as LLMRouteDecision
    if (obj.intent === undefined) return null
    return obj
  } catch {
    return null
  }
}

export async function llmRoute(
  skills: Skill[],
  ctx: SkillContext,
  history: HistoryEntry[]
): Promise<LLMRouteDecision> {
  const prompt = buildPrompt(skills, history, ctx.text)
  let raw: string
  try {
    raw = await generate(prompt, { temperature: 0.2, max: 256 })
  } catch (err) {
    return { intent: null, reply: `(brain offline — ${(err as Error).message.slice(0, 80)})` }
  }
  const parsed = extractJson(raw)
  if (!parsed) {
    return { intent: null, reply: raw.trim().slice(0, 400) || '(我這邊腦袋打結了, 重試一下?)' }
  }
  return parsed
}
