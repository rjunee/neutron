#!/usr/bin/env bash
# lane_review.sh <branch-or-ref> [base] — the REVIEW leg, made mechanical.
#
# WHY. This repo's signature failure is a build that is green and delivers
# nothing. Three classes, all seen in the last 24h:
#   docs-only   #386, #408 — the entire diff is markdown
#   test-only   a change whose only non-test edit is a re-export
#   unwired     #400 — new symbol exists, 17/17 green, ZERO production callers
# A passing test suite cannot see any of them, because a test that calls
# buildX(deps) directly passes whether or not production ever invokes buildX.
#
# This does not judge code quality. It answers one question a test cannot:
# DOES THIS BRANCH CHANGE WHAT THE PRODUCT DOES?
#
# Exit 0 = delivers something. Exit 1 = findings. Exit 2 = the check itself
# could not run — an unresolvable ref, a failed extraction or an analyzer
# failure MUST fail loudly, never read as clean. The 2026-08-18 report recorded
# an earlier revision exiting 0; the surviving precursor measured exit 2, so
# the report may instead reflect an earlier copy or a `$?`-after-pipe misread.
# Either way, the shipped contract is pinned. There is deliberately NO lenient
# default; a caller wanting leniency must add an explicit opt-in flag.
#
# Pinned by tools/lane_review.test.ts: the unknown-ref non-zero exit, the
# origin/ fallback, the stated-empty symbol set, and the unwired finding.

set -uo pipefail

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  echo "lane_review: Bash 4.4 or newer is required — refusing to answer"
  exit 2
fi

if [ $# -lt 1 ]; then
  echo "usage: lane_review.sh <branch-or-ref> [base]"
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZER="$HERE/lane_review_ast.mjs"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
  || { echo "lane_review: could not find the repository root"; exit 2; }
cd "$ROOT" || { echo "lane_review: could not enter the repository root"; exit 2; }

BR_IN="$1"
BASE_IN="${2:-origin/main}"

# Resolve a ref the way callers actually hold them. A lane branch usually
# exists locally only as `origin/trident/<slug>`, and git's DWIM does NOT map
# a bare `trident/<slug>` onto refs/remotes/origin/trident/<slug> — which is
# exactly how three real PRs (#424 #420 #411) produced empty output. A local
# ref wins when both exist (git's own precedence); a fallback resolution is
# REPORTED below so the output is self-describing.
resolve_ref() {
  if git rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1; then
    printf '%s' "$1"
    return 0
  fi
  if git rev-parse --verify --quiet "origin/$1^{commit}" >/dev/null 2>&1; then
    printf 'origin/%s' "$1"
    return 0
  fi
  return 1
}

BR=$(resolve_ref "$BR_IN") \
  || { echo "lane_review: ref '$BR_IN' could not be resolved (tried '$BR_IN' and 'origin/$BR_IN') — refusing to answer"; exit 2; }
BASE=$(resolve_ref "$BASE_IN") \
  || { echo "lane_review: base '$BASE_IN' could not be resolved (tried '$BASE_IN' and 'origin/$BASE_IN') — refusing to answer"; exit 2; }
[ "$BR" != "$BR_IN" ] && echo "=== resolved '$BR_IN' -> '$BR'"
[ "$BASE" != "$BASE_IN" ] && echo "=== resolved base '$BASE_IN' -> '$BASE'"

MB=$(git merge-base "$BASE" "$BR") \
  || { echo "lane_review: no merge-base between '$BASE' and '$BR'"; exit 2; }

echo "=== $BR vs $BASE (merge-base ${MB:0:8})"
git diff --stat "$MB".."$BR" | tail -1

paths_file=$(mktemp)
trap 'rm -f "$paths_file"' EXIT

if ! git diff --name-only -z "$MB".."$BR" >"$paths_file"; then
  echo "lane_review: could not list changed files — refusing to answer"
  exit 2
fi
mapfile -d '' -t files <"$paths_file"
if [ "${#files[@]}" -eq 0 ]; then
  echo "FINDING: branch is IDENTICAL to base — it built nothing."
  exit 1
fi

# --- class 1: docs-only ------------------------------------------------------
code=()
for file in "${files[@]}"; do
  case "$file" in
    *.md|*.txt|docs/*|plans/*) ;;
    *) code+=("$file") ;;
  esac
done
if [ "${#code[@]}" -eq 0 ]; then
  echo "FINDING: DOCS-ONLY — every changed file is prose. Delivers no behaviour."
  printf '  %s\n' "${files[@]}"
  exit 1
fi

# --- class 2: test-only ------------------------------------------------------
prod=()
for file in "${code[@]}"; do
  if [[ ! "$file" =~ (^|/)(tests?|__tests__)(/|$)|\.(test|spec)\. ]]; then
    prod+=("$file")
  fi
done
if [ "${#prod[@]}" -eq 0 ]; then
  echo "FINDING: TEST-ONLY — no production file changed."
  printf '  %s\n' "${code[@]}"
  exit 1
fi

echo "--- non-prose, non-test files changed:"
printf '  %s\n' "${prod[@]}"

# --- class 3: unwired --------------------------------------------------------
# Compare bound syntax trees instead of grepping added lines. Besides handling
# every declaration and re-export form, this distinguishes aliases, namespace
# access and shadows while keeping comments and strings out by construction.
#
# A CALLER is a reference in a non-test production file that is not the export
# site itself. Two rules the analyzer must keep, both paid for in production:
# a re-export (`export { s } from`) is NOT a caller — that is exactly what #400
# did and it shipped unwired; and the DEFINING FILE is NOT skipped. A symbol
# defined and USED at top level inside its own module is wired: #395 (verified
# live in the deployed tree) does exactly that, and an earlier version that
# skipped the definer reported it as unwired. A reference from INSIDE a new
# definition is deferred rather than discarded: a direct caller proves its new
# definition is wired, then a fixpoint proves the new helpers that definition
# references. Recursion and mutually-referential islands with no independently
# proven entry point remain unwired.
bun "$ANALYZER" analyze "$MB" "$BR" "${prod[@]}"
analysis_status=$?
# The analyzer reserves 10 for a completed analysis with findings. Bun itself
# exits 1 for launch/import failures and uncaught exceptions, so treating 1 as
# a wiring verdict would collapse "could not run" into "unwired".
if [ "$analysis_status" -eq 10 ]; then
  exit 1
elif [ "$analysis_status" -ne 0 ]; then
  echo "lane_review: bound production-caller analysis failed — refusing to answer"
  exit 2
fi

echo "=== delivers behaviour: yes"
exit 0
