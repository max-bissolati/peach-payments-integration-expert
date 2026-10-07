# Reconciliation, settlement, and billing

## When to load
Load for: "where is my money?" queries, matching transactions to settlements, settlement reports, the Recon API (query limits/response fields), per-acquirer settlement cadence, or billing/invoice questions (what gets billed when).

## Two offerings
1. **Dashboard reconciliation** — report pages in the Peach Dashboard. **Cards only**, and only for **Absa, FNB, Nedbank, Standard Bank** acquiring. Previous day's transactions available **by 09:30 next day**; monthly reconciliation is generated **automatically on the 1st**.
2. **Settlement reconciliation (Dashboard → Settlements)** — **all payment methods**; shows payout batches with status `Processing` / `Settled` (funds reflect in your account ~24 h after settlement). Groups by settlement batch with reference numbers. Match these batches against bank deposits via the settlement reference; the Recon API exposes the same joins per transaction.

ISO vs aggregation: if the merchant signed a merchant-account agreement directly with a bank (Absa/Nedbank/FNB), it's an **ISO** account settled by that bank. Otherwise it's a **Peach aggregation** account, settled by Peach. Don't mix the cadences when answering "when will I be paid".

Don't promise either to non-Absa/FNB/Nedbank/Std card merchants for card-level recon — that's what the Recon API below is for.

## Recon API
- Hosts: live `https://reconciliation.peachpayments.com`, sandbox `https://sandbox-reconciliation.ppay.io`.
- Auth: OAuth bearer — `POST https://dashboard.peachpayments.com/api/oauth/token` (sandbox `https://sandbox-dashboard.peachpayments.com/api/oauth/token`) with `{clientId, clientSecret, merchantId}`. **Token comes from the DASHBOARD host, not the recon host** (a common port-over mistake).
- Endpoint: `GET /api/merchants/{merchantId}/transactions-recon`.

Query parameters:

| Param | Rule |
|---|---|
| `startDate` | ISO-8601, **inclusive**. If no timezone in the string, **UTC+2 is assumed** (per the API reference — bare `startDate=2024-03-14` becomes `2024-03-13T22:00:00.000Z`). ⚠️ Peach's own prose recon guide contradicts this and says the default is UTC — so never rely on the bare-date default; pass an explicit offset in the query string, URL-encoding `+` as `%2B`. `[DOCS]` |
| `endDate` | ISO-8601, **exclusive**. Same timezone rule. |
| `isSuccessful` | optional boolean filter |
| `paymentMethod` | optional: `bnpl` \| `card` \| `eft` |
| `batchNumber` | optional, 1–5 digits (`^\d{1,5}$`) |
| `settlementReference` | optional |
| (headers) | gzip accepted |

**Hard limits (enforced):**

| Limit | Value |
|---|---|
| Rate | **1 request/second** |
| Window | **≤ 24 h per request** — page across days, never weeks |
| History | **No data before 2023-01-01** |
| Aggregation lag | **Settlement data up to 3 business days late** for Peach-settled (aggregation) accounts; ISO accounts unaffected |

