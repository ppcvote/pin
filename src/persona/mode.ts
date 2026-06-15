/**
 * PIN_PERSONA §1 — Persona mode resolver.
 *
 * Pure function: deterministic, no I/O, fully unit-testable.
 *
 * Two modes:
 *   serious  — preview/confirm actions, mutations (POST/PUT/DELETE), numeric/client data
 *   friendly — read-only queries, morning list, task-complete endings, idle moments
 *
 * This is a program-layer rule, NOT a prompt heuristic. The mode is resolved
 * from concrete contextual signals (HTTP method, action flags, content patterns)
 * so the caller knows what tone to use before generating any text.
 */

export type PersonaMode = 'serious' | 'friendly'

export interface ModeContext {
  /** Action declares a preview/confirm gate (mutation requiring user approval). */
  hasPreviewConfirm?: boolean
  /** HTTP method of the triggered action API call. */
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Rendered output contains numeric data (prices, counts, customer IDs). */
  hasNumericData?: boolean
  /** Context explicitly involves customer / client records. */
  hasCustomerData?: boolean
  /** Caller explicitly overrides (e.g. morning greeting forces friendly). */
  forceMode?: PersonaMode
  /** UD enterprise white-label: serious mode weight is slightly higher (env-configurable). */
  udEnterpriseWeight?: boolean
}

/**
 * Resolve persona mode from context.
 *
 * Serious triggers (any one is sufficient):
 *   - hasPreviewConfirm  — user must approve before action executes
 *   - httpMethod !== GET — write action (create / update / delete)
 *   - hasNumericData     — reply contains real figures (prices, counts, dates)
 *   - hasCustomerData    — reply involves client / customer records
 *
 * Friendly otherwise (read-only, idle, morning, task-done).
 */
export function resolveMode(ctx: ModeContext): PersonaMode {
  if (ctx.forceMode) return ctx.forceMode
  if (ctx.hasPreviewConfirm) return 'serious'
  if (ctx.httpMethod && ctx.httpMethod !== 'GET') return 'serious'
  if (ctx.hasNumericData) return 'serious'
  if (ctx.hasCustomerData) return 'serious'
  return 'friendly'
}

/**
 * Heuristic: does this rendered text contain numeric data that warrants serious mode?
 * Matches: NT$ prices, ISO dates, counts with CJK measure words, percentages.
 */
export function textHasNumericData(text: string): boolean {
  return /NT\$\d+|HK\$\d+|\d{4}-\d{2}-\d{2}|\d+\s*[個件筆條%折]/.test(text)
}

/**
 * Derive ModeContext from an action's API spec and its rendered output.
 * Convenience helper for handle.ts / actionExecutor.ts call sites.
 */
export function contextFromAction(opts: {
  hasPreview: boolean
  httpMethod?: string
  renderedText?: string
}): ModeContext {
  return {
    hasPreviewConfirm: opts.hasPreview,
    httpMethod: opts.httpMethod as ModeContext['httpMethod'],
    hasNumericData: opts.renderedText ? textHasNumericData(opts.renderedText) : false,
  }
}
