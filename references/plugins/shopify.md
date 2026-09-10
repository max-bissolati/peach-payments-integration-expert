# Shopify

## When to load
Shopify store connecting Peach Payments; missing payment method at checkout; refund routing; Test-mode toggle dangers; sandbox store strategy.

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods; all currencies configured for the account; countries SA/KE/MU |
| Refunds | Full/partial **from the Shopify admin only** — never from the Peach Dashboard |
| Recurring | No — once-off payments only |
| Sandbox | Test-mode toggle in Shopify; Peach advises a **separate standalone sandbox store** linked to the sandbox Dashboard |
| Webhooks | Configure per the generic Peach webhook docs (Dashboard) — no Shopify-specific URL format |
| Activation | Account requires review by Peach Payments South Africa |

## Install
Two paths — Dashboard Connect is recommended:
1. Log in to the Peach Payments Dashboard (the sandbox Dashboard works identically for sandbox testing).
2. **Connect** section > **Shopify** > **Connect store**.
3. In the **Link your Peach account** window enter the store name `<store-name>.myshopify.com` (from Shopify **Settings**, or **Settings** > **Domains** if on a custom domain) > **Link account**.
4. In Shopify click **Install app**.
5. Set the **Test mode** toggle: ON for testing, OFF to accept live payments. (A sandbox Dashboard linked with toggle OFF causes transactions to FAIL — sandbox cannot accept live payments.)
6. Click **Activate** — the final, mandatory step.
7. Configure a webhook per the Peach webhook docs.
- Alternate path (API credentials): `https://dashboard.peachpayments.com/shopify/install` → store name + live entity ID + secret token > **Link account** > Install app > toggle > **Activate**.

## Credentials
Dashboard Connect flow: no manual credential entry. API path: live **entity ID** + **secret token** from Dashboard > Connect. Sandbox store = sandbox Dashboard credentials.

## Confirm live
1. Dashboard **Connect** > **Shopify**: store status `Successful`.
2. Shopify **Settings** > **Payments** > **Additional payment methods**: Peach Payments active, test mode not enabled.

## Deactivate / uninstall
Shopify **Settings** > **Payments** > **Peach Payments** section > **Deactivate** (removes the payment method; stop here to keep reactivation possible) > optionally **Uninstall** the app.

## Traps
- **Refunds: Shopify admin only** (Shopify's refunding-orders guide). The Peach Dashboard cannot inform Shopify of a refund — the customer is refunded but the Shopify order never learns of it.
- **Test-mode toggle post-live**: flipping it ON on a live store STOPS live processing and switches to test transactions. Use a standalone sandbox Shopify store instead.
- **Missing payment method at checkout = forgot Activate.** Fix: uninstall the app, relink the store, click **Activate** as the final step.
- PayPal: Shopify does not allow payment providers to accept PayPal via plugins — contact Shopify directly to enable it.
- `Not a valid store name` = custom domain entered; use the `<store>.myshopify.com` name.
- Instalment calculators (Payflex incl. Dawn-theme config, ZeroPay, Float, Happy Pay, Mobicred) are separate widgets.
- Capability comparison: [_matrix.md](_matrix.md); webhooks: `../webhooks.md`.
