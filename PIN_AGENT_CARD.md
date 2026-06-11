# PIN_AGENT_CARD.md — Agent 角色卡規格書 v1.0

> 交付對象：Pin repo 的 Claude（Opus 4.6）
> 從屬於：PIN_DIRECTION.md（本文件不得違反其 NOT-DO 清單與優先序）
> 性質：行銷型 UX 功能。比喻當介面用,不當經濟用。

---

## 0. 一句話定義

**把 agent 看不見的設定變成一張看得懂、想分享的角色卡:skills 是武器,防護規則是防具,操作次數是戰績。**

靈感對照:Claude Buddy(Anthropic 2026 愚人節彩蛋,gacha 寵物刷爆開發者圈)證明了「agent 擬人化」的情感鉤子;tama96 證明了開發者吃這套。但它們全是玩具。Pin 的角色卡不是玩具,是**設定的可視化**——每一格裝備都對應一個真實存在的 SKILL.md 或防護機制。卡片上沒有任何假的東西。

## 0.5 鐵律(先讀這個)

1. **沒有經濟系統。** 不做貨幣、不做抽卡、不做稀有度、不做等級、不做進度條、不做商城。這些字眼出現在任何 issue 或提案裡,引用本條拒絕。
2. **卡片內容 100% 來自真實設定與真實數據。** 武器欄 = 實際載入的 skills,防具欄 = 實際啟用的防護,戰績 = jsonStore 裡的真實 counter。不為了卡片好看而發明數值。
3. **工時上限:Phase 1 半天,Phase 2 兩天。** 超過就停下來回報,這是行銷功能,不是產品核心。
4. **優先序:P0(LINE adapter)完成前不開工。** 完成後可與 P1 並行。

---

## 1. Phase 1 — 文字版角色卡(半天)

### 觸發

- 新增 Pin 內建 action `agent_card`,label「看我的 Agent 🃏」,掛在 `/menu` 主選單,visibility: primary。
- 同時支援指令 `/card`。

### 渲染內容(純文字 + emoji,走現有 OutboundReply)

```
🃏 ULTRA AGENT — Pin
━━━━━━━━━━━━━━━━━
⚔️ 武器欄 (skills)
  🧵 MindThread      Lv.活躍
  🏠 UD House        Lv.活躍

🛡️ 防具欄 (protections)
  ✅ Webhook 簽名驗證 (HMAC-SHA256)
  ✅ 入站 Zod 全驗證
  ✅ Secrets 過濾
  ✅ Callback 白名單執行

📊 本週戰績
  按鈕操作 ×{n}
  推播送達 ×{m}
  LLM 介入 ×{k} ← 越低越強,這是賣點

⚡ 零幻覺執行 · Powered by Pin
```

### 資料來源

- **武器欄**:`registry` 已載入的 skills。每項顯示 `metadata.pin.icon` + name。「Lv.」只有兩態:`活躍`(7 天內有 action 執行紀錄)/ `待命`。不做數字等級(鐵律 1)。
- **防具欄**:來自一個新的靜態描述檔 `src/platform/protections.ts`,列出 runtime 實際內建的防護機制(名稱 + 啟用條件函式)。只顯示當前真的啟用的項目。例如 webhook 簽名驗證只在有註冊 webhook 的 skill 存在時顯示。
- **戰績**:在 `actionExecutor` 埋 counter(PIN_DIRECTION.md P1 本來就要做),jsonStore schema:`stats:{userId}:{isoWeek}` → `{actions: n, pushes: m, llmFallbacks: k}`。每週自動換 key,不做歷史聚合。
- **「LLM 介入 ×k 越低越強」**是整張卡的態度所在——把 Pin 的確定性哲學變成一個可炫耀的數字。保留這行。

### 不做

- 不做 agent 命名/改名功能(Phase 3 再說)。
- 不做卡片自訂排版。

---

## 2. Phase 2 — 圖片分享卡(兩天)

### 目的

讓用戶把卡片發到 Threads / 社群。這是本功能存在的真正理由:每張被分享的卡都是 Pin 的廣告。

### 技術路線(已決定,不重新評估)

- **SVG 模板 → PNG**,用 `@resvg/resvg-js` 做 server-side 渲染。**不准用 Puppeteer**——為一張卡片養 headless browser 不成比例,而且部署環境變重。
- SVG 模板放 `assets/card-template.svg`,用簡單的 `{{placeholder}}` 替換(可重用 `src/platform/template.ts` 的 Handlebars-ish 引擎)。
- 產出尺寸 1080×1350(4:5,Threads/IG 直式最佳),檔案 < 500KB。

