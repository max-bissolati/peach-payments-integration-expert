# Get Paid Without a Store

## When to load
Load when there's no website/store: invoices, donations, services, deposits — "how do I collect money from customers without building a checkout?"

## Decision tree

```
What shape is the collection?
├─ One-off / a few invoices → Payment Links (Dashboard for ad-hoc, API for volume)
├─ Recurring invoices (same customer, repeating) → Xero connection (repeating invoices)
├─ One durable public page (social bio, QR on an invoice/flyer) → Payment Page
└─ Taking card details over the phone → MOTO virtual terminal (liability warning)
```

| Need | Surface | Why |
|---|---|---|
| Single invoice / ad-hoc request | **Payment Links** via Dashboard | Zero code; email/SMS/WhatsApp delivery; all Checkout methods |
| Programmatic / bulk invoicing | **Payment Links API** (+ bulk CSV ≤1000) | `merchantInvoiceId` correlation, attachments, batch webhooks |
| Recurring invoice runs | **Xero** (Dashboard Connect) | Repeating invoices → Pay now → Checkout; auto-marks paid. No sandbox |
| Reusable public page | **Payment Page** | One link/QR forever; Embedded Checkout internally; default currency only |
| Phone orders | **MOTO** | Dashboard virtual terminal; approved channels only; **no 3DS — merchant bears chargeback liability; never MOTO to bypass 3DS** |

Payment Page amounts: 10.00–10000.00 default (support adjustable); email XOR mobile minimum; FNB accounts = alphanumeric reference. Details: `../products-and-routing.md` §4.

## Payment Links quickstart

**Dashboard** (no code): Dashboard → Payment Links → create → set amount, reference (`merchantInvoiceId`, 8–16 chars), customer email/mobile → send. Track status in Dashboard.

**API** (runnable shape; OAuth bearer — same `/api/oauth/token` pattern as Checkout, but links host: live `https://links.peachpayments.com`, sandbox `https://sandbox-l.ppay.io`):

```http runnable
POST /api/channels/{entityId}/payments
Authorization: Bearer <token>
{
  "payment":   { "merchantInvoiceId": "INV00001234", "amount": 1500.00, "currency": "ZAR" },
  "customer":  { "givenName": "Grace", "surname": "Nkosi",
                 "email": "grace@example.com" },
  "options":   { "sendEmail": true, "expiryTime": 10080 },
  "checkout":  { "tokeniseCard": false, "paymentType": "DB" }
}
→ { "url": "https://links.peachpayments.com/…", "id": "…" }
```

- `customer.email` required if `sendEmail`; `mobile` (`+27123456789`) if `sendSms`; `whatsapp` if `sendWhatsapp` (own Meta Business Account + Utility template, exactly 4 variables).
- Cancel: `DELETE /api/payments/{paymentId}` (only unpaid + `initiated` + unexpired; irreversible).
- Status: `GET /api/payments/{paymentId}` → `initiated|processing|expired|cancelled|completed`.
- Bulk batches: `POST /api/channels/{entityId}/payments/batches` → PUT CSV (`text/csv`) to the returned URL within **3h** or the batch expires; ≤1000 rows; columns fixed (`INVOICE_ID` 8–16 alnum, `AMOUNT` 0.01–1000000.00, names 2–50, `SEND_EMAIL/SMS/WHATSAPP`, `EXPIRY_TIME` 5–43200, …). Full column contract: `../payment-links.md`.

**Behavioural rules (quote these to the user):**
- **Expiry**: `expiryTime` minutes, min 5, default/max 43200 (30 days).
- **No edits, no partial payments**: change = cancel (irreversible) + regenerate.
- **Double-pay trap**: closing the payment window leaves the link `processing` — the customer can pay again on a retry. Prevent re-payment in your own flows; the link itself doesn't.
- `registrationId` (if `tokeniseCard`) arrives only on the `completed` webhook.
- Webhooks: JSON body, Scheme B header signature — **bulk batch webhooks are NOT signed**.

**Attachment invoices**: `POST /api/attachments` (PDF ≤5MB) → `fileId` → attach on create; `GET /api/payments/{id}/files/{fileId}` to retrieve. Mandatory ToS text ≤30k chars if you require acceptance.

## Payment Page setup

Dashboard → Payment Page → activate → publish → share (Facebook/X/WhatsApp/link/QR). Prepopulate: `?amount=10.00&reference=INV12345678&email=…&firstName=…&lastName=…&mobile=…` (values must be valid; flip the matching Collect toggles on; customer can still edit). Email XOR mobile is the minimum.

## Sandbox caveat

Payment Links sandbox is **email-only**, and there is **no sandbox for Xero** — test Xero flows with extra care against live (`../testing-and-go-live.md`).

## Merchant-side payment alerts (no code)

- **Payment Page**: Settings → "Receive payment notification emails" toggle + email addresses —
  documented `[DOCS]`; the nearest thing to zero-code "tell me when someone paid".
- **Payment Links**: customer receipts only; merchant notification requires `notificationUrl`
  (a server) or checking the Dashboard. No documented generic merchant SMS alerts exist.

## Traps
- Payment Links API ≠ Checkout API — only `defaultPaymentMethod` and `tokeniseCard` overlap; links use OAuth on the links host, not per-request HMAC.
- Assuming links are editable — they aren't; cancel-and-regenerate is the only change path (cancel is irreversible).
- Double-payment on window close — link stays `processing`; add your own re-payment guard.
- Bulk webhooks unsigned (spoofable) — don't build batch completion logic on signature checks that will never come, and never move money on a batch event without a server-side `GET /api/batches/{id}` confirmation.
- WhatsApp delivery assumed to be self-serve — it needs your own Meta Business Account + the exact 4-variable Utility template with dynamic URL button `https://links.peachpayments.com/{{1}}`.
- MOTO pitched as a convenience default — liability sits with the merchant (no 3DS); reserve it for genuine phone orders.
- FNB rejects non-alphanumeric references (links + Payment Page).
