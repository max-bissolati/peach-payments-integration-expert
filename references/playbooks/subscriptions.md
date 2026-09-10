# Playbook — "I need subscriptions / recurring billing"

## When to load

The user says subscription, recurring, retainer, instalments-from-a-wallet, "charge them every
month", membership, SaaS billing, or renewal anything. Pairs with
`../recurring-and-tokenisation.md` (mechanics) and `failed-renewal-card-expiry.md` (failure path).

## Step 0 — Route by platform first

| Platform | Answer |
|---|---|
| **WooCommerce** | Official Peach extension + **Woo Subscriptions**: request a **Recurring ID** and **Card Webhook Decryption key** from Peach support, enable **Card Storage** in the plugin. This is the supported path — do not hand-roll |
| **Magento** | Official plugin + paid **ParadoxLabs Adaptive Subscriptions** extension + recurring entity configured by support |
| **Xero** | Invoices: connect Xero (Dashboard → Connect); **repeating invoices** are supported natively — Peach collects them |
| **Shopify** | **Peach cannot do recurring on Shopify** (once-off only). Options: (a) accept once-off + manual renewal via Payment Links, (b) bill subscriptions off-platform, (c) different platform. Say this plainly — don't improvise |
| **Medusa** | The Peach plugin implements checkout + refunds but NOT a subscription scheduler — you build the billing loop below on top of stored registrations |
| **Custom build** | Continue below |

## Step 1 — The architecture you are signing up for

Peach provides: tokenisation (CIT), stored-credential debits (MIT), result codes. You provide:
the schedule, retries/dunning, card-expiry handling, cancellation/plan-change UX, proration
policy, and reconciliation. Draw this picture for the user before writing code — half of failed
subscription projects assumed the PSP owned the loop.

```
[CIT] signup → Checkout (createRegistration:true, standingInstruction INITIAL)
         → store: registrationId, initialTransactionId, last4, expiry, brand
[SCHEDULE] your cron/queue fires per (customer, period) — idempotency key: customerId+period
[MIT] POST /v1/registrations/{registrationId}/payments (source:MIT, mode:REPEATED, type:RECURRING)
         → classify result (../result-codes.md) → success | pending | soft | hard | expired
[DUNNING] ladder below; expired → failed-renewal-card-expiry.md
```

## Step 2 — Subscription state machine (steal this)

```
TRIALLING ──first debit ok──► ACTIVE ──payment_failed──► PAST_DUE ──all retries failed──► CANCELLED
                                 │  ▲                        │
                                 │  └──payment recovered─────┘ (grace period)
                                 └──user cancels──► CANCEL_AT_PERIOD_END ──period end──► CANCELLED
PAUSED (optional, manual) ──resume──► ACTIVE
```

- Keep entitlement active through a **grace period** (e.g. until `currentPeriodEnd`) while
  `PAST_DUE` — feature-gate on `status==ACTIVE || (status==PAST_DUE && now < graceEnd)`.
- `TRIALLING` without a card: first debit is the trial→active transition; with a tokenised card:
  zero-amount PA authorisation at signup proves the card works without charging.
- Persist every state transition as an event row (audit + support tooling), and make the debit +
  state change one DB transaction.

## Step 3 — Dunning ladder (data, not vibes)

| Day (after failed debit) | Action |
|---|---|
| 0 | classify failure; if `MerchantAdviceCode 04` → skip ladder, go to retokenization/cancel |
| 1 | retry debit (MAC `02` only — ⚠️ MAC `03` = "do not try again" per Dashboard docs); email "payment failed, update card" with retokenization link |
| 3 | retry; SMS/WhatsApp if available |
| 7 | retry; warning of suspension at period end |
| 14 | final retry; "subscription ends on <date>" |
| period end | downgrade to CANCELLED (or dunning-complete state per product policy) |

- Retry timing: avoid retrying a hard issuer decline (`800.100.152`-family) repeatedly — the
  issuer will keep declining; MAC drives the decision.
- Every email/SMS must deep-link to a **retokenization payment link** (`failed-renewal-card-expiry.md`)
  — not to a generic "contact support".
- Amount changes mid-cycle: decide proration policy explicitly (none / immediate charge / credit);
  if you charge, it's a fresh MIT with its own idempotency key.

## Step 4 — Build-order checklist

1. Tokenisation at checkout (CIT) + persistence of registration fields.
2. Scheduler + idempotent MIT debit + result classification.
3. State machine + grace-period gating.
4. Dunning ladder + comms with retokenization links.
5. Expiry monitoring (monthly scan of stored expiryMonth/Year vs next debit date).
6. Cancellation flow: cancel schedule, optionally deregister token (only if user asks — other
   subscriptions may share it; tokens are per-customer).
7. Reconciliation habit: daily compare MIT debits vs your invoice rows (`../reconciliation.md`).

## Advisory notes the user hasn't asked about (raise them)

- **Refund policy for subscriptions**: partial-month refunds come out of your pocket — Peach
  refunds the debit, not the time. Decide proration before launch.
- **Method mix**: only card/wallet tokens recur. If your audience prefers EFT/BNPL, those
  "subscriptions" are renewal links, not debits — different UX, plan for it.
- **Trials**: prevent trial abuse with a `hasUsedTrial` flag keyed to customer + card fingerprint
  (registrationId), not email alone.
- **Mandate language**: scheme rules (MC recurringType) require you to have told the customer what
  they agreed to — keep the consent record with the registration.
- **Payout timing**: recurring debits settle per acquirer schedule (`../reconciliation.md`) —
  don't model cash availability as instant.

## Traps

- Building the scheduler inside the request handler (webhook-triggered) — use a durable queue;
  webhook retries will double-fire debits otherwise.
- Assuming 3DS can run on MIT — it can't; MIT approval rates depend on clean initial CIT data
  (billing address etc. at signup).
- One registration token shared across "products" then cancelled for one product — deregistering
  kills all; model token ownership per customer, not per subscription.
- Treating `000.200.000` (pending) as failed and retrying immediately — async rails (EFT-cards,
  some issuers) finalize in minutes to days; wait for the ladder, not the next tick.
