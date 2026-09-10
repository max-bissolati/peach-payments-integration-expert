# Xero

## When to load
Xero accounting-connected invoice payments; Connect flow setup; invoice-number mangling (`INV-0003` → `0INV0003`); repeating invoices; template/account reconfiguration.

## Capabilities
| Capability | Detail |
|---|---|
| Scope | Xero invoices get a **Pay now** button → Peach Checkout screen → customer pays with any Checkout method configured on the account |
| Refunds | Invoice-level; not a plugin refund flow — handle via Peach Dashboard / manual |
| Recurring | **Repeating invoices supported** |
| Sandbox | **None** — no sandbox for Xero; live invoices from the start |
| Webhooks | Internal to the Peach ↔ Xero integration — no merchant webhook wiring |
| Auto-reconciliation | Xero automatically marks the invoice paid on payment; payments appear in Peach Dashboard **Transactions** |
| Activation | Account requires review by Peach Payments South Africa |

## Install
Prereq: using the OLD Peach Xero/PaySafe integration? Remove it first — Xero app launcher (waffle) > **Manage connections** > **Peach Payments** > **Disconnect**; then remove the payment service (Xero: business name > **Settings** > **Features** > **Payment services** > Peach Payments > Edit > **Remove**).
1. Log in to the Peach Dashboard.
2. **Connect** > **Add connection** > **Xero** > **Add connection** > **Connect now**.
3. Xero login screen: email + password > **Log in**; if multiple organisations, select the right one > **Allow access**.
4. Back in the Peach Dashboard: select a **Xero invoice template**, a **payment account**, and a **fee account** from the lists.
5. Click **Save changes**.
6. Confirm: Xero app launcher > **Manage connections** — Peach Payments listed.

## Credentials
OAuth Connect flow — no manual credential entry. Disconnect permissions: only Dashboard users with the **owner, admin, or developer** role.

## Pay-an-invoice flow
1. Customer opens the Xero invoice (link or emailed invoice) and clicks **Pay now**.
2. Clicks **Pay Now** again → Peach Checkout screen → completes payment.
3. Xero automatically marks the invoice paid; the transaction appears in the Peach Dashboard.

## Reconfiguration
Changing the **invoice template, payment account, or fee account** later is NOT editable in place — disconnect (**Connect** > **Add connection** > **Xero** > **Disconnect** > confirm) and reconnect, reselecting the three settings. Removing the payment service from Xero itself: Xero **Settings** > **Features** > **Payment services** > Peach Payments > Edit > **Remove**.

## Traps
- **Invoice-number mangling**: Peach strips special characters and prepends `0`s to 8 characters for `merchantTransactionId` (some payment methods reject special chars). `INV-0003` → `0INV0003`. Build reconciliation mappings against the MANGLED form, never the raw Xero number.
- No sandbox: first payment is production — **the merchant (not the agent)** verifies with a minimal real invoice; this is real money, so it falls under the SKILL.md write gate.
- Template/payment/fee account changes force disconnect/reconnect — schedule it; invoices during the gap lose Pay now.
- Old PaySafe-era integration left connected conflicts with the new service — remove it before connecting.
- Only owner/admin/developer roles can disconnect — check permissions before reconfiguration windows.
- Invoices without Xero route to [../payment-links.md](../payment-links.md); comparison: [_matrix.md](_matrix.md).
