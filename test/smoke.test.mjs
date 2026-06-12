/**
 * Pin smoke tests — run with `node --test test/`.
 *
 * These hit only pure-function and deterministic-IO paths so they pass
 * without network or LINE/TG creds. They're a regression net for the
 * runtime guarantees the spec docs depend on (visibility derivation,
 * tool compiler exclusion, template rendering, binding round-trip).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// Keep test binds out of the production flywheel metrics + dead-letter log.
process.env.PIN_DISABLE_FLYWHEEL = '1'

import { bootRegistry, allSkills, findAction } from '../dist/platform/registry.js'
import { compileToolsForUser } from '../dist/brain/toolCompiler.js'
import { render } from '../dist/platform/template.js'
import { createBindToken, redeemBindToken, peekBindToken } from '../dist/storage/bindTokens.js'

bootRegistry()
const skills = allSkills()

test('three live skills are registered', () => {
  assert.equal(skills.length, 3)
  const ids = skills.map(s => s.id).sort()
  assert.deepEqual(ids, ['mindthread', 'udhouse', 'ultragrowth'])
})

test('every skill has icon + primary_color (spec: recommended)', () => {
  for (const s of skills) {
    assert.ok(s.pin?.icon, `${s.id} missing icon`)
    assert.ok(s.pin?.primary_color, `${s.id} missing primary_color`)
  }
})

test('visibility auto-derivation: callback_only is inferred for choice targets', () => {
  // udhouse.list_listings → callback_action: get_listing
  // get_listing has no explicit visibility — should auto-derive callback_only.
  const get_listing = findAction('udhouse', 'get_listing')
  assert.equal(get_listing.action.visibility, 'callback_only')
})

test('visibility auto-derivation: confirm_action targets are callback_only', () => {
  // mindthread.post.preview.confirm_action = publish_now
  const publish_now = findAction('mindthread', 'publish_now')
  assert.equal(publish_now.action.visibility, 'callback_only')
})

test('tool compiler excludes callback_only + hidden', () => {
  const user = { chatId: 'test', firstName: '', onboardedAt: '', reminders: [], notes: [], expenses: [] }
  const tools = compileToolsForUser(user)
  // None should be callback_only or hidden actions
  for (const t of tools) {
    const found = findAction(t.skillId, t.actionId)
    assert.ok(found.action.visibility !== 'callback_only', `${t.name} is callback_only but exposed to LLM`)
    assert.ok(found.action.visibility !== 'hidden', `${t.name} is hidden but exposed`)
  }
})

test('template engine: handlebars-ish basics + each + helpers', () => {
  const out = render(
    `Hi {{user.name}}, you have {{#each items}}{{this.title}}, {{/each}}done.`,
    { user: { name: 'Alice' }, items: [{ title: 'A' }, { title: 'B' }] }
  )
  assert.ok(out.includes('Hi Alice'))
  assert.ok(out.includes('A, B,'))
})

test('template engine: sum helper formats numbers', () => {
  const out = render(
    `Total: {{sum data "n"}}`,
    { data: [{ n: 100 }, { n: 250 }, { n: 50 }] }
  )
  assert.equal(out, 'Total: 400')
})

test('bind token: create + redeem round-trip', async () => {
  const entry = await createBindToken('mindthread', 'test-tenant-roundtrip', { foo: 'bar' })
  assert.equal(entry.skillName, 'mindthread')
  assert.equal(entry.tenantKey, 'test-tenant-roundtrip')
  assert.equal(entry.token.length, 32)
  assert.equal(entry.meta?.foo, 'bar')
  assert.equal(entry.used, false)
})

test('bind token: redeem consumes (second redeem returns null)', async () => {
  const entry = await createBindToken('udhouse', 'single-use-test')
  const first = await redeemBindToken(entry.token)
  assert.ok(first)
  assert.equal(first.skillName, 'udhouse')
  const second = await redeemBindToken(entry.token)
  assert.equal(second, null)
})

test('bind token: malformed input returns null', async () => {
  assert.equal(await redeemBindToken(''), null)
  assert.equal(await redeemBindToken('too-short'), null)
  assert.equal(await redeemBindToken('Z'.repeat(32)), null)  // 32 chars but no such token
})

test('bind token: used token stays peekable until expiry (double-tap support)', async () => {
  const entry = await createBindToken('udhouse', 'peek-test')
  await redeemBindToken(entry.token, 'line:PEEK_USER')
  const peeked = await peekBindToken(entry.token)
  assert.ok(peeked, 'used token should still be visible to peek')
  assert.equal(peeked.used, true)
  assert.equal(peeked.usedBy, 'line:PEEK_USER')
})

// ── §A bind UX (ONBOARDING 工單 1: error paths + first-message experience) ──

test('bind flow: first bind welcomes without leaking tenantKey; double-tap is idempotent; rebind says so', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const uid = 'TEST_BIND_UX_' + Date.now()
  const msg = (text) => ({ channelId: 'line', userId: uid, userDisplayName: 't', text })

  // First bind
  const t1 = await createBindToken('udhouse', 'tenant-secret-xyz')
  const r1 = await handlePinMessage(msg(`bind ${t1.token}`))
  assert.ok(r1.text.includes('已連接'), 'first bind should confirm connection')
  assert.ok(!r1.text.includes('tenant-secret-xyz'), 'tenantKey must not leak to end users')

  // Double-tap the same prefilled message → idempotent success, not "expired"
  const r2 = await handlePinMessage(msg(`bind ${t1.token}`))
  assert.ok(r2.text.includes('已連接'), 'double-tap should be answered idempotently')
  assert.ok(!r2.text.includes('已失效'), 'double-tap must not show the expired error')

  // Rebind with a fresh token (re-click from product page / device change)
  const t2 = await createBindToken('udhouse', 'tenant-secret-xyz')
  const r3 = await handlePinMessage(msg(`bind ${t2.token}`))
  assert.ok(r3.text.includes('已重新連接'), 'rebind should be labeled as a re-connect')

  // A stranger replaying the used token still gets the generic failure
  const r4 = await handlePinMessage({ channelId: 'line', userId: uid + '_OTHER', userDisplayName: 'o', text: `bind ${t1.token}` })
  assert.ok(r4.text.includes('已失效'), 'another user replaying a used token gets the generic failure')
})

test('bind flow: unknown token gets one generic failure message', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const uid = 'TEST_BIND_FAIL_' + Date.now()
  const r = await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', text: `bind ${'a'.repeat(32)}` })
  assert.ok(r.text.includes('已失效'), 'unknown token → generic failure, no reason disclosed')
})

test('LINE follow event (/follow) includes bind-recovery hint', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const uid = 'TEST_FOLLOW_' + Date.now()
  const r = await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', text: '/follow' })
  assert.ok(r.text.includes('再點一次'), 'follow welcome should guide deep-link users back to the product page')
})

test('mindthread post wizard expects ordered args', () => {
  const f = findAction('mindthread', 'post')
  assert.equal(f.action.args.length, 3)
  assert.equal(f.action.args[0].name, 'account_id')
  assert.equal(f.action.args[1].name, 'formula')
  assert.equal(f.action.args[2].name, 'topic')
})

test('mindthread post arg formula uses static options', () => {
  const f = findAction('mindthread', 'post')
  const formula = f.action.args.find(a => a.name === 'formula')
  assert.ok(formula?.options)
  assert.equal(formula.options.length, 6)
  // First should be controversial_opinion per current SKILL
  assert.equal(formula.options[0].value, 'controversial_opinion')
})

test('udhouse create_from_photo uses image arg', () => {
  const f = findAction('udhouse', 'create_from_photo')
  const img = f.action.args.find(a => a.name === 'image')
  assert.ok(img)
  assert.equal(img.type, 'image')
  assert.equal(img.input, 'attachment')
})

test('udhouse declares both lead.created and listing.status_changed webhooks', () => {
  const udh = skills.find(s => s.id === 'udhouse')
  const events = (udh.pin?.webhooks ?? []).map(w => w.event).sort()
  assert.deepEqual(events, ['lead.created', 'listing.status_changed'])
})

test('ultragrowth declares report.ready and lead.created webhooks', () => {
  const ug = skills.find(s => s.id === 'ultragrowth')
  const events = (ug.pin?.webhooks ?? []).map(w => w.event).sort()
  assert.deepEqual(events, ['lead.created', 'report.ready'])
})

// ── Wizard cancellation behavior (regression net for the 2026-06-12 dogfood drill) ──

test('wizard cancels when user types a slash command (/menu, /card, /stats)', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const { loadUser } = await import('../dist/storage/jsonStore.js')
  const uid = 'TEST_WIZARD_SLASH_CANCEL_' + Date.now()
  // Start a wizard
  await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', callback: 'a:mindthread:post' })
  let user = await loadUser('line:' + uid)
  assert.ok(user?.wizard, 'wizard should be active after starting post action')
  // Type /menu — wizard should clear
  await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', text: '/menu' })
  user = await loadUser('line:' + uid)
  assert.equal(user?.wizard, undefined, 'wizard should be cleared after /menu')
})

test('wizard cancels when user taps a non-wizard callback (s:..., m:root)', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const { loadUser } = await import('../dist/storage/jsonStore.js')
  const uid = 'TEST_WIZARD_CB_CANCEL_' + Date.now()
  await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', callback: 'a:mindthread:post' })
  let user = await loadUser('line:' + uid)
  assert.ok(user?.wizard, 'wizard should be active after starting post action')
  await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', callback: 's:udhouse' })
  user = await loadUser('line:' + uid)
  assert.equal(user?.wizard, undefined, 'wizard should be cleared after navigating to another skill')
})

test('wizard cancels via explicit wz:cancel callback', async () => {
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const { loadUser } = await import('../dist/storage/jsonStore.js')
  const uid = 'TEST_WIZARD_EXPLICIT_CANCEL_' + Date.now()
  await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', callback: 'a:mindthread:post' })
  const reply = await handlePinMessage({ channelId: 'line', userId: uid, userDisplayName: 't', callback: 'wz:cancel' })
  const user = await loadUser('line:' + uid)
  assert.equal(user?.wizard, undefined, 'wizard should be cleared after wz:cancel')
  assert.ok(reply?.text.includes('已取消'), 'should reply 已取消')
})
