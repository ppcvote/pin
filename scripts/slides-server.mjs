/**
 * Slides generator service — the product backend behind skills/slides.
 *
 * Architecture: Pin stays deterministic; this service owns the generative
 * part. An LLM fills a fixed content schema (JSON slots), and the design
 * system is hand-written CSS replicated from two field-proven decks
 * (research-note cream/serif landscape; ops-manual black/red portrait).
 * Quality floor comes from the templates, not the model.
 *
 * Flow: POST /api/v1/decks {style, topic, notes}
 *   → Gemini fills the slot schema
 *   → HTML rendered from slots
 *   → headless Chrome prints PDF (A4)
 *   → pymupdf rasterizes page 1 as preview PNG
 *   → files land in Pin's data/tmp so Pin's public /image/<name> endpoint
 *     serves them over PIN_PUBLIC_URL (links live ~30 min, tempStore TTL).
 *
 * Run: npm run slides   (requires GEMINI_API_KEY, SLIDES_API_KEY in .env)
 */

import http from 'node:http'
import https from 'node:https'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const PORT = parseInt(process.env.SLIDES_PORT ?? '3210', 10)
const API_KEY = process.env.SLIDES_API_KEY
const GEMINI_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const PUBLIC_URL = (process.env.PIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const TMP = join(process.cwd(), 'data', 'tmp')
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

if (!API_KEY) { console.error('[slides] SLIDES_API_KEY missing'); process.exit(1) }
if (!GEMINI_KEY) { console.error('[slides] GEMINI_API_KEY missing'); process.exit(1) }
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })

// ── Abuse guards (the bot has no user allowlist, so the service self-limits) ──
// Daily cap protects the LLM quota; the render lock serializes Chrome
// (one headless render at a time, small wait queue, then busy).
const DAILY_CAP = parseInt(process.env.SLIDES_DAILY_CAP ?? '40', 10)
let dayBucket = ''
let dayCount = 0
function dailyCapExceeded() {
  const today = new Date().toISOString().slice(0, 10)
  if (dayBucket !== today) { dayBucket = today; dayCount = 0 }
  if (dayCount >= DAILY_CAP) return true
  dayCount++
  return false
}
let active = 0
let waiting = 0
const MAX_WAITING = 3
async function withRenderSlot(fn) {
  if (active > 0 && waiting >= MAX_WAITING) throw Object.assign(new Error('busy'), { busy: true })
  waiting++
  while (active > 0) await new Promise(r => setTimeout(r, 500))
  waiting--
  active++
  try { return await fn() } finally { active-- }
}

// ── LLM: fill the slot schema ────────────────────────────────────────────

const SCHEMA_DOC = `{
  "title": "主標題(中文,短)",
  "title_en": "英文副標(短,可選)",
  "kicker": "眉標(極短,如系列名)",
  "lede": "封面引言(2-4行,每行一短句)",
  "meta": { "label1": "value1", "label2": "value2", "label3": "value3" },
  "pages": [
    { "kind": "stats", "label": "章節標籤", "heading": "頁標題", "intro": "一兩句導言(可選)",
      "stats": [ { "value": "81.6", "unit": "B USD", "label": "總營收", "note": "補充一句(可選)" } ],
      "panel": { "title": "深色面板標題(可選)", "paras": ["段落1", "段落2"] } },
    { "kind": "points", "label": "章節標籤", "heading": "頁標題", "intro": "導言(可選)",
      "cards": [ { "title": "卡片標題", "body": "卡片內文(2-4句)" } ] },
    { "kind": "script", "label": "章節標籤", "heading": "頁標題", "intro": "導言(可選)",
      "scenes": [ { "tag": "情境標籤", "quote": "整段可照念的話術/重點原文", "action": "→ 接續動作一句(可選)" } ] },
    { "kind": "quote", "text": "金句", "attribution": "出處 / 人名 / 場合" },
    { "kind": "closing", "heading": "收尾標題", "takeaways": ["帶走重點1", "重點2", "重點3"], "footer": "落款一句(可選)" }
  ]
}`

