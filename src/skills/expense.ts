import { saveUser, type Expense } from '../storage/jsonStore.js'
import type { Skill, SkillContext } from './types.js'

/** Match patterns that look like expense logging.
 *  Examples that should match:
 *    午餐 NT$120
 *    NT$120 午餐
 *    午餐 120 元
 *    120 元 午餐
 *    花了 350 元 計程車
 */
const AMOUNT_RE = /(?:NT\$?|HK\$?|US\$?|\$)\s*(\d{1,7}(?:\.\d{1,2})?)|(\d{1,7}(?:\.\d{1,2})?)\s*(?:元|塊|TWD|HKD|USD)/i

const SUMMARY_PATTERNS = [
  /這(個)?月.{0,5}花了/,
  /上(個)?月.{0,5}花了/,
  /這(個)?月.{0,5}多少/,
  /上(個)?月.{0,5}多少/,
  /總共花了/,
  /開銷.{0,5}多少/,
  /今天.{0,5}花了/,
  /spent\s+this\s+month/i,
]

const LIST_PATTERNS = [
  /^列出.{0,5}(開銷|花費|帳)/,
  /^最近.{0,5}(開銷|花費|帳)/,
  /^list\s+expense/i,
]

const CATEGORIES: Array<{ keywords: string[]; name: string }> = [
  { keywords: ['早餐', '午餐', '晚餐', '宵夜', '吃', '餐', '飯', '咖啡', '飲料', '蛋糕'], name: '飲食' },
  { keywords: ['計程車', '叫車', '油', '加油', '高鐵', '捷運', '公車', '停車'], name: '交通' },
  { keywords: ['電', '水', '網', '瓦斯', '房租', '管理費'], name: '居家' },
  { keywords: ['電影', '遊戲', '訂閱', 'KTV'], name: '娛樂' },
  { keywords: ['醫', '藥', '診所'], name: '醫療' },
  { keywords: ['書', '課程', '訂閱', 'AI'], name: '學習' },
]

function classify(note: string): string {
  const lower = note.toLowerCase()
  for (const c of CATEGORIES) {
    if (c.keywords.some(k => lower.includes(k.toLowerCase()))) return c.name
  }
  return '其他'
}

function detectCurrency(text: string): 'TWD' | 'HKD' | 'USD' {
  if (/HK\$|HKD/i.test(text)) return 'HKD'
  if (/US\$|USD/i.test(text)) return 'USD'
  return 'TWD'
}

function newId(): string {
  return `e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

const expense: Skill = {
  id: 'expense',
  name: 'Expense',
  description: 'Log a spending entry with amount + note, or aggregate spending by month / category.',
  examples: [
    '午餐 NT$120',
    '咖啡 80 元',
    '這個月吃飯多少',
    '列出最近開銷',
  ],

  match(ctx: SkillContext): boolean {
    const t = ctx.text.trim()
    if (LIST_PATTERNS.some(re => re.test(t))) return true
    if (SUMMARY_PATTERNS.some(re => re.test(t))) return true
    // Add intent — must contain a number with currency or 元/塊
    return AMOUNT_RE.test(t)
  },

  async handle(ctx: SkillContext): Promise<string> {
    const t = ctx.text.trim()

    // LIST recent
    if (LIST_PATTERNS.some(re => re.test(t))) {
      const recent = [...ctx.user.expenses]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
      if (recent.length === 0) return '還沒有任何記帳 📭'
      const lines = recent.map((e, i) => {
        const when = new Date(e.createdAt).toLocaleDateString('zh-TW')
        return `${i + 1}. ${when} · ${e.currency} ${e.amount} · ${e.category} · ${e.note}`
      })
      return `💰 最近 ${recent.length} 筆:\n${lines.join('\n')}`
    }

    // SUMMARY — this/last month, today, by category
    if (SUMMARY_PATTERNS.some(re => re.test(t))) {
      let scopeStart: Date
      let scopeLabel: string
      if (/上(個)?月/.test(t)) {
        const d = new Date(ctx.now.getFullYear(), ctx.now.getMonth() - 1, 1)
        scopeStart = d
        scopeLabel = `${d.getMonth() + 1} 月`
      } else if (/今天/.test(t)) {
        scopeStart = startOfDay(ctx.now)
        scopeLabel = '今天'
      } else {
        scopeStart = startOfMonth(ctx.now)
        scopeLabel = `${ctx.now.getMonth() + 1} 月`
      }
      const scopeEnd = /上(個)?月/.test(t) ? startOfMonth(ctx.now) : new Date(ctx.now.getTime() + 86400000)
      const inScope = ctx.user.expenses.filter(e => {
        const d = new Date(e.createdAt)
        return d >= scopeStart && d < scopeEnd
      })
      // Try to detect category filter
      let catFilter: string | null = null
      for (const c of CATEGORIES) {
        if (c.keywords.some(k => t.includes(k))) { catFilter = c.name; break }
      }
      const filtered = catFilter ? inScope.filter(e => e.category === catFilter) : inScope
      if (filtered.length === 0) return `${scopeLabel}${catFilter ? ` 在「${catFilter}」` : ''} 沒有任何記帳 📭`

      // Group by currency
      const byCur: Record<string, number> = {}
      for (const e of filtered) byCur[e.currency] = (byCur[e.currency] ?? 0) + e.amount
      const curLines = Object.entries(byCur).map(([c, sum]) => `${c} ${sum.toFixed(2).replace(/\.00$/, '')}`)

      // Top categories
      const byCat: Record<string, number> = {}
      for (const e of filtered) byCat[e.category] = (byCat[e.category] ?? 0) + e.amount
      const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4)
      const catLines = topCats.map(([c, sum]) => `  · ${c}: ${sum.toFixed(0)}`)

      return [
        `💰 ${scopeLabel}${catFilter ? `「${catFilter}」` : ''} 共 ${filtered.length} 筆`,
        `合計: ${curLines.join(' · ')}`,
        ...(catFilter ? [] : ['', '分類:', ...catLines]),
      ].join('\n')
    }

    // ADD
    const m = AMOUNT_RE.exec(t)
    if (!m) return '我看不出金額 🤔 試試「午餐 NT$120」'
    const amount = parseFloat(m[1] ?? m[2])
    const currency = detectCurrency(t)
    const note = t.replace(m[0], '').replace(/^[\s,，、的]+|[\s,，、的]+$/g, '').trim() || '(無描述)'
    const category = classify(note)

    const e: Expense = {
      id: newId(),
      amount,
      currency,
      category,
      note,
      createdAt: ctx.now.toISOString(),
    }
    ctx.user.expenses.push(e)
    await saveUser(ctx.user)

    return `💰 記住了\n${currency} ${amount} · ${category}\n📝 ${note}`
  },
}

export default expense
