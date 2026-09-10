# PCI and Security

## When to load
Load for security reviews, key/credential handling, any PCI question, and always BEFORE building an S2S card flow.

## 1. SAQ A is the target

Design goal: the merchant's PCI scope stays minimal. Every Peach hosted surface exists to keep card data away from your servers.

| Integration type | Card data touches | SAQ level |
|---|---|---|
| Checkout Embedded / Hosted, Payment Page, COPYandPAY widget, official extensions | Peach-hosted fields only (browser → Peach direct) | **SAQ A** *(stated for COPYandPAY in Peach's docs; the same hosted-fields logic extends it to Checkout surfaces — confirm your acquirer's assessment)* |
| S2S / Payments-style raw card data (OPPWA server-to-server) | Your server (PAN enters your systems) | **SAQ A-EP / SAQ D** — full PCI DSS scope |
| MOTO (Dashboard virtual terminal) | Peach Dashboard; merchant keyed-in channel | **SAQ C-VT** (approved channel; role-gated) |

Levels by e-commerce volume (docs): L1 >6M / L2 1–6M / L3 20k–1M / L4 below. PCI DSS 4.x applies since 2024-03-31.

**Challenge the S2S instinct:** "card fields on my own site" costs SAQ A-EP/D (network scanning, script controls, full policy suite). Embedded Checkout gives the on-site look at SAQ A. Recommend S2S raw card only when a hard requirement forces it — and say the compliance cost out loud.

