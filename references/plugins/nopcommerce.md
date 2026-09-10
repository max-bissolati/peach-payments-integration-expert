# nopCommerce

## When to load
nopCommerce store connecting Peach Payments; plugin ZIP install; "Checkout Channel" credential naming; support-configured webhooks.

## Capabilities
| Capability | Detail |
|---|---|
| Payment methods | All Checkout methods; all currencies configured for the account; SA/KE/MU |
| Refunds | **No plugin refunds** (no full or partial). Log offline in nopCommerce, then refund manually or via the Peach Payments Dashboard |
| Recurring | No — once-off only |
| Sandbox | Yes — **Sandbox Mode** Enabled/Disabled toggle; sandbox and live Checkout Channel + Secret Token pairs |
| Webhooks | NOT self-serve — send your callback URL to Peach support; they configure it |
| Activation | Account requires review by Peach Payments South Africa |

## Install
1. Browse to `https://www.nopcommerce.com/en/peach-payments`, log in to your nopCommerce account, click **GET EXTENSION** — the plugin ZIP downloads.
2. nopCommerce admin: **Configuration** > **Local plugins** > **Upload plugin or theme** > **Choose File** > select the ZIP > upload.
3. **Configuration** > **Local plugins** > click **Install** in the **Peach Payments** row.

## Credentials
**Checkout Channel** (Peach's entity ID — Peach renames this credential per extension) + **Secret Token**, each in sandbox and live variants — both received **from Peach support**, not from Dashboard Connect self-serve. Enter under: admin > **Configuration** > **Payment methods** > **Peach Payments** row > **Configure**.

## Webhook wiring
No documented URL format. Send your store's callback URL to support (support ticket) — they register it for you. Go-live timing must budget for this round-trip.

## Configure
1. **Configuration** > **Payment methods** > **Peach Payments** > **Configure**.
2. Testing: set **Sandbox Mode** = **Enabled** (choose live credentials by leaving it disabled).
3. Enter **Checkout Channel** and **Secret Token** for the selected mode.
4. Send the callback URL to support for webhook configuration.
5. Click **Save**. Verify Peach Payments appears at checkout; execute test purchases.

## Traps
- Credentials come via a support ticket, not the Dashboard Connect UI — expect latency for BOTH sandbox and live pairs; request early.
- Webhook registration is support-side; payments can succeed while nopCommerce order states never update until the webhook is configured — test an end-to-end order after support confirms.
- **Sandbox Mode** toggle selects which credential pair is used; wrong toggle with valid creds produces "unconfigured" behaviour, not auth errors.
- No plugin refunds: the nopCommerce offline record and the Peach Dashboard refund are separate actions — reconcile manually.
- Entity ID naming variance across Peach extensions (this one calls it "Checkout Channel") — see [_matrix.md](_matrix.md); webhook schemes in `../webhooks.md`.
