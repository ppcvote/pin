/**
 * Reliable push delivery — retries transient failures, dead-letters permanent ones.
 *
 * Per PIN_DIRECTION §P1: a single user blocking the bot or a momentary network
 * blip must NOT silently drop notifications or block other pushes from going
 * out. We retry with backoff, and on final failure we persist to the user's
 * `failed_pushes` queue for later review.
 *
 * Used by:
 *   - webhooks.ts when a product-triggered notification arrives
 *   - bot.ts reminder cron
 */

import { loadUser, saveUser } from '../storage/jsonStore.js'
import type { Button, Channel } from '../channels/types.js'

const MAX_ATTEMPTS = 3
const BACKOFF_MS = [500, 1500, 3000]
const QUEUE_CAP = 100  // keep at most last N failed pushes per user

export interface DeliveryResult {
  ok: boolean
  attempts: number
  error?: string
}

export async function deliverWithRetry(
  channel: Channel,
  userKey: string,     // composite "<channel>:<userId>" for storage
  userId: string,      // raw channel-native id used by sendDirect
  text: string,
  buttons?: Button[][]
): Promise<DeliveryResult> {
  let lastError = 'unknown'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await channel.sendDirect(userId, text, buttons)
      if (attempt > 1) console.log(`[deliver] user=${userKey} ok on attempt ${attempt}`)
      return { ok: true, attempts: attempt }
    } catch (err) {
      lastError = (err as Error).message ?? String(err)
      console.warn(`[deliver ${attempt}/${MAX_ATTEMPTS}] user=${userKey} via=${channel.id}: ${lastError.slice(0, 200)}`)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]))
      }
    }
  }

  // Dead-letter
  try {
    const user = await loadUser(userKey)
    if (user) {
      if (!user.failed_pushes) user.failed_pushes = []
      user.failed_pushes.push({
        text: text.slice(0, 500),
        channelId: channel.id,
        attempts: MAX_ATTEMPTS,
        lastError: lastError.slice(0, 500),
        ts: new Date().toISOString(),
      })
      if (user.failed_pushes.length > QUEUE_CAP) {
        user.failed_pushes = user.failed_pushes.slice(-QUEUE_CAP)
      }
      await saveUser(user)
    }
  } catch (err) {
    console.error('[deliver dead-letter write failed]', err)
  }

  console.error(`[deliver giving up] user=${userKey} via=${channel.id} after ${MAX_ATTEMPTS} attempts`)
  return { ok: false, attempts: MAX_ATTEMPTS, error: lastError }
}
