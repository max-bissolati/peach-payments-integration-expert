# Sharp edges — the pitfall table

## When to load

Before go-live reviews, when something just broke, or when auditing an existing Peach integration
(`adversarial review` mode). Severity-ranked; every row has a fix. Files named in parentheses carry
the detail.

## Critical

| # | Edge | Fix |
|---|---|---|
| 1 | Trusting an unverified webhook (or skipping verification because "it broke") | Verify via Scheme A body signature or Scheme B headers (`webhooks.md`), fail closed, then re-confirm via `GET /status` before acting. Use `scripts/verify-webhook.js` |
| 2 | Fulfilling on the redirect return / widget event without server-side confirmation | The Hosted return POST and `onCompleted` events are browser-side; always `GET /status` + check amount before fulfilment (`checkout-v2.md`) |
| 3 | Refund request sent as nested JSON → `200.300.404` | V1 refund endpoint wants form-urlencoded flat dotted keys (`checkout-v2.md` § refunds) `[PLUGIN-VERIFIED]` |
| 4 | Treating `000.400.101`/`000.400.102` as success (fail-open) | Intermediate 3DS-step codes; only terminal `000.000.*`/`000.100.1*` are captured (`result-codes.md`) `[PLUGIN-VERIFIED]` |
| 5 | Amount-unit confusion (Checkout/Payments API = decimal-string major units; Payouts API integer cents AND Mobile SDK V2/Orchestration integer minor units) | Per-product rule; compare at rounded cents; `amountsMatch` on strings fails silently (`checkout-v2.md`, `payouts.md`, `mobile.md`) |
| 6 | Live credentials committed/tested against | Env-only; detection patterns + rotation (`pci-security.md`); sandbox first, always |

## High

| # | Edge | Fix |
|---|---|---|
| 7 | OAuth/checkout calls from the browser (CORS errors = design bug) | All auth + checkout creation server-side (`checkout-v2.md`) |
| 8 | JSON body-parser consumes the webhook raw body → signature unverifiable | Raw-body route or parsed-object reconstruction recipe (`webhooks.md`) `[PLUGIN-VERIFIED]` |
| 9 | M-PESA decimal amounts sent | Integer-only, round up; also non-refundable (`payments-api.md`, `methods-catalog.md`) |
| 10 | Assuming every platform is testable (Wix/Xero: no sandbox; Samsung Pay + MoneyBadger: live-only) | Plan live-test protocol + owner-run checks (`testing-and-go-live.md`, `playbooks/go-live.md`) |
| 11 | Shopify refunds issued from the Peach Dashboard | Shopify never learns of them — refund from the Shopify admin (`plugins/shopify.md`) |
| 12 | Acting on `pending` (`000.200.*`) webhooks — authorize attempts fail and retry ~30× | Only terminal success, re-confirmed via `/status` (`webhooks.md`) `[PLUGIN-VERIFIED]` |
| 13 | MIT debit sent with CVV/3DS params, or with the Checkout OAuth token instead of the S2S/recurring token | Strip CVV/3DS from MIT; use the card-facade credentials (`recurring-and-tokenisation.md`) `[PLUGIN-VERIFIED]` |
| 14 | Payments API webhook handler expects plaintext | Bodies are AES-128-GCM encrypted; PII toggle must be ON or nothing is sent (`payments-api.md`) |
| 15 | Hard-matching `paymentBrand` strings | Enums differ across surfaces (`VISA`/`MASTER` vs `MASTERCARD`, `APPLE PAY` with a space) — compare loosely (`checkout-v2.md`) |

## Medium

| # | Edge | Fix |
|---|---|---|
| 16 | Re-rendering a `checkoutId` after `unmount()`/expiry | Single-use, 30-min TTL; re-initiate a fresh checkout (`checkout-v2.md`) |
| 17 | PayShap partial refund blocks any later refund | One-refund-per-transaction rule — refund fully (`methods-catalog.md`) |
| 18 | Status polling assumed uniform | Checkout `/status`: no documented limit; Payments API: 2 req/min per transaction (`payments-api.md`) |
| 19 | Recon API queried with >24h windows or pre-2023 dates | Chunk to ≤24h, 1 req/s, mind 3-day aggregation lag (`reconciliation.md`) |
| 20 | Legacy docs read as current (COPYandPAY `/v1/checkouts` + `paymentWidgets.js` ≠ Checkout V2) | Legacy identity table (`legacy-surfaces.md`); note V1 refund endpoint is still current |
| 21 | Iframing Embedded/Hosted checkout | Unsupported — payment methods fail; open full-page or embed the widget properly (`checkout-v2.md`) |
| 22 | Payment link double-pay (customer closes window, link stays "Processing", pays again) | Suppress repeat payment UI after initiation; reconcile by `merchantInvoiceId` (`payment-links.md`) |
| 23 | Non-refundable methods assumed refundable (Pay by Bank, Capitec Pay, Peach EFT, M-PESA, blink, MCB Juice, MauCAS, ZeroPay) | Check `methods-catalog.md` before promising refunds; manual EFT fallback |

## Low

| # | Edge | Fix |
|---|---|---|
| 24 | Multi-currency sandbox amounts other than 92.00 / 15.99 fail | Use the magic amounts (`testing-and-go-live.md`) |
| 25 | Cancelling a payment link expecting to reuse it | Cancel is irreversible; edits are impossible — generate fresh (`payment-links.md`) |
| 26 | Xero invoice numbers mangled (`INV-0003` → `0INV0003`) | Special chars stripped + zero-padded to 8 — match on the transformed value (`plugins/xero.md`) |
| 27 | Dashboard shows no record of a "declined" sandbox attempt | Some cancelled/declined sim codes never appear in the Dashboard — verify via API (`result-codes.md`) |
