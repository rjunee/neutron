#!/usr/bin/env bash
#
# scripts/ci/route-slot-ratchet-guard.sh — the cross-branch half of the
# route-slot coverage ratchet.
#
# `open/__tests__/route-slot-coverage.test.ts` boots the real Open composition and
# asserts that every rung in `MOUNTED_SLOTS` is still served. It reads its own
# baseline, so it cannot catch the one edit that defeats it: move a rung from
# `MOUNTED_SLOTS` to `UNMOUNTED_SLOTS` and the assertion stops existing — the route
# starts 404ing and CI stays green. Same hole the layering baseline has, same
# shape of guard (see depcruise-ratchet-guard.sh).
#
# THE INVARIANT: relative to main, the served set may only GROW. Demoting a rung
# that main serves FAILS. Deleting the slot outright is allowed — the comparator
# is handed the live declared-rung list so a real deletion is not a false alarm.
#
# SKIP (exit 0, never fail) in the bootstrap cases, mirroring the layering guard:
#   * no committed inventory at all;
#   * main has no inventory yet, or the ref is unreachable (fork/offline);
#   * HEAD IS main (a push-to-main run) — the ratchet compares a PR against main.
#
# ENV (test seams / overrides):
#   ROUTE_SLOT_RATCHET_ROOT     repo root to operate on (default: this repo)
#   ROUTE_SLOT_RATCHET_MAIN_REF git ref for "main" (default: origin/main)
#   NEUTRON_BUN_BIN             bun binary (default: bun)
#
# EXIT: 0 = baseline did not shrink (or a skip case), 1 = a rung was demoted,
#       2 = usage / the guard could not evaluate (never a silent pass).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ROUTE_SLOT_RATCHET_ROOT:-$(cd "$HERE/../.." && pwd)}"
MAIN_REF="${ROUTE_SLOT_RATCHET_MAIN_REF:-origin/main}"
BUN="${NEUTRON_BUN_BIN:-bun}"
COMPARE_TS="$HERE/route-slot-ratchet-compare.ts"
INVENTORY_REL="open/__tests__/route-slot-coverage-inventory.ts"
SLOTS_REL="gateway/http/route-slots.ts"

[ -f "$COMPARE_TS" ] || { echo "route-slot-ratchet-guard: missing $COMPARE_TS" >&2; exit 2; }

cd "$ROOT" || { echo "route-slot-ratchet-guard: cannot cd to $ROOT" >&2; exit 2; }

if [ ! -f "$ROOT/$INVENTORY_REL" ]; then
  echo "route-slot-ratchet-guard: no committed $INVENTORY_REL — nothing to ratchet; skipping."
  exit 0
fi
[ -f "$ROOT/$SLOTS_REL" ] || {
  echo "route-slot-ratchet-guard: $SLOTS_REL is gone — the registry moved, so this" >&2
  echo "guard is no longer looking where the slots live. Treat as broken, not clean." >&2
  exit 2
}

# Best-effort: make origin/main present on a shallow checkout. Never fatal — an
# offline/fork run falls through to the skip below rather than blocking.
if [ "$MAIN_REF" = "origin/main" ]; then
  # --depth=1 ADDS a ref to a shallow checkout but TRUNCATES a full one, writing
  # .git/shallow. That is how a line meant to help CI shallowed the shared build
  # checkout and produced three unrelated-looking failures in one night
  # (unrelated histories locally, an unresolvable sha and a missing merge base in
  # CI). Take the shallow path only when the clone is already shallow.
  if [ -f "$(git rev-parse --git-dir)/shallow" ]; then
    git fetch --depth=1 origin main >/dev/null 2>&1 || true
  else
    git fetch origin main >/dev/null 2>&1 || true
  fi
fi

# Skip on a push-to-main run: HEAD already IS main, so there is nothing to ratchet
# against (the guard enforces PR-vs-main, not main-vs-itself).
head_sha="$(git rev-parse HEAD 2>/dev/null || true)"
main_sha="$(git rev-parse "$MAIN_REF" 2>/dev/null || true)"
if [ -n "$head_sha" ] && [ -n "$main_sha" ] && [ "$head_sha" = "$main_sha" ]; then
  echo "route-slot-ratchet-guard: HEAD == $MAIN_REF (push-to-main) — ratchet N/A; skipping."
  exit 0
fi

# main's inventory has to land INSIDE the repo: bun resolves an import against the
# importing file's location, and the inventory is deliberately import-free so any
# path inside the tree works. A temp dir outside the repo would resolve the same
# here, but keeping it in-tree keeps that independent of tsconfig path setup.
MAIN_INVENTORY="$ROOT/.route-slot-inventory-main.$$.ts"
trap 'rm -f "$MAIN_INVENTORY"' EXIT
if ! git show "$MAIN_REF:$INVENTORY_REL" > "$MAIN_INVENTORY" 2>/dev/null; then
  # T3: name shallowness rather than leaving a true-but-useless message. An
  # "unreachable" ref on a shallow clone is not a fork or an outage, it is the
  # history simply not being present — the distinction cost hours to find once.
  if [ -f "$(git rev-parse --git-dir)/shallow" ]; then
    echo "route-slot-ratchet-guard: the checkout is SHALLOW (.git/shallow present), so $MAIN_REF's history is not available — this is a clone-depth problem, not a missing baseline. Run: git fetch --unshallow origin" >&2
  fi
  echo "route-slot-ratchet-guard: $MAIN_REF has no $INVENTORY_REL (bootstrap) or is unreachable — skipping."
  exit 0
fi

"$BUN" "$COMPARE_TS" "$MAIN_INVENTORY" "$ROOT/$INVENTORY_REL" "$ROOT/$SLOTS_REL"
