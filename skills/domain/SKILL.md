---
name: domain
description: |
  Check domain-name availability, compare prices across TLDs, and register
  domains through a swappable registrar provider (Cloudflare first; UDomain
  /.hk rail later). Use when the user wants to 買域名/查域名/註冊網域,
  check whether a domain is free, or compare domain prices. Registration
  moves real money and ALWAYS goes through the Pin human confirm key —
  preview first, nothing is charged until the user taps ✅.
license: Proprietary (Ultra Lab)
compatibility: Requires DOMAIN_BASE_URL + DOMAIN_API_KEY (domain-server, `npm run domain`) and network access
metadata:
  pin:
    version: "1.0"
    icon: 🌐
    primary_color: "#F6821F"
    secrets:
      - DOMAIN_API_KEY
      - DOMAIN_BASE_URL
    actions:
      - id: check_domain
        label: 🔍 查域名能不能買
        description: Check whether one specific domain is available to register, with its price
        args:
          - name: domain
            label: 想查的域名
            type: string
            input: text
            placeholder: 完整域名, 例如 ultracafe.com
        api:
          method: GET
          url: "{DOMAIN_BASE_URL}/api/v1/availability"
          auth: bearer:DOMAIN_API_KEY
          query:
            domain: "{domain}"
        respond:
          template: |
            {{#if data.available}}✅ {{data.domain}} 可以註冊
            💵 {{data.price_line}}
            {{#if data.premium}}⭐ Premium 域名 — 價格高於一般行情{{/if}}
            🏪 上游: {{data.provider}}{{/if}}
            {{#if data.taken}}❌ {{data.domain}} 已被註冊

            可以用「💰 比價」看同名字其他後綴有沒有空位。{{/if}}
          follow_up_actions:
            - action: compare_prices
              label: 💰 比價其他後綴
            - action: register_domain
              label: 🛒 註冊域名

      - id: compare_prices
        label: 💰 比價
        description: Compare availability and price of one name across common TLDs (.com/.net/.org/.io/.dev/.app/.ai)
        args:
          - name: name
            label: 想比價的名字
            type: string
            input: text
            placeholder: 名字就好, 不用後綴, 例如 ultracafe
        api:
          method: GET
          url: "{DOMAIN_BASE_URL}/api/v1/quote"
          auth: bearer:DOMAIN_API_KEY
          query:
            name: "{name}"
        respond:
          template: |
            💰 {{data.name}} 各後綴比價 (上游: {{data.provider}}):

            {{#each data.quotes}}{{this.icon}} {{this.domain}} — {{this.price_line}}
            {{/each}}
          follow_up_actions:
            - action: register_domain
              label: 🛒 註冊域名

      - id: register_domain
        label: 🛒 註冊域名
        description: Register a domain — fetches a binding quote first, then REQUIRES the human ✅ confirm key before any money moves
        args:
          - name: domain
            label: 要註冊的域名
            type: string
            input: text
            placeholder: 完整域名, 例如 ultracafe.com
          - name: years
            label: 註冊幾年
            type: enum
            options:
              - value: "1"
                label: 1 年
              - value: "2"
                label: 2 年
              - value: "5"
                label: 5 年
        api:
          method: GET
          url: "{DOMAIN_BASE_URL}/api/v1/quote"
          auth: bearer:DOMAIN_API_KEY
          query:
            domain: "{domain}"
            years: "{years}"
        preview:
          template: |
            {{#if data.taken}}❌ {{data.domain}} 已被註冊, 換一個名字再試。
            (按取消結束){{/if}}
            {{#if data.available}}🛒 註冊預覽 — 這一步還沒花錢

            🌐 {{data.domain}}
            💵 總價 {{data.total_line}}, 之後續約 {{data.renew_line}}
            {{#if data.premium}}⭐ Premium 域名 — 請確認價格再按{{/if}}
            {{#if data.sandbox}}🧪 沙盒模式 — 按確認也只會模擬下單, 不會扣款{{/if}}
            🏪 上游: {{data.provider}} · 報價 10 分鐘內有效

            按「✅ 確認發」才會真的下單 — 這顆就是人類確認鍵, 沒按就不花錢。{{/if}}
          confirm_action: register_confirmed
          content_path: "data.confirm_token"

      # The ONLY action that moves real money. visibility: hidden keeps it
      # out of menus, MCP tools, and Agent Mode — it is reachable solely as
      # register_domain's confirm_action (the wizard's ✅ button), and the
      # server additionally demands the one-time confirm_token minted by the
      # quote the user just previewed. No tapped key → no token → no charge.
      - id: register_confirmed
        label: 確認註冊
        visibility: hidden
        description: Execute a previously previewed-and-confirmed domain registration (internal — never call directly)
        args:
          - name: domain
            type: string
          - name: years
            type: string
          - name: content
            type: string
        api:
          method: POST
          url: "{DOMAIN_BASE_URL}/api/v1/register"
          auth: bearer:DOMAIN_API_KEY
          body:
            domain: "{domain}"
            years: "{years}"
            confirm_token: "{content}"
            confirmed: true
        respond:
          template: |
            {{#if data.registered}}🎉 {{data.domain}} 註冊成功!
            🧾 訂單: {{data.order_id}} · {{data.total_line}}
            🏪 上游: {{data.provider}}{{/if}}
            {{#if data.sandbox}}🧪 沙盒下單完成 (沒有扣款)
            🌐 {{data.domain}} · {{data.total_line}}
            🧾 模擬訂單: {{data.order_id}}

            要開真實註冊: 在 domain-server 設 DOMAIN_ALLOW_REAL_REGISTRATION=1{{/if}}
---

# Domain skill (GENESIS P0 — agent buys infrastructure, human holds the key)

Check availability, compare prices, and register domains. This skill is the
first rung of the Genesis chain (domain → site → social → AVS → steward →
managed service): the moment a business is born.

## Design trade-offs (per GENESIS_BLUEPRINT §1 P0)

- **Upstream is swappable.** This skill never talks to a registrar directly;
  it talks to `scripts/domain-server.mjs`, whose `DomainProvider` contract
  (`availability` / `register`) isolates the upstream. Cloudflare is the
  first provider (Registrar at cost price, API-first); a `mock` provider
  ships for sandbox dogfooding; UDomain (.hk/.tw rail, P2) and Porkbun slot
  in behind the same contract without touching this file.
- **Real money always crosses the human key.** `register_domain` only fetches
  a quote (free) and renders a preview; the charging action
  (`register_confirmed`) is `visibility: hidden` — absent from menus, MCP,
  and Agent Mode — and the server demands a one-time `confirm_token` minted
  by that exact previewed quote (domain + years bound, 10-min TTL). On top,
  the server boots in sandbox mode: real charging requires an operator to
  set `DOMAIN_ALLOW_REAL_REGISTRATION=1`. 沒按鍵不花錢, 無例外.
- **Cloudflare can't do .hk/.tw.** That gap is deliberate scope: the Chinese-
  market rail belongs to the UDomain provider (GENESIS P1/P2). This skill's
  UX learnings (quote → preview → key) carry over unchanged.

## UX observations to feed back (P0 goal: agent-buys-domain intel)

- Follow-up buttons re-ask for the domain instead of carrying it from the
  previous answer (runtime pre-seeds callback args but the wizard still
  prompts each arg). Worth a runtime improvement before P3's one-sentence
  genesis flow.

## For LLM agents loading this skill

Call the domain-server API directly: `GET /api/v1/availability?domain=`,
`GET /api/v1/quote?name=` (compare) or `?domain=&years=` (binding quote).
You may quote freely. You can NOT complete a registration yourself: POST
`/api/v1/register` requires a `confirm_token` from a quote that a human has
reviewed and confirmed through Pin's ✅ key. Propose; the human disposes.
