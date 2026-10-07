# Orchestration API — the Server-to-Server REST surface

## When to load

Load for the Peach **Orchestration** JSON REST API: creating payments server-side (`POST /payments`),
capture/void/refund, customers and the payment-method vault, mandates and merchant-initiated recurring,
alternative payment methods over S2S, and Orchestration webhooks. This is the backend behind the
Orchestration Web SDK (`sdk-web.md`) and the mobile SDKs (`mobile.md`). It is a **different product** from
the legacy Payments API v2 / OPPWA card facade (`payments-api.md`, `legacy-surfaces.md`) — see §12 for the
migration mapping. Orchestration is a white-labelled Hyperswitch surface.

## 0. The one-paragraph orientation

You create a payment intent with `POST /payments` and either confirm it server-side (`confirm:true`, you
hold the credential — S2S) or defer confirmation to an SDK (`confirm:false`, return the `client_secret` —
`sdk-web.md`/`mobile.md`). Money is authorised then captured; captures can be full, partial (remaining-hold behavior depends on the connector and capture mode),
or, with an opt-in, over the authorised amount. Refunds run against captured money. Saved
credentials and mandates drive merchant-initiated recurring. **Amounts are integer minor units**, auth is a
merchant `api-key`, and outcomes are confirmed by webhook + `GET /payments/{id}`, never by the client.

## 1. Auth, hosts, amounts

- **Auth**: header `api-key: <merchant_secret_key>` on every server call. Server-side only — never ship it
  to a browser or app (the client uses the publishable key). `[DOCS playground.peachpayments.com/playground; openapi securitySchemes.api_key]`
- **Hosts**: sandbox `https://app.sandbox-next.peachpayments.com/api`, production
  `https://app.next.peachpayments.com/api`. `[DOCS]`
- **Amounts are integer minor units** — `6540` = R65.40 / $65.40. `currency` is a sibling top-level field
  (ISO code, e.g. `"ZAR"`). This is the opposite of Checkout V2 / Payments API
  v2, which take decimal-string major units — mixing them is a 100× error. `[DOCS integrate/api-only; openapi PaymentsCreateRequest]`
- **Zero-amount payments are rejected** as a business rule on the create path (the `amount` schema itself
  permits `0`, which is used only by the zero-auth flow, §10.4). `[DOCS integrate/api-only]`
- **Credential prefixes** (Dashboard-issued): profile id `pro_…`, publishable key `pk_snd_…`/`pk_prd_…`,
  secret/API key `snd_…`/`prd_…`. IDs like `cus_…`/`pm_…`/`man_…` are the shapes Peach returns; the schema
  does not pin them as validated formats, so match on the value you were given, not on a hard prefix. `[DOCS sdk-web]`
- **Finding your `merchant_id` + `profile_id`**: `GET /payments/list?limit=1` returns both. Neither is in
  client config, and `/accounts/list` is not available to a merchant `api-key`. `[DOCS operate/profile]`

## 2. Core endpoints