function buildPrompt(style, topic, notes) {
  const tone = style === 'ops'
    ? '語氣:內部作戰手冊。直接、命令式、可執行。標籤用短詞(如「話術與開場」「分類」)。'
    : '語氣:研究筆記/投資備忘錄。冷靜、論點推進、數據說話。標籤用 §01 這類編號。'
  const today = new Date().toISOString().slice(0, 10)
  return [
    `你是一位頂尖簡報內容架構師。把下面的素材整理成一份 5-7 頁的簡報內容 JSON。`,
    ``,
    `主題:${topic}`,
    ``,
    `素材(以此為準,數字與專有名詞只能來自素材,缺的就不要編造具體數字):`,
    notes,
    ``,
    tone,
    ``,
    `規則:`,
    `1. 只輸出 JSON,符合這個 schema(pages 不含封面,封面由 title/kicker/lede 生成):`,
    SCHEMA_DOC,
    `2. 繁體中文。**寧可頁數少、每一頁塞滿**:points 頁一律給 4 張卡片、每張 body 寫 3-5 句完整論述;`,
    `   stats 頁必須同時附 panel(2-3 段);script 頁給 2-3 個 scene、quote 要長到可以照念;`,
    `   closing 給 4-5 條 takeaways、每條兩短句。半空的頁面是失敗的頁面。`,
    `3. pages 順序自選,但最後一頁必須是 closing。stats 最多 4 個數字;素材裡沒有可靠數字就不要用 stats 頁。`,
    `4. meta 放 3 個鍵值對,鍵用英文大寫單詞(SERIES/DATE/FOR/SECTOR 等),DATE 一律用 ${today}。`,
  ].join('\n')
}

