# Recurring payments and tokenisation

## When to load

Anything subscription/recurring-related, storing cards, one-click checkout, charging a saved card,
card-on-file (CIT/MIT), network tokens, or card operations (capture/reverse a pre-auth). Also read
`playbooks/subscriptions.md` (building subscriptions) and
`playbooks/failed-renewal-card-expiry.md` (card expired / renewal failed).

## The single most important fact

**Peach has no subscription/scheduler product.** "Recurring payments" in the Dashboard only
provides a separate set of **recurring API credentials** (recurring entity ID + access token,
activated by support) and shows which methods support recurring. The merchant always owns:
the billing schedule, retry/dunning logic, and card-expiry handling. Anyone promising "Peach
handles the retry" is wrong — build the loop (`playbooks/subscriptions.md`).

> **Two different recurring models exist — don't cross them.** This file documents the **Checkout /
> card-facade** model: a `registrationId` + `standingInstruction` MIT debits, with your own scheduler. The
> newer **Orchestration** product has a distinct model — `mandate_data` / `mandate_id` / `recurring_details`
> with a formal mandate maximum, plus a simpler `payment_method_id` token vault (which is still charged
> **through** `recurring_details`, never as a top-level `payment_method_id` field) — documented in
> `orchestration-api.md` §10. Pick the one that matches the merchant's product; the fields and endpoints do
> not interchange.

## Tokenisation — storing a card (the CIT)

- Checkout: `createRegistration: true` on `POST /v2/checkout` (cards: Visa/Mastercard/Amex/Diners,
  via `DB` or `PA`; wallets: `DB` only). `allowStoringDetails: true` is the shopper-opt-in variant
  (mutually exclusive; `registrationId` may be absent — handle it).
- Payment Links API: `checkout.tokeniseCard: true` (API-created links only, not Dashboard links).
  A **zero-amount `PA` link** tokenises without charging — ideal for retokenization flows (an amount
  of `0` is accepted only with `paymentType: PA` + `createRegistration: true`). Not universal across
  acquirers: if a zero-amount request is rejected on your entity, fall back to a small
  auth-and-reverse (`PA` then `RV`) to tokenise.
- Result: a `registrationId` (docs example format: `8ac7a49f8e9f15d2018ea09b285f0ebz`) returned top-level in the checkout
  response, `GET /status`, and the `successful`/`completed` webhook (Payment Links: only on
  `completed`, card brands only — plan your capture point there).
- Standalone registration without payment (S2S card facade): `POST /v1/registrations` with card +
  customer data (no `paymentType`).
- Variable amounts: fixed schedule → `type: RECURRING`; variable/ad-hoc (metered-style) amounts → `type: UNSCHEDULED` with each debit its own amount (MC `recurringType` rules still apply).
- **Permission is mandatory** — get the customer's consent to store; display it. Removal: Embedded
  `onRemoveCard(token)` (return true to confirm) or Hosted `cardRemovalUrl` (POSTs `checkoutId`,
  `registrationId`, `signature`). Never re-present a removed token in `cardTokens`.
- **Merchant-initiated deregistration**: `DELETE {card-facade}/v1/registrations/{registrationId}?entityId=…` disables the token for future payments `[DOCS — S2S registration tokens]`. Use it for card-removal/erasure requests — but the customer's transaction HISTORY (and its retention obligations) lives in your ledger and Peach's records, not in the token; erasure-vs-retention conflicts are a legal question for the merchant's counsel, not an API feature.
- One-click checkout: pass stored tokens via `cardTokens: [...]` (must be linked to the customer);
  optionally `card.registrations.requireCvv: true` in Embedded for CVV on repeat payments.

## Charging a saved card

### One-click (shopper present — still a CIT)

Pass the stored `registrationId`/`cardTokens` on a normal checkout with
`standingInstruction: { source: "CIT", mode: "REPEATED", type: "UNSCHEDULED" }`. No CVV/3DS
needed beyond the session's own authentication.

### Merchant-initiated (MIT) — the recurring debit

Card facade (`https://card.peachpayments.com/v1`, sandbox `https://sandbox-card.peachpayments.com/v1`):

```text runnable
POST /v1/registrations/{registrationId}/payments
Authorization: Bearer <S2S/recurring token>      ← NOT the Checkout OAuth token [PLUGIN-VERIFIED]
{ "entityId": "…", "amount": "299.00", "currency": "ZAR",
  "paymentType": "DB",                            // or PA
  "standingInstruction": {
    "source": "MIT", "mode": "REPEATED",
    "type": "RECURRING",                          // UNSCHEDULED | INSTALLMENT | RECURRING
    "initialTransactionId": "<schemeTransactionId from the original CIT>"
  } }
```

