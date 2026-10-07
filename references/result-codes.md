# Result codes — reading outcomes and mapping them safely


**Advice-code scope, checked 2026-10-07:** current Dashboard documentation separates Mastercard
and Visa advice tables. A bare numeric `MerchantAdviceCode` is not a universal retry instruction.
Resolve the network and connector before applying the older Mastercard-style mappings below or
calling the helper. For example, Mastercard `03` is no-retry, while Visa `03` means invalid merchant
in a limited-retry category. Unknown provenance means stop and review, not automatic retries or
mandate cancellation. `map-result-code.js` / `decode-result.js` retain legacy advice mappings and
are not network-aware decision engines.
[Current tables](https://playground.peachpayments.com/docs/dashboard-transactions).

## When to load

Mapping `result.code` to order/subscription state, handling a failed/declined payment, building a
status mapping for any framework, or reviewing why an integration mis-classifies outcomes.

POS does not use these numeric `result.code` families. Use `pos-integrations.md` for
`transactionResult`, numeric webhook transaction types, and Intent callback success checks.
Orchestration also uses its own status model (`orchestration-api.md`).

## Format and where the truth lives

`ddd.ddd.ddd` (Payment Links and Payouts use a **4-digit first group**, e.g. `2000.000.000`).
Group 1 = rough category, group 2 = subcategory, group 3 = specific
(`800.100.153` = bank declined / authorisation declined / wrong CVV).

- Human list: Dashboard docs → Response codes.
- Machine-readable JSON: `GET https://sandbox-card.peachpayments.com/v1/resultcodes` (excludes
  Payment Links and Payouts codes). ⚠️ version-sensitive — refetch when extending mappings.
- Investigate by matching the first two groups; the third is the precise cause.

## Mapping recipe (framework-agnostic, fail-closed)

```ts
// runnable — battle-tested in a production Medusa provider [PLUGIN-VERIFIED]
const SUCCESS        = /^(000\.000\.|000\.100\.1|000\.[36])/;
const SUCCESS_REVIEW = /^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/;
const PENDING        = /^(000\.200)/;
const PENDING_EXT    = /^(800\.400\.5|100\.400\.500)/;   // delayed finalisation (EFT etc.)
const REQUIRES_MORE  = /^(300\.100\.100|900\.100\.[34])/; // SCA soft-decline / timeout
const CANCELLED      = /^(100\.396\.101|100\.396\.104)/;
const CODE_SHAPE     = /^\d{3}\.\d{3}\.\d{3}$/;

function mapCode(raw: string): "captured"|"review"|"pending"|"requires_more"|"canceled"|"error" {
  const code = (raw ?? "").trim();
  if (!CODE_SHAPE.test(code) || /\s/.test(code)) return "error";  // junk can never bucket as success
  if (SUCCESS.test(code)) return "captured";
  if (SUCCESS_REVIEW.test(code)) return "review";       // charged — review before fulfilment
  if (PENDING.test(code)) return "pending";
  if (PENDING_EXT.test(code)) return "pending";
  if (REQUIRES_MORE.test(code)) return "requires_more";
  if (CANCELLED.test(code)) return "canceled";
  return "error";
}
```

Rules that make this fail-closed `[PLUGIN-VERIFIED]`:
- Anchor both ends, digits-only classes, reject whitespace — `"000.000.000extra"` or a code with a
  trailing newline must never bucket as success.
- `000.400.101` ("card not participating / authentication unavailable") and `000.400.102`
  ("user not enrolled") are **3DS rejections, NOT success — the docs file 101–113 under Rejected (terminal)** — in server-to-server
  flows the debit's own terminal code decides. Treating 101/102 as captured is fail-open; a real
  Checkout V2 success always returns a terminal `000.100.1*` / `000.000.*`.
- `000.100.2xx` is the **chargeback/reversal family** (`000.100.200`–`234`, plus `000.100.299`) —
  excluded from success by anchoring on `000.100.1`, not `000.100.`. Two outliers,
  `000.100.211`/`000.100.212` ("transaction succeeded, amount differs from the pre-authorisation"),
  are genuine successes that this fail-closed matcher still holds as non-success — if you run
  auth/capture with a variable capture amount, reconcile those two from `/status`.
- `100.396.101` (cancelled by user) and `100.396.104` (uncertain/probably cancelled) map to
  **canceled, not error** — so retry/queue logic skips them and never downgrades a confirmed order.
- Make the mapping pure + overrideable, and snapshot-test the full table so refactors can't
  silently move real codes.

## The documented groups (filter regexes from Peach's docs)

| Group | Regex | Meaning / action |
|---|---|---|
| Successful | `/^(000.000.\|000.100.1\|000.[36]\|000.400.[1][12]0)/` | captured/authorised — fulfil after amount check. ⚠️ **Documented divergence, by design**: the docs' own Successful group includes `000.400.110/120`; this recipe deliberately gates them to `review` for fulfilment safety — when explaining to a user, say "successful per the docs, held for review by this recipe" |
| Successful, flagged for review | `/^(000.400.0[^3]\|000.400.100)/` | money moved; review (fraud/AVS/CVV suspicion) before fulfilment |
| Pending, short-term | `/^(000\.200)/` | session open; ~30 min then timeout; `000.200.000` pending, `000.200.100` created, `000.200.201` QR/link opened |
| Pending, delayed finalisation | `/^(800\.400\.5\|100\.400\.500)/` | non-instant methods (debit orders, async EFT); can take days — do NOT retry |
| 3DS / risk_m | `/^(000\.400\.[1][0-9][1-9]\|000\.400\.2)/` | 3DS-step and risk rejections |
| 3DS authentication rejected | `/^(100\.390\.1)/` | `100.390.100`–`124` — 3-D Secure authentication-step rejections (PARes/enrolment/challenge/fraud). Decline, never success — shopper should retry or use another method |
| External payment system | `/^(800\.[17]00\|800\.800\.[123])/` | external PSP rejections |
| Communication error | `/^(900\.[1234]00\|000\.400\.030)/` | network/timeout — often retryable |
| System error | `/^(800\.[56]\|999.\|600.1\|800\.800\.[84])/` | config/system — fix before retry |
| Async workflow | `/^(100\.39[765])/` | workflow-level rejections |
| Soft decline | `300.100.100` | SCA/exemption refused — re-run through 3DS or `challengeIndicator=04` |
| MAC/signature | `/^(700\.600\|700\.601)/` | your signature is wrong |
| Format validation | `/^(200\.[123]\|100\.[53][07]\|800\.900\|100\.[69]00\.500)/` | your request shape is wrong |
| Amount validation | `/^(100\.55)/` | amount problems (incl. `100.550.701` refund amount mismatch) |
| Chargebacks | `/^(000\.100\.2)/` | `000.100.200`–`000.100.234` + `000.100.299` — dispute/chargeback/reversal family (`…211`/`…212` are actually "succeeded" — see note above) |

> Group filters and the chargeback range re-verified 2026-09-08 against the live
> `GET /v1/resultcodes` (709 codes). `[DOCS]`

Payouts second-group meanings: `001` technical, `002` processing, `003` invalid input, `004`
request, `005` security (`payouts.md`).

## Codes worth memorizing

| Code | Meaning | Action |
|---|---|---|
| `000.000.000` / `000.100.110` | success (`…110` = sandbox "Integrator Test Mode" text) | fulfil after `/status` + amount check |
| `000.200.000` | pending | poll/wait — **in sandbox a 3DS decline can also land here**; discriminate via `/status`, not the code alone `[PLUGIN-VERIFIED]` |
| `200.300.404` | invalid/missing parameter (e.g. nested-JSON refund body) | fix the request shape |
| `100.396.101` / `100.396.104` | cancelled / uncertain | map to canceled; never downgrade confirmed orders |
| `300.100.100` | soft decline (SCA) | retry through 3DS or challenge indicator 04 |
| `800.100.152` | generic bank authorisation decline | retry with another method/card |
| `800.100.153` | wrong CVV | shopper-fixable |
| `800.100.156` | format error | workaround on recurring: `standingInstruction.type=UNSCHEDULED` instead of `INSTALLMENT` |
| `800.100.195` | `UserAccount Number/ID unknown` — e.g. a MoneyBadger refund where the original payment captured no refund destination | refund fails — prevent at payment time |
| `100.550.701` | refund amount mismatch | check original amount/currency |
| `700.300.100` / `700.400.200` | referenced transaction can't be refunded / refund not allowed | wrong `id` or method non-refundable |
| `000.400.109` | card not 3DS2-enrolled (sandbox, unlisted card) | use listed test cards |
| `900.100.3xx/4xx` | timeout / SCA timeout | treat as requires_more; shopper may retry |

`MerchantAdviceCode` (from `/status` `resultDetails` — ⚠️ TWO doc sources conflict on 03: the
Dashboard transactions page says **03 = "Do not try again. Retry is not allowed"** while the API
reference gloss says "re-initiate"; the stricter Dashboard table governs — treat 03 as terminal):
`01` new account info (card updated — retry sensible), `02` cannot approve now (retry later),
`03` **do not retry — stop billing this mandate** (Dashboard) / re-initiate (API gloss — resolve
per your acquirer before relying on either), `04` do not try again (token requirements — kill the
mandate). Drive dunning off `scripts/map-result-code.js`'s `merchantAdviceGuidance` which encodes
the strict reading. Drive dunning off this — see
`playbooks/failed-renewal-card-expiry.md`.

## Traps

- A 3DS decline in an Integrator-Test-Mode sandbox can surface as `000.200.000` pending —
  indistinguishable at code level; discriminate with `/status` + session state. `[PLUGIN-VERIFIED]`
- Codes for cancelled sandbox attempts (e.g. PayShap decline sims) don't appear in the Dashboard —
  don't hunt for them there.
- Payment Links/Payouts codes have 4-digit first groups — shape-check before the 3-group regex.
- `result.description` is display text, sometimes "Merchant in Integrator Test Mode" — never parse
  it for logic; use the code.
- Never map "unknown code" to success. Default is error; humans can override case-by-case with an
  overrides table that logs what it upgraded (and cannot upgrade refunds). `[PLUGIN-VERIFIED]`
