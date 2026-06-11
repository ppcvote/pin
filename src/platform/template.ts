/**
 * Tiny Handlebars-compatible template engine for skill responses.
 * Supports: {{path.to.value}}, {{#each arr}}...{{/each}}, {{#each_first N arr}}...{{/each_first}},
 *           {{#if cond}}...{{/if}}, {{@index_1}}, {{sum arr "path.to.field"}}
 * Intentionally tiny — no eval, no general expression parser.
 */

function getPath(obj: any, path: string): any {
  if (!obj || !path) return undefined
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function fmtNumber(n: any): string {
  if (typeof n !== 'number') return String(n ?? '')
  return n.toLocaleString('en-US')
}

function renderBlock(template: string, data: any): string {
  let out = template

  // {{sum array "path"}}  — sum a field across an array
  out = out.replace(/\{\{sum\s+([\w.]+)\s+"([^"]+)"\}\}/g, (_, arrPath: string, field: string) => {
    const arr = getPath(data, arrPath)
    if (!Array.isArray(arr)) return '0'
    const total = arr.reduce((s, item) => s + (Number(getPath(item, field)) || 0), 0)
    return fmtNumber(total)
  })

  // {{#each_first N arr}}...{{/each_first}}
  out = out.replace(
    /\{\{#each_first\s+(\d+)\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each_first\}\}/g,
    (_, nStr: string, arrPath: string, inner: string) => {
      const arr = getPath(data, arrPath)
      if (!Array.isArray(arr)) return ''
      const limit = Math.min(Number(nStr), arr.length)
      const extra = arr.length - limit
      // Expose more_count so templates can show "...N more"
      data.more_count = extra > 0 ? extra : 0
      const lines: string[] = []
      for (let i = 0; i < limit; i++) {
        lines.push(renderItem(inner, arr[i], i, data))
      }
      return lines.join('')
    }
  )

  // {{#each arr}}...{{/each}}
  out = out.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, arrPath: string, inner: string) => {
    const arr = getPath(data, arrPath)
    if (!Array.isArray(arr)) return ''
    return arr.map((item, i) => renderItem(inner, item, i, data)).join('')
  })

  // {{#if path}}...{{/if}}
  out = out.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, path: string, inner: string) => {
    const v = getPath(data, path)
    return v ? renderBlock(inner, data) : ''
  })

  // Simple {{path}} and {{this.foo}}
  out = out.replace(/\{\{([\w.@_]+)\}\}/g, (_, key: string) => {
    if (key === '@index_1') return '' // only valid inside loop scope
    const v = getPath(data, key)
    return v == null ? '' : (typeof v === 'number' ? fmtNumber(v) : String(v))
  })

  return out
}

function renderItem(inner: string, item: any, index: number, parent: any): string {
  // Build per-iteration scope: `this` is the item, parent fields still visible
  const scope = { ...parent, this: item, '@index': index, '@index_1': index + 1 }
  let rendered = inner
  rendered = rendered.replace(/\{\{@index_1\}\}/g, String(index + 1))
  rendered = rendered.replace(/\{\{@index\}\}/g, String(index))
  // {{this.foo.bar}} and {{this}}
  rendered = rendered.replace(/\{\{this\.([\w.]+)\}\}/g, (_, k: string) => {
    const v = getPath(item, k)
    return v == null ? '' : (typeof v === 'number' ? fmtNumber(v) : String(v))
  })
  rendered = rendered.replace(/\{\{this\}\}/g, () => String(item ?? ''))
  // Then run outer-level substitutions for parent refs
  rendered = renderBlock(rendered, scope)
  return rendered
}

export function render(template: string, data: any): string {
  return renderBlock(template, data).trim()
}
