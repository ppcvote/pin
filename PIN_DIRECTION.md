# PIN_DIRECTION.md — Pin 開發方向書 v1.0

> 交付對象：Pin repo 內的 Claude（Opus 4.6）
> 作者：PPC × Claude（claude.ai 策略對話，2026/06/11）
> 效力：本文件是 Pin 的最高層決策依據。與 README、舊 spec、或對話中的臨時想法衝突時,以本文件為準,除非 PPC 明確推翻。

---

## 0. 一句話定位

**Pin 是「確定性優先」的 Agent Skills consumer runtime:讓 SaaS 產品用一個 SKILL.md,就在通訊軟體上長出按鈕選單操作介面。**

對照組是 OpenClaw。OpenClaw 的哲學是給 agent 最大自主權,每則訊息過 LLM,不可控是設計使然。Pin 的哲學相反:**人類很多時候只想按幾下把事情辦完**。確定性、零 token 成本、零幻覺的按鈕執行是主菜,LLM 是備援不是核心。任何讓 Pin 變得更像 OpenClaw 的提案,預設拒絕。

---

## 1. 戰略結論(背景,不需重新辯論)

這些是已經想清楚的判斷,開發時直接採用:

1. **Agent Skills 標準已起飛**(2025/12 開放,32+ adopters,AAIF 治理),但沒有人做 consumer-grade runtime。這個空位真實存在。
2. **規格化本身不是生意。** 賺錢的是參考實作,不是 spec。`PIN_SKILL_SPEC.md` 維持最小可用即可,不追求規格完備性。
3. **大公司風險已評估過**:官方標準若收編 structured actions,對 Pin 是利多(需求被驗證,runtime 現成);OpenClaw 不會來做無聊的確定性選單,DNA 相反;Anthropic 官方 channel 是通用智能入口,不會替台灣房仲在 LINE 上畫按鈕。Pin 守的位置是「不性感所以沒人搶」的確定性 UX。
4. **Pin 目前最誠實的身分是 Ultralab portfolio 的膠水層**(MindThread + UD House)。這已經值回票價。對外發展的前提是三個月內出現一個非 PPC 本人的外部 adopter。
5. **MindThread 教訓直接適用**:不要在驗證需求前蓋基礎設施。150 註冊 0 付費的劇本不准重演。

---

## 2. 優先序(P0 → P3)

### P0 — LINE Adapter(最高優先,先於一切)

理由:Telegram 在台灣是小眾,Pin 的目標市場(台灣/香港中小 SaaS)活在 LINE 上。OpenClaw 的 LINE 支援是開發者玩具。「丟一個 SKILL.md,你的產品就有 LINE 選單介面」是一句話講得完的 pitch,而且短期內沒人搶。

實作要求:

- 實作 `src/channels/line.ts`,遵守現有 `Channel` interface(`src/channels/types.ts`),不准為了 LINE 改動 core 抽象。如果 interface 真的不夠用,先在 PR 說明裡論證,改 interface 是大事。
- 用 LINE Messaging API 官方 SDK(`@line/bot-sdk`)。
- 按鈕對應:Pin 的 `Button[][]` inline keyboard → LINE 的 Flex Message 或 Quick Reply。注意 LINE 限制:Quick Reply 最多 13 顆、會在使用者回覆後消失;Flex Message 才是持久選單。預設用 Flex Message bubble + button components,`url` 按鈕用 URI action,`callback_data` 用 Postback action。
- `respond.template` 的輸出在 LINE 沒有 markdown,`parseMode` 對 LINE adapter 一律降級為 plain。emoji 保留。
- LINE 的 webhook 模式(沒有 long polling),需要 HTTPS endpoint——掛進現有的 `src/server/webhooks.ts` HTTP server,路徑 `/line/webhook`,驗 `x-line-signature`。
- `OutboundReply.edit = true` 在 LINE 做不到(LINE 不能編輯已送訊息),fallback 為發送新訊息。這個 fallback 寫在 adapter 層,core 不知情。
- 完成定義:MindThread 跟 UD House 兩個 skill 在 LINE 上全功能可跑,包括 wizard 流程(args 逐步收集)跟 webhook 推播。

### P1 — Webhook 推播閉環打磨

這是 Pin 真正的付費理由:**產品事件主動找到用戶,帶著可按的後續動作**。UD House 的 `lead.created` → 「🔥 新 lead!」→ 按鈕「看物件詳細」是範本。

實作要求:

- Webhook 簽名驗證強制化:每個 `metadata.pin.webhooks[].secret` 必須驗證(HMAC-SHA256 over raw body),驗不過回 401 並記 log。現在如果是選配,改成必配。
- 推播路由:webhook 進來時要知道推給哪個 user。實作 user↔product 綁定表(`jsonStore` 即可,schema:`{channelId, userId, skillName, tenantKey}`),綁定動作做成 Pin 內建 action(用戶按「綁定通知」→ 產生一次性 token → 產品端 API 帶 token 回呼確認)。不要硬編 chat_id。
- 失敗重試:推播失敗(用戶封鎖 bot、網路錯誤)記入 dead letter(jsonStore),不重試超過 3 次,不阻塞其他推播。
- 完成定義:UD House 新 lead 從 webhook 進來到 LINE/TG 推播含按鈕,全程 < 3 秒,簽名驗證有測試覆蓋。

