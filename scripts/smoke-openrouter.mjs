#!/usr/bin/env node
// Smoke test: Pin's openrouter brain — runs against compiled dist/.
// Loads .env via dotenv, calls generate(), prints model + token cost-of-life.
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', '.env') })

const { generate, brainName } = await import('../dist/brain/index.js')

console.log(`brain mode: ${brainName}`)
console.log(`primary model: ${process.env.OPENROUTER_MODEL ?? '(default)'}`)
console.log(`key present: ${process.env.OPENROUTER_API_KEY ? 'yes' : 'NO'}`)
console.log()
console.log('Calling generate() with a tiny prompt...')

const t0 = Date.now()
try {
  const out = await generate(
    'Reply with the single token "pong" and nothing else.',
    { temperature: 0, max: 16, json: false }
  )
  const ms = Date.now() - t0
  console.log(`✅ OK in ${ms}ms — response:`)
  console.log('  ' + JSON.stringify(out))
} catch (err) {
  const ms = Date.now() - t0
  console.error(`❌ FAIL in ${ms}ms:`)
  console.error('  ' + err.message)
  process.exit(1)
}
