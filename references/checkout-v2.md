# Checkout V2 — the core integration

## When to load

Building payments into a custom web app with Peach Checkout (Embedded widget, Hosted redirect, or
Express wallet buttons), debugging checkout creation, or reviewing any Checkout V2 code. This is
the core file — read it before writing Checkout code of any kind.

## Hosts (per mode)

| Purpose | Sandbox | Live |
|---|---|---|
| OAuth token | `https://sandbox-dashboard.peachpayments.com` | `https://dashboard.peachpayments.com` |
| Checkout API | `https://testsecure.peachpayments.com` | `https://secure.peachpayments.com` |
| Refund API (V1) | `https://testapi.peachpayments.com` | `https://api.peachpayments.com` |
| Embedded JS SDK | `https://sandbox-checkout.peachpayments.com/js/checkout.js` | `https://checkout.peachpayments.com/js/checkout.js` |

Four different hosts per mode — mixing them (e.g. live entity on sandbox API) is a classic
integration failure. `[PLUGIN-VERIFIED]`

## Auth — OAuth bearer

```text
POST {auth-host}/api/oauth/token
Content-Type: application/json

{"clientId": "…", "clientSecret": "…", "merchantId": "…"}
→ 200 {"access_token": "…", "expires_in": 14400, "token_type": "Bearer"}
```

- Cache the token and reuse until expiry (refresh ~60s early) — the returned `expires_in` governs;
  sandbox tokens observed at **14400s (4 h)** `[SANDBOX-VERIFIED 2026-09-08]`, so never hardcode 3600.
  On a 401 mid-flight: clear the token, re-auth once, retry once — never loop. `[PLUGIN-VERIFIED]`
- Credentials come from Dashboard → **Checkout → API keys**: client ID, client secret, merchant
  ID, entity ID, secret token. Auth/token/checkout calls are **server-side only** — doing them in
  the browser exposes credentials and fails CORS. That CORS error is a design smell, not a config
  bug.

## Create a checkout — `POST {checkout-host}/v2/checkout`

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, **and both allowlist
headers**: `Origin: https://www.example.com` (NO trailing slash) and
`Referer: https://www.example.com/` (WITH trailing slash). The Dashboard allowlist validates these
on checkout creation — sending only one can fail validation. `[PLUGIN-VERIFIED]` Peach validates
the **domain, not a source IP**.

### Required body fields

| Field | Rules |
|---|---|
| `authentication.entityId` | ≤32 chars; the channel/entity ID from the Dashboard; doubles as the SDK `key` (semi-public) |
| `merchantTransactionId` | **8–16 chars**, unique; FNB acquirer: letters+digits only. Generate it **before** the POST and use it as YOUR idempotency key — Peach documents no server-side dedupe on it, so on a timeout/network failure don't blind-retry the create; look the payment up first (`GET /status`, or query by this id) and only re-create if nothing exists `[DOCS]` (no documented idempotency header) + `[PLUGIN-VERIFIED]` (check-before-retry) |
| `amount` | Decimal string, 2dp: `"1500.00"`. Major units — never cents. The 2dp group is optional — whole amounts like `"1500"` also validate `[SANDBOX-VERIFIED 2026-09-08]`, but always send 2dp so signed bodies and displays stay canonical. `0` only for `PA` + `createRegistration` (tokenisation without charge) — the carve-out and both sides of it verified `[SANDBOX-VERIFIED 2026-09-08]`. M-PESA: integers only — Checkout auto-rounds up |
| `currency` | `ZAR`, `KES`, `MUR`, `USD`, `GBP`, `EUR` (uppercase) |
| `nonce` | Unique per request (UUID) — anti-replay |
| `shopperResultUrl` | 6–2048, fully-qualified lowercase URL (an uppercase host is rejected as `Invalid request body` `[SANDBOX-VERIFIED 2026-09-08]`). Customer is returned here via **POST** with a webhook-shaped body (Embedded can override with `onCompleted`) |

### High-value optional fields