- **Use a Server-to-Server / recurring / COPYandPAY bearer token** (from those Dashboard
  sections), not the Checkout token — wrong token = auth failures. `[PLUGIN-VERIFIED]`
- Standard MIT debits carry **no CVV/3DS** (docs: REPEATED mode = *without* such data). ⚠️ But merchant-initiated 3DS DOES exist as a separate 3RI flow (`threeDSecure.channel=01` + `threeRIInd` — `3ds-advanced.md`) for recurring-transaction authentication when the issuer requires it — don't say "MITs can never run 3DS".
- **Retry-safety (avoid double-charging):** the MIT debit POST has no documented server-side
  idempotency key, and it runs unattended in your scheduler — the exact place a timed-out request
  gets blind-retried into a second charge. Make the debit idempotent on YOUR side: key each attempt by
  `(customerId, billingPeriod)`, and if a POST times out or returns uncertain, **query the transaction
  status before retrying** rather than re-POSTing. Never blind-retry an uncertain money operation.
  `[DOCS]` (no documented idempotency header) + `[PLUGIN-VERIFIED]` (check-status-then-decide)
- `standingInstruction.initialTransactionId`: the scheme transaction id returned by the original
  CIT (in webhook/status as `schemeTransactionId` / `cardholderInitiatedTransactionId` — you get
  one or the other depending on acquirer). Omitting it rarely hard-rejects at the API, but per
  card-scheme MIT rules the cost lands downstream: higher MIT decline rates and interchange /
  authentication downgrades across the series. Capture and send it whenever available — its absence
  is not silently safe (exact enforcement is acquirer-dependent).
- Mastercard: `recurringType` (`SUBSCRIPTION|STANDING_ORDER`) required for all CIT and MIT.
  Visa India-issued cards: required as well. Recurring: `type: RECURRING`; installments:
  `type: INSTALLMENT` (+ `numberOfInstallments`).
- Store per-customer: `registrationId`, `initialTransactionId`, `card.last4Digits`,
  `card.expiryMonth/Year` (from `/status` — you need these for expiry monitoring; they are
  browser-safe), brand.

### `standingInstruction` field reference

| Field | Values | Notes |
|---|---|---|
| `source` | `CIT` \| `MIT` | who initiated: shopper vs merchant. Mode ≠ initiator — `REPEATED` appears with both; set source correctly |
| `mode` | `INITIAL` \| `REPEATED` | first stored-credential use vs subsequent |
| `type` | `UNSCHEDULED` \| `RECURRING` \| `INSTALLMENT` | billing shape |
| `recurringType` | `SUBSCRIPTION` \| `STANDING_ORDER` | MC mandatory (CIT+MIT); Visa India |
| `frequency` | 1–9999 (days) | common: 7/30/90/365 |
| `expiry` | `YYYY-MM-DD` (future) | mandate end; mandatory for 3DS-on-recurring |
| `industryPractice` | `INCREMENTAL_AUTH` etc. | hotel/auto-use cases |
| `numberOfInstallments` | 1–999 | required when `type=INSTALLMENT` with EMV 3DS |

> **`800.100.156` (format error) on a card MIT/recurring?** Peach's published guidance: setting
> `standingInstruction.type` to `INSTALLMENT` triggers a format error with multiple card issuers —
> use `UNSCHEDULED` instead until it's resolved. `[DOCS]` (see `result-codes.md`)

## Which methods can go recurring at all

Cards + tokenised wallets (Apple/Google/Samsung Pay tokens — "primarily for recurring" per docs).
EFT/BNPL/mobile-money methods are effectively not MIT-recurring (methods-catalog.md). If a
subscription business relies on Payflex/ZeroPay-style methods, model renewals as new
shopper-present payments (links/checkout), not saved-credential debits.

## Card operations: capture, reverse (the PA lifecycle)

Pre-authorisations (`paymentType: PA` created with `forceDefaultMethod:true` +
`defaultPaymentMethod:CARD`) must be captured or reversed: **7-day window**, after which they
drop. Same card-facade host + S2S token as above:

| Operation | Call | Notes |
|---|---|---|
| Capture | `POST /v1/payments/{paId}` `{entityId, amount, currency, paymentType:"CP"}` | full or partial; multiple captures allowed while total ≤ PA; **captures cannot be undone**; uncaptured PA never settles |
| Reverse (void) | `POST /v1/payments/{paId}` `{entityId, paymentType:"RV"}` | full reversal needs no amount; partial RV (amount+currency) is acquirer-dependent |
| Refund | `POST /v1/checkout/refund` (V1 endpoint) | **refunds apply to captured debits only — never to a PA** |

