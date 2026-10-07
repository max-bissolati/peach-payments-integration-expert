# Webhooks — signature verification and delivery semantics

## When to load

Implementing or debugging ANY webhook endpoint for Peach (Checkout, Payment Links relay, refunds),
designing idempotent webhook processing, or deciding what a webhook may be trusted to do. If you
need to verify a payload right now: `scripts/verify-webhook.js`.

## Select the webhook product first

This file's opening doctrine and Scheme A/B helpers apply to classic Checkout. For POS, read
`pos-integrations.md`: JSON payloads, configured custom-header authentication, operation-specific
success and correlation, REST polling or Intent recovery. Do not call Checkout status with POS IDs,
require nonexistent POS HMAC headers, or assume Checkout's retry schedule. Orchestration and
Payments API have their own sections below.

## The doctrine (read this first)

1. **A webhook is a wake-up call, not a source of truth.** Verify its signature, then re-fetch
   `GET /v2/checkout/{checkoutId}/status` and use THAT (outcome + amount) to fulfil. The body's
   field values are signed but the classic scheme's canonicalisation is not injective — a captured
   signature could be replayed with altered fields. Acting only on `/status`-confirmed terminal
   success closes replay, tamper, and ordering holes at once. `[PLUGIN-VERIFIED]`
2. **Fail closed.** If you cannot verify a webhook, never act on it: log the failure and
   return non-200 (Peach will retry — useful while your config is broken) or 200 with the event
   parked for investigation. Never process an unverified body, and never "temporarily disable"
   verification. No secret token configured = nothing can verify = never act. `[PLUGIN-VERIFIED]`
3. **Idempotent by key.** Deduplicate on `webhookId` (header scheme) or `checkoutId` + state
   bucket. Never downgrade an already-confirmed order because a late `cancelled`/`uncertain`
   webhook arrives — delivery order is NOT guaranteed.

## What arrives, and when

- Sent on every state change of DB (debit), PA (pre-auth), RF (refund) requests. States:
  `created → pending → successful | cancelled | uncertain`, and late
  `uncertain|cancelled → successful` is possible (a customer who "cancelled" then completed on
  another device).
- **The first webhook after you configure an endpoint is JSON** (config verification); **all
  subsequent ones are `application/x-www-form-urlencoded`**. Handle both content types.
- Typical codes: created `000.200.100`; pending `000.200.000`; successful `000.000.000` /
  `000.100.110` (sandbox); uncertain `100.396.104`; cancelled `100.396.101`; refunds arrive with
  `paymentType=RF` and `referencedId` = original transaction.
- Successful payloads add: `id` (transaction id), `paymentBrand`, `recon.{authCode,rrn}`,
  `resultDetails.*`, optional `card.*`, `customer.*`, `shipping.*` (Express with
  `requiresShipping`), `registrationId` (when tokenising).
- `notificationUrl` (per checkout) and the Dashboard webhook BOTH receive events.
- Field names use **dot notation** in the classic body: `result.code`, `result.description`,
  `resultDetails.ExtendedDescription`, `card.last4Digits`, `billing.city`, etc. (the underscore
  `result_code` form shows up only in prose, never in a real payload) — code for dot-keys. `[DOCS]`

## Delivery semantics

- Your endpoint must return **HTTP 200** to acknowledge; otherwise Peach retries with exponential
  backoff: **2, 4, 8, 15, 30 minutes, 1 hour, then daily up to 30 days** (Checkout / Payment
  Links). Payments API webhooks use a shorter window — **7 days** (6-hourly after the initial
  ramp); see below. `[DOCS]`
- Not ordered. Use the payload `timestamp` (ISO 8601) for ordering, never arrival order.
- Pending (`000.200.*`) webhooks are not guaranteed for every session — don't build state machines
  that require them.
- Source IPs are published (live includes e.g. `54.217.71.82`, `185.147.172.128/25`,
  `18.202.83.149`, `52.212.210.254`) if you want an optional IP guard — but authentication is by
  signature, not IP.

## Scheme A — classic body signature (what Checkout sends by default)

- Body is form-urlencoded; the signature is a **field inside the body**: `signature=<64-hex>`.
- Secret key: the Checkout **secret token** (Dashboard → Checkout → API keys).
- Canonical string: **ALL other body parameters — including empty-valued ones — sorted
  alphabetically by key, concatenated as `key` + `value` with NO separators** (no `=`, no `&`):
