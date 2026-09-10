# Orchestration Web SDK — Embedded and Hosted Checkout

## When to load

Load for the Peach **Orchestration Web SDK** (browser Embedded Checkout via `HyperLoader.js`) and for
Orchestration **Hosted Checkout** (Peach-hosted payment page via `payment_link`). This is a different
product from legacy Checkout V2 (`checkout-v2.md`) — different backend, auth, script, and object model.
For the server-side REST surface behind it (creating the PaymentIntent, capture/refund/mandates), read
`orchestration-api.md`. For native app SDKs, `mobile.md`.

## 0. Which product is this — and which is it NOT

Peach now has **two unrelated "Embedded/Hosted Checkout" products that share the name**. Confirm which
one the merchant is on before writing a line — the credentials tell you instantly.

| | **Orchestration Web SDK** (this file) | **Checkout V2** (`checkout-v2.md`) |
|---|---|---|
| Client script | `HyperLoader.js` (`Hyper()` + Elements) | `checkout.js` (`checkout` widget) |
| Core object | `PaymentIntent` + `client_secret` | `checkoutId` |
| Auth | publishable key `pk_snd_`/`pk_prd_` (client) + secret `snd_`/`prd_` (server, `api-key` header) | OAuth bearer token |
| API host | `app.sandbox-next.peachpayments.com` / `app.next.peachpayments.com` | `secure.peachpayments.com` / `testsecure.peachpayments.com` |
| Card-field styling | **Payment Element with `variables` + CSS-like `rules`** (an Elements-style product) | limited theming only, no Elements equivalent |

The card-field-styling row matters: `checkout-v2.md` correctly says Checkout V2 has *no* fully-stylable
tokenised card-fields product. That statement is about Checkout V2 only. The Orchestration Web SDK below
**is** that product. Point pixel-perfect-card-field requests here. (The Checkout-V2 comparison itself is
skill cross-reference, not a fact from the playground pages.)

## 1. The client library — load, init, confirm

- Load `HyperLoader.js` from Peach's versioned CDN (npm packages are **not published yet** — Peach will
  publish its own): `[DOCS playground.peachpayments.com/sdk-web]`

```html illustrative
<script src="https://sdk.sandbox-next.peachpayments.com/sandbox/web/0.133.0/v1/HyperLoader.js"></script>
```

- Init and confirm, in order (the `clientSecret` comes from your server's `POST /payments` with
  `confirm:false` — see `orchestration-api.md` §handshake): `[DOCS sdk-web]`

```javascript runnable
const hyper = Hyper('pk_snd_your_publishable_key', {
  customBackendUrl: 'https://app.sandbox-next.peachpayments.com/api',
});

const elements = hyper.elements({ clientSecret, appearance: { theme: 'default' } });
const paymentElement = elements.create('payment', { layout: 'tabs' });
paymentElement.mount('#payment-element');

const { error, paymentIntent } = await hyper.confirmPayment({
  elements,
  confirmParams: { return_url: window.location.origin + '/payment-complete' },
  redirect: 'if_required',
});
```

- `hyper.confirmSetup({ elements, confirmParams })` saves a card without charging (a Setup Intent flow;
  "Setup Intent" is descriptive here, there is no separate SetupIntent API object). `[DOCS sdk-web]`
- `hyper.paymentRequest({ country, currency, total })` + `canMakePayment()` — wallet availability check.
  `[DOCS sdk-web]`
- **Publishable key prefix is `pk_snd_` (sandbox) / `pk_prd_` (production).** The doc's code samples use a
  placeholder `pk_test_your_publishable_key`, which is **not** a real prefix — do not copy it; use the
  `pk_snd_`/`pk_prd_` key from the Dashboard. `[DOCS sdk-web]`
- Base URLs: sandbox `https://app.sandbox-next.peachpayments.com/api`, production
  `https://app.next.peachpayments.com/api`. `[DOCS sdk-web]`

## 2. Server ↔ client handshake, and enable-vs-order (the footgun)

- Your **server** creates the intent with `confirm:false` and returns `client_secret`; the **client**
  confirms with the publishable key. The secret key never leaves your server. (Contrast: an S2S flow
  confirms server-side in one call with `confirm:true` — `orchestration-api.md`.) `[DOCS sdk-web, integrate/sdk]`
- **`allowed_payment_method_types` is a server-side field on the PaymentIntent — it FILTERS, it does not
  ENABLE.** A type listed there still has to be enabled on the merchant account and support the payment's
  currency. `[DOCS integrate/sdk]`

```json illustrative
"allowed_payment_method_types": ["pay_shap", "payflex", "credit", "debit"]
```

- The client-side controls are **presentation only** and are different parameters: the SDK's
  `paymentMethodOrder` reorders what is shown; `paymentMethodsConfig` (with `displayMode:"hidden"`) can
  hide entries. Neither enables a method. `[DOCS integrate/sdk]`
