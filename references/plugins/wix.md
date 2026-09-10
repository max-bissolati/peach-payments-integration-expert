# Wix

## When to load
Wix store connecting Peach Payments; questions about missing sandbox/webhooks/refunds; payment methods disappearing due to base currency.

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods — **but Wix supports ONE base currency**: a method not supporting your base currency cannot be offered. ZAR base ⇒ **no PayPal** (PayPal does not support ZAR) |
| Refunds | **No plugin refunds** (no full or partial). Log the refund with Wix's offline refund feature, then refund the customer manually or via the Peach Payments Dashboard |
| Recurring | No — once-off only |
| Sandbox | **None** — no sandbox environment for Wix; the key provided at sign-up processes LIVE transactions |
| Webhooks | **None supported** — confirmed in official FAQ |
| Activation | Account requires review by Peach Payments South Africa |
| Plan gate | Wix **Business & eCommerce premium plan** required to accept payments |

## Install
1. Wix dashboard left navigation: **Settings** > **Accept payments**.
2. Click **See More Payment Options** (bottom of the page).
3. In the **Peach Payments** row, click **Connect**.
4. Retrieve the **Entity ID** from the Peach Dashboard (**Connect** > **Wix**; section appears only if Peach configured it for your account — else contact support, who can also supply the ID). Enter it > **Connect**.
5. When connected, click **Manage** in the Peach Payments row.
6. Toggle **Not accepting payments** → **Accepting payments**.
7. Confirm Peach Payments shows **ACTIVE** on the **Accept Payments** page.

## Credentials
**Entity ID only.** No secret token, client ID, client secret, or merchant ID is entered anywhere in Wix.

## Webhook wiring
Not available. No server-side payment confirmation channel exists for Wix.

## Querying transactions
Quote the **merchant order ID** value embedded in the payment page URL when querying a transaction with Peach support.

## Traps

- **Over-refusal trap**: "once-off only, no card storage" describes the WIX PLUGIN — not Peach. Deferred charging is achievable off-plugin: send a Payment Link with `tokeniseCard` (or a zero-amount `PA`) at preorder time, then run the MIT debit yourself at dispatch (`recurring-and-tokenisation.md`). Say "the plugin can't; your own link + ledger can." 
- Live-only: every transaction is real money. **The merchant (not the agent)** verifies with a minimal live amount (SKILL.md write gate); there is no sandbox toggle.
- Base-currency choice silently gates the method list — decide currency BEFORE promising method coverage (ZAR kills PayPal).
- No webhooks ⇒ never build fulfilment/shipping automation on payment callbacks for Wix; reconcile against the Peach Dashboard or Wix order state.
- Peach Payments missing as a provider = store not on Business & eCommerce premium plan.
- Refunds are a TWO-step manual process (Wix offline log + Peach Dashboard refund) — doing only one desyncs the systems.
- If sandbox, webhooks, or plugin refunds are requirements, route to a different platform — compare [_matrix.md](_matrix.md).
