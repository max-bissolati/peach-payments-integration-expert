# Go Live

## When to load
Load when the integration works in sandbox and the user says "go live", "production", or asks about launch checks. Run this runbook top-to-bottom; don't skip the gate.

## The runbook

### Step 0 — Pre-flight: run the verification gate
Walk the full PASS/FAIL gate from `../testing-and-go-live.md` §5 (sandbox E2E, webhook tamper/replay, result-code matrix, amount integrity, refund incl. declined-refund case, secrets scan, live-swap plan). **Peach runs no verification checklist — the documented go-live is only a credential + endpoint swap. This gate is the quality bar.** Do not proceed on any FAIL.

### Step 1 — Credential + endpoint swap (per product)

| Product | Swap | Sandbox → Live |
|---|---|---|
| Checkout (Embedded/Hosted) | OAuth creds (client ID/secret, merchant ID) + entity ID + secret token; SDK script URL; checkout host | `sandbox-dashboard…` → `dashboard…` · `testsecure…` → `secure…` · `sandbox-checkout…/js/checkout.js` → `checkout…/js/checkout.js` |
| Refunds (Checkout-origin) | Refund host + secret token (HMAC key) | `testapi.peachpayments.com` → `api.peachpayments.com` |
| Payment Links | OAuth creds (links product) + API base | `https://sandbox-l.ppay.io` → `https://links.peachpayments.com` |
| Payments API | Auth-in-body userId/password/entityId (support-activated) | `testapi-v2…` → `api-v2…` |
| Card facade | Card-facade bearer (NOT a Checkout token) | `sandbox-card…` → `card.peachpayments.com/v1` |
| Payouts | Dashboard OAuth + float funding live | `sandbox-payouts…` → `payouts…` (fund the LIVE float; deposits take ~2h cycles) |
| Reconciliation | OAuth + base URL | `sandbox-reconciliation.ppay.io` → `reconciliation.peachpayments.com` |

- Sandbox and live credentials are **different sets** — every env var gets a live twin; grep the repo for any hard-coded `sandbox`/`testsecure`/`testapi` hosts.
- Credentials live in Dashboard (Connect tab for extensions); secrets to the secret store, never to code.

### Step 2 — Allowlist final domains
Dashboard → Checkout → Allowlisted domains: production domain + subdomains. No local domains. Non-matching domains sit `pending` until Peach verifies. Send **both** `Origin` (no trailing slash) and `Referer` (trailing slash) on authed calls. `[PLUGIN-VERIFIED]`

### Step 3 — Webhook URL + secret in place
Register the production webhook URL in Dashboard (+ per-checkout `notificationUrl` if used). Peach **fails closed until the webhook is configured** on extension platforms that require it (e.g. WooCommerce's decryption key) — wire it before launch, not after. Confirm the secret token is the live one (it signs webhooks AND V1 refunds).

### Step 4 — Owner-run live test (never automated)
Live money movement is executed by the owner, deliberately, once. Options `[PLUGIN-VERIFIED]`:
- **PA + void/reverse** via the card facade (cleanest — uncaptured PA never settles), or
- **small real charge + immediate refund** (verify the RF webhook + code `000.100.110`), or
- To validate credentials without settling, use the **PA + reverse** zero-settlement pattern (`../recurring-and-tokenisation.md`) — there is no separate "test checkout" Dashboard tool.
For payouts: fund the live float, then one small payout to a known-good account + proof download.

### Step 5 — Rollback plan
Write it down before launch: reverting to sandbox endpoints in production is NOT a plan. The plan = feature-flag payments off / queue orders, keep the previous credential set revocable (rotate if a rollback is credential-related), re-enable after fix. Checkout sessions are 30-min single-use — a rollback mid-session strands in-flight checkouts; finish reconciling them via `/status` after restore.

### Step 6 — Monitor the first 48h
Watch for result codes and states:
- `000.100.110` / `000.000.000` successes matching order volume.
- `100.396.104` uncertain — poll `/status`; don't auto-refund.
- `100.396.101` cancelled-by-user — **never appears in Dashboard**; absence there ≠ failure.
- `800.100.152` generic declines; `300.100.100` 3DS soft declines (retryable via 3DS).
- Webhook retry bursts (2, 4, 8, 15, 30 min, 1 h, daily → 30 days) = your endpoint returning non-200.
- First settlement cycle: cards daily-ish per acquirer (Nedbank ~1d, Absa ~2d, FNB ~2d); recon API 1 req/s, ≤24h windows.

## Platform-specific go-live notes

| Platform | Go-live requirement |
|---|---|
| Extensions (Woo, GF, Magento…) | **Activation review by Peach** after install — missing activation = "missing methods" reports. WooCommerce uses live keys; Integrator Test mode off |
| OpenCart / nopCommerce | Live credentials come **from support** — request them ahead of launch (webhook wiring also via support) |
| Shopify | Use a **separate sandbox store** for testing; flipping the test toggle on the live store post-launch stops live processing |
| Wix / Xero | **No sandbox** — untestable pre-live. Dry-run the full flow doc, then extra-cautious owner-run live test as the first real validation |
| Take App | Live-only |
| Medusa | Published community plugin; same gate + host swap (`../plugins/medusa.md`) |

## Traps
- Skipping the gate because "the sandbox payment worked once" — one happy path proves nothing about webhooks, declines, or refunds.
- Sandbox creds left in production config (or live creds leaked into the repo) — the swap is a checklist, not a find-and-replace hope.
- Allowlisting the staging domain but not production (or adding localhost — unsupported).
- Launching with the sandbox SDK script URL — the page loads but calls the wrong host; grep for `sandbox-checkout` and `testsecure` before deploy.
- Automated live charges from a "smoke test" — forbidden; owner-run PA+void or small charge+refund only. `[PLUGIN-VERIFIED]`
- Treating a missing `100.396.101` in the Dashboard as a lost transaction — it never shows there.
- Payouts going live with an empty live float — first batch fails with `2900.002.001`; fund hours ahead (2h processing cycles).
- Wix/Xero go-lives without a rehearsal — nothing was testable; walk the flow on paper with the owner first.
