/**
 * Flywheel event reporter — PIN_FLYWHEEL §3.
 *
 * Fire-and-forget HTTP POST to UltraLab's /api/flywheel-event. Failure
 * never blocks the main flow; one retry max; on giving up the event
 * lands in a dead-letter file for later replay/inspection.
 *
 * Two events today:
 *   pin_bound          — when a user successfully redeems a bind token
 *   pin_weekly_active  — Sunday cron rollup, grouped by skill
 *
 * Userid is HASHED before transmission so we don't leak channel identifiers
 * outside Pin.
 */

import crypto from 'node:crypto'
import { httpRequest } from '../products/httpRequest.js'
import { mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEAD_LETTER = join(process.cwd(), 'data', 'flywheel_dead_letter.log')

export type FlywheelEvent =
  | { type: 'pin_bound'; skillName: string; userHash: string; ts: string }
  | { type: 'pin_weekly_active'; weekIso: string; perSkill: Record<string, number>; ts: string }

function hashUserKey(userKey: string): string {
  return crypto.createHash('sha256').update(userKey).digest('hex').slice(0, 16)
}

async function sendOnce(event: FlywheelEvent): Promise<boolean> {
  const base = process.env.UG_BASE_URL
  const secret = process.env.UG_FLYWHEEL_SECRET
  if (!base || !secret) {
    console.warn('[flywheel] UG_BASE_URL or UG_FLYWHEEL_SECRET missing — skipping')
    return false
  }
  try {
    await httpRequest(`${base.replace(/\/$/, '')}/api/flywheel-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pin-Shared-Secret': secret,
      },
      body: JSON.stringify(event),
    })
    return true
  } catch (err) {
    console.warn('[flywheel] send failed:', (err as Error).message.slice(0, 120))
    return false
  }
}

async function deadLetter(event: FlywheelEvent, lastError: string): Promise<void> {
  try {
    await mkdir(join(process.cwd(), 'data'), { recursive: true })
    await appendFile(
      DEAD_LETTER,
      JSON.stringify({ event, lastError, ts: new Date().toISOString() }) + '\n',
      'utf-8'
    )
  } catch (err) {
    console.error('[flywheel dead-letter write failed]', err)
  }
}

/**
 * Fire an event. Spec §3: failure does NOT retry past one attempt and never blocks.
 * Returns immediately on the caller's tick; sender runs detached.
 */
export function reportEvent(event: FlywheelEvent): void {
  // Escape hatch for tests/sandboxes — keeps fake binds out of the
  // production flywheel metrics and the dead-letter log.
  if (process.env.PIN_DISABLE_FLYWHEEL === '1') return
  void (async () => {
    const ok = await sendOnce(event)
    if (!ok) await deadLetter(event, 'send_failed')
  })()
}

export function reportBound(userKey: string, skillName: string): void {
  reportEvent({
    type: 'pin_bound',
    skillName,
    userHash: hashUserKey(userKey),
    ts: new Date().toISOString(),
  })
}

/** Aggregate this-week active bindings per skill across all users. */
export async function reportWeeklyActive(): Promise<void> {
  const { iterAllUsers } = await import('../storage/jsonStore.js')
  const { isoWeek } = await import('./stats.js').then(m => ({ isoWeek: () => {
    // Re-derive — stats.ts doesn't export the helper, so do it inline.
    const d = new Date()
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    const dayNum = (date.getUTCDay() + 6) % 7
    date.setUTCDate(date.getUTCDate() - dayNum + 3)
    const firstThursday = date.valueOf()
    date.setUTCMonth(0, 1)
    if (date.getUTCDay() !== 4) date.setUTCMonth(0, 1 + ((4 - date.getUTCDay()) + 7) % 7)
    const week = 1 + Math.ceil((firstThursday - date.valueOf()) / 604800000)
    return `${new Date(firstThursday).getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  } }))
  const week = isoWeek()
  const perSkill: Record<string, number> = {}
  for await (const user of iterAllUsers()) {
    if (!user.bindings || !user.stats?.[week] || (user.stats[week].actions ?? 0) === 0) continue
    for (const skillName of Object.keys(user.bindings)) {
      perSkill[skillName] = (perSkill[skillName] ?? 0) + 1
    }
  }
  if (Object.keys(perSkill).length === 0) return
  reportEvent({
    type: 'pin_weekly_active',
    weekIso: week,
    perSkill,
    ts: new Date().toISOString(),
  })
}
