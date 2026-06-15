/**
 * Out-of-band push to a specific user, by composite userKey ("<channel>:<id>").
 *
 * handle.ts has no channel references (it only returns replies for the current
 * turn). The apply/approval flow needs to notify a *different* user than the one
 * in the current turn — the owner when an application lands, the applicant when
 * it's decided. bot.ts wires the channels in via setChannels() at boot, mirroring
 * how startWebhookServer(channels) receives them.
 *
 * Best-effort: if channels aren't wired (tests, MCP) or the channel is unknown,
 * the push is logged and dropped — never throws into the caller's flow.
 */

import type { Channel, Button } from '../channels/types.js'

let channels: Channel[] = []

export function setChannels(chs: Channel[]): void {
  channels = chs
}

/** Split "tg:123" → { channelId: "tg", userId: "123" }. */
function splitKey(userKey: string): { channelId: string; userId: string } | null {
  const i = userKey.indexOf(':')
  if (i <= 0) return null
  return { channelId: userKey.slice(0, i), userId: userKey.slice(i + 1) }
}

export async function pushToUser(userKey: string, text: string, buttons?: Button[][]): Promise<boolean> {
  const parts = splitKey(userKey)
  if (!parts) { console.warn(`[notifier] bad userKey ${userKey}`); return false }
  const ch = channels.find(c => c.id === parts.channelId)
  if (!ch) { console.warn(`[notifier] no channel for ${userKey} (have: ${channels.map(c => c.id).join(',') || 'none'})`); return false }
  try {
    await ch.sendDirect(parts.userId, text, buttons)
    return true
  } catch (err) {
    console.error(`[notifier] push to ${userKey} failed: ${(err as Error).message}`)
    return false
  }
}
