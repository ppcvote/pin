# Pin × BOS Integration

This doc tracks how Pin (`ppcvote/pin`) wires into UltraBOS — the brand-managing
agent fleet runtime. Both projects share Anthropic's Agent Skills spec; this is
the seam between them.

## Roles (from BOS README)

| | Pin | BOS |
|---|---|---|
| **Audience** | Humans + external agents (Claude Code, Cursor) | Internal brand-managing fleet agents |
| **Primary surface** | Telegram / Discord / LINE / Web + MCP server | Cron-driven agent loops + internal MCP |
| **Tenancy** | Multi-user, channel-isolated | Per-brand, Firebase service account scoped |
| **Source of truth for ops** | n/a — proxies | YES, brands are the canonical thing |

## Contract

BOS exposes operations via MCP, named `bos_<brand>_<op>`. The six v0.1 ops:

```
list_accounts | get_aggregates | growth | health | schedule_post | list_schedules
```

These are stable; v0.1 reference impl returns `NOT_IMPLEMENTED` but the
discovery layer is real, so Pin can wire against the schema today.

## How Pin consumes BOS

Two integration shapes — Pin will support BOTH:

### A. BOS-MCP as a Pin upstream (loose coupling, recommended)

Pin's runtime adds a new SKILL.md spec extension: `metadata.pin.mcp_upstream`
that points at a stdio MCP server.

```yaml
# skills/bos/SKILL.md
metadata:
  pin:
    mcp_upstream:
      command: node
      args: ["C:/Users/User/UltraBOS/apps/mcp-server/dist/server.js"]
      env:
        MT_API_KEY: "${MT_API_KEY}"
    # Pin auto-discovers tools, renders each as a menu action
    label_template: "{tool.description}"
    visibility_rule: primary
```

At boot, Pin spawns the MCP server as a subprocess and queries `tools/list`,
materializing each as a Pin action. Tap a button → Pin invokes the MCP tool →
result rendered in the channel.

**Pros**: BOS owns the schema, Pin doesn't duplicate. Adding a brand to BOS
auto-adds to Pin's menu.

**Cons**: Pin's runtime needs to run as MCP CLIENT (subprocess + JSON-RPC).

### B. SKILL.md mirroring (tighter, manual sync)

Pin maintains a SKILL.md per brand mirroring BOS's tool shape. Each action's
`api` field points at a Pin-side bridge that proxies to BOS MCP.

**Pros**: Simpler implementation, no MCP client needed.

**Cons**: Spec lives twice, drifts on brand additions.

## Status (as of 2026-06-11)

- ✅ Pin v0.1.0 shipped: SKILL.md runtime, TG channel, MCP server, webhook receiver, 2 native skills (mindthread, udhouse)
- ✅ BOS v0.1 MCP server stub shipped with locked TOOL_OPS contract
- 🔲 Pin MCP-client adapter to consume BOS — **next**
- 🔲 BOS reference impls (mindthread first)

## Coordination

- Pin issues / spec questions: ppcvote/pin
- BOS issues: UltraBOS repo (when published)
- Cross-cutting decisions: discussed via @UltraClaudeBot Telegram channel
