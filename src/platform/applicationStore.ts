/**
 * Persistent store for self-serve skill applications (PIN_APPLY_SPEC §3).
 * One JSON file per application under data/applications/. Atomic writes
 * (tmp + rename), mirroring storage/jsonStore.ts.
 */

import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const ROOT = join(process.cwd(), 'data', 'applications')

export type ApplicationStatus = 'pending' | 'approved' | 'rejected'

export interface ProposedButton { label: string; url: string }

export interface SkillProposal {
  name: string
  display_name: string
  icon: string
  buttons: ProposedButton[]
}

export interface Application {
  id: string
  owner: string          // composite userKey "<channel>:<userId>"
  ownerName: string
  status: ApplicationStatus
  url: string
  origin: string
  proposal: SkillProposal
  skillId?: string       // assigned on approval
  createdAt: string
  decidedAt?: string
  reason?: string
}

function fileFor(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_')
  return join(ROOT, `${safe}.json`)
}

export function newApplicationId(): string {
  return 'app_' + randomBytes(6).toString('hex')
}

export async function saveApplication(app: Application): Promise<void> {
  const file = fileFor(app.id)
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(app, null, 2), 'utf-8')
  await rename(tmp, file)
}

export async function loadApplication(id: string): Promise<Application | null> {
  const file = fileFor(id)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf-8')) as Application
}

export async function listApplications(status?: ApplicationStatus): Promise<Application[]> {
  if (!existsSync(ROOT)) return []
  const files = (await readdir(ROOT)).filter(f => f.endsWith('.json'))
  const out: Application[] = []
  for (const f of files) {
    try {
      const app = JSON.parse(await readFile(join(ROOT, f), 'utf-8')) as Application
      if (!status || app.status === status) out.push(app)
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
