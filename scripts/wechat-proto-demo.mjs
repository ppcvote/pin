/**
 * WeChat 服務號 adapter — 原型 demo（無需真帳號 / 無需網路 / 無需 LLM）。
 * 證明整條協定路徑：簽章驗證 → 收訊 XML 解析 → Pin 大腦 → 回覆 XML。
 * 跑法：node scripts/wechat-proto-demo.mjs（需先 npm run build）
 */
import crypto from 'node:crypto'
import { checkSignature, parseInboundXml, buildReplyXml, flattenButtons, WeChatChannel } from '../dist/channels/wechat.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const TOKEN = 'pin_demo_token'
const ts = '1700000000', nonce = 'abc123'
const sig = crypto.createHash('sha1').update([TOKEN, ts, nonce].sort().join('')).digest('hex')

console.log('\n[1] 簽章驗證（GET 握手 + POST 訊息共用 sha1）')
ok('正確簽章通過', checkSignature(TOKEN, sig, ts, nonce) === true)
ok('竄改簽章被擋', checkSignature(TOKEN, sig.replace(/.$/, sig.endsWith('0') ? '1' : '0'), ts, nonce) === false)
ok('錯 token 被擋', checkSignature('wrong_token', sig, ts, nonce) === false)

console.log('\n[2] 收訊 XML 解析（WeChat 明文格式，CDATA）')
const inboundXml = `<xml><ToUserName><![CDATA[gh_oa123]]></ToUserName><FromUserName><![CDATA[oUser_openid_888]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[我想看物件]]></Content><MsgId>24000001</MsgId></xml>`
const p = parseInboundXml(inboundXml)
ok('FromUserName(openid)', p.fromUser === 'oUser_openid_888', p.fromUser)
ok('Content', p.content === '我想看物件', p.content)
ok('MsgType', p.msgType === 'text')

console.log('\n[3] 回覆 XML 生成 + 按鈕降級（WeChat 無 inline 按鈕）')
const body = flattenButtons('你好，我是 Pin', [[{ text: '看物件', url: 'https://social.8338.hk' }], [{ text: '找專員', callback_data: 'agent' }]])
ok('url 按鈕 → 連結', body.includes('看物件：https://social.8338.hk'))
ok('callback 按鈕 → 可輸入提示', body.includes('• 找專員'))
ok('回覆 XML 結構', buildReplyXml('to', 'from', body).includes('<MsgType><![CDATA[text]]></MsgType>'))

console.log('\n[4] 整條跑：簽章 → 解析 → handler → 回覆 XML（mock handler）')
const ch = new WeChatChannel('wxappid', 'wxsecret', TOKEN)
await ch.start(async (msg) => ({
  text: `收到你的「${msg.text}」（${msg.channelId}:${msg.userId}）`,
  buttons: [[{ text: '物件清單', url: 'https://social.8338.hk/listings' }]],
}))
const out = await ch.handleWebhook(inboundXml, { signature: sig, timestamp: ts, nonce })
ok('handleWebhook 回被動回覆 XML', out.startsWith('<xml>') && out.includes('收到你的「我想看物件」'))
ok('回覆對回正確 openid', out.includes('<ToUserName><![CDATA[oUser_openid_888]]>'))
ok('url 按鈕降級進回覆', out.includes('物件清單：https://social.8338.hk/listings'))
ok('未驗證簽章 → 空（拒絕、不洩漏）', (await ch.handleWebhook(inboundXml, { signature: 'deadbeef', timestamp: ts, nonce })) === '')
console.log('\n  ── 實際回給 WeChat 的被動回覆 XML ──')
console.log('  ' + out)

console.log('\n[5] 整條跑：接「真 Pin 大腦」handlePinMessage（/version 非 owner，確定性、無 LLM）')
try {
  process.env.PIN_DISABLE_FLYWHEEL = '1'
  const { bootRegistry } = await import('../dist/platform/registry.js')
  const { initSkillThreatScan } = await import('../dist/platform/skillThreatScan.js')
  await initSkillThreatScan(); bootRegistry()
  const { handlePinMessage } = await import('../dist/core/handle.js')
  const ch2 = new WeChatChannel('wxappid', 'wxsecret', TOKEN)
  await ch2.start(handlePinMessage)
  const vXml = inboundXml.replace('我想看物件', '/version')
  const vOut = await ch2.handleWebhook(vXml, { signature: sig, timestamp: ts, nonce })
  ok('真 handler 經 WeChat adapter 回 XML', vOut.startsWith('<xml>') && vOut.includes('Pin'))
  console.log('  ── 真 Pin 回覆（經 WeChat adapter）──')
  console.log('  ' + vOut)
} catch (e) {
  console.log('  (real-handler 整合略過：' + (e?.message || e) + ')')
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`)
process.exit(fail ? 1 : 0)
