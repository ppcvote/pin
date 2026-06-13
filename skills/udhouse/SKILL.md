---
name: udhouse
description: |
  Query the user's UD House real-estate platform (HK property listings + leads).
  Use when the user mentions UD House, UDH, 物件, 樓盤, 房仲, lead, or 詢問.
license: Proprietary (Ultra Lab × UDomain)
compatibility: Requires UDH_API_KEY (udh_live_xxx) and network access to social.8338.hk
metadata:
  pin:
    version: "1.0"
    icon: 🏠
    primary_color: "#0EA5E9"
    secrets:
      - UDH_API_KEY
      - UDH_BASE_URL
    webhooks:
      - event: lead.created
        secret: UDH_WEBHOOK_SECRET
        notify:
          template: |
            🔥 新 lead!
            👤 {{data.lead.name}} ({{data.lead.phone}})
            🏠 看的是: {{data.lead.listing_title}}
            🌡️ 熱度: {{data.lead.temperature}}/10
          buttons:
            - label: 看物件詳細
              action: get_listing
              args:
                listing_id: "{{data.lead.listing_id}}"
            - label: 開分享頁
              url: "{{data.lead.share_url}}"

      - event: listing.status_changed
        secret: UDH_WEBHOOK_SECRET
        notify:
          template: "🔖 物件「{{data.listing.title}}」狀態改為 {{data.listing.status}}"
          buttons:
            - label: 看詳細
              action: get_listing
              args:
                listing_id: "{{data.listing.id}}"
    actions:
      - id: whoami
        label: 看身份
        visibility: secondary
        description: Show realtor identity (tenant, uid)
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/me"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            🏠 UD House identity
            Product: {{response.product}}
            Tenant: {{response.tenant_id}}
            UID: {{response.uid}}

      - id: create_from_photo
        label: 📸 傳照片建物件
        description: Send a property photo; AI analyses it, returns a listing draft, you confirm to publish.
        args:
          - name: image
            label: 物件照片
            type: image
            input: attachment
            placeholder: 拍一張物件主圖, 或從相簿選
        api:
          method: POST
          url: "{UDH_BASE_URL}/api/v1/listings/from-photo"
          auth: bearer:UDH_API_KEY
          body:
            image: "{image}"
        preview:
          template: |
            ✨ AI 從照片產出的物件草稿:

            📝 標題: {{response.suggested.suggested_title}}
            🏠 類型: {{response.suggested.estimated_type}}
            📍 區域: {{response.suggested.estimated_district}}
            🛏 {{response.suggested.estimated_bedrooms}} 房 {{response.suggested.estimated_bathrooms}} 衛
            📐 {{response.suggested.estimated_sqft}} sqft
            🪟 陽台: {{response.suggested.has_balcony}}
            🎯 信心度: {{response.suggested.confidence}}

            想建立這個物件嗎?
          confirm_action: confirm_create_from_photo
          content_path: "response"

      - id: confirm_create_from_photo
        label: 從 photo draft 建物件
        description: Internal — invoked by create_from_photo's preview-confirm
        args:
          - name: account_id
            type: string
          - name: content
            type: string
        api:
          method: POST
          url: "{UDH_BASE_URL}/api/v1/listings"
          auth: bearer:UDH_API_KEY
          body:
            from_draft: "{content}"
        respond:
          template: |
            ✅ 物件已建立
            🆔 listing id: {{data.id}}
            🔗 {{data.share_url}}

      - id: list_listings
        label: 看所有物件
        description: List property listings — tap one to see full details
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/listings"
          auth: bearer:UDH_API_KEY
        respond:
          template: "🏠 你有 {{data.count}} 個物件 — 點一個看詳細:"
          choices:
            from: listings
            button: "{{this.title}} (HK${{this.price_hkd}})"
            callback_action: get_listing
            callback_args:
              listing_id: "{{this.id}}"
            limit: 30

      - id: get_listing
        label: 看單一物件
        description: Show full details of one listing
        args:
          - name: listing_id
            label: 物件 ID
            type: string
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/listings/{listing_id}"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            🏠 {{response.title}}

            📍 {{response.district}}
            💰 HK${{response.price_hkd}}
            🛏 {{response.bedrooms}}房 {{response.bathrooms}}衛
            📐 {{response.area_sqft}} sqft
            🔖 狀態: {{response.status}}
          follow_up_actions:
            - action: generate_promo
              label: ✍️ AI 生廣告文
              args:
                listing_id: "{{args.listing_id}}"
          follow_up_urls:
            - label: 🔗 開分享頁
              url: "{{response.share_url}}"

      - id: generate_promo
        label: AI 生廣告文
        description: Generate AI ad copy for a listing in zh-HK
        args:
          - name: listing_id
            label: 物件 ID
            type: string
        api:
          method: POST
          url: "{UDH_BASE_URL}/api/v1/listings/{listing_id}/promo"
          auth: bearer:UDH_API_KEY
          body:
            locales: ["zh_hk"]
        respond:
          template: |
            ✍️ AI 廣告文 (繁中):

            {{response.promo.zh_hk}}

      - id: list_leads
        label: 看 leads
        description: List customer inquiries from share pages — newest first
        args: []
        api:
          method: GET
          url: "{UDH_BASE_URL}/api/v1/leads"
          auth: bearer:UDH_API_KEY
        respond:
          template: |
            🔥 你有 {{data.count}} 個 lead:
            {{#each data.leads}}
            · {{this.name}} ({{this.phone}}) — {{this.temperature}} · listing: {{this.listing_id}}{{/each}}

      # ── B-role: UDomain platform operator (cross-realtor) ──
      # Allowlist-gated by UDH_ADMIN_UIDS env on the UDH side. Non-admin keys
      # → 403 → Pin's sanitizeError shows "產品端拒絕了這個請求 (403)".
      # Per HQ_HANDOFF_UDHOUSE.md the operator's uid is already allowlisted.
      - id: admin_stats
        label: 平台總覽 📊
        visibility: secondary
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
        visibility: secondary
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
        visibility: secondary
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
        visibility: secondary
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

UD House is Ultra Lab's white-labelled real-estate platform for HK realtors, built with
UDomain (NASDAQ: UDUD). The API exposes:

- `/api/v1/me` — verify identity (returns product/tenant/uid)
- `/api/v1/listings` — list property listings with stats (price_hkd, bedrooms, bathrooms, district, area_sqft, share_url, status)
- `/api/v1/leads` — list customer inquiries from share pages (name, phone, listing_id, temperature, source)

When showing money, prefer HK$ formatting. When showing leads, sort by created_at desc
(newest first). Listings come paginated up to 40 per call; mention if truncated.
