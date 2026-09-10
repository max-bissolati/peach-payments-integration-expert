# Medusa

## When to load
Medusa v2 backend (≥2.13) integrating Peach Payments via the official community npm plugin `medusa-payment-peach-payments`. Also as the reference implementation for webhook verification against framework-parsed bodies, fail-closed completion, and V1 refunds.

## Status
Official, published community plugin — well-tested (a full unit + adversarial test suite and a sandbox end-to-end run, including a refund). Requirements: Medusa v2 **≥2.13** (peer deps `@medusajs/framework` + `@medusajs/medusa` ^2.13.0), Node **≥20**. `[PLUGIN-VERIFIED]`

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods (plugin creates a Checkout; surface + account config decide methods) |
| Completion model | Two independent paths converging on `GET /v2/checkout/{id}/status`: **authorize-on-return primary** (storefront return → `authorizePayment` polls `/status`) + **webhook backup** (`getWebhookActionAndData`: verify → act only on success → re-confirm via `/status`). Transient `/status` failure → `pending`, never throws out of cart completion |
| Refunds | Implemented via Peach **V1 endpoint** `POST {apiV1}/v1/checkout/refund` — HMAC-signed flat form-urlencoded body; requires the 32-char `data.transactionId` from `/status`, NOT the checkoutId; throws UNEXPECTED_STATE telling you to check the Dashboard before retrying |
| Capture/void | `capturePayment` no-op for `DB` (immediate capture settles at Peach on payment). **PA capture/void = separate card API, NOT implemented** |
| Cancel/delete | No-ops — no V2 cancel endpoint; let the 30-min checkout session expire |
| Recurring | Only `createRegistration:true` passthrough (cards). No registration management, no scheduler — BYO billing loop (see `../recurring-and-tokenisation.md`) |
| Sandbox | Full via `PEACH_MODE=sandbox`: auth `sandbox-dashboard.peachpayments.com`, checkout `testsecure.peachpayments.com`, apiV1 `testapi.peachpayments.com`, SDK `sandbox-checkout.peachpayments.com/js/checkout.js` |

## Install (summary)
1. `npm install medusa-payment-peach-payments` (exports serve only the `.medusa/server` build; bare `require()` throws `ERR_PACKAGE_PATHS_NOT_EXPORTED` by design).
2. Register in `medusa-config.ts` as a provider on module `PAYMENT` (`illustrative` — shape per plugin README):
   ```ts
   { resolve: "medusa-payment-peach-payments", id: "peach", options: { /* env-backed */ } }
   ```
   Resolves to provider id `pp_peach_peach`. `[PLUGIN-VERIFIED]`
3. Set env vars (below); restart; select Peach as the region's payment provider.

## Environment variables
| Var | Option | Notes |
|---|---|---|
| `PEACH_MODE` | `mode` | `sandbox` \| `production`, default `sandbox` |
| `PEACH_CLIENT_ID` / `PEACH_CLIENT_SECRET` / `PEACH_MERCHANT_ID` | OAuth | secret |
| `PEACH_ENTITY_ID` | `entityId` | sent to browser; semi-public, not a secret |
| `PEACH_SECRET_TOKEN` | `secretToken` | secret — HMAC key for BOTH webhooks and V1 refunds (needed even with no webhooks) |
| `PEACH_REFERER` | `referer` | storefront origin for the domain allowlist — NO trailing slash (Referer gets one, plugin handles it) |
| `PEACH_NOTIFICATION_URL` | `notificationUrl` | webhook URL |
| `PEACH_SHOPPER_RESULT_URL` / `PEACH_CANCEL_URL` | return targets | cart id appended to shopperResultUrl query for cross-browser/mobile-bank-app 3DS-return recovery |
| `PEACH_PAYMENT_TYPE` | `paymentType` | `DB` (default) or `PA` |
| `PEACH_MERCHANT_NAME` / `PEACH_DEFAULT_CURRENCY` / `PEACH_DEFAULT_COUNTRY_CODE` | cosmetic/fallback | currency/country never guessed — omitted unless derivable or defaulted |

## Webhook wiring
- Medusa auto-mounts `/hooks/payment/<provider_id>` → **`/hooks/payment/pp_peach_peach`** for provider id `pp_peach_peach` (the URL segment IS the full provider id — no shortening). `[PLUGIN-VERIFIED]` Register it in the Peach Dashboard (or `notificationUrl`); Peach surfaces a signing secret when adding the webhook — that becomes `PEACH_SECRET_TOKEN`.
- Three verification paths: classic raw form-urlencoded (signature field INSIDE the body; all other params incl. empty values sorted, `key`+`value` concatenated, no separators; HMAC-SHA256 hex), classic parsed-body reconstruction (framework dropped raw bytes → flatten parsed object to bracket notation; proven to exactly reproduce Peach's signature against a real sandbox webhook), and modern header scheme (`${timestamp}.${webhookId}.${url}.${payload}`).
- Fail closed: unverifiable webhook → ignored, never trusted; timing-safe compare; missing secretToken → invalid.
- Body = wake-up signal only: outcome + amount re-confirmed via `/status`; amount taken ONLY from `/status`; mismatch or missing Peach amount → fail CLOSED to `error`. Only the SUCCESS webhook drives completion.
- Retries up to 30 days, no ordering guarantee — late cancel/uncertain webhooks never downgrade an authorised order.

## What it does NOT implement
PA capture/void (separate card facade API); registration lifecycle / standing instructions; subscription scheduling; multi-currency detection (per-cart resolution, `defaultCurrency` fallback only). For details see the repo: `docs/WEBHOOKS.md` (webhook URL derivation + delivery semantics), `examples/storefront/` (Next.js reference: session picking, embedded widget mount, authorize-on-return result page), the plugin's changelog (see its GitHub repo) (why each fix exists).

## Traps
- `/status` returns FLAT dotted keys (`json["result.code"]`) — the parser reads every known shape; a 200 with no result code is unclassifiable → stays `pending`.
- `000.400.101/102` deliberately NOT success (would be fail-open); `000.100.2xx` = chargeback family, excluded via the `000.100.1` prefix.
- `100.396.101` (cancelled) and `100.396.104` (uncertain) map to `canceled` so Medusa's subscriber SKIPS them — never re-authorises on a late webhook.
- V1 refund returns **HTTP 200 even when DECLINED** — branch on `result.code`; uppercase currency BEFORE signing or the HMAC mismatches; nested JSON instead of flat form-encoded → `200.300.404`.
- checkoutId single-use, 30-min TTL, not reusable after unmount; `updatePayment` with a changed amount re-creates the checkout (amount-locked sessions).
- Boot is deliberately lenient about missing credentials (never break the whole payment module incl. `pp_system_default`) — errors surface at call time naming the env var.
- Amount-integrity gate: success code is NOT sufficient; Peach's reported amount must equal the session amount at rounded cents, else fail CLOSED.
- Sandbox Integrator Test Mode auto-approves 3DS — challenge flows untestable there.
- Related: [_matrix.md](_matrix.md), `../webhooks.md`, `../checkout-v2.md`.
