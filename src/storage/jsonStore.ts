import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DATA_ROOT = join(process.cwd(), 'data', 'users')

export interface WizardState {
  skillId: string
  actionId: string
  argIdx: number
  collected: Record<string, string>
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
