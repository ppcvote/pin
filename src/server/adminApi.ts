/**
 * Pin admin API（治理 Phase 2，PPC 6/16）—— 給 ultralab /admin 後台讀/管。
 * 金鑰保護（X-Admin-Key === PIN_ADMIN_KEY）由 webhooks.ts 把關。
 * 安全：回傳一律是「安全視圖」—— 永不外洩 tenantKey / editToken / bindToken 等密。
 */
import { iterAllUsers, loadUser, deleteUser, type UserRecord } from '../storage/jsonStore.js'
import { deleteAccountData, accountForPinCode } from '../platform/accountStore.js'
import { listApplications } from '../platform/applicationStore.js'

/** 安全視圖：只露管理需要的，密一律不露。 */
function safeUser(u: UserRecord) {
  return {
    chatId: u.chatId,                                  // channel:userId（canonical key）
    firstName: u.firstName ?? '',
    pinCode: u.pinCode ?? null,
    onboardedAt: u.onboardedAt,
    bindings: Object.keys(u.bindings ?? {}),           // skill 名，不含 tenantKey
    grantedSkills: u.grantedSkills ?? [],
    hasCard: !!u.ultrasite,
    cardName: u.ultrasite?.name ?? null,
    cardSlug: u.ultrasite?.slug ?? null,               // 公開頁碼，非密
    shareStats: u.shareStats ?? null,
    counts: {
      notes: (u.notes ?? []).length,
      reminders: (u.reminders ?? []).length,
      expenses: (u.expenses ?? []).length,
    },
  }
}

export async function adminStats() {
  let total = 0, todayNew = 0, withBindings = 0, withCard = 0, withShare = 0
  const today = new Date().toISOString().slice(0, 10)
  for await (const u of iterAllUsers()) {
    total++
    if ((u.onboardedAt ?? '').slice(0, 10) === today) todayNew++
    if (u.bindings && Object.keys(u.bindings).length) withBindings++
    if (u.ultrasite) withCard++
    if (u.shareStats && (u.shareStats.sharesCreated || u.shareStats.adoptions)) withShare++
  }
  const pendingApplies = (await listApplications('pending')).length
  return { total, todayNew, withBindings, withCard, withShare, pendingApplies }
}

export async function adminListUsers(q: string | null, limit = 50, offset = 0) {
  const all: UserRecord[] = []
  for await (const u of iterAllUsers()) all.push(u)
  let filtered = all
  if (q) {
    const ql = q.toLowerCase()
    filtered = all.filter(u =>
      (u.firstName ?? '').toLowerCase().includes(ql)
      || (u.pinCode ?? '').includes(ql)
      || (u.ultrasite?.name ?? '').toLowerCase().includes(ql)
      || u.chatId.includes(ql))
  }
  filtered.sort((a, b) => (b.onboardedAt ?? '').localeCompare(a.onboardedAt ?? ''))
  return { total: filtered.length, users: filtered.slice(offset, offset + Math.min(limit, 200)).map(safeUser) }
}

export async function adminGetUser(idOrPin: string) {
  const acct = (await accountForPinCode(idOrPin)) ?? idOrPin
  const u = await loadUser(acct)
  return u ? safeUser(u) : null
}

/** 刪一個會員（含 UltraLab 名片）。合規徹底刪。 */
export async function adminDeleteUser(idOrPin: string): Promise<{ ok: boolean; alreadyGone?: boolean }> {
  const acct = (await accountForPinCode(idOrPin)) ?? idOrPin
  const u = await loadUser(acct)
  if (!u) return { ok: true, alreadyGone: true }
  if (u.ultrasite?.slug && u.ultrasite.editToken) {
    try {
      await fetch('https://ultralab.tw/api/probe-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ultrasite-delete', slug: u.ultrasite.slug, editToken: u.ultrasite.editToken }),
      })
    } catch { /* best-effort */ }
  }
  await deleteAccountData(acct, u.pinCode)
  await deleteUser(acct)
  return { ok: true }
}
