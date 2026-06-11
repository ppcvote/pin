/**
 * Tiny scratch dir for short-lived blobs (uploaded photos during a wizard
 * step, etc.). Files older than TTL are swept on next access.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'

const TMP_ROOT = join(process.cwd(), 'data', 'tmp')
const TTL_MS = 30 * 60 * 1000   // 30 minutes

if (!existsSync(TMP_ROOT)) mkdirSync(TMP_ROOT, { recursive: true })

function sweep(): void {
  try {
    const now = Date.now()
    for (const f of readdirSync(TMP_ROOT)) {
      const p = join(TMP_ROOT, f)
      try {
        if (now - statSync(p).mtimeMs > TTL_MS) unlinkSync(p)
      } catch {}
    }
  } catch {}
}

/** Write a buffer to disk, return a `tmp:<token>` reference. */
export function saveTempBlob(data: Buffer, mime: string): string {
  sweep()
  const token = crypto.randomBytes(12).toString('hex')
  const ext = mime.split('/')[1] ?? 'bin'
  const path = join(TMP_ROOT, `${token}.${ext}`)
  writeFileSync(path, data)
  // metadata sidecar so callers can recover mime without sniffing
  writeFileSync(`${path}.meta`, JSON.stringify({ mime }), 'utf-8')
  return `tmp:${token}.${ext}`
}

/** Read a buffer previously saved with saveTempBlob. */
export function readTempBlob(ref: string): { data: Buffer; mime: string } | null {
  if (!ref.startsWith('tmp:')) return null
  const name = ref.slice(4)
  // Reject path traversal
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  const path = join(TMP_ROOT, name)
  if (!existsSync(path)) return null
  let mime = 'application/octet-stream'
  try {
    const meta = JSON.parse(readFileSync(`${path}.meta`, 'utf-8'))
    if (typeof meta?.mime === 'string') mime = meta.mime
  } catch {}
  return { data: readFileSync(path), mime }
}
