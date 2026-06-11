---
name: ultragrowth
description: |
  Query the realtor / SaaS customer's UltraGrowth managed-service stats —
  SEO keyword movement, social reach, site visits, recent published posts.
  Use when the user mentions UltraGrowth, 月報, 成效, 流量, 我的網站, SEO.
license: Proprietary (Ultra Lab)
compatibility: Requires UG_API_KEY (ug_live_xxx) and network access to the UltraGrowth API host.
metadata:
  pin:
    version: "1.0"
    icon: 📈
    primary_color: "#2DD4BF"
    secrets:
      - UG_API_KEY
      - UG_BASE_URL
    webhooks:
      - event: report.ready
        secret: UG_WEBHOOK_SECRET
        notify:
          template: |
            📊 你的 {{data.period}} 月報出爐了

            ✨ 三個亮點:
            • {{data.highlights.0}}
            • {{data.highlights.1}}
            • {{data.highlights.2}}
          buttons:
            - label: 📄 看完整報告
              url: "{{data.report_url}}"
            - label: 📈 看本月成效
              action: monthly_summary
      - event: lead.created
        secret: UG_WEBHOOK_SECRET
        notify:
          template: |
            🔥 有人從你的網站找你

            👤 {{data.lead.name}}
            📞 {{data.lead.contact}}
            📍 來源: {{data.lead.source}}
          buttons:
            - label: 👀 看最近貼文 (了解他可能是看到什麼來)
              action: recent_posts

    actions:
      - id: monthly_summary
        label: 看本月成效 📈
        description: Summarise SEO + social + site stats for the current billing period.
        args: []
        api:
          method: GET
          url: "{UG_BASE_URL}/api/v1/growth/summary"
          auth: bearer:UG_API_KEY
        respond:
          template: |
            📈 {{data.period}} 成效摘要

            🔍 SEO
              關鍵字上升 ▲ {{data.seo.keywords_up}}
              關鍵字下滑 ▼ {{data.seo.keywords_down}}
              本月最強: {{data.seo.top_keyword}}

            📱 社群
              觸及 {{data.social.reach}}
              發文 {{data.social.posts}}
              粉絲變動 {{data.social.followers_delta}}

            🌐 網站
              造訪 {{data.site.visits}}
              成長 {{data.site.visits_delta_pct}}%

      - id: recent_posts
        label: 看最近貼文
        description: List the latest 5 published posts across all channels with engagement.
        args: []
        api:
          method: GET
          url: "{UG_BASE_URL}/api/v1/growth/posts"
          auth: bearer:UG_API_KEY
          query:
            limit: "5"
        respond:
          template: "📝 最近 {{data.posts.length}} 篇貼文 — 點一篇看原文:"
          choices:
            from: posts
            button: "{{this.channel}} · {{this.title}} ({{this.reach}}👁)"
            callback_action: open_post
            callback_args:
              url: "{{this.url}}"
            limit: 5

      - id: open_post
        label: 開貼文
        description: Internal — invoked from recent_posts choice rows
        args:
          - name: url
            type: string
        api:
          method: GET
          url: "{UG_BASE_URL}/api/v1/growth/posts"
          auth: bearer:UG_API_KEY
          query:
            limit: "5"
        respond:
          template: "🔗 開連結看貼文"
          follow_up_urls:
            - label: 🔗 開貼文
              url: "{{args.url}}"

      - id: whoami
        label: 看方案
        visibility: secondary
        description: Show this customer's tenant id + plan
        args: []
        api:
          method: GET
          url: "{UG_BASE_URL}/api/v1/growth/summary"
          auth: bearer:UG_API_KEY
        respond:
          template: |
            📈 UltraGrowth
            Tenant: {{data.tenant_id}}
            方案: {{data.plan}}
            計費週期: {{data.period}}
---

# Skill instructions (for LLM agents)

UltraGrowth is Ultra Lab's managed digital service for Taiwan SMBs and
solo professionals (insurance agents, real-estate agents, clinics).
Subscription NT$2,990/month, the offering bundles SEO + social automation
+ a brand site, managed by Ultra Lab.

Pin's role for an UltraGrowth subscriber is the **retention surface**:
weekly digest pushes, ad-hoc summaries when they ask, lead notifications
when a website form submits, and monthly report deliveries. Pin should
never be the source of truth for performance data — every action calls
the live API.

## API contract (frozen 2026-06-12)

This SKILL.md is written against an API contract agreed with the
UltraLab session. If a field shape changes server-side, the deviation
gets coordinated through HQ Claude before either side ships — see
PIN_FLYWHEEL §1.
