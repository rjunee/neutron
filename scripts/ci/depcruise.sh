#!/usr/bin/env bash
#
# scripts/ci/depcruise.sh — G4 layering ratchet.
#
# Runs dependency-cruiser against `.dependency-cruiser.cjs` (the five-band
# layer model from docs/research/refactor-audit-2026-07-02/critic-layering.md
# §2.2/§9.1) with the current cross-band edges grandfathered via
# `.dependency-cruiser-known-violations.json`. A NEW cross-band import (or a
# NEW import cycle) that isn't in that baseline fails the build; edges already
# in the baseline stay silent until their owning refactor unit (the §2.1
# cut-list) removes them — at which point re-running
# `scripts/ci/depcruise-refresh-baseline.sh` shrinks the baseline file and the
# ratchet tightens permanently (there is no mechanism to add NEW entries other
# than editing the config or genuinely fixing an edge; regenerating the
# baseline from a dirty tree would silently grandfather a new violation, so
# that script refuses to run if `git status --porcelain` isn't clean).
#
# USAGE
#   scripts/ci/depcruise.sh            # scan the whole repo (CI default)
#
# EXIT: 0 = no NEW violations (known ones may still be printed as a warning
# count), 1 = a new violation was found, 2 = usage/internal error.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG="$ROOT/.dependency-cruiser.cjs"
BASELINE="$ROOT/.dependency-cruiser-known-violations.json"

if [ ! -f "$CONFIG" ]; then
  echo "depcruise.sh: missing $CONFIG" >&2
  exit 2
fi
if [ ! -f "$BASELINE" ]; then
  echo "depcruise.sh: missing $BASELINE (run scripts/ci/depcruise-refresh-baseline.sh once)" >&2
  exit 2
fi

cd "$ROOT"
bunx depcruise --config "$CONFIG" --ignore-known "$BASELINE" -T err .
status=$?

if [ "$status" -eq 0 ]; then
  echo "DEPCRUISE: NO NEW CROSS-BAND VIOLATIONS ✅"
else
  echo "DEPCRUISE: NEW LAYERING VIOLATION(S) — see above. If this edge is a" >&2
  echo "deliberate, reviewed part of the current refactor step (not a regression)," >&2
  echo "run scripts/ci/depcruise-refresh-baseline.sh on a clean tree to re-baseline" >&2
  echo "— but prefer fixing the edge; the baseline should only ever shrink." >&2
fi

exit "$status"
