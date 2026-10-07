# Build an Orchestration integration

## When to load

Load when designing or reviewing a complete Peach Orchestration implementation: hosted checkout,
embedded web, native mobile, API-only payment methods, saved cards, recurring charges, or multiple
processor routing. Pair this workflow with [API contracts](../orchestration-api.md),
[Web SDK](../sdk-web.md), [mobile SDKs](../mobile.md), and
[network tokenisation](../network-tokenisation.md). POS is a separate payment surface; use
[POS integrations](../pos-integrations.md) for physical terminals.

Public documentation and selected OpenAPI fields were reviewed on **2026-10-07**. No merchant
configuration, sandbox transaction, SDK execution or connector behaviour was tested for this guide.
Product claims below come from those sources; persistence, concurrency and acceptance-test advice
is implementation guidance, not a promise of platform guarantees.

## 1. Discover and choose the payment surface

Establish country/currency, merchant account and business profile, required payment methods,
one-off versus saved-card/recurring use, capture timing, existing connectors, required checkout
experience, and who handles card credentials. Infer answers already in the project.

| Need | Start with | Responsibility that remains yours |
|---|---|---|
| Peach-hosted payment page | `POST /payments`, `confirm:false`, `payment_link:true`; redirect to `payment_link.link` | Trusted order amounts, authenticated creation, status reconciliation and fulfilment |
| Embedded web checkout and styled payment fields | Web SDK Payment Element; server creates intent, client confirms | SDK lifecycle, redirect return, accessibility and real-browser verification |
| Native customer payment app | Orchestration Mobile SDK V2 for the chosen platform | Supported-device testing, deep links, wallet onboarding and server confirmation |
| Custom alternative-method flow or an existing assessed credential system | API-only with `confirm:true` | Method-specific fields, redirects/QR, status recovery and assessed credential handling |

Use merchant enablement and method/currency support to constrain the choice. SDK
`paymentMethodOrder` affects presentation; `allowed_payment_method_types` filters enabled methods.
Neither provisions a connector. Native-sheet support is not implied by S2S or Web SDK support.

Hosted and SDK collection avoid your backend receiving raw card input. API-only PAN handling
requires an environment assessed for that handling. Network tokens and encrypted wallet payloads
have different risk profiles but do not, by themselves, remove PCI obligations. Do not present
headless card collection as merely a styling choice.

## 2. Model identities and operations before coding

| Record | Meaning and local handling |
|---|---|
| Merchant and `profile_id` | Merchant secret identifies the account. Profiles own shared defaults, webhook settings and routing-related configuration. Scope each local record to its merchant/environment/profile. |
| Customer | Map your authenticated customer to Peach's customer. Never let a client select another customer's saved methods or mandate. |
| Order/invoice | Your commercial record and authoritative amount/currency. Use a reference such as `merchant_order_reference_id` for reconciliation; a reference alone is not an idempotency guarantee. |
| Payment intent | One `payment_id`, potentially several processor attempts. Persist it before returning client session data; resume a valid existing payment where appropriate. |
| Attempt | An `attempt_id` and connector-specific status/error. Retain diagnostic references for support; fulfil from reconciled payment and money state, not the first failed attempt. |
| Capture/refund | Separate operation records, amounts and statuses. A refund request accepted for processing has not necessarily refunded the customer. |
| Saved method/mandate | Product-specific `payment_method_id` and optional `mandate_id`, consent and ownership. These are not classic Checkout `registrationId` values. |

A customer's second purchase is a new payment. Resuming the same in-flight purchase is different:
creating a fresh intent on every page reload fragments the history and can duplicate charges.
If the old session has expired, first resolve any uncertain payment outcome before replacing it.
Store only the client-safe session data needed for the SDK handoff; never log API keys, session
secrets, PAN, CVC, cryptograms or full payment-method payloads.

## 3. Implement the end-to-end flow

1. Authenticate the shopper or merchant operator. Calculate amount/currency on your server from
   trusted order data; Orchestration uses integer minor units.
