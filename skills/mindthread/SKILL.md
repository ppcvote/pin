---
name: mindthread
description: |
  Query the user's MindThread social media automation. Show connected Threads accounts
  and their stats (followers, views, posts). Use when the user mentions MindThread, MT,
  Threads, social media accounts, or wants to see post / follower / view stats.
license: Proprietary (Ultra Lab)
compatibility: Requires MT_API_KEY (live or test) and network access to mindthread.tw
metadata:
  pin:
    version: "1.0"
    icon: 🧵
    primary_color: "#6366F1"
    secrets:
      - MT_API_KEY
      - MT_BASE_URL
    actions:
      - id: list_accounts
        label: 看所有帳號
        description: List connected Threads accounts as tappable buttons — tap one to drill into details
        args: []
        api:
          method: GET
          url: "{MT_BASE_URL}/api/v1/accounts"
          auth: bearer:MT_API_KEY
        respond:
          template: "🧵 你有 {{data.accounts.length}} 個帳號 — 點一個看詳細:"
          choices:
            from: data.accounts
            button: "{{this.threads_username}} ({{this.stats.followers}}👥)"
            callback_action: get_account
            callback_args:
              account_id: "{{this.id}}"
            limit: 13

      - id: get_account
        label: 看單一帳號
        description: Show full details of one account
        args:
          - name: account_id
            label: 帳號 ID
            type: string
        api:
          method: GET
          url: "{MT_BASE_URL}/api/v1/accounts"
          auth: bearer:MT_API_KEY
        respond:
          find_one:
            from: data.accounts
            where: id
            equals: "{account_id}"
          template: |
            🧵 {{found.threads_username}}
            {{found.display_name}}

            👥 粉絲: {{found.stats.followers}}
            👁️ 瀏覽: {{found.stats.total_views}}
            📝 貼文: {{found.stats.total_posts}}
            ❤️ 喜歡: {{found.stats.total_likes}}
            💬 回覆: {{found.stats.total_replies}}

            狀態: {{found.status}}

      - id: list_formulas
        label: 看文案公式
        visibility: secondary
        description: List available AI content generation formulas
        args: []
        api:
          method: GET
          url: "{MT_BASE_URL}/api/v1/formulas"
          auth: bearer:MT_API_KEY
        respond:
          template: |
            ✍️ AI 寫文公式 ({{response.formulas.length}} 種):
            {{#each response.formulas}}
            · `{{this.id}}` — {{this.description}}{{/each}}

      - id: post
        label: 幫我發一篇 ✨
        description: Multi-step wizard — pick account, pick formula, give topic, preview, publish
        args:
          - name: account_id
            label: 選帳號
            type: string
            from_action: list_accounts
            select_key: id
            display_key: threads_username
          - name: formula
            label: 選文案公式
            type: enum
            options:
              - value: controversial_opinion
                label: 💥 爭議性觀點 (引討論)
              - value: curiosity_hook
                label: 🎯 好奇心鉤子 (拉互動)
              - value: binary_choice
                label: ⚖️ A 或 B (拉留言)
              - value: personal_experience
                label: 📖 個人經驗 (拉共鳴)
              - value: list_format
                label: 📋 條列清單 (好分享)
              - value: auto
                label: ✨ 自動選最好
          - name: topic
            label: 想寫什麼主題
            type: string
            input: text
            placeholder: 例如「為什麼老闆都該學 Threads」
        api:
          method: POST
          url: "{MT_BASE_URL}/api/v1/content/generate"
          auth: bearer:MT_API_KEY
          body:
            account_id: "{account_id}"
            formula: "{formula}"
            topic: "{topic}"
        preview:
          template: |
            📝 預覽 (給 {{response.account_id}}, 用 `{{response.formula}}`):

            ━━━━━━━━━━━━━━━━━━━━
            {{response.content}}
            ━━━━━━━━━━━━━━━━━━━━

            想發出去嗎?
          confirm_action: publish_now

      - id: publish_now
        label: 立即發佈
        description: Publish a pre-generated piece of content to Threads now
        args:
          - name: account_id
            type: string
          - name: content
            type: string
        api:
          method: POST
          url: "{MT_BASE_URL}/api/v1/content/schedule"
          auth: bearer:MT_API_KEY
          body:
            account_id: "{account_id}"
            content: "{content}"
            publish_at: "now"
        respond:
          template: |
            ✅ 已發到 Threads
            {{#if response.post_id}}🔗 post id: {{response.post_id}}{{/if}}

      - id: totals
        label: 看總和
        visibility: secondary
        description: Aggregate stats across all connected accounts (followers, views, posts)
        args: []
        api:
          method: GET
          url: "{MT_BASE_URL}/api/v1/accounts"
          auth: bearer:MT_API_KEY
        respond:
          template: |
            📊 全帳號合計 ({{data.accounts.length}} 個):

            👥 粉絲: {{sum data.accounts "stats.followers"}}
            👁️ 瀏覽: {{sum data.accounts "stats.total_views"}}
            📝 貼文: {{sum data.accounts "stats.total_posts"}}
            ❤️ 喜歡: {{sum data.accounts "stats.total_likes"}}
---

# Skill instructions (read by LLM agents — Pin uses metadata.pin above for menu)

This skill exposes Ultra Lab's MindThread platform — a multi-account Threads automation
service that posts AI-generated content from formulas to multiple connected accounts.

Use this skill when the user wants to see:
- How many accounts are connected
- Stats for any specific account (followers, views, post count)
- Aggregate totals across all accounts

The MindThread API returns each account's `threads_username`, `display_name`, and a
`stats` object with `followers`, `total_views`, `total_likes`, `total_replies`,
`total_posts`. Show numbers with thousands separators when large.

If a Pin runtime is loading this, the `metadata.pin.actions` block above defines the
menu the user will see. Each action maps to one button.
