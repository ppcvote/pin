# PIN_BUTTON_WIRING.md — 產品端「📱 用 LINE 管理」按鈕接入規格

> 交付對象:MindThread / UltraGrowth / Ultra Advisor 各 session 的 Claude
> 從屬於:PIN_DIRECTION.md + PIN_ONBOARDING.md §A + PRODUCT_INTEGRATION.md
> 目的:**Pin runtime 90% 就位,vision 變不變成現實看每個產品有沒有把按鈕裝上去**
> 已示範:UD House 已 ship(social.8338.hk dashboard 已有按鈕)
> 工時/產品:1-2 小時

---

## 0. 為什麼動這個

```
客戶買服務 → 在 Pin 上按幾下 → 服務被控制
↑                                  ↑
你要做的就是這個按鈕              Pin 已經能做了 ✅
```

沒有這顆按鈕,客戶根本不知道可以用 LINE 操控他的訂閱。Pin 對他完全隱形。
有了這顆按鈕,他點一下,Pin 把他的產品投射到 LINE。**這顆按鈕是 Ultra Lab
多產品時代統一控制面的觸發器**。

---

## 1. 按鈕該放哪

**客戶後台 dashboard 的整合區 / 設定區。**

- MindThread:`mindthread.tw/dashboard/integrations` 或側邊 nav 的 settings
- UltraGrowth:客戶月報送達的 email 內 + 後台首頁右上角
- Ultra Advisor:`ultra-advisor.tw/settings` 整合面板

避免:首頁 hero、隨便插一塊。整合區是最合理的脈絡——「我的產品還有什麼可以接的」。

文案建議:

```
📱 用 LINE 管理你的 <ProductName>
   無須 app,LINE 一鍵連接。發文 / 看數據 / 收 lead 推播都在一個 chat 裡。
   [ 立即連接 ]
```

icon 用 LINE 綠 + 一行 description + 一顆 CTA button。

---

## 2. 後端要做的兩件事

### 2.1 拿一支 productApiKey

Pin 用這支 key 驗你產品的合法性。設定:

```
.env (你產品的後端)
PIN_BIND_BASE = https://pin.quartz.tw
                # ⚠️ 這個 URL 會換,先以 Min Yi 告知為準
PIN_PRODUCT_API_KEY = dev_secret_for_pin_testing_123
                # ⚠️ 這個是 dev key,production 用 Min Yi 給的真實 key
PIN_SKILL_NAME = mindthread        # 或 udhouse / ultragrowth / advisor
```

### 2.2 寫一個 endpoint 在你自己後端

```
POST /api/pin/connect-link
  auth: 你自己產品的用戶 session (必須登入)
  body: (可選) { meta: {...} }   ← 任意 JSON,Pin 會原封不動傳回綁定 callback
  
  邏輯:
    1. 認證用戶,拿到他的 tenantKey (你產品內部代表這個用戶的 id)
    2. 呼叫 Pin:
       POST {PIN_BIND_BASE}/bind/token
       Content-Type: application/json
       body: {
         skillName: "{PIN_SKILL_NAME}",
         tenantKey: "<這個用戶的 id>",
         productApiKey: "{PIN_PRODUCT_API_KEY}",
         meta: <body.meta || undefined>
       }
    3. Pin 回 { token, expiresAt }
    4. 你 server 回給前端:
       {
         line_url: "https://line.me/R/oaMessage/@158mrpzk/?bind%20<token>",
         tg_url:   "https://t.me/UltraClaudeBot?start=<token>",   # 二選一,或都給
         expires_at: <expiresAt>
       }
```

⚠️ **token 不要回給前端再讓前端組 URL**——前端可以攔 token 做壞事。Server-side 組 URL。

⚠️ **每次點按鈕都打一次 `/bind/token`**——token 只有 10 分鐘 TTL + 單次使用,別 cache。

### 2.3 前端按鈕的行為

```javascript
// 用戶按下 "📱 用 LINE 管理"
async function onConnectClick() {
  const res = await fetch('/api/pin/connect-link', {
    method: 'POST',
    body: JSON.stringify({
      // 可選:傳一些 metadata 給 Pin 在綁定 welcome 用
      // (例如 UltraGrowth 想在歡迎訊息顯示 AVS before/after)
      meta: {
        // your data here
      }
    })
  })
  const { line_url } = await res.json()

  // 直接跳 LINE (mobile) 或顯示 QR code (desktop)
  if (isMobile()) {
    window.location.href = line_url
  } else {
    showQRModal(line_url)   // 客戶手機掃,進 LINE 完成綁定
  }
}
```

不要把 token 寫進 URL 後 history.pushState — token 會留在瀏覽歷史。

---

## 3. AVS / 自訂歡迎訊息(只 UltraGrowth 用)

UltraGrowth 客戶第一次連接時應該看到「服務介入前 vs 現在」的 AVS 對比作為價值證明。

Pin 端已實作:當 `skillName === "ultragrowth"` 且 meta 帶 `avs_before` + `avs_after` 兩個數字時,綁定回覆會渲染對比訊息。詳見 PIN_FLYWHEEL.md §2 + Pin 的 handle.ts。

你的後端在 `/api/pin/connect-link` 時加:

```javascript
body: {
  skillName: "ultragrowth",
  tenantKey: "<用戶 id>",
  productApiKey: "...",
  meta: {
    avs_before: <他訂閱前的 AVS 分數>,
    avs_after:  <他目前的 AVS 分數>,
  }
}
```

MindThread / Ultra Advisor / UD House 不用這欄。

---

## 4. 驗收標準(每個產品自驗,完成後通知 Pin's Claude)

1. 用一個沒綁過的 LINE 帳號從點擊「📱 用 LINE 管理」到看到 skill 選單 **< 30 秒、零打字**。
2. 過期 token(等 10 分鐘以上再點)→ Pin 回「連結已失效」。
3. 重複點兩次拿到不同 token(沒 cache)。
4. 同一個 LINE 帳號重複綁定 → Pin 覆蓋舊綁定不報錯(冪等)。
5. 移動到電腦的 dashboard → 出現 QR code → 手機掃 → 同樣流程跑通。

---

## 5. 不要做的事(直接違反 PIN_DIRECTION)

- ❌ 不要在你產品端複製 Pin 的功能(發文 wizard、選單等)。那是 Pin 該做的。
- ❌ 不要把 productApiKey 寫進前端(會洩漏)。
- ❌ 不要在你產品端存 Pin 給的 token(無意義,單次使用)。
- ❌ 不要做沙盒 / 試吃流程。Pin 的沙盒(PIN_ONBOARDING §B)是 Pin 端的事,你產品端先做付費客戶的接入。

---

## 6. 需要 Pin's Claude 配合的事

如果你發現:

- Pin 該支援的綁定欄位你需要傳但 spec 沒寫(例如 `meta` 加更多欄位)
- 綁定流程在你的 onboarding 上下文需要不一樣的歡迎文案
- Pin webhook spec 需要對齊新 event

→ 寫一份 reply 文件丟在 `C:\Users\User\HQ\` 或 `C:\Users\User\UltraPin\` 根目錄,
   Min Yi 會看到並轉告 Pin's Claude。

---

## 7. 範例:UD House 已 ship 版本(可參考)

HQ Claude 已在 UD House 完成:`social.8338.hk` dashboard 有「📱 用 LINE 管理」
按鈕,寫法可以直接抄過去調整。問 HQ 要程式碼參考。