2. Claim the local payment operation atomically. Use an existing correlated payment when the
   operation is already running. Make the create request using the merchant secret `api-key`.
3. For hosted/SDK flows, create with `confirm:false`, then pass only the appropriate link or
   intended `client_secret` handoff to the client. For S2S, supply the method-specific credential
   and `confirm:true`. Do not send `client_secret` with secret-key confirmation merely because
   the general schema lists it.
4. Let the SDK handle its normal challenge flow. In a custom flow, branch on `next_action.type`
   and use the freshly returned redirect URL verbatim. Support cancellation, abandonment and
   delayed completion. Return-URL parameters and SDK completion callbacks do not authorise fulfilment.
5. Authenticate notifications, fetch the correlated payment when reconciling, and verify merchant,
   profile, customer/order binding, currency, amount and captured state. Persist the transition
   and fulfil once. A `requires_capture` result authorises funds; it does not mean they settled.
6. Expose an order-status endpoint to the client. Keep an unresolved payment visibly pending
   while the backend reconciles it. Add a background sweep for abandoned challenges, pending
   captures/refunds and missing webhook deliveries.

Use [API contracts](../orchestration-api.md) for full request shapes and status enums. Handle unknown
or unresolved states by retaining them for reconciliation. Do not collapse every non-`succeeded`
response to a decline, or invent `refunded` as a payment intent status from a simplified diagram.

## 4. Saved cards, subscriptions and mandates

Separate **customer-present reuse** from **merchant-initiated charging**:

- Returning shopper at checkout: use the documented on-session save/reuse flow with the same
  customer and a new payment. A saved credential does not automatically make a transaction MIT.
- Scheduled or otherwise off-session charge: establish the documented customer-present setup
  and consent first, then call from your backend with `off_session:true`, `confirm:true` and
  `recurring_details` referencing `payment_method_id` or `mandate_id`. `payment_method_id` is not
  a top-level payment-create field.
- Use mandates when their documented consent and amount-limit model fits the contract. Persist
  evidence of consent, allowed amount/currency and revocation. Do not treat a mandate as a
  guarantee of approval or immunity from disputes.
- Own billing schedules, invoice uniqueness, cancellation and dunning in the application. A
  vaulted card or mandate is not a subscription scheduler. Reconcile an uncertain renewal before
  retrying; honour network/issuer retry advice and require a new customer action when needed.
- Zero-auth/free-trial setup is a specific documented flow, not permission to use `amount:0` for
  an ordinary purchase. Check connector eligibility and follow the zero-auth lifecycle.

