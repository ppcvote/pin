/**
 * Share card renderer — PIN_AGENT_CARD §2 Phase 2.
 *
 * 1080×1350 4:5 PNG (Threads/IG vertical optimal). Pure SVG → resvg.
 * No Puppeteer (spec explicitly forbids). No external rendering services.
 *
 * Color system: Ultralab dark — deep navy gradient, teal accent, gold
 * for numeric callouts. Identicon avatar is deterministic geometric;
 * no copyrighted glyphs / no AI generation.
 */

import { Resvg } from '@resvg/resvg-js'
import crypto from 'node:crypto'
import { join } from 'node:path'
import type { AgentCardData } from '../platform/agentCard.js'

const FONT_DIRS = [
  join(process.cwd(), 'assets', 'fonts'),
  'C:/Windows/Fonts',
  '/usr/share/fonts',
  '/Library/Fonts',
]

const W = 1080
const H = 1350

// Ultralab palette
const BG_TOP = '#1A1033'
const BG_BOT = '#0D0B1A'
const ACCENT = '#2DD4BF'  // teal
const GOLD = '#D4AF37'    // numeric callouts
const TEXT = '#E2E8F0'    // body
const MUTED = '#94A3B8'   // small hints
const ROW_BG = 'rgba(255,255,255,0.04)'

function hash(s: string): Buffer {
  return crypto.createHash('sha256').update(s || 'anon').digest()
}

/** 8 deterministic shapes from userKey → soft identicon avatar. */
function avatar(userKey: string, cx: number, cy: number, size: number): string {
  const h = hash(userKey)
  const hue = h[0] * 360 / 256
  const lightness = 45 + (h[1] % 25)
  const ringColor = `hsl(${hue}, 70%, ${lightness}%)`
  // Inner ring of small dots
  const dots: string[] = []
  for (let i = 0; i < 8; i++) {
    if ((h[2 + i] & 1) === 0) continue
    const angle = i * (Math.PI / 4) - Math.PI / 2
    const r = size * 0.32
    const dx = cx + Math.cos(angle) * r
    const dy = cy + Math.sin(angle) * r
    const dotSize = 10 + (h[10 + i] % 6)
    dots.push(`<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="${dotSize}" fill="${ringColor}" opacity="0.85"/>`)
  }
  const innerHue = (hue + 180) % 360
  return [
    `<circle cx="${cx}" cy="${cy}" r="${size * 0.45}" fill="${ringColor}" opacity="0.15"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${size * 0.22}" fill="hsl(${innerHue}, 65%, 60%)" opacity="0.6"/>`,
    ...dots,
  ].join('\n')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function svgText(x: number, y: number, content: string, opts: { size?: number; color?: string; weight?: number; anchor?: 'start' | 'middle' | 'end' } = {}): string {
  const size = opts.size ?? 28
  const color = opts.color ?? TEXT
  const weight = opts.weight ?? 400
  const anchor = opts.anchor ?? 'start'
  return `<text x="${x}" y="${y}" font-family="Noto Sans TC" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(content)}</text>`
}

export function buildSvg(data: AgentCardData, userKey: string): string {
  const parts: string[] = []

  // Background gradient
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`)

  // Header band — agent identity
  parts.push(`<rect x="0" y="0" width="${W}" height="280" fill="rgba(0,0,0,0.2)"/>`)
  // Avatar
  parts.push(avatar(userKey, 140, 140, 220))
  // Title
  parts.push(svgText(290, 130, `🃏 ${data.agentName}`, { size: 56, color: ACCENT, weight: 700 }))
  parts.push(svgText(290, 175, '— Pin', { size: 36, color: TEXT, weight: 400 }))
  parts.push(svgText(290, 225, '確定性執行 · 零幻覺', { size: 26, color: MUTED }))

  // Divider
  parts.push(`<line x1="80" y1="320" x2="${W - 80}" y2="320" stroke="${ACCENT}" stroke-opacity="0.4" stroke-width="2"/>`)

  // 武器欄
  let y = 380
  parts.push(svgText(80, y, '⚔️ 武器欄', { size: 38, color: ACCENT, weight: 600 }))
  parts.push(svgText(W - 80, y, `${data.weapons.length} skills`, { size: 22, color: MUTED, anchor: 'end' }))
  y += 50
  for (const w of data.weapons.slice(0, 4)) {
    parts.push(`<rect x="80" y="${y - 30}" width="${W - 160}" height="50" rx="10" fill="${ROW_BG}"/>`)
    parts.push(svgText(110, y + 8, `${w.icon}  ${w.name}`, { size: 32, color: TEXT }))
    parts.push(svgText(W - 110, y + 8, `Lv.${w.status}`, { size: 28, color: w.status === '活躍' ? ACCENT : MUTED, anchor: 'end' }))
    y += 65
  }

  // 防具欄
  y += 30
  parts.push(svgText(80, y, '🛡️ 防具欄', { size: 38, color: ACCENT, weight: 600 }))
  parts.push(svgText(W - 80, y, `${data.protections.length} active`, { size: 22, color: MUTED, anchor: 'end' }))
  y += 50
  for (const p of data.protections.slice(0, 5)) {
    parts.push(svgText(80, y + 10, `✅`, { size: 26 }))
    parts.push(svgText(130, y + 10, p.label, { size: 26, color: TEXT }))
    y += 45
  }

  // 戰績
  y += 30
  parts.push(`<line x1="80" y1="${y - 10}" x2="${W - 80}" y2="${y - 10}" stroke="${ACCENT}" stroke-opacity="0.4" stroke-width="2"/>`)
  y += 30
  parts.push(svgText(80, y, '📊 本週戰績', { size: 38, color: ACCENT, weight: 600 }))
  y += 55
  // Three big-number stats in a row
  const colW = (W - 160) / 3
  const stats = [
    { label: '按鈕操作', value: data.stats.actions, color: GOLD },
    { label: '推播送達', value: data.stats.pushes, color: GOLD },
    { label: 'LLM 介入', value: data.stats.llmFallbacks, color: data.stats.llmFallbacks === 0 ? ACCENT : TEXT },
  ]
  stats.forEach((s, i) => {
    const cx = 80 + colW * i + colW / 2
    parts.push(svgText(cx, y + 50, String(s.value), { size: 72, color: s.color, weight: 700, anchor: 'middle' }))
    parts.push(svgText(cx, y + 90, s.label, { size: 22, color: MUTED, anchor: 'middle' }))
  })
  if (data.stats.llmFallbacks === 0) {
    parts.push(svgText(W / 2, y + 130, '⚡ 越低越強', { size: 22, color: ACCENT, anchor: 'middle' }))
  }

  // Footer
  parts.push(svgText(W / 2, H - 60, 'pin · ultralab.tw', { size: 22, color: MUTED, anchor: 'middle' }))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${BG_TOP}"/>
    <stop offset="1" stop-color="${BG_BOT}"/>
  </linearGradient>
</defs>
${parts.join('\n')}
</svg>`
}

export function renderCardPng(data: AgentCardData, userKey: string): Buffer {
  const svg = buildSvg(data, userKey)
  const resvg = new Resvg(svg, {
    font: { fontDirs: FONT_DIRS, loadSystemFonts: true, defaultFontFamily: 'Noto Sans TC' },
  })
  return resvg.render().asPng()
}
