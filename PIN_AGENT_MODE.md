# PIN_AGENT_MODE.md — Agent 模式規格書 v1.0

> 交付對象:Pin repo 的 Claude(Opus 4.6)
> 從屬於:PIN_DIRECTION.md(其 NOT-DO 與技術原則全部有效)
> 一句話:讓用戶用嘴說,但 LLM 只是個聰明的選單操作員——它選按鈕,不執行任何按鈕之外的事。

---

## 0. 鐵律

1. **LLM 沒有執行權。** 它的唯一輸出是「選哪個已註冊 action + 填什麼 args」,產出物進入**原本那條確定性管線**:callback 白名單、zod 驗證、preview/confirm,一個都不跳過。LLM 永遠無法發明一個不存在的操作。
2. **不確定就攤開選項,永不硬猜。** 路由曖昧時降級為按鈕選單讓用戶自己點。這是 Pin agent 跟所有競品的人格差異,是功能不是缺陷。
3. **v1 不做多步驟鏈式執行。** 一句話 → 一個 action(或進入該 action 的 wizard)。「幫我看完數據然後挑最好的帳號發文」這種 planning 是 OpenClaw 的方向,凍結。用戶說了複合指令,回覆拆解後的選項按鈕。
4. **不做計費系統。** 整個功能藏在 `PIN_AGENT_MODE=true` env flag 後面,dogfood 一個月、看完數據之前,任何訂閱/計量/方案頁的提案引用本條拒絕。
5. **不換腦。** 沿用 brain/ 既有的 Gemini 路由,不新增 LLM 供應商、不加 Claude API、不做模型比較框架(DIRECTION NOT-DO 第 3 條)。

---

## 1. Phase 1 — Tool Schema 編譯 + 意圖路由(兩天)

### 1.1 編譯器:actions → tools

新增 `src/brain/toolCompiler.ts`:

- 輸入:registry 全部已載入 skills 的 actions。輸出:function calling 格式的 tool 定義陣列。
- 映射:`id` → tool name(前綴 skill name:`mindthread__post`)、`description` + `label` → tool description、`args` 的 ArgSpec → JSON schema parameters(`type: enum` 帶 choices、`from_action` 型參數標註「需先查詢」)。
- **排除規則**:`visibility: hidden` 一律排除;`callback_only` 排除(它們是鏈式中間態,由 respond.choices 觸發,不給 LLM 直選);有 `preview` 的 action 照常納入——preview 機制本來就是給「來源不確定的觸發」用的,agent 觸發正是這種。
- 用戶綁定過濾:只編譯該用戶已綁定 tenants 的 skills。沒綁任何東西的用戶,agent 模式直接回探索區。

### 1.2 路由器

改寫 `src/brain/llmRouter.ts` 的 freeform fallback 路徑(觸發條件不變:任何非按鈕的文字輸入):

- Prompt 結構:系統指令(你是 Pin 的操作路由器,只能從工具清單中選擇,無法執行清單外任何事)+ 編譯後 tools + 用戶文字。
- **強制 JSON 輸出**,schema 三選一:
  - `{ "decision": "execute", "action": "mindthread__post", "args": {...} }`
  - `{ "decision": "clarify", "candidates": ["action_id_1", "action_id_2", "action_id_3"], "question": "你想..." }`
  - `{ "decision": "none", "reply": "..." }`(與任何 action 無關的閒聊/問題)
- **不使用自報 confidence 分數**——LLM 的信心數字不可靠。曖昧的定義交給輸出結構:模型被指示「只要有兩個以上合理解讀就必須選 clarify」。clarify 的 candidates 渲染成按鈕,question 當訊息文字。這就是鐵律 2 的實作。
- `execute` 路徑:args 過該 action 的 zod schema,**驗證失敗不重試 LLM**,降級為該 action 的正常 wizard 流程(已收集到的合法 args 預填,缺的逐步問)。
- `none` 路徑:回覆 reply + 附一行「或從選單操作 👇」+ 主選單按鈕。

### 1.3 護欄

