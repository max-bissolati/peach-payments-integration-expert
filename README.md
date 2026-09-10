# peach-payments-integration-expert

An AI-agent skill that makes integrating Peach Payments (Checkout, Payment Links, Payments API,
recurring/tokenisation, payouts, reconciliation, and the official platform extensions) fast and
safe — for any agent stack that supports SKILL.md skills (Claude Code, Cursor, and similar).

Unofficial and community-built. Everything here derives from **public documentation**
(developer.peachpayments.com and playground.peachpayments.com, mirrored 2026-09-07) and the open-source
**`medusa-payment-peach-payments`** community plugin. No non-public material.

## What it does

- **Discovery first** — asks platform/product/currency/recurring questions before recommending
  anything (`references/discovery.md`).
- **Plugin-first routing** — steers WooCommerce/Shopify/Magento/Wix/Ecwid/nopCommerce/OpenCart/
  Gravity Forms/Xero/Medusa users to the official extension instead of custom code.
- **Verified patterns** — webhook signature verification (both schemes), fail-closed result-code
  mapping, amount-unit rules, amount-integrity gating; all marked `[PLUGIN-VERIFIED]` where they
  were proven in production, `[VERIFY-SANDBOX]` where docs are ambiguous.
- **Advisory playbooks** — subscriptions from scratch, card-expiry/failed-renewal retokenization
  (the churn-killer), get-paid-without-a-store, marketplace payouts, go-live verification.
- **Safety** — write-confirmation gates for money operations, live-key red lines, PCI/SAQ scope
  guidance, and a PASS/FAIL verification gate as the definition of done.

## Layout

`SKILL.md` is a thin router; everything else loads on demand:

- `references/` — one file per product surface + `plugins/` (12 platforms) + `playbooks/` (5)
- `scripts/check-integration.js` — lint agent-generated integration code for the known Peach footguns
  (webhook raw-body, amount units, dot-keys, frontend secrets, token mixups) — run it before you ship
- `scripts/verify-webhook.js` — verify a real webhook payload (both signature schemes)
- `scripts/map-result-code.js` — classify a result code (captured/review/pending/error) the fail-closed way
- `scripts/canonical-string.js` — build the classic canonical string / sign V1 refund bodies
- `scripts/refresh-docs-check.sh` — detect docs drift vs the version pin (fail-open, bounded; prints one `DOCS-FRESHNESS: OK|DRIFT|UNKNOWN` line)
- `scripts/doctor.js` — one-command skill health check + agent golden path
- `templates/env.example` — copy-to-`.env` scaffold: correct variable names, sandbox/live hosts, server-side-only markers

## Keeping the docs pin fresh

The skill's facts are pinned to a docs mirror date (`references/versions.md`). To catch when Peach's docs
change out from under the pin:

- **Automatic when the skill loads (recommended, portable):** SKILL.md instructs the agent to run
  `scripts/refresh-docs-check.sh` once at the start of a session. It's *fail-open* (one bounded HTTP GET;
  offline → `UNKNOWN`, never blocks or hangs) and prints a single status line. On `DOCS-FRESHNESS: DRIFT`
  the agent tells you the docs moved since the pin and offers to triage. This runs only when the skill is
  actually used, and works in any agent (Claude Code, Codex, Cursor…).
- **Optional — deterministic, Claude Code only:** a `SessionStart` hook fires without the model deciding to.
  Add to `~/.claude/settings.json` (adjust the path):
  ```json
  { "hooks": { "SessionStart": [ { "hooks": [ {
    "type": "command",
    "command": "bash '<abs-path>/peach-payments-integration-expert/scripts/refresh-docs-check.sh' 2>&1 | head -1"
  } ] } ] } }
  ```
  Tradeoff: it fires on *every* session (not just Peach work) and adds one network call at session start —
  so prefer it only if you touch Peach often. It doesn't travel with the skill to other agents.

Either way, **detection is safe to automate; auto-*applying* fixes is not** — DRIFT means the docs index
changed, not that a shipped fact is wrong (most changelog churn touches nothing the skill asserts). Triage
the diff (`changelog.rss`), update the affected `references/` + `versions.md`, then re-sync the pin.

## Install

Copy/symlink this directory into your agent's skills directory, e.g.
`.agents/skills/peach-payments-integration-expert` or `~/.claude/skills/…`.

## Status

v0.6.1 (2026-09-10). The full version history and the provenance of every shipped fact are in
`references/versions.md`.