**Customer-facing copy you may reuse (docs' own positioning):** Peach is a PCI DSS v4.x Level 1 compliant service; cardholder details are transmitted directly from the customer's browser to Peach Payments (merchant servers never see them on hosted surfaces).

## 2. Credential governance

| Credential | Scope / used for | Where it surfaces in Dashboard | Browser-safe? |
|---|---|---|---|
| **Entity ID** (`authentication.entityId`, ≤32 chars, channel-scoped) | Checkout creation + SDK `key`; limits currencies/methods per channel | Checkout → API keys | **Semi-public** — it is the SDK key; never a secret, but don't scatter it |
| **Secret token** | HMAC-SHA256 key for webhook signatures **and** V1 refund signing — needed even if webhooks are unused | Checkout → API keys | **NO — secret** |
| **Client ID + Client secret** (+ **Merchant ID**) | OAuth `POST {auth}/api/oauth/token` bearer for Checkout/Links/Payouts/Recon APIs | Dashboard → per-product API keys | **NO — secret** |
| **Payments API user ID + password** (32-hex user) | Auth-in-body for S2S `api-v2` calls | Dashboard → Payments API → API keys (support-activated) | **NO — secret** |
| **Recurring ID + recurring access token** | Recurring debits on registrations (separate from Checkout creds) | Via support activation; recurring section | **NO — secret** |
| **Webhook signing secret** (Scheme B header signing) | `x-webhook-signature` verification | Dashboard → Webhook security | **NO — secret** |
| **Payments API webhook AES key** | AES-128-GCM body decryption (per-webhook secret) | Payments API webhook config | **NO — secret** |
| **Svix signing secret** (Payouts) | Svix-signed payout webhooks | From Peach support | **NO — secret** |
| MOTO credentials | Virtual terminal | Dashboard (role-gated) | No merchant-callable MOTO API — the Dashboard "API credentials" authenticate the channel, not a public endpoint; the virtual terminal is the only integration path `[DOCS]` |

Rules: credentials from env/secret store, never in code or repo. Entity ID may ship to the browser (it's the `key`); everything else stays server-side. Frontend calls to OAuth or checkout-creation endpoints = CORS errors and credential exposure — always backend.

## 3. Prohibited data (never store, never log)

Executable rule list — if your code writes any of these to DB, disk, logs, or analytics, fix it:

- **Raw PAN** (full card number) on hosted/embedded flows it never arrives; on S2S it must not persist. Store `registrationId` / network token instead — tokenise (`createRegistration=true`), don't archive cards.
- **CVV/CVC after authorisation** — prohibited by PCI DSS, full stop, even with tokenisation.
- **Track data** (magstripe equivalent) — never received via Peach surfaces; never accept it from anywhere else.
- Sensitive authentication data in logs: full 3DS cryptograms, PIN blocks.
- Status/webhook payloads can carry masked card PII (`card.bin`, `card.last4Digits`, holder) — whitelist fields you persist; never spread the raw payload into your DB. `[PLUGIN-VERIFIED]`

## 4. PCI DSS 4.x payment-page script controls

If you render any payment page with custom UI (Embedded on your pages, custom result pages):

- **Req 6.4.3** — every script loaded on the payment page must be: authorised (confirm each script is legitimate, via manual or automated process), integrity-assured (e.g. SRI), and inventoried with written justification per script. Docs' listed techniques: manual/automated script authorisation, Subresource Integrity (SRI), CSP limiting script loading + data transmission, proprietary tag-management controls.
- **Req 11.6.1** — change/tamper detection on payment-page scripts and headers — required since 2025-03-31. Docs' listed techniques: embedded tamper-detection scripts, reverse proxies/CDNs that detect script changes.
- **CSP recommended** as the enforcement mechanism. Peach publishes directives for its checkout scripts:
  - `https://secure.peachpayments.com/.well-known/csp-config.txt` (and `.json`)
  - sandbox equivalent from `sandbox-checkout.peachpayments.com` per Embedded SDK docs — copy the published directives into your CSP rather than hand-guessing domains.

## 5. Secret hygiene rules for agents

- **Never echo secrets into the transcript, logs, or code comments.** When displaying config, mask: `PEACH_CLIENT_SECRET=****` (show last 4 max, only if the user asks).
- **Detect exposed keys in code.** Grep patterns worth running on any repo you touch:
  - `entityId|entity_id` hard-coded with a 32-hex value in frontend bundles (informational — semi-public)
  - `secret[_-]?token|client[_-]?secret|password` near `peach` (case-insensitive), hex strings ≥32 chars assigned to constants
  - `PEACH_` env names committed with literal values in `.env` checked into git, or defaults in source
  - webhook secret / AES key / Svix secret strings in config files
- **Rotation runbook** (when a secret leaked or a dev left):
  1. Regenerate in Dashboard: secret token (immediate — old signatures fail at once), client secret, Payments API password.
  2. Update the secret store/env in all environments (sandbox and live are separate creds).
  3. Redeploy/restart consumers; webhook endpoint starts failing signatures until updated — expect retries (30-day schedule), they succeed after the fix.
  4. Search logs/backups for the leaked value; purge where possible.
  5. Regenerating the Scheme B webhook secret is immediate — coordinate deploy windows.
- **MOTO liability:** MOTO bypasses 3DS by design; the **merchant bears chargeback liability**. Never propose MOTO to circumvent 3DS. PA via MOTO must be captured within 7 days.
- PCI audit scoping for non-Peach flows: out of this skill's scope — say so.

## Traps
- Treating the entity ID as a secret (it isn't) or the secret token as Checkout-only (it signs refunds too — "refunds need it even if you never wire up webhooks"). `[PLUGIN-VERIFIED]`
- Thinking SAQ A applies because "we use Peach" — true only while card data stays on Peach surfaces; one raw-card S2S endpoint moves you to A-EP/D.
- Logging full webhook/status bodies: masked card PII + signatures end up in logs; whitelist fields. `[PLUGIN-VERIFIED]`
- Committing `.env` with live creds because sandbox "works" — sandbox and live credential sets are distinct; a leaked sandbox set is still a rotation.
- Forgetting 6.4.3/11.6.1 apply to YOUR pages that host the Embedded widget, not just to Peach's pages.
- Citing the docs' best-practices page as a security checklist — it is nearly empty; this file is the checklist.
