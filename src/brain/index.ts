import { generate as ollamaGenerate } from './ollama.js'
import { generate as geminiGenerate } from './gemini.js'
import { generate as openrouterGenerate } from './openrouter.js'

const MODE = (process.env.BRAIN_MODE ?? 'openrouter').toLowerCase()

export const brainName = MODE

export async function generate(prompt: string, opts?: { temperature?: number; max?: number; json?: boolean }): Promise<string> {
  if (MODE === 'openrouter') return openrouterGenerate(prompt, opts)
  if (MODE === 'gemini') return geminiGenerate(prompt, opts)
  return ollamaGenerate(prompt, opts)
}
