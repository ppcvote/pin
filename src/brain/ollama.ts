import { httpRequest } from '../products/httpRequest.js'
import http from 'node:http'

const HOST = process.env.OLLAMA_HOST ?? 'localhost'
const PORT = parseInt(process.env.OLLAMA_PORT ?? '11434', 10)
const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b'

interface GenerateResponse {
  model: string
  response: string
  done: boolean
}

/** Call Ollama generate endpoint. Uses node:http directly (no TLS). */
export async function generate(prompt: string, opts?: { temperature?: number; max?: number; json?: boolean }): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    prompt,
    stream: false,
    options: {
      temperature: opts?.temperature ?? 0.2,
      num_predict: opts?.max ?? 256,
    },
  })

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let raw = ''
        res.setEncoding('utf-8')
        res.on('data', c => { raw += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(raw) as GenerateResponse
            resolve(j.response ?? '')
          } catch (err) {
            reject(new Error(`Ollama parse: ${(err as Error).message} | raw: ${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(new Error('Ollama timeout (30s)')) })
    req.write(body)
    req.end()
  })
}
