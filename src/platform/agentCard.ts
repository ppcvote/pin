/**
 * Agent card text renderer — Phase 1 of PIN_AGENT_CARD.md.
 *
 * Outputs a plain-text card showing:
 *  - weapons (loaded skills, active/standby state)
 *  - armor (currently active runtime protections)
 *  - this-week battle record (real counters)
 *
 * Phase 2 (PNG share card) reuses the same data sources but renders SVG.
 */

import { allSkills } from './registry.js'
import { activeProtections } from './protections.js'
import { getCurrentWeekStats, userActiveWithinDays } from '../runtime/stats.js'
import { loadUser } from '../storage/jsonStore.js'

export interface AgentCardData {
  agentName: string
  weapons: Array<{ icon: string; name: string; status: '活躍' | '待命' }>
  protections: Array<{ label: string; detail?: string }>
  stats: { actions: number; pushes: number; llmFallbacks: number; piiRedactions?: number }
  share?: { sharesCreated: number; adoptions: number }  // 推薦戰績（累計）
}

export async function buildAgentCardData(userKey: string, agentName = 'ULTRA AGENT'): Promise<AgentCardData> {
  const skills = allSkills()
  const userActive = await userActiveWithinDays(userKey, 7)
  const weapons = skills.map(s => ({
    icon: s.pin?.icon ?? '•',
    name: s.name,
    status: userActive ? '活躍' as const : '待命' as const,
  }))
  const protections = activeProtections().map(p => ({ label: p.label, detail: p.detail }))
  const stats = await getCurrentWeekStats(userKey)
  const u = await loadUser(userKey)
  return { agentName, weapons, protections, stats, share: u?.shareStats }
}

export function renderAgentCardText(data: AgentCardData): string {
  const lines: string[] = []
  lines.push(`🃏 ${data.agentName} — Pin`)
  lines.push('━━━━━━━━━━━━━━━━━')
  lines.push('⚔️ 武器欄 (skills)')
  if (data.weapons.length === 0) {
    lines.push('  (尚未載入任何 skill)')
  } else {
    for (const w of data.weapons) {
      lines.push(`  ${w.icon} ${w.name.padEnd(16, ' ')} Lv.${w.status}`)
    }
  }
  lines.push('')
  lines.push('🛡️ 防具欄 (protections)')
  if (data.protections.length === 0) {
    lines.push('  (沒有啟用的防護機制)')
  } else {
    for (const p of data.protections) {
      lines.push(`  ✅ ${p.label}`)
    }
  }
  lines.push('')
  lines.push('📊 本週戰績')
  lines.push(`  按鈕操作 ×${data.stats.actions}`)
  lines.push(`  推播送達 ×${data.stats.pushes}`)
  lines.push(`  LLM 介入 ×${data.stats.llmFallbacks} ← 越低越強`)
  if ((data.stats.piiRedactions ?? 0) > 0) {
    lines.push(`  PII 攔截 ×${data.stats.piiRedactions}`)
  }
  if (data.share && (data.share.sharesCreated > 0 || data.share.adoptions > 0)) {
    lines.push('')
    lines.push('🏆 推薦戰績 (累計)')
    lines.push(`  分享 ×${data.share.sharesCreated} · 被採用 ×${data.share.adoptions}`)
  }
  lines.push('')
  lines.push('⚡ 零幻覺執行 · Powered by Pin')
  return lines.join('\n')
}
