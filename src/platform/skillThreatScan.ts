/**
 * ATR (Agent Threat Rules) skill-load scanner — protection #6.
 *
 * Scans raw SKILL.md content against the agent-threat-rules pack
 * (same ruleset Microsoft AGT / Cisco AI Defense run in production)
 * before a skill enters the registry. Policy:
 *   - critical match  → skill refused (loadSkill throws, loadAllSkills skips it)
 *   - anything lower  → logged, skill still loads
 *
 * The engine is initialized once at process boot (bot.ts / mcp server)
 * via initSkillThreatScan(). If init was skipped or disabled
 * (PIN_ATR_SCAN=false), scanning becomes a no-op so dev tooling and
 * tests that call loadSkill() directly keep working.
 *
 * Privacy: no ATRReporter is configured — nothing leaves the process.
 */

import { ATREngine } from 'agent-threat-rules'
import type { ATRMatch } from 'agent-threat-rules'

let engine: ATREngine | null = null
let ruleCount = 0

function scanDisabled(): boolean {
  const v = process.env.PIN_ATR_SCAN
  return v === 'false' || v === '0'
}

export async function initSkillThreatScan(): Promise<number> {
  if (scanDisabled()) {
    console.warn('[atr] skill threat scan DISABLED via PIN_ATR_SCAN — skills load unscanned')
    return 0
  }
  if (engine) return ruleCount
  const e = new ATREngine() // bundled rule pack from the npm package
  ruleCount = await e.loadRules()
  engine = e
  console.log(`[atr] skill threat scanner ready (${ruleCount} rules)`)
  return ruleCount
}

export function skillScanActive(): boolean {
  return engine !== null
}

export function skillScanRuleCount(): number {
  return ruleCount
}

export interface SkillScanVerdict {
  /** true when at least one critical-severity rule matched */
  blocked: boolean
  critical: ATRMatch[]
  /** non-critical matches — surfaced in logs, do not block */
  warnings: ATRMatch[]
}

export function scanSkillContent(raw: string): SkillScanVerdict {
  if (!engine) return { blocked: false, critical: [], warnings: [] }
  const matches = engine.scanSkill(raw)
  const critical = matches.filter(m => m.rule.severity === 'critical')
  const warnings = matches.filter(m => m.rule.severity !== 'critical')
  return { blocked: critical.length > 0, critical, warnings }
}

export function describeMatch(m: ATRMatch): string {
  return `${m.rule.id} [${m.rule.severity}/${m.scan_context}] ${m.rule.title}`
}
