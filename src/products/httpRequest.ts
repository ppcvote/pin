import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

/**
 * Promise-based HTTP/HTTPS request.
 * Was historically HTTPS-only — workaround for undici/fetch failing on some
 * Vercel-hosted TLS/H2 endpoints (mindthread.tw). Now also handles http://
 * cleanly so the mock servers used during dogfood can be hit without TLS.
 */
export async function httpRequest<T = unknown>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<T> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const transport = isHttps ? https : http
  return new Promise<T>((resolve, reject) => {
    const opts: any = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      family: 4,
      agent: false,
    }
    if (isHttps) opts.servername = u.hostname
    const req = transport.request(opts, res => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${body.slice(0, 300)}`))
          return
        }
        try {
          resolve(JSON.parse(body) as T)
        } catch (err) {
          reject(new Error(`JSON parse failed: ${(err as Error).message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'))
    })
    if (init.body) req.write(init.body)
    req.end()
  })
}
