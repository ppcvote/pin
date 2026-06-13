---
name: admin-hub
description: |
  Ultra Lab 跨產品管理員後台入口 —— 一站打開各產品的 admin 後台。
  Use when the user mentions 管理後台, admin, 後台, 平台管理, 管理員入口.
  與各產品的會員/操作工具分開：這是「管理員身分」的後台入口集合。
license: Proprietary (Ultra Lab)
compatibility: Admin-only — gated by requires_admin (same probe as udhouse-admin). Non-admin users never see this skill.
metadata:
  pin:
    version: "1.0"
    icon: 🛠
    display_name: 管理後台
    primary_color: "#475569"
    requires_admin: true
    actions:
      # 每個動作 anchor 到一個穩定的 2xx JSON（manifest.json，回應忽略），
      # 真正的後台網址放在 follow_up_urls。各 admin App 之後再逐個加免登入(?ct)。
      - id: advisor_admin
        label: 📊 Ultra Advisor 後台
        description: Open Ultra Advisor's admin backend (member / revenue management).
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/manifest.json"
        respond:
          template: |
            📊 Ultra Advisor 管理後台（財顧/會員/營收）
          follow_up_urls:
            - label: 🔓 開啟 Advisor 後台
              url: "https://admin.ultra-advisor.tw/secret-admin-ultra-2026"
      - id: ultralab_admin
        label: 🔬 UltraLab 後台
        description: Open UltraLab's admin backend (orders / products / email).
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/manifest.json"
        respond:
          template: |
            🔬 UltraLab 管理後台（訂單/商品/Email）
          follow_up_urls:
            - label: 🔓 開啟 UltraLab 後台
              url: "https://ultralab.tw/admin"
      - id: mindthread_admin
        label: 🧵 MindThread 後台
        description: Open MindThread's admin backend (member management).
        args: []
        api:
          method: GET
          url: "https://ultra-advisor.tw/manifest.json"
        respond:
          template: |
            🧵 MindThread 管理後台（會員管理）
          follow_up_urls:
            - label: 🔓 開啟 MindThread 後台
              url: "https://mindthread.tw/admin"
---

# admin-hub skill (for LLM agents)

Ultra Lab 跨產品管理員後台「入口集合」。只有管理員身分（requires_admin，與
udhouse-admin 同一個探針 `probeAdminAccess`）看得到本 skill；非管理員完全不顯示。

- 📊 Ultra Advisor 後台 — `https://admin.ultra-advisor.tw/secret-admin-ultra-2026`（獨立子 App）
- 🔬 UltraLab 後台 — `https://ultralab.tw/admin`（Google 登入閘門 VITE_ADMIN_EMAIL）
- 🧵 MindThread 後台 — `https://mindthread.tw/admin`（MemberAdmin）

v1 = 一鍵開網頁（到該後台登入一次）。v2 = 各 admin App 加 `?ct` 自動登入（passwordless），
比照主站 pinAuth 機制，但要在「每個獨立 admin App」各加一段 ?ct 處理。

UD House 的管理員視角是另一個 skill `udhouse-admin`（API 式、直接在 Pin 看平台統計/物件/leads），
不開網頁，故不收進本入口集合。
