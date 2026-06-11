#!/usr/bin/env node
/**
 * Pin MCP Server
 *
 * Exposes every loaded SKILL.md action as an MCP tool.
 * Any MCP-compatible agent (Claude Code, Cursor, Hermes, etc.) can connect
 * and use ALL Pin-registered Ultra Lab products through a single endpoint.
 *
 * Usage (stdio):
 *   node dist/mcp/server.js
 *
 * Claude Code config:
 *   {
 *     "mcpServers": {
 *       "pin": {
 *         "command": "node",
 *         "args": ["C:/Users/User/UltraPin/dist/mcp/server.js"],
 *         "env": { "MT_API_KEY": "...", "UDH_API_KEY": "...", ... }
 *       }
 *     }
 *   }
 */

import 'dotenv/config'
import dns from 'node:dns'
dns.setDefaultResultOrder('ipv4first')

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { bootRegistry, allSkills } from '../platform/registry.js'
import { executeAction } from '../platform/actionExecutor.js'
import type { ArgSpec } from '../platform/types.js'

// Load skills before registering
bootRegistry()

const server = new McpServer({
  name: 'pin',
  version: '0.1.0',
})

function argsToZod(argSpecs: ArgSpec[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const a of argSpecs) {
    let s: z.ZodTypeAny
    if (a.type === 'number') s = z.number()
    else s = z.string()
    s = s.describe(a.label ?? a.name)
    shape[a.name] = s
  }
  return shape
}

function summarizeResult(result: { ok: boolean; rendered?: string; raw?: any; error?: string }): string {
  if (!result.ok) return `Error: ${result.error ?? 'unknown'}`
  if (result.rendered) return result.rendered
  if (result.raw) return typeof result.raw === 'string' ? result.raw : JSON.stringify(result.raw, null, 2)
  return 'OK (no output)'
}

let toolCount = 0
for (const skill of allSkills()) {
  if (!skill.pin) continue
  for (const action of skill.pin.actions) {
    const toolName = `pin_${skill.id}_${action.id}`
    const description = `${skill.name}: ${action.description ?? action.label}`
    const inputSchema = argsToZod(action.args)

    server.tool(
      toolName,
      description,
      inputSchema,
      async (args: Record<string, any>) => {
        const result = await executeAction(skill, action, args)
        return {
          content: [{ type: 'text', text: summarizeResult(result) }],
        }
      }
    )
    toolCount++
  }
}

// Also register a meta-tool that lists all skills (for agent discoverability)
server.tool(
  'pin_list_skills',
  'List all Ultra Lab products available through Pin, with their actions.',
  {},
  async () => {
    const skills = allSkills()
    const out = skills.map(s => {
      const acts = (s.pin?.actions ?? []).map(a => `  · ${a.id} — ${a.label}`).join('\n')
      return `${s.pin?.icon ?? '•'} **${s.name}** — ${s.description}\n${acts}`
    }).join('\n\n')
    return { content: [{ type: 'text', text: `Pin (${skills.length} skills):\n\n${out}` }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[pin-mcp] online · ${toolCount} action tools + 1 meta tool`)