- **Canonical caveat (empty-value ambiguity):** because values are joined with no separators, two
  different parameter sets can collapse to the same canonical string when empty values are involved
  (e.g. `ab=&c=1` and `a=&bc=1` both become `abc1`), so a single signature can "verify" either body.
  This mirrors Peach's own canonical form, so the verifier cannot fix it without breaking compatibility.
  Mitigation: never re-verify an attacker-modified parameter set, and trust only the fields that were
  present in the originally signed body — re-confirm the outcome and amount via `GET /status` regardless.

```js
// runnable (Node, no deps)
const crypto = require("crypto");
const params = new URLSearchParams(rawBody);        // raw form body string
params.delete("signature");
const keys = [...params.keys()].sort();
const message = keys.map(k => k + (params.get(k) ?? "")).join("");
const expected = crypto.createHmac("sha256", SECRET_TOKEN)
  .update(message).digest("hex");
// compare with timing-safe equality against body signature
```

- Real-world example message:
  `amount5.00authentication.entityId8ac7…currencyZARid8ac7…paymentTypeRF`
- The same construction signs the shopperResultUrl POST return body (Hosted Checkout).
- Repeated form keys: emit one entry per value when reconstructing.
- The same secret token signs V1 refund requests (`checkout-v2.md` → refunds).

### The framework-body trap (the #1 integration bug)

JSON/form-parsing middleware (Express body parsers, Next.js route handlers, Medusa) consumes the
raw bytes and hands you a parsed object — the raw body needed for verification is gone. Two ways
out: `[PLUGIN-VERIFIED]`
1. **Raw-body route**: mount the webhook route with raw-body preservation
   (`express.raw({type: "application/x-www-form-urlencoded"})`), or read the request as text
   before any parser.
2. **Reconstruct from the parsed object**: flatten nested keys to form notation
   (`customParameters: {medusaSessionId}` → `customParameters[medusaSessionId]`), drop
   `signature`, sort alphabetically, concat `key`+`value` (no separators, include empties),
   HMAC-SHA256 hex. This reproduces Peach's signature exactly — proven against real sandbox
   webhooks. `[PLUGIN-VERIFIED]`

## Scheme B — header signing (Dashboard-enabled, GA 2026-07-21)

Enable under Dashboard → **Webhook security** and copy the shared secret (regeneration is
immediate; disabling/re-enabling without regenerating reuses the key). Every webhook then carries:

```
x-webhook-signature-algorithm: HMAC-SHA256  (header name documented; the exact algorithm string is convention — verify the value your dashboard shows `[VERIFY-SANDBOX]`)
x-webhook-timestamp: <ts>
x-webhook-id: <unique id>
x-webhook-signature: <hex>
```

Verification (Checkout and Payment Links alike):

```js
// runnable (Node) — payload is the RAW body exactly as received
const message = `${ts}.${webhookId}.${configuredUrl}.${rawBody}`;
const expected = crypto.createHmac("sha256", SECRET)
  .update(message).digest("hex");
// timing-safe compare with header x-webhook-signature
```

