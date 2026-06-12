# Pin

> Determinism-first consumer runtime for [Anthropic Agent Skills](https://agentskills.io/specification). Drop a `SKILL.md` and your SaaS product gains a button-driven LINE / Telegram interface. By the author of the AVS standard, contributor to Cisco mcp-scanner — built at [Ultra Lab](https://ultralab.tw).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Pin Skill Spec](https://img.shields.io/badge/Pin%20Skill-Spec-2DD4BF)](./PIN_SKILL_SPEC.md)
[![Direction Doc](https://img.shields.io/badge/Direction-Doc-D4AF37)](./PIN_DIRECTION.md)

> **Honest status note:** self-hosting from this repo works today; the hosted/cloud version is still in internal dogfooding and **not open for sign-ups yet**.

## What this is

Pin is a runtime that consumes Anthropic's Agent Skills standard — but optimized for an audience the spec wasn't originally tuned for: **end users on messaging apps in Taiwan and Hong Kong** (LINE-first, then Telegram). Drop a `SKILL.md` into `skills/` and:

- **End users** see button menus on LINE / TG — no typing, no LLM routing, no hallucination risk.
- **AI agents** (Claude Code, Cursor, Hermes) see the same skill as MCP tools.
- **Product backends** push event notifications back to the user's channel via signed webhooks.
- **The skill author** writes one file and gets all four surfaces for free.

The thesis (`PIN_DIRECTION.md`): determinism beats LLM-routing for consumer SaaS UX. Buttons + templates are the main dish; LLM is a fallback, hidden behind an opt-in flag.

## What you can do with it today

Three skills ship live:

| Skill | Status | Wires |
|---|---|---|
| 🧵 **MindThread** | 6 actions, full post wizard (account → formula → topic → preview → ✅ → live Threads post) | https://mindthread.tw |
| 🏠 **UD House** | 7 actions incl. photo-to-listing draft, list + drill leads, AI promo generation | https://social.8338.hk |
| 📈 **UltraGrowth** | 4 actions: monthly summary, recent posts, plan info, lead/report webhooks | mock @ http://localhost:4001 (see `scripts/mock-ug-server.mjs`) |

Plus runtime capabilities:

- **`/menu`** root → tap a skill → tap an action → done.
- **`/card`** — your agent card with skills (weapons), runtime protections (armor), weekly counters (battle record). Spec: `PIN_AGENT_CARD.md`.
- **`/card` 🖼️ 產生分享圖** — 1080×1350 PNG share card. Resvg-based, no Puppeteer. CJK font ships in `assets/fonts/`. Spec: `PIN_AGENT_CARD.md` §2.
- **`/stats`** — per-week button operations, pushes, LLM usage, plus agent-mode decision distribution (execute / clarify / none / blocked / fallback) and 降級率.
- **Webhook push closed loop** — product POSTs `lead.created` → Pin renders → LINE Flex notification with action buttons. Signature mandatory. Failed pushes dead-letter into `data/users/<...>.json#failed_pushes`. Spec: `PIN_DIRECTION.md` §P1 + `WEBHOOK_SPEC_FOR_PRODUCTS.md`.
- **Bind/token deep link** — product backend mints a token via `POST /bind/token`, embeds in `https://line.me/R/oaMessage/@<oa>/?bind%20<token>`. User taps once. Pin binds + replies with skill menu. Spec: `PIN_ONBOARDING.md` §A + `PRODUCT_INTEGRATION.md`.
- **Photo-driven wizards** — user sends a photo to LINE → Pin forwards to product (e.g., UD House `POST /listings/from-photo`) → renders draft → ✅ → committed. Image refs flow as `tmp:<id>` references (data lives in scratch dir, not jsonStore).
- **Agent Mode (opt-in)** — `PIN_AGENT_MODE=true` flips freeform text routing from regex to LLM. LLM picks one registered action + args; deterministic pipeline executes. Three decisions: `execute`, `clarify` (≥2 plausible options → buttons), `none` (chat). Injection scanned by `@ppcvote/prompt-shield` before the LLM is called. `POST/PUT/DELETE` actions get forced preview even if SKILL.md didn't declare one. Spec: `PIN_AGENT_MODE.md`.
- **MCP server** — `npm run mcp` exposes every action as an MCP tool. Drop into Claude Code's `claude_desktop_config.json` and ask "list my recent UD House leads".

## Quick start

```bash
git clone https://github.com/ppcvote/pin.git
cd pin
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN + LINE_* + skill secrets
npm run build
npm start

# In another shell, for the UltraGrowth dogfood pre-UltraLab:
node scripts/mock-ug-server.mjs
```

For LINE you'll also need a public HTTPS endpoint for inbound + image delivery. `cloudflared tunnel --url http://localhost:3000` is what we dogfood on. Set `PIN_PUBLIC_URL` in `.env` to the public tunnel URL.

## Governance docs

Pin is governed by a small stack of authored spec docs. The order of authority:

1. [PIN_DIRECTION.md](./PIN_DIRECTION.md) — strategic constitution. P0–P3 priority, NOT-DO list, 3-month checkpoint.
2. [PIN_SKILL_SPEC.md](./PIN_SKILL_SPEC.md) — `metadata.pin` extension on top of Anthropic Agent Skills.
3. [PIN_ONBOARDING.md](./PIN_ONBOARDING.md) — how users connect; Phase A bind/token, Phase B landing, Phase C 探索.
4. [PIN_AGENT_CARD.md](./PIN_AGENT_CARD.md) — the agent card visualization.
5. [PIN_AGENT_MODE.md](./PIN_AGENT_MODE.md) — when the LLM is allowed to nominate an action.
6. [PIN_FLYWHEEL.md](./PIN_FLYWHEEL.md) — UltraGrowth integration as the 留存 surface of the Ultra Lab flywheel.
7. [WEBHOOK_SPEC_FOR_PRODUCTS.md](./WEBHOOK_SPEC_FOR_PRODUCTS.md) — product backend integration spec.
8. [PRODUCT_INTEGRATION.md](./PRODUCT_INTEGRATION.md) — deep link + bind/token integration spec.
9. [BOS_INTEGRATION.md](./BOS_INTEGRATION.md) — how Pin and UltraBOS relate.

Conflicts resolve in document order, except where a document explicitly says otherwise.

## Project layout

```
src/
├── platform/        SKILL.md spec runtime (loader, executor, menu, registry, template, wizard, binding)
├── channels/        Channel adapters (TG, LINE today; same Channel interface)
├── core/            Channel-agnostic message handling
├── server/          HTTP server for webhooks + image delivery + /bind/token
├── mcp/             Pin MCP server entry point
├── brain/           Gemini / Ollama LLM router + tool compiler + agent mode + shield mount
├── runtime/         Cross-cutting runtime services (deliver, stats, tempStore, flywheelReporter, cardRenderer)
├── storage/         jsonStore + bindTokens
└── bot.ts           Entry — wires channels + HTTP + cron

skills/
├── mindthread/SKILL.md
├── udhouse/SKILL.md
└── ultragrowth/SKILL.md

scripts/
└── mock-ug-server.mjs   Dev mock for UltraGrowth API (FLYWHEEL §1 contract)

assets/fonts/NotoSansTC-Regular.otf   For resvg PNG card rendering

proposals/
└── menu-driven-consumer-execution.md  Draft for agentskills/agentskills discussion
```

## Adding a new product to Pin

1. Create `skills/<your-product>/SKILL.md` with frontmatter (`name`, `description`, `metadata.pin.{icon, primary_color, actions, webhooks}`).
2. Each action declares its `api:` call, args, and `respond.template` (Handlebars-ish). Agent Skills standard `body` prose stays in the markdown body — works in Claude Code or any standard-aware tool unchanged.
3. Restart Pin.

The action shows up in `/menu`, becomes an MCP tool, gets exposed to Agent Mode (when on), and can receive webhooks. Full spec: [PIN_SKILL_SPEC.md](./PIN_SKILL_SPEC.md).

## License

The Pin runtime is [MIT](./LICENSE) — use it, fork it, ship your product on it, commercially or otherwise. No strings.

What we charge for is the **hosted/cloud version** (the n8n model): we run Pin for you — LINE OA, tunnels, webhooks, uptime, upgrades — so your product gets the messaging surface without operating any of it. The hosted version is not open for sign-ups yet (internal dogfooding). Self-hosting from this repo is and stays free.

The spec extensions (`metadata.pin`, see [proposals/](./proposals/)) are gifts back to the Agent Skills community.

---

Built with [Telegraf](https://telegraf.js.org), [`@line/bot-sdk`](https://github.com/line/line-bot-sdk-nodejs), [Anthropic MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [resvg-js](https://github.com/yisibl/resvg-js), [`@ppcvote/prompt-shield`](https://npmjs.com/@ppcvote/prompt-shield), and a lot of late nights.
