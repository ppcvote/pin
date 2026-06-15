/**
 * Self-serve apply flow (PIN_APPLY_SPEC). Phone-only: an applicant pastes a URL,
 * Pin safely reads the page and proposes a link menu, they submit, the platform
 * owner (OWNER_CHAT_ID) approves, the skill hot-loads private to the applicant.
 *
 * Kept out of handle.ts: this module owns the /apply conversation, the /apps
 * owner console, and all apply:* / ap:* callbacks. handle.ts just delegates.
 */

import { saveUser, type UserRecord } from '../storage/jsonStore.js'
import { fetchPageSignals, UnsafeUrlError } from '../platform/safeFetch.js'
import { proposeFromSignals, newSkillId, writeUserSkill } from '../platform/userSkillGen.js'
import { loadSkill, USER_SKILLS_DIR } from '../platform/skillLoader.js'
import { hotAddSkill, isPlatformOwner } from '../platform/registry.js'
import { pushToUser } from '../runtime/notifier.js'
import {
  newApplicationId, saveApplication, loadApplication, listApplications,
  type Application,
} from '../platform/applicationStore.js'
import type { OutboundReply, Button } from '../channels/types.js'

const HOME = (): Button[] => [{ text: '🏠 主選單', callback_data: 'm:root' }]

function previewReply(user: UserRecord): OutboundReply {
  const p = user.apply!.proposal!
  const lines = [
    `這是你的 Pin 選單預覽 👇`,
    ``,
    `${p.icon} **${p.display_name}**`,
    ...p.buttons.map(b => `  • ${b.label}`),
    ``,
    `沒問題就送出申請，PPC 核准後就上線。`,
  ]
  return {
    text: lines.join('\n'),
    buttons: [
      [{ text: '✅ 送出申請', callback_data: 'apply:submit' }],
      [{ text: '🔁 換個網址', callback_data: 'apply:redo' }, { text: '❌ 取消', callback_data: 'apply:cancel' }],
    ],
  }
}

/** `/apply` — begin the conversation. */
export async function startApply(user: UserRecord): Promise<OutboundReply> {
  user.apply = { step: 'await_url' }
  await saveUser(user)
  return {
    text: [
      '🚀 把你的網頁變成 Pin 選單',
      '',
      '貼上你的網址就好（例如 https://myapp.vercel.app）。',
      '我會讀一下那頁，幫你做一個可以點的選單，你確認後送審。',
    ].join('\n'),
    buttons: [[{ text: '❌ 取消', callback_data: 'apply:cancel' }]],
  }
}

/** True when this user is mid-apply (so handle.ts routes text/callbacks here). */
export function inApply(user: UserRecord): boolean {
  return !!user.apply
}

/** Process a pasted URL while in await_url. Returns a reply (always, when in apply). */
export async function applyText(user: UserRecord, text: string): Promise<OutboundReply> {
  if (!user.apply) return { text: '請先輸入 /apply 開始' }
  let raw = text.trim()
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw

  let signals
  try {
    signals = await fetchPageSignals(raw)
  } catch (err) {
    const msg = err instanceof UnsafeUrlError ? err.message : '讀取網頁失敗'
    return {
      text: `⚠️ ${msg}\n\n再貼一個 https 開頭的公開網址試試。`,
      buttons: [[{ text: '❌ 取消', callback_data: 'apply:cancel' }]],
    }
  }

  const proposal = await proposeFromSignals(signals)
  user.apply = { step: 'review', url: signals.finalUrl, origin: signals.origin, proposal }
  await saveUser(user)
  return previewReply(user)
}

