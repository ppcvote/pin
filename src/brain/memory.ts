import { loadUser, saveUser, ensureUser, type UserRecord } from '../storage/jsonStore.js'

/** Conversation history entry per user. */
export interface HistoryEntry {
  role: 'user' | 'assistant'
  text: string
  ts: string
}

const MAX_HISTORY = 20

/** Add to history with rolling cap. */
export async function appendHistory(
  chatId: number,
  role: 'user' | 'assistant',
  text: string,
  firstName?: string,
  username?: string
): Promise<void> {
  const user = await ensureUser(chatId, firstName ?? '', username)
  // Add `history` field lazily (existing user records may not have it)
  const u = user as UserRecord & { history?: HistoryEntry[] }
  if (!u.history) u.history = []
  u.history.push({ role, text: text.slice(0, 2000), ts: new Date().toISOString() })
  if (u.history.length > MAX_HISTORY) u.history = u.history.slice(-MAX_HISTORY)
  await saveUser(u)
}

/** Last N messages. */
export async function recentHistory(chatId: number, n: number = 8): Promise<HistoryEntry[]> {
  const user = await loadUser(chatId)
  if (!user) return []
  const u = user as UserRecord & { history?: HistoryEntry[] }
  return (u.history ?? []).slice(-n)
}

/** Render history as plain transcript for LLM context. */
export function renderHistoryForLLM(history: HistoryEntry[]): string {
  if (history.length === 0) return '(no prior conversation)'
  return history
    .map(h => `${h.role === 'user' ? 'User' : 'Pin'}: ${h.text}`)
    .join('\n')
}