- **Omit `allowed_payment_method_types`** (the default) and the checkout offers everything the account has
  enabled for that currency — which is what makes enabling a new method a Dashboard change, not a code
  change. Prefer this unless you have a specific reason to restrict. `[DOCS integrate/sdk]`

## 3. Payment Element options and appearance

- `elements.create('payment', {...})` options: `layout` (`'tabs'` | `'accordion'`), `paymentMethodOrder`
  (array, e.g. `'card'`, `'apple_pay'`, `'pay_shap'`, `'payflex'`), `wallets` (`'auto'` | `'never'` |
  `'always'`). `[DOCS sdk-web]`
- Appearance object, passed to `hyper.elements({ clientSecret, appearance })`: `[DOCS operate/customization]`
  - `theme`: `"default" | "midnight" | "charcoal" | "soft" | "none"` (the formal enum).
  - `labels`: `"above" | "floating" | "never"`.
  - `variables`: colour/typography/spacing map — `colorPrimary`, `colorBackground`, `colorText`,
    `borderColor`, `fontFamily`, `borderRadius`, etc.
  - `rules`: CSS-like selector map — e.g. `.Input`, `.Tab`, `.AccordionItem`.
- The customization editor exposes extra named presets (Peach orange, Branded blue, Minimal, Rounded)
  beyond the five formal `theme` values; those compose `theme` + `variables` and their exact makeup is not
  spelled out on the page — treat the five-value `theme` enum as canonical and build the rest with
  `variables`. `[VERIFY-SANDBOX]`

## 4. Saved cards on the web

- Pass `customerSessionClientSecret` alongside `clientSecret` in `hyper.elements(...)` to show a customer's
  saved cards. The field name is documented; its full shape is not spelled out on the page — confirm in
  sandbox. `[DOCS sdk-web]` `[VERIFY-SANDBOX]`
- Save a card with `hyper.confirmSetup({ elements, confirmParams })`. `[DOCS sdk-web]`
- **Charging a saved `pm_` later is a merchant-initiated transaction (MIT)** — you reference it through
  `recurring_details`, not a top-level `payment_method_id`. Only card-backed credentials can be stored and
  charged this way (not alternative methods). Full MIT shape and the `mandate_data` setup step are in
  `orchestration-api.md` §MIT. `[DOCS integrate/sdk, integrate/hosted-checkout]`

## 5. Inline iframe redirection for alternative methods

Non-card redirects can render inline in the form instead of a full-screen popout. It takes **two flags plus
a confirm-routing option**, and cards are always excluded. `[DOCS sdk-web]`

- **Backend/connector flag** `is_iframe_redirection_enabled` must be enabled on the Peach side, or the
  option does nothing (redirects stay full-page).
- **Client Elements option** `inline_iframe_redirection_enabled: true`.
- Pair it with `sdkHandleConfirmPayment: { confirmParams: { return_url } }` on the same options object —
  the SDK confirms from inside the element, so the return URL goes on the element, not on `confirmPayment()`.

```javascript illustrative
const paymentElement = elements.create('payment', {
  layout: 'tabs',
  inline_iframe_redirection_enabled: true,
  sdkHandleConfirmPayment: {
    confirmParams: { return_url: 'https://your-site.com/checkout/complete' },
  },
});
```

- **Cards always pop out** regardless of the flag (3DS/ACS pages refuse to be framed).
- **Redirect targets must allow framing** — a page sending `X-Frame-Options: DENY` or a restrictive
  `frame-ancestors` renders blank inside the iframe. Only enable it for APM pages you have verified frame.
- Completion is detected by polling the intent server-side (works cross-origin), with a 15-minute backstop;
  it settles cleanly if the shopper abandons. `[DOCS sdk-web]`

## 6. Framework guides

The Web SDK page ships a framework switcher — **Vanilla JavaScript, React, Vue, Angular** — with ten
sections each (Prerequisites, Installation, Configuration, Basic integration, Payment methods, Saved cards,
Error handling, Customisation, Testing, Troubleshooting). The only framework-specific detail captured in
the text is the React/Next.js pattern: load `HyperLoader.js` dynamically (a `<script>` tag or
`document.createElement('script')`), then use the global `Hyper` the same way as Vanilla. No
`@hyperswitch/react`-style package or hooks are named on the page — the per-framework code lives in the
interactive playground, so treat it as "guides exist; confirm the exact per-framework API in the live
playground" rather than inventing hook names. `[DOCS sdk-web]` `[VERIFY-SANDBOX for framework-specific code]`

## 7. Hosted Checkout — Peach hosts the page

- Create with `POST /payments`, `confirm:false` + `payment_link:true`; the response carries the link at
  `payment_link.link`. No checkout for you to build and no payment-method data in the request. `[DOCS integrate/hosted-checkout]`
