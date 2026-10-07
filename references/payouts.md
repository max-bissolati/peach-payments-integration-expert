# Payouts API (realtime EFT disbursements)

## When to load
Load for: paying out to suppliers/employees/partners/customers from a float, marketplace disbursements, refunds-as-payouts for non-refundable methods, float funding/BANV (bank account verification), bulk payouts, payout webhooks/reports. Prerequisites and test data interact with `testing-and-go-live.md`.

## Prerequisites and hard warnings
- South African businesses only. Activation via Peach Dashboard + Peach requires a **source-of-funds document** (compliance) before payouts work.
- **Payouts are irreversible.** A submitted payout cannot be recalled.
- **Failed payouts still incur fees** — the value returns to your float, but the attempt costs. Verify accounts (BANV, below) before paying out, especially first-time/high-value recipients.
- Roles: only certain Dashboard roles can create payouts.
- Excluded recipient accounts: **Capitec "Live Better"** accounts; **TymeBank SME accounts starting `53`**.
- Float top-up restrictions: no PayShap deposits (use RTC — recommended — or EFT); no deposits from a TymeBank Everyday account.

## Float model
- Deposit into the Peach Payouts account quoting your unique **deposit reference** (from Dashboard).
- Deposits are processed **every 2 hours** on a fixed schedule:

| Deposits included from | Deposits included to | Processed at |
|---|---|---|
| 00:00 | 02:00 | 03:00 |
| 02:00 | 04:00 | 05:00 |
| 04:00 | 06:00 | 07:00 |
| 06:00 | 08:00 | 09:00 |
| 08:00 | 10:00 | 11:00 |
| 10:00 | 12:00 | 13:00 |
| 12:00 | 14:00 | 15:00 |
| 14:00 | 16:00 | 17:00 |
| 16:00 | 18:00 | 19:00 |
| 18:00 | 20:00 | 21:00 |
| 20:00 | 22:00 | 23:00 |
| 22:00 | 00:00 | 01:00 |

- **RTC** payments reflect in ~1 min–3 h (deposit before the batch cut-off for fastest availability). **Normal EFT** may take up to 2 business days.
- **Auto-funding**: aggregation merchants can toggle funding payouts automatically from settlements. ⚠️ version-sensitive — toggle change takes effect for payouts funded if set **by 08:00**; confirm current cut-off behaviour with support.
- Balance: `GET /balance` returns available cents; never-funded/error → `2900.002.001`.

## Auth + hosts
- Auth: `POST https://dashboard.peachpayments.com/api/oauth/token` (sandbox: `https://sandbox-dashboard.peachpayments.com/api/oauth/token`) with JSON `{clientId, clientSecret, merchantId}` → `{access_token, expires_in, token_type:"Bearer"}`. Send `Authorization: Bearer {token}`.
- API host: live `https://payouts.peachpayments.com`, sandbox `https://sandbox-payouts.peachpayments.com`.

## Create payout — `POST /merchants/{merchantId}/payouts`
```bash runnable
curl -X POST "https://payouts.peachpayments.com/merchants/{merchantId}/payouts" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payouts": [{
        "payoutId": "84920878-fc32-494f-8e30-6a2465c9a456",
        "currency": "ZAR",
        "amount": 56712,
        "accountNumber": "4047594620",
        "branchCode": "632005",
        "reference": "Refund order 74152",
        "bankName": "ABSA",
        "accountHolder": "Sibusiso Kumalo",
        "payoutMethod": "realtime-eft"
      }]}'
```
Body is `{"payouts":[ … ]}` (array → batch submission). Item fields:

| Field | Rule |
|---|---|
| `payoutId` | UUIDv4 recommended — must be **UNIQUE per request; the API rejects duplicate payoutIds (`2900.003.002`)**. It is NOT a reuse-as-retry key: on a failed/uncertain submission, query by payoutId/status first; a genuine resubmit needs a NEW payoutId with `merchantReference` carrying the logical idempotency |
| `currency` | `ZAR` |
| `amount` | **IN CENTS — integer.** Min `1000` (= R10), max `500000000` (= R5,000,000). This is the #1 integration bug: sending rands-as-cents or cents-as-rands |
| `accountNumber` | ≤50 chars |
| `branchCode` | **Always the universal branch code** (table below) regardless of the recipient's actual branch |
| `reference` | 1–20 chars, alphanumeric + spaces (appears on the recipient's statement) |
| `bankName` | Enum (below), uppercase |
| `accountHolder` | 2–50 chars; pattern `^[a-zA-Z0-9]([ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$` (no leading/trailing punctuation) |
| `merchantReference` | Your free reference |
| `payoutMethod` | `realtime-eft` |
| `proofOfPayment` | `{to:[emails], cc:[emails]}` — auto-emails the PDF proof on success |

`bankName` enum (uppercase): `STANDARD BANK`, `NEDBANK`, `FNB`, `ABSA`, `CAPITEC BANK`, `CAPITEC BUSINESS`, `DISCOVERY BANK`, `TYMEBANK`, `INVESTEC BANK LIMITED`, `BIDVEST BANK`, `BIDVEST BANK ALLIANCES`, `AFRICAN BANK`, `AFRICAN BANK BUSINESS`, `ACCESS BANK`, `ALBARAKA BANK`, `BANK ZERO MUTUAL BANK`, `FINBOND EPE`, `FINBOND MUTUAL BANK`, `HBZ BANK LIMITED`, `OLD MUTUAL BANK`, `SASFIN BANK`, `STANDARD CHARTERED BANK SA`, `UBANK LTD`, `YWBN MUTUAL BANK`. **Aliases** `[DOCS]`: pay Mercantile Bank accounts via `CAPITEC BUSINESS`, Mukuru via `ACCESS BANK`, and RMB via `FNB` — use the aliased bank's account details + universal branch code.

### Universal branch codes
| Bank | Code | | Bank | Code |
|---|---|---|---|---|
| Absa | `632005` | | FNB | `250655` |
| Access Bank | `410506` | | HBZ Bank | `570105` |
| African Bank | `430000` | | Investec | `580105` |
| African Bank Business | `584000` | | Mercantile (via Capitec Business) | `450105` |
| Albaraka | `800000` | | Mukuru (via Access) | `410506` |
| Bank Zero | `888000` | | Nedbank | `198765` |
| Bidvest Bank | `462005` | | Old Mutual Bank | `462105` |
| Bidvest Alliances | `683000` | | RMB (via FNB) | `250655` |
| Capitec Bank | `470010` | | Sasfin (via Bidvest Alliances) | `683000` |
| Capitec Business | `450105` | | Standard Bank | `051001` |
| Discovery Bank | `679000` | | Standard Chartered SA | `730020` |
| Finbond (EPE/Mutual) | `589000` | | TymeBank | `678910` |
| | | | Ubank | `431010` |

**Bank Zero - Mukuru** now has universal branch code `435000`; this is distinct from the existing
Mukuru-via-Access route (`410506`). Select the beneficiary's actual bank and confirm the current
API enum rather than mapping all Mukuru accounts to Access.
[Supported banks, checked 2026-10-07](https://developer.peachpayments.com/docs/peach-payouts#supported-banks).

### Payout states
`pending → processing → successful | failed | cancelled | reversed`. A failed payout returns value to your float (fees still apply).

### Error shapes
- 400 validation: `{title:"Invalid input error", message:"Request field(s) missing or invalid.", code:"2900.003.001", errors:{…}}` where `errors` is keyed by dotted path (`payouts[0].accountHolder`, `payouts[2].reference`) with the failed pattern in the message. Iterate `errors` keys, don't parse the message string.
- Insufficient float: `2900.002.000` "Load more funds and try again or try a lower amount."
- Never-funded float: `2900.002.001` on the balance endpoint.
- IP not allowlisted (opt-in feature): HTTP 403 `2900.005.002`.
- Payout-code groups (4-digit first group): `001` technical, `002` processing, `003` invalid input, `004` request, `005` security; success `2000.000.000`; processing `2900.000.003`; bank-side "no account" `2001.002.106`.

## List / query
- `GET /merchants/{merchantId}/payouts`: list requests with date/status filters; window strictly **< 3 months**.
- `GET /merchants/{merchantId}/payouts/{payoutRequestId}/status`: query by the provider's request ID.
- `GET /merchants/{merchantId}/payouts/status?payoutId={payoutId}`: query using your merchant-supplied
  UUID, useful after create times out without returning `payoutRequestId`. A 200 means the payout was
  stored. An initial 404 means it is not visible yet: wait and query again, not immediate resubmission.
  The docs permit creating again only if it stays 404, but do not define that wait duration; use a
  bounded recovery policy and escalate uncertainty before a fresh payout. Source checked 2026-10-07:
  [query by payout ID](https://developer.peachpayments.com/reference/querypayoutrequestbypayoutid).
- `GET /merchants/{merchantId}/balance` — available float, in cents.

## BANV — bank account verification
```json runnable
POST /merchants/{merchantId}/banv
{
  "accountNumber": "123456789012",
  "accountType": "current_cheque_account",
  "branchCode": "198765",
  "idNumber": "123456789012",  // docs placeholder — real SA IDs are 13 digits
  "initials": "JD",
  "lastName": "Sibusiso"
}
```
→ `202`-style acknowledgement `{message, bankVerificationId (UUID), status:"pending", resultCode:"2902.000.001"}`; result arrives by webhook (or `GET` query-bank-verification-result by `bankVerificationId`).
- **Operates 03:00–23:00 only.**
- **Verifying a company account:** BANV is modelled around an individual (`idNumber` + `initials` + `lastName`), but you can verify a **business** bank account by putting the company registration number in the `idNumber` field. Use it for supplier/marketplace payouts to companies, not just individuals.
- Supported banks (13): Absa, African Bank, African Bank Business, Bidvest Bank Alliances, Capitec Bank, Discovery Bank, FNB, Grindrod Bank (African Bank), Investec, Nedbank, RMB (use FNB details + universal branch code), Standard Bank, TymeBank.
- Recommended cadence: verify on first payout to an account, on any banking-detail change, and re-verify roughly every 3 months.
- Test: Nedbank account `1012546144` is the no-match case (see `testing-and-go-live.md`).

## Webhooks (Svix-signed)
- Signature verified via **Svix**: headers `webhook-id` and `webhook-timestamp` (+ signature); verify with **Svix libraries** (`svix` npm/pip: `Webhook.verify`) or manually per Svix docs. Signing secret comes **from Peach support**, not self-serve.
- Delivery: URL-encoded query string format via HTTP POST for payout status updates; must return 200 or Peach retries — **30-day retry window**.
- Payloads (documented shape):
  ```json runnable
  { "status": "successful", "payoutId": "ae3be0f1-40d1-4b28-8072-6f78d4493444",
    "lastUpdated": "2025-07-02T11:00:45.406Z", "resultCode": "2000.000.000" }
  ```
  Processing → `2900.000.003`; Failed → failed-family code (see error groups below).
- Events: Payout status `processing | successful | failed`; BANV result; float allocation (top-up) updates. Configure endpoints in Dashboard (see `webhooks.md` for the endpoint-config API: get/update webhook endpoints).
- Result codes in payloads: `2000.000.000` successful; `2900.000.003` processing; `2001.002.106` no such account at bank; failed-payout family `2000`–`2899` (typically merchant/customer-supplied bank-detail errors — **these are billed**).

## Bulk payouts (XLSX)
`POST /merchants/{merchantId}/payouts/upload` (multipart). Only `.xlsx` processed; processed asynchronously; track via returned `bulkPayoutId`:
- `GET /merchants/{merchantId}/payouts/upload` — list bulk uploads and their statuses (e.g. `processing`).
- `GET /merchants/{merchantId}/payouts/upload/{bulkPayoutId}/error` — download the error file; fix and resubmit failed rows.
- Columns **exactly**: `currency`, `bankName`, `payoutMethod`, `amount`, `accountNumber`, `branchCode`, `reference`, `accountHolder`; optional `notifyEmail` (comma-separated emails → proof-of-payout email on success) and `merchantReference`.
- Dashboard bulk flow: Payouts → Create payout → Bulk payout → Download template → fill **without adding columns** → upload → `Uploaded successfully` or `Uploaded with errors` (download error XLSX, fix, resubmit). With IP allowlisting enabled, Dashboard bulk payouts also require your machines' IPv4 addresses on the allowlist.

## Proofs and reports
- Proof of payout: `downloadproofofpayout` / `emailproofofpayout` — PDF, **only for successful payouts**, first available **~30 minutes after completion** (an availability DELAY, not an expiry — no expiry is documented).
- Reports: transaction report CSV + statement report CSV (`downloadtransactionreport`, `downloadstatementreport`).

## IP allowlisting
- **Opt-in via support** (2026-08-14). Enable: (1) request it from Peach support; (2) supply IPv4 addresses or CIDR ranges that may create payouts — include Dashboard machine IPs if you bulk-payout from the Dashboard; (3) Peach adds them.
- Applies to **create-payout requests only** — status queries, reports, and BANV remain unrestricted. Non-allowlisted create → HTTP 403, result code `2900.005.002`. IPv6 requests are rejected outright.

## RTC dark-hours limits (recipients' banks / RTC rails)
- Min payout R10.
- Business days (Mon–Fri) 00:00:01–16:00: RTC up to **R5,000,000** per transaction.
- Overnight 16:00:01–00:00, weekends, public holidays: **R250,000** cap.
- Schedule high-value payouts inside business-day daytime windows or they fail/queue.

## Sandbox testing
Test accounts: Absa `4047594620` / branch `632005`; TymeBank `51000347387` / `678910`. BANV no-match: Nedbank `1012546144`. Sandbox payouts may fail intermittently outside South African office hours. Full data in `testing-and-go-live.md`.

## Dashboard bulk files use rands

Unlike API `amount` in cents, `payout_template.xlsx` amounts are in major units (rands). Keep all
columns, including optional ones; leave cells blank rather than removing columns. Maximum file size
is 1 MB, with no documented row-count or total-value limit. Per-payout limits remain R10 to
R5,000,000, with lower limits outside business hours. Validate in the sandbox Dashboard first.
For an upload with errors, valid rows are processed. Correct and re-upload only the rejected error
rows, never the original full batch. Confirm each payout's actual status for reconciliation.
[Dashboard guide, checked 2026-10-07](https://developer.peachpayments.com/docs/payouts-dashboard).

## Traps

- **No mid-batch stop or recall**: payouts are irreversible by design and there is no documented
  API to halt a submitted batch (`cancelled` exists as a per-item state you query, not a batch
  abort). Screen beneficiaries — BANV plus your own sanctions/verification — BEFORE submission;
  after submission, per-item status queries are your only visibility.
- `amount` sent in rands ("150.00") instead of cents (`15000`) → pays R1.50 or fails validation; the field is an integer **cents** value, min 1000, max 500000000.
- Using the recipient's real branch code instead of the universal one → rejected or misrouted; always the universal code from the table (and alias banks need the alias bank's code: RMB→FNB `250655`, Mercantile→Capitec Business `450105`, Mukuru via Access→`410506`, Bank Zero - Mukuru→`435000`, Sasfin→Bidvest Alliances `683000`).
- Adding columns or renaming headers in the bulk XLSX → upload errors; use the template verbatim.
- Only successful payouts have proofs; expect them from ~30 minutes after completion onward.
- List window ≥3 months → empty/error; page in <3-month chunks.
- IP allowlisting blocks bulk Dashboard payouts too if Dashboard machine IPs aren't allowlisted; IPv6 sources always rejected.
- Treating "failed" as lost money — value returns to float, but the fee is still billed (success + `2000`–`2899` result codes are billed); don't retry blindly without BANV.
- Recipient account types excluded (Capitec Live Better, TymeBank `53…` SME) fail despite valid-looking details — screen these upstream.
- Night/weekend RTC payouts above R250k fail on dark-hours limits, not on balance.
