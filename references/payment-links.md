# Payment Links

## When to load
Merchant needs invoices/payment links without building a store: single sends, retokenisation links (`tokeniseCard`), zero-amount PA links, or bulk CSV sends. Also when wiring Payment Links webhooks (Scheme B signing) or configuring links in the Dashboard.

## Product rules (hard constraints)
- Hosted payment page using Checkout internally — supports all Checkout payment methods; actual methods depend on account configuration.
- Delivery channels: email, SMS, WhatsApp, or any combination.
- Successful-transaction email receipts available (docs say "successful transaction email receipts" without specifying recipient — configure and verify who receives them in your Dashboard settings; don't promise customer-vs-merchant attribution).
- **No edits.** Existing links cannot be modified.
- Single full-amount payment per link; no documented partial-payment support `[VERIFY-SANDBOX]` — the docs state links can't be modified; part-payment is undocumented either way.
- To change amount/details: cancel the link (irreversible) and generate a new one.
- Expired link → customer must be sent a new link; the old one never revives.
- Expiry: `expiryTime` in minutes — min **5**, default and max **43200** (= 30 days).
- Bulk: up to **1000** links per batch.
- Dashboard CSV export: up to **20 000** links.
- PDF attachments: ≤ **5MB**.
- Mandatory terms of service: ≤ **30 000** chars.
- FNB acquirer: invoice IDs alnum-only (no special chars) — applies to `merchantInvoiceId` for API integrations too.
- Amounts up to **99999999.99** (API). Bulk CSV row amounts cap at **1000000.00** — ⚠️ version-sensitive — ceilings differ between surfaces; do not assume one number.
- Tokenisation recipes (get customer permission first):
  - `checkout.tokeniseCard:true` + `checkout.paymentType:PA` + `amount:0` → card-registration link, no charge.
  - PA reserves funds but does NOT settle; capture via card API within 7 days if amount > 0.
  - `checkout.tokeniseCard:true` + `DB` → charge + tokenise in one step.
  - `registrationId` arrives only on the `completed` webhook / post-completion status query.
  - Tokens feed the recurring API (card-on-file) — see `recurring-and-tokenisation.md`.

## Own Meta Business Account WhatsApp — OPTIONAL, custom templates only

**Default WhatsApp delivery (`options.sendWhatsapp`) works out of the box with Peach's own template — NO Meta Business Account needed.** The section below applies only if you want your OWN editable/approved WhatsApp template.
Template approval can take up to 24h; you pay per WhatsApp message; Meta policy violations can block your account (Peach is not liable).
- Template category: **Utility**.
- Language: **English** (no locale).
- Header type: **None**.
- Body must use **exactly 4 variables** `{{1}}`–`{{4}}` — no more, no fewer (e.g. greeting / merchant / due date / amount).
- Button: **Visit website**, URL type **Dynamic**.
- Button URL: static part `https://links.peachpayments.com/` + `{{1}}` (payment link ID inserted).
- Prereqs: approved Meta business portfolio, published business app with verified phone number, admin-permission Meta Developer account.
- Setup: create Admin **system user** → assign app asset + generate access token → create/approve template in WhatsApp Manager → get **phone number ID** (differs from WhatsApp Business Account ID) → enter credentials under Dashboard **Payment Links** > **Settings**.
- Peach's own WhatsApp template is NOT editable; email and SMS templates are (Settings page, with Revert to default).

## API
### Endpoint index
| Operation | Call |
|---|---|
| Generate a link | `POST /api/channels/{entityId}/payments` |
| Cancel a link | `DELETE /api/payments/{paymentId}` |
| Query a payment status | `GET /api/payments/{paymentId}` |
| Retrieve all payment links | `GET /api/payments` |
| Upload a PDF attachment | `POST /api/attachments` |
| Download a PDF attachment | `GET /api/payments/{paymentId}/files/{fileId}` |
| Generate batch link (bulk) | `POST /api/channels/{entityId}/payments/batches` |
| Query batches for a channel | `GET /api/channels/{entityId}/payments/batches` |
| Query a batch status | `GET /api/batches/{batchId}` |
| Retrieve batch error files | `GET /api/batches/{batchId}/files` |

**Status response shape** `[DOCS]`: `GET /api/payments/{paymentId}` returns
`{ "payment": { … }, "audit": [ … ] }`. The `payment` object **includes `amount` (number) and
`currency`** (e.g. `ZAR`/`KES`/`USD`) alongside the link's status — so the amount-reconfirm doctrine
(verify the paid amount before fulfilling, `webhooks.md`) DOES work for Payment Links: after a
`completed` webhook, re-query this endpoint and check `payment.amount` matches what you billed.
`registrationId` (when tokenising) also surfaces here post-completion.

### Auth + hosts
- OAuth bearer — `POST {authHost}/api/oauth/token`, JSON `{clientId, clientSecret, merchantId}` → `{access_token, expires_in, token_type:"Bearer"}`; send `Authorization: Bearer {access_token}`; reuse the token until expiry.
- **NOT per-request HMAC.** (HMAC is the Checkout V1 refund/webhook scheme — see `checkout-v2.md`.)
- Hosts: live `https://links.peachpayments.com`, sandbox `https://sandbox-l.ppay.io`. Auth host: live `https://dashboard.peachpayments.com`, sandbox `https://sandbox-dashboard.peachpayments.com`.
- Credentials from Dashboard → **Payment Links** > **Settings** > **API credentials** (+ **Create API credentials**; regenerate client ID/secret if compromised). 400 errors on generate are keyed by dotted path (`payment.amount`, `customer.email`, …).

### Generate a link — `POST /api/channels/{entityId}/payments` → `{url, id}`
- `payment.merchantInvoiceId` — required, 8–16 chars (FNB: alnum only).
- `payment.amount` — required, JSON **number** (not a string); `0` only with PA + `tokeniseCard`.
- `payment.currency` — `ZAR` | `KES` | `USD` (API enum). MUR links are documented at product/Dashboard level via the methods tables even though the API enum omits MUR `[VERIFY-SANDBOX]`.
- `payment.files[]` — attachment fileIds from `POST /api/attachments`.
- `payment.notes` — ≤140 chars.
- `customer.givenName` — required, ≤50.
- `customer.surname`, `customer.billing{street1,city,state,postalCode,country}` — optional.
- `customer.email` — required if `options.sendEmail`.
- `customer.mobile` — required if `options.sendSms`; format `+27123456789`.
- `customer.whatsapp` — required if `options.sendWhatsapp`.
- `options.sendEmail` / `options.sendSms` / `options.sendWhatsapp` — booleans; at least one channel.
- `options.emailCc` / `options.emailBcc` — additional recipients.
- `options.expiryTime` — minutes, 5–43200.
- `options.notificationUrl` — per-link webhook override (see Webhooks).
- `checkout.defaultPaymentMethod` — pin the method (same enum as Checkout).
- `checkout.forceDefaultMethod` — per Peach's public Payment Links FAQ, the Links API supports `defaultPaymentMethod` and `tokeniseCard` but **not** `forceDefaultMethod`. Use `defaultPaymentMethod` to set the preferred method; if you truly need it *forced* on a link, confirm current support with Peach (the FAQ is the authoritative public source, but this behaviour may have changed). `[DOCS]`
- `checkout.tokeniseCard` — card retokenisation (see product rules).
- `checkout.paymentType` — `DB` | `PA` (PA for zero-amount tokenisation or reserved-funds flows).

### Cancel a link — `DELETE /api/payments/{paymentId}`
- Preconditions (ALL three): Checkout payment unpaid; link status `initiated`; link NOT expired.
- Cancel is irreversible — the link can never return to a payable state. Regenerate a new link for any change.

### Query status — `GET /api/payments/{paymentId}`
- Status enum: `initiated | processing | expired | cancelled | completed` (⚠️ query-status enum omits `opened` even though the `opened` webhook exists).
- Also returns `checkout.registrationId`, `checkout.checkoutId`, `checkout.transactionUniqueId`, `checkout.resultCode`, `checkout.paymentBrand`.
- `source`: `API | Xero | UI` — tells you where the link was created.

### Retrieve all — `GET /api/payments`
- Filters: `startDate`/`endDate`, `status`, `amount` + operator (`lt|lte|gt|gte|eq`), sending options.
- Header `Accept: text/csv` → CSV export of the filtered set (Dashboard caps exports at 20 000 links; Dashboard path: **Payment Links** > **My links** > **Download a CSV**).

### Attachments
- `POST /api/attachments` — multipart `file`, **PDF ≤5MB** → `{fileId}`; attach via `payment.files[]` at generate time.
- `GET /api/payments/{paymentId}/files/{fileId}` — download a link's attachment.

### Bulk — create → PUT CSV → async
1. `POST /api/channels/{entityId}/payments/batches` body `{filename (≤256), notificationUrl (≤128)}` → `{id, url}`. Store the id for status queries.
2. `PUT` the CSV to the returned `url` with `Content-Type: text/csv` (`--data-binary '@file.csv'`). `200` = upload accepted.
3. Processing is **asynchronous**; batch expires if no file is uploaded within **3 hours**.
4. `GET /api/batches/{batchId}` → status `initiated | processing | completed | error` (+ `successfulRows`, `totalRows`, `errorCode`).
5. `GET /api/channels/{entityId}/payments/batches` — list batches for the channel.
6. Error files: `GET /api/batches/{batchId}/files` — download the CSV error file + error-details TXT; fix the rejected rows in the error file and resubmit so remaining rows process.
- Uploaded CSVs are **deleted after 90 days**.
- Each generated link still sends its own per-link webhooks as customers open/pay them.

## Bulk CSV (exact)
Fixed columns, no custom parameters, **≤1000 rows**:
| Column | Condition | Format |
|---|---|---|
| `INVOICE_ID` | Required | `[a-zA-Z0-9]{8,16}` |
| `AMOUNT` | Required | `0.01–1000000.00`, `[0-9]{1,10}(.[0-9]{2})?` |
| `CUSTOMER_SURNAME` / `CUSTOMER_GIVEN_NAME` | Required | 2–50 chars; truncated after 48 |
| `CURRENCY` | Required | `[A-Z]{3}` ISO 4217 |
| `CUSTOMER_EMAIL` | Conditional (req if `SEND_EMAIL` true) | 6–128 chars |
| `CUSTOMER_MOBILE` / `CUSTOMER_WHATSAPP` | Conditional (req if SMS/WhatsApp true) | 5–25 chars, `+27123456789` |
| `SEND_EMAIL` / `SEND_SMS` / `SEND_WHATSAPP` | Conditional | true: `true|yes|y|1`; false: `false|no|n|0|blank` |
| `NOTES` | Optional | ≤140 |
| `EXPIRY_TIME` | Optional | 5–43200 minutes |
| `BILLING_STREET1` / `_CITY` / `_STATE` / `_POSTALCODE` / `_COUNTRY` | Optional | 100/48/50/16 chars; country ISO 3166-1 alpha-2 (`BILLING_CITY` mandatory for 3DS2) |
| `EMAIL_CC` / `EMAIL_BCC` | Optional | ≤128, comma-separated |

Plus-sign trap: spreadsheets strip the leading `+` from mobile numbers on save. Workaround: save as `.xlsx`, rename the extension to `.csv`, upload the renamed file.

## Webhooks (Scheme B)
Two configurations: Dashboard-configured webhook URL, or `options.notificationUrl` per link/batch — **`notificationUrl` overrides the Dashboard webhook**.
Return HTTP 200; non-200 retries: 2, 4, 8, 15, 30 min, 1 h, then daily to **30 days**.
Order NOT guaranteed — correlate via `paymentId` and status, not sequence.
- Link events: `initiated | opened | processing | completed | cancelled | expired`.
- Batch events: `initiated | processing | completed | error | expired` (`expired` = no upload in 3h).
- Payment Links also **relays Checkout webhooks** (checkout created/pending/successful etc.) unless support disables relaying — parse both event families on the same endpoint.

### Per-event payload fields (JSON)
| Event | Fields |
|---|---|
| `initiated` | `paymentId`, `status`, `url` (the link URL, e.g. `https://l.ppay.io/<id>`) |
| `opened` | `paymentId`, `status` |
| `processing` | `paymentId`, `status` |
| `completed` | `paymentId`, `status`, `paymentBrand`, `registrationId` (optional) |
| `cancelled` | `paymentId`, `status` |
| `expired` | `paymentId`, `status` |

- `paymentId` is a UUID (e.g. `00d886d6-4754-4bcc-b88f-74a53d5220e5`) — the same id used by the status/cancel endpoints.
- `paymentBrand` enum: `VISA`, `MASTER`, `DINERS`, `AMEX`, `MASTERPASS`, `MOBICRED`, `MPESA`, `1FORYOU`, `APLUS`, `PAYPAL`, `ZEROPAY`, `PAYFLEX`, `BLINKBYEMTEL`, `CAPITECPAY`, `MCBJUICE`, `PEACHEFT` (docs' enum; brand enums vary across Peach surfaces — never hard-match).
- `registrationId` present ONLY when `tokeniseCard` was true on the request AND the brand is a card type — **registrationId only on `completed`**.
- **Scheme B header signing**: headers `x-webhook-signature-algorithm`, `x-webhook-timestamp`, `x-webhook-id`, `x-webhook-signature`.
- Enable under Dashboard **Webhook security** (role-gated); copy the shared secret; **regenerating the secret takes effect immediately**; disable/re-enable without regenerating reuses the existing key.
- Verbatim canonical message — HMAC-SHA256, hex digest (`runnable` — verbatim docs construction, replace placeholder values):
  ```js
  const message = `${timestamp}.${webhookId}.${url}.${payload}`;
  // timestamp  = x-webhook-timestamp header
  // webhookId  = x-webhook-id header (replay protection + idempotency key)
  // url        = YOUR CONFIGURED WEBHOOK URL — must match exactly
  // payload    = RAW request body, untouched
  ```
- **Payment Links body is JSON** — verify against the raw body bytes. (Checkout sends form-urlencoded; see `webhooks.md` Scheme A/B split.)
- **BULK (batch) WEBHOOKS ARE NOT SIGNED — they are spoofable.** Do not enforce signature verification on batch events (it will never pass), but never move money or mutate order/state on a batch event alone: treat it as an unauthenticated nudge and confirm server-side via `GET /api/batches/{id}` first.
- Payment Links also **relays Checkout webhooks** (checkout created/pending/successful etc.) unless support disables relaying — parse both event families on the same endpoint.

## Payment Links API ≠ Checkout API
Standalone API despite using Checkout internally. Parameter overlap with `POST /v2/checkout` is only `defaultPaymentMethod` + `tokeniseCard`. No `merchantTransactionId`, `nonce`, `shopperResultUrl`, `customParameters`, `standingInstruction`, `cancelUrl`, etc. `forceDefaultMethod` is not a documented Links parameter (public FAQ — see above).

## Dashboard operations (for context in agent answers)
- Create/single-send and bulk-send flows also exist fully in the Dashboard (no code needed).
- Cancel (role-gated): **Payment Links** > **My links** > click link > **Cancel link** (upper right of details panel) > **Confirm** — only `initiated` links.
- Filter: **My links** > select filters > **Apply**; **Clear** removes them.
- Export: **My links** > filters as needed > **Download a CSV** (upper right) — up to 20 000 links.
- Templates: **Payment Links** > **Settings** > **Email** or **SMS** section > edit with placeholders > **Save** (**Revert to default** available); role-gated.
- ToS: **Settings** > **Legal policy** > paste ToS (≤30 000 chars) > optionally tick **Require your customers to consent to your terms of service** > **Save**.
- Bulk with errors (`Completed with errors`): click the batch row → download error details TXT + CSV error file → fix the rejected rows per the error details → resubmit for processing of the remaining rows.

## Traps
- **Double-pay trap**: customer clicks Pay now, closes the checkout window (or opens two windows) → link stuck in `processing` with the Pay now button still active → customer can pay twice. Build your own re-payment prevention; rejecting a second `completed` per invoice ID is a sound merchant-side guard — our practice, not a documented Peach feature.
- Cancel preconditions: only `initiated`, unexpired, unpaid links cancel; anything else must run out the clock (max 30 days) — set `expiryTime` deliberately when you may need to retract offers.
- `registrationId` absent from `initiated`/`processing` webhooks — never build token capture on early events.
- Batch webhooks unsigned while link webhooks are signed — a strict verifier silently drops ALL batch notifications.
- Batch `expired` ≠ link `expired`: batch expiry = no CSV uploaded within 3h of batch creation.
- CSV boolean parsing accepts `yes/y/1` — a stray `1` in `SEND_WHATSAPP` makes `CUSTOMER_WHATSAPP` required and fails the row.
- Amount ceilings differ (API vs CSV) — validate per surface.
- Sandbox limitation: Payment Links in sandbox = email delivery only (no SMS/WhatsApp).
- The `url` in the signature message is your configured webhook URL string, NOT the event's link `url` field — mixing them fails verification.
- FNB invoice IDs: special chars rejected at generate time — validate `merchantInvoiceId` client-side for alnum-only when FNB is the acquirer.
