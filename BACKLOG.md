# Backlog

## What's next

Validate the selected product in a real implementation. For new online work, use
`references/playbooks/orchestration-build.md`; for network tokens, confirm the connector/TSP
arrangement and run `references/network-tokenisation.md` acceptance cases. Documentation review
cannot establish merchant enablement, provisioning or cross-connector portability.

When an actual POS app build is requested, confirm same-device versus separate-till deployment,
exact terminal and firmware, country/currency, UAT access and peripherals. Build a bounded Expo
proof of concept using `references/pos-expo-sunmi.md`, then execute its physical-device matrix.

## Follow-ups

- Obtain Peach confirmation for undocumented REST idempotency/rate limits and refund recovery;
  verify full webhook envelope and correlation against UAT (`references/pos-integrations.md`).
- Resolve documented POS polling, error-name and recovery contradictions using current SDK/UAT
  evidence; preserve uncertainty until verified (`references/pos-expo-sunmi.md`).
- Extend the curated source baseline when maintaining additional surfaces; index membership is
  not a complete page-content audit (`scripts/docs-baseline.json`).
- If a POS implementation is added later, add product-specific tooling and executable examples.
  Existing online verifier/preflight/linter scripts do not validate POS readiness (`SKILL.md`).

- Advice-code helpers retain legacy Mastercard-style numeric mappings. Resolve network/connector
  before use; add network-aware behavior if automated dunning needs it (`references/result-codes.md`).
