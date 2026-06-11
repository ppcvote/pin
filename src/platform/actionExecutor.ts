import { httpRequest } from '../products/httpRequest.js'
import { render } from './template.js'
import type { ActionDef, ApiSpec, Skill, ChoiceSpec } from './types.js'

/** Resolve a path like "data.accounts" on the response object. */
function pathLookup(obj: any, path: string): any {
  if (!path) return obj
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p] }
  return cur
}

/** Build inline buttons from a choices spec by walking the response array. */
function buildChoices(
  skillId: string,
  choices: ChoiceSpec,
  unwrappedData: any,
  rawResponse: any
): { text: string; callback_data: string }[] {
  // Search in unwrapped data first, fall back to raw
  const arr = pathLookup(unwrappedData, choices.from) ?? pathLookup(rawResponse, choices.from)
  if (!Array.isArray(arr)) return []
  const limit = Math.min(choices.limit ?? 100, arr.length)
  const out: { text: string; callback_data: string }[] = []
  for (let i = 0; i < limit; i++) {
    const item = arr[i]
    const text = render(choices.button, { this: item })
    // Build args
    const argsObj: Record<string, string> = {}
    if (choices.callback_args) {
      for (const [k, vTmpl] of Object.entries(choices.callback_args)) {
        argsObj[k] = render(vTmpl, { this: item })
      }
    }
    const argsEncoded = Object.entries(argsObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    // Pin callback format: a:<skill>:<action>?args
    let cb = `a:${skillId}:${choices.callback_action}`
    if (argsEncoded) cb += `?${argsEncoded}`
    // TG limit: 64 bytes — truncate if needed
    if (Buffer.byteLength(cb) > 64) {
      console.warn(`[choices] callback_data exceeds 64 bytes (${cb.length}): ${cb}`)
      cb = cb.slice(0, 64)
    }
    out.push({ text: text.slice(0, 40), callback_data: cb })
  }
  return out
}

/** Resolve `{ENV_VAR}` and `{arg_name}` placeholders in a string. */
function resolve(str: string, args: Record<string, any>): string {
  return str.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => String(process.env[name] ?? ''))
            .replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, name) => String(args[name] ?? ''))
}

/** Build Authorization header from `auth` spec like "bearer:MT_API_KEY". */
function buildAuthHeader(auth?: string): Record<string, string> {
  if (!auth) return {}
  const [scheme, envName] = auth.split(':')
  const token = envName ? process.env[envName] : undefined
  if (!token) return {}
  if (scheme.toLowerCase() === 'bearer') return { Authorization: `Bearer ${token}` }
  return {}
}

async function callApi(api: ApiSpec, args: Record<string, any>): Promise<any> {
  const url = resolve(api.url, args)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildAuthHeader(api.auth),
  }

  let body: string | undefined
  if (api.body && (api.method === 'POST' || api.method === 'PUT')) {
    const resolved: Record<string, any> = {}
    for (const [k, v] of Object.entries(api.body)) {
      resolved[k] = typeof v === 'string' ? resolve(v, args) : v
    }
    body = JSON.stringify(resolved)
  }

  // Append query
  let finalUrl = url
  if (api.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(api.query)) {
      qs.append(k, resolve(String(v), args))
    }
    finalUrl = `${url}${url.includes('?') ? '&' : '?'}${qs.toString()}`
  }

  return httpRequest<any>(finalUrl, { method: api.method, headers, body })
}

export interface RenderedChoice {
  text: string
  callback_data: string
}

export interface RenderedFollowUp {
  text: string
  callback_data?: string  // for action buttons
  url?: string            // for url buttons
}

export interface ActionResult {
  ok: boolean
  raw?: any                          // raw API response
  rendered?: string                  // user-facing text (from template)
  choices?: RenderedChoice[]         // inline buttons derived from response data
  followUps?: RenderedFollowUp[]     // follow-up action / URL buttons
  error?: string
}

export async function executeAction(
  skill: Skill,
  action: ActionDef,
  args: Record<string, any> = {}
): Promise<ActionResult> {
  try {
    if (action.api) {
      const raw = await callApi(action.api, args)
      const data = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw

      // Client-side filter (for APIs that don't support server-side filter)
      let found: any = undefined
      if (action.respond?.find_one) {
        const f = action.respond.find_one
        const arr = pathLookup(data, f.from) ?? pathLookup(raw, f.from)
        const target = resolve(f.equals, args)
        if (Array.isArray(arr)) {
          found = arr.find(item => String(pathLookup(item, f.where)) === target)
        }
      }

      const scope = { response: raw, data, args, found, more_count: 0 }

      let rendered: string | undefined
      let choices: { text: string; callback_data: string }[] | undefined
      let followUps: { text: string; callback_data?: string; url?: string }[] | undefined
      if (action.respond?.template) {
        rendered = render(action.respond.template, scope)
      }
      if (action.respond?.choices) {
        choices = buildChoices(skill.id, action.respond.choices, data, raw)
      }
      if (action.respond?.follow_up_actions || action.respond?.follow_up_urls) {
        followUps = []
        for (const fu of action.respond.follow_up_actions ?? []) {
          const targetAction = skill.pin?.actions.find(x => x.id === fu.action)
          if (!targetAction) continue
          const label = fu.label ?? targetAction.label
          // Resolve forwarded args from scope
          const forwardedArgs: Record<string, string> = {}
          for (const [k, vTmpl] of Object.entries(fu.args ?? {})) {
            forwardedArgs[k] = render(vTmpl, scope)
          }
          const enc = Object.entries(forwardedArgs).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
          let cb = `a:${skill.id}:${fu.action}`
          if (enc) cb += `?${enc}`
          if (Buffer.byteLength(cb) > 64) cb = cb.slice(0, 64)
          followUps.push({ text: label.slice(0, 40), callback_data: cb })
        }
        for (const fu of action.respond.follow_up_urls ?? []) {
          const url = render(fu.url, scope)
          if (!url) continue
          followUps.push({ text: fu.label.slice(0, 40), url })
        }
      }
      return { ok: true, raw, rendered, choices, followUps }
    }
    if (action.script) {
      return { ok: false, error: 'script execution not yet implemented (PR welcome)' }
    }
    if (action.handler) {
      return { ok: false, error: 'handler execution not yet implemented (PR welcome)' }
    }
    return { ok: false, error: 'action has no api / script / handler' }
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) }
  }
}
