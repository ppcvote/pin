import https from 'node:https'

const KEY = process.env.OPENROUTER_API_KEY
const MODEL = process.env.OPENROUTER_MODEL ?? 'google/gemma-4-31b-it:free'
const FALLBACK = (process.env.OPENROUTER_FALLBACK ?? 'google/gemini-2.5-flash,anthropic/claude-haiku-4.5')
  .split(',').map(s => s.trim()).filter(Boolean)

if (!KEY) console.warn('[openrouter] OPENROUTER_API_KEY missing — OpenRouter brain disabled')

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string; code?: string | number }
}

function callOnce(model: string, prompt: string, opts?: { temperature?: number; max?: number; json?: boolean }): Promise<string> {
  if (!KEY) return Promise.reject(new Error('OPENROUTER_API_KEY not set'))

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: opts?.temperature ?? 0.2,
    max_tokens: opts?.max ?? 512,
    ...(opts?.json === false ? {} : { response_format: { type: 'json_object' } }),
  })

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        port: 443,
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${KEY}`,
          'HTTP-Referer': 'https://ultralab.tw',
          'X-Title': 'Pin Runtime',
        },
        family: 4,
        agent: false,
        servername: 'openrouter.ai',
      },
      res => {
        let raw = ''
        res.setEncoding('utf-8')
        res.on('data', c => { raw += c })
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`OpenRouter HTTP ${res.statusCode} (${model}): ${raw.slice(0, 300)}`))
            return
          }
          try {
            const j = JSON.parse(raw) as ChatResponse
            if (j.error) {
              reject(new Error(`OpenRouter (${model}): ${j.error.message ?? 'unknown'}`))
              return
            }
            const text = j.choices?.[0]?.message?.content ?? ''
            const cleaned = text.trim()
              .replace(/^```(?:json)?/i, '')
              .replace(/```$/i, '')
              .trim()
            resolve(cleaned)
          } catch (err) {
            reject(new Error(`OpenRouter parse (${model}): ${(err as Error).message} | raw: ${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(new Error(`OpenRouter timeout (30s, ${model})`)) })
    req.write(body)
    req.end()
  })
}

export async function generate(prompt: string, opts?: { temperature?: number; max?: number; json?: boolean }): Promise<string> {
  const chain = [MODEL, ...FALLBACK]
  let lastErr: Error | null = null
  for (const m of chain) {
    try {
      return await callOnce(m, prompt, opts)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('OpenRouter: all models failed')
}
