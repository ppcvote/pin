#!/usr/bin/env node
/**
 * Mock UltraGrowth server — drop-in for the API contract frozen in
 * PIN_FLYWHEEL.md §1. Lets the ultragrowth SKILL be dogfooded before
 * the UltraLab session ships the real endpoints.
 *
 * Run:  node scripts/mock-ug-server.mjs
 * Port: 4001 (matches UG_BASE_URL=http://localhost:4001 in .env)
 */

import http from 'node:http'

const PORT = parseInt(process.env.MOCK_UG_PORT ?? '4001', 10)

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
}

const fakeSummary = (period = '2026-06') => ({
  ok: true,
  data: {
    tenant_id: 'sandbox',
    plan: 'UltraGrowth Pro',
    period,
    seo: {
      keywords_up: 18,
      keywords_down: 4,
      top_keyword: '台北房屋仲介推薦',
    },
    social: {
      reach: 12450,
      posts: 22,
      followers_delta: 137,
    },
    site: {
      visits: 3420,
      visits_delta_pct: 28,
    },
  },
})

const fakePosts = (limit = 5) => {
  const seed = [
    { title: '5 個你不知道的買房眉角', channel: 'Threads', reach: 4200, likes: 312, url: 'https://example.com/p/1', published_at: '2026-06-10' },
    { title: '永和 vs 中和 — 通勤族該選哪邊?', channel: 'IG', reach: 2890, likes: 198, url: 'https://example.com/p/2', published_at: '2026-06-08' },
    { title: '裝潢預算抓 200 萬, 你最該砸在哪?', channel: 'Threads', reach: 5610, likes: 487, url: 'https://example.com/p/3', published_at: '2026-06-06' },
    { title: '為什麼台北人租屋永遠在搬家?', channel: 'IG', reach: 1820, likes: 124, url: 'https://example.com/p/4', published_at: '2026-06-04' },
    { title: '我看了 100 間預售屋, 整理出 5 個雷', channel: 'Threads', reach: 8920, likes: 731, url: 'https://example.com/p/5', published_at: '2026-06-02' },
  ]
  return { ok: true, data: { posts: seed.slice(0, limit) } }
}

const server = http.createServer(async (req, res) => {
  console.log(`[mock-ug] ${req.method} ${req.url}`)

  // Auth check (matches the real shape — Bearer ug_*)
  const auth = req.headers.authorization
  if (req.url?.startsWith('/api/v1/growth/') && !auth?.startsWith('Bearer ug_')) {
    return send(res, 401, { error: 'missing_bearer' })
  }

  // GET /api/v1/growth/summary
  if (req.method === 'GET' && req.url?.startsWith('/api/v1/growth/summary')) {
    return send(res, 200, fakeSummary())
  }

  // GET /api/v1/growth/posts?limit=5
  if (req.method === 'GET' && req.url?.startsWith('/api/v1/growth/posts')) {
    const m = req.url.match(/limit=(\d+)/)
    const limit = m ? Math.min(parseInt(m[1], 10), 20) : 5
    return send(res, 200, fakePosts(limit))
  }

  // POST /api/flywheel-event — just log + accept
  if (req.method === 'POST' && req.url === '/api/flywheel-event') {
    const sharedSecret = req.headers['x-pin-shared-secret']
    let body = ''
    for await (const chunk of req) body += chunk
    console.log(`[mock-ug flywheel-event] secret=${sharedSecret ? 'set' : 'MISSING'} body=${body.slice(0, 200)}`)
    return send(res, 200, { ok: true, received: true })
  }

  return send(res, 404, { error: 'not_found', method: req.method, url: req.url })
})

server.listen(PORT, () => {
  console.log(`[mock-ug] listening on http://localhost:${PORT}`)
  console.log(`  GET  /api/v1/growth/summary`)
  console.log(`  GET  /api/v1/growth/posts?limit=N`)
  console.log(`  POST /api/flywheel-event`)
})
