/**
 * Agent-mode router — LLM picks an action+args from the compiled toolset.
 *
 * Per PIN_AGENT_MODE iron rules:
 *  - LLM never executes; output is parsed into one of three decisions
 *    that the deterministic pipeline handles.
 *  - Ambiguous input → clarify (button list), never harden into a guess.
 *  - Single LLM call per turn. 5-second timeout → fallback to menu.
 *  - Parse failure → fallback to menu, no retry.
 *
 * Hidden behind PIN_AGENT_MODE=true env flag — caller decides whether to invoke.
 */

import { generate } from './index.js'
import { compileToolsForUser, type CompiledTool } from './toolCompiler.js'
import { renderHistoryForLLM, type HistoryEntry } from './memory.js'
import { createShield } from '@ppcvote/prompt-shield'
import type { UserRecord } from '../storage/jsonStore.js'

// One shield per process — pure regex inside, no per-call state we'd want to reset.
const shield = createShield()

export type AgentDecision =
  | { kind: 'execute'; tool: CompiledTool; args: Record<string, any> }
  | { kind: 'clarify'; candidates: CompiledTool[]; question: string }
  | { kind: 'none'; reply: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'blocked'; reason: string; threats: Array<{ type: string; severity: string }> }

const LLM_TIMEOUT_MS = 5000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    let done = false
    const t = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    p.then(v => { if (!done) { done = true; clearTimeout(t); resolve(v) } })
     .catch(_ => { if (!done) { done = true; clearTimeout(t); resolve(null) } })
  })
}

function buildPrompt(tools: CompiledTool[], history: HistoryEntry[], userText: string): string {
  const toolList = tools.map(t =>
    `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`
  ).join('\n')
  return [
    'You are Pin\'s operation router. You CANNOT execute anything yourself.',
    'Your only job is to pick ONE registered tool the deterministic pipeline should run, OR ask the user to clarify, OR reply with chat.',
    '',
    `Available tools (you can only pick from this list — inventing names is forbidden):`,
    toolList || '(none — user has no bound skills)',
    '',
    `Recent conversation:`,
    renderHistoryForLLM(history),
    '',
    `User just said: ${JSON.stringify(userText)}`,
    '',
    'Output STRICT JSON, one of three shapes:',
    '',
    '1) Confidently maps to ONE tool and you can fill required args:',
    '   {"decision":"execute","action":"<tool_name>","args":{...}}',
    '',
    '2) Two or more plausible interpretations exist, OR you cannot fill a required arg:',
    '   {"decision":"clarify","candidates":["<tool_name>","<tool_name>","..."],"question":"<≤140 chars in user language>"}',
    '   (max 4 candidates)',
    '',
    '3) Not related to any tool (chitchat / general question):',
    '   {"decision":"none","reply":"<≤200 chars in user language>"}',
    '',
    'Rules:',
    '- If you find yourself even slightly unsure, choose clarify. Two reasonable interpretations always = clarify.',
    '- Never invent tool names. Never invent enum values.',
    '- For args with type=image, you cannot provide one yourself — if the user did NOT attach an image in their message, choose clarify and tell them to attach a photo.',
    '- No prose around the JSON. No markdown fences.',
  ].join('\n')
}

function parseLlmJson(raw: string): any | null {
  if (!raw) return null
  let s = raw.trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

export async function agentRoute(user: UserRecord, userText: string, history: HistoryEntry[]): Promise<AgentDecision> {
  // Injection / jailbreak gate — runs before the LLM call, short-circuits if blocked.
  // Skill paths (button + template) bypass this gate entirely; only the freeform
  // text path that hits the LLM has the exposure that needs it (PIN_AGENT_MODE §2.1).
  const shieldResult = shield.check(userText)
  if (shieldResult.blocked) {
    console.warn(`[shield] blocked: risk=${shieldResult.risk} threats=${shieldResult.threats.map(t => t.type).join(',')}`)
    return {
      kind: 'blocked',
      reason: shieldResult.risk,
      threats: shieldResult.threats.map(t => ({ type: t.type, severity: t.severity })),
    }
  }

  const tools = compileToolsForUser(user)
  if (tools.length === 0) {
    return { kind: 'fallback', reason: 'no_tools_for_user' }
  }
  const prompt = buildPrompt(tools, history, userText)
  const raw = await withTimeout(generate(prompt, { temperature: 0.1, max: 400 }), LLM_TIMEOUT_MS)
  if (raw === null) {
    console.warn('[agentRoute] LLM timeout — falling back to menu')
    return { kind: 'fallback', reason: 'llm_timeout' }
  }
  const obj = parseLlmJson(raw)
  if (!obj || typeof obj !== 'object') {
    console.warn('[agentRoute] LLM JSON parse failed — falling back')
    return { kind: 'fallback', reason: 'parse_failed' }
  }
  if (obj.decision === 'execute' && typeof obj.action === 'string') {
    const tool = tools.find(t => t.name === obj.action)
    if (!tool) {
      console.warn(`[agentRoute] LLM picked unknown tool ${obj.action} — falling back`)
      return { kind: 'fallback', reason: 'unknown_tool' }
    }
    return { kind: 'execute', tool, args: typeof obj.args === 'object' && obj.args ? obj.args : {} }
  }
  if (obj.decision === 'clarify' && Array.isArray(obj.candidates)) {
    const cands = (obj.candidates as string[])
      .map(n => tools.find(t => t.name === n))
      .filter((t): t is CompiledTool => !!t)
      .slice(0, 4)
    if (cands.length === 0) return { kind: 'fallback', reason: 'no_valid_candidates' }
    return { kind: 'clarify', candidates: cands, question: String(obj.question ?? '你想做哪一件?') }
  }
  if (obj.decision === 'none' && typeof obj.reply === 'string') {
    return { kind: 'none', reply: obj.reply.slice(0, 400) }
  }
  return { kind: 'fallback', reason: 'unknown_decision' }
}

export function isAgentModeEnabled(): boolean {
  return process.env.PIN_AGENT_MODE === 'true' || process.env.PIN_AGENT_MODE === '1'
}
