# Payments API (server-to-server v2)


**Routing update, verified 2026-10-07:** Peach now recommends Orchestration for new custom online
integrations. Existing classic Checkout/Payments API integrations remain documented; do not relabel
that guidance as an announced shutdown or force a migration during unrelated maintenance.
Read `sdk-web.md` and `orchestration-api.md` for new builds. Sources:
[product portfolio](https://developer.peachpayments.com/docs/product-portfolio-overview),
[Checkout overview](https://developer.peachpayments.com/docs/checkout-overview),
[Payments API overview](https://developer.peachpayments.com/docs/payments-api-overview).

## When to load
Load for: accepting non-card payment methods without Checkout's hosted UI (custom flows you render yourself), integrating a specific `paymentBrand` (PayShap, Capitec Pay, Peach EFT, 1Voucher, M-PESA, RCS, ...), implementing refunds/status queries against API-originated payments, or consuming Payments API encrypted webhooks. For Checkout-originated payments use the Checkout refund endpoint instead; for capability matrices see `methods-catalog.md`.

## What it is (vs Checkout)
- Custom server-to-server (S2S) integration: you build the payment UI and orchestrate redirects yourself. Checkout renders the form for you.
- Pick Payments API over Checkout only when you need a fully custom flow (own bank-selection UI, native app screens driving S2S calls, server-orchestrated redirects) or non-Checkout brands like Peach EFT. For everything else Checkout is faster to ship and keeps you on SAQ A.
- **No bank-card payments on this API.** The only "card" is RCS (a South African store card, submitted as `card.number` — it is not a Visa/Mastercard PAN). Bank cards require Checkout, COPYandPAY/S2S card API, or Mobile SDK. Apple Pay/Google Pay/Samsung Pay are likewise **absent from the v2 `paymentBrand` enum** — they live on the S2S card (OPPWA) and Checkout surfaces only. `[DOCS]`
- PCI: submitting RCS `card.number` means PAN data touches your servers (docs map S2S/web-direct integrations to SAQ A-EP/D); every other method here keeps PAN handling off your stack. Non-card methods stay in SAQ A scope.
- Base URLs:
  - Live: `https://api-v2.peachpayments.com`
  - Sandbox: `https://testapi-v2.peachpayments.com`
- Auth is **in the request body**, not a bearer header:
  ```json runnable
  {
    "authentication": {
      "userId": "<32-hex>",
      "password": "<secret>",
      "entityId": "<32-hex channel/entity ID>"
    }
  }
  ```
  Credentials come from Dashboard → **Payments API → API keys**; the Payments API channel is **support-activated** (contact Peach support if absent).

## Create payment — `POST /payments`
Required on every request:

| Field | Pattern / constraint |
|---|---|
| `merchantTransactionId` | `^[a-zA-Z0-9]{8,16}$` (8–16 alphanumerics) |
| `amount` | `^\d{1,8}(\.\d{2})?$`, string, must be nonzero |
| `currency` | `^[A-Z]{3}$` |
| `paymentBrand` | enum (below) |
| `paymentType` | `DB` (debit) or `RF` (refund) |
| `authentication.*` | userId / password / entityId (above) |

`paymentBrand` enum: `PAYFLEX, ZEROPAY, 1FORYOU, MASTERPASS, MPESA, BLINKBYEMTEL, MOBICRED, CAPITECPAY, PEACHEFT, MCBJUICE, RCS, FLOAT, HAPPYPAY, MAUCAS, MONEYBADGER, PAYSHAP`.

Optional fields: `virtualAccount` (object; **array form for PEACHEFT high-risk**, see below), `customer`, `billing`, `shipping`, `cart`, `shopify`, `merchantInvoiceId`, `shopperResultUrl` (6–2048 chars, fully-qualified URI — the customer lands here after the PSP step).

### Example: PayShap request and pending response
```json runnable
POST /payments HTTP/1.1
Host: testapi-v2.peachpayments.com
Content-Type: application/json

{
  "authentication": { "userId": "…", "password": "…", "entityId": "…" },
  "merchantTransactionId": "Order74152",
  "amount": "150.00",
  "currency": "ZAR",
  "paymentBrand": "PAYSHAP",
  "paymentType": "DB",
  "virtualAccount": {
    "bank": "FIRSTNATIONALBANK",
    "type": "CELLPHONE",
    "accountId": "+27-711111200"
  },
  "shopperResultUrl": "https://example.com/peach/return",
  "customParameters": { "enableTestMode": "true" }
}
```
Async success response (HTTP 200 — still pending, not paid):
```json runnable
{
  "id": "02f2ef804c4f4713ab053661cba98d4z",
  "merchantTransactionId": "Order74152",
  "amount": "150.00",
  "currency": "ZAR",
  "paymentBrand": "PAYSHAP",
  "paymentType": "DB",
  "result": { "code": "000.200.000", "description": "Pending" },
  "redirect": {
    "url": "https://…/shap-link",
    "method": "GET",
    "parameters": [ { "name": "reference", "value": "…" } ]
  }
}
```
Build the redirect exactly from `redirect` (object with required `url`, `method` `GET|POST`, `parameters[]`). `id` in the response is the `uniqueId` used later for refunds and single-transaction status.

### 1Voucher (synchronous) difference
`1FORYOU` returns a **final** result in the POST response (no redirect, no async wait). Send `customer.mobile` so the shopper can change the voucher or receive refunds later.

⚠️ version-sensitive — `paymentBrand` strings vary between surfaces and docs (e.g. Checkout uses `1FORYOU`/`MASTERPASS`; invoice names differ again: 1Voucher↔1ForYou, Scan to Pay↔Masterpass). Never hard-match brand strings across APIs; treat the enum above as authoritative for this endpoint only.

## Three flow types
| Flow | Methods | What you do |
|---|---|---|
| Synchronous | 1Voucher (`1FORYOU`) only | Final result in the POST response; no redirect, no webhook wait |
| Async, custom UI | Capitec Pay, Absa (PayShap rail), Mobicred, PayShap, blink by Emtel, MCB Juice, MauCAS, M-PESA | You render the OTP/pin/waiting screen; PSP pushes the prompt |
| Async, PSP UI | Peach EFT, Payflex, ZeroPay, RCS, Float, Happy Pay, MoneyBadger, Scan to Pay | Redirect the customer to the returned `redirect` object |

## Async flow (9 steps) and `redirect` semantics
1. `POST /payments` → response `result.code = 000.200.000` (transaction created, pending, awaiting payment).
2. Payments API sends a Pending webhook (`000.200.000`) for the state change.
3. Redirect the customer to the response's `redirect` object: `{url, method, parameters[]}`.
   - `method: GET` → append `parameters[]` as **query string** on `url`.
   - `method: POST` → submit `parameters[]` as **`x-www-form-urlencoded` form body** to `url`.
4. The PSP/method UI captures the customer's payment details.
5. Customer submits; PSP processes.
6. PSP redirects the customer back to your `shopperResultUrl`.
7. You query the transaction status API (below) for the final status.
8. Payments API sends the outcome webhook — `000.000.000` for success.
9. Fulfil on the terminal status (webhook + status call converge; do not fulfil on `000.200.000`).

State transitions are not ordered: Pending→Successful, Pending→Failed, and **Failed→Successful** all occur. Treat the final webhook/status result code as the only truth; never assume arrival order (use timestamps).

## Per-method required parameters
`virtualAccount` is an object unless noted. `shopperResultUrl` is mandatory for all async methods.

Worked examples of the trickier payload shapes:
```json illustrative
// Capitec Pay — three accepted identifiers (high-risk: verified IDNUMBER only).
// Sandbox test identifiers incl. negative cases: ID 1111111111106 / phone 0111111106 (see `testing-and-go-live.md`)
{ "virtualAccount": { "type": "IDNUMBER",     "accountId": "1111111111106" } }
{ "virtualAccount": { "type": "CELLPHONE",    "accountId": "0111111106" } }
{ "virtualAccount": { "type": "ACCOUNTNUMBER","accountId": "<account number, ≤64 chars>" } }

// M-PESA — 12-digit phone, INTEGER amount (no decimals, round up)
{ "amount": "1500", "currency": "KES", "paymentBrand": "MPESA",
  "virtualAccount": { "accountId": "<12-digit phone>" } }

// PEACHEFT high-risk (Absa) — virtualAccount is an ARRAY here
{ "paymentBrand": "PEACHEFT",
  "virtualAccount": [ { "processor": "ABSAEFT",
    "identifier": [ { "type": "IDNUMBER", "accountId": "<13-digit SA ID>" } ] } ] }

// Mobicred — email as accountId
{ "virtualAccount": { "accountId": "shopper@example.com", "password": "…" } }
```
`customParameters` values are strings (e.g. `"customParameters[enableTestMode]":"true"`).

| `paymentBrand` | Required parameters | Notes |
|---|---|---|
| `PAYSHAP` | `virtualAccount.bank` (enum: `FIRSTNATIONALBANK`, `DISCOVERYBANK`, `NEDBANK`, `TYMEBANK`, `ABSABANK`), `virtualAccount.type=CELLPHONE`, `virtualAccount.accountId` (format `+27-123456789`), `shopperResultUrl` | ShapID = bank-registered cellphone. Bank transaction caps: Absa/Discovery/FNB R3,000, Nedbank R50,000, TymeBank R5,000. No African Bank/Capitec/Investec/Standard Bank. **One refund per transaction — a partial refund blocks all later refunds.** |
| `CAPITECPAY` | `virtualAccount.type` (enum: `IDNUMBER`, `CELLPHONE`, `ACCOUNTNUMBER`), `virtualAccount.accountId` (13-digit SA ID / 10-digit phone starting `0` / ≤64-char account number), `shopperResultUrl` | High-risk merchants: verified `IDNUMBER` only, customer cannot edit; no passport. No refunds. |
| `PEACHEFT` | `shopperResultUrl`; **high-risk (Absa) also `virtualAccount` as array**: `[{"processor":"ABSAEFT","identifier":[{"type":"IDNUMBER","accountId":"<13-digit SA ID>"}]}]` | Absa Pay rides PEACHEFT via this array form. PA-only method (not on Checkout). No refunds. |
| `1FORYOU` | `customer.mobile`, `virtualAccount.password` (voucher PIN) | Synchronous. Mobile number is needed for voucher changes/refunds. |
| `MOBICRED` | `virtualAccount.accountId` (email), `virtualAccount.password`, `shopperResultUrl` | Async custom UI. |
| `RCS` | `card.number`, `shopperResultUrl` | Store card, the only "card" on this API. |
| `MPESA` | `virtualAccount.accountId` (12-digit phone), `shopperResultUrl` | **Integer amounts only — round up client-side** (e.g. `"1500"`, no decimals). Kenya/KES. No refunds. |
| `BLINKBYEMTEL` | `virtualAccount.accountId` (8-digit phone), `shopperResultUrl` | Mauritius. No refunds. |
| `MCBJUICE` | `virtualAccount.accountId` (8-digit phone), `shopperResultUrl` | Mauritius. No refunds. |
| `PAYFLEX` | `shopperResultUrl` | R10–R50,000. Refundable. |
| `ZEROPAY` | `shopperResultUrl` | Min R30. **Not refundable.** |
| `FLOAT` | `shopperResultUrl` | R1–R99,000. Refundable. |
| `HAPPYPAY` | `shopperResultUrl` | Refundable. |
| `MASTERPASS` | `shopperResultUrl` | Scan to Pay. **Full refunds only.** Debit-card reversal ≤6h via Scan to Pay service. |
| `MONEYBADGER` | `shopperResultUrl` | Crypto (BLN/Luno/VALR/Binance/Bybit/OKX). Refunds ≥R25 incl. partial; **refund fails `800.100.195` if customer supplied no wallet address at payment time**; refunded at current FX on the ZAR price. |
| `MAUCAS` | `shopperResultUrl` | Mauritius QR. No refunds. POS-oriented. |

## Refund
```
POST /payments/{uniqueId}
```
- Body: `authentication.*`, `amount`, `currency`, `paymentType=RF`. `uniqueId` = the Peach transaction unique ID of the **original payment** (from the payment response/status/webhook `id`), not your `merchantTransactionId`.
- Asynchronous: a successful refund request returns `000.200.000` (pending); the transaction reaches its final state when the PSP processes it, then the outcome webhook arrives.
- Partial refunds allowed unless the method forbids it (see `methods-catalog.md` — e.g. PayShap one-refund-only, Scan to Pay full-only).
- For Checkout-originated payments use the Checkout V1 refund endpoint instead — do not mix surfaces.

## Transaction status
- `GET /payments?authentication.userId=…&authentication.password=…&authentication.entityId=…&merchantTransactionId=…` — may return **multiple** transactions (one per attempt with that ID).
- `GET /payments/{uniqueId}?authentication.*` — single transaction.
- **Rate limit: max 2 status requests per minute per transaction.** Poll with backoff or wait for webhooks; do not tight-loop.
- Response carries the transaction's full record: `id` (uniqueId), `merchantTransactionId`, `amount`, `currency`, `paymentBrand`, `paymentType`, `result.code`/`result.description`, plus card/PSP detail where applicable (`card.bin`, `card.last4Digits`, `card.holder`, `authCode`, `customParameters`, acquirer fields e.g. `resultDetails.AcquirerResponse`). Parse defensively — field presence varies by method and state.
- The final result code is authoritative: `000.000.000` success family, `000.200.000` pending, `100.396.101` cancelled, `100.396.104` uncertain. Bucket codes with the standard success regex `/^(000\.000\.|000\.100\.1|000\.[36])/` and pending `/^(000\.200)/` (same families as Checkout; never treat `000.400.101/102` as success). Full bucket table: `result-codes.md`.

## Error shapes
- 400 validation: body contains `code`, `description`, and `parameterErrors[]` — each item `{name, value, message}` naming the offending field:
  ```json illustrative
  {
    "code": "…",
    "description": "Errors in the processed request.",
    "parameterErrors": [
      { "name": "amount", "value": "0", "message": "amount must be nonzero" }
    ]
  }
  ```
  Branch on `parameterErrors[].name`, not on the message text.
- 401/403 authentication/authorisation errors; 404 unknown transaction. Never interpret an HTTP 2xx as payment success — only `result.code` decides (`000.200.000` is a 2xx but means pending).

## Transaction states
| From → To | Meaning / handling |
|---|---|
| created → pending | `000.200.000`; transaction awaiting shopper/PSP action |
| pending → successful | terminal `000.000.000` family; fulfil |
| pending → failed | terminal decline; invite retry |
| pending → cancelled | typically shopper abandonment (`100.396.101`) |
| **failed → successful** | possible — a "failed" transaction can still complete (late PSP confirmation). Never delete/compact state on first failure; keep listening for webhooks |
Order not guaranteed — use `timestamp`; treat webhooks as wake-ups and the status API as truth.

## Webhooks (AES-128-GCM encrypted)
Payments API webhooks are **not** the Checkout form-signed webhooks — bodies are encrypted.

Configure (Dashboard → Payments API → Webhooks → **Add webhook URL**):
1. Enter your webhook URL — HTTPS required in live; your system must answer 200.
2. Peach immediately sends the config-verification message: plaintext JSON `{"verificationCode": …}` (see below).
3. Optional: flip **JSON wrapper** ON for `{"encryptedBody":"<hex>"}` bodies instead of plain hex text.
4. Flip **PII** toggle ON (mandatory — see known issue below).
5. Save; the webhook row then shows the **secret key** used to decrypt its payloads.
6. Disable via the Enabled toggle; delete via the row's more-options menu.
- Body: **hex-encoded AES-128-GCM ciphertext**. Secret key shown next to the webhook after creation.
- `iv` and auth tag arrive in HTTP headers (decrypt: `createDecipheriv("aes-128-gcm", key, iv)`, `setAuthTag`, `update`+`final` on the hex-decoded body). Decryption shape (from the docs' Node sample):
  ```js illustrative
  const key = Buffer.from(secretKeyHex, "hex");        // from the Dashboard webhook config
  const iv = Buffer.from(ivHeader, "hex");             // per-request header
  const tag = Buffer.from(authTagHeader, "hex");       // per-request header
  const d = crypto.createDecipheriv("aes-128-gcm", key, iv);
  d.setAuthTag(tag);
  const payload = d.update(Buffer.from(bodyHex, "hex")) + d.final("utf8");
  ```
- Optional **JSON wrapper** toggle: body becomes `{"encryptedBody":"<hex string>"}` instead of plain text.
- **PII toggle MUST be ON — known issue: leaving it off means Peach sends no webhooks at all.**
- First message after configuration is plaintext JSON `{"verificationCode":"9e7a8dc7caeaccez"}`-shaped — it verifies the endpoint, not a payment. Echo/store per instructions; don't feed it to your decryptor.
- Events (decrypted payload, keyed by `{id, referencedId, …}`): Pending, Successful, Cancelled, Failed. `referencedId` carries the original payment id on refunds.
  Decrypted payload shape (documented PEACHEFT example, truncated):
  ```json illustrative
  {
    "id": "02f2ef804c4f4713ab053661cba98d4z",
    "referencedId": "",
    "paymentType": "DB",
    "paymentBrand": "PEACHEFT",
    "amount": "1.0",
    "merchantTransactionId": "EFTTestdb7532d8d",
    "currency": "ZAR",
    "presentationAmount": "1.0",
    "presentationCurrency": "ZAR",
    "result": { "code": "000.000.000", "description": "Transaction succeeded" },
    "resultDetails": {
      "clearingInstituteName": "EFT",
      "ExtendedDescription": "n/a",
      "AcquirerResponse": 1
    },
    "connectorTxID1": "105035601",
    "authentication": { "entityId": "…" }
  }
  ```
  Parse defensively: `AcquirerResponse` can be string or number; `merchantInvoiceId`/`descriptor` may be null/empty.
- Retry: 7 days, exponential backoff — 1, 2, 4, 8, 15, 30 min, 1 h, then 6 h daily until 7 days elapse or a 200 is returned.
- Verify-then-trust: decrypt fails → reject; then re-confirm outcome via the status API before fulfilling (webhook order is not guaranteed). Payment endpoints can be listed/updated via the webhook endpoint config API (see `webhooks.md`).

## Sandbox method testing
Sandbox testing of simulator-backed methods needs `"customParameters[enableTestMode]":"true"` in the Payments API request body (not required for the same methods in Checkout). Documented for: **PayShap, Capitec Pay, Float, RCS, blink by Emtel, MCB Juice, MauCAS**. With it, sandbox payments bypass the verification/success step and redirect straight to `shopperResultUrl`. Scenario-specific test data (PayShap phone numbers, Capitec ID numbers, RCS amount-coded card, payout accounts) lives in `testing-and-go-live.md`.

## Method availability changelog flags
⚠️ version-sensitive — method availability shifts; check the public changelog before hard-coding:
- **Nedbank Direct EFT removed 2026-07-21** (Peach no longer offers it). Any integration still offering it must be migrated (Peach EFT covers Nedbank).
- **PayShap added 2025-08-25**; Absa capped at R3,000 per transaction.
- Float / Nedbank EFT availability has changed over time — treat method lists as configuration, re-fetch or re-verify per environment.
- Note: *Pay by Bank* (Checkout-only bundle) and *Absa Pay* are distinct from `PEACHEFT` and `PAYSHAP` — see `methods-catalog.md`.

## Traps
- Amount `"0"` or missing decimals where required → 400; M-PESA additionally rejects decimal amounts entirely (integer only, round up).
- `paymentType=RF` on `POST /payments` (no uniqueId) is wrong — refunds go to `POST /payments/{uniqueId}`.
- Refunding a Checkout-originated payment through this API fails — surfaces must match.
- PII toggle off = silently zero webhooks; you only discover it when pending payments never resolve.
- Feeding the first `verificationCode` message into your decryptor throws (it is plaintext JSON, not ciphertext).
- GET vs POST redirect mixed up → parameters land in the wrong place and the PSP sees an empty request.
- Status polling >2/min per transaction gets throttled — with many transactions the per-transaction cap still applies per uniqueId.
- `merchantTransactionId` reused across attempts makes the query variant return multiple rows — always resolve the specific `uniqueId` before refunding.
- Treating `000.200.000` (or any 2xx) as success; Failed→Successful transitions exist, so only terminal codes settle the order.
- High-risk merchants: Capitec `CELLPHONE`/`ACCOUNTNUMBER` and editable IDs are rejected — verified `IDNUMBER` only; PEACHEFT high-risk requires the `virtualAccount` **array** with 13-digit ID, not the object form.
