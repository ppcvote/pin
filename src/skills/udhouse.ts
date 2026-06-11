import { whoami, listListings, listLeads } from '../products/udhouse.js'
import type { Skill, SkillContext } from './types.js'

const TRIGGER = /(ud\s*house|udh|房仲|物件|盤源|放盤|lead|詢問|房客|樓盤)/i

const SUB_INTENTS = {
  listings: /(物件|listing|盤源|放盤|樓盤|有.{0,5}盤|多少.{0,3}盤)/i,
  leads: /(lead|詢問|客|查詢|interested)/i,
  whoami: /(我是誰|whoami|身份)/i,
}

const udhouse: Skill = {
  id: 'udhouse',
  name: 'UD House',
  description: 'Query the user\'s UD House real-estate platform: list property listings, leads (customer inquiries), or realtor identity.',
  examples: [
    'UD House 物件',
    'UDH 今天 lead',
    '我有幾個盤',
    '房仲 lead',
  ],

  match(ctx: SkillContext): boolean {
    return TRIGGER.test(ctx.text)
  },

  async handle(ctx: SkillContext): Promise<string> {
    try {
      // WHOAMI
      if (SUB_INTENTS.whoami.test(ctx.text)) {
        const me = await whoami()
        return [
          `🏠 UD House identity`,
          ``,
          `Product: ${me.product}`,
          `Tenant: ${me.tenant_id}`,
          `UID: ${me.uid}`,
        ].join('\n')
      }

      // LEADS
      if (SUB_INTENTS.leads.test(ctx.text)) {
        const leads = await listLeads()
        if (leads.length === 0) return '📭 目前沒有 lead'
        const lines = leads.slice(0, 10).map((l, i) => {
          const when = l.created_at ? new Date(l.created_at).toLocaleDateString('zh-TW') : '?'
          const who = l.name ?? l.contact ?? '(匿名)'
          const msg = (l.message ?? '').slice(0, 40)
          return `${i + 1}. ${when} · ${who}${msg ? ` — ${msg}` : ''}`
        })
        const more = leads.length > 10 ? `\n…還有 ${leads.length - 10} 個` : ''
        return `🔥 UD House Leads (${leads.length}):\n${lines.join('\n')}${more}`
      }

      // LISTINGS (default)
      const listings = await listListings()
      if (listings.length === 0) return '📭 目前沒有物件'

      const sorted = [...listings].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      const lines = sorted.slice(0, 8).map((l, i) => {
        const title = l.title || l.address || `物件 ${l.id}`
        const price = l.price ? ` · $${l.price.toLocaleString()}` : ''
        const district = l.district ? ` · ${l.district}` : ''
        const status = l.status ? ` (${l.status})` : ''
        return `${i + 1}. ${title.slice(0, 30)}${price}${district}${status}`
      })
      const more = listings.length > 8 ? `\n…還有 ${listings.length - 8} 個` : ''
      return `🏠 UD House 物件 (${listings.length} 個):\n${lines.join('\n')}${more}`
    } catch (err) {
      return `UD House API 出錯 😢\n${(err as Error).message.slice(0, 200)}`
    }
  },
}

export default udhouse
