# PIN_FLYWHEEL.md — Pin 端接線工單 v1.0

> 交付對象:Pin repo 的 Claude(Opus 4.6)
> 從屬於:PIN_DIRECTION.md(憲法不變)+ HQ_FLYWHEEL_DIRECTIVE.md(本工單 = 其 W4 的 Pin 端視角)
> 排程:**PIN_ONBOARDING A(綁定 deep link)完成後開工。** A 沒完成前本文件唯讀。
> 協作:API 由 UltraLab session 提供,合約見第 1 節;進度衝突或合約變更,透過 HQ(@UltraClaudeBot)協調,不要直接改對方 repo。
> 總工時上限:三天(API mock 先行,不等 UltraLab)。

---

## 0. Pin 在飛輪裡的位置

```
掃描 → AVS 病歷 → UltraGrowth 處方 → 【Pin:日常觸點】 → 內容引擎回流
```

Pin 負責的那一齒叫**留存**。客戶付 NT$2,990/月,平日感受不到服務存在就會退訂;Pin 讓服務每週主動出現在他的 LINE 裡——成效數字、新貼文通知、lead 推播。退訂等於親手刪掉一個每天在用的東西,這就是 Pin 對飛輪的全部貢獻,本工單的每一項都為這句話服務。

---

## 1. UltraGrowth Skill(一天,API 用 mock 先開發)

### API 合約(UltraLab 端提供,Pin 端先寫 mock server 對齊)

```
GET  {UG_BASE_URL}/api/v1/growth/summary      bearer:UG_API_KEY
     → { period, seo: {keywords_up, keywords_down, top_keyword},
         social: {reach, posts, followers_delta},
         site: {visits, visits_delta_pct} }

GET  {UG_BASE_URL}/api/v1/growth/posts?limit=5  bearer:UG_API_KEY
     → { posts: [{ title, channel, reach, likes, url, published_at }] }

Webhook  report.ready   → 月報生成,payload 含 report_url + 三個亮點數字
Webhook  lead.created   → 客戶網站表單進件,payload 含 name/contact/source
```

合約凍結規則:Pin 端照此 mock 開發;UltraLab 端若需改動,經 HQ 通知、雙方確認後才改。**不要猜對方會給什麼,照合約寫。**

### skills/ultragrowth/SKILL.md

- icon 📈,primary_color 沿用 Ultralab teal `#2DD4BF`,secrets:`UG_BASE_URL`、`UG_API_KEY`。
- actions:
  - `monthly_summary`「看本月成效 📈」— GET summary,template 渲染三段(SEO/社群/網站),數字加減用 ▲▼ 標示。primary。
  - `recent_posts`「看最近貼文」— GET posts,choices 列表,點單篇回 url 按鈕。primary。
  - `whoami`「看方案」— secondary,顯示 tenant 與方案名。
- webhooks:
  - `report.ready` → 推播「📊 你的 {period} 月報出爐」+ 三個亮點 + 「看完整報告」url 按鈕。
  - `lead.created` → 推播「🔥 有人從你的網站找你」+ 聯絡資訊 + 來源。
- **驗收標準之一:runtime 零改動。** 如果這份 SKILL.md 寫不出來、需要動 runtime,代表 spec 或 runtime 有缺陷——停下來回報 HQ,修平台不修個案(DIRECTION P2 原則)。

## 2. 交付儀式(半天)

新 UltraGrowth 客戶 onboarding 的最後一步:

1. UltraGrowth 端(UltraLab session 負責)呼叫既有的 `POST /bind/token`(PIN_ONBOARDING A 的 endpoint,**零新工**),拿 token 組 LINE 預填訊息連結,渲染成 onboarding 完成頁的 QR。
2. Pin 端綁定成功的回覆,對 `skillName === "ultragrowth"` 做一個特例:歡迎訊息 + **第一則內容直接推他的 AVS 前後對比**(綁定 token 的 meta 帶 `avs_before`/`avs_after` 兩個數字,由 UltraGrowth 端塞入)。第一印象就是價值證明,這半天的工全花在這一則訊息的含金量上。
3. 綁定表 schema 不變,`bindTokens` 的 payload 加選配 `meta` 欄位即可。

## 3. 飛輪事件上報(半天)

Pin 不直連 Firestore——UltraLab 端提供 `POST {UG_BASE_URL}/api/flywheel-event`(shared secret header),Pin 打兩種事件:

- `pin_bound`:任何 skill 綁定成功時即時上報,meta 含 skillName(**不含** userId 原值,送 hash)。
- `pin_weekly_active`:node-cron 每週日彙總——本週有過至少一次 action 執行的綁定數,按 skill 分組,一次上報。

上報失敗不重試超過一次、不阻塞主流程、進 dead-letter log。量測是儀表,儀表壞了不能弄停引擎。

## 4. 不做

- 不做 UltraGrowth 的任何寫入型 action(改設定、發貼文)——v1 這個 skill 是唯讀 + 推播。客戶要改東西,推播裡給後台連結。寫入等 UltraGrowth 端 API 成熟、且有客戶真的要求再說。
- 不在 Pin 端存任何成效數據——每次都打 API 拿即時的,Pin 是介面不是資料庫。
- 不做月報 PDF 的生成或轉發——`report_url` 一顆按鈕,生成是 UltraGrowth 的事。

## 5. 驗收

用 sandbox tenant 走完整圈:掃 QR 綁定 → 收到 AVS 對比歡迎訊息 → 按「看本月成效」拿到 mock 數據 → mock webhook 打 `lead.created` 收到推播 → Firestore 裡看得到 `pin_bound` 事件。全程錄屏給 HQ 歸檔,這段錄屏同時就是給 Russell 看的 demo 素材。

## 6. 決策點(經 HQ 轉給 PPC)

無。本工單全部是既有規格的組合,沒有新的戰略決策。唯一的外部依賴是 UltraLab 端的 API 與事件 endpoint 時程——由 HQ 追。
