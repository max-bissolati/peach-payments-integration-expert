#!/usr/bin/env bash
# refresh-docs-check.sh — detect Peach docs drift vs the skill's version pin.
#
# Designed to be safe to run at the START of a session (fail-open, bounded, one-line status):
#   - FAILS OPEN: if the docs can't be reached (offline, timeout), it prints DOCS-FRESHNESS: UNKNOWN
#     and exits 0 — it NEVER blocks the skill or hangs.
#   - Prints a single machine-relayable status line first (DOCS-FRESHNESS: OK | DRIFT | UNKNOWN),
#     then human detail.
#   - Exit code: 0 = OK or UNKNOWN (non-blocking), 1 = DRIFT detected (so CI can gate if it wants).
#
# It compares the live llms.txt index hash to a last-seen hash stored next to this script
# (.last-llms-hash): the first run records a baseline, later runs detect drift against it.
# NOTE: DRIFT means the docs INDEX changed — not that a shipped fact is wrong. Triage the change;
# do not auto-rewrite the skill from a diff.

set -uo pipefail   # NOT -e: we handle errors explicitly so the check stays fail-open.

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PIN_FILE="$SELF_DIR/.last-llms-hash"
LIVE_URL="https://developer.peachpayments.com/llms.txt"
PIN_DATE="$(grep -oE 'Docs mirror date: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$SELF_DIR/../references/versions.md" 2>/dev/null | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')"
PIN_DATE="${PIN_DATE:-unknown}"
NOW="$(date +%Y-%m-%d)"

# --- fetch the live index, bounded, fail-open -------------------------------------------------
live_body="$(curl -sfL --max-time 8 "$LIVE_URL" 2>/dev/null || true)"
if [ -z "$live_body" ]; then
  echo "DOCS-FRESHNESS: UNKNOWN (could not reach developer.peachpayments.com — skipped, not blocking)"
  exit 0
fi
# Hash with trailing-newline normalization on BOTH sides ($(...) strips trailing newlines) so an
# identical index doesn't mismatch on a stray newline.
live_hash="$(printf '%s' "$live_body" | shasum -a 256 | awk '{print $1}')"

# --- resolve the pin hash ---------------------------------------------------------------------
if [ -f "$PIN_FILE" ]; then
  pin_hash="$(cat "$PIN_FILE" 2>/dev/null)"
  pin_src="last-seen hash"
else
  printf '%s\n' "$live_hash" > "$PIN_FILE" 2>/dev/null || true
  echo "DOCS-FRESHNESS: OK (first run — recorded baseline; re-run later to detect drift)"
  exit 0
fi

# --- compare ----------------------------------------------------------------------------------
if [ "$pin_hash" = "$live_hash" ]; then
  echo "DOCS-FRESHNESS: OK (pin ${PIN_DATE}, index unchanged as of ${NOW})"
  exit 0
fi

echo "DOCS-FRESHNESS: DRIFT — Peach docs index changed since the ${PIN_DATE} pin (checked ${NOW})"
echo "  → Relay to the user: the docs may have changed since this skill's pin; offer to triage."
echo "  → Triage: diff https://developer.peachpayments.com/changelog.rss into new/changed/deprecated"
echo "     facts, update the affected references/ + versions.md, then re-sync the pin (${pin_src})."
echo "  → DRIFT ≠ a shipped fact is wrong; most changelog churn touches nothing the skill asserts."
exit 1
