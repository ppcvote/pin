---
name: slides
description: |
  Generate a polished presentation deck (PDF) from a topic and pasted notes.
  Two field-proven design systems: research-note (cream, serif, landscape)
  and ops-manual (black/red, portrait). Use when the user wants slides, a
  deck, a presentation, 簡報, 投影片, or a teaching/briefing document.
license: Proprietary (Ultra Lab)
compatibility: Requires SLIDES_BASE_URL + SLIDES_API_KEY (slides-server) and network access
metadata:
  pin:
    version: "1.0"
    icon: 📊
    primary_color: "#C0492F"
    secrets:
      - SLIDES_API_KEY
      - SLIDES_BASE_URL
    actions:
      - id: make_deck
        label: ✨ 幫我做一份簡報
        description: Multi-step wizard — pick a design system, give topic + source notes, get a rendered PDF deck
        args:
          - name: style
            label: 選風格
            type: enum
            options:
              - value: research
                label: 📰 研究筆記風 (米白・襯線・橫式)
              - value: ops
                label: 🩸 作戰手冊風 (黑紅・內參・直式)
          - name: topic
            label: 簡報主題
            type: string
            input: text
            placeholder: 例如「Q3 增員策略:為什麼現在是進場點」
          - name: notes
            label: 重點素材
            type: string
            input: text
            placeholder: 把重點、數據、想講的話全部貼上來 — 素材越多, 內容越紮實 (數字只會來自你貼的素材)
        api:
          method: POST
          url: "{SLIDES_BASE_URL}/api/v1/decks"
          auth: bearer:SLIDES_API_KEY
          timeout_s: 110
          body:
            style: "{style}"
            topic: "{topic}"
            notes: "{notes}"
        respond:
          template: |
            ✅ 《{{data.title}}》排版完成 — {{data.pages}} 頁

            ⏳ 下載連結 30 分鐘內有效, 請盡快存檔。
          follow_up_urls:
            - label: ⬇️ 下載 PDF
              url: "{{data.pdf_url}}"
            - label: 👀 看第 1 頁
              url: "{{data.preview_url}}"
---

# Slides skill

Generates presentation decks by filling two fixed, field-proven design
systems with LLM-structured content. The design layer is deterministic
HTML/CSS (quality floor guaranteed); the LLM only fills content slots and
is instructed to use numbers exclusively from the user's pasted notes.

If a Pin runtime is loading this, `metadata.pin.actions` above defines the
menu. For LLM agents: call the deck API directly with {style, topic, notes}.