See [API recurring flows](../orchestration-api.md#10-mandates-recurring-and-mit) for exact fields.
Classic `standingInstruction` and `registrationId` examples must not be copied into this product.

## 5. Routing and recovery have configuration limits

Orchestration can create multiple attempts within the same payment. The current 3DS guide describes
GSM classification of connector/network failures, configured automatic retry budgets, step-up to
3DS, connector fallback, and optional clear-PAN/alternate-network retries. These are conditional:

- Routing needs eligible provisioned connectors for the payment's method/currency and merchant.
  A listed API option does not prove it is enabled for that account.
- Step-up requires a matching retry rule and an allowed connector. A hard decline is not an
  instruction to loop through every processor.
- Gateway-agnostic MIT is documented for PeachPayments, ACI and Cybersource, with the business
  profile feature enabled and suitable routing. It does not establish portability to every PSP.
- Network-token fallback and clear-PAN retries are separately configured. Do not build an
  application-level token-to-PAN downgrade, acquire PAN unnecessarily, or replay a single-use
  cryptogram to imitate platform recovery.
- Before deciding to retry a final failure, inspect the intent's attempts, error details and
  applicable advice. It may already have exhausted platform retries. An HTTP timeout tells you
  about your connection, not whether the processor charged the customer.

Read the current profile before any proposed update. Changing a profile affects other payments
using it; preserve unrelated settings. Describe a proposed routing policy and sandbox scenarios
before changing configuration. Follow the user's authorisation requirements for account writes.
The documented feature-toggle path and available schema can differ; keep the discrepancy visible
and verify it rather than guessing an administrative API.

## 6. Idempotency and uncertain outcomes

Implement local uniqueness for each business operation, a durable operation journal and atomic
state transitions. A disabled pay button and an in-memory lock do not survive concurrent requests
or process restarts.

The current OpenAPI explicitly documents merchant-supplied `payment_id` for payment-create
idempotency and `refund_id` for refund idempotency. Persist each identifier before sending, reuse
it only for the same operation and same payload, and retrieve the resulting resource after an
uncertain response. Do not invent an `Idempotency-Key` header or assume these fields protect
capture, cancel and every other endpoint.

**Schema contradiction to test:** `payment_id` and `refund_id` are constrained to exactly 30
characters. The refund description also recommends UUIDv4, whose usual hyphenated representation
has 36 characters. Follow the field constraints when constructing examples, flag the conflict,
and verify accepted values plus duplicate-request semantics in sandbox before shipping a generator.

For capture/cancel ambiguity, block a second local operation, retrieve current state and reconcile
amounts before deciding anything else. Confirm/refund recovery should likewise inspect the
correlated resource. Do not issue a fresh identifier to make a timeout disappear.

Peach documents status synchronisation at **two queries per minute per transaction**. Coordinate
polling across workers, use webhooks as the primary trigger, and schedule status polling about
30 seconds apart. A rate-limited sync may return current cached state; it is not proof the remote
operation has finished. Bound retries and retain a support/reconciliation path.

## 7. Captures, refunds and reconciliation

Keep authorised, captured, capturable, successfully refunded and pending-refund amounts separate.
Prevent concurrent refunds from exceeding available captured funds by reserving pending refund
amounts locally, then reconciling final outcomes. Check method-specific refund restrictions too.

A normal manual capture may be full or partial; overcapture is a separate capability requested
at creation and subject to actual enablement. The transaction guide says a partial capture
releases the remainder, but the capture schema marks `refund_uncaptured_amount` as not fully
supported or connector-dependent, and additional multi-capture states exist. Verify the selected
capture mode and connector's remaining-hold behaviour in sandbox. Do not apply single-capture
assumptions to `manual_multiple` or promise retained funds without evidence.

Void releases an uncaptured authorisation. Refund returns captured funds. The separate
`cancel_post_capture` endpoint is not a universal replacement for refund. Validate operation
eligibility, amount and current state immediately before any write; observe the skill's money-action
gate. Record each refund ID and final status, not just the original payment status.

Reconcile orders against payment attempts/captures/refunds, then against the merchant's settlement
and fee reports. `succeeded` proves a payment outcome, not that a bank settlement has arrived.
See [reconciliation](../reconciliation.md) and [transaction API](../orchestration-api.md).

## 8. Webhook security and reliable fulfilment

Use the Orchestration scheme: HMAC-SHA512 of the original request bytes with the profile's
`payment_response_hash_key`, compared to `x-webhook-signature-512`. Validate signature format and
length before a constant-time comparison; fail closed when the secret/header is missing or the
signature is invalid. Do not parse and reserialize before verifying. Checkout HMAC and Payments
API AES-GCM helpers are different contracts.

After authentication, durably accept an event before acknowledging it, then process asynchronously.
The flow guide requests a 2xx response within five seconds. Make receipt deduplication and job
creation atomic; marking an event processed before a job is durable can lose a payment on crash.
Deduplicate by event identity and make the actual order transition idempotent as well. Signatures
authenticate origin; they do not alone prevent valid-event replay or guarantee ordering.

Current flow docs publish retries up to 24 hours with 1m, 5m, 10m, 1h, 6h and 24h intervals. Treat
that as documented delivery behaviour, not a reason to expire deduplication records at exactly 24
hours or assume no later manual replay. Reconcile stale/out-of-order events against current state.
Never roll an order backwards merely because an older event arrived last.

Delivery-log/replay endpoints require Dashboard authentication rather than an ordinary merchant
API key. Use the Dashboard for investigation instead of repeatedly retrying an unsupported auth
mode. Keep operational logs to event/resource IDs, statuses and redacted errors.

## 9. Acceptance matrix

These are required implementation checks, not results obtained while writing this guide.

| Scenario | Evidence required |
|---|---|
| Happy path for every enabled method | Real UI/redirect or SDK flow plus matching backend state, amount/currency and one fulfilment |
| 3DS challenge, failure and abandoned return | Correct pending/failure state, preserved payment correlation, no client-only fulfilment |
| Same order submitted concurrently or after restart | One local operation and no duplicate economic effect; provider idempotency behaviour recorded |
| Timeout after payment/refund acceptance | Recovery by the same identifiers; no blind replacement charge/refund |
| Forged, missing-signature, duplicate and reordered events | Invalid events rejected, valid replay harmless, final state never regresses |
| Crash between webhook acceptance and fulfilment | Durable event/job survives; order fulfils exactly once |
| Customer tries another customer's saved method | Server ownership check rejects it before a provider write |
| Saved-card CIT and off-session MIT | Correct customer context, consent, mandate limits and independent invoice IDs |
| Soft-decline fallback and hard decline | Observed attempts match configured policy; application does not multiply retries |
| Partial capture, hold release and partial refunds | Actual connector state and amounts match the intended ledger; pending refunds prevent overspend |
| SDK cancellation, expired session and unavailable wallet | Recoverable user experience, suitable fallback, no false success |
| Credentials, logs and environment | No server secret in the client; no raw credential logs; sandbox/live separation validated |

Only claim sandbox/browser/device verification after executing the relevant checks. Public docs,
schema validation and mocks establish different evidence levels.

## Traps

- Using Checkout V2 OAuth/`checkoutId` or classic recurring fields in an Orchestration build.
- Treating one processor attempt as the complete payment, or starting a new payment on every retry.
- Calling every saved-card payment MIT, or assuming a mandate includes a billing scheduler.
- Promising routing, token portability or advanced capture semantics solely from schema presence.
- Using a client callback, unsigned event, stale webhook or HTTP 200 as fulfilment authority.
- Logging session secrets/cryptograms or claiming network tokenisation eliminates PCI scope.
- Copying playground demo endpoints into a merchant backend instead of `POST /payments`.

## Sources reviewed

The following official pages were read through the fresh
[full documentation export](https://playground.peachpayments.com/llms-full.txt), with selected
fields checked in the [OpenAPI schema](https://playground.peachpayments.com/openapi.json),
on 2026-10-07:

- [API-only integration](https://playground.peachpayments.com/integrate/api-only)
- [SDK integration](https://playground.peachpayments.com/integrate/sdk)
- [Hosted checkout](https://playground.peachpayments.com/integrate/hosted-checkout)
- [On-session saved cards](https://playground.peachpayments.com/flows/save-card-on-session)
- [Recurring via payment method](https://playground.peachpayments.com/flows/recurring-pm)
- [Recurring mandates](https://playground.peachpayments.com/flows/recurring-payments)
- [Gateway-agnostic recurring](https://playground.peachpayments.com/gateway-agnostic)
- [3DS and retry behaviour](https://playground.peachpayments.com/concepts/three-ds-next-action)
- [Profile configuration](https://playground.peachpayments.com/operate/profile)
- [Payment explorer](https://playground.peachpayments.com/operate/transactions)
- [Manage transactions](https://playground.peachpayments.com/docs/manage-transactions)
- [Webhook flow](https://playground.peachpayments.com/flows/webhooks)
- [Webhook operations](https://playground.peachpayments.com/operate/webhooks)

The 3DS page links to `/concepts/entity-payment-attempt`; its `.md` URL returned 404 during this
review. The payment/attempt model above was verified against the payment explorer and response
schema instead. Do not cite the unavailable page as independently reviewed.
