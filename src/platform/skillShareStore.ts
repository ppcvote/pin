/**
 * Skill 分享 token 存放（PPC 6/16「skill 一鍵分享 + 採用追蹤」）。
 * 一個 token 一檔 data/skillshares/{token}.json，記：哪個 skill、誰分享的、誰採用了。
 * 安全：只有「使用者上架的私人 skill」(skill.pin.owner) 能分享，平台產品 skill 不行（用共用金鑰）。
 * 原子寫（tmp + rename），對齊 applicationStore。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const ROOT = join(process.cwd(), 'data', 'skillshares')

export interface SkillShare {
  token: string
  skillId: string
  createdBy: string        // 分享者 userKey
  createdByName?: string
  createdAt: string
  redeemedBy: Array<{ user: string; name?: string; at: string }>  // 採用者
}

function fileFor(token: string): string {
  const safe = token.replace(/[^A-Za-z0-9_.-]/g, '_')
  return join(ROOT, `${safe}.json`)
}

async function save(s: SkillShare): Promise<void> {
  const file = fileFor(s.token)
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf-8')
  await rename(tmp, file)
}

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 天
export async function createSkillShare(skillId: string, createdBy: string, createdByName?: string): Promise<SkillShare> {
  // best-effort 清 90 天前的舊分享（防目錄無限長 + PDPO 採用者 PII 不久留）
  try {
    const { readdir, unlink } = await import('node:fs/promises')
    for (const f of await readdir(ROOT).catch(() => [])) {
      if (!f.endsWith('.json')) continue
      try {
        const s = JSON.parse(await readFile(join(ROOT, f), 'utf-8')) as SkillShare
        if (Date.now() - new Date(s.createdAt).getTime() > SHARE_TTL_MS) await unlink(join(ROOT, f)).catch(() => {})
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  const share: SkillShare = {
    token: 'ss_' + randomBytes(8).toString('hex'),
    skillId, createdBy, createdByName,
    createdAt: new Date().toISOString(),
    redeemedBy: [],
  }
  await save(share)
  return share
}

export async function loadSkillShare(token: string): Promise<SkillShare | null> {
  const file = fileFor(token)
  if (!existsSync(file)) return null
  try { return JSON.parse(await readFile(file, 'utf-8')) as SkillShare } catch { return null }
}

/** 記一筆採用（去重：同一人重複點不重複計）。回傳 {share, firstTime}。 */
export async function recordRedeem(token: string, user: string, name?: string): Promise<{ share: SkillShare; firstTime: boolean } | null> {
  const share = await loadSkillShare(token)
  if (!share) return null
  const already = share.redeemedBy.some(r => r.user === user)
  if (!already) {
    // 上限 2000：仍授權採用，只是不再記名單（防爆檔 + PDPO 不過度蒐集）
    if (share.redeemedBy.length < 2000) share.redeemedBy.push({ user, name, at: new Date().toISOString() })
    await save(share)
  }
  return { share, firstTime: !already }
}
