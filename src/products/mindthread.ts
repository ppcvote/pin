import { httpRequest } from './httpRequest.js'

const BASE = process.env.MT_BASE_URL ?? 'https://mindthread.tw'
const KEY = process.env.MT_API_KEY

if (!KEY) console.warn('[mindthread] MT_API_KEY not set — MindThread skill will fail')

async function call<T = any>(path: string): Promise<T> {
  return httpRequest<T>(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
  })
}

export interface MTAccount {
  id: string
  threads_username: string
  display_name: string
  status: string
  has_system_prompt: boolean
  stats: {
    followers: number
    total_views: number
    total_likes: number
    total_replies: number
    total_posts: number
  }
  connected_at: string
}

interface AccountsResponse {
  ok: boolean
  data: { accounts: MTAccount[] }
}

export async function listAccounts(): Promise<MTAccount[]> {
  const r = await call<AccountsResponse>('/api/v1/accounts')
  return r.data.accounts
}
