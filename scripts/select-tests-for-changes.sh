#!/usr/bin/env bash
#
# scripts/select-tests-for-changes.sh — print the test files that cover what this
# working tree changed, newline-separated, deterministically ordered and capped.
#
# WHY THIS EXISTS
# ---------------
# A build lane running in a worktree on a shared machine used to run the ENTIRE
# suite locally on every round. Several lanes doing that at once saturate the box,
# and a saturated box does not merely run slowly — it MANUFACTURES FAILURES. On
# 2026-08-17 six tests failed under lane contention, every one of them sitting
# exactly on a 5 s timeout boundary, and an A/B of one file across two worktrees
# came out with the CONTROL slower than the changed tree. So the local run is now
# scoped to what the lane touched, and the full suite runs in CI, on its own
# runners, on every push. Coverage before merge is unchanged; only the machine
# does less.
#
# This script exists because that selection was previously PROSE in the build
# contract — three tiers, a priority order and a cap, re-derived by hand by every
# agent on every round. Prose is not reproducible. This is.
#
# THE SELECTION, in priority order:
#   (a) changed files that are THEMSELVES test files;
#   (b) test files in each changed file's own directory or its adjacent `__tests__/`;
#   (c) test files that NAME a changed module's basename (a plain content grep,
#       so `thing` also matches `nothing` — tier (c) OVER-approximates on purpose;
#       stage 1 is a fast reject and is allowed to be generous, never sparse).
#
# THE CAP BOUNDS THE WHOLE SET, not the last tier. `git diff --name-only <base>`
# is the branch's CUMULATIVE diff, so on a fix round it grows every round; tier
# (c) on a generic basename (`index`, `store`, `utils`) is the worst offender.
# Over budget, a tier is DROPPED ENTIRELY rather than trimmed — (c) first, then
# (b) — because half a tier is a arbitrary subset with none of the tier's meaning.
# If (a) alone is over budget its first CAP files are run.
#
# USAGE
#   bash scripts/select-tests-for-changes.sh [base-ref] [cap]
#     base-ref   what to diff against          (default: main)
#     cap        maximum files to print        (default: 40)
#
# EXIT
#   0  always, when git answered — an empty selection prints nothing and is not an
#      error (a docs-only diff genuinely has no covering tests). Non-zero only when
#      this is not a git work tree.
#
# The comparison is base..WORKING TREE, NOT base..HEAD: a lane runs its tests
# BEFORE it commits, so `base..HEAD` is empty on round 1 and prints the PREVIOUS
# round's files on a fix round. Untracked files are added separately because git
# has never seen them.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${NEUTRON_TEST_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$ROOT" || exit 1

BASE="${1:-main}"
CAP="${2:-40}"
case "$CAP" in ''|*[!0-9]*) echo "select-tests: cap must be a non-negative integer, got '$CAP'" >&2; exit 1 ;; esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "select-tests: not a git work tree (cwd=$ROOT)" >&2
  exit 1
fi

# The same discovery the runner uses, so the selection can never name a file the
# suite does not contain (nor miss one it does).
# shellcheck source=scripts/lib/discover-test-files.sh
. "${SCRIPT_DIR}/lib/discover-test-files.sh"

ALL_TESTS="$(neutron_discover_test_files)"

# --- what changed -------------------------------------------------------------
# An unknown base ref is NOT fatal: it degrades to "only the untracked files",
# which is a smaller selection, never a wrong one.
#
# Diffed against the MERGE-BASE, not against the base ref's tip: on a branch that
# has been open a while the tip has moved on, and a two-dot diff then reports
# everything OTHER people landed as "changed here" — which is how a one-file edit
# selects four hundred test files and the cap silently throws the real ones away.
BASE_REF="$BASE"
_mb="$(git merge-base HEAD "$BASE" 2>/dev/null)"
[ -n "$_mb" ] && BASE_REF="$_mb"

CHANGED="$(
  {
    git diff --name-only "$BASE_REF" 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | LC_ALL=C awk 'NF && !seen[$0]++'
)"

if [ -z "$CHANGED" ]; then
  exit 0
fi

is_test_path() {
  case "$1" in
    *.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.test.mjs|*.test.cjs) return 0 ;;
    *.spec.ts|*.spec.tsx|*.spec.js|*.spec.jsx|*.spec.mjs|*.spec.cjs) return 0 ;;
    *) return 1 ;;
  esac
}

# Discovery emits `./a/b.test.ts`; git emits `a/b.test.ts`. Compare in ONE form.
norm() { printf '%s\n' "${1#./}"; }

TIER_A=""
TIER_B=""
DIRS=""
BASENAMES=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  f="$(norm "$f")"
  if is_test_path "$f"; then
    # A DELETED test file cannot be run, and naming it would make the whole
    # file-scoped invocation error out on a path that is not there.
    [ -e "$f" ] || continue
    TIER_A="${TIER_A}${f}
