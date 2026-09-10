# Gravity Forms

## When to load
WordPress + Gravity Forms payment collection (order/donation forms); add-on ZIP install; feed configuration; "3DSecure Channel ID" credential naming; Integrator Test mode.

## Capabilities
| Capability | Detail |
|---|---|
| Scope | Once-off payments on Gravity Forms forms via Peach Checkout methods (Pricing Fields based) |
| Refunds | Full/partial (certain payment methods manual) |
| Recurring | No — once-off only |
| Sandbox | Yes — sandbox credentials + **Transaction Mode: Integrator Test**; Live for production |
| Webhooks | No plugin-specific webhook documented; standard Dashboard webhook configuration if needed (`../webhooks.md`) `[VERIFY-SANDBOX]` whether the add-on consumes a webhook endpoint |
| Activation | Account requires review by Peach Payments South Africa |

## Install
1. Download the Peach Payments add-on ZIP from the Peach Payments website.
2. WordPress admin: **Plugins** > **Add New Plugin**.
3. Top of page: **Upload Plugin** > **Choose File** > select the ZIP > **Open** > **Install Now**.
4. Click **Activate Plugin** — the add-on is now active.

## Credentials
From the Peach Payments Dashboard Checkout section (if you lack access or can't find credentials, contact support). Entered at WordPress admin: **Forms** > **Settings** > **Peach Payments** tab:
- **Secret Token**
- **3DSecure Channel ID** — this IS the entity ID under a different name (Peach renames the same credential per extension).
Set **Transaction Mode** = **Integrator Test** (sandbox testing with sandbox credentials) or **Live**. Click **Save Settings**.

## Configure (form + feed)
1. Create/edit the form: right panel > expand **Pricing Fields**.
2. Drag the needed fields onto the form — the **Product** and **Total** fields are MANDATORY. Click **Save Form**.
3. Create the feed: **Forms** > **Forms** > hover the target form > **Settings** > **Peach Payments** > **Add New**.
4. Enter a feed name; select transaction type **Products and Services**; set **Payment Amount** = **Form Total**; map remaining fields under **Other Settings**; **Save Settings**.
5. Embed the form: create/edit the WordPress page, place the form block/shortcode at the payment position.

## Webhook wiring
No Gravity Forms-specific URL in the docs — the add-on works via the return flow. If independent server-side confirmation is required, configure the standard Dashboard webhook and verify against your own endpoint (schemes: `../webhooks.md`).

## Traps
- Form without **Product** + **Total** fields cannot charge — the feed's Form Total source is missing.
- Feeds are PER FORM — every new form needs its own Peach Payments feed; a missing feed = no payment option on that form.
- "3DSecure Channel ID" is the entity ID — don't hunt for a separate 3DS credential.
- Transaction Mode left on **Integrator Test** after go-live = live cards "succeed" as test transactions with no money moved.
- Feed transaction type must be **Products and Services** with Payment Amount **Form Total** — other combos are undocumented.
- WooCommerce is the fuller-featured WordPress option (subscriptions capable) — see [woocommerce.md](woocommerce.md) and [_matrix.md](_matrix.md).