| Field | Notes |
|---|---|
| `paymentType` | `DB` (default, capture now) or `PA` (pre-auth). **`PA` only works with `forceDefaultMethod:true` + `defaultPaymentMethod:"CARD"`** — otherwise rejected with exactly: `Payment type PA is not supported for any payment method other than card.` `[SANDBOX-VERIFIED 2026-09-08]`. Uncaptured `PA` never settles; capture/void goes through the card facade (`recurring-and-tokenisation.md`) |
| `defaultPaymentMethod` + `forceDefaultMethod` | Pin one method. Enum: `CARD, MASTERPASS, MOBICRED, MPESA, 1FORYOU, APLUS, PAYPAL, ZEROPAY, PAYFLEX, BLINKBYEMTEL, CAPITECPAY, PAYBYBANK, MCBJUICE, RCS, FLOAT, HAPPYPAY, APPLE PAY (with a space), GOOGLEPAY, SAMSUNGPAY, MAUCAS, MONEYBADGER, PAYSHAP, ABSAEFT`. Acceptance is **availability-checked per entity**: `APPLE PAY` (space) validates while `APPLEPAY` does not `[SANDBOX-VERIFIED 2026-09-08]`; `PAYSHAP` was rejected at creation with `Default payment method invalid for this request: PAYSHAP` on an entity without PayShap — treat PayShap as Payments-API-only unless your entity lists it `[SANDBOX-VERIFIED 2026-09-08]` |
| `notificationUrl` | Per-checkout webhook destination **in addition to** the Dashboard-configured webhook |
| `cancelUrl` | Documented but **ignored by default** — support must enable. Prefer handling cancel via the result URL / `onCancelled` |
| `customParameters` | Map of strings (≤2048 each). Echoed back in webhooks/status under bracket keys (`customParameters[mySessionId]`). Use for session correlation; for Dashboard display use a single `auxData` key containing JSON |
| `customer` | `givenName`/`surname` (≤48; required if any customer field sent), `email` (6–128), `mobile`, `merchantCustomerId` (≤48), `idNumber` (exactly 13 — high-risk Capitec Pay) |
| `billing` / `shipping` | `street1, street2, city, company, state, postcode, country` (ISO-3166-1 alpha-2). If you don't know the country, **omit it** — never guess |
| `createRegistration` | `true` to tokenise the card (see `recurring-and-tokenisation.md`) |
| `allowStoringDetails` | Shopper opt-in to save card; mutually exclusive with `createRegistration`; `registrationId` may then be absent — handle that |
| `cardTokens` | Stored registration tokens for one-click (linked to the customer) |
| `standingInstruction` | Card-on-file constraints for recurring — `recurring-and-tokenisation.md` |
| `cardRemovalUrl` | Hosted Checkout POSTs `checkoutId, registrationId, signature` here when a shopper removes a card (Embedded: use `onRemoveCard`) |

`POST /v2/checkout/validate` accepts the same body and returns `{"message":"Valid request"}` —
cheap way to debug body errors without creating sessions.

**Response 200**: `{"checkoutId": "…", "redirectUrl": "…"}` — `checkoutId` is the session handle
(single-use, **30-minute TTL**); `redirectUrl` is the Hosted Checkout page.

Errors: 400 validation (`message`), 401 auth, 404 = invalid entity ID, 500.

## Domain allowlisting

Dashboard → Checkout → Allowlisted domains. Every domain your backend or frontend initiates
payment calls from must be listed (domain, subdomain, or IP). Non-matching submissions sit
"pending" until Peach verifies; failed risk checks are declined for 14 days. **Local/localhost
domains cannot be allowlisted** — test on a public staging domain (builder preview domains like
`preview--x.lovable.app` are fine). Sandbox allowlisting needs no verification.

## Embedded Checkout (widget on your page)

```html runnable
<script src="https://sandbox-checkout.peachpayments.com/js/checkout.js"></script>
<div id="checkout-root" style="height: 640px"></div>
<script>
  const checkout = Checkout.initiate({
    key: entityId,                // same entity used to create the checkout
    checkoutId,
    eventHandlers: {
      onCompleted: (e) => window.location = '/checkout/result?cid=' + e.checkoutId,
      onCancelled: () => showRetry(),
      onExpired: () => recreateCheckout(),   // 30-min TTL; checkoutId is not reusable
      onError: (e) => log(e.result.code),
    },
  });
  checkout.render('#checkout-root');   // returns void — do NOT await
</script>
```

- Load `checkout.js` fully before `initiate` — otherwise "Checkout not found".
- `eventHandlers` (NOT the deprecated `events`): `onCompleted`, `onCancelled`, `onExpired`,
  `onError`, `onBeforePayment`, `onRemoveCard`. Providing a handler **suppresses the default
  redirect** — you own the flow from then on.
- Event payloads carry `amount, checkoutId, currency, merchantTransactionId, paymentType,
  result{code,description}, signature, timestamp`; `onCompleted` adds `id` (transaction id),
  `paymentBrand`, `resultDetails`. **Do not fulfil on the event alone** — verify server-side via
  `GET /status` (events come from the browser).
- `onBeforePayment`: return `true`/`Promise<true>` to allow the payment; anything else (including
  no return) blocks it and you must handle the UX (redirect/unmount).
