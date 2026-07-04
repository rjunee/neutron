#!/usr/bin/env bash
#
# scripts/ci/depcruise-refresh-baseline.sh — regenerate the G4 layering
# baseline (`.dependency-cruiser-known-violations.json`) from the current
# tree. Run this ONLY after a refactor unit removes one or more cross-band
# edges (the §2.1 cut-list in
# docs/research/refactor-audit-2026-07-02/critic-layering.md) — the new
# baseline should be a strict subset of the old one. It refuses to run on a
# dirty tree so an in-progress, unreviewed edge can never be silently
# grandfathered.
#
# USAGE
#   scripts/ci/depcruise-refresh-baseline.sh
#
# Then diff the baseline file in your PR — reviewers should see it only ever
# shrink (fewer entries), never grow, never add a rule name that wasn't
# already there.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG="$ROOT/.dependency-cruiser.cjs"
BASELINE="$ROOT/.dependency-cruiser-known-violations.json"

cd "$ROOT"

if [ -n "$(git status --porcelain -- . ':(exclude)'"${BASELINE#$ROOT/}" 2>/dev/null)" ]; then
  echo "depcruise-refresh-baseline.sh: working tree has uncommitted changes." >&2
  echo "Commit or stash them first — regenerating the baseline from a dirty" >&2
  echo "tree could silently grandfather an unreviewed violation." >&2
  exit 1
fi

before=0
if [ -f "$BASELINE" ]; then
  before="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$BASELINE" 2>/dev/null || echo 0)"
fi

bunx depcruise-baseline --config "$CONFIG" -f "$BASELINE" .

after="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$BASELINE")"
echo "depcruise baseline: $before -> $after known violations"
if [ "$after" -gt "$before" ]; then
  echo "WARNING: baseline GREW. It should only ever shrink — double-check you" >&2
  echo "didn't introduce a new cross-band edge instead of removing one." >&2
fi