/** Handle apply:* (applicant) and ap:* (owner) callbacks. null if not ours. */
export async function applyCallback(
  user: UserRecord, userKey: string, displayName: string, data: string,
): Promise<OutboundReply | null> {
  // ── Applicant side ──
  if (data === 'apply:cancel') {
    delete user.apply
    await saveUser(user)
    return { text: '已取消申請。需要時再輸入 /apply。', buttons: [HOME()] }
  }
  if (data === 'apply:redo') {
    user.apply = { step: 'await_url' }
    await saveUser(user)
    return { text: '好，貼上新的網址。', buttons: [[{ text: '❌ 取消', callback_data: 'apply:cancel' }]] }
  }
  if (data === 'apply:submit') {
    if (user.apply?.step !== 'review' || !user.apply.proposal || !user.apply.origin) {
      return { text: '沒有待送出的申請，輸入 /apply 重新開始。', buttons: [HOME()] }
    }
    const app: Application = {
      id: newApplicationId(),
      owner: userKey,
      ownerName: displayName,
      status: 'pending',
      url: user.apply.url ?? user.apply.origin,
      origin: user.apply.origin,
      proposal: user.apply.proposal,
      createdAt: new Date().toISOString(),
    }
    await saveApplication(app)
    delete user.apply
    await saveUser(user)
    // Notify the owner (best-effort). They can also pull with /apps.
    // OWNER_CHAT_ID may be bare (no channel prefix) — assume the primary TG channel.
    const owner = process.env.OWNER_CHAT_ID
    if (owner) {
      const ownerKey = owner.includes(':') ? owner : `tg:${owner}`
      await pushToUser(ownerKey,
        `🔔 新 Pin 申請\n${app.ownerName}：${app.proposal.display_name}\n${app.origin}`,
        [[{ text: '👀 審核', callback_data: `ap:view:${app.id}` }]])
    }
    return {
      text: '✅ 已送出申請！PPC 核准後，你在 /menu 就會看到自己的 Pin。',
      buttons: [HOME()],
    }
  }

  // ── Owner side (ap:*) ── only the platform owner may act.
  if (data.startsWith('ap:')) {
    if (!isPlatformOwner(userKey)) return { text: '我看不懂這個指令 — 試 /menu' }
    const [, verb, id] = data.split(':')
    const app = id ? await loadApplication(id) : null
    if (!app) return { text: '找不到這筆申請（可能已處理）。', buttons: [[{ text: '📋 待審清單', callback_data: 'ap:list:' }]] }

    if (verb === 'list') return appsConsole()
    if (verb === 'view') return appView(app)
    if (verb === 'ok') return approve(app)
    if (verb === 'no') return reject(app)
  }
  return null
}

function appView(app: Application): OutboundReply {
  const p = app.proposal
  const lines = [
    `📋 申請 ${app.id}`,
    `申請人：${app.ownerName} (${app.owner})`,
    `網站：${app.origin}`,
    `狀態：${app.status}`,
    ``,
    `${p.icon} **${p.display_name}**`,
    ...p.buttons.map(b => `  • ${b.label} → ${b.url}`),
  ]
  const buttons: Button[][] = app.status === 'pending'
    ? [[{ text: '✅ 核准', callback_data: `ap:ok:${app.id}` }, { text: '❌ 退回', callback_data: `ap:no:${app.id}` }],
       [{ text: '📋 待審清單', callback_data: 'ap:list:' }]]
    : [[{ text: '📋 待審清單', callback_data: 'ap:list:' }]]
  return { text: lines.join('\n'), buttons }
}

async function approve(app: Application): Promise<OutboundReply> {
  if (app.status !== 'pending') return appView(app)
  app.skillId = newSkillId(app.proposal.display_name)
  try {
    await writeUserSkill(app)
    const skill = loadSkill(app.skillId, USER_SKILLS_DIR) // runs ATR scan + validation
    hotAddSkill(skill)
  } catch (err) {
    return { text: `⚠️ 上架失敗：${(err as Error).message}\n（已生成的檔案保留，可手動檢查）`, buttons: [[{ text: '📋 待審清單', callback_data: 'ap:list:' }]] }
  }
  app.status = 'approved'
  app.decidedAt = new Date().toISOString()
  await saveApplication(app)
  await pushToUser(app.owner,
    `🎉 你的 Pin「${app.proposal.display_name}」上線了！\n輸入 /menu 就看得到。`,
    [[{ text: '🏠 主選單', callback_data: 'm:root' }]])
  return { text: `✅ 已核准並上線：${app.proposal.display_name}（${app.skillId}）`, buttons: [[{ text: '📋 待審清單', callback_data: 'ap:list:' }]] }
}

async function reject(app: Application): Promise<OutboundReply> {
  if (app.status !== 'pending') return appView(app)
  app.status = 'rejected'
  app.decidedAt = new Date().toISOString()
  await saveApplication(app)
  await pushToUser(app.owner, `你的 Pin 申請「${app.proposal.display_name}」這次沒有通過。可以調整後重新 /apply。`)
  return { text: `已退回：${app.proposal.display_name}`, buttons: [[{ text: '📋 待審清單', callback_data: 'ap:list:' }]] }
}

/** `/apps` — owner console listing pending applications. */
export async function appsConsole(): Promise<OutboundReply> {
  const pending = await listApplications('pending')
  if (pending.length === 0) return { text: '📋 沒有待審的申請。', buttons: [HOME()] }
  const buttons: Button[][] = pending.map(a => [{
    text: `${a.proposal.icon} ${a.proposal.display_name} — ${a.ownerName}`,
    callback_data: `ap:view:${a.id}`,
  }])
  buttons.push(HOME())
  return { text: `📋 待審申請（${pending.length}）`, buttons }
}
