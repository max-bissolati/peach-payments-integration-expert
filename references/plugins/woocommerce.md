# WooCommerce

## When to load
WordPress/WooCommerce store needs Peach Payments; questions about Woo Subscriptions recurring, V4 upgrade, webhook path, Integrator Test mode, or Divi/Thrive theme errors.

## Capabilities
| Capability | Detail |
|---|---|
| Plugin | "Peach Payments Gateway", V4 current. ⚠️ version-sensitive — **no V4→V3 rollback**; V4 is a new plugin with different configuration |
| Payment methods | All Checkout methods (must be activated on your Peach account); all currencies configured for your account; countries SA/KE/MU |
| Payment flow | Customer chooses Peach Payments at checkout → redirected to Peach **Hosted Checkout** → back to the order confirmation page; order created in the backend |
| Refunds | Full/partial via WooCommerce (certain payment methods must be refunded manually) |
| Recurring | Woo Subscriptions: needs **Recurring ID** (from support) + **Enable Card Storage**; logged-in customers save cards for future use (customer permission required before tokenising) |
| Sandbox | Yes — sandbox Dashboard credentials + **Transaction Mode: Integrator Test** |
| Webhooks | Yes — `<your-domain>/?wc-api=wc_switch_webhook_peach_payments` |
| Activation | Account requires review by Peach Payments South Africa |

## Install
1. Log in to the WordPress administration dashboard.
2. **Plugins** > **Add Plugin**.
3. Search **Peach Payments Gateway** in the plugin search bar > **Install Now**.
4. When installation completes, click **Activate**.
- Upgrade (V3 → V4): **Plugins** > find **WooCommerce Peach Payments Gateway** > **update now**. Back up the site and test V4 in staging BEFORE upgrading live — there is no rollback.

## Credentials
Dashboard **Connect** > **WooCommerce** (section only appears if configured for your account — else contact support). For sandbox: switch to the sandbox Dashboard FIRST and take the WooCommerce-section credentials from there.
Under **API Keys** enter all six: **Entity ID**, **Access Token**, **Secret Token**, **Client ID**, **Client Secret**, **Merchant ID**. Recurring additionally needs **Recurring ID** (support provides it; request recurring payments activation).

## Configure (exact paths)
1. **WooCommerce** > **Settings** > **Payments**.
2. Drag the Peach Payments row to the top of the payment-provider list (top of checkout page).
3. Click **Manage** next to Peach Payments.
4. **Enable/Disable** toggle; **Transaction Mode** = **Integrator Test** (sandbox) or **Live** (production).
5. Configure title, description, redirect notice message if defaults are unwanted.
6. **Payment Logos**: select logos to display on the storefront (methods must be activated on the account).
7. Enter the six API keys; enter **Recurring ID** if accepting subscriptions.
8. Select **Enable Card Storage** to let logged-in customers save cards.
9. **Order Status**: choose the status set for successful payments.
10. Click **Save changes**.
11. Add your domain to the Peach allowlist (Dashboard **Connect** > allowlisted domains).

## Webhook wiring
Dashboard webhook configuration → URL format `<your-domain>/?wc-api=wc_switch_webhook_peach_payments`. If subscriptions are used, also get the **Card Webhook Decryption key** from support and enter it in the plugin's relevant field. Webhook verification background: `../webhooks.md`.

## Traps
- Upgrading to V4 is one-way — no V3 rollback; staging first.
- `Legacy fields are missing` error = one of the six API keys not configured.
- Subscriptions silently missing unless ALL THREE are in place: Recurring ID + Card Webhook Decryption key + Enable Card Storage.
- Divi/Thrive themes: known `No fast checkout brands defined` / `It appears that <site> is not yet ready to accept payments` errors (support KB articles).
- `Error [CURL] ... 401` during checkout — Peach's support article attributes it to pasting the word "Bearer" into the Access Token field (enter the token bare); also re-check keys and the domain allowlist. Two causes, one documented, one defensive.
- SSL warning = HTTPS not enabled on the store.
- Logs for support: **WooCommerce** > **Status** > **Logs** tab > select logs > Bulk actions > **Download** > send to Peach.
- Instalment calculators (Payflex/ZeroPay/Float/Happy Pay/Mobicred) are separate widgets/plugins, not plugin settings.
- Plugin docs also at wordpress.org `wc-peach-payments-gateway`; capability comparison in [_matrix.md](_matrix.md).
- Some errors are plugin-version bugs, not your config: a `Card registration could not be verified. Please try again.` message where the card actually *did* save (check the Dashboard before retrying), or a subscription renewal / change-payment-method failing with `Unable to retrieve the payment redirect URL`. If you hit these, update to the latest plugin version and re-test before debugging your own setup.
