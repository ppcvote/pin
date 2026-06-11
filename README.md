# Pin

> The open consumer + agent runtime for [Anthropic Agent Skills](https://agentskills.io/specification).
> Built by [Ultra Lab](https://ultralab.tw).

Pin is a channel-agnostic skill runtime + MCP server. Drop a `SKILL.md` into `skills/` and the same capability becomes instantly available to:

- **End users** on Telegram, Discord, LINE, WhatsApp, Web (button menus, no typing)
- **AI agents** (Claude Code, Cursor, Hermes, Goose) via the Model Context Protocol
- **Other services** via inbound webhooks → push notifications back to the user

The same `SKILL.md` works in **stock Anthropic Agent Skills tools** AND in Pin (which adds menu rendering, action execution, webhook routing on top — see [`PIN_SKILL_SPEC.md`](./PIN_SKILL_SPEC.md)).

## Why

Most chatbot platforms force users into their app and lock skills to their stack. The 2025 AAIF (Anthropic + OpenAI + Block, Linux Foundation) already standardized the skill format — but no one shipped a **consumer-grade runtime** for it.

Pin is that runtime. Optimized for: **predictable menus over LLM guessing, multi-channel by default, drop-in product integrations**.

## Status

Alpha. Dogfooded daily by Min Yi (founder, Ultra Lab) across his portfolio: MindThread (700+ Threads accounts), UD House (HK realtor platform), more landing.

## Architecture

```
                        ┌──────────────────────┐
            humans  ──→ │ TG / Discord / LINE  │ ─→
            agents  ──→ │ MCP server (stdio)   │ ─→
            services──→ │ Webhook server :3000 │ ─→  Pin Core ── ─→ Skills/*/SKILL.md
                        └──────────────────────┘
```

## Quick start

```bash
git clone https://github.com/ppcvote/pin.git
cd pin
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN + skill secrets
npm run build

# As a Telegram bot (channel mode)
npm start

# As an MCP server (agent mode — for Claude Code / Cursor)
npm run mcp
```

## Project structure

```
src/
├── platform/    SKILL.md spec runtime (loader, executor, menu, registry)
├── channels/    Channel adapters (TG today, more on the way)
├── core/        Channel-agnostic message handling
├── server/      HTTP server for webhooks
├── mcp/         Pin MCP server entry point
├── brain/       Optional Gemini / Ollama LLM router (for freeform fallback)
└── bot.ts       Main entry — wires everything together

skills/
├── mindthread/SKILL.md   Threads automation product
└── udhouse/SKILL.md      HK real-estate product
```

## Adding a new product to Pin

1. Create `skills/<your-product>/SKILL.md`
2. Declare actions under `metadata.pin.actions` (HTTP endpoints, args, response templates)
3. (Optional) Declare `metadata.pin.webhooks` for push notifications
4. Restart Pin

The skill instantly appears in `/menu`, becomes an MCP tool, and can receive webhooks. Full spec: [`PIN_SKILL_SPEC.md`](./PIN_SKILL_SPEC.md).

## License

Source-available, Pin-Personal license — free for personal use, contact for commercial.

---

Built with [Telegraf](https://telegraf.js.org), [Anthropic MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), and a lot of late nights.
