# PIN_ONBOARDING.md — 連接與曝光規格書 v1.0

> 交付對象:Pin repo 的 Claude(Opus 4.6)
> 從屬於:PIN_DIRECTION.md(NOT-DO 清單依然有效,特別是第 1 條 Marketplace)
> 回答的問題:終端用戶怎麼連上 Pin?開發者怎麼知道 Pin 存在?
> 總工時上限:一週。三個 phase 可依序做,A 最優先。

---

## 0. 定位判斷(已定案,不重新辯論)

Pin 是 B2B2C。終端用戶(房仲、MindThread 客戶)永遠不會「逛」任何東西——他們從已付費的產品裡點一顆按鈕進來。開發者不逛市集,開發者查文件。所以不做市集,做三件事:**綁定 deep link(A)、一頁式 landing + 沙盒(B)、選單探索區(C)**。市集的解凍條件寫在第 4 節。

---

## A. 綁定 Deep Link(兩天)— 終端用戶零輸入連接

### 目標體驗

用戶在 MindThread / UD House 的網頁後台看到按鈕「📱 用 LINE 管理」→ 點擊 → 進入 LINE 聊天室 → 按一下發送 → 綁定完成、選單出現。全程零打字。

### 流程與 API

1. **產品端取 token**:Pin 新增 endpoint `POST /bind/token`
   - 請求:`{ skillName, tenantKey, productApiKey }`(productApiKey 用該 skill 在 .env 的 secret 驗證)
   - 回應:`{ token, expiresAt }`
   - token:128-bit random(`crypto.randomBytes(16)`),**單次有效,TTL 10 分鐘**,存 jsonStore `bindTokens:{token}` → `{skillName, tenantKey, createdAt, used: false}`。
2. **產品端組連結**:
   - **Telegram**:原生支援,`https://t.me/{botUsername}?start={token}`。Pin 在 `/start` handler 解析 payload。
   - **LINE**:加好友連結不帶參數,**用預填訊息連結**:`https://line.me/R/oaMessage/{officialAccountId}/?bind%20{token}`。用戶點開聊天室時訊息已填好「bind {token}」,按發送即完成。**不用 LIFF**——LIFF 要多養一個前端跟 LINE Login 設定,預填訊息一個 tap 達成 95% 的體驗,不成比例的工不做。
   - 未加好友的 LINE 用戶:產品端按鈕先導 `https://lin.ee/...` 加好友頁,加完好友的歡迎訊息(follow event)裡放一顆「完成綁定」按鈕,callback 帶同一個 token(token 由產品端透過 URL fragment 或第二步驟頁傳遞;若實作太繞,fallback 為顯示 6 位數綁定碼讓用戶貼上——體驗降一級但穩)。先做主路徑,fallback 視測試結果決定。
3. **Pin 端完成綁定**:收到 `bind {token}` 或 start payload → 驗 token(存在、未用、未過期)→ 寫入 P1 既有的綁定表 `{channelId, userId, skillName, tenantKey}` → 標記 token used → 回覆「✅ 已連接 {skill icon} {skillName}」+ 該 skill 選單。
4. **解綁**:skill 選單加 secondary action「解除連接」,二次確認後刪綁定。

### 安全要求

- token 驗證失敗一律回同一句「連結已失效,請回到產品頁面重新點擊」,不透露失敗原因。
- 同一 userId 對 `bind` 嘗試限流:10 次/小時,超過靜默忽略。
- `POST /bind/token` 走 HTTPS、驗 productApiKey、限流 60 次/小時/skill。
- token 不寫進任何 log。

### 驗收

MindThread 網頁後台放一顆真按鈕,PPC 用一支沒綁過的 LINE 帳號從點擊到看到選單 < 30 秒、零打字(或最多貼一次綁定碼)。

---

## B. ultralab.tw/pin 一頁式 + 沙盒 Demo(兩天)— 開發者入口

### 不是新工程

ultralab repo 是現成的 Vite + React 站,加一個 `/pin` 路由。設計語言沿用 Ultralab 系統(深紫底 + teal),不另起爐灶。

### 頁面結構(一頁,四段)

