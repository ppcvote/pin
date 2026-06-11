/**
 * Per-user weekly counters — the data source for the agent card's 戰績 section.
 *
 * Bucketed by ISO week (e.g. "2026-W24") so the card always shows current
 * week without needing rollovers. Old weeks stay in the user record for at
 * most a small fixed history (we cap to 8 weeks).
 *
 * The "LLM 介入 ×k — 越低越強" line per PIN_AGENT_CARD §1: every freeform
 * text turn that hits the LLM fallback bumps llmFallbacks. Button flows
 * never touch it. That gap IS Pin's pitch.
 */

import { loadUser, saveUser, ensureUser } from '../storage/jsonStore.js'

export interface WeeklyStats {
  actions: number       // SKILL.md action executions (button-driven)
  pushes: number        // successful unsolicited deliveries (cron / webhook)
  llmFallbacks: number  // freeform text routed via the LLM brain
  piiRedactions?: number // reserved for Phase 3 (ultraprobe/guard)
}

export type StatsMap = Record<string, WeeklyStats>

const MAX_WEEKS_KEPT = 8

function isoWeek(d: Date = new Date()): string {
  // ISO 8601 week number, e.g. "2026-W24"
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = date.valueOf()
  date.setUTCMonth(0, 1)
  if (date.getUTCDay() !== 4) {
    date.setUTCMonth(0, 1 + ((4 - date.getUTCDay()) + 7) % 7)
  }
  const week = 1 + Math.ceil((firstThursday - date.valueOf()) / 604800000)
  const year = new Date(firstThursday).getUTCFullYear()
  return `${year}-W${String(week).padStart(2, '0')}`
}

function emptyStats(): WeeklyStats {
  return { actions: 0, pushes: 0, llmFallbacks: 0 }
}

function pruneOld(stats: StatsMap): StatsMap {
  const keys = Object.keys(stats).sort()
  if (keys.length <= MAX_WEEKS_KEPT) return stats
  const keep = keys.slice(-MAX_WEEKS_KEPT)
  const out: StatsMap = {}
  for (const k of keep) out[k] = stats[k]
  return out
}

export async function incrementStat(userKey: string, field: keyof WeeklyStats, by = 1): Promise<void> {
  if (!userKey) return
  try {
    // Tolerate users who haven't been seen yet (e.g. cron firing before any inbound)
    const user = (await loadUser(userKey)) ?? await ensureUser(userKey, '', undefined)
    const week = isoWeek()
    if (!user.stats) user.stats = {}
    if (!user.stats[week]) user.stats[week] = emptyStats()
    user.stats[week][field] = (user.stats[week][field] ?? 0) + by
    user.stats = pruneOld(user.stats)
    await saveUser(user)
  } catch (err) {
    console.error('[stats] increment failed', err)
  }
}

export async function getCurrentWeekStats(userKey: string): Promise<WeeklyStats> {
  if (!userKey) return emptyStats()
  const user = await loadUser(userKey)
  if (!user) return emptyStats()
  return user.stats?.[isoWeek()] ?? emptyStats()
}

/**
 * Has the user used any skill in the last N days?
 * Used to render "活躍 / 待命" on each skill in the weapons slot.
 * (This is a coarse signal — any action on any skill counts as activity.)
 */
export async function userActiveWithinDays(userKey: string, days = 7): Promise<boolean> {
  const user = await loadUser(userKey)
  if (!user) return false
  if (!user.stats) return false
  const weeksToCheck = Math.max(1, Math.ceil(days / 7))
  const keys = Object.keys(user.stats).sort().slice(-weeksToCheck)
  for (const k of keys) {
    if ((user.stats[k]?.actions ?? 0) > 0) return true
  }
  return false
}
