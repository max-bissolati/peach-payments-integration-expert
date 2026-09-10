# OpenCart

## When to load
OpenCart store connecting Peach Payments; extension id 43757; Modifications cache flush; merchant ID prefix on statements; unique Traces API-audit tab.

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods; all currencies configured for the account; SA/KE/MU |
| Refunds | **No plugin refunds** (no full or partial). Log offline in OpenCart, then refund manually or via the Peach Payments Dashboard |
| Recurring | No — once-off only; **no one-click/stored-card payments either** |
| Sandbox | Yes — **Sandbox Mode** Yes/No + sandbox/live credential pairs |
| Webhooks | Via support — send the callback URL from **Checkout** > **Webhooks** > **Callback url** to Peach support |
| Audit | **Traces** tab: web tool listing ALL API interactions between store and Peach APIs, with per-trace detail |
| Activation | Account requires review by Peach Payments South Africa |

## Install
1. OpenCart Extension Store — extension **id 43757**; the page lists compatible OpenCart versions. Click **DOWNLOAD** (log in; enter PIN if requested). Extract the ZIP.
2. OpenCart admin: **Extensions** > **Installer** > **Upload** (OpenCart 2: **Extensions** > **Extension Installer**).
3. From the extracted folder `..\plugin-opencart-a1l-master 2\plugin-opencart-a1l-master\zip`, select the ZIP matching YOUR OpenCart version > **Open** (OpenCart 2: **Continue**).
4. **Extensions** > **Modifications** > click **Clear** then **Refresh** — flushes and rebuilds the modification cache.

## Credentials
**Checkout channel** (officially noted as "sometimes called the Entity ID") + **secret token**, sandbox and live — requested **from Peach support** (support@peachpayments.com), not Dashboard Connect.

## Configure (test)
**Extensions** > **Extensions** > Filter drop-down **Payments** > Peach Payments > **Edit**:
1. **General** tab: sandbox checkout channel + sandbox secret token.
2. Send the callback URL (**Checkout** > **Webhooks** > **Callback url**) to support for webhook setup.
3. **Merchant ID prefix**: prepended to order IDs — prefix `test-shop` + order `1234` → `test-shop-1234` on the customer statement and in the Dashboard merchant order ID column.
4. **Sandbox Mode** = Yes.
5. **Peach Payments Currency**: match the currency configured with Peach Payments.
6. **Sort Order** if multiple payment gateways.
7. **Order status** tab: verify order status mappings > **Save** (upper right).
8. Execute test purchases.

## Go live
Request a live checkout channel + live secret token from support → **Edit** Peach Payments → **General** tab → enter live pair → **Sandbox Mode** = No → **Save**. Verify with live purchases — **the merchant runs these, not the agent**: this is real money, so it falls under the SKILL.md write gate (owner-confirmed, smallest possible amount, refund after).

## Webhook wiring
Support-configured only: send the plugin's callback URL to support. No self-serve registration.

## Traps
- Skipping **Extensions** > **Modifications** > Clear + Refresh after install = extension silently absent.
- The ZIP is version-specific — installing the wrong OpenCart version's ZIP fails or misbehaves.
- Set the **merchant ID prefix** before live traffic: changing it later breaks statement/reconciliation key continuity.
- No recurring AND no one-click — tokenisation requirements route to another platform ([_matrix.md](_matrix.md)).
- Debug from the **Traces** tab (Edit > Traces): every API call with detail views — use it before contacting support.
- Credential sourcing via support ticket: budget latency on go-live day.
