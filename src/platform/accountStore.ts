/**
 * 帳號連結 / 一人一 Pin（PPC 6/16 拍板）。
 * 核心：每個 channel identity（line:X / tg:Y / wechat:Z）可「連結」到一個 canonical 帳號（= 某個 channelKey）。
 * resolveAccount() 在訊息入口把 rawKey → canonical；沒連結的人原樣回傳（零影響）。
 * 安全：連結走一次性 token 深連結（link_，10 分鐘）。Pin 碼用於識別/顯示，不單獨當連結憑證（防盜連）。
 * 原子寫（tmp + rename），對齊其他 store。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const LINKS = join(process.cwd(), 'data', 'links')        // {channelKey}.json → { account }
const TOKENS = join(process.cwd(), 'data', 'link-tokens') // {token}.json → { account, createdAt }
const CODES = join(process.cwd(), 'data', 'pincodes')     // {code}.json → { account }

const LINK_TTL_MS = 10 * 60 * 1000
// 去掉易混字 (0/O/1/I/l)
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

function safe(s: string): string { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_') }
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try { await rename(tmp, file) } catch { await writeFile(file, JSON.stringify(data, null, 2), 'utf-8') }
}
async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null
  try { return JSON.parse(await readFile(file, 'utf-8')) as T } catch { return null }
}

/** rawKey → canonical 帳號 key。沒連結 = 原樣（單層，canonical 自己不再連結）。 */
export async function resolveAccount(channelKey: string): Promise<string> {
  const link = await readJson<{ account: string }>(join(LINKS, `${safe(channelKey)}.json`))
  return link?.account || channelKey
}

/** 把 channelKey 掛到 account（之後 resolveAccount(channelKey) === account）。存 channel 供反查。 */
export async function linkChannel(channelKey: string, account: string): Promise<void> {
  await writeJson(join(LINKS, `${safe(channelKey)}.json`), { channel: channelKey, account, linkedAt: new Date().toISOString() })
}

/** 撤銷連結：channelKey 回到自己的帳號（resolveAccount(channelKey) === channelKey）。 */
export async function unlinkChannel(channelKey: string): Promise<void> {
  const file = join(LINKS, `${safe(channelKey)}.json`)
  try { const { unlink } = await import('node:fs/promises'); await unlink(file) } catch { /* 不存在就算了 */ }
}

/** 找出所有連到某 account 的 channel（資料刪除/管理用）。 */
export async function channelsForAccount(account: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const out: string[] = []
  try {
    for (const f of await readdir(LINKS)) {
      if (!f.endsWith('.json')) continue
      const link = await readJson<{ channel?: string; account: string }>(join(LINKS, f))
      if (link?.account === account && link.channel) out.push(link.channel)
    }
  } catch { /* 目錄不存在 */ }
  return out
}

/** 徹底清掉某 account 的連結資料：連結檔 + Pin 碼（用戶記錄本體由 jsonStore.deleteUser 刪）。 */
export async function deleteAccountData(account: string, pinCode?: string): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  for (const ch of await channelsForAccount(account)) {
    try { await unlink(join(LINKS, `${safe(ch)}.json`)) } catch { /* ignore */ }
  }
  if (pinCode) { try { await unlink(join(CODES, `${safe(pinCode)}.json`)) } catch { /* ignore */ } }
}

/** 產生一次性連結 token（給「另一台」點了自動掛上 account）。 */
export async function createLinkToken(account: string): Promise<string> {
  const token = 'link_' + randomBytes(8).toString('hex')
  await writeJson(join(TOKENS, `${safe(token)}.json`), { account, createdAt: Date.now() })
  return token
}

/** 解析連結 token → account（過期回 null）。 */
export async function resolveLinkToken(token: string): Promise<string | null> {
  const t = await readJson<{ account: string; createdAt: number }>(join(TOKENS, `${safe(token)}.json`))
  if (!t) return null
  if (Date.now() - t.createdAt > LINK_TTL_MS) return null
  return t.account
}

/** 取得（必要時生成）帳號的 Pin 碼。穩定、可顯示/印名片。 */
export async function ensurePinCode(account: string, existing?: string): Promise<string> {
  if (existing) return existing
  // 6 碼，碰撞極低；衝突就重抽
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = randomBytes(6)
    let code = ''
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]
    const file = join(CODES, `${safe(code)}.json`)
    if (!existsSync(file)) {
      await writeJson(file, { account })
      return code
    }
  }
  // 退化：用帳號 hash 尾碼
  return 'pin' + safe(account).slice(-4)
}

/** Pin 碼 → account（之後 approval-gated 連結用；v1 顯示用）。 */
export async function accountForPinCode(code: string): Promise<string | null> {
  const c = await readJson<{ account: string }>(join(CODES, `${safe(code)}.json`))
  return c?.account || null
}
