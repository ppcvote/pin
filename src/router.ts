import reminders from './skills/reminders.js'
import notes from './skills/notes.js'
import expense from './skills/expense.js'
import mindthread from './skills/mindthread.js'
import udhouse from './skills/udhouse.js'
import { llmRoute } from './brain/llmRouter.js'
import { recentHistory } from './brain/memory.js'
import type { Skill, SkillContext } from './skills/types.js'

const SKILLS: Skill[] = [
  // Product integrations FIRST (more specific triggers, take priority)
  mindthread,
  udhouse,
  // Built-in skills
  reminders,
  notes,
  expense,
]

const SKILL_BY_ID = Object.fromEntries(SKILLS.map(s => [s.id, s]))

export interface RouteResult {
  skill: Skill | null
  reply: string
  via: 'regex' | 'llm' | 'fallback'
}

export async function route(ctx: SkillContext): Promise<RouteResult> {
  // Phase 1: regex skill match — fast, free, deterministic
  for (const skill of SKILLS) {
    if (skill.match(ctx)) {
      const reply = await skill.handle(ctx)
      return { skill, reply, via: 'regex' }
    }
  }

  // Phase 2: LLM router — handles natural language we didn't write regex for
  const history = await recentHistory(ctx.chatId, 8)
  const decision = await llmRoute(SKILLS, ctx, history)

  if (decision.intent && SKILL_BY_ID[decision.intent]) {
    const target = SKILL_BY_ID[decision.intent]
    // Use LLM's rewritten text (so the skill's own regex can parse) OR original
    const newCtx: SkillContext = { ...ctx, text: decision.rewritten ?? ctx.text }
    try {
      const reply = await target.handle(newCtx)
      return { skill: target, reply, via: 'llm' }
    } catch (err) {
      return { skill: target, reply: `${target.name} 出錯: ${(err as Error).message.slice(0, 200)}`, via: 'llm' }
    }
  }

  // Phase 3: LLM's direct reply (chat / Q&A)
  return { skill: null, reply: decision.reply ?? helpText(), via: 'fallback' }
}

function helpText(): string {
  return [
    "Hi 👋 我是 Pin · 你的 AI 生活秘書",
    "",
    "目前能力 (持續擴充):",
    "⏰ 提醒  📝 筆記  💰 記帳  🧵 MindThread  🏠 UD House",
    "",
    "直接打日常對話, 我會抓你的意思。",
  ].join('\n')
}

export const skillCount = SKILLS.length
export const skillIds = SKILLS.map(s => s.id)