function geminiGenerate(prompt) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.6, maxOutputTokens: 8192 },
  })
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      family: 4,
      servername: 'generativelanguage.googleapis.com',
    }, res => {
      let data = ''
      res.setEncoding('utf-8')
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text
          if (!text) return reject(new Error(`gemini empty response (${res.statusCode}): ${data.slice(0, 200)}`))
          resolve(JSON.parse(text))
        } catch (e) { reject(new Error(`gemini parse: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('gemini timeout')))
    req.write(body)
    req.end()
  })
}

// ── HTML renderers ───────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FONT_SANS = `'Noto Sans TC','Microsoft JhengHei',sans-serif`
const FONT_SERIF = `Georgia,'Noto Serif TC','Times New Roman',PMingLiU,serif`
const FONT_MONO = `Consolas,'Courier New',monospace`

function metaRow(meta, cls) {
  const entries = Object.entries(meta ?? {}).slice(0, 4)
  return entries.map(([k, v]) =>
    `<div class="${cls}"><div class="mk">${esc(k)}</div><div class="mv">${esc(v)}</div></div>`).join('')
}

// — Style: research (收費站風 — cream, serif, landscape) —

function researchCSS() {
  return `
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size: A4 landscape; margin:0; }
  body { font-family:${FONT_SANS}; color:#222A35; background:#FAF7F2; }
  .page { width:297mm; height:209.5mm; page-break-after:always; position:relative;
          background:#FAF7F2; padding:18mm 22mm; overflow:hidden; }
  .page:last-child { page-break-after:auto; }
  .mono { font-family:${FONT_MONO}; font-size:7.5pt; letter-spacing:0.18em; color:#8B8578; text-transform:uppercase; }
  .serif { font-family:${FONT_SERIF}; }
  .accent { color:#C0492F; }
  .rule { border:none; border-top:1px solid #E2DBCE; margin:5mm 0; }
  .metas { display:flex; gap:14mm; }
  .meta .mk { font-family:${FONT_MONO}; font-size:7pt; letter-spacing:0.16em; color:#9A937F; text-transform:uppercase; margin-bottom:1.5mm; }
  .meta .mv { font-family:${FONT_MONO}; font-size:8.5pt; letter-spacing:0.08em; color:#3A4150; }
  .kicker { font-family:${FONT_SERIF}; font-style:italic; font-size:13pt; color:#C0492F; margin:14mm 0 5mm; }
  .cover-title { font-size:42pt; font-weight:700; letter-spacing:0.02em; line-height:1.15; }
  .cover-en { font-family:${FONT_SERIF}; font-style:italic; font-size:30pt; color:#2A3343; margin-top:2mm; }
  .lede { border-left:2.5px solid #C0492F; padding-left:6mm; margin-top:10mm; font-size:11pt; line-height:1.9; color:#3A4150; max-width:150mm; }
  .pageno { position:absolute; bottom:10mm; right:22mm; font-family:${FONT_MONO}; font-size:7.5pt; color:#B5AE9D; }
  .footrule { position:absolute; bottom:10mm; left:22mm; font-family:${FONT_MONO}; font-size:7pt; letter-spacing:0.14em; color:#B5AE9D; text-transform:uppercase; }
  .seclabel { font-family:${FONT_MONO}; font-size:8pt; letter-spacing:0.2em; color:#C0492F; text-transform:uppercase; }
  h2.heading { font-size:24pt; font-weight:700; margin:3mm 0 5mm; }
  .intro { font-size:10.5pt; line-height:1.8; color:#3A4150; max-width:165mm; margin-bottom:7mm; }
  .intro b, .intro strong { background:linear-gradient(transparent 60%, #F2D7CD 60%); }
  .statgrid { display:flex; gap:6mm; }
  .statcol { flex:1; }
  .statcard { background:#FFFFFF; border:1px solid #E5DFD0; padding:6mm 7mm; margin-bottom:5mm; }
  .statcard .sk { font-family:${FONT_MONO}; font-size:7pt; letter-spacing:0.16em; color:#9A937F; text-transform:uppercase; margin-bottom:3mm; }
  .statcard .sv { font-family:${FONT_SERIF}; font-size:24pt; color:#1F2733; }
  .statcard .sv .unit { font-size:11pt; color:#C0492F; margin-left:1.5mm; }
  .statcard .sn { font-size:8.5pt; color:#6B7280; margin-top:2mm; line-height:1.5; }
  .darkpanel { background:#1B2433; color:#EDE8DC; padding:8mm 9mm; flex:1.15; }
  .darkpanel .dt { font-size:13pt; font-weight:700; margin-bottom:4mm; line-height:1.5; }
  .darkpanel .dt .accent { color:#E08A6D; }
  .darkpanel p { font-size:9.5pt; line-height:1.85; color:#C9C3B4; margin-bottom:3.5mm; }
  .cards { display:flex; flex-wrap:wrap; gap:6mm; align-content:flex-start; }
  .card { background:#FFFFFF; border:1px solid #E5DFD0; border-top:2.5px solid #C0492F; padding:8mm 9mm; flex:1 1 42%; }
  .card h3 { font-size:13.5pt; margin-bottom:3.5mm; }
  .card p { font-size:10pt; line-height:1.95; color:#3A4150; }
  .scene { background:#FFFFFF; border:1px solid #E5DFD0; padding:6mm 8mm; margin-bottom:5mm; }
  .scene .tag { font-family:${FONT_MONO}; font-size:7.5pt; letter-spacing:0.16em; color:#C0492F; text-transform:uppercase; margin-bottom:3mm; }
  .scene .q { font-family:${FONT_SERIF}; font-size:11pt; line-height:1.85; color:#2A3343; }
  .scene .act { font-size:9pt; color:#6B7280; margin-top:3mm; }
  .quotepage { display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; }
  .bigquote { font-family:${FONT_SERIF}; font-size:21pt; line-height:1.8; color:#1F2733; max-width:200mm; }
  .attr { font-family:${FONT_MONO}; font-size:8.5pt; letter-spacing:0.14em; color:#9A937F; margin-top:9mm; text-transform:uppercase; }
  .takeaway { display:flex; gap:6mm; border-top:1px solid #E2DBCE; padding:6.5mm 0; }
  .takeaway .n { font-family:${FONT_SERIF}; font-style:italic; font-size:16pt; color:#C0492F; min-width:12mm; }
  .takeaway .t { font-size:12pt; line-height:1.85; padding-top:1mm; max-width:210mm; }
  `
}

// — Style: ops (作戰手冊風 — black/red, portrait) —

function opsCSS() {
  return `
  * { margin:0; padding:0; box-sizing:border-box; }
  @page { size: A4 portrait; margin:0; }
  body { font-family:${FONT_SANS}; color:#E8E4DC; background:#0B0B0D; }
  .page { width:210mm; height:296.5mm; page-break-after:always; position:relative;
          background:#0B0B0D; padding:16mm 18mm; overflow:hidden; }
  .page:last-child { page-break-after:auto; }
  .mono { font-family:${FONT_MONO}; font-size:7.5pt; letter-spacing:0.2em; text-transform:uppercase; color:#7A746A; }
  .red { color:#C8332B; }
  .masthead { display:flex; justify-content:space-between; border-bottom:1px solid #232326; padding-bottom:4mm; }
  .cover-block { margin-top:60mm; }
  .cover-title { font-size:40pt; font-weight:900; line-height:1.2; letter-spacing:0.03em; }
  .cover-title .red { color:#C8332B; }
  .lede { border-left:2px solid #C8332B; padding-left:6mm; margin-top:12mm; font-size:10.5pt; line-height:2.1; color:#B9B3A6; }
  .cover-foot { position:absolute; bottom:14mm; left:18mm; right:18mm; display:flex; gap:12mm; border-top:1px solid #232326; padding-top:5mm; }
  .meta .mk { font-family:${FONT_MONO}; font-size:6.5pt; letter-spacing:0.18em; color:#5E594F; text-transform:uppercase; margin-bottom:1.5mm; }
  .meta .mv { font-family:${FONT_MONO}; font-size:8pt; color:#A8A296; }
  .seclabel { display:inline-block; border:1px solid #C8332B; color:#C8332B; font-family:${FONT_MONO};
              font-size:7.5pt; letter-spacing:0.2em; padding:1.5mm 3.5mm; text-transform:uppercase; }
  h2.heading { font-size:23pt; font-weight:800; margin:5mm 0 5mm; }
  .intro { font-size:10pt; line-height:1.9; color:#B9B3A6; margin-bottom:6mm; }
  .intro b, .intro strong { color:#E8E4DC; border-bottom:1px solid #C8332B; font-weight:700; }
  .statgrid { display:flex; flex-wrap:wrap; gap:4.5mm; }
  .statcard { border:1px solid #2A2A2E; background:#121214; padding:6mm; flex:1 1 40%; }
  .statcard .sk { font-family:${FONT_MONO}; font-size:7pt; letter-spacing:0.16em; color:#7A746A; text-transform:uppercase; margin-bottom:3mm; }
  .statcard .sv { font-size:21pt; font-weight:800; color:#F2EEE6; }
  .statcard .sv .unit { font-size:10pt; color:#C8332B; margin-left:1.5mm; font-weight:700; }
  .statcard .sn { font-size:8.5pt; color:#8E887C; margin-top:2mm; line-height:1.6; }
  .darkpanel { border:1px solid #2A2A2E; background:#121214; padding:7mm; margin-top:5mm; }
  .darkpanel .dt { font-size:12pt; font-weight:700; margin-bottom:3.5mm; color:#F2EEE6; }
  .darkpanel p { font-size:9.5pt; line-height:1.9; color:#A8A296; margin-bottom:3mm; }
  .cards { display:flex; flex-direction:column; gap:4.5mm; }
  .card { border:1px solid #2A2A2E; border-left:2.5px solid #C8332B; background:#121214; padding:6mm 7mm; }
  .card h3 { font-size:12.5pt; color:#F2EEE6; margin-bottom:2.5mm; }
  .card p { font-size:9.5pt; line-height:1.85; color:#A8A296; }
  .scene { background:#15090A; border:1px solid #3A1512; border-left:3px solid #C8332B; padding:6mm 7mm; margin-bottom:5mm; }
  .scene .tag { font-family:${FONT_MONO}; font-size:7.5pt; letter-spacing:0.18em; color:#D96C5A; text-transform:uppercase; margin-bottom:3mm; }
  .scene .q { font-size:10.5pt; line-height:2.0; color:#E8E4DC; }
  .scene .act { font-size:9pt; color:#8E887C; margin-top:3mm; }
  .quotepage { display:flex; flex-direction:column; justify-content:center; }
  .bigquote { font-size:18pt; line-height:2.0; font-weight:700; color:#F2EEE6; border-left:3px solid #C8332B; padding-left:8mm; }
  .attr { font-family:${FONT_MONO}; font-size:8.5pt; letter-spacing:0.16em; color:#7A746A; margin-top:8mm; text-transform:uppercase; }
  .takeaway { display:flex; gap:6mm; border-top:1px solid #232326; padding:5.5mm 0; }
  .takeaway .n { font-family:${FONT_MONO}; font-size:12pt; color:#C8332B; min-width:12mm; padding-top:1mm; }
  .takeaway .t { font-size:11pt; line-height:1.8; }
  .pagefoot { position:absolute; bottom:10mm; left:18mm; right:18mm; display:flex; justify-content:space-between;
              font-family:${FONT_MONO}; font-size:7pt; letter-spacing:0.16em; color:#4E4A42; text-transform:uppercase; }
  `
}

function renderCover(deck, style) {
  if (style === 'ops') {
    return `<section class="page">
      <div class="masthead"><div class="mono">${esc(deck.kicker)}</div><div class="mono red">CLASSIFIED — INTERNAL USE ONLY</div></div>
      <div class="cover-block">
        <div class="cover-title">${esc(deck.title)}${deck.title_en ? `<div class="mono" style="margin-top:5mm; font-size:9pt; color:#A8A296">${esc(deck.title_en)}</div>` : ''}</div>
        <div class="lede">${esc(deck.lede).replace(/\n/g, '<br>')}</div>
      </div>
      <div class="cover-foot metas">${metaRow(deck.meta, 'meta')}</div>
    </section>`
  }
  return `<section class="page">
    <div class="metas">${metaRow(deck.meta, 'meta')}</div>
    <div class="kicker">${esc(deck.kicker)}</div>
    <div class="cover-title serif">${esc(deck.title)}</div>
    ${deck.title_en ? `<div class="cover-en">${esc(deck.title_en)}</div>` : ''}
    <div class="lede">${esc(deck.lede).replace(/\n/g, '<br>')}</div>
    <div class="footrule">本內容供內部參考</div><div class="pageno">P. 01</div>
  </section>`
}

function pageChrome(inner, label, idx, total, deck, style) {
  const foot = style === 'ops'
    ? `<div class="pagefoot"><div>${esc(deck.kicker)}</div><div>P. ${String(idx).padStart(2, '0')} / ${String(total).padStart(2, '0')}</div></div>`
    : `<div class="footrule">${esc(deck.kicker)}</div><div class="pageno">P. ${String(idx).padStart(2, '0')}</div>`
  return `<section class="page">
    <div class="seclabel">${esc(label ?? '')}</div>
    ${inner}
    ${foot}
  </section>`
}

function renderPage(p, idx, total, deck, style) {
  const intro = p.intro ? `<p class="intro">${esc(p.intro)}</p>` : ''
  if (p.kind === 'stats') {
    const stats = (p.stats ?? []).slice(0, 4).map(s => `
      <div class="statcard"><div class="sk">${esc(s.label)}</div>
      <div class="sv">${esc(s.value)}${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ''}</div>
      ${s.note ? `<div class="sn">${esc(s.note)}</div>` : ''}</div>`).join('')
    const panel = p.panel ? `<div class="darkpanel"><div class="dt">${esc(p.panel.title)}</div>
      ${(p.panel.paras ?? []).map(t => `<p>${esc(t)}</p>`).join('')}</div>` : ''
    const innerBody = style === 'ops'
      ? `<div class="statgrid">${stats}</div>${panel}`
      : `<div class="statgrid"><div class="statcol">${stats}</div>${panel}</div>`
    return pageChrome(`<h2 class="heading">${esc(p.heading)}</h2>${intro}${innerBody}`, p.label, idx, total, deck, style)
  }
  if (p.kind === 'points') {
    const cards = (p.cards ?? []).slice(0, 4).map(c =>
      `<div class="card"><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></div>`).join('')
    return pageChrome(`<h2 class="heading">${esc(p.heading)}</h2>${intro}<div class="cards">${cards}</div>`, p.label, idx, total, deck, style)
  }
  if (p.kind === 'script') {
    const scenes = (p.scenes ?? []).slice(0, 3).map(s => `
      <div class="scene"><div class="tag">${esc(s.tag)}</div><div class="q">「${esc(s.quote)}」</div>
      ${s.action ? `<div class="act">${esc(s.action)}</div>` : ''}</div>`).join('')
    return pageChrome(`<h2 class="heading">${esc(p.heading)}</h2>${intro}${scenes}`, p.label, idx, total, deck, style)
  }
  if (p.kind === 'quote') {
    return `<section class="page quotepage">
      <div class="bigquote">「${esc(p.text)}」</div>
      <div class="attr">— ${esc(p.attribution)}</div>
    </section>`
  }
  if (p.kind === 'closing') {
    const items = (p.takeaways ?? []).slice(0, 5).map((t, i) =>
      `<div class="takeaway"><div class="n">${String(i + 1).padStart(2, '0')}</div><div class="t">${esc(t)}</div></div>`).join('')
    const foot = p.footer ? `<p class="intro" style="margin-top:8mm">${esc(p.footer)}</p>` : ''
    return pageChrome(`<h2 class="heading">${esc(p.heading)}</h2>${items}${foot}`, p.label ?? 'TAKEAWAYS', idx, total, deck, style)
  }
  return ''
}

function renderDeckHTML(deck, style) {
  const total = (deck.pages?.length ?? 0) + 1
  const pages = [renderCover(deck, style)]
  let i = 2
  for (const p of deck.pages ?? []) { pages.push(renderPage(p, i, total, deck, style)); i++ }
  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
  <style>${style === 'ops' ? opsCSS() : researchCSS()}</style></head>
  <body>${pages.join('\n')}</body></html>`
}

// ── Render pipeline ──────────────────────────────────────────────────────

function printPDF(htmlPath, pdfPath) {
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ], { timeout: 45000 })
  if (r.status !== 0 || !existsSync(pdfPath)) {
    throw new Error(`chrome print failed (${r.status}): ${String(r.stderr).slice(-300)}`)
  }
}

function previewPNG(pdfPath, pngPath) {
  const py = `import fitz; d=fitz.open(r'${pdfPath}'); d[0].get_pixmap(dpi=110).save(r'${pngPath}'); print(len(d))`
  const r = spawnSync('python', ['-c', py], { timeout: 30000, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`preview failed: ${String(r.stderr).slice(-200)}`)
  return parseInt(String(r.stdout).trim(), 10) || 0
}

// ── HTTP server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

  if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true })

  if (req.method === 'POST' && req.url === '/api/v1/decks') {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(401, { error: 'bad_api_key' })
    const chunks = []
    let total = 0
    for await (const c of req) {
      total += c.length
      if (total > 64 * 1024) return json(413, { error: 'too_large' })
      chunks.push(c)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch { return json(400, { error: 'invalid_json' }) }
    const style = body.style === 'ops' ? 'ops' : 'research'
    const topic = String(body.topic ?? '').trim()
    const notes = String(body.notes ?? '').trim()
    if (!topic) return json(400, { error: 'topic_required' })

    if (dailyCapExceeded()) {
      console.warn(`[slides] daily cap hit (${DAILY_CAP})`)
      return json(429, { error: 'daily_cap_reached' })
    }
    const t0 = Date.now()
    try {
      return await withRenderSlot(async () => {
        console.log(`[slides] deck start style=${style} topic="${topic.slice(0, 60)}"`)
        const deck = await geminiGenerate(buildPrompt(style, topic, notes || '(無補充素材,僅就主題常識性展開,不要編造具體數據)'))
        const id = crypto.randomBytes(8).toString('hex')
        const htmlPath = join(TMP, `deck_${id}.html`)
        const pdfPath = join(TMP, `deck_${id}.pdf`)
        const pngPath = join(TMP, `deck_${id}.png`)
        writeFileSync(htmlPath, renderDeckHTML(deck, style), 'utf-8')
        printPDF(htmlPath, pdfPath)
        const pageCount = previewPNG(pdfPath, pngPath)
        // sidecars so Pin's /image/<name> endpoint serves correct mime
        writeFileSync(`${pdfPath}.meta`, JSON.stringify({ mime: 'application/pdf' }), 'utf-8')
        writeFileSync(`${pngPath}.meta`, JSON.stringify({ mime: 'image/png' }), 'utf-8')
        console.log(`[slides] deck done id=${id} pages=${pageCount} ms=${Date.now() - t0} (${dayCount}/${DAILY_CAP} today)`)
        return json(200, {
          id,
          title: deck.title,
          pages: pageCount,
          pdf_url: `${PUBLIC_URL}/image/deck_${id}.pdf`,
          preview_url: `${PUBLIC_URL}/image/deck_${id}.png`,
        })
      })
    } catch (err) {
      if (err.busy) return json(429, { error: 'busy_try_again_shortly' })
      console.error('[slides] deck failed:', err.message)
      return json(502, { error: 'generation_failed', detail: err.message.slice(0, 200) })
    }
  }

  json(404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[slides] listening on 127.0.0.1:${PORT} (model=${GEMINI_MODEL})`))
