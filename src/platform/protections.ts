/**
 * Runtime protection registry — the "armor slots" on the agent card.
 *
 * Each entry advertises a real, currently-active protection mechanism Pin
 * provides. Per PIN_AGENT_CARD §0.5 rule 2: only show what's actually on.
 * isActive() must reflect real runtime state, not a static "we built this".
 */

import { allSkills } from './registry.js'

export interface Protection {
  id: string
  label: string
  /** Sub-line shown under the label (optional) */
  detail?: string
  /** Predicate evaluated at card-render time */
  isActive: () => boolean
}

export const PROTECTIONS: Protection[] = [
  {
    id: 'webhook_sig',
    label: 'Webhook 簽名驗證',
    detail: 'HMAC-SHA256 over raw body',
    isActive: () => allSkills().some(s => (s.pin?.webhooks?.length ?? 0) > 0),
  },
  {
    id: 'callback_whitelist',
    label: 'Callback 白名單執行',
    detail: 'only registered action ids run',
    // Always on — Pin's callback parser only routes to known actions.
    isActive: () => true,
  },
  {
    id: 'wizard_state_isolated',
    label: 'Wizard state 用戶隔離',
    detail: 'jsonStore per channel:userId',
    // Always on — composite chatId keys + per-user JSON.
    isActive: () => true,
  },
  {
    id: 'dead_letter',
    label: 'Push 重試 + Dead-letter',
    detail: '3 attempts, then queued for review',
    isActive: () => true,
  },
  {
    id: 'mandatory_sig',
    label: '入站事件強制簽章',
    detail: 'no opt-out, missing config rejects',
    isActive: () => true,
  },
]

/** Snapshot the protections that are currently active. */
export function activeProtections(): Protection[] {
  return PROTECTIONS.filter(p => p.isActive())
}
