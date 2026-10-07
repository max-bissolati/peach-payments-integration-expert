#!/usr/bin/env bash
# Read-only by default. Index check; --deep also checks tracked page bodies.
# Python 3 and curl required. 0 = OK/UNKNOWN, 1 = DRIFT, 2 = invalid CLI.
# See refresh-docs-check.py --help for the explicit review/accept workflow.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "DOCS-FRESHNESS: UNKNOWN (python3 unavailable; no freshness assertion)"
  exit 0
fi
exec python3 "$SELF_DIR/refresh-docs-check.py" "$@"
