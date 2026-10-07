# Discovery

## When to load
BEFORE recommending or building anything Peach-related, and whenever requirements are unclear. A recommendation without these answers is a guess.

## Interview rules

- **Infer what you can from the repo first.** Detect the platform before asking: `wp-content/` or WooCommerce plugin files → WooCommerce; `shopify.app.toml`/theme liquid → Shopify; `composer.json` with Magento → Magento; `nuxt.config`/custom app → custom web; `ios/`+`android/` native dirs → mobile; `pubspec.yaml` → Flutter; `react-native.config.js` → React Native. Don't ask what a file listing answers.
- **Batch 5–7 questions max per round.** Don't interrogate; two rounds beat one questionnaire dump.
- Skip any question the repo or the user's first message already answered. Ask only what changes the recommendation.
- If every answer is known after round 1, skip further rounds and produce the recommendation.

## Calibrate to the user FIRST (this decides how you ask everything below)

Detect who you are helping from their first message, then match them. Getting this wrong — jargon at a
beginner, hand-holding at an expert — is itself a failure.

**Non-technical / vibecoder** — signs: they name an AI builder (Lovable/Bolt/Cursor/v0), say things
like "I want people to pay me on my site", and use no API/webhook/backend vocabulary. Switch to
**plain-language mode**: translate every term, ask the 2–3 plain questions below (not the full
questionnaire), and pick sensible defaults they can just accept. Never surface a term they can't be
expected to know (`acquirer`, `auth-then-capture`, `SAQ A`, `entity ID`) without translating it.

**Experienced developer** — signs: they name their stack, mention webhooks/tokenisation/PCI, or paste
code. Skip every question they already answered, stay terse and precise, and go straight to
endpoints/fields/code. Don't explain basics they clearly know.

**Unsure?** Ask one calibration question: "Are you comfortable with the technical side (APIs,
webhooks), or would you like me to keep this plain and handle the technical bits for you?"

### Plain-language mode — ask these instead

| Don't ask (jargon) | Ask this instead (with a sensible default) |
|---|---|
| "One-off / recurring / auth-then-capture / payouts?" | "Do people pay you once, or on a repeating schedule (like a monthly subscription)?" |
| "Charge now vs auth-then-capture?" | "Charge them the moment they pay, or hold the money and take it later (e.g. once you ship)?" (default: charge now) |
| "Which methods — cards / EFT / BNPL / wallets / mobile money?" | "Card payments to start? I can also switch on Apple Pay / Google Pay and 'pay later' options — want those?" (default: cards + instant EFT) |
| "Embedded vs redirect vs wallet-buttons-only?" | "Should the payment box stay on your page, or is it fine to send people to a secure Peach page and back?" (default: stays on your page = Embedded) |
| "Sandbox access? Acquirer? Which methods enabled?" | "Do you already have a Peach Payments account, or should I walk you through signing up?" |
| "Plugin vs custom? Backend language / framework?" | Infer silently from the repo — never ask a non-technical user this. |

Then produce the same recommendation block as everyone else, but explain the "why" in one plain
sentence and keep the technical detail in the code you write, not in the conversation.

**Plain-language mode doesn't stop at discovery — carry it through the build:**

