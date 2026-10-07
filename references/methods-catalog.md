# Payment methods catalog (capability matrix)

Current scope: the [classic methods matrix](https://developer.peachpayments.com/docs/pp-payment-methods)
explicitly excludes Orchestration. Verify Orchestration at its
[payment-methods page](https://playground.peachpayments.com/operate/payment-methods).
PayJustNow changes below were checked on 2026-10-07; other rows retain their recorded provenance.

## When to load
Load for any "can method X do Y?" question: refunds (full/partial/none/one-only), recurring, country/currency, available surfaces, min/max limits, bank coverage. For per-method request parameters see `payments-api.md`; for test data see `testing-and-go-live.md`; for method-availability changelog flags see `payments-api.md`.

Surfaces legend: **Ch** Checkout (Embedded/Hosted) · **PA** Payments API v2 · **L** Payment Links · **PP** Payment Page · **Ext** platform extensions · **POS** Point of Sale. Method availability changes — ⚠️ version-sensitive, check the Peach changelog (recent example: Nedbank Direct EFT removed 2026-07-21).

Country/currency: SA=ZAR, KE=KES, MU=MUR; PayPal settles USD/GBP/EUR (Checkout `currency` enum: `ZAR, USD, KES, MUR, GBP, EUR`). Extensions expose the Checkout method set in all three countries; platform-specific method gaps live in the extension reference (e.g. Wix: one base currency only — ZAR base means no PayPal). BNPL instalment calculators (Payflex/ZeroPay/Float/Happy Pay/Mobicred) exist as per-extension storefront widgets, not API features.

## South Africa (ZAR)

| Method | Code (`paymentBrand`) | Surfaces | Refunds | Recurring | Limits / notes |
|---|---|---|---|---|---|
| Cards (Visa/MC/Amex/Diners) | on the card API / Checkout surfaces — **not** the Payments-API-v2 enum (the API "does not support card payments") `[DOCS]` | Ch, PA¹, L, PP, Ext, POS | Full + partial | Yes — tokenise (`createRegistration`) | DB/PA; PA capture via card API (7-day window) |
| PayShap | `PAYSHAP` | PA — despite `PAYSHAP` appearing in the Checkout `defaultPaymentMethod` enum, Checkout creation rejected it on an entity without PayShap (`Default payment method invalid for this request: PAYSHAP`) `[SANDBOX-VERIFIED 2026-09-08]` | **One refund per transaction only** — a partial refund blocks any later refund | No | Bank caps: Absa/Discovery/FNB R3,000; Nedbank R50,000; TymeBank R5,000. No African Bank/Capitec/Investec/Standard Bank. ShapID cellphone; banks enum: FNB/Discovery/Nedbank/TymeBank/Absa |
| Pay by Bank | (Checkout method, no v2 brand) | **Ch only** | **No refunds** | No | Bundle of Peach EFT + Capitec Pay + Absa Pay; Embedded + Hosted only. Customer's bank limit must cover the amount |
| Capitec Pay | `CAPITECPAY` | Ch, PA, L, PP, Ext, POS | **No refunds** | No | High-risk merchants: verified `IDNUMBER` only (customer can't edit); no passport option |
| Absa Pay | (via Pay by Bank / `PEACHEFT`) | Ch (Pay by Bank), PA (`PEACHEFT` array) | **No refunds** | No | High-risk PA form: `virtualAccount` array with `processor:ABSAEFT` + 13-digit ID |
| Peach EFT | `PEACHEFT` | **PA only** | **No refunds** | No | Banks: Absa, Nedbank, FNB, Standard Bank, Investec, Bidvest, African Bank. High-risk: Absa array form |
| Payflex (BNPL) | `PAYFLEX` | Ch, PA, L, PP, Ext | Full + partial | No | R10–R50,000. Sandbox: ID `9202190061088`, OTP `911911` |
| ZeroPay (BNPL) | `ZEROPAY` | Ch, PA, L, PP, Ext | **Not refundable** | No | Min R30. Sandbox: ID `9512235170089`, OTP `00000` |
| Float | `FLOAT` | Ch, PA, L, PP, Ext | Full + partial | No | R1–R99,000. Whole rands in sandbox |
| Happy Pay (BNPL) | `HAPPYPAY` | Ch, PA, L, PP, Ext | Full + partial | No | Sandbox registration: qa.happypay.co.za/register_test |
| PayJustNow (BNPL) | `PAYJUSTNOW` (Checkout webhook brand, not classic Payments API enum) | **Embedded + Hosted Checkout, POS**; Orchestration has its own catalogue | Full + partial per current classic matrix | No | Checkout requires `customer.email`; added 2026-10-01 |
| Scan to Pay (was Masterpass) | `MASTERPASS` | Ch, PA, L, PP, Ext | **Full refunds only** | No | **Not to debit cards.** Debit-card reversal ≤6h via Scan to Pay service; mTxId ≤45 chars |
| Apple Pay | (Checkout wallet) | Ch (Express + standard), Ext, Links, S2S/SDK | Full + partial | Wallets DB-only tokenisation (2026-08-27) | Merchant needs FNB/Nedbank/Std Bank account; domain-association file + support activation |
| Google Pay | (Checkout wallet) | Ch (Express + standard), Ext | Full + partial | Wallets DB-only tokenisation | Merchant needs Absa/FNB/Nedbank/Std Bank account + Google signup |
| Samsung Pay | (Checkout wallet) | Ch (Express + standard), Ext | Full + partial | Wallets DB-only tokenisation | Merchant needs Nedbank/Std Bank account. **Live only — no sandbox** |
| PayPal | `PAYPAL` | Ch Hosted, L, Ext, POS | Full + partial | No | USD/GBP/EUR (not ZAR); no Embedded Checkout |
| 1Voucher | `1FORYOU` | Ch, PA, L, PP, Ext | Refundable | No | Only synchronous Payments API method. `customer.mobile` required (voucher changes/refunds) |
| Mobicred (credit) | `MOBICRED` | Ch, PA, L, PP, Ext | Refundable | No | `virtualAccount.accountId` = email + password |
| RCS (store card) | `RCS` | Ch, PA, L, PP, Ext | Refundable | No | The only "card" accepted on Payments API (`card.number`) |
| A+ (Aplus) | `APLUS` | Ch, L, PP | (docs don't state) | No | **No Payments API** support |
| MoneyBadger (crypto) | `MONEYBADGER` | Ch, PA | Refundable, ≥R25, partial OK, **immediate** | No | Exchanges: BLN, Luno, VALR, Binance, Bybit, OKX. Refund fails `800.100.195` if customer gave no wallet at payment; refunded at current FX on ZAR price. **Live only — no sandbox** |

¹ Bank cards on Payments API: none — v2 PA has no bank-card brands; card S2S is the separate card API/COPYandPAY surface. RCS is a store card.

## Kenya (KES)

| Method | Code | Surfaces | Refunds | Recurring | Limits / notes |
|---|---|---|---|---|---|
| Visa/Mastercard | — | Ch, L, PP, Ext | Full + partial | Yes (tokenise) | KES + acquirer-side EUR/USD |
| Amex | — | Ch, L, PP, Ext | Full + partial | Yes (tokenise) | Equity Bank acquirer only |
| M-PESA | `MPESA` | Ch, PA, L, PP, Ext | **No refunds** | No | 12-digit phone; **integer amounts only** — Checkout auto-rounds a decimal up, but on the Payments API the caller must round (a decimal is rejected); sandbox via own account with 7-day auto-reversal |

## Mauritius (MUR)

| Method | Code | Surfaces | Refunds | Recurring | Limits / notes |
|---|---|---|---|---|---|
| Visa/MC/Amex/Diners | — | Ch, L, PP, Ext | Full + partial | Yes (tokenise) | EUR/USD acquirer-dependent |
| Apple Pay | (Checkout wallet) | Ch | Full + partial | Wallets DB-only | MCB / Absa Mauritius acquirers |
| blink by Emtel | `BLINKBYEMTEL` | Ch, PA, L, PP | **No refunds** | No | 8-digit phone |
| MCB Juice | `MCBJUICE` | Ch, PA, L, PP | **No refunds** | No | 8-digit phone |
| MauCAS QR | `MAUCAS` | Ch, PA, POS | **No refunds** | No | QR; POS-oriented |
| PayPal | `PAYPAL` | Hosted Ch, L, Ext, POS | Full + partial | No | USD/GBP/EUR; no Embedded Checkout |

For surface enums per API see below. Never hard-match brand strings across surfaces — names differ (e.g. `1FORYOU` vs "1Voucher", `MASTERPASS` vs "Scan to Pay", invoices differ again).

## Surface enum reference (verbatim)
- **Payments API v2 `paymentBrand`** (16): `PAYFLEX, ZEROPAY, 1FORYOU, MASTERPASS, MPESA, BLINKBYEMTEL, MOBICRED, CAPITECPAY, PEACHEFT, MCBJUICE, RCS, FLOAT, HAPPYPAY, MAUCAS, MONEYBADGER, PAYSHAP`.
- **Checkout `defaultPaymentMethod`** (24): `CARD, MASTERPASS, MOBICRED, MPESA, 1FORYOU, APLUS, PAYPAL, ZEROPAY, PAYFLEX, BLINKBYEMTEL, CAPITECPAY, PAYBYBANK, MCBJUICE, RCS, FLOAT, HAPPYPAY, APPLE PAY (literal space), GOOGLEPAY, SAMSUNGPAY, MAUCAS, MONEYBADGER, PAYSHAP, ABSAEFT` — with `forceDefaultMethod` (default false). Pay by Bank appears only here (`PAYBYBANK`), confirming its Checkout-only surface.
- Extensions expose "all Checkout methods" (per-platform quirks in the extension docs); Payment Links and Payment Page inherit the Checkout method set (Payment Page: default currency only).

## Sandbox availability (testing) — details in `testing-and-go-live.md`
| Method | Sandbox | Note |
|---|---|---|
| PayShap, Capitec Pay, Float, RCS, blink, MCB Juice, MauCAS | Yes | Payments API needs `customParameters[enableTestMode]:"true"`; Checkout doesn't |
| Payflex, ZeroPay, Happy Pay, Scan to Pay | Yes | Fixed test IDs/OTPs/card prefixes per method |
| Peach EFT (bank selector) | Yes | Use the **SIMULATOR** bank option |
| M-PESA | Yes | Via your own account; auto-reversal after 7 days |
| 1Voucher, Mobicred | Via support/partner credentials | No public test vouchers |
| Samsung Pay, MoneyBadger | **Live only** | No sandbox — plan a minimal live-value smoke test |

## Call-out rows (commonly missed)

Wallet acquirer requirements (merchant must bank where the wallet demands it):

| Wallet | Required acquiring relationship |
|---|---|
| Apple Pay | FNB / Nedbank / Standard Bank account |
| Google Pay | Absa / FNB / Nedbank / Standard Bank account + Google signup |
| Samsung Pay | Nedbank / Standard Bank account |

- **PayShap**: one refund per transaction only — partial refund forecloses the rest; per-bank caps (Absa/Discovery/FNB R3k, Nedbank R50k, TymeBank R5k) reject above-cap amounts; five participating banks only.
- **ZeroPay**: non-refundable — route any customer reimbursement manually (see below).
- **M-PESA**: non-refundable AND integer-only amounts — on the Payments API a decimal amount is
  rejected; on Checkout Peach rounds it up automatically. `[DOCS]`
- **MoneyBadger**: refund attempt fails `800.100.195` when the customer supplied no wallet address at payment time → collect wallet at payment or refund manually; refunds land immediately but at current FX on the ZAR price.
- **Pay by Bank**: Checkout-only (Embedded/Hosted), no refunds — it is a bundle, not a `paymentBrand` you can call from the Payments API.
- **Scan to Pay**: full refunds only; never partial; debit cards can't be refunded (≤6h debit reversal via Scan to Pay service instead).
- **Wallets (Apple/Google/Samsung Pay)**: require specific acquiring bank relationships (Apple: FNB/Nedbank/Std; Google: Absa/FNB/Nedbank/Std + Google signup; Samsung: Nedbank/Std) — refundable, but Samsung Pay has no sandbox.
- **PayPal**: never on Embedded Checkout; ZAR unsupported (USD/GBP/EUR).
- **Peach EFT / Capitec Pay / Absa Pay / blink / MCB Juice / MauCAS**: refund-incompatible by design — if the integration requires refunds on these, that's a design conflict to raise before build.

## Refund timing summary
| Method family | Shopper sees funds |
|---|---|
| Cards, BNPL (Payflex/ZeroPay/Float/Happy Pay) | ≤14 business days |
| MoneyBadger | Immediate |
| All other refundable methods | ≤30 days |
| Non-refundable methods | Manual EFT off-platform |

⚠️ version-sensitive — refund timing figures vary across Peach docs (3–10 working days Dashboard-speak vs 14 vs 30): present as ranges; the differences reflect bank reflection vs method processing time. Dashboard refunds: full/partial + reason, role-gated; refunds >6 months old require support. Some extensions can't issue API refunds at all (Wix, Ecwid, nopCommerce, OpenCart, Shopify-in-Shopify-dashboard) — there a "refund" means Peach Dashboard refund (where supported) + offline bookkeeping in the platform, or a payout (see `payouts.md`).

Refund endpoints by surface: Checkout-originated → Checkout refund endpoint (HMAC-signed V1, nested-JSON response); Payments-API-originated → `POST /payments/{uniqueId}` with `paymentType=RF` (see `payments-api.md`). Never refund across surfaces.

Non-refundable methods (ZeroPay, M-PESA, Peach EFT, Capitec Pay, Absa Pay, Pay by Bank, PayShap-after-first-refund, blink, MCB Juice, MauCAS, Scan to Pay partials): the only path is **manual EFT off-platform** — the integration should expose a reconciliation-friendly workflow for it (see `reconciliation.md`), and payouts can be the operational rail for it (see `payouts.md`).

## Method → required-params cross-pointer
Per-method request bodies for the Payments API (PayShap bank enum + phone format, Capitec type/accountId formats, PEACHEFT array form, M-PESA integer amounts, RCS card.number, shopperResultUrl-only methods) live in `payments-api.md`. Test data per method lives in `testing-and-go-live.md`.

## Refund-restriction matrix (fastest lookup)
| Restriction | Methods |
|---|---|
| Full + partial refunds | Cards, Payflex, Float, Happy Pay, Apple/Google/Samsung Pay, PayPal, 1Voucher, Mobicred, RCS, MoneyBadger (≥R25) |
| Full refunds only | Scan to Pay (`MASTERPASS`) |
| One refund per transaction (partial blocks the rest) | PayShap |
| PayJustNow | Embedded and Hosted Checkout plus POS; no classic Payments API brand |
| No API refund (skill summary of the docs' per-method ❌ Refunds cells — not a docs-quoted bucket) → manual EFT off-platform | ZeroPay, Peach EFT, Capitec Pay, Absa Pay, Pay by Bank, M-PESA, blink by Emtel, MCB Juice, MauCAS |

## Not callable on Payments API v2 (and what to use)
| Method | Why | Alternative surface |
|---|---|---|
| Bank cards (Visa/MC/Amex/Diners) | No card brands in the v2 enum | Checkout, card S2S (COPYandPAY), Mobile SDK |
| Apple/Google/Samsung Pay | Not in the Payments-API-v2 enum — S2S/OPPWA + Checkout surfaces only `[DOCS]` | Checkout (incl. Embedded Express), extensions |
| PayPal | Not in the v2 enum | Hosted Checkout, Links, extensions, POS |
| Pay by Bank | Checkout bundle, not a brand | Embedded/Hosted Checkout |
| PayJustNow | Not in the classic Payments API v2 enum | Embedded/Hosted Checkout, POS; verify Orchestration separately |
| A+ (APLUS) | No Payments API support | Checkout surfaces |

## Bank-coverage notes
- **Peach EFT** (`PEACHEFT`) covers: Absa, Nedbank, FNB, Standard Bank, Investec, Bidvest, African Bank.
- **Pay by Bank** = those Peach EFT banks **plus** Capitec Pay and Absa Pay, packaged for Embedded/Hosted Checkout.
- **PayShap** participating banks only: FNB, Discovery, Nedbank, TymeBank, Absa.

## Traps
- Promising refunds on a non-refundable method (ZeroPay/Peach EFT/Capitec Pay/M-PESA/Pay by Bank) → contract/UX failure discovered at first support ticket. Decide the manual-EFT path up front.
- PayShap partial refund then second refund attempt → rejected; one refund per transaction, ever.
- MoneyBadger refund with no stored wallet → `800.100.195` every time; not retriable via API.
- M-PESA `"199.99"` → on the Payments API the request fails (integers only); Checkout rounds it up
  to `"200"` automatically. Either way, show the shopper the rounded amount.
- Assuming ZAR works for PayPal → it doesn't (USD/GBP/EUR only).
- PayJustNow became available on Embedded/Hosted Checkout on 2026-10-01; older POS-only advice is stale.
- Hard-matching brand names across surfaces (docs, enums, invoices, extensions all differ) → map by capability, not by string.
- Wallet tokenisation ≠ card tokenisation: wallets are DB-only repeats since 2026-08-27; card registrations (`createRegistration`) carry Visa/MC/Amex/Diners only.
- High-risk merchant overrides (Capitec verified-ID, Absa PEACHEFT array) silently differ from the standard integration — confirm merchant risk class before finalising parameter validation.
- Amount limits are method-enforced, not API-enforced: Payflex R10–R50k, ZeroPay min R30, Float R1–R99k, PayShap per-bank caps — a value valid for one brand 400s on another; validate per selected brand before submitting.
- Shopify refunds happen in the Shopify dashboard, not Peach; Wix/Ecwid/nopCommerce/OpenCart plugins can't refund at all — don't build merchant expectations on plugin-level refunds.
- POS in this catalogue describes the broad product offering, not the REST/Intent method contract. Current integration guides cover South African Sunmi card payments; see `pos-integrations.md` before promising other countries or API-driven QR/PayByLink.