**CP/RV response shape** `[DOCS]`: capture and reverse return the card-facade envelope — `id`,
`result.code` (branch on this, never the HTTP status), `result.description`, `timestamp`, `ndc`
(the docs' "internal unique identifier for the request"), `referencedId` (the PA being captured/reversed), and — when the acquirer
approves — `amount` + `currency` (the amount actually captured) plus `resultDetails.AcquirerResponse`.
A CP or RV can be DECLINED with a non-success `result.code`, so confirm the code before you treat the
money as moved, and on a partial capture reconcile against the response `amount` (what the acquirer
approved), not the amount you requested.

Refund (recap from `checkout-v2.md`): form-urlencoded, flat dotted keys
(`authentication.entityId`, `amount`, `currency`, `id` = **32-hex transaction id** in the body,
`paymentType=RF`), signed with the secret token (sorted key+value HMAC). **Peach returns HTTP 200
even for declined refunds — check `result.code`.** `[PLUGIN-VERIFIED]`

**Declined-but-held funds**: a failed or abandoned authorisation can leave an issuer-side hold the shopper sees on their bank app. A hold is NOT a capture — never refund (`RF`) it (nothing was captured); to release proactively, reverse the PA (`RV`) inside the 7-day window; otherwise the issuer releases it automatically (Peach docs publish no timeline — treat "how long" as issuer-dependent and reassure the shopper accordingly).
PA + reverse is the zero-settlement way to verify a live integration (`playbooks/go-live.md`).

## Network tokens (optional, stronger)

Issuer-manained card-format tokens (`654321XXXXXX7890`) replacing the registration token for
card-brand rails: auto-updates (some expiry changes), dynamic cryptogram, silent 3DS, ~10bps Visa
interchange benefit. Behavior: a MIT on an existing registration can auto-provision one
(`paymentType: TK` provisioning / `TF` fetch transactions appear; `800.100.311` = token request
in-flight — retry later). Proactive: `POST /v1/registrations/{registrationId}` with
`createOmniToken=true`. `card.bin` keeps returning the ORIGINAL PAN BIN (network-token BIN
differs — don't alert on BIN changes). Errors `100.350.317` (already requested) / `.318`
(not enabled). Test cards are expiry-keyed: xx/2031 valid, 2034 full lifecycle, 2035 card-update
(see `testing-and-go-live.md`). Cryptogram rule: if the CIT was authorized with the network token,
MITs need no cryptogram; if the CIT used the real PAN, the first token-MIT must include one.
Enable via support/scheme onboarding.

## Design checklist for the billing loop you own

1. Tokenise at first payment (CIT, `mode:INITIAL`); persist `registrationId`,
   `initialTransactionId`, card last4 + expiry.
2. Scheduler fires MIT debits (`mode:REPEATED`, `source:MIT`) — idempotent by
   (customerId, billingPeriod) key.
3. Classify every debit: success / pending (`000.200.*`, `800.400.5*` — async, wait) / soft
   decline (`300.100.100` — retry after 3DS… but MITs can't 3DS, so treat as retryable-decline) /
   hard decline / expired card.
4. Dunning ladder keyed off `MerchantAdviceCode`: `03` **do NOT retry** (Dashboard: "Retry is not allowed" — stop billing this mandate; API gloss says re-initiate — resolve per acquirer), `02` retry later,
   `04` never retry — cancel mandate, `01` card updated upstream — retry now.
5. Monitor stored `expiryMonth/Year` monthly; before a scheduled debit would fail on expiry,
   trigger retokenization: `playbooks/failed-renewal-card-expiry.md`.
6. Never store PANs/CVV; registrations only. Stay SAQ A (`pci-security.md`).

## Traps

- S2S/recurring token vs Checkout OAuth token confusion — different credentials, same-looking
  bearer flow. `[PLUGIN-VERIFIED]`
- `registrationId` arrives only on specific events (Links: `completed` only) — miss the event,
  lose the token.
- CVV/3DS params present on an MIT debit = rejected flow.
- Deregistered token (customer removed card) — debit fails; detect and route to retokenization,
  not endless retries.
- `mode: REPEATED` does NOT mean shopper-absent — `source` carries that meaning.
- Zero-decimal/3-decimal currencies are out of scope for Checkout amount strings — 2dp only.
