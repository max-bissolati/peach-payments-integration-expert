# Point of sale integrations

Verified against live official documentation on **2026-10-07**. `[DOCS]` means documentation
review, not a successful terminal or sandbox transaction. This reference covers REST terminal
payments and shared backend concerns. For a custom Expo app on the terminal, also read
`pos-expo-sunmi.md`.

## When to load

Load for terminal REST sales, status polling, refunds, POS webhook authentication, identifiers, or recovery. For same-device Android implementation also read `pos-expo-sunmi.md`.

## Choose the connection first

| Where the till runs | Integration | Responsibility |
|---|---|---|
| Separate tablet, phone, browser, or computer | **POS Integrations API**, HTTPS through your backend | Your backend dispatches to a terminal serial number; Payment App takes the card payment |
| Same Android terminal as Peach Payment App | **Intent API**, `com.peach:intent_api` | Your native Android integration hands off to Payment App and handles its callback |

Peach documents its Sunmi Payment App for in-store card payments in **South Africa**. Do not
extend online country/currency availability to terminals. Confirm the exact merchant, device,
territory, currency, account and Payment App build with Peach. An Expo app on a separate device
does not need a terminal SDK; an app on the Sunmi needs a native Android bridge and device
compatibility validation. Card reading and PIN entry belong to Payment App.

Both POS paths use integer **minor units**: `3000` is R30.00. This differs from Checkout's
decimal strings. POS does not use Checkout `result.code`, Checkout HMAC canonicalization, or
`GET /v2/checkout/{id}/status`.

## REST setup and authentication