### P2 — Dogfooding 深化

讓 MindThread 跟 UD House 把 Pin 用到極限,runtime 跑在真實營收上的時間是護城河。

- MindThread skill 補齊:發文 action 的 `preview` + `confirm_action` 流程(先看草稿再確認發布),這是 spec 裡寫了但要確保 runtime 真的穩。
- 每次在 dogfooding 中發現 runtime 缺陷,修 runtime 不是繞過去。繞過去的 hack 會變成第二個龍蝦艦隊(架構上只有一個功能穩定的系統)。

### P3 — 標準提案(低工時、高賠率的選擇權)

- 整理一份「menu-driven consumer execution」use case 提案,發到 github.com/agentskills/agentskills 的 discussion。內容:問題陳述(消費者場景需要確定性執行,LLM 路由有成本/延遲/幻覺問題)、Pin 的 `metadata.pin` 作為 prior art、不要求標準採納特定設計。
- 目的是把這個問題跟 Pin 綁定,不是推銷 Pin 的 schema。語氣放低,工時控制在一天內。

---

## 3. 明確不做清單(NOT-DO)

沒有 PPC 明確指示前,以下一律不開工,提了也要被你(Pin 的 Claude)擋下來:

1. **Marketplace / pin.skills.io registry** — 沒有外部 adopter 前是空中樓閣。
2. **Discord / WhatsApp / Slack adapter** — LINE 之後才考慮,而且要有具體需求方。
3. **更多 LLM brain 整合** — brain 是 fallback,現有 Gemini/Ollama 夠了。不加 OpenAI、不加 Claude API 串接、不做 LLM 路由優化。
4. **Web dashboard / 管理後台** — 用 `/menu` 跟 jsonStore 撐到撐不住為止。
5. **資料庫升級**(Postgres/SQLite)— jsonStore 在單一用戶 + 個位數外部用戶的規模完全夠。出現具體效能問題再說。
6. **spec 完備化** — 不為了「規格看起來專業」加欄位。每個新欄位都要有一個真實 skill 正在用它。
7. **泛用 AI 助理功能**(行事曆、提醒、筆記的功能擴張)— `skills/expense.ts`、`notes.ts`、`reminders.ts` 維持現狀或淘汰,它們是早期實驗,方向是 OpenClaw 的地盤,Pin 不去。

---

## 4. 技術原則

1. **確定性優先**:任何流程能用按鈕 + template 解決,就不准過 LLM。LLM 只出現在兩處——freeform text fallback 路由、`respond.summarize_with`。
2. **Channel 抽象神聖不可侵犯**:core 跟 platform 層不准 import 任何 channel SDK。channel 特性差異(編輯訊息、markdown、按鈕上限)在 adapter 層吸收。
3. **`metadata.pin` 只擴充不污染**:SKILL.md 的標準欄位(name、description、prose body)必須維持在 stock Agent Skills 工具裡可用。每次改 spec 都要驗證:同一份 SKILL.md 丟進 Claude Code 還能正常當 skill 用。
4. **Secrets 永不落地**:env 解析只在 actionExecutor,template 渲染前過濾任何長得像 secret 的值(bearer token、api key pattern),推播訊息跟 log 都不准出現。
5. **入站皆不可信**:webhook body、用戶 text input、callback data 全部過 zod 驗證。callback data 只接受已註冊的 action id + 白名單 args,不執行任何拼接出來的東西。這點是 Pin 對 OpenClaw 的安全敘事差異,要守住。
6. **檔案規模紀律**:單檔超過 300 行先想想是不是抽象錯了。現在最大的 actionExecutor 184 行,健康,維持。

---

## 5. 三個月檢查點(2026/09 前)

到期時回答這三題,答案寫進 repo 的 `CHECKPOINT.md`:

1. 有沒有至少一個非 PPC 的外部開發者,用 Pin 包了他自己的產品?
2. MindThread / UD House 的終端用戶,每週透過 Pin 按鈕完成多少次操作?(埋個簡單 counter 進 actionExecutor,jsonStore 記就好)
3. License 決定了沒?選項只有兩個:MIT core + 收費 hosted(生態玩法),或承認商業產品拿掉「open」字樣。現在的 source-available + README 寫 open 是自相矛盾,最遲檢查點前要選邊。

第 1 題答「沒有」→ Pin 降級為內部工具,P3 以下全部凍結,只維護 P0–P2 中支撐 MindThread/UD House 營運的部分。這不是失敗,是止損紀律。

---

## 6. 給 Pin 的 Claude 的工作守則

- PPC 的風格:繁體中文、短句直接、prototype-first、自己做決策。只在**真正的決策分叉點**停下來問,其他一律先做出能跑的版本再迭代。
- 不確定優先序時,回到第 2 節。第 2 節解決不了,預設選「對 MindThread/UD House 營運有直接幫助」的那條路。
- 任何工作開始前先問自己:這是在做 P0–P3,還是在做 NOT-DO 清單上的東西的變形?是後者就停下來明講。
- commit message 用英文,文件跟用戶面文案用繁體中文。
- 本文件由 PPC 更新。你可以提議修改,但不要自行改寫戰略結論。
