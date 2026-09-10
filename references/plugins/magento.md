# Magento

## When to load
Magento 2 store; choosing traditional vs PWA plugin; subscriptions via ParadoxLabs; S2S card-on-site; one-click; webhook path; invisible-module cache issue.

## Capabilities
| Capability | Detail |
|---|---|
| Plugins | TWO: traditional plugin AND progressive web application (PWA) plugin. Rule: **custom frontend + Magento backend ⇒ PWA plugin** |
| Payment methods | All Checkout methods; all account currencies; SA/KE/MU |
| Flows | Redirect to Peach-hosted page; Embedded Checkout on-site; Server-to-Server card-on-site; **one-click payments** |
| Refunds | Full/partial (certain methods manual) |
| Recurring | Via the **paid ParadoxLabs Adaptive Subscriptions plugin** (Adobe Marketplace) + recurring entity ID; version support in the repo compatibility matrix |
| Sandbox | Yes — plugin ≥1.3.3 has **Get Sandbox credentials from Peach Payments** button |
| Webhooks | `https://{MAGENTO_BASE_URL}/pp-hosted/secure/webhook` |

## Install
- Repos (GitLab, org `p2886`): traditional `plugin-magento-v2` (composer install per readme), PWA `graphql-plugin-magento`, Venia-theme example `pwa-plugin-magento-v2`. PHP compatibility + events + GraphQL documented in the repo readme.
1. Retrieve sandbox + live credentials from Dashboard **Connect** > **Magento** (section appears only if Peach configured it for your account — else contact support).
   - From plugin 1.3.3: Magento admin > **Stores** > **Configuration** > **Sales** > **Payment Methods** > **Other payment methods** > **Peach Payments — Hosted All-in-One payment solution for emerging Africa markets.** > **API Configuration** > select **Mode** > click **Get Sandbox credentials from Peach Payments** or **Get Production credentials from Peach Payments** (jumps into the Dashboard Magento section).
2. Configure webhook: `https://{MAGENTO_BASE_URL}/pp-hosted/secure/webhook`.
3. Add your domain to the Peach allowlist (`Merchant domain not whitelisted` errors otherwise).
4. Install per the chosen repo's readme (composer for traditional).
5. Magento admin: **Stores** > **Configuration** > **Sales** > **Payment Methods**. Module not listed? **System** > **Cache Management** > **Flush Magento Cache**.

## Credentials
Dashboard Connect > **Magento**: standard Checkout credentials per mode. Subscriptions/one-click additionally need the **recurring entity ID** — recurring must be support-activated on the Peach account. Get customer permission before tokenising cards.

## Configure
All under **Stores** > **Configuration** > **Sales** > **Payment Methods** > **Other payment methods** > **Peach Payments — Hosted All-in-One…**:
- **API Configuration**: Mode = Production/Sandbox + the matching credentials. **Save Config** at the end.
- **Hosted Payment** (redirect): Enable = Yes; **Enable Consolidated Payments** = Yes; **Display Methods** selection; force-default-method option; **Show Sort Order Configurations** = Yes → number methods ascending from 1 (1 first); **Show Title Configurations** = Yes → custom labels incl. All Payments Title (default `More payment types - all payment methods`); **All Payments Display Description** on/off.
- **Embedded Checkout**: Enable = Yes + title. Warning: Embedded does not support certain payment methods (check Embedded limitations before promising coverage).
- **Server to Server** (card on checkout page): Enable = Yes; enter API credentials **incl. recurring entity ID** (step 10.2 prerequisite for one-click/subscriptions); select card types; **Enable Subscriptions** = Yes for ParadoxLabs — set **No** if NOT offering subscriptions.

## Subscriptions product setup
1. Prereqs: recurring entity ID entered + ParadoxLabs Adaptive Subscriptions installed.
2. **Server to Server** > **Enable Subscriptions** = Yes > **Save Config**.
3. **Catalog** > **Products** > open the product > expand **Subscription** section > Enable = Yes > set frequency, length, instalment price, adjustment price > **Save**.
- One-click only: recurring entity ID is enough; customers get "store card" option at card checkout.

## Traps

- **Magento 1.x**: past official EOL (2020) — no Peach plugin exists for M1, and running cards on
  an unsupported platform is a PCI/card-scheme posture problem the merchant owns. Route M1
  merchants to migration (M2 or headless + Checkout), never to extending M1.
- Custom frontend on the traditional plugin is the wrong tool — use the PWA plugin.
- Module invisible after install → flush cache before assuming a broken install.
- Subscriptions need BOTH the paid ParadoxLabs plugin AND the recurring entity ID; either alone fails. Non-subscription stores must set Enable Subscriptions = No explicitly.
- Embedded Checkout drops some payment methods vs Hosted.
- Merchant domain not allowlisted = payments blocked at checkout.
- Siblings: [_matrix.md](_matrix.md), `../webhooks.md`.
