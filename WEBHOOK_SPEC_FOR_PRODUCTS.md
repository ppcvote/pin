# Pin Webhook Spec — for product backends

This is what a product backend needs to do to push notifications to a user's
preferred channel (Telegram today, more later) via Pin.

## TL;DR for product backend authors (e.g. UD House team)

1. When something user-relevant happens (new lead, listing status change, post published, etc.), POST to:

```
POST https://<pin-host>/webhooks/<skill>/<event>
```

2. Sign the body with `HMAC-SHA256(secret, body_bytes)`, send as header:

```
X-Pin-Signature: sha256=<hex_digest>
```

3. Body shape:

```json
{
  "pin_user_id": "tg:781284060",
  "data": { /* event-specific payload */ }
}
```

Pin will look up the matching `webhooks:` entry in the skill's `SKILL.md`,
render the notification template with `data`, and deliver via the user's
channel.

## What gets pushed to the user

Whatever the skill author wrote in `metadata.pin.webhooks[].notify`. Example
from `skills/udhouse/SKILL.md`:

```yaml
- event: lead.created
  secret: UDH_WEBHOOK_SECRET
  notify:
    template: |
      🔥 新 lead!
      👤 {{data.lead.name}} ({{data.lead.phone}})
      🏠 看的是: {{data.lead.listing_title}}
      🌡️ 熱度: {{data.lead.temperature}}/10
    buttons:
      - label: 看物件詳細
        action: get_listing
        args:
          listing_id: "{{data.lead.listing_id}}"
      - label: 開分享頁
        url: "{{data.lead.share_url}}"
```

→ User receives a Telegram message with the rendered text + two inline
buttons (one drills into Pin's `get_listing` action, the other opens the
share URL).

## Signature computation

```python
import hashlib, hmac, json, requests

secret = os.environ["UDH_WEBHOOK_SECRET"].encode()
body   = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
sig    = hmac.new(secret, body, hashlib.sha256).hexdigest()

requests.post(
    f"https://pin.your-domain.tw/webhooks/udhouse/lead.created",
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-Pin-Signature": f"sha256={sig}",
    },
)
```

Critical: sign the **bytes** you actually transmit, not a re-serialized JSON.
Otherwise key order / whitespace can break the hash.

```js
// Node.js equivalent
import crypto from 'node:crypto'
const body = JSON.stringify(payload)
const sig  = crypto.createHmac('sha256', secret).update(body).digest('hex')
await fetch(url, {
  method: 'POST',
  body,
  headers: {
    'Content-Type': 'application/json',
    'X-Pin-Signature': `sha256=${sig}`,
  },
})
```

## `pin_user_id` format

`<channel_id>:<user_id_within_channel>` — e.g. `tg:781284060`.

- `tg:<chat_id>` — Telegram chat id (DM channel)
- `discord:<user_id>` — Discord user id (when Discord channel ships)
- `line:<user_id>` — LINE user id (when LINE ships)
- `web:<email>` — web channel user (when ships)

The product backend stores `pin_user_id` against the realtor / account /
whatever the event ties back to. Pin doesn't manage that mapping — it just
routes to whichever channel + id you say.

## What needs to exist on UD House backend (HQ Claude punch list)

Per [skills/udhouse/SKILL.md](./skills/udhouse/SKILL.md) currently declares:

| Event | Triggered when | Payload shape |
|---|---|---|
| `lead.created` | New lead from share page | `{ pin_user_id, data: { lead: { name, phone, listing_id, listing_title, temperature, share_url } } }` |
| `listing.status_changed` | Status field changes | `{ pin_user_id, data: { listing: { id, title, status } } }` |

To enable them, UD House backend needs:

1. **Where realtor → pin_user_id mapping lives** — probably a `pin_user_id` field on the realtor's account
2. **Webhook dispatch on event** — fire the POST when the event happens
3. **Retry on 5xx** — at-least-once delivery; Pin is idempotent on receive
4. **`UDH_WEBHOOK_SECRET` shared with Pin** — set in both UD House backend env and Pin env

Additional product-write endpoints Pin already references (skills/udhouse/SKILL.md):

- `PATCH /api/v1/listings/:id/status` — change status (currently 405)
- `POST /api/v1/listings/:id/photos` — upload photos (not yet exposed)

These unlock "edit status / upload from TG" directly in Pin's listing detail view.

## Error responses

| Status | Meaning |
|---|---|
| 200 | Delivered |
| 400 | Bad body / unknown `pin_user_id` format / channel not supported |
| 401 | Signature missing or invalid |
| 404 | Skill or event not declared in Pin's registry |
| 413 | Body too large (> 1 MB) |
| 502 | Channel delivery failed (retry) |

## Health check

`GET /health` → `{ "ok": true, "service": "pin", "version": "0.1.0" }`

Use this for Vercel / Cloudflare health probes, or to verify Pin is reachable
from your backend network.
