/**
 * Bind-token store — used by PIN_ONBOARDING §A flow.
 *
 * A product backend POSTs to /bind/token with its skill API key + tenant
 * key; we generate a single-use, time-limited token and stash it here.
 * The product embeds the token in a deep link (TG start payload, LINE
 * prefilled message); when the user opens the chat and the token bounces
 * back to Pin, we redeem it and write a binding to the user record.
 *
 * Storage: single JSON file (data/bind_tokens.json). One Map<token, entry>.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import crypto from 'node:crypto'

const FILE = join(process.cwd(), 'data', 'bind_tokens.json')
const TTL_MS = 10 * 60 * 1000

export interface BindTokenEntry {
  token: string
  skillName: string
  tenantKey: string
  createdAt: string
  expiresAt: string
  used: boolean
}

type Store = Record<string, BindTokenEntry>

async function loadStore(): Promise<Store> {
  if (!existsSync(FILE)) return {}
  try { return JSON.parse(await readFile(FILE, 'utf-8')) as Store } catch { return {} }
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true })
  await writeFile(FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function pruneExpired(store: Store): Store {
  const now = Date.now()
  const out: Store = {}
  for (const [k, v] of Object.entries(store)) {
    if (!v.used && new Date(v.expiresAt).getTime() > now) out[k] = v
  }
  return out
}

export async function createBindToken(skillName: string, tenantKey: string): Promise<BindTokenEntry> {
  const token = crypto.randomBytes(16).toString('hex')  // 32 hex chars = 128 bits
  const now = Date.now()
  const entry: BindTokenEntry = {
    token,
    skillName,
    tenantKey,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    used: false,
  }
  const store = pruneExpired(await loadStore())
  store[token] = entry
  await saveStore(store)
  return entry
}

/** Look up + atomically consume a token. Returns the entry on success, null otherwise. */
export async function redeemBindToken(token: string): Promise<BindTokenEntry | null> {
  if (!token || token.length !== 32) return null
  const store = await loadStore()
  const entry = store[token]
  if (!entry || entry.used) return null
  if (new Date(entry.expiresAt).getTime() <= Date.now()) return null
  entry.used = true
  store[token] = entry
  await saveStore(store)
  return entry
}
