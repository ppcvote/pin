# PIN_APPLY_SPEC.md — 申請制自助上架 v1

> 一句話：**讓人只用手機，把一個 Vercel 網頁變成 Telegram 裡可點的 Pin 選單——送申請，PPC 一個人核准。**
> 從屬於 `PIN_DIRECTION.md`。這是 onboarding（申請+核准），**不是市集**（無瀏覽他人 skill）→ NOT-DO #1 守得住。核准閘本身即「不做市集」的保證。

## 0. 受眾與範圍判斷（定案）

大部分 vibe 的人**手上只有一個網頁，而且只能做到網頁**——不會再做 API、不會改 code。所以 v1 不是「接你的 API」，是「把你的網頁變成選單」。

**v1 = 連結選單 only。** 生成的 skill 只有 URL 按鈕（點了在用戶自己瀏覽器開），**runtime 對用戶網域零外呼**。真資料 app（要 `api:` 呼叫 + 密鑰庫）排 **v2**，等有人真的要再開。

## 1. 兩邊都在手機上的流程

**申請人（@UltraPinaibot 裡）**
1. `/apply` → 「貼上你的網址」
2. 貼 `https://myapp.vercel.app` → Pin 伺服器端**安全地**讀那頁 → LLM 提案 {圖示, 名稱, 3–5 顆按鈕(指向站內頁面)}
3. 預覽選單長怎樣 → `[✅ 送出申請] [✏️ 換個網址] [❌ 取消]`
4. 送出 → 「已送出，審核中」

**PPC（唯一審核人）**
1. `/apps` → 列出 pending 申請（owner-only，非 PPC 視為未知指令）
2. 點一個 → 看網址、提案預覽、ATR 掃描結果 → `[✅ 核准] [❌ 退回]`
3. 核准 → 生成 SKILL.md、ATR 掃、熱載入、申請人收到「你的 Pin 上線了 🎉」

## 2. 四道安全閘（PPC 列為最重要）

1. **出口過濾（申請時讀頁那一下，唯一擋不到人工閘的點）**：`src/platform/safeFetch.ts`。只准 https；DNS 解析後封鎖 private / loopback / link-local / 雲端 metadata（10/8、172.16/12、192.168/16、127/8、169.254/16、`::1`、`fc00::/7`）；限大小（512KB）、限時（8s）、redirect ≤2 且每跳重驗。
2. **same-origin 限制**：生成的每顆按鈕 URL 強制落在申請網域內。同時擋掉「惡意網頁塞 prompt injection 騙 LLM 生外連惡意連結」。
3. **ATR 掃描**：生成的 SKILL.md 過 `scanSkillContent`（protection #6，已有），critical 拒。
4. **PPC 人工核准**：最終閘。流量小、一人手機按幾下。

> runtime 安全來自 v1 的狠簡化：核准後 Pin 對用戶網域**零呼叫**（純 URL 按鈕）。上一版設計最尖的 SSRF/開放代理風險在 runtime 不存在；唯一伺服器主動外呼是申請時讀頁，由閘 1 擋。

## 3. 資料模型

**Application**（`data/applications/<appId>.json`，新 store）
```
{ id, owner: "<channel>:<userId>", ownerName, status: pending|approved|rejected,
  url, origin, proposal: { name, icon, display_name, buttons: [{label, url}] },
  skillId?, createdAt, decidedAt?, reason? }
```

**生成的 user-skill**（`data/user-skills/<skillId>/SKILL.md`）
- 連結選單形狀：單 action `open`，`api.url` 錨定 Pin 自家 `http://127.0.0.1:<PIN_HTTP_PORT>/ping`（恆回 200 JSON，滿足 executor 的 2xx-JSON 閘，不要求用戶有 API），`respond.follow_up_urls` = 提案按鈕。
- 新欄位 `metadata.pin.owner: "<channel>:<userId>"` → 擁有者私有可見。
- 跟內建 skill 同樣經 `loadSkill`（含 ATR）。`loadAllSkills` 擴充為**也掃** `data/user-skills/`。

**擁有者可見過濾**（menu）
- `skill.pin.owner` 未設 → 公開（現狀，內建 6 skill 不變）
- `owner === 觀看者 userKey` → 可見
- 觀看者 = PPC（`OWNER_CHAT_ID`）→ 全見
- 否則隱藏

## 4. 整合點（要動的檔案）

- `src/platform/safeFetch.ts`（新）— 出口過濾 + 讀頁 + 抽 title/og/同源連結
- `src/platform/applicationStore.ts`（新）— application CRUD（atomic，仿 jsonStore）
- `src/platform/userSkillGen.ts`（新）— 提案→SKILL.md 字串、寫檔、same-origin 過濾
- `src/server/webhooks.ts` — 加 `GET /ping` → `{ok:true}`
- `src/platform/skillLoader.ts` — `owner` 欄位入 PinExtension；`loadAllSkills` 加掃 user-skills 目錄
- `src/platform/types.ts` — PinExtension 加 `owner?`
- `src/storage/jsonStore.ts` — UserRecord 加 `apply?` 對話狀態
- `src/core/handle.ts` — `/apply` 對話、`/apps` 審核、`ap:*` callbacks、menu owner 過濾
- `src/platform/registry.ts` — 熱新增（push）+ 重載輔助
- `.env.example` — 確認 `OWNER_CHAT_ID`（格式 `tg:<id>`）

## 5. v1 / v2 邊界

- **v1**：連結選單、無密鑰、runtime 零外呼、PPC 核准、擁有者私有。
- **v2**（不做）：真 `api:` 動作（要 per-skill 加密密鑰庫 + runtime 出口過濾）、公開可見選項、多審核人。

## 6. 驗收（機器可判定 + 一次真人）

- 陌生 TG 帳號 `/apply` 貼一個 https 網址 → 30 秒內看到自己的選單預覽 → 送出。
- PPC `/apps` 看得到、核准後該帳號 `/menu` 出現新 skill、**其他帳號看不到**。
- 出口過濾單測：`http://`、`http://127.0.0.1`、`http://169.254.169.254` 一律拒。
- same-origin 單測：提案含外網 URL → 被丟棄。
- 全程 `npm test` 綠。