- `onRemoveCard(token)`: return `true` to confirm removal; never pass a removed token in
  `cardTokens` again.
- Container must have an explicit height (**min 640px**, or `100%`/`100vh`). Must exist in the DOM
  before `initiate`. `file://` pages render but cannot pay — host the page.
- `unmount()` tears down; **the same `checkoutId` cannot be reused after unmount** — create a new
  checkout. `[PLUGIN-VERIFIED]`
- Ordering / method filtering: `options.ordering` (`{PAYFLEX: 1, CARD: 2}` — lower first),
  `options.paymentMethods.include` / `.exclude`.
- **Checkout V2 has no fully-stylable tokenised card-fields product** (no Elements equivalent): here the choice is the customisations below (limited fields cross the cross-origin iframe) or raw-card S2S (PCI SAQ A-EP/D — `pci-security.md`). **This ceiling is Checkout V2's** — the **Orchestration Web SDK** (`sdk-web.md`) IS an Elements-style product (Payment Element with `variables` + CSS-like `rules`), so point pixel-perfect-card-field requests there. Don't tell a user "Peach has no Elements option" without first checking whether Orchestration fits.
- Customisations: `showCancelButton`, `showAmountField`, `theme.fontFamily` (CVV/card fields
  support few fonts), `theme.brand.primary` (hex; `secondary` is unused), `theme.cards.background`,
  `card.submitButtonText` (default "Pay Now"), `card.showCardIcon`, `card.headingText`,
  `card.brands` (default `VISA, MASTERCARD, AMEX, DINERS`), `card.showBillingFields`,
  `card.registrations.requireCvv` (CVV on one-click, default false).
- **No iframing** Embedded/Hosted Checkout — payment methods break.
- CSP: if your site has one, add directives from
  `https://secure.peachpayments.com/.well-known/csp-config.json` (3DS runs in an `oppwa.com`
  iframe — allow it in `frame-src`).

### Embedded Express (wallet buttons)

`Checkout.express({key, checkoutId, requiresShipping?, eventHandlers?})` — renders only Apple/Google/
Samsung Pay buttons. **No customisations** beyond handlers; no tokenisation; device/browser
dependent. `requiresShipping: true` makes Apple Pay collect address/name/email/phone, returned as
`shipping.*` / `customer.*` in the webhook. Wallet availability needs acquirer support
(Apple Pay: FNB/Nedbank/Standard Bank merchant account; Google Pay: Absa/FNB/Nedbank/Standard Bank
+ Google signup; Samsung Pay: Nedbank/Standard Bank) and Apple Pay domain onboarding: serve Peach's
`apple-developer-merchantid-domain-association` (from `secure.peachpayments.com/.well-known/…`,
remove any `.txt`, raw 200, no redirect/proxy/auth) at your domain's `/.well-known/`, then ask
support to activate. Changing the allowlist can force re-onboarding.

## Hosted Checkout (redirect)

Redirect the customer to `redirectUrl`; it supports **more methods than Embedded** (per-method
detail in `methods-catalog.md`). On completion Peach POSTs the customer to `shopperResultUrl`
with a **webhook-shaped form body** — treat it exactly like a webhook and do NOT fulfil on it directly:
verify its signature, and ALWAYS re-confirm via `GET /status` (terminal code + amount) before fulfilling.
The `shopperResultUrl` landing is a UX redirect an attacker can also hit — never proof of payment. Hosted
links are single-load
(messengers unfurling the link consumes it).

## Status — `GET {checkout-host}/v2/checkout/{checkoutId}/status`

Bearer auth. URL-encode the checkoutId. **The response is a FLAT object with dotted string keys —
not nested objects**: `json["result.code"]`, `json["card.last4Digits"]`,
`json["customParameters[medusaSessionId]"]`. `[PLUGIN-VERIFIED]`

Key fields: `result.code`, `result.description`, `id` (**the 32-hex transaction id — this, not
checkoutId, is what refunds need** `[PLUGIN-VERIFIED]`), `amount` (string), `currency`,
`paymentBrand`, `paymentType`, `card.{bin,last4Digits,expiryMonth,expiryYear,holder}`,
`registrationId` (when tokenising), `resultDetails.MerchantAdviceCode` (`01` new account info
available / `02` cannot approve now / `03` **do not retry** (strict Dashboard reading — see result-codes.md) / `04` do not retry), `signature`,
`timestamp`. 404 returns `{"result.code":"200.300.404"}`.

