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
# could not run — an unresolvable ref or an empty extraction MUST fail loudly,
# never read as clean. Measured 2026-08-18: an earlier revision printed
# `unknown ref` and exited 0, and that empty output was indistinguishable
# from a clean verdict on three PRs at once. There is deliberately NO lenient
# default; a caller wanting leniency must add an explicit opt-in flag.
#
# Pinned by tools/lane_review.test.ts: the unknown-ref non-zero exit, the
# origin/ fallback, the stated-empty symbol set, and the unwired finding.

set -uo pipefail

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

files=$(git diff --name-only "$MB".."$BR")
if [ -z "$files" ]; then
  echo "FINDING: branch is IDENTICAL to base — it built nothing."
  exit 1
fi

# --- class 1: docs-only ------------------------------------------------------
code=$(printf '%s\n' "$files" | grep -vE '\.(md|txt)$|^docs/|^plans/' || true)
if [ -z "$code" ]; then
  echo "FINDING: DOCS-ONLY — every changed file is prose. Delivers no behaviour."
  printf '  %s\n' $files
  exit 1
fi

# --- class 2: test-only ------------------------------------------------------
prod=$(printf '%s\n' "$code" | grep -vE '\.test\.|\.spec\.|^tests?/|__tests__' || true)
if [ -z "$prod" ]; then
  echo "FINDING: TEST-ONLY — no production file changed."
  printf '  %s\n' $code
  exit 1
fi

echo "--- production files changed:"
printf '  %s\n' $prod

# --- class 3: unwired --------------------------------------------------------
# Collect exported symbols ADDED by this branch in production files.
syms=$(git diff "$MB".."$BR" -- $prod 2>/dev/null \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -oE 'export (async )?function [A-Za-z_][A-Za-z0-9_]*|export const [A-Za-z_][A-Za-z0-9_]*|export class [A-Za-z_][A-Za-z0-9_]*' \
  | sed -E 's/.* //' | sort -u || true)

if [ -z "$syms" ]; then
  # Stated in words, never implied by absence: "nothing to check" and
  # "checked, all wired" must not look identical.
  echo "--- no new exported symbols — nothing to verify; branch edits existing code paths (wiring N/A)"
else
  echo "--- new exported symbols: $(printf '%s ' $syms)"
  for s in $syms; do
    # A CALLER is a reference in a non-test production file that is not the
    # export site itself. A re-export (`export { s } from`) is NOT a caller —
    # that is exactly what #400 did and it shipped unwired.
    callers=$(git grep -l --full-name -w "$s" "$BR" -- '*.ts' '*.tsx' 2>/dev/null \
      | sed 's/^[^:]*://' \
      | grep -vE '\.test\.|\.spec\.|^tests?/|__tests__' || true)
    real=""
    for f in $callers; do
      body=$(git show "$BR:$f" 2>/dev/null) || continue
      # NOTE: the defining file is NOT skipped. A symbol defined and USED inside
      # its own module is wired — #395 (verified live in the deployed tree) does
      # exactly that, and skipping the definer reported it as unwired. What is
      # stripped is the DEFINITION ITSELF, not the file.
      body=$(printf '%s' "$body" | sed -E "s/export (async )?(function|const|class) $s\b/__DEF__/")
      # Strip re-export and import BLOCKS before looking for a use. These span
      # MULTIPLE LINES:
      #     export {
      #       buildWorktreeReaperLoop,
      #     } from './worktree-reaper.ts'
      # A line-oriented regex misses that and reports the barrel as a caller —
      # which is precisely how #400 passed a naive version of this check while
      # being the unwired branch this tool exists to catch. Slurp, then strip.
      stripped=$(printf '%s' "$body" | perl -0777 -pe "
        s/export\s+(type\s+)?\{[^}]*\}\s*from\s*['\"][^'\"]+['\"];?//gs;
        s/^\s*(import|export)\s+type\s+.*?;?\s*\$//gms;
        s/import\s+(type\s+)?\{[^}]*\}\s*from\s*['\"][^'\"]+['\"];?//gs;
      " 2>/dev/null)
      # HERESTRING, NOT A PIPE — and this is not style. `set -o pipefail` is on.
      # `printf … | grep -q` makes grep exit the instant it matches, which closes
      # the pipe and kills printf with SIGPIPE (141); pipefail then reports the
      # PIPELINE as failed. So the check reported "no caller found" exactly when
      # the caller was found EARLY in the file, and reported correctly only when
      # the match happened to be near the end. An inverted check that looks like
      # a clean pass. It marked #395 — verified live in the deployed tree —
      # unwired. Do not turn this back into a pipe.
      grep -qE "\b$s\b" <<<"$stripped" && real="$real $f"
    done
    if [ -z "$real" ]; then
      echo "  FINDING: $s has NO non-test production caller — green-and-unwired."
      findings=$((findings+1))
    else
      echo "  ok: $s called by$real"
    fi
  done
fi

[ "$findings" -gt 0 ] && exit 1
echo "=== delivers behaviour: yes"
exit 0
