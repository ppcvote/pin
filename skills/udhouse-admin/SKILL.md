---
name: udhouse-admin
description: |
  UDomain 平台管理員視角 — 跨房仲的平台總覽、所有物件、所有 leads/需求、房仲名冊。
  Use when the user mentions 平台總覽, 平台管理, admin, 跨房仲, 房仲名冊, 全平台.
  與房仲操作工具 (udhouse skill) 分開：這是「管理員身分」入口。
license: Proprietary (Ultra Lab × UDomain)
compatibility: Requires UDH_API_KEY whose uid is on the UDH admin allowlist (UDH_ADMIN_UIDS). Non-admin keys get 403.
metadata:
  pin:
    version: "1.0"
    icon: 🛠
    primary_color: "#7C3AED"
    requires_admin: true
    # 不在根選單單獨露出；由 admin-hub（管理後台）的「UD House 後台」入口進來，
    # 跟其他產品一致。仍可用 s:udhouse-admin 開。
    hide_from_root: true
    secrets:
      - UDH_API_KEY
      - UDH_BASE_URL
    actions:
      # 平台管理員 (B-role) — allowlist-gated by UDH_ADMIN_UIDS on the UDH side.
      # Non-admin key → 403 → Pin's sanitizeError shows「產品端拒絕了這個請求 (403)」.
      - id: admin_stats
        label: 平台總覽 📊
        description: Platform-wide stats — realtors, listings, leads, demands. UDomain operator only.
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/admin/stats"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            📊 UD House 平台總覽
            ━━━━━━━━━━━━━━━━━
            👥 房仲: {{data.realtors}}
            🏠 物件總數: {{data.listings_total}}
               · active   {{data.by_status.active}}
               · pending  {{data.by_status.pending}}
               · signed   {{data.by_status.signed}}
               · draft    {{data.by_status.draft}}
            📥 今日新增物件: {{data.listings_today}}
            🔥 Leads: {{data.leads_total}} (今日 {{data.leads_today}})
            📝 需求登記: {{data.demands_total}}

      - id: admin_listings
        label: 所有物件 (跨房仲)
        description: Cross-realtor listings index. UDomain operator only.
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/admin/listings"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            🏠 全平台 {{data.count}} 個物件 — 最新 5 個:
            {{#each_first data.listings 5}}
            · {{this.title}} · {{this.district}} · {{this.status}} (by {{this.owner_name}})
            {{/each_first}}

      - id: admin_leads
        label: 所有 leads + 需求
        description: Cross-realtor leads + demand registrations. UDomain operator only.
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/admin/leads"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            🔥 平台 leads {{data.leads_count}} + 需求 {{data.demands_count}}

            最新 5 leads:
            {{#each_first data.leads 5}}
            · {{this.name}} → {{this.listing_title}} (熱度 {{this.temperature}})
            {{/each_first}}

            最新 3 需求:
            {{#each_first data.demands 3}}
            · {{this.district}} · {{this.bedrooms}}房 · 預算 HK${{this.budget}} · {{this.contact}}
            {{/each_first}}

      - id: admin_agents
        label: 房仲名冊
        description: Roster of all realtors + their listing counts. UDomain operator only.
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/admin/agents"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            👥 {{data.count}} 個房仲:
            {{#each data.agents}}
            · {{this.name}} ({{this.listings_count}} 物件){{#if this.pin_linked}} 📱{{/if}}
            {{/each}}
---

# Skill instructions (for LLM agents)

UD House 管理員視角 —— UDomain 平台營運者用的跨房仲後台。與房仲操作工具
（`udhouse` skill）刻意分開，讓「管理員身分」和「房仲身分」在 Pin 主選單上
是兩個清楚分開的入口。

- `/api/v1/admin/stats` — 全平台統計（房仲數、物件數、leads、需求）
- `/api/v1/admin/listings` — 跨房仲物件索引
- `/api/v1/admin/leads` — 跨房仲 leads + 需求登記
- `/api/v1/admin/agents` — 房仲名冊 + 各自物件數

全部 allowlist-gated（UDH_ADMIN_UIDS）。非 admin key 呼叫一律 403。
