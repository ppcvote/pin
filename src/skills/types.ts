import type { UserRecord } from '../storage/jsonStore.js'

export interface SkillContext {
  chatId: number
  user: UserRecord
  text: string
  now: Date
}

export interface Skill {
  /** Stable id, used in logs and future skill marketplace */
  id: string
  /** Display name shown to user */
  name: string
  /** One-line description for the LLM router to know what this skill does */
  description: string
  /** Concrete example phrases the LLM router uses for few-shot routing */
  examples: string[]
  /** Fast regex match — first-pass routing without LLM cost */
  match(ctx: SkillContext): boolean
  /** Process the message and return a reply string */
  handle(ctx: SkillContext): Promise<string>
}
