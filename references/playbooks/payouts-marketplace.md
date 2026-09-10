# Payouts Marketplace Playbook

## When to load
Load when paying out drivers, sellers, suppliers, or partners — marketplace disbursements, earnings withdrawals, refunds-by-EFT. Payouts are **irreversible**: treat every step as a write-gated operation.

## The sequence

```
1. Activate product + source of funds   →  Dashboard + support
2. Fund the float                       →  deposit with unique reference, ~2h cadence
3. BANV each new bank account           →  verify before first payout
4. Create payouts                       →  cents, UUID payoutId, idempotency
5. Svix-signed webhooks                 →  track state transitions
6. Proofs + reconciliation loop         →  PDFs, reports, balance checks
```

### 1. Activation
- SA businesses; Dashboard activation **plus a source-of-funds document** (support). Do this before promising payout timelines.
- Optional: **IP allowlisting** on create-payout (opt-in via support; IPv4/CIDR; IPv6 rejected; 403 `2900.005.002` when blocked).

### 2. Fund the float
- Deposit to the payouts account with the **unique deposit reference**; processed every 2h; RTC lands 1–3h, standard EFT ≤2 business days.
- No PayShap / TymeBank Everyday deposits. Aggregation merchants can auto-fund from settlements (toggle before 08:00).
- Check `GET /balance` (cents) before every batch — `2900.002.001` = insufficient float.

### 3. BANV new accounts (before first payout)
`POST /merchants/{merchantId}/banv` — accountNumber ≤13 digits, accountType enum, branchCode, idNumber, initials, lastName. Hours **03:00–23:00**, ~14 banks. Sandbox outcome classes: Absa `4047594620` all-match · Nedbank `1012546144` no-match · full table `../testing-and-go-live.md` §4. Gate payouts on a BANV pass; store the result with the payee record.

### 4. Create payouts
`POST https://payouts.peachpayments.com/merchants/{merchantId}/payouts` with `{"payouts":[…]}` (sandbox `sandbox-payouts…`). Request shape (illustrative — values from the sandbox test table):

```json
{ "payoutId": "<UUIDv4 — your idempotency key>",
  "currency": "ZAR",
  "amount": 150000,
  "accountNumber": "4047594620", "branchCode": "632005",
  "bankName": "ABSA", "accountHolder": "Test Account Holder",
  "reference": "INV 123", "payoutMethod": "realtime-eft",
  "merchantReference": "driver-week-36",
  "proofOfPayment": { "to": ["payee@example.com"] } }
```

- **Amount is IN CENTS** — `150000` = R1500.00. Mixing with the major-unit convention used everywhere else in Peach is a 100× error. Min 1000 (R10), max 500000000.
- `payoutId` (UUIDv4) must be **UNIQUE per request — duplicates are rejected (`2900.003.002`)**, so it is NOT a retry-reuse key. Idempotency = query the submitted payoutId's status BEFORE resubmitting; a real resubmit gets a NEW payoutId, with `merchantReference` tying it to the logical payout.
- `branchCode`: **always a universal branch code** (Absa 632005, FNB 250655, Nedbank 198765, Std 051001, Capitec 470010, TymeBank 678910 — full table `../payouts.md`).
- `reference` 1–20 alnum/space; `bankName` from the docs enum (STANDARD BANK, NEDBANK, FNB, ABSA, CAPITEC BANK, DISCOVERY BANK, TYMEBANK, INVESTEC BANK LIMITED, BIDVEST BANK, AFRICAN BANK, +~15 more).
- Unsupported destinations: no Capitec Live Better; no TymeBank `53…` SME accounts.
- Bulk alternative: XLSX to `/payouts/upload` (columns: currency, bankName, payoutMethod, amount, accountNumber, branchCode, reference, accountHolder + notifyEmail/merchantReference).

### 5. Webhooks (Svix-signed)
Headers `webhook-id`/`webhook-timestamp` (+ signature) — verify with **Svix libraries**; secret from support; 30-day retry. States: `pending → processing → successful | failed | cancelled | reversed`. Treat webhooks as wake-up calls; confirm via list/balance where money decisions follow.

### 6. Proofs + recon loop
- **Proofs of payment**: PDF, success only, downloadable/emailable ≤30min after completion.
- Reports: transaction + statement CSVs; `GET /balance` for float position; list endpoint has a **<3-month window** — archive beyond that.
- Recon loop: match webhook state → proof → settlement statement; failed payouts return value to float (minus fee — see below).

## Failure handling

- **Failed payouts incur fees AND return the value to the float** — model both in the ledger; a failed payout is not free and not lost.
- State machine: `pending → processing → successful | failed | cancelled | reversed`. Idempotent retry uses the SAME `payoutId`; a changed payee account gets a NEW payoutId after re-BANV.
- **RTC dark-hours limits**: business hours 00:00–16:00 cap R5M; 16:00–00:00 + weekends/holidays cap R250k — schedule large runs inside business hours.
- Result-code families (4-digit first group): `001` technical, `002` processing (`2900.000.003`), `003` invalid input, `004` request, `005` security. Success `2000.000.000`; `2001.002.106` no account at bank; `2900.002.001` unfunded float; `2900.005.002` IP not allowlisted.

## Cross-references
- Endpoint/parameter reference: `../payouts.md`
- Sandbox test accounts + BANV outcome classes: `../testing-and-go-live.md` §4
- Go-live for payouts specifically: `go-live.md`

## Traps
- Major-unit amounts sent to the payouts API — **cents only**, hard rule, the one place Peach uses cents.
- Reusing the SAME payoutId on retry — the API rejects duplicates (`2900.003.002`); new payoutId per submission, correlate via `merchantReference`.
- Random branch codes — only universal branch codes are accepted.
- Scheduling big payout runs into dark hours — R250k cap instead of R5M silently queues or fails volume.
- Skipping BANV on the first payout — a mistyped account pays the wrong person and **payouts are irreversible**; recovery is goodwill, not an API call.
- Treating a `failed` payout as cost-free — fees apply and value returns to float; reconcile both effects.
- Building on the list endpoint as an archive — it only covers <3 months.
- Expecting Peach-side fraud checks to replace your own — BANV + your ledger gates are the control.
