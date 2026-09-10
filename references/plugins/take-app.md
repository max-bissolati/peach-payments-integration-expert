# Take App

## When to load
Take App (chat-commerce store builder) connecting Peach Payments. Peach's own developer docs don't cover
the setup — it's documented on Take App's side. Steps below are from Take App's own help centre
(help.take.app, verified 2026-09-08); the Peach specifics are standard Checkout.

## Capabilities
| Capability | Detail |
|---|---|
| Scope | Take App accepts Peach Payments as a checkout payment provider using your Peach **Checkout** credentials |
| Payment methods | **Credit card** (per Take App's docs); other methods follow your Peach account config, but Take App only names cards `[DOCS: help.take.app]` |
| Currencies | **MUR, ZAR, USD** — your store currency must match your Peach account's currency `[DOCS: help.take.app]` |
| Refunds | **Not documented by Take App** — no in-platform refund flow is described. Refund from the Peach Dashboard directly, and reconcile the order in Take App manually |
| Recurring | **Not documented / not supported** — Take App describes one-off checkout only |
| Sandbox | **Live only** — no test mode; every transaction is real |
| Webhooks | **Not documented by Take App** — no webhook config is exposed. For independent confirmation, poll Peach `GET /status` from your own backend keyed on the order reference (`../webhooks.md`) |

## Connect (Take App side) — `[DOCS: help.take.app]`
1. Dashboard → **Settings** → **Integrations** → select **Peach Payments**.
2. Enter your Peach credentials: Take App asks for the **5 API keys, in the right order** — these are your
   standard Peach Checkout credentials (entity/channel ID, client ID, client secret, merchant ID, secret
   token) from the Peach Dashboard. Put them in the order Take App's fields specify.
3. Go to **Payments**, add **Peach Payments**, and **Save**.
4. Test by opening an unpaid order → new payment tab → choose **Peach Payment** → complete payment.

## Peach-side setup you MUST do first (the two things that break it)
- **Allowlist `take.app` in your Peach Dashboard** (domain allowlist). If you skip this, checkout creation
  is rejected — Peach returns `Merchant domain is not allowlisted`. This is the #1 Take App setup failure.
  `[DOCS: help.take.app]`
- **Ask Peach support to enable the cancel/fail page**, so a buyer who cancels or fails a transaction is
  returned cleanly instead of hitting a dead end. `[DOCS: help.take.app]`

## Traps
- **Live only** — no sandbox. **The merchant (not the agent)** verifies with the smallest real amount, then refunds from the Peach Dashboard; this is real money, so it falls under the SKILL.md write gate.
- **`take.app` must be allowlisted in Peach** before anything works (`Merchant domain is not allowlisted`
  otherwise) — this is separate from anything you set in Take App.
- **No documented refunds / recurring / webhooks.** If server-side confirmation, refunds, or subscriptions
  are hard requirements, prefer a platform that documents them (compare in [_matrix.md](_matrix.md)); on
  Take App you handle refunds in the Peach Dashboard and confirm payments by polling Peach `/status`.
- Store currency must match your Peach account currency (MUR/ZAR/USD) or checkout won't proceed.
- Take App's install flow is its own — do NOT assume other extensions' steps transfer.
