/**
 * PIN_PERSONA §2 — RimWorld-style personality Easter eggs.
 *
 * Rules:
 *   - Only in friendly mode (never in serious mode)
 *   - Only at safe moments: morning greeting / all-done wrap-up / streak care
 *   - UD enterprise default: disabled (env PIN_EASTER_EGGS=false)
 *   - At most once per moment per call — caller is responsible for daily rate-limit
 *     (check user record: today's egg count < 2 before calling)
 *
 * No I/O. No randomness (Date.now/Math.random forbidden in harness).
 * Rotation is index-based; caller passes `rotationIndex` from user state.
 */

import type { PersonaMode } from './mode.js'

export type EasterMoment = 'morning' | 'all_done' | 'user_streak'

export interface EasterConfig {
  /** Master switch. Reads env PIN_EASTER_EGGS if not explicitly set. Default: true. */
  enabled?: boolean
}

function isEnabled(config: EasterConfig): boolean {
  if (config.enabled !== undefined) return config.enabled
  const env = process.env.PIN_EASTER_EGGS
  if (env === 'false' || env === '0') return false
  return true
}

// Safe-moment copy pools (繁中, short, no AI/sales tone, no cute markers)
const POOLS: Record<EasterMoment, readonly string[]> = {
  morning: [
    '早，今天有幾件事想跟你過一下 👇',
    '早。清單整理好了，從最重要的開始 👇',
    '今天清單有點短，是提前做完了還是偷懶？',
  ],
  all_done: [
    '都處理完了，你今天蠻拚的。',
    '全辦完了。',
    '收工。',
    '都做完了。今天算有效率的那種。',
  ],
  user_streak: [
    '這幾天你一直在跑，休息一下也沒關係。',
    '注意到你連續好幾天都很拚，有需要我幫你排輕一點嗎？',
  ],
}

/**
 * Return a personality Easter egg string for a safe moment, or null if suppressed.
 *
 * @param moment     Which safe moment triggered the potential egg.
 * @param mode       Current persona mode — serious mode returns null immediately.
 * @param config     Feature flag config.
 * @param rotationIdx Index into the pool (from user state, incremented by caller).
 *                   Keeps rotation deterministic without Math.random().
 */
export function maybeEasterEgg(
  moment: EasterMoment,
  mode: PersonaMode,
  config: EasterConfig = {},
  rotationIdx = 0,
): string | null {
  if (mode === 'serious') return null
  if (!isEnabled(config)) return null

  const pool = POOLS[moment]
  if (!pool || pool.length === 0) return null

  return pool[rotationIdx % pool.length]
}

/** All available moments, for enumeration / testing. */
export const EASTER_MOMENTS: readonly EasterMoment[] = ['morning', 'all_done', 'user_streak']