```bash runnable
curl "https://reconciliation.peachpayments.com/api/merchants/{merchantId}/transactions-recon?startDate=2026-03-14T00:00:00.000%2B02:00&endDate=2026-03-15T00:00:00.000%2B02:00" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Response fields worth using (NOTE: the documented response does **not** include `merchantTransactionId` — join recon rows to your orders via `uniqueId`/`transactionId`, which you must store at fulfilment time from `/status` or the success webhook): `batchNumber`, `uniqueId`, `transactionId`, card `last4`/`bin`, `paymentType`/`paymentMethod`/`paymentBrand`/`cardType`, credit/debit, **`amount` (includes `tipAmount`)**, **`settledAmount`** (what actually settled, net of adjustments — ⚠️ Peach-settled/aggregation accounts ONLY; **direct-settled (ISO) accounts have no `settledAmount` and reconcile on `amount`**), `settlementStatus`, **`settlementReference`** (provider settlement reference; bank description can be customized), `peachResult` (**status enum** `successful|failed|cancelled|pending` per the OpenAPI schema — NOT the numeric result code; numeric codes come from `/status`/webhooks), `rrn`. `tipAmount` was added 2026-06-30 for POS merchants and is `null` when not applicable.

**Response envelope + paging**: the documented response is a **flat JSON array** of transaction objects
(no `data`/`meta` wrapper), and errors come back as `{ "message": "...", "errors": { "<field>": ["..."] } }`
— parse that, don't assume a bare string. `[DOCS]` The documented shape and parameter list show **no
pagination mechanism** (no `cursor`/`page`/`limit`/`offset`/`next`), so you page by DATE WINDOW: walk
`startDate`/`endDate` in ≤24 h steps (both required, ISO-8601), respecting the 1 req/s rate limit —
but confirm a large single window isn't server-capped in your sandbox `[VERIFY-SANDBOX]`. Optional
filters narrow a window: `isSuccessful` (boolean), `paymentMethod` (card/eft/bnpl), `batchNumber`
(`^\d{1,5}$`), `settlementReference` (`PEACH-NNN-DDMMYYYY`). `[DOCS]`

```json illustrative
{
  "batchNumber": "305",
  "uniqueId": "00000000000000000000000000000aa1",
  "transactionId": "…",
  "last4Digits": "0091", "bin": "420000",
  "paymentType": "DB", "paymentMethod": "card", "paymentBrand": "VISA",
  "credit": "0", "debit": "100.00",
  "amount": "100.00", "tipAmount": "0.00",
  "settledAmount": "97.50",
  "settlementStatus": "Settled",
  "settlementReference": "…",
  "peachResult": "successful", "rrn": "…"
}
```

Match flow: query per 24-h window (≤1 req/s) → group by `batchNumber`/`settlementReference` → compare `settledAmount` against your bank deposit lines. Peach publishes a public Postman workspace with a ready-made `transactions-recon` request — use it to sanity-check auth and timezone handling before writing your own client.

## Settlement cadence (ISO — direct merchant accounts)
| Acquirer | Cadence | Delay | Bank-statement marker |
|---|---|---|---|
| Nedbank | Daily, net (today's sales − refunds) | ~1 business day | `Nedlink DP <merchant number>` e.g. `Nedlink DP 2552555` |
| Absa | Daily **except Monday** | ~2 business days | — |
| FNB | Daily | ~2 business days | — |

Aggregation (Peach-settled) merchants: free net daily — Mon–Thu settlements pay out **next day**; Fri–Sun settlements pay out **Monday**. Peach may withhold settlement (outstanding FICA docs, suspected fraud, chargeback disputes, volume spikes, incomplete verification, outstanding fees).

⚠️ version-sensitive — settlement figures drift with acquirer contracts; treat the table as the docs' baseline, not a guarantee.

## Standard Bank batch-number trap
**Standard Bank sends `00001` as the batch number for every batch.** It does not match your deposit references, so `batchNumber`-based matching is useless for Standard Bank — reconcile Standard Bank deposits via `settlementReference` and date/amount instead. (Peach is working with Standard Bank to fix; re-check before building on it.)

## Billing
- Invoices are issued in the **first 4 business days** of the month and are **due on the 10th**.
- Line-item statuses: `ACK` (transaction acknowledged complete by the payment method), `NOK` (not acknowledged), `SDV` (Same Day Value EFT).
- **What's billed when:**
  - Card payments + PayPal: transaction fees on **both `ACK` and `NOK`**.
  - All other payment methods: **`ACK` only**.
  - Payouts: billed for **successful** payouts **and** payouts ending in result codes **`2000`–`2899`** (typically wrong bank details / bank-account issues — merchant- or customer-caused). Failed payouts still cost money.
- Fee categories: monthly fees (provisioning, tokenisation), acceptance fees (% of value), transaction fees (per count; some providers add their own on top, e.g. Payflex R4.00 + Peach R1.50 style line items).
- Invoice quirks: invoice names differ from method names (Masterpass→Scan to Pay, 1ForYou→1Voucher); Apple Pay always processes without 3DS; SMS/other services billed only if used; quantity is volume- or value-based (a %-unit price means quantity = monetary value).

## Disputes and chargebacks

> Source: OPPWA backoffice docs — S2S-era surface; the Dashboard's dispute tooling isn't publicly documented and may differ — confirm current dispute handling with Peach support.

**Detection:** an incoming dispute surfaces as a `000.100.2xx` result code — the chargeback/reversal family (`000.100.200`–`234` + `000.100.299` per `result-codes.md`). There is no dedicated dispute feed documented.

The backoffice/chargebacks docs document four Server-to-Server REST operations, all `POST /payments/{id}` on the card facade, each referencing the prior payment's `payment.id`:

| Operation | `paymentType` | Performed against | Docs describe it as |
|---|---|---|---|
| Chargeback (CB) | `CB` | previous capture (`CP`) or debit (`DB`) | acquirer↔issuer fund transfer; **issuer initiates** |
| Chargeback reversal | `CR` | previous chargeback payment | funds debited from merchant return to merchant |
| Representment | `CR` | previous **chargeback reversal** payment | issuer↔acquirer fund transfer; **acquirer initiates** |
| Representment reversal | `CR` | previous representment payment | acquirer↔issuer fund transfer |

- Chargebacks can be full or partial (where supported, the `amount` field controls it); **multiple chargeback requests against the same payment type are not allowed**. Representment can also be full or partial.
- The chargeback request carries a `chargebackResultCode` field (docs sample: `000.100.200`); "you can use any of these chargeback result codes" links to the Dashboard response-codes page's chargebacks section.
- Framing per the docs: the **merchant records** the chargeback and its reason "as received from the bank" — i.e. these endpoints record and contest chargebacks you already know about, they are **not** an inbound notification mechanism.
- Contesting: the merchant "can contest the legitimacy of the original transaction by presenting evidence such as receipts and delivery confirmations"; if the issuing bank rules in the merchant's favour after reviewing the evidence, the chargeback reverses. Per the backoffice guide: "representment challenges a chargeback, and a chargeback reversal is one possible outcome."
- Fees persist: even after a chargeback **reversal**, the merchant still incurs the chargeback fee and the transaction still counts toward the merchant's chargeback ratio.
- Refund vs dispute: a **refund** is merchant-initiated post-settlement (damaged goods, wrong amount, change of mind — see the Refund section above); a **chargeback** is funds reversed from the merchant's account into the customer's account because the customer disputed the charge with their bank. Different initiator, different fee profile.
- Ordering contradiction between the two pages: the chargebacks page says representment is performed against a previous *chargeback reversal* payment, while the backoffice guide says the reversal happens *after* representment succeeds. The docs are internally inconsistent and it isn't resolvable from public sources — treat the exact ordering as unspecified and confirm with Peach support if it matters.
- Not documented in these sources (do not guess): inbound dispute/chargeback notifications or webhooks, an evidence-submission endpoint/workflow, and dispute timeframes/deadlines. The backoffice guide's intro also names "rebills, and credits" among manageable operations, but the page only documents reversal, capture, refund, and chargeback. Detect dispute state via result codes on queried transactions and webhooks (`result-codes.md`, `webhooks.md`); confirm Dashboard-side dispute tooling with Peach support.

## Settlement models — aggregation vs direct (ISO), defined

- **Aggregation (Peach-settled)**: Peach collects and settles net to you daily (Mon–Thu payments →
  next business day; Fri–Sun → Monday); settlement data in the recon API can lag up to 3 business
  days. Payouts-float auto-funding is available to aggregation merchants.
- **Direct / ISO**: you hold the acquirer agreement; the acquirer settles on its own cadence
  (Nedbank ~1 business day, Absa daily-except-Monday ~2, FNB ~2) and batch numbers come from the
  bank (Standard Bank sends `00001` for every batch).
Which model you're on is decided at account setup — ask Peach. It changes settlement timing and
payout-funding behaviour, and auditors will ask.

## Traps
- Querying a >24 h window or >1 req/s → rejected; build a day-by-day paged fetch with throttling, not one big range.
- Querying before 2023-01-01 → no data, silently empty.
- Assuming query dates are UTC: the API reference assumes **UTC+2** for a bare date (a bare `endDate` of the 15th resolves to the 14th 22:00Z, excluding 00:00–02:00 SAST of the 15th) — yet Peach's prose recon guide says UTC. The two public docs contradict each other, so always send explicit timezone offsets, URL-encoding `+`.
- Standard Bank recon keyed on `batchNumber` → everything maps to `00001`; use `settlementReference` + amounts.
- Reconciling `amount` instead of `settledAmount` (on an aggregation account) → cents off wherever tips/fees adjust the settled value (`amount` includes `tipAmount`); on ISO/direct accounts the reverse — `settledAmount` doesn't apply, use `amount`.
- Expecting same-day recon data for aggregation accounts (up to 3 business days lag) → false "missing transaction" alarms on Mondays.
- Budgeting payouts without the failed-payout fee: `2000`–`2899` outcomes are billed even though money returned to float.
- Treating `NOK` as "not billed" for cards/PayPal — they bill on both `ACK` and `NOK`.
- Dashboard recon assumed for all methods — it's cards-only and 4 acquirers only; everything else goes through Settlements pages or the Recon API.
- Treating the S2S `CB`/`CR` endpoints as a dispute feed — they only record/contest chargebacks you already know about; incoming disputes reach you via `000.100.2xx` codes and webhooks, and the evidence workflow/timeframes are undocumented (see `Disputes and chargebacks` above) — coordinate disputes with Peach support.

## Current Dashboard qualifications

The current Orchestration Dashboard supports a custom settlement deposit reference. Do not assume
API `settlementReference` always equals the bank statement description; match using merchant,
settlement data, date and amount as well. [Settings](https://playground.peachpayments.com/docs/dashboard-settings).

Billing docs disagree in scope: the classic developer guide explicitly bills cards and PayPal on
both ACK and NOK, while the current Orchestration settlement guide says cards on ACK/NOK and other
methods on ACK only. Preserve the product distinction and confirm PayPal billing under the merchant's
actual agreement; do not silently apply one page's rule to every account.
[Orchestration settlement and billing](https://playground.peachpayments.com/docs/settlement-and-billing).
These qualifications were checked on 2026-10-07.

## POS correlation

For terminal payments, keep the POS transaction UUID used for refunds separate from your order
reference. POS guides say `posData.merchantTransactionId` appears in Reconciliation API
`transactionId`; the generic recon schema's hex-style description does not justify rejecting
non-hex order references. Use explicit timezone offsets and verify the actual UAT records.
See `pos-integrations.md` for webhook, polling and fallback recovery.