Ask [Peach support](https://support.peachpayments.com/support/tickets/new?ticket_form=log_a_support_ticket)
for a sandbox account, UAT terminal serial, merchant-scoped POS Integrations API key, webhook
configuration and POS Integrations API enablement on the terminal. Before dispatch, Payment App
must be open, connected and showing `Remote payments online`.

| Environment | POS API base URL |
|---|---|
| Sandbox | `https://pos-sandbox.peachpayments.com` |
| Production | `https://pos.peachpayments.com` |

Send `Authorization: Bearer <POS_API_KEY>` on each request, with `Content-Type: application/json`
on JSON writes. This is not the ecommerce OAuth client secret. The docs use `pk_live_xxx` in
a sandbox example: that is a placeholder, not proof that a real live key belongs in sandbox.
Use the environment-specific credentials Peach supplies.

**Implementation recommendation:** keep the merchant key in a backend secret store. Never embed
it in an Expo bundle, browser code, `EXPO_PUBLIC_*`, kiosk image or client log. Authenticate the
cashier/device to your own backend. Derive prices and merchant/terminal ownership there, rather
than trusting a client-provided amount or terminal serial. Do not assume the key is publishable
because its example starts with `pk_`.

## REST sale and status contract

| Operation | Endpoint |
|---|---|
| Request card payment | `POST /integrations/v1/terminals/{terminalId}/payment-requests` |
| Read its outcome | `GET /integrations/v1/payment-requests/{requestId}` |
| Refund a sale | `POST /integrations/v1/transactions/{transactionId}/refund` |

`terminalId` is the terminal's manufacturer serial, not your internal terminal row ID. The
sale body requires integer `amount` and `merchantTransactionId`. Optional `paymentMethod`
is a routing hint, with `CARD` the documented example; optional `posData` holds custom metadata.
The request schema does not document a currency override. Confirm the configured currency.

Illustrative request body, not a command to initiate a payment:

```json
{
  "amount": 3000,
  "merchantTransactionId": "ORDER-1042",
  "paymentMethod": "CARD",
  "posData": { "cashierReference": "REGISTER-2" }
}
```

| Dispatch HTTP status | Meaning | Application handling |
|---|---|---|
| `202` | Accepted and pushed to terminal | Persist returned `requestId`; show payment in progress |
| `409` | Terminal busy | Keep one active attempt per terminal; wait for it to become free |
| `422` | Invalid request or terminal not enabled | Correct the cause; unchanged retries will not help |
| `503` | Terminal unreachable | Check connectivity and remote-payment indicator before a cashier retries |
| `504` | Terminal did not acknowledge in time | Treat outcome as uncertain; recover before issuing another sale |

The docs suggest retrying `504` when the terminal is online. They do not publish an idempotency
guarantee. The safer integration policy is to recover any available `requestId`, webhook and
transaction evidence first; a transport timeout alone does not prove no payment took place.
An HTTP `202` is never authorization to fulfil an order.

Polling returns `requestId`, `merchantTransactionId`, `transactionResult`, `failureReason`,
`amount`, `currency`, `transactionId`, `rrn` and `updatedAt` in the documented example. Poll
every couple of seconds while pending. An early `404` means the record may not yet exist;
keep it in progress. Add backoff and an application timeout that changes the UI to
"Checking payment", not "Safe to charge again". Rate limits, retention, and a maximum polling
duration are not published on the POS API page.

Only `approved_confirmed` is successful. `approved` is still in progress. Before completing an
order, compare the expected order reference, amount and currency, confirm the request belongs
to this merchant's sale attempt, and apply completion exactly once. The poll response has no
documented `transactionType` field, so the stored **sale request** provides operation context.
Do not classify it with ecommerce result-code regexes.

## Identifiers: store each separately

| Identifier | Meaning and use |
|---|---|
| Your order ID | Your business order, booking or folio |
| `merchantTransactionId` | Merchant reconciliation reference; persist before requesting payment |
| `requestId` | One REST dispatch, echoed as webhook `transaction.posData.requestId` |
| POS `transactionId` | Peach transaction identifier; needed for refunds; can differ between attempts under one request |
| `rrn` | Card-scheme retrieval reference, useful in support/recovery |
| `webhookId` | Delivery identifier; unsuitable for deduplication because retries change it |
| Reconciliation `transactionId` | POS docs say this holds your `merchantTransactionId`; do not confuse it with the POS refund identifier |

The polling transaction identifier has no dashes; webhook identifiers use UUID formatting.
Retain the original value and normalize only for an operation that requires it. REST refund
paths require the no-dash form. Intent flows use the original transaction UUID.

One REST `requestId` can produce several transaction events, such as a failed PIN attempt
followed by a success. Never discard every later event merely because a request already had
one webhook. Track individual transactions under the request and derive the order outcome
from confirmed sale evidence. A first declined attempt must not hide a later approved one.

## Plain JSON POS webhooks

Peach configures these at merchant level for all allocated terminals. Supply an HTTPS endpoint
(the docs allow ports 80 and 443) and ask support to configure a secret custom authentication
header. These webhooks are **plain JSON**, with no decryption step. The public POS pages do
not specify the ecommerce HMAC signature scheme for this surface.

**Implementation recommendation:** require and securely compare the configured secret header,
reject missing/incorrect values, and retain authenticated events durably before acknowledging
them. Select a dedicated POS route and parser. Never pass JSON through Checkout's canonical
string verifier. A custom header authenticates delivery through the agreed configuration;
it does not make `webhookTime` a cryptographically signed replay token. Use persistent
deduplication and ordering, plus REST status confirmation where available.

Peach attempts delivery five times, at 30-second intervals. Exhausted events enter a
dead-letter queue and Peach can resend them manually. Confirm operational alerting and
redelivery arrangements before production.

The event includes a `transaction` object. Read its operation and result together:

| `transaction.transactionType.value` | Operation |
|---|---|
| `0` | Sale |
| `20` | Refund |

| `transaction.transactionResult` | Meaning |
|---|---|
| `approved` | Not final; wait |
| `approved_confirmed` | Successful for the stated operation |
| `declined`, `failed` | This transaction did not succeed |
| `voided`, `reversed` | Cancellation/reversal; update payment and order records |
| Unknown value | Preserve and investigate; never infer success |

For sale completion require type `0` and `approved_confirmed`, the expected order reference,
amount and currency, and expected terminal/merchant context. A successful refund must never
mark an unpaid order paid. Match the terminal using `terminal.manufacturerSerialNumber` and
the order via `transaction.posData.merchantTransactionId`; REST events also carry
`transaction.posData.requestId`.

The docs explicitly say `webhookId` changes on redelivery and the latest `webhookTime` wins
**for a transaction**. Recommended processing:

1. Authenticate, validate the payload and locate the stored merchant/request/order context.
2. Store the event with normalized POS transaction ID, operation, event time and payload hash.
3. Under a database transaction, apply only a newer event for that transaction; retain older
   deliveries for audit. Investigate conflicting states with the same timestamp.
4. Update order/payment state and enqueue fulfilment once with a unique operation key.
5. Handle later authenticated reversals as financial state changes, with compensating business
   actions. Do not erase completed transaction history.

The public webhook page is a field guide rather than a complete JSON schema. Confirm the
real UAT envelope, optional fields and refund-to-original-sale linkage before generating a
strict production validator. There is no documented request-signing algorithm to invent.

Polling, callbacks and webhooks must feed one serialized payment-state reducer, not independent
order-completion paths. Never let an older approved poll resurrect a transaction already confirmed
reversed. The docs do not guarantee that timestamps across poll responses and webhook events are
comparable. Preserve both pieces of evidence, keep conflicting outcomes unresolved and re-query or
escalate reconciliation. Fulfilment and compensating actions need separate durable once-only keys.

## Idempotency, interruption and recovery

The Intent API explicitly allows a second sale with the same `merchantTransactionId`. REST
does **not** document an idempotency header or a uniqueness guarantee for this field. Treat it
as a reconciliation reference, not provider-side duplicate prevention.

Recommended backend model: an order has one or more payment attempts; an attempt contains
its environment, merchant, terminal, expected amount/currency, dispatch status, request ID
and transaction records. Use a unique client-operation key and a database lock/constraint
to prevent repeated button taps or concurrent requests from dispatching twice. Persist the
attempt before external I/O. A crash between dispatch and saving its response leaves an
uncertain attempt that requires recovery, not automatic re-dispatch.

Use webhook plus REST polling for a separate-device app. For Intent callbacks lost to an app
crash, use local lookup, backend webhooks and merchant-day reconciliation. Never treat a
customer's bank notification or an order with a similar amount as proof of this order's success.

Peach documents reversal within five minutes if the Payment App cannot display its successful
outcome screen. The customer can still see a bank approval during that interval. Treat that
timing as recovery guidance, not proof that every unknown attempt was reversed after a local
timer. Confirm the actual transaction before making a new charge or final accounting change.

## REST refunds

Refund a completed sale with its POS transaction ID, without dashes. Body fields are optional:
integer `amount` in cents, `note` and `reason`. **Omitting `amount` refunds the entire remaining
balance.** When a cashier selects a partial refund, validate and send an explicit amount; a
missing value must not silently turn it into a full refund.

Multiple partial refunds are supported up to the original sale total. Track refunded and
pending amounts in the backend and serialize competing refund attempts.

| HTTP status | Contract |
|---|---|
| `200` | Documented success has `transactionResult: approved_confirmed`, type value `20`, amount and currency |
| `402` | `refund_declined`; provider declined and docs say no money moved |
| `400` | `refund_amount_not_available` or `transaction_not_refundable` |
| `404` | `transaction_not_found`, including a transaction belonging to another merchant |

Check both HTTP and the operation/result body. Store the refund attempt and response; handle
refund webhooks independently from sales. No REST refund-status endpoint, refund idempotency
key, or refund transaction ID in the documented success response is specified. After a lost
refund response, block a blind retry and reconcile with webhooks/support. Do not copy an
ecommerce `RF` request or its signing rules into this endpoint.

Intent refund/void requires the same terminal and supervisor approval. That does not establish
that the REST API has the identical PIN flow or refund age limit. Confirm REST commercial and
operational constraints with Peach rather than transferring Intent-only rules by analogy.

## Reconciliation and reporting

Use [Dashboard reporting](https://developer.peachpayments.com/docs/dashboard-reporting) and
the [Reconciliation API](https://developer.peachpayments.com/docs/bus-ops-recon-api) as fallback
and financial controls. Peach handles daily settlement; a custom till does not close Peach's
settlement batch. Use `references/reconciliation.md` for the broader accounting model.

Reconciliation uses its own OAuth credentials (`clientId`, `clientSecret`, `merchantId`) and
`POST /api/oauth/token` on the Dashboard auth host. Do not send the POS merchant key there.
Its read endpoint is `GET /api/merchants/{merchantId}/transactions-recon`.

| Service | Sandbox | Production |
|---|---|---|
| Auth | `https://sandbox-dashboard.peachpayments.com` | `https://dashboard.peachpayments.com` |
| Recon | `https://sandbox-reconciliation.ppay.io` | `https://reconciliation.peachpayments.com` |

Query merchant-day windows no longer than 24 hours, at most one request per second. Specify
timezone-aware timestamps explicitly and URL-encode `+` offsets. The guide says missing
timezone defaults to UTC, while the endpoint schema says UTC+2: avoid relying on either default.
Do not query before 2023-01-01. Settlement fields for aggregation accounts can lag three
business days, so missing settlement is not evidence of a failed payment. POS docs map the
merchant reference into recon `transactionId`, but the generic schema still declares a
32-character hex pattern. Validate real POS records in UAT before enforcing that pattern or
building a refund join from it. Confirm recon amount units separately from POS cents.

## Test matrix and launch readiness

Use sandbox and a Peach-enabled UAT terminal. The [REST testing guide](https://developer.peachpayments.com/docs/pos-test)
documents these amounts in rand; convert to integer cents in API calls:

| Test amount | Expected behavior |
|---|---|
| R50.05, send `5005` | Failed attempt followed by approved attempt |
| Amount ending in `.55` | Several failed transactions |
| Amount ending in `.65`, tap card | Failed then successful attempt |
| Amount ending in `.51` | Decline |
| Amount ending in `.69` | Timeout/failure |

Also test ordinary approval, terminal busy/offline, initial polling `404`, polling after
restart, missing/invalid webhook authentication, duplicate and out-of-order events, several
events sharing a request, mismatched amount/reference/terminal, refund treated separately
from sale, partial and full refunds, lost dispatch/refund response, double taps, concurrent
cashiers, and recovery from a missing webhook via reconciliation. Test unknown enum values
without accidentally approving them. Record the observed terminal UI, callback or webhook,
polling record and recon record for each case.

UAT/mocked responses are not production certification. Have Peach confirm readiness, terminal
enablement, merchant permissions and environment credentials before production. Same-device
apps also need Sunmi deployment and hardware testing described in `pos-expo-sunmi.md`.

## Documentation conflicts and capability boundaries

| Claim | Current evidence and action |
|---|---|
| "No polling endpoint" on webhook page | Stale relative to the POS Integrations page updated 2026-09-28, which documents polling. Use that endpoint and verify in UAT |
| REST refund availability | Confirmed: REST supports full and partial refunds |
| Refund transaction identifier in REST response | Current REST success example still omits it; do not depend on it or invent another identifier field |
| Same-day void availability by integration | No REST void endpoint is documented here. Intent **already has void**; do not collapse the two product surfaces |
| Push PayByLink/QR availability | Do not advertise REST terminal QR/PayByLink as available or invent `paymentMethod` values. Separate online Payment Links remains another product |
| Missing Intent callback described as failed | Docs also warn card authorization can complete. Do not fulfil without proof, and preserve an unresolved financial attempt for recovery before retry |

Before promising a production integration, confirm unpublished REST idempotency behavior,
rate limits/timeouts, webhook authentication and full schema, refund recovery/correlation,
supported terminal models/builds and supported currencies with Peach. These are explicit
unknowns, not missing code to fill in by guessing.

## Source map

Read the live pages for changing contracts; append `.md` for their machine-readable versions.
The live `llms.txt` fetched on 2026-10-07 omitted these POS guides, so index-only freshness
checks cannot establish that this surface is unchanged.

- [POS Integrations API](https://developer.peachpayments.com/docs/pos-integrations-api), updated 2026-09-28: REST auth, environments, sale, poll, refunds.
- [Terminal integration flows](https://developer.peachpayments.com/docs/terminal-integration-flows), updated 2026-09-17: Intent operations, recovery and merchant reference mapping.
- [Point of sale webhooks](https://developer.peachpayments.com/docs/pos-instore-webhooks), updated 2026-09-17: JSON, custom headers, ordering, retries and results.
- [Test your POS Integrations API integration](https://developer.peachpayments.com/docs/pos-test), updated 2026-09-17: magic amounts and UAT matrix.
- [App-to-app integration](https://developer.peachpayments.com/docs/pos-app-to-app): native and WebView patterns.
- [Intent API data models](https://developer.peachpayments.com/docs/pos-intent-data-models) and [Intent error codes](https://developer.peachpayments.com/docs/pos-intent-error-codes): version-specific native contracts.
- [Test your app-to-app integration](https://developer.peachpayments.com/docs/pos-test-app-to-app) and [Deploy your POS app](https://developer.peachpayments.com/docs/pos-deploy-sunmi): mock, UAT and production distribution.
- [Reconciliation API guide](https://developer.peachpayments.com/docs/bus-ops-recon-api), updated 2026-09-15, and [endpoint schema](https://developer.peachpayments.com/reference/get_api-merchants-merchantid-transactions-recon), updated 2026-06-30: accounting recovery, credentials and known schema discrepancies.

## Traps

- REST 202 confirms dispatch only. Initial polling 404 is still in flight.
- A request can have multiple transaction events; do not deduplicate the whole request after its first decline.
- A missing refund amount means the full remaining balance.
- POS IDs, result states, amount units and webhook authentication are distinct from online Checkout.