1. **Hero**:一句話 pitch ——「一份 SKILL.md,你的產品就有 LINE 選單介面。確定性執行,零 LLM 成本,零幻覺。」副標對照 OpenClaw:「不是另一個 agent。是讓人按三下把事辦完的介面。」CTA 兩顆:「掃碼試玩」錨點到第 2 段、「10 分鐘接上你的產品」錨點到第 3 段。
2. **沙盒 Demo**:LINE QR code(沙盒官方帳號或主帳號 + 沙盒綁定 deep link,複用 A 的機制:頁面載入時跟 Pin 要一個 `tenantKey: "sandbox"` 的 token)。掃了直接進聊天室體驗 MindThread skill——看帳號、走發文 wizard。**這個體驗是整頁的核心**,比所有文案有說服力。
3. **開發者 Quickstart**:三步驟——`git clone`、寫一份最小 SKILL.md(10 行內的真實範例,inline 展示)、`npm start`。連結到 GitHub repo 跟 PIN_SKILL_SPEC.md。
4. **信任區**:UltraProbe 防護整合一句話 + 已上線產品 logo(MindThread、UD House)+ 「Built on the Agent Skills open standard (agentskills.io)」。

### 沙盒的 Pin 端要求(這是本 phase 真正的工)

- Pin 新增 sandbox 模式:綁定表的 `tenantKey === "sandbox"` 時,actionExecutor 把該 skill 的 `MT_BASE_URL`/`MT_API_KEY` 換成 `SANDBOX_MT_BASE_URL`/`SANDBOX_MT_API_KEY`(env 層替換,skill 定義零修改)。
- 沙盒帳號的發文 action 必須打在 MindThread 的測試帳號上,**絕不碰真實客戶資料**——這由 sandbox API key 的權限範圍保證,Pin 端額外加一道保險:sandbox 綁定的用戶執行任何 POST/PUT/DELETE action 前,先檢查 base URL 是 sandbox 的,不是就拒絕執行並記 log。
- 沙盒綁定限流:同一 userId 只能有一個 sandbox 綁定;全域 sandbox 用戶數上限 200(jsonStore counter),滿了 QR 流程回覆「測試額滿,留下 email」。
- 沙盒綁定 7 天自動過期清除(node-cron 已在依賴裡)。

### 驗收

陌生開發者(找翁丞鴻或團隊裡非工程背景的人測)從掃碼到完成一次沙盒發文 < 2 分鐘,全程不需要任何人解釋。

---

## C. /menu 探索區(半天)— 現階段的「市集」

- `/menu` 主選單尾部加分區「🧭 探索」,列出 registry 已載入但**該用戶未綁定**的 skills。
- 每個 skill 一則卡片訊息(LINE 用 Flex、TG 用文字 + 按鈕):`metadata.pin.icon` + name + description 第一行,兩顆按鈕——「🎮 試用」(走 sandbox 綁定,複用 B 的機制)、「🔗 連接」(回覆該 skill 的接入說明文字,內容來自新的選配欄位 `metadata.pin.connect_url`,沒有就顯示「請從 {skillName} 後台連接」)。
- 全部 skills 都已綁定的用戶不顯示探索區。
- spec 增加 `connect_url` 一個欄位即可,不加其他(DIRECTION NOT-DO 第 6 條:每個新欄位都要有真實 skill 在用)。

---

## 4. 市集解凍條件(寫死,到了再談)

同時滿足三項才重啟市集討論:(1) 非 PPC 的外部 skills ≥ 5 個;(2) 用戶主動詢問「還有什麼功能」的紀錄 ≥ 10 次;(3) DIRECTION 三個月檢查點第 1 題答「有」。在那之前,任何上架流程、審核機制、搜尋功能、評分系統的提案,引用本節拒絕。

---

## 5. 留給 PPC 的決策點

1. **LINE 官方帳號策略**:沙盒跟正式用同一個 OA(靠 tenantKey 區分)還是開第二個 OA?同一個省管理但測試流量混進正式帳號的統計。建議先同一個,量大再拆。
2. **MindThread 沙盒帳號**:需要你在 MindThread 端開一個 sandbox API key + 一兩個測試 Threads 帳號。這是 B 的前置依賴,Pin 端等不到就先用 mock server 開發。
3. **Landing 文案語言**:/pin 頁面先繁中、先繁中+英文雙語、還是先英文?目標客群如果含 HK(UD House 線)建議雙語,工時多半天。