- 輸出 JSON parse 失敗 → 直接回主選單,不重試(記 log)。
- 單則訊息只觸發一次 LLM 呼叫,clarify 之後用戶的按鈕回應走純 callback,零 LLM。
- LLM 呼叫逾時 5 秒 → 降級主選單。慢的 agent 比沒有 agent 更傷信任。

---

## 2. Phase 2 — Guard 掛載 + 度量(一天)

### 2.1 Guard(與 PIN_AGENT_CARD.md Phase 3 同一件事,合併實作)

- 用戶文字進 LLM 前過 `@ultraprobe/guard` redact,路由結果中的 args 若含 PII placeholder,用 vault restore 還原後再進 zod——**真實資料只存在於確定性管線內,LLM 看到的永遠是遮蔽版**。這句話放進行銷文案。
- 注入偵測(`result.defense`)記 log,v1 不攔截,觀察誤判率。

### 2.2 度量(決定這功能生死的兩個數字)

jsonStore `agentStats:{isoWeek}`,每次路由記錄:

- **降級率**:clarify + none + parse 失敗 + 逾時 ÷ 總路由次數。
- **誤路由代理指標**:execute 之後用戶在下一動作內按了取消、back、或重新輸入同類請求的比率(沒有人工標註,用行為代理)。
- 卡片戰績區的「LLM 介入 ×k」自動接上真實數字。

### 2.3 Dogfood 退出條件

PPC + 團隊用一個月後看數據再決定下一步。先收集,不預設達標線——但若誤路由代理指標 > 30%,agent 模式對外永不開放,維持內部玩具。誠實寫進 CHECKPOINT.md。

---

## 3. Phase 3 — BYOK(半天)

- **v1 的 BYOK = 部署層級**:self-host 的開發者在 .env 放自己的 `GEMINI_API_KEY`,文件寫清楚即可——這對接 Pin 的開發者已是完整的 BYOK。
- **per-user BYOK 凍結**:在聊天室裡收用戶的 API key 是安全災難——LINE 不能刪訊息,key 會永遠躺在對話紀錄裡;jsonStore 存 key 需要加密層跟金鑰管理。等 hosted 多租戶版本存在再議,且到時走網頁表單不走聊天室。本條寫死。
- landing page(PIN_ONBOARDING B)的 quickstart 加一行:「想要自然語言模式?.env 加一把 Gemini key,`PIN_AGENT_MODE=true`。」——對開發者,這是 Pin 從介面工具升級成 agent 平台的那一行字。

---

## 4. 體驗準則(人類的第一個 agent 該有的樣子)

實作時每個 UX 決策對照這五條,衝突時這五條贏:

1. **看得懂**:`/card` 是 agent 的完整權限清單,agent 模式啟用後卡片加一行「🧠 自然語言模式:開啟」。它能做的事白紙黑字,沒有隱藏能力。
2. **管得住**:不可逆操作(POST/PUT/DELETE 類 action)經 agent 觸發時 preview 強制開啟,即使 SKILL.md 沒宣告 preview——agent 觸發的寫入一律先看後發。這條寫進 actionExecutor,不依賴 skill 作者自覺。
3. **花得明白**:每次 LLM 介入在回覆尾附極小字「🧠×1」。不藏。
4. **會認錯**:clarify 的文案永遠是攤開選項,不是道歉式廢話。「你想發文還是看數據?👇」優於「抱歉我不太確定您的意思」。
5. **不黏人**:任務結束就安靜。不追問「還需要什麼嗎」、不發每日問候、不做任何拉留存的對話設計。webhook 有事才出現。

---

## 5. 留給 PPC 的決策點

1. **觸發方式**:方案 A——任何文字輸入即走 agent 路由(現行 freeform fallback 直接升級,零學習成本);方案 B——需 `/ai` 前綴或模式切換(更可控但多一步)。規格按方案 A 寫,要改說一聲。
2. **Dogfood 名單**:除了你,團隊裡誰進來測?建議拉一個完全非技術背景的人,他的降級率才是真實世界的降級率。
3. **「none」閒聊路徑的人格**:現在規格是極簡(答完附選單)。要不要給 Pin 一點人格語氣,等 agent 命名決策(CARD 文件決策點 1)一起定。