- The **URL in the message is the webhook URL you configured** — exact match required.
- Checkout bodies are form-urlencoded; **Payment Links bodies are JSON**.
- `webhookId` exists to enable replay protection and idempotency — store it. Reject a webhook whose
  `x-webhook-timestamp` is stale (allow a few minutes' clock skew) so a captured request can't be
  replayed later.
- ⚠️ version-sensitive — header signing is new; classic body signature still arrives on Checkout
  webhooks. Verify whichever scheme you're configured for; supporting both is safest.

## Idempotent processing pattern

```text
receive → verify signature (fail closed) → parse checkoutId + result.code
→ dedupe key: webhookId | (checkoutId + result bucket)
→ if not terminal-success: log, 200, done (pending webhooks must NOT trigger fulfilment
  — authorizing an un-authorized session just fails and your queue retries ~30×) [PLUGIN-VERIFIED]
→ if terminal success: GET /status → confirm result.code AND amount == created amount
  (missing amount on /status = fail closed) → fulfil inside a transaction → 200
```

Never fulfil, refund, or downgrade based on webhook fields alone. Late out-of-order
cancelled/uncertain after success: ignored by design (state machine only moves forward except
when /status itself says so).

## Other products' webhooks (don't cross the schemes)

⚠️ **Each surface has its OWN retry ladder — never mix them**. Checkout/Links: **FIRST RETRY AT 2 MINUTES** (not 1) — 2/4/8/15/30 min → 1 h → daily → 30 days; Payment Links: same 30-day shape; Payments API v2: shorter 7-day schedule (see
`payments-api.md` for its exact steps); Payouts: 30 days; **Orchestration**: ~24 h ladder
(1m/5m/10m/1h/6h/24h, prose-documented — `orchestration-api.md`). Quote the target surface's schedule from
its own file only.

- **Payment Links**: Scheme B headers, **JSON body**; link events `initiated|opened|processing|
  completed|cancelled|expired`; `registrationId` only on `completed`. **Bulk link webhooks are NOT
  signed.** Links also relay underlying Checkout webhooks unless support disables.
- **Payments API**: bodies are **AES-128-GCM encrypted** (hex); per-webhook secret, `iv` + auth
  tag in headers, optional `{"encryptedBody": …}` wrapper; first message is
  `{"verificationCode": …}`; Dashboard **PII toggle must be ON or webhooks stop being sent**;
  7-day retry. Details: `payments-api.md`.
- **Payouts**: signed via **Svix** headers (`webhook-id`, `webhook-timestamp`) — use Svix
  libraries. Details: `payouts.md`.
- **Orchestration** (the Hyperswitch surface): HMAC-**SHA512** over the **raw body**, header
  `x-webhook-signature-512`, keyed by the profile's `payment_response_hash_key` (reject mismatch with 401);
  JSON body. The `EventType` enum has **29 values** — 9 `payment_*`, `action_required`, 2 `refund_*`, **7
  `dispute_*`**, 2 `mandate_*`, 7 `payout_*`, `invoice_paid` (no `subscription_*`). Config lives on the
  **business profile** (`webhook_details`; status lists use `succeeded`/`failed`, not `success`/`failure`).
  The delivery-log/retry endpoints (`/events/...`) need a **Dashboard session**, not the merchant `api-key`.
  The current flow page documents retries at 1m, 5m, 10m, 1h, 6h and 24h; do not reuse classic
  Checkout's 30-day schedule. Full detail: `orchestration-api.md` §11.2 (and `mobile.md` §7 for the SDK view).

## After a duplicate-fulfilment incident (replay storm recovery)

When webhooks were redelivered/replayed and you fulfilled twice:
1. **Freeze fulfilment** for the affected window before touching data.
2. Export every webhook received in the window from your logs; dedupe by `webhookId` (Scheme B) or
   `checkoutId` + result bucket (Scheme A) — that set is the unique payment events.
3. For each unique successful `checkoutId`: `GET /status` — terminal success + amount match is
   truth (`scripts/map-result-code.js` to classify).
4. Diff against your fulfilled orders → true duplicates are orders fulfilled more than once per
   unique payment.
5. Correct money with the write gate: refund captured duplicates (`checkout-v2.md` § Refunds); a
   still-open PA is reversed (`RV`), not refunded. Cross-check with the recon API's RF rows
   (`reconciliation.md`) so books and PSP agree.
6. Fix the root cause before resuming: store `webhookId`/event keys durably and fulfil exactly once
   per payment (the idempotent pattern above makes this class of incident impossible).

## Traps

- First-webhook-is-JSON vs rest-form-urlencoded: content-type switch breaks naive parsers.
- `signature` is in the BODY (classic), not a header — header-only verification code silently
  passes nothing.
- Sorting is by key; empty values are included; no separators — every deviation breaks the HMAC.
- Framework JSON parsing eats the raw body → verification always fails → people "temporarily"
  disable verification. Never. Reconstruct instead (above).
- Returning non-200 indefinitely = 30 days of retries filling your queue; return 200 once you've
  durably recorded the event (process async).
- Don't act on `pending` (`000.200.*`) — only terminal success, confirmed via `/status`.
- Webhook URL config lives in the Dashboard (and per-checkout `notificationUrl`); the secret token
  surfaces when you add the webhook — until it's set, verification fails closed by design.
  `[PLUGIN-VERIFIED]`
