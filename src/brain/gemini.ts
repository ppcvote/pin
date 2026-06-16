import https from 'node:https'

const KEY = process.env.GEMINI_API_KEY
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

if (!KEY) console.warn('[gemini] GEMINI_API_KEY missing — Gemini brain disabled')

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  promptFeedback?: { blockReason?: string }
}

/**
 * Call Gemini generateContent.
 * Strips ```json``` code fences from output (Gemini frequently wraps JSON in them).
 */
export async function generate(prompt: string, opts?: { temperature?: number; max?: number; json?: boolean }): Promise<string> {
  if (!KEY) throw new Error('GEMINI_API_KEY not set')
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts?.temperature ?? 0.2,
      maxOutputTokens: opts?.max ?? 512,
      // JSON by default (legacy + agent routers parse JSON). Prose callers
      // (e.g. the qa skill) pass json:false to get plain text — otherwise
      // Gemini wraps the answer as {"answer": "..."} and the user sees raw JSON.
      responseMimeType: opts?.json === false ? 'text/plain' : 'application/json',
      // No responseSchema — different callers emit different shapes (legacy
      // router uses {intent, rewritten, reply}; agent router uses
      // {decision, action, args, candidates, question, reply}). Pinning a
      // schema here collapses both and broke agent mode in dogfood.
    },
  })

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        family: 4,
        agent: false,
        servername: 'generativelanguage.googleapis.com',
      },
      res => {
        let raw = ''
        res.setEncoding('utf-8')
        res.on('data', c => { raw += c })
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Gemini HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
            return
          }
          try {
            const j = JSON.parse(raw) as GeminiResponse
            if (j.promptFeedback?.blockReason) {
              reject(new Error(`Gemini blocked: ${j.promptFeedback.blockReason}`))
              return
            }
            const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
            // Strip code fence if any
            const cleaned = text.trim()
              .replace(/^```(?:json)?/i, '')
              .replace(/```$/i, '')
              .trim()
            resolve(cleaned)
          } catch (err) {
            reject(new Error(`Gemini parse: ${(err as Error).message} | raw: ${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(new Error('Gemini timeout (30s)')) })
    req.write(body)
    req.end()
  })
}
