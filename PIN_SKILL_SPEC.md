# Pin Skill Spec (v0.1)

Pin is a menu-driven runtime for [Agent Skills](https://agentskills.io/specification). Any standard Anthropic Agent Skill is loadable by Pin; Pin extends the spec with `metadata.pin` to add menu rendering + structured actions so end-users on Telegram / Discord / LINE / WhatsApp etc. can tap their way through capabilities without typing.

## Compatibility

- **Forward**: Any Agent Skill (just `name` + `description`) is loadable. Pin will offer it as a single-button entry that asks the user to type a request, and route to an optional LLM brain.
- **Native**: Skills that declare `metadata.pin.actions` get auto-generated inline-keyboard menus and structured action execution (no LLM needed for routing or argument extraction).

## Frontmatter extension

In addition to Anthropic's required fields (`name`, `description`), Pin reads:

```yaml
metadata:
  pin:
    version: "1.0"                # Pin extension version
    icon: 🧵                       # Emoji shown in menus (single grapheme)
    primary_color: "#6366F1"      # Optional brand color (hex)
    secrets:                       # Environment variables required to run
      - MT_API_KEY
      - MT_BASE_URL
    actions:                       # Each becomes an inline button
      - id: list_accounts          # Stable id (used in callback data)
        label: 看所有帳號           # Shown to user (max 40 chars)
        description: List all connected accounts with stats
        args: []                   # No user input required
        api:
          method: GET
          url: "{MT_BASE_URL}/api/v1/accounts"
          auth: bearer:MT_API_KEY
        respond:
          template: |
            🧵 帳號 ({{data.accounts.length}}):
            {{#each data.accounts}}
            {{@index_1}}. {{this.threads_username}} — 👥{{this.stats.followers}}
            {{/each}}
```

## Action fields

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | Yes | Stable identifier. Used as callback data. Snake_case. |
| `label` | Yes | User-facing button text. ≤40 chars. Localized: `label_zh`, `label_en` |
| `description` | No | Tooltip / LLM hint |
| `visibility` | No | Menu layout hint. Auto-derived if omitted (see below) |
| `args` | No | List of `ArgSpec`. Empty array = zero-input action. |
| `api` | One of `api` / `script` / `handler` | HTTP call to execute |
| `script` | … | Run a script from `scripts/` (Agent Skills standard path) |
| `handler` | … | Call a TypeScript handler exported from `handler.ts` (Pin-native) |
| `respond` | No | How to render API response back to user |
| `preview` | No | `{template, confirm_action}` — show preview then confirm to fire another action |
| `gated_by` | No | List of prior action ids that must be tapped first |

### `visibility` values

| Value | UI behavior |
|-------|-------------|
| `primary` (default) | Full-width button, one per row at top of skill menu |
| `secondary` | Compact button, packed 2 per row at bottom of skill menu |
| `callback_only` | Hidden from menus — only callable via another action's choices / preview |
| `hidden` | Completely hidden — not in menus nor exposed via MCP |

### Auto-derivation rules

If `visibility` is omitted, Pin infers it:

1. Referenced as another action's `respond.choices.callback_action` → `callback_only`
2. Referenced as another action's `preview.confirm_action` → `callback_only`
3. Has `args` but no arg is collectable from UI (no `from_action`, no `input`) → `callback_only`
4. Otherwise → `primary`

This means most skill authors can omit `visibility` entirely. Override only when a no-arg action is diagnostic (`secondary`) or experimental (`hidden`).

### `ArgSpec`

```yaml
args:
  - name: account_id
    label: 選帳號
    type: string                  # string | number | enum
    from_action: list_accounts    # Reuse prior action's output as choices
    select_key: id                # Field on prior output to use as value
    display_key: threads_username # Field shown in button
  - name: topic
    label: 想寫什麼
    type: string
    input: text                   # Prompt user to type free text
    placeholder: 例如 "今天的市場"
```

When an action has `args`, Pin walks the user through them as a wizard (one prompt at a time, with back/cancel buttons).

### `api` spec

```yaml
api:
  method: GET | POST | PUT | DELETE
  url: "{ENV_VAR}/path/{arg_name}"   # ENV refs use {VAR}, arg refs use {arg}
  auth: bearer:SECRET_NAME            # secret looked up from env
  body:                                # for POST/PUT
    field1: "{arg1}"
    field2: "literal value"
  query:
    page: "{page}"
```

Pin's executor:
1. Resolves env vars from process.env
2. Resolves args from collected wizard inputs
3. Makes HTTP call via Pin's hardened HTTP layer (handles IPv4 fallback, no keep-alive — see learnings)
4. Parses JSON response
5. Renders via `respond.template` (Handlebars-ish) OR returns raw to LLM if no template

## Response rendering

Two modes:

1. **Template** (no LLM, instant): Handlebars-style template. Supported helpers: `each`, `index_1` (1-based index), `slice`, `if`, `unless`.
2. **LLM summarize** (slow but flexible): Pass the JSON to LLM with `respond.summarize_with: "Show top 5 accounts ranked by follower count"`.

Most skills should use templates. LLM summarize is fallback when output shape is unpredictable.

## Multi-channel

Pin executor is channel-agnostic. Each channel adapter (`channels/telegram.ts`, `channels/discord.ts`, …) implements:

```ts
interface Channel {
  name: string
  sendText(userId: string, text: string): Promise<void>
  sendMenu(userId: string, title: string, buttons: Button[]): Promise<void>
  promptText(userId: string, prompt: string): Promise<string>
  promptChoice(userId: string, prompt: string, choices: Button[]): Promise<string>
}
```

A skill execution is channel-agnostic — Pin core works on the channel abstraction.

## Loading skills

Pin reads from:

1. **Bundled skills**: `./skills/*/SKILL.md` (shipped with Pin)
2. **User-installed**: `./data/users/<chat_id>/skills/*/SKILL.md` (Pin marketplace, future)
3. **Remote registries**: pulled by name from `pin.skills.io` (future)

At boot Pin parses all SKILL.md, validates frontmatter, registers actions, and seeds the main `/menu`.

## Forward compatibility with Agent Skills standard

Pin never modifies fields outside `metadata.pin`. The same SKILL.md can be:

- Loaded into Claude Code / Cursor / Hermes Agent (they read the prose body + ignore `metadata.pin`)
- Loaded into Pin (it auto-renders menus + uses structured actions)

Skill authors can choose to provide ONLY the prose body (LLM-only execution) OR add `metadata.pin.actions` for menu-driven UX.