| Endpoint | Purpose | Key request fields |
|---|---|---|
| `POST /payments` | Create a payment intent | `amount`, `currency`, `confirm`, `capture_method`, `authentication_type`, `payment_method`/`_type`/`_data`, `return_url`, `customer_id`, `setup_future_usage`, `mandate_data`, `recurring_details`, `off_session` |
| `POST /payments/{id}/confirm` | Confirm an intent created with `confirm:false` | With merchant secret API-key auth, send payment method/data as needed, not `client_secret`; client SDK auth is a separate flow |
| `POST /payments/{id}/capture` | Capture an authorised (manual-capture) payment | `amount_to_capture` (optional; must be ≤ current `amount_capturable`; full amount if omitted), `refund_uncaptured_amount` |
| `POST /payments/{id}/cancel` | **Void** a pre-capture authorisation | `cancellation_reason` |
| `POST /payments/{id}/cancel_post_capture` | Cancel after capture (valid on `succeeded` / `partially_captured` / `partially_captured_and_capturable`) | `cancellation_reason`. How this differs operationally from a refund is not spelled out in prose — `[VERIFY-SANDBOX]` |
| `POST /payments/{id}/extend_authorization` | Extend the auth validity window (payment in `requires_capture`) | `{}` |
| `POST /payments/{id}/incremental_authorization` | Increase the authorised amount | `amount` (the cumulative total incl. the previous auth, not a delta), `reason` |
| `POST /payments/{id}/complete_authorize` | Complete auth after external/standalone 3DS | `client_secret`. Path is US-spelled `complete_authorize` even where prose reads "authorise". |
| `GET /payments/{id}?force_sync=true` | Retrieve status, forcing a live connector call (not cached) | query: `force_sync`, `client_secret`, `expand_attempts`, `expand_captures` |
| `GET /payments/list` | List/filter payments | query: `customer_id`, `limit`, `created[_lt/gt/lte/gte]`, `starting_after`, `ending_before` |
| `POST /refunds` | Refund a captured payment | `payment_id`, `refund_id` (optional idempotency key), `amount` (optional; **`minimum:100`** minor units), `reason`, `refund_type` |
| `GET /refunds/{id}` | Retrieve a refund | path: `refund_id` |

`[DOCS playground; openapi paths + PaymentsCaptureRequest / PaymentsCancelRequest / RefundRequest]`
Customers, payment methods, and mandates have their own endpoint groups — §8–§10.

