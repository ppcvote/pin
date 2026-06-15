/**
 * Turn a fetched page into a link-menu skill proposal, and render an approved
 * proposal into a SKILL.md on disk (PIN_APPLY_SPEC §3).
 *
 * v1 is link-menu-only: the generated skill makes NO call to the applicant's
 * domain at runtime. The single action anchors api.url at Pin's own /ping (to
 * satisfy the executor's 2xx-JSON gate) and renders URL buttons that open in the
 * user's browser. Every button URL is forced same-origin with the applied site.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { stringify as yamlStringify } from 'yaml'
import { generate as llmGenerate } from '../brain/index.js'
import type { PageSignals } from './safeFetch.js'
import type { SkillProposal, ProposedButton, Application } from './applicationStore.js'

export const USER_SKILLS_DIR = join(process.cwd(), 'data', 'user-skills')
const MAX_BUTTONS = 5

/** Strip control chars and collapse whitespace, then cap length. */
function clean(s: string, max: number): string {
  let out = ''
  for (const ch of s) out += (ch.codePointAt(0) ?? 32) < 32 ? ' ' : ch
  return out.replace(/\s+/g, ' ').trim().slice(0, max)
}

function firstEmoji(s: string): string | null {
  const m = s.match(/\p{Extended_Pictographic}/u)
  return m ? m[0] : null
}

/** Force a URL to be a same-origin absolute URL, else null. */
function sameOrigin(url: string, origin: string): string | null {
  try {
    const abs = new URL(url, origin + '/').toString().split('#')[0]
    return abs.startsWith(origin) ? abs : null
  } catch { return null }
}

function slugify(s: string): string {
  const base = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return base.slice(0, 40) || 'app'
}

/** Unique skill id: slug + short random suffix; satisfies the spec name rules. */
export function newSkillId(displayName: string): string {
  const slug = slugify(displayName)
  const suffix = randomBytes(3).toString('hex') // 6 hex chars
  let id = `${slug}-u${suffix}`.replace(/-{2,}/g, '-')
  if (!/^[a-z0-9]/.test(id)) id = 'a' + id
  if (!/[a-z0-9]$/.test(id)) id = id + '0'
  return id.slice(0, 63)
}

function heuristicProposal(sig: PageSignals): SkillProposal {
  const host = sig.origin.replace(/^https?:\/\//, '')
  const display_name = clean(sig.title || host, 40)
  const buttons: ProposedButton[] = [{ label: `🏠 ${display_name}`, url: sig.origin + '/' }]
  for (const l of sig.links) {
    if (buttons.length >= MAX_BUTTONS) break
    if (l.href === sig.origin + '/' || l.href === sig.origin) continue
    const label = clean(l.text || l.href.replace(sig.origin, '').replace(/^\//, '') || '頁面', 24)
    buttons.push({ label, url: l.href })
  }
  return { name: 'placeholder', display_name, icon: '🌐', buttons }
}

/**
 * Propose a menu via the LLM, falling back to a heuristic. Output is always
 * sanitized + same-origin enforced regardless of what the LLM returned.
 */
export async function proposeFromSignals(sig: PageSignals): Promise<SkillProposal> {
  const heuristic = heuristicProposal(sig)
  let proposal = heuristic
  try {
    const prompt = [
      'You design a tiny button menu for a messaging app, from a website.',
      'Return ONLY minified JSON: {"icon":"<one emoji>","display_name":"<=24 chars","buttons":[{"label":"<=24 chars, may start with one emoji","path":"/relative-path"}]}',
      'Rules: 2-5 buttons. Use ONLY paths that appear in the provided links (or "/" for home). Labels in the site\'s own language. No prose, no markdown fences.',
      '',
      `SITE TITLE: ${sig.title || '(none)'}`,
      `DESCRIPTION: ${sig.description || '(none)'}`,
      `ORIGIN: ${sig.origin}`,
      'LINKS:',
      ...sig.links.slice(0, 20).map(l => `  ${l.href.replace(sig.origin, '') || '/'}  — ${l.text || ''}`),
    ].join('\n')
    const raw = await llmGenerate(prompt, { temperature: 0.3, max: 600 })
    const jsonStr = raw.replace(/```json|```/gi, '').trim()
    const start = jsonStr.indexOf('{'); const end = jsonStr.lastIndexOf('}')
    const parsed = JSON.parse(jsonStr.slice(start, end + 1))
    const icon = firstEmoji(String(parsed.icon ?? '')) ?? '🌐'
    const display_name = clean(String(parsed.display_name ?? sig.title ?? ''), 40) || heuristic.display_name
    const buttons: ProposedButton[] = []
    for (const b of Array.isArray(parsed.buttons) ? parsed.buttons : []) {
      if (buttons.length >= MAX_BUTTONS) break
      const url = sameOrigin(String(b.path ?? b.url ?? ''), sig.origin)
      if (!url) continue
      const label = clean(String(b.label ?? ''), 24) || '頁面'
      if (buttons.some(x => x.url === url)) continue
      buttons.push({ label, url })
    }
    if (buttons.length >= 1) proposal = { name: 'placeholder', display_name, icon, buttons }
  } catch (err) {
    console.warn(`[apply] LLM proposal failed, using heuristic: ${(err as Error).message}`)
  }
  // Final hard guarantee: every button same-origin, homepage present.
  proposal.buttons = proposal.buttons
    .map(b => ({ label: b.label, url: sameOrigin(b.url, sig.origin) }))
    .filter((b): b is ProposedButton => b.url !== null)
  if (!proposal.buttons.some(b => b.url === sig.origin + '/')) {
    proposal.buttons.unshift({ label: `🏠 ${proposal.display_name}`, url: sig.origin + '/' })
  }
  proposal.buttons = proposal.buttons.slice(0, MAX_BUTTONS)
  return proposal
}

/** Render an approved application into SKILL.md text (frontmatter + body). */
export function renderSkillMd(app: Application): string {
  const port = process.env.PIN_HTTP_PORT ?? '3000'
  const p = app.proposal
  const fm = {
    name: app.skillId,
    description: `${p.display_name} — link menu published via Pin self-serve apply. Show when the user asks for ${p.display_name}.`,
    license: 'Proprietary (applicant-owned)',
    metadata: {
      pin: {
        version: '1.0',
        icon: p.icon,
        display_name: p.display_name,
        primary_color: '#2DD4BF',
        owner: app.owner,
        actions: [
          {
            id: 'open',
            label: `${p.icon} ${p.display_name}`,
            description: `Open ${p.display_name}`,
            args: [],
            api: { method: 'GET', url: `http://127.0.0.1:${port}/ping` },
            respond: {
              template: `${p.icon} ${p.display_name}\n\n點下面直接開:`,
              follow_up_urls: p.buttons.map(b => ({ label: b.label, url: b.url })),
            },
          },
        ],
      },
    },
  }
  const body = `# ${p.display_name}\n\nLink-menu skill published via Pin self-serve apply (v1). Owner: ${app.owner}. Source: ${app.origin}\n`
  return `---\n${yamlStringify(fm)}---\n\n${body}`
}

/** Write the SKILL.md for an approved application; returns the skill directory. */
export async function writeUserSkill(app: Application): Promise<string> {
  if (!app.skillId) throw new Error('application has no skillId')
  const dir = join(USER_SKILLS_DIR, app.skillId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), renderSkillMd(app), 'utf-8')
  return dir
}