### 視覺規格

- **配色走 Ultralab 系統**:深紫底 `#1A1033` 漸層至 `#0D0B1A`,主色 teal `#2DD4BF`,金色點綴 `#D4AF37` 用於戰績數字。深色卡面、高對比、Goldman 式的冷調,不要可愛風——受眾是開發者跟營運者,不是小孩。
- 版面三段:上段 agent 識別區(名稱 + 幾何圖形 avatar)、中段裝備欄(武器 / 防具兩欄)、下段戰績條 + `pin · ultralab.tw` 落款。
- **Avatar 用確定性幾何生成**(identicon 風格:以 userId hash 決定圖形組合與色相),不用任何現成角色、不用 AI 生圖、不碰任何版權素材。等 PPC 提供正式吉祥物後替換。
- 字體:思源黑體(Noto Sans TC),SVG 內嵌 subset 或轉 path,確保 resvg 渲染中文不掉字。**先驗證中文渲染再做版面**,這是本 phase 最大的坑。

### 交付方式

- Telegram:`sendPhoto`。LINE:image message。`Channel` interface 需新增 `sendImage(userId, buffer, caption?)` —— 這是合理的 interface 擴充,在 PR 裡引用本文件即可。
- 卡片 caption 附一行:「我的 agent 本週零幻覺完成 {n} 次操作 ⚡ pin」。

---

## 3. Phase 3 — @ultraprobe/guard 防具掛載(一天,可與 Phase 2 並行)

「裝備＝防護規則」不是比喻,是真實整合。`@ultraprobe/guard` 是 Ultralab 自家已發佈的 npm 套件:零依賴、<5ms、無網路呼叫的確定性防護層(PII redact/restore、12 向量注入偵測、A–F defense grade)。它跟 Pin 是同一個哲學——確定性、零 LLM 成本——兩個產品講同一個故事。

### 實際整合(不是裝飾)

- `npm install @ultraprobe/guard`,掛載點只有一個:**`src/brain/llmRouter.ts` 的 freeform fallback 路徑**。用戶自由輸入送往 Gemini/Ollama 前,過 `createGuard({ pii: { mode: 'redact' } })` 的 `scan()` 做 PII 遮蔽,LLM 回應後用 `restore(response, scan.vault)` 還原。round-trip 機制 guard 原生支援,照官方 README 用。
- **確定性路徑(按鈕 + template)不掛 guard**——那條路沒有 LLM,沒有外洩面,加了只是浪費 5ms。這個取捨本身就是 Pin 的賣點,文案可以直接講。
- 注入偵測結果(`result.defense`)記 log 即可,Phase 3 不做攔截動作,先觀察誤判率。

### 卡片呈現

- 防具欄新增一行:`🛡️ @ultraprobe/guard — PII Shield (redact mode)`,僅在套件實際掛載時顯示(鐵律 2)。
- 戰績區可加一行真實數字:`PII 攔截 ×{p}`(guard scan 到的 PII 累計,進同一個 jsonStore counter)。對保險業客戶這個數字比什麼都有說服力。
- 卡片落款區預留 `Protected by UltraProbe` 小字 + ultralab.tw/probe——每張被分享的卡同時替兩個產品打廣告。

### 不做

- 不接 guard 的 Smart Router / Cost Intelligence——Pin 的 brain 路由維持現狀,不為整合而整合。
- 不在 Pin 裡重新實作任何 guard 已有的偵測邏輯。發現需求缺口,去 ultraprobe repo 開 issue,讓套件變強,Pin 只負責消費。

---

## 4. 驗收標準

- Phase 1:在 Telegram 與 LINE 上按「看我的 Agent」,3 秒內回出文字卡,所有內容可對應到真實設定與真實 counter。
- Phase 2:`/card share` 產出 PNG,中文不掉字、深色系符合 Ultralab 配色,PPC 看了願意親自發一篇 Threads。最後這條是真驗收。

---

## 5. 留給 PPC 的兩個決策點(不阻塞開工)

1. **Agent 要不要有預設名字?** 現在卡片標題暫用「ULTRA AGENT」。如果要有人格化命名(像 OpenClaw 的龍蝦),那是品牌決策,等你給名字。
2. **卡片落款連結**:現在寫 `ultralab.tw`。如果 Pin 之後有獨立 landing page,換掉這行即可,位置已預留。

其餘設計決策(resvg、4:5 尺寸、identicon avatar、配色、兩態 Lv.)都已定案,照做,做完再迭代。
