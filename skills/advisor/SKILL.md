---
name: advisor
description: |
  Open Ultra Advisor's research report series (ultra-advisor.tw) — a three-volume
  deep dive on personal finance infrastructure. Use when the user mentions
  Ultra Advisor, 研究報告, 收費站, 大腦, 降落傘, or asks for the research series.
license: Proprietary (Ultra Lab)
compatibility: Requires network access to ultra-advisor.tw (no API key needed)
metadata:
  pin:
    version: "1.0"
    icon: 📚
    primary_color: "#0F766E"
    actions:
      - id: open_research
        label: 📚 研究報告
        description: Show Ultra Advisor's research report series — index plus three volumes, as tappable links
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/manifest.json"
        respond:
          template: |
            📚 Ultra Advisor 研究報告系列

            三卷深度研究, 點下面直接讀:
          follow_up_urls:
            - label: 🗂 系列索引
              url: "https://ultra-advisor.tw/research"
            - label: 📖 Vol.I 收費站
              url: "https://ultra-advisor.tw/research/the-gateway"
            - label: 📖 Vol.II 大腦
              url: "https://ultra-advisor.tw/research/the-brain"
            - label: 📖 Vol.III 降落傘
              url: "https://ultra-advisor.tw/research/the-parachute"
      - id: policy_checkup
        label: 🩺 保單健診
        description: Point members at Ultra Advisor's insurance checkup tool (lives inside the member dashboard, login required)
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/manifest.json"
        respond:
          template: |
            🩺 保單健診是會員工具, 登入 Ultra Advisor 後在工具列開啟:
          follow_up_urls:
            - label: 🔑 登入 Ultra Advisor
              url: "https://ultra-advisor.tw/"
      - id: daily_quote
        label: ✨ 每日金句
        description: Fetch today's quote from ultra-advisor.tw — same quote the site shows (date-hash synced)
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/api/daily-quote"
        respond:
          template: |
            ✨ 每日金句 · {{data.date}}

            「{{data.text}}」

            — Ultra Advisor
          follow_up_urls:
            - label: 🌐 開啟 Ultra Advisor
              url: "https://ultra-advisor.tw/"
      # —— 預留（PPC 2026-06-13 指示）——
      # 未來在此擴充更多會員功能按鈕, 每個 = 一個 action:
      #   - 每日金句「自動推播」（不是按鈕, 是排程）: 等 Pin runtime 排程器,
      #     端點已就緒（/api/daily-quote?date= 可預取）, 工單見 INBOX
      #   - 其他工具（退休規劃 / 房貸試算…）視會員需求逐顆加
    # —— 會員通知綁定（PPC 2026-06-13「12都上」）——
    # 宣告 webhooks → Pin 自動在本 skill 選單顯示「🔔 綁定通知」鈕，
    # 會員拿 token 到 ultra-advisor.tw 後台貼上完成綁定（流程見 binding.ts）。
    # secret = Pin .env 的 ADVISOR_PIN_WEBHOOK_SECRET，須與 Advisor 後端共用值。
    webhooks:
      - event: daily_quote.scheduled
        secret: ADVISOR_PIN_WEBHOOK_SECRET
        notify:
          template: |
            ✨ 每日金句 · {{data.date}}

            「{{data.text}}」

            — Ultra Advisor
          buttons:
            - label: 🌐 開啟 Ultra Advisor
              url: "https://ultra-advisor.tw/"
---

# Advisor skill

Static entry point to Ultra Advisor's research report series. No backend
service and no secrets — the four destinations are public pages on
ultra-advisor.tw.

Implementation note: the Pin runtime only renders `respond` (text + URL
buttons) after a successful 2xx JSON `api` call, so this action anchors to
`https://ultra-advisor.tw/manifest.json` — a static JSON asset on the same
site. The response body is ignored; the template and all four URLs are static.

For LLM agents: just give the user these links —

- 系列索引: https://ultra-advisor.tw/research
- Vol.I 收費站: https://ultra-advisor.tw/research/the-gateway
- Vol.II 大腦: https://ultra-advisor.tw/research/the-brain
- Vol.III 降落傘: https://ultra-advisor.tw/research/the-parachute
