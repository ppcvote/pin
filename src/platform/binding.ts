/**
 * Binding-code system — links a Pin user to a product backend's view of them.
 *
 * Flow (per PIN_DIRECTION §P1):
 *   1. User taps "🔔 綁定通知" in a skill's menu (auto-shown if skill has webhooks).
 *   2. Pin generates an 8-char single-use token, valid 10 min.
 *   3. Pin DMs the token + instructions back to the user.
 *   4. User pastes the token into the product backend's "Pin 綁定" field.
 *   5. Product backend POSTs to Pin's /webhooks/_bind with {token}.
 *   6. Pin consumes the token + returns {pin_user_id, skill_id}.
 *   7. Product backend stores the mapping (their_realtor_id → pin_user_id)
 *      and uses it on later /webhooks/<skill>/<event> POSTs.
 *
 * Auth model: no signature on /_bind. The token itself is the auth —
 * short-lived, single-use, generated inside an authenticated channel.
 */

import crypto from 'node:crypto'
import { loadUser, saveUser, iterAllUsers, type BindingToken } from '../storage/jsonStore.js'

const TTL_MS = 10 * 60 * 1000  // 10 minutes
const MAX_TOKENS_PER_USER = 5

function generate8(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase()
}

/** Create a binding token for a user + skill. Returns the token string. */
export async function createBindingToken(userKey: string, skillId: string): Promise<string> {
  const user = await loadUser(userKey)
  if (!user) throw new Error(`user not found: ${userKey}`)

  const now = Date.now()
  const fresh = (user.binding_tokens ?? []).filter(t => new Date(t.expiresAt).getTime() > now)
  // Cap how many tokens any user can have outstanding (prevent token-flood DoS)
  if (fresh.length >= MAX_TOKENS_PER_USER) fresh.shift()

  const token = generate8()
  const entry: BindingToken = {
    token,
    skillId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  }
  user.binding_tokens = [...fresh, entry]
  await saveUser(user)
  return token
}

/**
 * Consume a binding token across all users. Returns the resolved binding info
 * on success, or null if the token doesn't exist / has expired.
 */
export async function consumeBindingToken(token: string): Promise<{ pin_user_id: string; skill_id: string } | null> {
  if (!token || token.length !== 8) return null
  const now = Date.now()
  for await (const user of iterAllUsers()) {
    if (!user.binding_tokens) continue
    const idx = user.binding_tokens.findIndex(t => t.token === token && new Date(t.expiresAt).getTime() > now)
    if (idx < 0) continue
    const found = user.binding_tokens[idx]
    user.binding_tokens.splice(idx, 1)
    await saveUser(user)
    return { pin_user_id: user.chatId, skill_id: found.skillId }
  }
  return null
}