Parse tolerantly — other Peach surfaces nest under `result`/`payment`/`payments[0]`; read all
shapes so a success code is never missed:
```js runnable
const code = j["result.code"] ?? j.result?.code ?? j.payments?.[0]?.["result.code"] ?? j.resultCode;
```
`[PLUGIN-VERIFIED]` Reading only `j.result.code` returns `undefined` on the flat shape → every
payment looks "pending". There is **no explicit status field** — status is derived from
`result.code` (`result-codes.md`).

**Polling**: no documented rate limit on this endpoint; define your own timeout (~30 min session
life) and let webhooks finalize state. The Payments API status endpoints are limited to 2/min per
transaction — different product.

## Which methods are enabled?

`GET {checkout-host}/v2/channels/{entityId}/payment-methods?currency=ZAR` →
`{"paymentMethods":[{"name":"…"},…]}`. Names come back as **display strings, not brand codes** —
observed: `Visa`, `Mastercard`, `American Express`, `Apple Pay`, `GooglePay`, `SamsungPay`,
`CapitecPay`, `Float`, `HappyPay`, `Payflex`, `Mobicred`, `RCS`, `Masterpass` (no `CARD` entry —
cards enumerate per brand; `defaultPaymentMethod: CARD` still validates) `[SANDBOX-VERIFIED
2026-09-08]`. Compare loosely; availability is entity-scoped — an unsupported currency returns
`No valid payment methods available for this request.` (observed with KES on a ZAR-only entity)
`[SANDBOX-VERIFIED 2026-09-08]`. Cache and refresh ~weekly; enablement is a Dashboard concern.

## Minimum viable flow (custom app)

1. Server: OAuth → `POST /v2/checkout` (with `customParameters.sessionId` for correlation) →
   return browser-safe `{checkoutId, entityId, sdkUrl}` only (no secrets) to the frontend.
2. Frontend: load SDK → `Checkout.initiate({key, checkoutId, eventHandlers}).render('#root')`;
   `onCompleted` → navigate to your result page.
3. Result page/route (server): `GET /status` → map `result.code` (`result-codes.md`) → verify
   amount == created amount → fulfil → clear cart.
4. Webhook (backup path, same mapping): `webhooks.md`.
5. Refunds: see § Refunds below (capture/void of PAs: `recurring-and-tokenisation.md`).

## Refunds (Checkout payments)

Endpoint: `POST https://api.peachpayments.com/v1/checkout/refund` (sandbox `https://testapi.peachpayments.com/v1/checkout/refund`).
Body: form-urlencoded (safest) with **flat dotted keys** — JSON is accepted ONLY as flat key-values; nested objects fail — `authentication.entityId`,
`amount` (2dp string), `currency`, `id` = the original payment's **32-hex transaction id** (from
`/status` or the success webhook — NOT the checkoutId), `paymentType=RF`, `signature` (HMAC-SHA256
over the sorted key+value concatenation with the secret token — same construction as classic
webhooks, `webhooks.md`). Nested JSON bodies fail with `200.300.404`. `[PLUGIN-VERIFIED]`
**A declined refund can arrive as HTTP 200 + declined `result.code` (observed in production `[PLUGIN-VERIFIED]`) — the general HTTP table also documents 400 for failed payments — so parse `result.code` from the body on EITHER status** (`100.550.701` amount
mismatch, `700.300.100` not refundable). Refundability is per method (`methods-catalog.md`);
refunds older than 6 months go through support. Full card-ops mechanics (capture/void PAs):
`recurring-and-tokenisation.md`.

## Traps

- Nested-JSON/amount bugs are caught by `/v2/checkout/validate` — use it while developing.
- `shopperResultUrl` must match `^(https?://)[a-z0-9...]+$` style (fully-qualified, lowercase) —
  "Invalid request body" usually means it doesn't.
- Never re-render with an expired/unmounted `checkoutId` ("Checkout not found" / silent failure).
- Browser refresh mid-Hosted → "Could not find Checkout details": start a new checkout.
- Unused checkouts — behavior DIFFERS by surface: never-opened **Embedded** checkouts send NO webhook (status returns bare checkout info with no result code); unused **Hosted** checkouts DO signal: `/status` returns `700.400.580` for the first 30 minutes, then webhooks fire (`000.200.100` at ~30 min, `100.396.104` at ~60 min) `[DOCS checkout-faq]`. Don't build 'silence means abandoned' logic on the Hosted path.
  `result.code` until timeout — don't treat as failure prematurely.
- CORS errors on auth/checkout calls = you're calling from the browser. Stop; move server-side.
- The React tutorial in Peach's docs is React **Native**, not web. No npm package exists — the SDK
  is a script-tag global.
