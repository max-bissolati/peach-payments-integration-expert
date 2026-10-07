# Documentation audit, 2026-10-07

This update adds custom point-of-sale integration guidance and corrects material changes found
while comparing the current public developer index/pages with the September documentation
mirror. It also checks the Orchestration documentation and the unchanged OpenAPI snapshot.
The audit retrieved 208 indexed sources; Gravity Forms returned HTML rather than usable Markdown.
The nine directly linked POS guides were checked separately because the index omits them.
This is a documentation review, not a certification of all historical claims or a sandbox test.

## Changes applied

| Area | Result and source |
|---|---|
| Product selection | New custom online integrations route to Orchestration. Classic Checkout and Payments API remain documented for existing users. [Portfolio](https://developer.peachpayments.com/docs/product-portfolio-overview) |
| POS REST | Separate till sends sales, polls by request ID and refunds through its backend. Integer cents, merchant key, operation-specific results. [API](https://developer.peachpayments.com/docs/pos-integrations-api) |
| POS Intent | Same-terminal Android app uses Peach's Payment App for sales, refunds, voids and lookup. [Flows](https://developer.peachpayments.com/docs/terminal-integration-flows) |
| POS recovery | Authenticated JSON notifications, multiple attempts per request, durable duplicate prevention and reconciliation. Older webhook-page polling claim conflicts with the newer REST guide. [Webhooks](https://developer.peachpayments.com/docs/pos-instore-webhooks) |
| Expo/SUNMI | Conditional Expo architecture with native Kotlin module, device proof of concept, peripherals and signed APK rollout. [Deployment](https://developer.peachpayments.com/docs/pos-deploy-sunmi) and sources in `references/pos-expo-sunmi.md` |
| PayJustNow | Embedded/Hosted Checkout support, `PAYJUSTNOW`, customer email, full/partial refunds and sandbox enrolment. Machine-readable catalogue updated. [Release](https://developer.peachpayments.com/changelog/checkout-payjustnow-2026-10-01) |
| Payout recovery | Distinguish provider request ID from merchant payout ID; query the latter after a lost create response and tolerate initial 404. [Endpoint](https://developer.peachpayments.com/reference/querypayoutrequestbypayoutid) |
| Payout bank | Bank Zero - Mukuru branch `435000` is distinct from Mukuru via Access `410506`. [Banks](https://developer.peachpayments.com/docs/peach-payouts#supported-banks) |
| Bulk payouts | Spreadsheet uses rands while API uses cents; retain all columns and retry only rejected rows. [Dashboard](https://developer.peachpayments.com/docs/payouts-dashboard) |
| Test data | Corrected RCS test card and added PayJustNow sandbox requirements. [Testing](https://developer.peachpayments.com/docs/reference-test-and-go-live) |
| Dashboard | Always-required 2FA, reset enrolment semantics, MOTO Reserve funds and proof documents. [Settings](https://developer.peachpayments.com/docs/dashboard-settings), [MOTO](https://developer.peachpayments.com/docs/dashboard-moto) |
| Orchestration SDKs | Updated RN package to `@peach-payments/react-native`, mobile package versions, Web SDK CDN and October behavior changes; corrected key-prefix and Android-minimum assumptions. [Release notes](https://playground.peachpayments.com/docs/release-notes) |
| Orchestration Dashboard | Added pages reviewed: consolidated business views, custom deposit references and network-specific advice-code tables qualify older guidance. PayPal billing disagreement is preserved in reconciliation guidance. |
| Existing facts retained | BANV company registration support was already present; authentication and Shopify changes mostly concern labels/screenshots. No contract rewrite inferred from formatting churn. |

## Freshness checker

The previous script compared only `llms.txt` and silently accepted a first live response as its
baseline. That could report OK without comparing to the skill's historical source. POS pages were
also absent from the live index, so even index stability could miss their changes.

The replacement uses source-specific hashes in `scripts/docs-baseline.json`. The default checks
index membership; `--deep` checks tracked page bodies. Network failure is UNKNOWN, not fresh.
Ordinary checks never write a baseline. Acceptance requires a saved, reviewed source file and a
review note. Detection identifies source changes; it never rewrites knowledge automatically.

The tracked list is curated. It is not an exhaustive subscription to every Peach, Expo or SUNMI
page. Recheck the exact source and native dependency versions when implementing a new app.

## v0.8.0 expansion

Added a network-tokenisation guide and an Orchestration build playbook using current public
provisioning, API-only, recurring, webhook and OpenAPI sources. The guides separate classic
registration IDs from network tokens, customer-present consent from off-session use, and
processor routing from guaranteed token portability. Source contradictions remain explicit.

The reviewed freshness baseline now tracks 35 sources. A live deep check reported zero changed
and zero unavailable sources. An independent forward test rejected unsafe token reuse and
unsupported assumptions about authentication, migration and recurring scheduling.

## Verification and limits

- Skill frontmatter validation and the doctor suite passed: 194 JavaScript tests, 16 freshness regressions,
  405 reference-data assertions, 40 reference structure checks and 36 internal links. Actual generated
  doctor output was inspected for product routing and amount units.
- The freshness checker has offline tests for unchanged index with changed content, unavailable
  sources, missing baselines, rejection of HTML fallback, and explicit baseline acceptance.
- Independent source review checked POS contracts. A forward-test plan correctly selected Intent
  for a same-device Expo app, rejected client merchant secrets, recovered interrupted payments,
  and distinguished documented Intent voids from undocumented REST roadmap capabilities.
- No terminal, credentials or UAT account was used. No POS app was built, and no card sale, refund,
  void or deployment was performed. GitHub publication is separate from payment runtime validation.
- Exact terminal/firmware/native-module compatibility and receipt/scanner behavior require physical
  UAT. Public gaps include REST idempotency/rate limits, complete webhook schema, ambiguous refund
  recovery and availability outside the documented South African terminal flow.
- Gravity Forms Markdown retrieval returned an HTML fallback, so its changes were not treated as verified contract changes.
- The POS references explicitly preserve source contradictions. A hash match does not resolve a
  contradiction or prove runtime behavior.
