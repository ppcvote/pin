/**
 * PIN_PERSONA §8 — Red-line auto-scanner.
 *
 * Pure function: no runtime deps, no I/O, fully unit-testable.
 * Call after any outbound copy is produced; log + intercept on hit.
 *
 * Prohibited:
 *   - Banned words (AI/sales tone): 立即 馬上 親 為您 賦能 打造
 *   - "不是X而是Y" sentence pattern (PPC explicit dislike)
 *   - Sexualization / cute-ification markers
 *   - Simplified Chinese characters (Traditional-only policy)
 *   - Excessive exclamation (>1 per message)
 */

export interface RedlineScan {
  passed: boolean
  hits: string[]
}

const FORBIDDEN_WORDS: readonly string[] = [
  '立即', '馬上', '為您', '賦能', '打造',
]

// 「親」只在當「稱呼語」時是紅線（淘寶式「親，…」「親！」），不誤傷
// 親切/親自/父親/母親/親友/親愛/親手 等正常詞（含人格自己的「親切模式」）。
const SALESY_QIN = /(?:^|[\s，,。.！!？?、：:])親(?=[\s，,。.！!？?～~、：:]|$)/

// 不是X而是Y — matches even with filler between X and Y
const NOT_X_BUT_Y = /不是.{1,30}而是.{1,30}/

// Simplified-only characters — distinct Unicode codepoints from Traditional equivalents.
// These never appear in correctly-encoded Traditional Chinese text.
// Verified simplified→traditional pairs: 们/們 为/為 过/過 还/還 说/說 马/馬 开/開 吗/嗎
// 这/這 问/問 来/來 时/時 对/對 会/會 关/關 处/處 长/長 书/書 头/頭 东/東 场/場 带/帶
// 见/見 组/組 气/氣 级/級 约/約 给/給 义/義 务/務 决/決 证/證 认/認 写/寫 专/專 选/選
// 记/記 结/結 复/復 获/獲 无/無 备/備 单/單 双/雙 导/導 归/歸 电/電 线/線 经/經 购/購
// 进/進 边/邊 远/遠 达/達 连/連 转/轉 协/協 艺/藝 历/歷 则/則 响/響 继/繼
const SIMPLIFIED_CHARS = new Set<string>([
  '们', '为', '过', '还', '说', '马', '开', '吗', '这', '问',
  '来', '时', '对', '会', '关', '处', '长', '书', '头', '东',
  '场', '带', '见', '组', '气', '级', '约', '给', '义', '务',
  '决', '证', '认', '写', '专', '选', '记', '结', '复', '获',
  '无', '备', '单', '双', '导', '归', '电', '线', '经', '购',
  '进', '边', '远', '达', '连', '转', '协', '艺', '历', '则',
  '响', '继',
])

// Explicit sexualization / cute-ification patterns (PPC §0 鐵律2)
const CUTE_SEXUALIZED_WORDS: readonly string[] = [
  '親親', '寶貝', '好棒棒', '乖乖', '抱抱', '摸摸頭',
]
const CUTE_SEXUALIZED_PATTERNS: readonly RegExp[] = [
  /哦[~～]+/, /嗯[~～]+/, /喔[~～]+/, /呢[~～]+/,
]

export function scanRedline(text: string): RedlineScan {
  const hits: string[] = []

  // §1 Banned words
  for (const word of FORBIDDEN_WORDS) {
    if (text.includes(word)) {
      hits.push(`禁用詞: 「${word}」`)
    }
  }
  // 「親」稱呼語（不誤傷 親切/父親 等）
  if (SALESY_QIN.test(text)) {
    hits.push('禁用詞: 「親」(稱呼語)')
  }

  // §2 不是X而是Y sentence pattern
  const notXButY = text.match(NOT_X_BUT_Y)
  if (notXButY) {
    hits.push(`禁句型: 「${notXButY[0].slice(0, 25)}${notXButY[0].length > 25 ? '…' : ''}」`)
  }

  // §3 Simplified Chinese characters
  const simplified: string[] = []
  for (const ch of text) {
    if (SIMPLIFIED_CHARS.has(ch) && !simplified.includes(ch)) {
      simplified.push(ch)
      if (simplified.length >= 5) break
    }
  }
  if (simplified.length > 0) {
    hits.push(`紅線-簡體字: 「${simplified.join('')}」`)
  }

  // §4 Sexualization / cute-ification
  for (const word of CUTE_SEXUALIZED_WORDS) {
    if (text.includes(word)) {
      hits.push(`紅線-賣萌: 「${word}」`)
      break
    }
  }
  for (const pat of CUTE_SEXUALIZED_PATTERNS) {
    if (pat.test(text)) {
      hits.push(`紅線-賣萌語氣: /${pat.source}/`)
      break
    }
  }

  // §5 Excessive exclamation (>1 per message — PIN_PERSONA §3 "驚嘆號節制")
  const exclamCount = (text.match(/！|!/g) ?? []).length
  if (exclamCount > 1) {
    hits.push(`過量驚嘆號: ${exclamCount} 個（上限 1）`)
  }

  return { passed: hits.length === 0, hits }
}

/**
 * Log a redline violation. Callers should call this whenever scanRedline returns
 * passed=false, so the hit is always surfaced (never silently ignored).
 */
export function reportRedlineViolation(context: string, hits: string[]): void {
  console.error(`[redline] ${context} | hits: ${hits.join(' / ')}`)
}
