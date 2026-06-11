import { listAccounts } from '../products/mindthread.js'
import type { Skill, SkillContext } from './types.js'

const TRIGGER = /(mindthread|mt帳號|脆|threads|社群)/i

const SUB_INTENTS = {
  accounts: /(帳號|accounts?|連接|connected)/i,
  followers: /(粉絲|followers?|多少粉)/i,
  views: /(瀏覽|views?|觀看)/i,
  posts: /(發了多少|發過多少|posts?|貼文數)/i,
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

const mindthread: Skill = {
  id: 'mindthread',
  name: 'MindThread',
  description: 'Query the user\'s MindThread social-media automation: list connected Threads accounts, view follower / view / post stats.',
  examples: [
    'MindThread 帳號',
    'MT 粉絲多少',
    '我有幾個 threads',
    '社群帳號統計',
  ],

  match(ctx: SkillContext): boolean {
    return TRIGGER.test(ctx.text)
  },

  async handle(ctx: SkillContext): Promise<string> {
    try {
      const accounts = await listAccounts()

      // FOLLOWERS / POSTS / VIEWS aggregates
      if (SUB_INTENTS.followers.test(ctx.text) || SUB_INTENTS.views.test(ctx.text) || SUB_INTENTS.posts.test(ctx.text)) {
        const totFollowers = accounts.reduce((s, a) => s + a.stats.followers, 0)
        const totViews = accounts.reduce((s, a) => s + a.stats.total_views, 0)
        const totPosts = accounts.reduce((s, a) => s + a.stats.total_posts, 0)
        const totLikes = accounts.reduce((s, a) => s + a.stats.total_likes, 0)
        return [
          `📊 MindThread 全帳號合計 (${accounts.length} 個):`,
          ``,
          `👥 粉絲: ${formatNumber(totFollowers)}`,
          `👁️ 瀏覽: ${formatNumber(totViews)}`,
          `📝 貼文: ${formatNumber(totPosts)}`,
          `❤️ 喜歡: ${formatNumber(totLikes)}`,
        ].join('\n')
      }

      // Default: ACCOUNTS list
      if (accounts.length === 0) return '🤔 沒有 MindThread 帳號'
      const lines = accounts.slice(0, 10).map((a, i) => {
        const f = formatNumber(a.stats.followers)
        const v = formatNumber(a.stats.total_views)
        const p = a.stats.total_posts
        return `${i + 1}. ${a.threads_username} (${a.display_name.slice(0, 12)}) — 👥${f} 👁${v} 📝${p}`
      })
      const more = accounts.length > 10 ? `\n…還有 ${accounts.length - 10} 個` : ''
      return `🧵 MindThread 帳號 (${accounts.length} 個):\n${lines.join('\n')}${more}`
    } catch (err) {
      return `MindThread API 出錯 😢\n${(err as Error).message.slice(0, 200)}`
    }
  },
}

export default mindthread
