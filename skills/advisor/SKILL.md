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
