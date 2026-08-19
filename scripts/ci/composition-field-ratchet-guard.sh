#!/usr/bin/env bash
#
# scripts/ci/composition-field-ratchet-guard.sh — the cross-branch half of the
# composition-field coverage ratchet.
#
# `open/__tests__/composition-field-coverage.test.ts` boots the real Open
# composition and asserts that every field in `WIRED_FIELDS` is still set. It
# reads its own baseline, so it cannot catch the one edit that defeats it: move a
# field from `WIRED_FIELDS` to `UNWIRED_FIELDS` and the assertion stops existing
# — the capability goes dark and CI stays green. Same hole the route-slot and
# layering baselines have, same shape of guard (see route-slot-ratchet-guard.sh).
#
# THE INVARIANT: relative to main, the wired set may only GROW. Demoting a field
# that main wires FAILS. Deleting the field outright is allowed — the comparator
# reads the live declared-field list, so a real deletion is not a false alarm.
#
# SKIP (exit 0, never fail) in the bootstrap cases, mirroring the guards next door:
#   * no committed inventory at all;
#   * main has no inventory yet, or the ref is unreachable (fork/offline);
#   * HEAD IS main (a push-to-main run) — the ratchet compares a PR against main.
#
# ENV (test seams / overrides):
#   COMPOSITION_FIELD_RATCHET_ROOT     repo root to operate on (default: this repo)
#   COMPOSITION_FIELD_RATCHET_MAIN_REF git ref for "main" (default: origin/main)
#   NEUTRON_BUN_BIN                    bun binary (default: bun)
#
# EXIT: 0 = baseline did not shrink (or a skip case), 1 = a field was demoted,
#       2 = usage / the guard could not evaluate (never a silent pass).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${COMPOSITION_FIELD_RATCHET_ROOT:-$(cd "$HERE/../.." && pwd)}"
MAIN_REF="${COMPOSITION_FIELD_RATCHET_MAIN_REF:-origin/main}"
BUN="${NEUTRON_BUN_BIN:-bun}"
COMPARE_TS="$HERE/composition-field-ratchet-compare.ts"
INVENTORY_REL="open/__tests__/composition-field-coverage-inventory.ts"
READER_REL="open/__tests__/declared-composition-fields.ts"

[ -f "$COMPARE_TS" ] || { echo "composition-field-ratchet-guard: missing $COMPARE_TS" >&2; exit 2; }

cd "$ROOT" || { echo "composition-field-ratchet-guard: cannot cd to $ROOT" >&2; exit 2; }

if [ ! -f "$ROOT/$INVENTORY_REL" ]; then
  echo "composition-field-ratchet-guard: no committed $INVENTORY_REL — nothing to ratchet; skipping."
  exit 0
fi
[ -f "$ROOT/$READER_REL" ] || {
  echo "composition-field-ratchet-guard: $READER_REL is gone — the declaration reader" >&2
  echo "moved, so this guard can no longer tell a demotion from a deletion. Treat as" >&2
  echo "broken, not clean." >&2
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
  echo "composition-field-ratchet-guard: HEAD == $MAIN_REF (push-to-main) — ratchet N/A; skipping."
  exit 0
fi

# main's inventory has to land INSIDE the repo: bun resolves an import against the
# importing file's location, and the inventory is deliberately import-free so any
# path inside the tree works.
MAIN_INVENTORY="$ROOT/.composition-field-inventory-main.$$.ts"
trap 'rm -f "$MAIN_INVENTORY"' EXIT
if ! git show "$MAIN_REF:$INVENTORY_REL" > "$MAIN_INVENTORY" 2>/dev/null; then
  echo "composition-field-ratchet-guard: $MAIN_REF has no $INVENTORY_REL (bootstrap) or is unreachable — skipping."
  exit 0
fi

"$BUN" "$COMPARE_TS" "$MAIN_INVENTORY" "$ROOT/$INVENTORY_REL" "$ROOT"