"
    continue
  fi
  # A DELETED module still contributes its directory and its basename, and that
  # is deliberate: the tests that imported it are exactly the ones the deletion
  # breaks, so they are the ones a local pass most needs to run. Excluding them
  # would hand that break to CI when it was the cheapest thing to catch here.
  d="$(dirname "$f")"
  DIRS="${DIRS}${d}
${d}/__tests__
"
  b="$(basename "$f")"
  # Strip ONE extension only: `devices-client.ts` -> `devices-client`. A dotted
  # name (`vite.config.ts`) keeps its prefix, which is what a grep wants.
  BASENAMES="${BASENAMES}${b%.*}
"
done <<EOF
${CHANGED}
EOF

DIRS="$(printf '%s' "$DIRS" | LC_ALL=C awk 'NF && !seen[$0]++')"
BASENAMES="$(printf '%s' "$BASENAMES" | LC_ALL=C awk 'NF && !seen[$0]++')"
TIER_A="$(printf '%s' "$TIER_A" | LC_ALL=C awk 'NF && !seen[$0]++')"

# --- tier (b): test files sitting beside a changed file -----------------------
if [ -n "$DIRS" ]; then
  # The directory list is passed as a FILE, never through `awk -v`: a `-v`
  # assignment cannot carry newlines (BSD awk answers `newline in string` and
  # empties the variable), which silently deleted this whole tier.
  TIER_B="$(
    LC_ALL=C awk '
      NR == FNR { if (NF) want[$0] = 1; next }
      {
        p = $0
        sub(/^\.\//, "", p)
        if (p == "") next
        dir = p
        if (sub(/\/[^\/]+$/, "", dir) == 0) dir = "."
        if (dir in want) print p
      }
    ' <(printf '%s\n' "$DIRS") <(printf '%s\n' "$ALL_TESTS")
  )"
fi

# --- tier (c): test files that NAME a changed module --------------------------
# ONE batched grep over the whole suite rather than one per basename. Basenames
# are regex-escaped: a module called `use-something.v2` would otherwise make `.`
# match anything, and an unescaped `+` is a syntax error that would silently
# empty the tier.
TIER_C=""
if [ -n "$BASENAMES" ]; then
  PATTERN="$(printf '%s\n' "$BASENAMES" | LC_ALL=C sed -e 's/[][^$.*+?(){}|\\]/\\&/g' | LC_ALL=C tr '\n' '|' | sed -e 's/|$//')"
  if [ -n "$PATTERN" ]; then
    TIER_C="$(
      printf '%s\n' "$ALL_TESTS" \
        | LC_ALL=C tr '\n' '\0' \
        | LC_ALL=C xargs -0 grep -lE "$PATTERN" 2>/dev/null \
        | LC_ALL=C awk 'NF { sub(/^\.\//, "", $0); print }'
    )"
  fi
fi

# --- assemble under the cap ---------------------------------------------------
count() { [ -z "$1" ] && { echo 0; return; }; printf '%s\n' "$1" | LC_ALL=C awk 'NF' | wc -l | tr -d ' '; }

# Dedup ACROSS tiers before measuring: a file in both (a) and (b) is one file, and
# counting it twice would drop a whole tier for a budget that was never exceeded.
dedup_against() {
  # $1 = candidate list, $2 = already-selected list. Prints $1 minus $2, order kept.
  LC_ALL=C awk 'NR == FNR { if (NF) seen[$0] = 1; next } NF && !seen[$0]++' \
    <(printf '%s\n' "$2") <(printf '%s\n' "$1")
}

TIER_B="$(dedup_against "$TIER_B" "$TIER_A")"
TIER_C="$(dedup_against "$TIER_C" "$(printf '%s\n%s' "$TIER_A" "$TIER_B")")"

NA="$(count "$TIER_A")"
NB="$(count "$TIER_B")"
NC="$(count "$TIER_C")"

if [ "$(( NA + NB + NC ))" -le "$CAP" ]; then
  SELECTED="$(printf '%s\n%s\n%s' "$TIER_A" "$TIER_B" "$TIER_C")"
elif [ "$(( NA + NB ))" -le "$CAP" ]; then
  SELECTED="$(printf '%s\n%s' "$TIER_A" "$TIER_B")"
elif [ "$NA" -le "$CAP" ]; then
  SELECTED="$TIER_A"
else
  SELECTED="$(printf '%s\n' "$TIER_A" | LC_ALL=C awk 'NF' | head -n "$CAP")"
fi

printf '%s\n' "$SELECTED" | LC_ALL=C awk 'NF && !seen[$0]++'
