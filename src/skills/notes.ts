import { saveUser, type Note } from '../storage/jsonStore.js'
import type { Skill, SkillContext } from './types.js'

const ADD_PATTERNS = [
  /^記一下[:：\s]*/,
  /^筆記[:：\s]*/,
  /^記住[:：\s]*/,
  /^幫我記[:：\s]*/,
  /^note[:：\s]+/i,
  /^remember[:：\s]+/i,
]

const SEARCH_PATTERNS = [
  /^我.{0,3}記過/,
  /^找筆記/,
  /^搜筆記/,
  /^搜尋筆記/,
  /^我.{0,3}說過/,
  /^search\s+notes?/i,
  /^find\s+notes?/i,
]

const LIST_PATTERNS = [
  /^列出.{0,3}筆記/,
  /^最近.{0,3}筆記/,
  /^list\s+notes?/i,
]

function newId(): string {
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function extractTags(text: string): string[] {
  const tags = new Set<string>()
  // Hashtag style
  for (const m of text.matchAll(/#(\S+)/g)) tags.add(m[1])
  // CJK named entities (very simple — capitalized words / 2+ char names)
  // We keep this minimal for MVP; LLM-based extraction later.
  return Array.from(tags)
}

const notes: Skill = {
  id: 'notes',
  name: 'Notes',
  description: 'Save short text notes (people, ideas, facts) and search them later.',
  examples: [
    '記一下: Molly 偏好結果論',
    '我記過 Molly 嗎',
    '搜筆記 UDomain',
    '列出最近筆記',
  ],

  match(ctx: SkillContext): boolean {
    const t = ctx.text.trim()
    return ADD_PATTERNS.some(re => re.test(t))
      || SEARCH_PATTERNS.some(re => re.test(t))
      || LIST_PATTERNS.some(re => re.test(t))
  },

  async handle(ctx: SkillContext): Promise<string> {
    const t = ctx.text.trim()

    // LIST: recent notes
    if (LIST_PATTERNS.some(re => re.test(t))) {
      const recent = [...ctx.user.notes]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
      if (recent.length === 0) return '還沒有任何筆記 📭'
      const lines = recent.map((n, i) => {
        const when = new Date(n.createdAt).toLocaleDateString('zh-TW')
        const tags = n.tags.length ? ` [${n.tags.join(' ')}]` : ''
        return `${i + 1}. (${when})${tags} ${n.text.slice(0, 80)}`
      })
      return `📒 最近 ${recent.length} 則筆記:\n${lines.join('\n')}`
    }

    // SEARCH
    for (const re of SEARCH_PATTERNS) {
      const m = t.match(re)
      if (!m) continue
      // Extract query — everything after the trigger
      const query = t.slice(m[0].length).replace(/[嗎\?？\s]+$/, '').trim()
      if (!query) return '要找什麼? 試試「我記過 Molly 嗎」'
      const q = query.toLowerCase()
      const hits = ctx.user.notes
        .filter(n => n.text.toLowerCase().includes(q) || n.tags.some(tag => tag.toLowerCase().includes(q)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 5)
      if (hits.length === 0) return `沒找到「${query}」相關的筆記 🔍`
      const lines = hits.map((n, i) => {
        const when = new Date(n.createdAt).toLocaleDateString('zh-TW')
        return `${i + 1}. (${when}) ${n.text}`
      })
      return `🔍 找到 ${hits.length} 則「${query}」相關:\n${lines.join('\n')}`
    }

    // ADD
    for (const re of ADD_PATTERNS) {
      const m = t.match(re)
      if (!m) continue
      const body = t.slice(m[0].length).trim()
      if (!body) return '要記什麼? 試試「記一下: Molly 偏好結果論」'
      const note: Note = {
        id: newId(),
        text: body,
        tags: extractTags(body),
        createdAt: ctx.now.toISOString(),
      }
      ctx.user.notes.push(note)
      await saveUser(ctx.user)
      const tagStr = note.tags.length ? `\n🏷️ ${note.tags.join(' ')}` : ''
      return `📝 記住了\n${body}${tagStr}`
    }

    return '我搞不清楚要做什麼 🤔'
  },
}

export default notes
