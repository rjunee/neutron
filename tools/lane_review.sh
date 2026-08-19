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
# failure MUST fail loudly, never read as clean. Measured 2026-08-18: an
# earlier revision printed `unknown ref` and exited 0, and that empty output
# was indistinguishable from a clean verdict on three PRs at once. There is deliberately NO lenient
# default; a caller wanting leniency must add an explicit opt-in flag.
#
# Pinned by tools/lane_review.test.ts: the unknown-ref non-zero exit, the
# origin/ fallback, the stated-empty symbol set, and the unwired finding.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZER="$HERE/lane_review_ast.mjs"

if [ $# -lt 1 ]; then
  echo "usage: lane_review.sh <branch-or-ref> [base]"
  exit 2
fi
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
findings=0

echo "=== $BR vs $BASE (merge-base ${MB:0:8})"
git diff --stat "$MB".."$BR" | tail -1

paths_file=$(mktemp)
symbols_file=$(mktemp)
callers_file=$(mktemp)
trap 'rm -f "$paths_file" "$symbols_file" "$callers_file"' EXIT

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
  if [[ ! "$file" =~ \.test\.|\.spec\.|^tests?/|__tests__ ]]; then
    prod+=("$file")
  fi
done
if [ "${#prod[@]}" -eq 0 ]; then
  echo "FINDING: TEST-ONLY — no production file changed."
  printf '  %s\n' "${code[@]}"
  exit 1
fi

echo "--- production files changed:"
printf '  %s\n' "${prod[@]}"

# --- class 3: unwired --------------------------------------------------------
# Compare syntax trees instead of grepping added lines. Besides handling every
# declaration form (default/abstract/generator/enum/let/export lists), this
# keeps comments and strings out of the caller question by construction.
#
# A CALLER is a reference in a non-test production file that is not the export
# site itself. Two rules the analyzer must keep, both paid for in production:
# a re-export (`export { s } from`) is NOT a caller — that is exactly what #400
# did and it shipped unwired; and the DEFINING FILE is NOT skipped — only the
# definition itself is. A symbol defined and USED inside its own module is
# wired: #395 (verified live in the deployed tree) does exactly that, and an
# earlier version that skipped the definer reported it as unwired.
if ! bun "$ANALYZER" exports "$MB" "$BR" "${prod[@]}" >"$symbols_file"; then
  echo "lane_review: exported-symbol analysis failed — refusing to answer"
  exit 2
fi
mapfile -t syms <"$symbols_file"

if [ "${#syms[@]}" -eq 0 ]; then
  # Stated in words, never implied by absence: "nothing to check" and
  # "checked, all wired" must not look identical.
  echo "--- no new exported symbols — nothing to verify; branch edits existing code paths (wiring N/A)"
else
  printf '%s' "--- new exported symbols:"
  printf ' %s' "${syms[@]}"
  printf '\n'

  if ! bun "$ANALYZER" callers "$BR" "${syms[@]}" >"$callers_file"; then
    echo "lane_review: production-caller analysis failed — refusing to answer"
    exit 2
  fi
  declare -A real_callers
  while IFS=$'\t' read -r -d '' symbol caller; do
    real_callers["$symbol"]+="${real_callers[$symbol]:+$'\n'}$caller"
  done <"$callers_file"

  for symbol in "${syms[@]}"; do
    if [ -z "${real_callers[$symbol]:-}" ]; then
      echo "  FINDING: $symbol has NO non-test production caller — green-and-unwired."
      findings=$((findings+1))
    else
      printf '  ok: %s called by' "$symbol"
      while IFS= read -r caller; do printf ' %s' "$caller"; done <<<"${real_callers[$symbol]}"
      printf '\n'
    fi
  done
fi

[ "$findings" -gt 0 ] && exit 1
echo "=== delivers behaviour: yes"
exit 0