The current [confirm reference](https://playground.peachpayments.com/playground) explicitly
says not to send `client_secret` with a secret API key (reviewed 2026-10-07). A schema listing an
optional field does not make it appropriate for every authentication mode.

Payment creation documents `payment_id` for idempotency; refunds document `refund_id`. Both are
constrained to 30 characters in the current schema, while refund prose also recommends UUIDv4.
Persist an ID before dispatch, use it for only one immutable operation, and verify the conflicting
refund-length advice and duplicate semantics in sandbox. Do not assume every endpoint shares these
idempotency rules. See `playbooks/orchestration-build.md` for recovery and acceptance cases.

## 3. The create / confirm request shape

- `payment_method` (`card`, `wallet`, `network_token`, `bank_transfer`, `bank_redirect`, `real_time_payment`,
  `pay_later`, `voucher`, `crypto`, `mobile_payment`, …) with a matching `payment_method_type`; a mismatched
  pair is rejected (*"payment_method_type doesn't correspond to the specified payment_method"*). The
  credential nests under `payment_method_data`. `[DOCS integrate/api-only]`
- **`capture_method` has FIVE values** (not two): `automatic` (default; capture on authorisation), `manual`
  (authorise, then a separate `/capture`), plus `manual_multiple`, `scheduled`, `sequential_automatic`. The
  last three are named in the schema but not explained in prose — `[VERIFY-SANDBOX]` for their exact
  semantics. `[DOCS openapi CaptureMethod]`

Current server-to-server card and save-card examples include `browser_info` with shopper device,
IP, user agent, language, timezone and screen fields. Collect actual client context and follow the
selected connector's requirements; do not copy the documentation's sample IP or browser values.
This example change was reviewed on 2026-10-07 and does not make every listed field universally
required. [Card flow](https://playground.peachpayments.com/flows/server-to-server-card).

### Card (PAN) — heaviest PCI scope
```json illustrative
"payment_method": "card",
"payment_method_type": "credit",
"payment_method_data": { "card": {
  "card_number": "4200000000000091", "card_exp_month": "01", "card_exp_year": "32",
  "card_cvc": "123", "card_holder_name": "Test Holder"
}}
```

### Network token: surrogate plus cryptogram
```json illustrative
"payment_method": "network_token",
"payment_method_type": "network_token",
"payment_method_data": { "network_token": {
  "network_token": "4111111111111111", "token_exp_month": "01", "token_exp_year": "32",
  "token_cryptogram": "AgAAAAAA...", "card_holder_name": "Test Holder", "eci": "05"
}}
```
`payment_method_type` **must** also be `network_token` (pairing with `credit` is rejected). The cryptogram
is single-use per authorisation. The connector must be configured for network tokens or routing returns
*"No eligible connector was found"*. `[DOCS integrate/api-only]`

### Wallet passthrough (Apple/Google/Samsung Pay)
All three use `"payment_method": "wallet"` with the brand as `payment_method_type`; you forward an encrypted
payload and never decrypt it. Google Pay needs the `PAYMENT_GATEWAY` tokenization type (`DIRECT` is a
different integration). A bad/expired payload declines with *"card properties must be set"* → `200.300.404`.
All three settle on card rails, so refunds behave like card refunds. `[DOCS integrate/api-only]`

### Credential handling and PCI scope

Raw card-backed credentials in a server-to-server flow remain in PCI scope. Token and expiry
handling, cryptograms and encrypted wallet payloads have different exposures; none gives a
blanket exemption. The current API-only guide identifies network token plus expiry as cardholder
data and the cryptogram as sensitive authentication data. Do not retain cryptograms after
authorisation. Confirm token-requestor onboarding and PCI obligations with Peach and the assessor.
Prefer SDK/hosted collection unless the merchant has an assessed reason to handle credentials.
See `network-tokenisation.md` for token types and authentication/lifecycle boundaries.
[Current API-only guide](https://playground.peachpayments.com/integrate/api-only), checked 2026-10-07.

## 4. Flow shapes and `next_action`

Which steps you get depends on the method: `[DOCS integrate/api-only]`
- **Direct** (cards, network tokens, wallet passthrough) — no provider page; a 3DS challenge may still redirect.
- **Asynchronous redirect** (most alternative methods) — confirm returns `requires_customer_action` with
  `next_action.redirect_to_url`; the final state arrives by webhook or status poll.
- **Synchronous** (1Voucher only) — the confirm response is already `succeeded`/`failed`.
- **QR or redirect** (Scan to Pay, MauCAS) — add `"payment_experience": "display_qr_code"` and the response
  carries `next_action.qr_code_information` (image data URL, scan target, `display_to_timestamp`).

`next_action` is a **tagged union — switch on `type`, never on field presence.** It has 14 variants
(`redirect_to_url` is the S2S card-3DS case; the rest cover SDK 3DS, QR, bank-transfer, voucher, OTP, UPI,
etc.). The redirect target is always a **Peach-hosted URL**
(`…/api/payments/redirect/{payment_id}/{merchant_id}/{attempt_id}`) — **send the shopper there verbatim**;
do not parse, rewrite, or append to it (its shape is internal and will change). `[DOCS concepts/three-ds-next-action; openapi NextActionData]`

## 5. Alternative payment methods over S2S

- **Billing derives the shopper identifier** for several methods, so the billing phone/email is effectively
  required (phone is sent split as `{ "number": "711111200", "country_code": "+27" }`): `[DOCS integrate/api-only]`

  | Method | Requires | Format |
  |---|---|---|
  | PayShap | phone | `+27-711111200` (hyphenated international) |
  | Capitec Pay (no `account_id`) | phone | `0711111200` (local, 10 digits) |
  | M-PESA | phone | `254711111200` (digits + country code) |
  | blink by Emtel, MCB Juice | phone | local 8-digit |
  | 1Voucher | phone | `27711111200` (digits, no plus) |
  | Mobicred | email | account identifier |

- **All alternative methods are automatic-capture only** (manual capture/void are rejected) and **CIT-only**
  (only card-backed credentials can be stored and charged as an MIT). `[DOCS integrate/api-only]`
- Per-method market + refund support (from `operate/payment-methods`): `[DOCS operate/payment-methods]`

  | Method | Market | Refunds |
  |---|---|---|
  | Card (Visa/Mastercard/Amex; Diners ZA+MU) | ZA, KE, MU (Amex KE = Equity Bank, KES only) | ✅ full/partial |
  | PayShap | ZA | ✅ **one refund only** |
  | Peach EFT, Capitec Pay | ZA | ❌ |
  | Payflex, Float, Happy Pay, Mobicred, RCS | ZA | ✅ full/partial |
  | PayJustNow | ZA | Full or partial, current payment-methods docs checked 2026-10-07 |
  | ZeroPay | ZA | ❌ |
  | Apple Pay (ZA/ZAR; MU/MUR,USD), Google Pay (ZA), Samsung Pay (ZA) | ZA/MU | ✅ full/partial |
  | Scan to Pay | ZA | ✅ **full only** (no debit-card refunds; debit reversals within 6h) |
  | M-PESA | KE | ❌ |
  | MauCAS, blink by Emtel, MCB Juice | MU | ❌ |
  | 1Voucher | ZA | ✅ full/partial |
  | MoneyBadger (crypto) | ZA | ✅ full/partial |

  M-PESA on Orchestration is a **KE-market S2S/Web-SDK method** (it is *not* enumerated on the native
  mobile-SDK pages — `mobile.md`). It is non-refundable by API.

## 6. Capture, void, refund, overcapture

`[DOCS docs/manage-transactions]`
- **Capture** takes the held funds and settles you. You can capture the **full authorised amount or less** —
  the manage-transactions guide describes release of the difference on partial capture (status
  `partially_captured`), but the schema marks `refund_uncaptured_amount` incompletely supported and
  connector-dependent. Verify final versus multiple capture semantics before promising immediate
  release of the balance. Captures
  are **final** (undo = refund).
- **Overcapture** (capturing *more* than authorised) is a **separate opt-in PSP capability** requested on the
  original payment via `enable_overcapture: true` — not a capture-time parameter. `[DOCS openapi PaymentsCreateRequest.enable_overcapture]`
- **Void** = `POST /payments/{id}/cancel`, **pre-capture only**. It releases the hold; nothing settles.
  A preauthorisation **cannot be refunded** (no money moved) — void it. You **cannot `/cancel` after capture** —
  refund instead (`/cancel_post_capture`, §2, is a separate post-capture endpoint, not a void).
- **Refund** = `POST /refunds`, only on `succeeded` / `partially_captured`. Full or multiple partials up to
  the captured total. `amount` has a hard **`minimum:100`** minor units. Refunds are asynchronous — track via
  webhook or `GET /payments/{id}`. `[DOCS; openapi RefundRequest]`
- Holds expire on their own (cards: ~7 days, issuer/scheme dependent) — capture or void before then; use
  `extend_authorization` to extend the window (connector permitting).
- Refund completion times: card & BNPL up to 14 business days; PayShap bank-dependent (some immediate);
  MoneyBadger immediate; other methods up to 30 days. A refund older than 6 months is processed manually by
  Peach support. `[DOCS docs/manage-transactions]`

## 7. Money-relevant create fields (name-verified; some semantics schema-only)

Named on `PaymentsCreateRequest`; where prose doesn't explain them, treat semantics as `[VERIFY-SANDBOX]`:
`enable_overcapture` (§6), `enable_partial_authorization` (allow issuer-approved-less-than-requested — behaviour
not in prose), `off_session` (mandatory when charging a `mandate_id`), `mit_category`
(`recurring`/`installment`/`unscheduled`/`resubmission`), `psd2_sca_exemption_type`
(`low_value`/`transaction_risk_analysis` — PSD2 only; buys nothing on a SA-domestic transaction),
`split_payments`, `surcharge_details`, `order_tax_amount`, `discount_amount` (present in the schema, no prose
behaviour documented). `[DOCS openapi PaymentsCreateRequest]`

## 8. Customers

- `POST /customers` (auto-creates; returns the existing record if the id already exists, does not error),
  `GET /customers/{id}`, `POST /customers/{id}` (partial update), `DELETE /customers/{id}`, `GET /customers/list`.
- `CustomerRequest`: `customer_id` (autogenerated if omitted; returned like `cus_…`), `name`, `email`, `phone`,
  `phone_country_code`, `description`, `address` (`AddressDetails`), `metadata` (≤50 keys), `tax_registration_id`.
  The response also carries `default_payment_method_id`. `[DOCS openapi Customer*; operate/payment-methods]`

## 9. Payment-method vault

- `POST /payment_methods`, `GET/DELETE /payment_methods/{id}`, `POST /payment_methods/{id}/update`,
  `GET /customers/{id}/payment_methods` (a customer's saved methods),
  `GET /account/payment_methods` (methods available to the merchant),
  `POST /{customer_id}/payment_methods/{id}/default` (set default).
- `GET /customers/payment_methods` is the **client-facing** "what can this shopper pay with" lookup — it is
  authenticated by the **publishable key** and a `client_secret` query param, not the merchant `api-key`. Do
  not confuse it with the merchant-side `GET /account/payment_methods`. `[DOCS openapi; operate/payment-methods]`
- Saved methods come back as `pm_…` ids. (Some OpenAPI examples show a `card_…` id; `pm_…` is the form used in
  the customer-scoped responses and all doc prose — prefer it.)

## 10. Mandates, recurring and MIT

### 10.1 The two vault models
- **Vault-with-us / payment_method_id** — saved-method reference without the mandate amount-limit model. Save with
  `setup_future_usage:"off_session"` + a `customer`; charge with
  `recurring_details:{ "type":"payment_method_id", "data":"pm_…" }`. `[DOCS flows/recurring-pm]`
- **Mandate**: a formal consent and amount-limit model. It does not make a charge immune to disputes. `[DOCS flows/recurring-payments]`

### 10.2 Mandates
- Create by passing `mandate_data` on a payment: `customer_acceptance` (`acceptance_type` `online`/`offline`;
  for `online`, `online:{ip_address,user_agent}`) + `mandate_type` (`single_use` **or** `multi_use`), each
  carrying `MandateAmountData` = `amount` (the **maximum** debitable, minor units) + `currency` (+ optional
  `start_date`/`end_date`). A charge must be **≤ the mandate maximum**. `[DOCS openapi MandateData/MandateType/MandateAmountData]`
- Charge with `recurring_details:{ "type":"mandate_id", "data":"man_…" }`, `off_session:true`, `confirm:true`.
- Manage: `GET /mandates/{id}`, `POST /mandates/revoke/{id}`, `GET /customers/{id}/mandates`. `MandateStatus`
  is `active` / `inactive` / `pending` / `revoked`. Webhook events `mandate_active` / `mandate_revoked`.
- Doc guidance (not API-enforced): set the mandate max ~20–30% above the highest expected charge, and keep
  proof of customer acceptance (recurring-compliance narratives reference ≥18 months). `[DOCS flows/recurring-payments]`

### 10.3 Customer-present setup followed by MIT
The customer's acceptance must be captured while they are present, so an MIT is never a single call:
1. **CIT (present)**: `POST /payments` with `setup_future_usage:"off_session"`, `customer` (+ id), and either
   `mandate_data` (mandate model) or nothing beyond `setup_future_usage` (payment_method_id model),
   `authentication_type:"three_ds"`. The response yields `payment_method_id` (and `mandate_id` for the mandate
   model). The vault-with-us setup **must complete** or the credential is not chargeable.
2. **MIT (absent)**: `POST /payments` with `amount`, `currency`, `confirm:true`, `off_session:true`,
   `customer_id`, and the `recurring_details` reference — no raw payment-method data for this vaulted-reference variant and no shopper present. Handle authentication-required failures with customer-present recovery.
   `[DOCS integrate/api-only, flows/recurring-payments]`

`recurring_details` is the single field for referencing any stored credential — **`payment_method_id` is NOT a
top-level field on `POST /payments`** (sending it there is rejected). Documented variant types: `payment_method_id`,
`mandate_id`, `processor_payment_token`, `network_transaction_id_and_card_details` (own-vault PAN),
`network_transaction_id_and_network_token_details` (own-vault token), `card_with_limited_data`. (The schema also
carries `network_transaction_id_and_decrypted_wallet_token_details`, but its body is unspecified in the spec —
treat as not-yet-released.) For own-vault variants, the `network_transaction_id` from the original CIT is the
scheme linkage to the original transaction and must be carried forward. Retain customer consent evidence separately. `[DOCS integrate/api-only; openapi RecurringDetails]`

### 10.4 Zero-auth (validate a card, no funds held)
`amount:0` + `capture_method:"manual"` + `setup_future_usage:"off_session"` + `currency` (still required) +
`customer.id`. Validates number/expiry/issuer/AVS/CVV without holding funds; void afterward for cleanup
(`POST /payments/{id}/cancel`). For a free-trial→paid flow, add `mandate_data` (with the real subscription
price as the mandate max) so the mandate is established at 0 and the first real charge is an MIT. Plain
zero-auth does **not** require `mandate_data`. `[DOCS flows/zero-auth, flows/recurring-zero-auth]`

### 10.5 Gateway-agnostic MIT
One saved `payment_method_id` can be charged across **PeachPayments, ACI, and Cybersource**, with automatic
connector-fallback on soft decline and the authorisation-chain data carried automatically. The charge shape is
the ordinary payment_method_id MIT. The schema documents the business-profile field
`is_connector_agnostic_mit_enabled` set via `POST /account/{account_id}/business_profile/{profile_id}`. (The
doc pages also show `POST …/toggle_connector_agnostic_mit {"enabled":true}`, but that path is absent from the
OpenAPI spec. This is a source discrepancy, not proof either administrative operation is enabled for the merchant. Confirm the authorized configuration path and test it in sandbox before changing a shared profile. `[VERIFY-SANDBOX]`) `[DOCS gateway-agnostic, flows/gateway-agnostic-mit; openapi ProfileResponse]`

## 11. Payment states and webhooks

### 11.1 State machine (use the OpenAPI enums as authoritative)
The `payment-states` page gives a simplified teaching list; the **authoritative enums** are in the spec:
- `IntentStatus` (16): `requires_payment_method`, `requires_confirmation`, `requires_customer_action`,
  `requires_merchant_action`, `requires_capture`, `processing`, `succeeded`, `failed`, `cancelled`,
  `cancelled_post_capture`, `partially_captured`, `partially_captured_and_capturable`,
  `partially_authorized_and_requires_capture`, `partially_captured_and_processing`, `conflicted`, `expired`.
  (Note it is `requires_customer_action`, **not** `requires_action` as the prose list mislabels it.)
- `AttemptStatus` (28): `started`, `authentication_pending/successful/failed`, `authorizing`, `authorized`,
  `authorization_failed`, `charged`, `voided`, `router_declined`, `capture_initiated/failed`, `expired`, … .

Branch payment logic on `IntentStatus`. `[DOCS openapi IntentStatus/AttemptStatus; payment-states]`

### 11.2 Webhooks
- **Signature**: HMAC-**SHA512** over the raw body, using the profile's `payment_response_hash_key`, compared
  against header `x-webhook-signature-512`; reject a mismatch with 401. The same key signs the 3DS/redirect
  return-leg params. This is neither Checkout V2's scheme nor Payments API v2's — don't reuse code across
  surfaces (`webhooks.md`). `[DOCS operate/webhooks, concepts/three-ds-next-action]`
- **Event types — 29 values** in the `EventType` enum: 9 `payment_*` (incl. `payment_captured`,
  `payment_partially_authorized`, `payment_expired`, `payment_cancelled_post_capture`), `action_required`,
  2 `refund_*`, **7 `dispute_*`** (`dispute_opened/expired/accepted/cancelled/challenged/won/lost`), 2
  `mandate_*`, 7 `payout_*`, `invoice_paid`. There are **no `subscription_*` event types** — don't invent
  them. `[DOCS openapi EventType]`
- **Config lives on the business profile** (`webhook_details`: `webhook_url`, the `*_enabled` toggles,
  `payment_statuses_enabled`, `refund_statuses_enabled` — use `succeeded`/`failed`, not `success`/`failure`),
  plus `outgoing_webhook_custom_http_headers`. `[DOCS operate/webhooks; openapi WebhookDetails]`
- The webhook-delivery-log endpoints (`POST /events/profile/list`,
  `GET /events/{merchant_id}/{event_id}/attempts`, `POST /events/{merchant_id}/{event_id}/retry`) require a
  **Dashboard session**, not a merchant `api-key` (they return `IR_04`/`IR_01` otherwise). `[DOCS operate/webhooks]`
- The current `/flows/webhooks` page documents retries at 1 minute, 5 minutes, 10 minutes,
  1 hour, 6 hours and 24 hours. This is documentation, not observed delivery timing; tolerate
  duplicate, delayed and out-of-order events. Reconcile gaps after the retry window.
- **Operational**: status queries are rate-limited to **2/min per transaction** (poll ~30s apart; a
  rate-limited sync keeps the current status rather than failing). `800.900.201` "unknown channel" = the
  Entity ID is not enabled for that brand (a provisioning issue, not a request bug). `[DOCS integrate/api-only]`

## 12. Migrating from the legacy S2S / OPPWA API

For a merchant moving off the form-urlencoded card facade (`payments-api.md`, `legacy-surfaces.md`):
`[DOCS migration-s2s]`

| Legacy S2S | Orchestration |
|---|---|
| `POST /v1/payments` `paymentType=DB`/`PA` | `POST /payments` (`PA` = `capture_method:"manual"`) |
| `POST /v1/payments/{id}` `CP` (capture) | `POST /payments/{id}/capture` |
| `POST /v1/payments/{id}` `RV` (reverse) | `POST /payments/{id}/cancel` (void, pre-capture) |
| `POST /v1/payments/{id}` `RF` (refund) | `POST /refunds` |
| `GET /v1/payments/{id}` | `GET /payments/{id}?force_sync=true` |
| `Authorization: Bearer` + `entityId` | `api-key` (per-merchant) + connector account (`entityId` → MCA `connector_account_details.key1`) |
| amounts `92.00` (major) | `9200` (minor units) |
| card fields flat | nested under `payment_method_data.card.*` |
| `merchantTransactionId` | `connector_request_reference_id` |
| `registrationId` (stored card) | `recurring_details` + `mandate_id`/`payment_method_id`; the legacy `standingInstruction.type` maps to `mit_category` |

## Traps

- **Minor units.** `6500` = R65.00 here; Checkout V2 / Payments API v2 take `"65.00"`. 100× if copied across.
- **`payment_method_id` is not a top-level field** — always reference stored credentials via `recurring_details` (§10.3).
- **`capture_method` has five values, not two** (§3) — a merchant on `manual_multiple`/`scheduled`/`sequential_automatic` behaves differently; verify semantics in sandbox.
- **Void is pre-capture only; a PA cannot be refunded** (§6). Once captured, refund; use `cancel_post_capture` only where its status-eligibility applies.
- **Overcapture is opt-in** (`enable_overcapture` at create), not a capture-time amount you can just exceed (§6).
- **`allowed_payment_method_types` filters, it does not enable** (see `sdk-web.md` §2) — and enabling a method is a Dashboard/account change, not just a code change.
- **Three webhook schemes across three products** — Orchestration is SHA512/`x-webhook-signature-512`; do not reuse Checkout V2 or Payments API v2 verification code (§11.2, `webhooks.md`).
- **The redirect URL is Peach-hosted and internal** — send it verbatim, never parse or infer the bank from it (§4).
- **Confirm outcomes server-side** — webhook + `GET /payments/{id}`, never the client event or a return-URL `status` param (which is frequently `processing`).

## Sources

All `[DOCS]` facts fetched 2026-09-07 from the public Peach Orchestration docs
(playground.peachpayments.com — `llms-full.txt` + `openapi.json`, pinned in `versions.md`). Where
the OpenAPI spec and a prose page disagree, the spec is treated as authoritative and the discrepancy noted
inline. Fields named without documented behaviour are marked `[VERIFY-SANDBOX]`. Nothing internal to Peach is
reproduced here — the skill cites only public playground pages.
