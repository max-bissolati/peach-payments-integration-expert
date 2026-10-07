# Testing and Go Live

## When to load
Load for sandbox setup, test data selection, pre-launch checks, and any "going live" question. The verification gate (§5) is the definition of done for any integration task.

For POS, use `pos-integrations.md` and `pos-expo-sunmi.md`: Mock Payment App tests, provisioned
UAT terminals, round/non-round amount cases, then actual hardware acceptance. Online card test
numbers and the scripts' online profiles do not establish POS readiness.

## 1. Sandbox

- **Access**: sign up, or the **Sandbox** button in the live Dashboard (`sandbox-dashboard.peachpayments.com`). Available soon after signup; live access follows Peach risk approval. All credentials live in the sandbox Dashboard.
- **Capabilities**: fake money; card methods auto-configured; view sandbox transactions + webhooks in the sandbox Dashboard.
- **Limitations**:
  - Payment Links sandbox is **email-only** (no SMS/WhatsApp).
  - **Wix and Xero have no sandbox at all**; Take App is live-only.
  - Multi-currency (non-ZAR) testing: transactions only succeed with amounts **92.00** or **15.99**.
  - WooCommerce / Gravity Forms plugins use the **"Integrator Test"** transaction mode. Auto-approval of 3DS in that mode is observed in sandbox testing, not doc-stated — verify challenge flows in your own sandbox before relying on it. `[VERIFY-SANDBOX]`
  - Bank selectors expose a **SIMULATOR** bank option — use it for EFT/bank scenarios.
  - `enableTestMode` rule: Payments API tests of PayShap, Capitec Pay, Float, RCS, blink by Emtel, MCB Juice, MauCAS need `"customParameters[enableTestMode]":"true"`; **Checkout does not**.

