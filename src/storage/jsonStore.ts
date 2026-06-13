import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DATA_ROOT = join(process.cwd(), 'data', 'users')

export interface BindingToken {
  /** 8-char hex token shown to the user, pasted into product backend */
  token: string
  /** Which skill's webhooks this token authorises */
  skillId: string
  createdAt: string
  expiresAt: string
}

export interface FailedPush {
  text: string
  channelId: string
  attempts: number
  lastError: string
  ts: string
}

export interface WizardState {
  skillId: string
  actionId: string
  argIdx: number
  /** Raw values (the actual IDs / hex / strings forwarded to the API). */
  collected: Record<string, string>
  /** Human-readable labels for each collected arg, used to show "已選" context. */
  collected_labels?: Record<string, string>
  /** Generated preview content (when waiting for confirm) */
  preview?: { content: any; rawText?: string }
  startedAt: string
}

export interface UserRecord {
  /** Composite key: "<channel>:<userId>" e.g. "tg:781284060" or "line:Ud8df..." */
  chatId: string
  firstName: string
  username?: string
  onboardedAt: string
  reminders: Reminder[]
  notes: Note[]
  expenses: Expense[]
  /** In-progress multi-step action */
  wizard?: WizardState
  /** Dead-letter queue — pushes that exhausted retries (capped at last 100) */
  failed_pushes?: FailedPush[]
  /** Outstanding binding tokens (one per pending product link). Expires in 10 min. */
  binding_tokens?: BindingToken[]
  /** Weekly usage counters, keyed by ISO week. Used by agent card render. */
  stats?: Record<string, { actions: number; pushes: number; llmFallbacks: number; piiRedactions?: number }>
  /** Weekly agent-mode decision distribution. Drives 降級率 dashboard later. */
  agentStats?: Record<string, { execute: number; clarify: number; none: number; blocked: number; fallback: number }>
  /** Active product bindings. Keyed by skill name. */
  bindings?: Record<string, { tenantKey: string; boundAt: string }>
  /** Bind redemption rate limit — counter resets each hour bucket. */
  bind_attempts?: { hourBucket: string; count: number }
  /** ISO timestamp of the last inbound WhatsApp message from this user. Drives the 24-hour window check. */
  wa_last_inbound?: string
  /** Cached result of admin identity probes, keyed by skill ID. Once set, skips re-probe. */
  admin_probe_cache?: Record<string, { isAdmin: boolean; checkedAt: string }>
  /**
   * Pending agent-triggered mutation awaiting confirmation. PIN_AGENT_MODE §4.2:
   * POST/PUT/DELETE actions chosen by the LLM go through a forced preview
   * even when the SKILL doesn't declare one.
   */
  agent_pending?: {
    pendingId: string
    skillId: string
    actionId: string
    args: Record<string, any>
    expiresAt: string
  }
}

export interface Reminder {
  id: string
  when: string  // ISO datetime
  text: string
  fired: boolean
  createdAt: string
}

export interface Note {
  id: string
  text: string
  tags: string[]
  createdAt: string
}

export interface Expense {
  id: string
  amount: number
  currency: 'TWD' | 'HKD' | 'USD'
  category: string
  note: string
  createdAt: string
}

function userFile(chatId: string): string {
  // Replace anything that's not safe for a filename. Colons and slashes are common in
  // composite IDs (e.g., "tg:123" — colon is illegal on Windows filenames).
  const safe = String(chatId).replace(/[^A-Za-z0-9_.-]/g, '_')
  return join(DATA_ROOT, `${safe}.json`)
}

export async function loadUser(chatId: string): Promise<UserRecord | null> {
  const file = userFile(chatId)
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf-8')
  return JSON.parse(raw) as UserRecord
}

export async function saveUser(record: UserRecord): Promise<void> {
  const file = userFile(record.chatId)
  await mkdir(dirname(file), { recursive: true })
  // Atomic write — write to a per-process/per-call temp file, then rename.
  // Windows rename can EPERM when another handle (read or write) is open on
  // the destination; retry briefly with backoff. POSIX renames are atomic
  // and don't hit this. If retries exhaust, fall back to a plain in-place
  // write — better to risk a tiny corruption window than to drop user
  // state entirely.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf-8')
  let lastErr: any = null
  for (const delay of [0, 25, 75, 200, 500]) {
    if (delay) await new Promise(r => setTimeout(r, delay))
    try {
      await rename(tmp, file)
      return
    } catch (err: any) {
      lastErr = err
      if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') break
    }
  }
  // Last resort: in-place overwrite. Tmp file is left for sweep on next call.
  console.warn(`[jsonStore] rename failed after retries (${lastErr?.code}); falling back to in-place write`)
  await writeFile(file, JSON.stringify(record, null, 2), 'utf-8')
}

export async function ensureUser(
  chatId: string,
  firstName: string,
  username?: string
): Promise<UserRecord> {
  let user = await loadUser(chatId)
  if (user) return user
  user = {
    chatId,
    firstName,
    username,
    onboardedAt: new Date().toISOString(),
    reminders: [],
    notes: [],
    expenses: [],
  }
  await saveUser(user)
  return user
}

export async function* iterAllUsers(): AsyncGenerator<UserRecord> {
  if (!existsSync(DATA_ROOT)) return
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(DATA_ROOT)
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const raw = await readFile(join(DATA_ROOT, f), 'utf-8')
    yield JSON.parse(raw) as UserRecord
  }
}
