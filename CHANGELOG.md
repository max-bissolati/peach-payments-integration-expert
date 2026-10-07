# Changelog

## Unreleased, 2026-10-07

- Added `AGENTS.md` with maintenance, source review, product-boundary, verification and release
  guidance drawn from the v0.8.0 work and publication corrections.

## 2026-10-07, v0.8.0 publication correction

- Restored the custom README banner, status badges and collapsible freshness section while keeping
  current product guidance. Updated the banner for POS, Orchestration and network tokens.
- Aligned GitHub release publication with `VERSION`; README now links to the latest release.

## 2026-10-07, v0.8.0

- Added a dedicated network-tokenisation guide separating vault IDs, scheme tokens and wallet
  credentials, with provisioning, CIT/MIT, cryptogram, lifecycle and migration guidance.
- Added an Orchestration build playbook covering product selection, saved cards, routing,
  authentication, recovery and acceptance evidence. Corrected classic-only recurring guidance,
  token/3DS assumptions and partial-capture qualifications.
- Reworked the README around current capabilities, product boundaries and verification limits;
  added `VERSION` and Orchestration/POS hosts to machine-readable data.
- Hardened health checks so failed processes cannot pass through success text, and validate the
  real freshness baseline offline. Removed generated Python bytecode from the package.
- Includes the POS and documentation-audit work below. No terminal, acquirer or token-provisioning
  runtime certification is claimed.

## 2026-10-07, v0.7.0

- Added POS REST and same-device Intent integration references, including custom Expo/SUNMI
  architecture, native bridge, peripherals, recovery, UAT and distribution guidance.
- Corrected product routing, PayJustNow support, payout lookup/bulk units, RCS test data and
  Dashboard changes against current public documentation. Preserved separate product contracts.
- Replaced first-run/index-only freshness assumptions with explicit reviewed source baselines and
  an optional content check that includes POS pages missing from the index.
- Added independent POS review and forward testing; kept physical-device validation explicitly
  unverified. See `docs-audit-2026-10-07.md` and `references/versions.md`.

Earlier releases are recorded in `references/versions.md`.
