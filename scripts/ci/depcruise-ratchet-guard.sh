#!/usr/bin/env bash
#
# scripts/ci/depcruise-ratchet-guard.sh — G8 ratchet-GROWTH enforcement for the
# G4 layering baseline.
#
# G4's depcruise.sh runs `--ignore-known "$BASELINE"`, trusting EVERY entry in
# `.dependency-cruiser-known-violations.json`. So a PR could grandfather a NEW
# cross-band edge simply by ADDING it to that committed baseline and CI would
# stay green — violating the stated "the baseline should only ever shrink"
# invariant (Codex flagged this on G4's review; the refresh helper only WARNS on
# growth, and only when a human runs it). This guard makes the invariant
# CI-ENFORCED: the committed baseline may only SHRINK (or stay equal) relative to
# origin/main's version. Any ADDED grandfathered entry FAILS the build.
#
# It reads main's baseline via `git show <ref>:<baseline>` (best-effort
# `git fetch --depth=1 origin main` first so a shallow CI checkout has the ref),
# then hands both baselines to the pure comparator (depcruise-ratchet-compare.ts),
# which keys each violation as `rule|from|to` and fails on any key present in the
# committed set but absent from main's.
#
# SKIP (exit 0, never fail) in the bootstrap cases:
#   * no committed baseline at all (nothing to ratchet);
#   * main has no baseline yet, or the ref is unreachable (fork/offline);
#   * HEAD IS main (a push-to-main run) — the ratchet compares a PR against main,
#     not main against itself.
#
# ENV (test seams / overrides):
#   DEPCRUISE_RATCHET_ROOT     repo root to operate on (default: this repo)
#   DEPCRUISE_RATCHET_MAIN_REF git ref for "main" (default: origin/main)
#   NEUTRON_BUN_BIN            bun binary (default: bun)
#
# EXIT: 0 = baseline did not grow (or a skip case), 1 = baseline GREW, 2 = usage.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DEPCRUISE_RATCHET_ROOT:-$(cd "$HERE/../.." && pwd)}"
MAIN_REF="${DEPCRUISE_RATCHET_MAIN_REF:-origin/main}"
BUN="${NEUTRON_BUN_BIN:-bun}"
COMPARE_TS="$HERE/depcruise-ratchet-compare.ts"
BASELINE_REL=".dependency-cruiser-known-violations.json"
BASELINE="$ROOT/$BASELINE_REL"

[ -f "$COMPARE_TS" ] || { echo "depcruise-ratchet-guard: missing $COMPARE_TS" >&2; exit 2; }

cd "$ROOT" || { echo "depcruise-ratchet-guard: cannot cd to $ROOT" >&2; exit 2; }

if [ ! -f "$BASELINE" ]; then
  echo "depcruise-ratchet-guard: no committed $BASELINE_REL — nothing to ratchet; skipping."
  exit 0
fi

# Best-effort: make origin/main present on a shallow checkout. Never fatal — an
# offline/fork run falls through to the skip below rather than blocking.
if [ "$MAIN_REF" = "origin/main" ]; then
  git fetch --depth=1 origin main >/dev/null 2>&1 || true
fi

# Skip on a push-to-main run: HEAD already IS main, so there is nothing to ratchet
# against (the guard enforces PR-vs-main, not main-vs-itself).
head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
main_sha="$(git rev-parse "$MAIN_REF" 2>/dev/null || true)"
if [ -n "$head_sha" ] && [ -n "$main_sha" ] && [ "$head_sha" = "$main_sha" ]; then
  echo "depcruise-ratchet-guard: HEAD == $MAIN_REF (push-to-main) — ratchet N/A; skipping."
  exit 0
fi

# Fetch main's committed baseline. If main has none yet (bootstrap) or the ref is
# unreachable, there is nothing to compare against — skip rather than fail.
MAIN_BASELINE="$(mktemp)"
trap 'rm -f "$MAIN_BASELINE"' EXIT
if ! git show "$MAIN_REF:$BASELINE_REL" > "$MAIN_BASELINE" 2>/dev/null; then
  echo "depcruise-ratchet-guard: $MAIN_REF has no $BASELINE_REL (bootstrap) or is unreachable — skipping."
  exit 0
fi

"$BUN" "$COMPARE_TS" "$MAIN_BASELINE" "$BASELINE"
