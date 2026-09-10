# Ecwid

## When to load
Ecwid store connecting Peach Payments; sandbox/live credential separation; Google Sites embed redirect failure; plan requirements.

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods; all currencies configured for the account; SA/KE/MU |
| Refunds | **No plugin refunds** (no full or partial). Log with Ecwid's offline refund feature, then refund manually or via the Peach Payments Dashboard |
| Recurring | No — once-off only |
| Sandbox | Yes — **separate sandbox and live credentials**, both stored side by side in the Ecwid config; per-environment selection |
| Webhooks | Configure per the generic Peach webhook docs (Dashboard webhook configuration) |
| Plan gate | Ecwid **Venture plan or higher** required |
| Activation | Account requires review by Peach Payments South Africa |

## Install
1. Peach Dashboard: **Connect** > **Add connection** > **Ecwid** > **Add connection** (confirm through the **Add Ecwid connection** prompts).
2. In the **Ecwid** section click **Settings** — note the **entity ID** and **secret token**.
   - Sandbox credentials: switch to the **sandbox Dashboard** and take them from the Ecwid settings section there.
3. Ecwid control panel: **Payment** (left navigation) > **Add new payment methods** > **Choose Payment Method** > **Peach Payments Gateway**.
4. In the **New payment method: Peach Payments Gateway** window click **Add Payment Method**.
5. Select test (sandbox) or live; enter **Sandbox entity ID** + **Sandbox secret token** and/or **Live entity ID** + **Live secret token**.
6. Click **Save**. Configure a webhook per the Peach webhook docs.
7. Verify: Peach appears under **Current payment methods**; toggle on = accepting payments.

## Credentials
From Dashboard **Connect** > **Ecwid** > **Settings**: entity ID + secret token in BOTH sandbox and live variants — Ecwid keeps both pairs in one panel.

## Disable / remove
- Disable temporarily: **Payment** > **Current payment methods** > Peach Payments toggle off (grey).
- Remove entirely: **Payment** > **Current payment methods** > **Actions** > **Remove**. Re-adding = repeat the configuration process.

## Webhook wiring
No Ecwid-specific URL documented; use the standard Dashboard webhook configuration (schemes: `../webhooks.md`).

## Traps
- **Google Sites embeds cannot redirect to checkout.** An Ecwid store or cart embedded in a Google Sites page breaks the payment redirect; use Ecwid's Instant Site instead.
- Plan gate: Peach Payments is not offered on Ecwid plans below Venture.
- Both credential pairs live in one panel — a sandbox pair entered while "accept real payments" is selected breaks live checkout (and vice versa).
- No plugin refunds: Ecwid offline log + Peach Dashboard refund are two separate manual actions.
- Siblings: [_matrix.md](_matrix.md).
