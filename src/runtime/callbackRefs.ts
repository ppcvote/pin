/**
 * Callback indirection — fixes the silent-failure modes around Telegram's
 * 64-byte callback_data cap (LINE postback is 300 chars; we design to the
 * lowest common denominator).
 *
 * Before this existed, an oversized callback was either truncated
 * (actionExecutor → corrupted payload) or dropped (wizard → option silently
 * missing from the menu). Now the full callback is stored server-side and
 * the button carries a short `cb:<16hex>` reference instead.
 *
 * Storage: data/callback_refs.json. Keys are content hashes, so re-rendering
 * the same menu reuses the same ref instead of growing the store. Entries
 * expire after 14 days (a tapped button older than that gets a friendly
 * "menu expired" reply from the handler).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import crypto from 'node:crypto'

const FILE = join(process.cwd(), 'data', 'callback_refs.json')
const TTL_MS = 14 * 24 * 60 * 60 * 1000
export const CALLBACK_BYTE_CAP = 64

interface RefEntry { full: string; ts: number }
type Store = Record<string, RefEntry>

function loadStore(): Store {
  if (!existsSync(FILE)) return {}
  try { return JSON.parse(readFileSync(FILE, 'utf-8')) as Store } catch { return {} }
}

function saveStore(store: Store): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(store), 'utf-8')
}

function prune(store: Store): Store {
  const cutoff = Date.now() - TTL_MS
  const out: Store = {}
  for (const [k, v] of Object.entries(store)) {
    if (v.ts > cutoff) out[k] = v
  }
  return out
}

/**
 * Return a callback that fits the byte cap: the input itself when it already
 * fits, otherwise a short `cb:<hash>` reference to the stored full string.
 * `maxBytes` is parameterized for tests only.
 */
export function shortenCallback(full: string, maxBytes: number = CALLBACK_BYTE_CAP): string {
  if (Buffer.byteLength(full) <= maxBytes) return full
  const id = crypto.createHash('sha256').update(full).digest('hex').slice(0, 16)
  const store = prune(loadStore())
  store[id] = { full, ts: Date.now() }
  saveStore(store)
  return `cb:${id}`
}

/**
 * Resolve a possibly-indirect callback. Non-`cb:` data passes through
 * untouched. Returns null when the ref is unknown or expired.
 */
export function resolveCallback(data: string): string | null {
  if (!data.startsWith('cb:')) return data
  const id = data.slice(3)
  if (!/^[a-f0-9]{16}$/.test(id)) return null
  const entry = loadStore()[id]
  if (!entry) return null
  if (entry.ts <= Date.now() - TTL_MS) return null
  return entry.full
}
