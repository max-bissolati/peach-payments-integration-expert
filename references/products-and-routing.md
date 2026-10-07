# Products and Routing


**Routing update, verified 2026-10-07:** Peach now recommends Orchestration for new custom online
integrations. Existing classic Checkout/Payments API integrations remain documented; do not relabel
that guidance as an announced shutdown or force a migration during unrelated maintenance.
Read `sdk-web.md` and `orchestration-api.md` for new builds. Sources:
[product portfolio](https://developer.peachpayments.com/docs/product-portfolio-overview),
[Checkout overview](https://developer.peachpayments.com/docs/checkout-overview),
[Payments API overview](https://developer.peachpayments.com/docs/payments-api-overview).

## When to load
Load for any "which Peach product/approach" question, and BEFORE any custom build is started or proposed. Route here first whenever the user names a product ambiguity (Checkout vs Payments API vs Payment Links).

## 1. Product portfolio

| Product | What it is | When to choose |
|---|---|---|
| **Orchestration** | PaymentIntent-based Embedded/Hosted Checkout, server API, online mobile SDKs | Recommended for new custom online builds; `sdk-web.md`, `orchestration-api.md`, `mobile.md` |
| **Classic Checkout** (Embedded / Hosted) | Ready-made payment form, embedded on-site or full-page redirect; cards + African methods; handles 3DS automatically | Existing Checkout integrations; new custom online builds use Orchestration |
| **Embedded Express** (part of Checkout) | `Checkout.express` wallet-buttons-only surface (Apple/Google/Samsung Pay) | Wallets on product/cart pages; no customisations, no tokenisation |
| **Payment Links** | Hosted links via Dashboard or API; deliver by email/SMS/WhatsApp; bulk CSV ≤1000 | No store, invoices, one-off collections; recurring invoices via Xero |
| **Classic Payments API** (v2) | Server-to-server, custom flow, **no (bank) card payments** (RCS store-card exception); non-card methods incl. PayShap, M-PESA, Peach EFT | Existing integrations; new custom flows use Orchestration Server-to-Server |
| **Payment Page** | Reusable hosted page (share via social/WhatsApp/QR); Embedded Checkout internally, default currency only | Reusable public pay-me page; donations; no per-invoice API work |
| **Payment extensions** | Pre-built plugins: WooCommerce, Shopify, Magento, Wix, Ecwid, nopCommerce, OpenCart, Gravity Forms, Xero (+ Take App) | Platform in the list → install beats build. See `plugins/_matrix.md` |
| **Recurring payments** (Dashboard feature) | NOT a scheduler — only issues recurring API credentials (recurring ID + token) + lists recurring-capable methods | You tokenise + run your own billing loop. See `playbooks/subscriptions.md` |
| **MOTO** (virtual terminal) | Dashboard-only manual card entry; approved channels only | Phone/mail orders. **No 3DS — merchant bears chargeback liability** |
| **POS** (point of sale) | Card-present Payment App on Sunmi; REST from a separate till or Intent API on the terminal | Public integration docs cover South Africa. Read `pos-integrations.md`; confirm other markets, hardware and enablement with Peach |
| **Payouts** | Realtime EFT disbursements to SA bank accounts (float-funded) | Paying drivers/sellers/suppliers. See `playbooks/payouts-marketplace.md` |
| **Mobile SDK** | Native iOS/Android SDK; **V2 current, V1 legacy** | Native apps. See `mobile.md` |
| Dashboard ops | Transactions/refunds, credentials, domain allowlisting, recon/settlement reports, onboarding | Ops tasks; not an integration surface |

Method categories: card, EFT, BNPL, QR, wallet, voucher, mobile money, alternative credit. Per-method matrix: `methods-catalog.md`.

## 2. Product-selection matrix

| Need | First choice | Also consider | Why |
|---|---|---|---|
| Store on a supported platform | Official extension | Embedded only for headless | Plugin-first: Peach maintains the method/3DS/webhook wiring; you maintain keys. See `plugins/_matrix.md` |
| New custom web app, one-off payment | Orchestration Embedded Checkout | Orchestration Hosted Checkout | Current Peach recommendation; see `sdk-web.md` |
| Wallets on product/cart pages | Embedded Express | — | Express = wallet buttons only; no customisations, no tokenisation, device-dependent |
| Invoices / no website | Payment Links | Payment Page (reusable); Xero (repeating invoices) | Links = invoice-style, no store needed; Page = one durable social/QR link |
| New custom flow, non-card methods | Orchestration Server-to-Server | Orchestration Checkout | Check per-method support and next actions in `orchestration-api.md`; classic Payments API is for existing integrations |
| Card data on your own site | S2S — **PCI warning, challenge this instinct** | Embedded (SAQ A) almost always better | S2S raw card ⇒ SAQ A-EP/D + full PCI scope. Embedded keeps you SAQ A with the same customer experience. Say this out loud |
| Subscriptions / recurring | Playbook `playbooks/subscriptions.md` | — | No Peach scheduler exists; design = tokenise + your loop (or extension recurring where supported) |
| Paying out recipients | Payouts | — | Realtime EFT disbursement, float-funded, irreversible. See `payouts.md` |
| Customer-facing online mobile app | Mobile SDK V2 | Checkout-in-WebView (hybrid apps only) | For card-present cashier apps use POS, not the online SDK. See `mobile.md` |
| In-person / pay-on-pickup / counter | POS REST (separate till) or Intent (same terminal) | Payment Link at collection; platform COD-style gateway | See §5 and `pos-integrations.md`; custom Expo/Sunmi apps also load `pos-expo-sunmi.md` |
| Legacy codebase already present | Check `legacy-surfaces.md` first | — | `/v1/checkouts` + `paymentWidgets.js` = COPYandPAY, not Checkout V2 |

## 3. Custom-vs-plugin decision aid

Ask these 4 questions, in order:

1. **Is the platform in Peach's extension list?** (WooCommerce, Shopify, Magento, Wix, Ecwid, nopCommerce, OpenCart, Gravity Forms, Xero, Take App; Medusa has a published community plugin.) Yes → default to the extension.
2. **Are the flows standard?** (one-off checkout, refunds, simple tokenisation) — extensions cover them. Custom needs (headless storefront, custom checkout UX, non-card-only S2S flows, payouts-driven marketplaces) → new custom online build on Orchestration, or POS for card-present needs.
3. **Who maintains it?** An extension shifts method/3DS/webhook maintenance to Peach's plugin releases. A custom build makes your team the maintainer of signature schemes, code mappings, and endpoint changes forever.
4. **What is the timeline?** Estimate after selecting the product, accounting for account enablement, recovery, testing and physical UAT for POS.

**When NOT to build custom (default refusals):**
- Platform has an official extension AND flows are standard → do not build custom; configure the extension.
- The need is "card fields on my own site" → do not build raw-card S2S without surfacing the SAQ A-EP/D cost and re-offering Embedded.
- The need is subscriptions on Shopify → **Peach cannot do recurring on Shopify** (once-off only). Honest refusal + alternatives: once-off + manual Payment Links renewals, or a platform decision. Say it plainly; never invent a Shopify subscription capability.
- Recurring anywhere without a scheduler plan → there is no Peach-managed subscription engine; the merchant owns the debit loop (`playbooks/subscriptions.md`).

**Confidence rubric (attach to every recommendation):**
- **High** (≥80% one approach clearly wins): supported platform + standard needs, or a hard constraint decides it (for example, the required payment method is enabled on one suitable surface).
- **Medium**: trade-offs exist but one option dominates on maintenance risk; state the trade-off in one line.
- **Low** (<50% clear winner, or requirements unknown): present the trade-offs side by side, do NOT pick silently; run `discovery.md` first.

**Honest-refusal framing:** if Peach can't do it, say so as a capability fact, then offer the nearest real alternative. Examples: Shopify recurring (no), Peach-side dunning/retry (no — your scheduler), Wix/Ecwid plugin refunds (no — manual via Peach Dashboard), sandbox for Wix/Xero (none), Payments API card payments (no, RCS exception only). Never speculate a product into existence.

## 4. Payment Page quick facts

- Reusable hosted page, Embedded Checkout internally → same methods, **default currency only**.
- Amount **≥ 10.00 and ≤ 10000.00** by default; support can lower the minimum or raise the cap to 999999.99. ⚠️ version-sensitive — confirm current cap in Dashboard before quoting.
- Setup: Dashboard → activate → publish → share (Facebook/X/WhatsApp/direct link/QR).
- Prepopulate via query params: `?amount=&reference=&email=&firstName=&lastName=&mobile=` — values must be valid and flip the matching **Collect** toggles on. Customer can still edit prepopulated fields.
- **Email XOR mobile is the minimum** contact requirement.
- FNB accounts: reference must be alphanumeric only.
- Cross-link: `playbooks/get-paid-without-a-store.md`, `payment-links.md`.

## 5. In-person payments: counter, pickup, tip jar, phone orders

- **Integrated card-present payments are publicly documented.** For a separate web/tablet/computer
  till, use POS Integrations REST: dispatch a sale, receive webhooks, poll by request ID, and refund.
  For an app on the same Android terminal as Peach's Payment App, use the Intent API: sale, refund,
  void and lookup. See `pos-integrations.md` for the distinct contracts and known documentation gaps.
- **Custom Expo apps:** a separate till can use HTTPS through its backend; an on-terminal app needs
  an Android native bridge and development/production build. Read `pos-expo-sunmi.md` before choosing
  hardware or promising installation. Android alone does not establish Peach or Sunmi approval.
- **Market and method scope:** current integration guides cover Sunmi in South Africa and REST card
  payments. Broader POS product availability or Hosted Checkout methods do not establish API support
  in Mauritius or for QR/PayByLink. Confirm those capabilities separately with Peach.
- **Pay-on-pickup patterns** (customer orders online, pays at collection): (a) the platform's own
  pay-at-collection/cash-on-delivery gateway — not a Peach flow, zero fees via Peach, usually the
  pragmatic answer; (b) a **Payment Link** generated/sent when the customer arrives (email/SMS/
  WhatsApp; any enabled method); (c) a **Payment Page QR** at the till — reusable, customer enters
  their own amount (tips/donations), R10.00 minimum by default, email-or-mobile required.
- **Pre-auth then capture-on-collection** (reserve at order, capture at pickup) is a Checkout `PA`
  flow — **7-day capture window** (`recurring-and-tokenisation.md`); whether a given platform
  extension exposes auth-then-capture is often undocumented — confirm with Peach support before
  promising it.
- **Phone orders**: prefer a **Payment Link** sent to the customer's phone (3DS-protected,
  liability stays with the rail). **MOTO** (keying the card in) needs channel approval, has **no
  3DS — chargeback liability is yours**, and can create a registration token — fallback only.
- **MOTO Dashboard update, checked 2026-10-07:** the hold option is labelled **Reserve funds**.
  Successful debits offer **Proof of Payment**; successful holds offer **Proof of PreAuth**.
  A preauthorisation still needs capture before settlement. The MOTO role processes payments but
  does not expose MOTO credentials. [Current guide](https://developer.peachpayments.com/docs/dashboard-moto).
- Offline bank transfers (customer EFTs you directly) are invisible to Peach — no webhook, no
  reconciliation, manual invoice marking.

## 6. Capability absence catalogue — say these out loud

Never leave a "does Peach support X?" to be inferred from silence. These are capability FACTS:

- **No self-serve split payments / split settlement** — a gated **Marketplace Payments** arrangement
  does exist (API carries `marketPlace.sellers[n].amount` fields; un-enabled accounts get `800.121.400
  Marketplace Payments is not enabled` — enablement is a Peach account change, not a parameter).
  Without it: one checkout settles to one account; splits = your ledger + Payouts (SA-only), or
  separate transactions. The Orchestration (Mobile SDK V2) spec also carries split items
  (`AdyenSplitItem`-style) — same story: schema exists, enablement is Peach-side.
- **No escrow / pay-on-delivery-hold product** — the closest primitive is a card `PA` with its
  **7-day capture window** (`recurring-and-tokenisation.md`); long delivery cycles don't fit it. On
  **Orchestration** the hold can be stretched a bit: `extend_authorization` extends the window and
  `incremental_authorization` raises the authorised amount (`orchestration-api.md` §2/§6) — but it is still
  a temporary card hold, not escrow.
- **Orchestration adds cross-processor MIT resilience** (a capability the legacy card facade lacks): with
  **gateway-agnostic MIT**, one saved credential is charged across PeachPayments / ACI / Cybersource with
  automatic connector-fallback on soft decline — enabled by the business-profile field
  `is_connector_agnostic_mit_enabled` (`orchestration-api.md` §10.5). Legacy Checkout / Payments-API
  recurring stays on a single connector. This is a routing/resilience feature, not a splitting or scheduling one.
- **No metered / usage-based billing product** — model variable usage as variable-amount MIT debits
  (`standingInstruction.type: UNSCHEDULED`) or prepaid top-ups via links.
- **No un-refund / refund reversal** — refunds move one direction only. A refund sent in error is
  corrected by a NEW debit (charge the customer again), never by "reversing" the refund; the money is
  already gone from your side, so recover it as a fresh sale. (Reversal/void, `RV`, applies to an
  uncaptured pre-auth, NOT to a completed refund — `recurring-and-tokenisation.md`.)
- **Dashboard-only-managed features are not programmable** — where a capability is configured only in
  the Peach Dashboard (MOTO virtual terminal, webhook security, some 3DS risk-rule tuning), there is
  no API/SDK parameter for it. Automate around it; don't hunt for an endpoint that does not exist, and
  say so plainly rather than implying the API can toggle it.
- **No built-in age verification on any surface** — checkout cannot enforce an age gate; do it in
  your app BEFORE creating the payment, and see `onboarding-and-eligibility.md` for restricted goods.
- **Consolidated Dashboard views exist.** Current Orchestration Dashboard guides describe transactions
  across businesses, exports with merchant identifiers and team management. That does not establish
  pooled settlement or shared API credentials; keep API/recon requests scoped to their merchant.
  [Dashboard overview](https://playground.peachpayments.com/docs/dashboard-overview), checked 2026-10-07.
- **No FX / display-currency conversion** — quoting in one currency and collecting in another is
  your app's job (see §7); Peach processes the transaction currency your account supports.
- **No merchant-facing MCC controls** — category assignment happens at Peach onboarding/risk
  (`onboarding-and-eligibility.md`).

## 7. Transaction currency vs settlement currency

The API `currency` field is the **transaction currency** (Checkout enum: ZAR/KES/MUR/USD/GBP/EUR —
and only if your entity has methods enabled for it; otherwise creation fails with `No valid payment
methods available for this request.` `[SANDBOX-VERIFIED 2026-09-08]`). **Settlement currency —
what actually lands in your bank account — is set at account/entity level by Peach and your
acquirer agreement and is NOT published in the developer docs.** When a user asks "which currency
lands in my account?" the honest answer is: transaction currency is configurable per request;
settlement currency is an account property — confirm it with Peach. Displaying a different
(quoting) currency is your application's concern; there is no checkout-time FX/quoting product —
where settlement involves conversion, the Reconciliation API reports a `settlement.fxRate` per
transaction, i.e. conversion (when it applies) happens on the settlement side, not via a merchant
API feature.

## Traps
- "Payments API" ≠ Checkout API. Payments API is the no-redirect S2S surface for **non-card** methods (RCS store-card exception). Cards on Payments API do not exist — Apple/Google/Samsung Pay aren't in its brand enum.
- S2S instinct for "card on my own site": challenge it — Embedded gives near-identical UX at SAQ A; S2S raw card = SAQ A-EP/D and full PCI scope. Classic Checkout has limited theming; Orchestration Web SDK offers Elements-style components and is covered in `sdk-web.md`.
- Embedded Express ≠ full Embedded: no customisations, no tokenisation, wallets device-dependent.
- "Recurring payments" in Dashboard is a credentials feature, not a scheduler — promising auto-billing is an invented capability.
- Wix + Xero have **no sandbox**; Take App is live-only — don't route testable plans there.
- Hosted Checkout exposes more methods than Embedded (e.g. PayPal is Hosted/Links/extensions, not Embedded).
- Route card-present POS questions to `pos-integrations.md`; do not substitute online Checkout, its mobile SDK, or Payment Links unless the user wants those alternatives.
- The product table and the matrix above decide the surface; method-level questions (refundable? limits? countries?) go to `methods-catalog.md`, not memory.
