# Platform routing matrix

## When to load
FIRST file for any "which platform/plugin/extension" question. Route here before opening any platform file.

Peach ships official extensions. Install beats build for standard flows. Load the platform file after this.

## Capability matrix
| Platform | Refunds | Recurring | Sandbox | Webhooks | Verdict → file |
|---|---|---|---|---|---|
| WooCommerce | Full/partial via Woo (some methods manual) | Yes — Woo Subscriptions (Recurring ID + Card Webhook Decryption key from support; Enable Card Storage) | Yes — Integrator Test mode | `<domain>/?wc-api=wc_switch_webhook_peach_payments` | Fullest-featured extension — subscriptions capable → [woocommerce.md](woocommerce.md) |
| Shopify | From **Shopify admin only** (never Peach Dashboard) | No — once-off only | Test-mode toggle; use a separate sandbox store (flipping Test ON post-live stops live processing) | Dashboard-configured generic webhook | Official app via Dashboard Connect — must click **Activate** → [shopify.md](shopify.md) |
| Magento | Full/partial (some manual) | Yes — paid ParadoxLabs Adaptive Subscriptions + recurring entity ID | Yes (v1.3.3+ "Get Sandbox credentials" button) | `https://{base}/pp-hosted/secure/webhook` | Two plugins (traditional vs PWA — custom frontend ⇒ PWA); GitLab repos → [magento.md](magento.md) |
| Wix | No plugin refunds — log offline in Wix + refund manually / Peach Dashboard | No | No sandbox | No webhooks | Minimal: Entity ID only, one base currency (ZAR base ⇒ no PayPal), premium plan → [wix.md](wix.md) |
| Ecwid | No plugin refunds — offline + manual/Dashboard | No | Yes — separate sandbox/live creds | Dashboard-configured generic webhook | Dashboard Connect flow; Ecwid Venture plan+ → [ecwid.md](ecwid.md) |
| nopCommerce | No plugin refunds | No | Yes — Sandbox Mode toggle | Via support (send callback URL) | ZIP upload install; Checkout Channel + Secret Token from support → [nopcommerce.md](nopcommerce.md) |
| OpenCart | No plugin refunds | No (no one-click either) | Yes — Sandbox Mode | Via support | Extension store id 43757; Modifications Clear+Refresh; unique Traces audit tab → [opencart.md](opencart.md) |
| Gravity Forms | Full/partial (some manual) | No | Yes — Integrator Test | Not plugin-specific | WordPress form payments; ZIP install; Secret Token + 3DSecure Channel ID → [gravity-forms.md](gravity-forms.md) |
| SBTech | No — manual via Peach | — | Dedicated `/checkout/sbt`, `/status/sbt` endpoints | Handled by SBTech | Betting platform; credentials handed to SBTech under their naming → [sbtech.md](sbtech.md) |
| Xero | Invoice-level | Repeating invoices supported | No sandbox | Internal to integration | Invoice payments via Pay now → Checkout; auto-marks paid; invoice-number mangling → [xero.md](xero.md) |
| Take App | `[VERIFY-SANDBOX]` | `[VERIFY-SANDBOX]` | Live only | `[VERIFY-SANDBOX]` | Off-site docs at help.take.app; Checkout credentials → [take-app.md](take-app.md) |
| Medusa | V1 refund endpoint (implemented) | `createRegistration` only; BYO scheduler | Yes | `/hooks/payment/peach_checkout` → provider `pp_peach_peach` | Official community plugin (npm `medusa-payment-peach-payments`) → [medusa.md](medusa.md) |
| Custom build | Per API chosen | BYO scheduler (tokenise + own billing loop) | Yes | Scheme A (Checkout) / Scheme B (Links) / AES-GCM (Payments API) | No extension fits → [../products-and-routing.md](../products-and-routing.md) |

## Extension-wide facts (apply to every row)
- All extensions are Checkout-based; countries SA/KE/MU; all account currencies unless stated (Wix = one base currency).
- Credentials come from Dashboard **Connect**; the platform's section appears once you OR Peach configured it for the account (the extension hub also notes activation involves review by Peach SA — both framings appear in the docs); otherwise contact support. Exceptions: nopCommerce/OpenCart/SBTech source credentials via support tickets.
- Most extensions require account activation review by Peach Payments South Africa.
- Instalment calculators (Payflex/ZeroPay/Float/Happy Pay/Mobicred) are per-extension storefront widgets distributed separately (get.peachpayments.com), not plugin settings.
- Sandbox limitations apply per product, not per extension: Payment Links sandbox = email only; Wix + Xero have NO sandbox at all.

## Entity ID naming variants (same credential, different labels)
| Platform | Label used |
|---|---|
| WooCommerce / Shopify / Ecwid / Wix / Magento | Entity ID |
| nopCommerce | Checkout Channel |
| OpenCart | checkout channel ("sometimes called the Entity ID") |
| Gravity Forms | 3DSecure Channel ID |
| SBTech | API merchant reference |

When an integration fails auth on any extension, first confirm which label maps to the entity ID and which secret pairs with it — mismatches here are the top support driver. Refund method matrices per extension live in each platform file; webhook signing schemes: `../webhooks.md`; product-level routing: `../products-and-routing.md`.