For classic Checkout PayJustNow, send `customer.email`, create a sandbox PayJustNow account,
and use accessible email/phone for verification and SMS OTP. Pay with the documented test cards.
[Source, checked 2026-10-07](https://developer.peachpayments.com/docs/reference-test-and-go-live#payjustnow).

For Orchestration ZeroPay testing, current testing guidance uses R30 (`3000` minor units),
instalments without cents, ID/OTP steps and then a standard test card. Keep this separate from
classic API amount formatting. [Source](https://playground.peachpayments.com/docs/testing).

## 2. Card test data

All cards: CVV any 3 digits (Amex 4); expiry any future date; cards simulate successful transactions unless stated. Zero-amount PA testing: use the 3DS2 cards.

### 3-D Secure 2

| Scenario | Returns method data | Visa | Mastercard | Maestro | Amex | Result |
|---|---|---|---|---|---|---|
| Frictionless | Yes | `4200000000000091` | `5200000000000007` | `6761301000993772` | `374500262001008` | Success (Visa ECI 05, MC ECI 02, Status Y) |
| Frictionless (attempt) | Yes | `4200000000000109` | `5200000000000023` | `6706981111111113` | `377277081382243` | Attempt (ECI 06/01, Status A) |
| Frictionless | No | `4200000000000026` | `5200000000000056` | `6799851000000032` | `375987000000062` | Success frictionless |
| Frictionless (attempt) | No | `4200000000000059` | `5200000000000106` | `6007930123456780` | `373953192351004` | Attempt (ECI 06/01, Status A) |
| Error (technical) | No | `4012001037461114` | `5434580000000006` | `6761301000941201` | `375987000169875` | Technical error (no ECI, Status U) |
| Error (not enrolled) | No | `4012001037141112` | `5457350076543210` | `6761301000946341` | `375987000169883` | User not enrolled (ECI 06/01, Status N) |
| Error (not participating) | n/a | `4532497088771651` | `5497260847316287` | `6761257707836567` | `343923092050144` | Card not participating |
| Challenge (pass) | Yes | `4200000000000042` | `5200000000000015` | `6799998900000060018` | `343434343434343` | Determined by challenge |
| Challenge (pass) | Yes | `4200000000000067` | `5200000000000049` | `6773670009114879` | `375987000000021` | Determined by challenge |
| Challenge (fail) | No | `4200000000000018` | `5200000000000064` | `67034200554565015` | `375987000169867` | Determined by challenge |
| Challenge (fail) | No | `4200000000000075` | `5200000000000072` | `6759888888888888` | `371449635398431` | Determined by challenge |

### 3-D Secure 1

| Scheme | Card | 3DS |
|---|---|---|
| Visa | `4711100000000000` | Enabled |
| Visa | `4012888888881881` | Enabled |
| Visa | `4111111111111111` | Simulates external mode |
| Visa | `4200000000000000` / `4242424242424242` | Disabled |
| Mastercard | `5212345678901234` | Enabled |
| Mastercard | `5105105105105100` / `5454545454545454` | Disabled |
| Amex | `375987000000005` | Enabled |
| Amex | `377777777777770` | Disabled |
| Diners | `30082246403846` | Disabled |

### Network tokens (expiry-keyed — any PAN)

Expiry xx/**2031** valid (ACTIVE after ~2s) · **2032** not eligible · **2033** issuer unsupported · **2034** lifecycle ACTIVE→SUSPENDED→ACTIVE→DELETED (~3s) · **2035** card update · **2036** can't tokenise · **2041** invalid state cycle. UAT BINs: Visa `462294`, Mastercard `512345`, Amex `371732`.

### 3DS forcing parameters

`customParameters[3DS2_enrolled]=true` · `customParameters[3DS2_flow]=challenge|frictionless` · `threeDSecure.challengeIndicator=4`. Cards not in the simulator roster return `000.400.109`.

## 3. Method simulators

**enableTestMode `"true"` = Payments API only (not Checkout) for: PayShap, Capitec Pay, Float, RCS, blink, MCB Juice, MauCAS.**

| Method | Test data → expected result |
|---|---|
| **PayShap** | `+27-711111200` → `000.100.110` success · `+27-711111160` → `100.396.101` declined (invisible in Dashboard) · `+27-711111140` → `100.396.104` expired · `+27-711111107` → `900.100.100` connector error. `virtualAccount.bank`: FIRSTNATIONALBANK/DISCOVERYBANK/NEDBANK/TYMEBANK/ABSABANK |
| **Capitec Pay** | ID `1111111111214` → success `000.100.110` sandbox / `000.000.000` live · `…106` not registered `000.400.102` · `…109` limit `800.100.162` · `…190` consent created `000.200.000` · `…137` declined `100.396.101` · `…138` timeout `100.380.501` · `…139` failed `800.100.100` · `…140` fraud `000.100.220` (use the documented test IDs as-is) |
| **Pay by Bank / Peach EFT / Absa Pay** | Bank selector → **SIMULATOR** → pick outcome |
| **Payflex** | Must be allowlisted by Payflex first; R10–R50 000. Account: real email (OTP), any password/name, ID `9202190061088`, phone `0123456789`, OTP `911911`, card `5181030000183696` CVV `576` exp `01/28` |
| **ZeroPay** | ID `9512235170089`, OTP `00000`, amount ≥ R30 |
| **Float** | enableTestMode (PA). Card `5200000000000023`, any CVV, future expiry; **whole-rand amounts** (R60 divides evenly across 2–6 instalments) |
| **Happy Pay** | Create test account at `qa.happypay.co.za/register_test`; any 4-digit code; **PAY IN INSTALMENTS** → **Simulate Card**. One active instalment per account — multiple accounts for multiple scenarios |
| **Scan to Pay** | `merchantTransactionId` ≤ 45 chars. Debit prefixes: `50010001000105`→`00` success · `50010001000101`→`51` insufficient · `50020001000103`→`91` issuer failure. Credit: `50020001000105` success · `50020001000101` insufficient · `50020001000103` failure. Don't close the browser after paying |
| **RCS** | enableTestMode (PA). Card `6010240000000000000`; amount-coded: `1.00`→`000.100.110` · `0.75`/`0.80`→`100.396.101` · `1.15`→`900.100.100` |
| **blink by Emtel** | enableTestMode (PA). Requests: `51111213`→`200.100.501` · `51111215`→`000.200.000` · `51111206`→`900.300.600`. Status: `51111322`→`800.100.203` insufficient · `51100000`→`000.100.110` success (let confirmation expire) |
| **MCB Juice** | enableTestMode (PA). `1.25`→`100.380.501` consent expired · `1.40`→`900.100.201` error. **Success not testable end-to-end** |
| **MauCAS** | enableTestMode (PA). `16.40`→`000.200.000` pending→success after 5 min · `15.40`→`600.100.100` · `16.30`→`900.100.100` · `25.00`→`800.100.152` failed (30–90s) · `25.10`→`000.000.000` success (30–90s) |
| **Apple / Google Pay** | Apple: developer sandbox cards from Apple; Google: pick scenario card in the sheet. Neither on Payments API |
| **Samsung Pay / MoneyBadger** | **Live-only** — no sandbox |
| **1Voucher / Mobicred** | Test vouchers from Peach support / credentials from Mobicred |
| **M-PESA** | Your own account; M-PESA auto-reverses in 7 days |
| **Payouts** | Test bank accounts below (R10+, `realtime-eft`, mind your float) |

### Orchestration sandbox — amount-based error simulation

Orchestration (`orchestration-api.md`) has its own sandbox model, separate from the Checkout/Payments-API
simulators above. `[DOCS docs/testing]`

- **Acquirer-error simulation**: the **last two digits of the amount in minor units** become the ISO 8583
  field-39 acquirer return code — `1051` (R10.51) → `51` insufficient funds; `…00` = success. Availability
  is per acquiring bank (ask Peach support to enable it). These acquirer codes are **not** Peach result
  codes (`result-codes.md`); a failed payment can carry both.
- **Special amounts**: `9994` STAN echo mismatch · `9967` request/response STAN mismatch · `9999`
  timeout/uncertain · `9900` no trace-ID returned. Use for reconciliation / retry / timeout testing.
- **Merchant Advice Code**: a `1234.XX` display amount (`123403` = R1234.03) returns MAC `03` (Visa
  `ORIGINAL_RESPONSE_CODE` / Mastercard `MERCHANT_ADVICE_CODE`) — test issuer retry-guidance handling.
- **CIT/COF trace-ID simulation**: an initial CIT/COF request returns hardcoded scheme trace IDs
  (Mastercard `BANKNET_REF_NR`+`BANKNET_DATE`, Visa `TRANSACTION_ID`, Amex `GLOBE:ACQUIRERREFERENCEDATATID`,
  Diners `SCHEME_REFERENCE_DATA`) so you can validate the subsequent MIT.
- **Per-APM sandbox credentials + result codes** for the Orchestration methods (PayShap, Capitec Pay,
  Payflex, ZeroPay, Float, Happy Pay, PayJustNow, Scan to Pay, RCS, blink by Emtel, MCB Juice, MauCAS,
  M-PESA) are on the Orchestration testing page; Samsung Pay and MoneyBadger are live-only. M-PESA is tested
  with your own account (auto-reverses in 7 days).

## 4. Payouts + BANV test accounts (sandbox)

All `realtime-eft`, account holder "Test Account Holder", values R10+:

| Bank | Account | Branch | Payout | BANV result |
|---|---|---|---|---|
| Absa | `4047594620` | `632005` | ✅ | All match (`4045972046` also all match) |
| Bidvest Bank Alliances | `30000162885` | `683000` | ✅ | Partial match |
| Discovery Bank | `10503060072` | `679000` | ✅ | Partial match |
| Nedbank | `1012546144` | `198765` | ✅ | **No match** |
| Old Mutual Bank | `21383368760` | `352000` | ✅ | All match |
| TymeBank | `51000347387` | `678910` | ✅ | **No match** |

(Additional Discovery/Old Mutual/TymeBank numbers exist in the docs table; the pairs above cover every BANV outcome class.)

## 5. Verification gate — run before declaring ANY integration done

Produce a fill-in PASS/FAIL report. A FAIL on any row blocks "done".

```
## Peach integration verification report

1. Sandbox E2E: checkout created → test card per scenario → redirect/event
   received → GET /v2/checkout/{id}/status verified → order state correct.
   [ PASS / FAIL ] Evidence: <scenarios run + result codes + order states>
   Scenarios minimum: success (000.100.110), decline (challenge-fail card),
   pending/uncertain, cancelled.
2. Webhook: signature verified against a REAL payload (scripts/verify-webhook.js);
   tampered payload rejected; replayed payload fails closed.
   [ PASS / FAIL ] Evidence: <verifier output>
3. Result-code mapping: success / decline / pending / 3DS-decline matrix
   exercised; no fail-open paths (intermediate 000.400.101/102 NOT treated
   as success). [ PASS / FAIL ] Evidence: <codes → mapped states>
4. Amount integrity: paid amount == created amount enforced (fail closed on
   mismatch or missing amount). [ PASS / FAIL ] Evidence: <mismatch test>
5. Refund path tested, including a DECLINED refund — assert result.code,
   never HTTP status (Peach returns 200 for declines). [ PASS / FAIL ]
   Evidence: <refund id/codes>
6. Secrets scan clean (no creds in code/logs); allowlist configured;
   CSP present if custom UI. [ PASS / FAIL ] Evidence: <grep output/config>
   Run `node scripts/check-integration.js <your integration paths>` — 0 FAIL
   findings (raw-body destruction, cents/major-unit, dot-key, frontend secret,
   token mixups); triage every WARN. [ PASS / FAIL ] Evidence: <linter output>
7. Live-swap plan documented (creds + endpoints per product) + owner-run live
   test defined. [ PASS / FAIL ] Evidence: <plan link/owner name>
```

**Peach documents no verification checklist** — the documented go-live procedure is only a credential + endpoint swap. This gate is the quality bar; walk it every time.

## 6. Go-live

Documented procedure: when sandbox testing passes, **swap to live credentials and live endpoints**. Account activation happens at signup via Peach risk; extensions additionally need an activation review. Nothing else is published as an audit step.

| Product | Sandbox | Live |
|---|---|---|
| Auth (OAuth) | `sandbox-dashboard.peachpayments.com` | `dashboard.peachpayments.com` |
| Checkout API | `testsecure.peachpayments.com` | `secure.peachpayments.com` |
| Embedded SDK script | `sandbox-checkout.peachpayments.com/js/checkout.js` | `checkout.peachpayments.com/js/checkout.js` |
| Orchestration API + Web SDK | `app.sandbox-next.peachpayments.com` | `app.next.peachpayments.com` |
| V1 refund / card facade | `testapi.peachpayments.com` / `sandbox-card.peachpayments.com/v1` | `api.peachpayments.com` / `card.peachpayments.com/v1` |
| Payment Links API | `https://sandbox-l.ppay.io` | `https://links.peachpayments.com` |
| Payments API v2 | `https://testapi-v2.peachpayments.com` | `https://api-v2.peachpayments.com` |
| Payouts | `sandbox-payouts.peachpayments.com` | `payouts.peachpayments.com` |
| Reconciliation | `sandbox-reconciliation.ppay.io` | `reconciliation.peachpayments.com` |

Runbook + platform notes: `playbooks/go-live.md`.

## 7. Live-test doctrine

- **Never fire automated live charges** from examples, tests, or agent tooling. Live money movement is owner-run, deliberate, single-shot.
- Owner-run options `[PLUGIN-VERIFIED]`: **PA (pre-auth) + void/reverse** via the card facade, or a **small real charge + immediate refund**.
- Pre-authorisation note: PA must be captured within 7 days or it expires uncaptured (uncaptured PA never settles) — a voided/expired PA is the cleanest live test.
- Validate credentials without a real charge via the **PA + reverse** zero-settlement pattern (`recurring-and-tokenisation.md`) — there is no separate Dashboard "test checkout" tool.

## Traps
- `000.400.101` / `000.400.102` are NOT success — intermediate 3DS/risk codes; only terminal `000.100.1*` / `000.000.*` mean captured. `[PLUGIN-VERIFIED]`
- Multi-currency sandbox amounts other than 92.00 / 15.99 will "mysteriously" fail.
- Integrator Test Mode auto-approves 3DS — you cannot test challenge flows while it's on; don't report 3DS as "tested" from that mode.
- PayShap declined/expired codes (`100.396.101/104`) don't appear in the Dashboard — absent from Dashboard ≠ absent from reality.
- Declined refund returning **HTTP 200** — branch on `result.code` or you'll report failure as success. `[PLUGIN-VERIFIED]`
- Testing card payments on Payments API — cards don't exist there (RCS store-card exception); cards are Checkout/card-facade surfaces.
- Assuming Wix/Xero/Take App can be sandbox-tested — they can't; plan their live validation extra carefully.
- MoneyBadger and Samsung Pay have no sandbox path — don't promise sandbox coverage.
- Marking refund "tested" with only a success case — the declined-refund case is what catches the HTTP-200 trap.
