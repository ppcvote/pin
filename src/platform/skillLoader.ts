import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Skill, PinExtension } from './types.js'

const SKILLS_DIR = join(process.cwd(), 'skills')

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface ParsedFrontmatter {
  name?: string
  description?: string
  license?: string
  compatibility?: string
  metadata?: Record<string, any>
}

function parseSkillFile(content: string): { fm: ParsedFrontmatter; body: string } {
  // Tolerate a UTF-8 BOM — Windows editors prepend U+FEFF, which would
  // otherwise make the frontmatter regex reject a perfectly valid file.
  // (The regex below contains the literal invisible U+FEFF character.)
  const m = content.replace(/^﻿/, '').match(FRONTMATTER_RE)
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---')
  const fm = parseYaml(m[1]) as ParsedFrontmatter
  const body = m[2] ?? ''
  return { fm, body }
}

function validateSkill(skill: Skill, fm: ParsedFrontmatter, skillDir: string): string[] {
  const errs: string[] = []
  if (!skill.name) errs.push('frontmatter.name missing')
  if (skill.name && !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(skill.name) && skill.name.length > 1) {
    errs.push(`frontmatter.name "${skill.name}" violates naming rules`)
  }
  // Spec parity with skills-ref: no consecutive hyphens; name must match the
  // parent directory name (NFKC-normalized comparison, matching the
  // reference validator's behavior).
  if (skill.name?.includes('--')) errs.push(`frontmatter.name "${skill.name}" contains consecutive hyphens`)
  if (skill.name && skill.name.normalize('NFKC') !== skillDir.normalize('NFKC')) {
    errs.push(`frontmatter.name "${skill.name}" must match directory name "${skillDir}"`)
  }
  if (!skill.description) errs.push('frontmatter.description missing')
  if (skill.description && skill.description.length > 1024) errs.push('description exceeds 1024 chars')
  if (fm.compatibility && fm.compatibility.length > 500) errs.push('compatibility exceeds 500 chars')

  if (skill.pin) {
    if (!skill.pin.actions || !Array.isArray(skill.pin.actions) || skill.pin.actions.length === 0) {
      errs.push('metadata.pin.actions must be a non-empty array')
    } else {
      const seen = new Set<string>()
      for (const a of skill.pin.actions) {
        if (!a.id) errs.push('action missing id')
        if (a.id && seen.has(a.id)) errs.push(`duplicate action id "${a.id}"`)
        if (a.id) seen.add(a.id)
        if (!a.label) errs.push(`action ${a.id} missing label`)
        if (!a.api && !a.script && !a.handler) errs.push(`action ${a.id} must define api/script/handler`)
      }
    }
  }
  return errs
}

export function loadSkill(skillDir: string): Skill {
  const skillPath = join(SKILLS_DIR, skillDir)
  const skillFile = join(skillPath, 'SKILL.md')
  if (!existsSync(skillFile)) throw new Error(`SKILL.md not found at ${skillFile}`)

  const raw = readFileSync(skillFile, 'utf-8')
  const { fm, body } = parseSkillFile(raw)

  const pinExt: PinExtension | undefined = fm.metadata?.pin
    ? {
        version: String(fm.metadata.pin.version ?? '1.0'),
        icon: fm.metadata.pin.icon,
        primary_color: fm.metadata.pin.primary_color,
        secrets: fm.metadata.pin.secrets ?? [],
        connect_url: fm.metadata.pin.connect_url,
        webhooks: (fm.metadata.pin.webhooks ?? []).map((w: any) => ({
          event: w.event,
          secret: w.secret,
          notify: w.notify,
        })),
        actions: (fm.metadata.pin.actions ?? []).map((a: any) => ({
          id: a.id,
          label: a.label,
          description: a.description,
          visibility: a.visibility,
          args: (a.args ?? []).map((x: any) => ({
            name: x.name,
            label: x.label,
            type: x.type,
            options: x.options,
            from_action: x.from_action,
            from_path: x.from_path,
            select_key: x.select_key,
            display_key: x.display_key,
            input: x.input,
            placeholder: x.placeholder,
          })),
          api: a.api,
          script: a.script,
          handler: a.handler,
          respond: a.respond,
          preview: a.preview ? {
            template: a.preview.template,
            confirm_action: a.preview.confirm_action,
            content_path: a.preview.content_path,
          } : undefined,
          gated_by: a.gated_by,
        })),
      }
    : undefined

  // Auto-derive visibility: explicit author setting wins; otherwise infer
  if (pinExt) {
    const referencedAsCallback = new Set<string>()
    for (const a of pinExt.actions) {
      if (a.respond?.choices?.callback_action) referencedAsCallback.add(a.respond.choices.callback_action)
      if (a.preview?.confirm_action) referencedAsCallback.add(a.preview.confirm_action)
    }
    for (const a of pinExt.actions) {
      if (a.visibility) continue
      // Referenced by another action as a target → only callable via that callback
      if (referencedAsCallback.has(a.id)) { a.visibility = 'callback_only'; continue }
      // Has args but no way to collect them via UI → can't be invoked from menu
      const hasArgs = (a.args?.length ?? 0) > 0
      const collectable = (a.args ?? []).some(arg => arg.from_action || arg.input)
      if (hasArgs && !collectable) { a.visibility = 'callback_only'; continue }
      a.visibility = 'primary'
    }
  }

  const skill: Skill = {
    id: skillDir,
    rootPath: skillPath,
    name: fm.name ?? skillDir,
    description: fm.description ?? '',
    body: body.trim(),
    pin: pinExt,
  }

  const errs = validateSkill(skill, fm, skillDir)
  if (errs.length > 0) {
    throw new Error(`Invalid skill ${skillDir}:\n  - ${errs.join('\n  - ')}`)
  }
  return skill
}

export function loadAllSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return []
  const entries = readdirSync(SKILLS_DIR)
  const out: Skill[] = []
  for (const e of entries) {
    if (!statSync(join(SKILLS_DIR, e)).isDirectory()) continue
    try {
      out.push(loadSkill(e))
    } catch (err) {
      console.error(`[skillLoader] failed to load ${e}: ${(err as Error).message}`)
    }
  }
  return out
}