- `payment_link_config` (baked in at creation — a live link cannot be restyled; editing appearance prompts
  a new link, which is a **new payment and new URL**): `[DOCS integrate/hosted-checkout]`

| Field | Meaning |
|---|---|
| `theme` | Accent colour (e.g. `"#4E6ADD"`) |
| `logo` | Merchant logo URL |
| `seller_name` | Merchant name shown to the shopper |
| `branding_visibility` | Toggle Peach/HyperSwitch branding |
| `sdk_layout` | `accordion` / `tabs` / `spaced_accordion` (free string in schema; these are the documented values) |
| `details_layout` | `layout1` / `layout2` |
| `display_sdk_only` | Hide order summary, show just the form |
| `show_card_form_by_default` | Open card form on load (default `true`) |
| `enabled_saved_payment_method` | Offer the customer's saved cards (default `false`) |
| `hide_card_nickname_field` | Hide nickname input (default `false`) |
| `payment_button_text` | Pay-button label |
| `custom_message_for_card_terms` | Message under the card form |
| `transaction_details` | Key/value rows shown to the shopper |

Also present in the OpenAPI `PaymentLinkConfigRequest` (not on the doc page's table, carry as "also
available"): `background_image`, `payment_button_colour`, `payment_button_text_colour`, `background_colour`,
`skip_status_screen`, `sdk_ui_rules`, `payment_link_ui_rules`, `enable_button_only_on_form_ready`,
`payment_form_header_text`, `payment_form_label_type` (`above`/`floating`/`never`), `show_card_terms`
(`always`/`auto`/`never`), `is_setup_mandate_flow`, `custom_message_for_payment_method_types`.
`[DOCS openapi PaymentLinkConfigRequest]`

- **Unit trap — `session_expiry` is in SECONDS.** It sits on the payment-create request root (next to
  `payment_link`/`confirm`), not inside `payment_link_config`, and expires the client secret (which is what
  makes a shared link stop working). Example `900` = 15 minutes. Our separate **Payment Links** product
  (`payment-links.md`) takes `expiryTime` in **minutes** — do not copy the number between the two products.
  `[DOCS integrate/hosted-checkout, openapi PaymentsCreateRequest.session_expiry]`
- Recurring on Hosted Checkout: add `setup_future_usage:"off_session"` + `customer_id` + `mandate_data` to
  the same payment-link request; the shopper agrees to the mandate on Peach's page, so you never handle the
  credential or the acceptance. Details in `orchestration-api.md` §MIT. `[DOCS integrate/hosted-checkout]`
- Same platform rules as the rest of Orchestration: amounts in **minor units**; alternative payment methods
  are **automatic-capture only**; status queries rate-limited to **2/min per transaction** (poll 30s apart).
  `[DOCS integrate/hosted-checkout]`

## 8. Mobile SDK theming (pointer)

The iOS/Android SDKs style the payment sheet with an `Appearance`/`PaymentSheetAppearance` object (colours,
corner radius, border width) rather than CSS-like `rules`, with the same preset idea. That is covered in
`mobile.md` §8 — not duplicated here. `[DOCS operate/customization/ios, operate/customization/android]`

## Traps

- **The demo endpoints are NOT a real API.** The `integrate/sdk` playground page fetches its intent over
  `GET /api/create-msdk-intent` / `/modify-msdk-intent?sessionId=...`. **These are the playground's own demo
  backend** (they appear nowhere in the OpenAPI spec). Never present them as merchant endpoints — your
  server creates the intent with `POST /payments` (`orchestration-api.md`).
- **Do not confuse this with Checkout V2.** Both are called "Embedded/Hosted Checkout"; they share no
  backend, auth, or script (§0). Get it wrong and nothing authenticates.
- **`allowed_payment_method_types` filters, it does not enable** — a merchant expecting a method to appear
  because they listed it, without enabling it on the account for that currency, will see nothing (§2).
- **`session_expiry` seconds vs Payment Links `expiryTime` minutes** — a 60× error if copied across products (§7).
- **Never put the secret `api-key` in the browser** — the publishable key confirms client-side; the secret
  key creates the intent server-side only (§1–§2).

## Sources

All `[DOCS]` facts fetched 2026-09-07 from the public Peach Orchestration docs
(playground.peachpayments.com — `llms-full.txt` + `openapi.json`): `/sdk-web`, `/integrate/sdk`,
`/integrate/hosted-checkout`, `/operate/customization`, and the OpenAPI `PaymentsCreateRequest` /
`PaymentLinkConfigRequest` schemas. Fields named on a page but not fully specified there are marked
`[VERIFY-SANDBOX]`. The Checkout-V2 comparison in §0 is skill cross-reference (`checkout-v2.md`), not a
playground fact.
