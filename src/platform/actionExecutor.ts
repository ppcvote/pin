import { httpRequest } from '../products/httpRequest.js'
import { render } from './template.js'
import { readTempBlob } from '../runtime/tempStore.js'
import { shortenCallback } from '../runtime/callbackRefs.js'
import type { ActionDef, ApiSpec, Skill, ChoiceSpec } from './types.js'

/**
 * Resolve tmp:<id> blob reference(s) for JSON bodies.
 * Comma-separated multi-refs (stored by multi-image wizard) always return an array,
 * so the body key should be plural (e.g. "images") to match backend array handling.
 * Single ref also returns a single-element array for consistency with plural key.
 */
function maybeResolveBlob(value: any): any {
  if (typeof value !== 'string' || !value.startsWith('tmp:')) return value
  const refs = value.split(',').map(r => r.trim()).filter(r => r.startsWith('tmp:'))
  if (refs.length === 0) return value
  const dataUrls = refs
    .map(ref => {
      const blob = readTempBlob(ref)
      if (!blob) return null
      return `data:${blob.mime};base64,${blob.data.toString('base64')}`
    })
    .filter((u): u is string => u !== null)
  return dataUrls.length === 0 ? value : dataUrls
}

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
    // TG caps callback_data at 64 bytes — oversized payloads go through
    // the server-side indirection instead of being corrupted by truncation.
    out.push({ text: text.slice(0, 40), callback_data: shortenCallback(cb) })
  }
  return out
}

/** Resolve `{ENV_VAR}`, `{arg_name}`, and dynamic tokens like `{now}` in a string. */
function resolve(str: string, args: Record<string, any>): string {
  return str
    .replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => String(process.env[name] ?? ''))
    .replace(/\{([a-z_][a-z0-9_]*)(?:([+-])(\d+)([smhd]))?\}/g, (_, name, sign, amount, unit) => {
      if (name === 'now' || name === 'today') {
        let ms = Date.now()
        if (sign && amount && unit) {
          const n = parseInt(amount, 10)
          const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
          ms += (sign === '+' ? 1 : -1) * n * factor
        }
        const d = new Date(ms)
        return name === 'today' ? d.toISOString().slice(0, 10) : d.toISOString()
      }
      return String(args[name] ?? '')
    })
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
      let val: any = typeof v === 'string' ? resolve(v, args) : v
      // If the resolved value is a tmp:<id> ref, inline the binary as a data URL
      val = maybeResolveBlob(val)
      resolved[k] = val
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

  const timeoutMs = Math.min(Math.max(api.timeout_s ?? 15, 1), 120) * 1000
  return httpRequest<any>(finalUrl, { method: api.method, headers, body, timeoutMs })
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
          followUps.push({ text: label.slice(0, 40), callback_data: shortenCallback(cb) })
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
      // Dynamic import resolves to dist/skills/<skillId>.js at runtime.
      // Using a variable intentionally — TypeScript yields `any`, which is correct here.
      const mod = await import(`../skills/${skill.id}.js`) as Record<string, unknown>
      const fn = mod[action.handler]
      if (typeof fn !== 'function') {
        return { ok: false, error: `handler "${action.handler}" not exported from skills/${skill.id}` }
      }
      return await fn(args) as ActionResult
    }
    return { ok: false, error: 'action has no api / script / handler' }
  } catch (err) {
    return { ok: false, error: sanitizeError((err as Error).message) }
  }
}

/**
 * Normalise upstream error text for end users — strip HTML/CSS noise from
 * Cloudflare/nginx error pages so the user sees something like
 * "服務暫時無法回應 (502)" instead of "HTTP 502: <html><head>..." with 200
 * characters of markup.
 */
function sanitizeError(raw: string): string {
  // Match common upstream-down patterns
  const httpMatch = raw.match(/HTTP\s+(\d{3})/)
  if (httpMatch) {
    const status = httpMatch[1]
    if (status === '502' || status === '503' || status === '504') {
      return `產品端服務暫時無法回應 (${status}). 稍候再試或從選單操作.`
    }
    if (status === '401' || status === '403') {
      return `產品端拒絕了這個請求 (${status}). 連結可能過期或權限不足.`
    }
    if (status === '404') {
      return `找不到對應資源 (${status})`
    }
    if (status === '429') {
      return `操作太頻繁了 (${status}). 過一會兒再試.`
    }
    if (status === '500') {
      return `產品端有個內部錯誤 (${status}). 已記入 log, 等他們修.`
    }
  }
  // Network errors
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(raw)) return '連不上產品端 (網路問題)'
  if (/ETIMEDOUT|Request timeout/.test(raw)) return '產品端反應太慢 (timeout)'
  if (/EPROTO/.test(raw)) return '連線協議問題 (產品端 HTTPS 設定異常?)'
  // Strip HTML if present
  if (raw.includes('<html') || raw.includes('<body')) {
    return raw.split('<')[0].trim().slice(0, 200) || '產品端回傳了非預期的內容'
  }
  return raw.slice(0, 300)
}
