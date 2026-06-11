import https from 'node:https'
import { URL } from 'node:url'

/**
 * Promise-based HTTPS request using Node's `https` module.
 * Workaround for undici/fetch failing on some Vercel-hosted TLS/H2 endpoints
 * (e.g. mindthread.tw at the time of writing).
 */
export async function httpRequest<T = unknown>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<T> {
  const u = new URL(url)
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        family: 4,        // force IPv4 — avoid v6 hangs
        agent: false,     // disable keep-alive pool — avoid concurrent-conn issues with long-poll
        servername: u.hostname, // explicit SNI
      },
      res => {
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
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'))
    })
    if (init.body) req.write(init.body)
    req.end()
  })
}
