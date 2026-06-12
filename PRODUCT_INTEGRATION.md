# Product Integration — Pin Onboarding (Phase A)

> For product backends (UD House, MindThread, etc.) that want a one-tap
> "📱 用 LINE 管理" / "📱 在 Telegram 開啟" button on their dashboard.

This is the spec your backend needs to follow to issue a Pin bind link.
Pin's side is shipped — you just call `/bind/token` from your server.

## Flow

```
[Realtor's dashboard]                  [Pin]                    [Realtor's LINE]
        │
        │ 1. realtor clicks "📱 用 LINE 管理"
        ▼
    backend POST /bind/token ─────────────► returns {token, expiresAt}
        │                                        token: 32-hex, single-use, 10 min TTL
        │ 2. backend redirects to deep link
        ▼
    https://line.me/R/oaMessage/@158mrpzk/?bind%20<token>
        │
        │ 3. LINE app opens, message prefilled
        ▼
                                                                  realtor taps Send
                                                                   "bind <token>"
                                                                          │
                                                                          ▼
                                                              ┌────────────────┐
                                                              │  Pin redeems   │◄────
                                                              │  token, binds  │
                                                              │  this LINE     │
                                                              │  user to       │
                                                              │  tenantKey     │
                                                              └────────────────┘
                                                                          │
                                                                          ▼
                                                              "✅ 已連接 🏠 UD House"
                                                                + skill menu
```

## 1. Get a token

```http
POST https://<pin-host>/bind/token
Content-Type: application/json

{
  "skillName":     "udhouse",
  "tenantKey":     "<your internal id for this user, e.g. realtor uid>",
  "productApiKey": "<value of UDH_WEBHOOK_SECRET — same secret you sign webhooks with>"
}
```

Response (200):

```json
{
  "token":     "127fb261aefa6a8b4058e8fe2f82709a",
  "expiresAt": "2026-06-11T18:45:13.174Z"
}
```

Errors:

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{"error":"skillName_tenantKey_productApiKey_required"}` | missing field |
| 401 | `{"error":"bad_product_api_key"}` | secret mismatch |
| 404 | `{"error":"unknown_skill"}` | skill not loaded in Pin |
| 403 | `{"error":"skill_does_not_support_binding"}` | skill has no webhooks declared |
| 429 | `{"error":"rate_limited","retryAfterSeconds":3600}` | > 60 tokens/hour for this skill |

Rate limit: **60 token issuances per hour per skill** (only authenticated
requests count). If you hit it organically, batch your dashboard's button
clicks less aggressively — a token should be minted per click, not per
page load.

## 2. Compose the deep link

### LINE

The Pin OA basic ID is `@158mrpzk`. Compose:

```
https://line.me/R/oaMessage/@158mrpzk/?bind%20{token}
```

When the user taps this from your dashboard:
- If they've added the OA: the chat opens with "bind {token}" prefilled, one tap sends.
- If they haven't: LINE prompts to add the OA first, then prefills.

### Telegram

The bot username is `@UltraPinaibot`. Compose:

```
https://t.me/UltraPinaibot?start={token}
```

Tapping opens the chat in the TG app with a [Start] button; tapping Start
fires `/start <token>` to Pin.

## 3. What you can do with the binding

Once the user is bound, **subsequent webhook pushes** from your backend
target their `pin_user_id` directly. You can call Pin's existing
`/webhooks/<skill>/<event>` endpoint with:

```json
{
  "pin_user_id": "<channelId>:<userId>",
  "data": { /* event-specific payload */ }
}
```

You won't know the `pin_user_id` until the binding happens. Two patterns:

- **Eager**: store the binding outcome on your side. Pin will reply OK to
  the user's chat after redemption; if you want server-side confirmation,
  call `POST /webhooks/_bind` with the token *before* it's redeemed —
  Pin returns `{pin_user_id, skill_id}` and consumes it. (This is the
  P1c flow — see WEBHOOK_SPEC_FOR_PRODUCTS.md.)
- **Lazy**: keep the token-issuance event as your trigger and reconcile
  later via a "list bound users" admin endpoint. Pin doesn't ship this
  today; ask if you need it.

The simpler thing for v1: rely on Pin's chat confirmation to the user.
Your dashboard can show "Sent — please open LINE and confirm" without
needing to know the result server-side. The bind flow itself is what we
optimised — not the bookkeeping around it.

## 4. Security rules

- HTTPS only.
- `productApiKey` MUST match the skill's webhook secret (the one in
  Pin's env as `<SKILL>_WEBHOOK_SECRET`). If you rotate the secret,
  bind-token issuance breaks until both sides update — fail closed.
- Token lifetime is 10 minutes, single-use. Don't log it.
- If the user fails to redeem in time, issue a new one. There's no
  refund / reuse path.

## 4b. Redemption edge cases (Pin handles these — for your support docs)

- **Double-tap**: LINE keeps the prefilled message after sending; users
  often send "bind {token}" twice. The second send gets an idempotent
  "已連接" reply, not an error.
- **Re-bind**: the same user clicking your dashboard button again (new
  device, re-onboarding) gets a fresh token and a "已重新連接" reply;
  their Pin-side settings survive. If the new token carries a different
  `tenantKey`, the binding switches to it.
- **Lost prefill**: a user who had to add the OA as a friend first may
  lose the prefilled message. Pin's follow-event welcome tells them to
  go back to your page and click the button again — make sure your
  button mints a fresh token on every click.
- **Expired/used/foreign token**: one generic "連結已失效" reply, no
  reason disclosed.

## 5. Acceptance test

PPC's manual test target from PIN_ONBOARDING §A: an unbound LINE account
goes from clicking your dashboard button to seeing the skill menu in
**< 30 seconds, zero typing** (one tap to send the prefilled message).

If that target breaks for your product's flow, ping me (open an issue
on github.com/ppcvote/pin) — usually the fix is on the link composition
side, not in Pin's runtime.