- **Check for a backend before recommending Embedded/Hosted Checkout.** AI-builder sites
  (Lovable / Bolt / v0 / Replit) are often frontend-only. Both Embedded and Hosted Checkout need a
  small server to create the payment and verify webhooks. If the user has no backend ("it's just the
  site the AI made", no Supabase/edge functions), route them to the **zero-code path — a Payment Link
  or Payment Page** (`playbooks/get-paid-without-a-store.md`): a hosted pay-me link/button that needs
  no server at all. Make that the default for a non-technical user unless they clearly have a backend.
- **Say why Peach exists, once:** "Peach is the service that actually moves the money — your site just
  sends people to Peach to pay and gets told when it worked." A first-timer may not realise the site
  and the payment provider are two different things.
- **Keep translating at go-live,** the other place non-technical users get stuck: explain credentials
  in plain terms ("add these two secret keys to your project's settings, and keep them off the public
  page"), never drop raw `entityId` / `webhook secret` / `sandbox vs live` on them unexplained.

### Minimal glossary (use to translate, don't lecture)

- **Tokenise / card on file** — securely save a card so you can charge it again without re-asking.
- **Recurring / MIT** — you charge a saved card on a schedule (subscription); the customer isn't present.
- **3DS** — the bank's "confirm it's really you" step (OTP / app approval) during a card payment.
- **PCI / SAQ A** — using Peach's hosted card fields means card numbers never touch your server, which
  keeps your security paperwork minimal. Building your own card inputs makes it much heavier — avoid it.
- **Webhook** — Peach calling your server to say "this payment happened"; you verify it, then fulfil.
- **Acquirer** — the bank that processes the card payment behind the scenes; usually you don't pick it.
- **EFT** — paying by bank transfer instead of a card. **BNPL** — "buy now, pay later" (Payflex etc.).
- **Sandbox** — a free test mode with fake cards, so you can practise before taking real money.

## POS discovery branch

For in-store or terminal payments, infer what is already known, then establish:

- Same Sunmi terminal as the Payment App, or a separate web/tablet/computer till?
- Exact model, Android/API level, memory/ABI, country and currency, provisioned Payment App version?
- REST enablement/API key or Intent Maven access, UAT terminal/account, backend and webhook availability?
- Sale, partial refunds, voids, receipts, printer/scanner, offline basket capture, and multi-terminal needs?

Route to `pos-integrations.md`, then `pos-expo-sunmi.md` for Expo. Do not ask online-wallet or 3DS
questions for a card-present cashier flow. An offline basket is not an offline card approval.

## The questionnaire

1. **What are you building on?**
   WooCommerce / Shopify / Magento / Wix / Ecwid / nopCommerce / OpenCart / Gravity Forms / Xero / Medusa / custom web / mobile app / something else.
   *Why it matters:* a supported platform routes plugin-first.
   *Branch:* any named platform → `plugins/_matrix.md` + the platform file. Custom web → `products-and-routing.md` then `sdk-web.md` / `orchestration-api.md` for new integrations. Online mobile → `mobile.md`; cashier POS → `pos-integrations.md`.

2. **What are you collecting?**
   One-off payments / subscriptions or recurring / invoices or pay-links / deposits+capture (auth-then-capture) / payouts to users / donations.
   *Why it matters:* recurring excludes Shopify and forces the tokenisation + own-scheduler design; payouts is a different product entirely.
   *Branch:* recurring → `playbooks/subscriptions.md` + `recurring-and-tokenisation.md`; payouts → `playbooks/payouts-marketplace.md` + `payouts.md`; invoices/no store → `playbooks/get-paid-without-a-store.md`.

3. **Which countries and currencies?**
   ZAR / KES / MUR (+ USD/GBP/EUR availability varies by method).
   *Why it matters:* currency gates methods — M-PESA is KES, PayShap is ZAR, MauCAS/blink/MCB Juice are MUR.
   *Branch:* `methods-catalog.md` for the gated matrix; multi-currency + non-ZAR sandbox testing needs the magic amounts (92.00 / 15.99) — `testing-and-go-live.md`.

4. **Which payment methods matter?**
   Cards / EFT & Pay-by-Bank / BNPL (Payflex, ZeroPay, Float, Happy Pay) / wallets (Apple/Google/Samsung Pay, PayPal) / mobile money (M-PESA, blink, MCB Juice) / vouchers (1Voucher).
   *Why it matters:* method choice constrains the surface — e.g. Peach EFT is Payments API only, PayPal not on Embedded, Pay by Bank Checkout-only.
   *Branch:* `methods-catalog.md`; non-card with custom UI → `payments-api.md`.

5. **Checkout experience constraint?**
   On-site embedded vs redirect acceptable vs wallet-buttons-only.
   *Why it matters:* decides Embedded vs Hosted vs Express vs Payments API custom UI.
   *Branch:* new online builds → `sdk-web.md`; existing classic Checkout → `checkout-v2.md` (including its Express section).

6. **Existing Peach account?**
   Sandbox access? Which methods are enabled? Acquirer?
   *Why it matters:* some methods need support activation (Payments API, recurring credentials, MOTO channel, Apple Pay domain registration); method availability depends on onboarding.
   *Branch:* anything activation-gated → flag "contact Peach support" in the next step; testing plan → `testing-and-go-live.md`.

7. **Who maintains this?**
   Plugin acceptable vs custom code required; team skills (backend language, frontend framework).
   *Why it matters:* a custom build makes the team owner of signatures, result-code mapping, and webhook parsing forever.
   *Branch:* feeds the custom-vs-plugin confidence rubric in `products-and-routing.md` §3.

## Output format

Produce exactly this block after discovery (fill every line; no silent omissions):

```
Recommended approach: <surface/product + key config>
Why (weighted reasons):
  1. <strongest reason>
  2. <second reason>
  3. <further reasons>
Confidence: High | Medium | Low
Trade-offs considered:
  - <option B>: <why not / what it costs>
  - <option C>: <why not>
Next step: <concrete action> — read <reference file> first.
```

### Worked example (WooCommerce + subscriptions)

```
Recommended approach: Official Peach Payments WooCommerce extension (V4) with
Woo Subscriptions enabled; obtain the Recurring ID + Card Webhook Decryption
key from Peach support; enable card storage in the plugin settings.
Why (weighted reasons):
  1. WooCommerce is officially supported — plugin-first beats custom code.
  2. Recurring works via Woo Subscriptions on tokenised cards; Peach handles
     3DS and the checkout surface.
  3. Custom build would make you own webhook signatures, result codes, and
     card-expiry handling for no gain here.
Confidence: High
Trade-offs considered:
  - Custom Checkout V2 build: weeks of work, you own maintenance — rejected.
  - Shopify-style once-off + manual links: inferior UX for subscriptions on Woo.
Next step: install the plugin in sandbox (Integrator Test mode) and run the
sandbox matrix — read plugins/woocommerce.md, then playbooks/subscriptions.md
for the card-expiry/failed-renewal plan (playbooks/failed-renewal-card-expiry.md).
```

## Traps
- Do NOT recommend before platform + collection-type + currency are known — those three flip the answer most often.
- Do NOT offer Peach recurring on Shopify — capability does not exist; refuse honestly (`products-and-routing.md` §3).
- Repo inference is a prior, not proof — confirm the platform in one line if the detection is ambiguous (e.g. headless storefront on WooCommerce backend).
- Don't ask about pricing/fees — out of scope; route to Peach.
- If the user shows legacy code (`/v1/checkouts`, `paymentWidgets.js`), run `legacy-surfaces.md` identification BEFORE asking build questions.
- Batch limit exists for the user's benefit: >7 questions per round gets partial answers; missing answers cause wrong routing later.
