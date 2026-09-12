#!/usr/bin/env bash
#
# scripts/ci/as-built-staging-floor-guard.sh — no directory that holds a staged
# as-built record may be able to EMPTY when the records are promoted out of it.
# Every such directory keeps one tracked non-record file as its floor, and no
# branch may remove the floor under `.trident/as-built/` itself.
#
# WHAT BREAKS WITHOUT A FLOOR, MEASURED RATHER THAN PREDICTED.
# A branch stages exactly one record at `.trident/as-built/<branch>.md` and the
# promoter moves it to `docs/as-built/<slug>.md` on the base after the merge lands
# (`trident/as-built-appender.ts:161`). When a promotion consumes the LAST record
# in a directory, that directory has no tracked file left and so stops existing in
# the tree — and the promotion commit is, file for file, a move out of it into
# `docs/as-built/`. Git reads the pair as a DIRECTORY RENAME. Every open PR that
# stages a record in that same directory then acquires:
#
#   CONFLICT (file location): .trident/as-built/<path>.md added in <sha> inside a
#   directory that was renamed in origin/main, suggesting it should perhaps be
#   moved to docs/as-built/<name>.md
#
# On 2026-09-12 promoting the single remaining record emptied the directory and
# two of the seven then-open PRs acquired exactly that conflict. The suggested
# resolution is WORSE than the conflict: moving a staged record into
# `docs/as-built/` writes a shard FROM A BRANCH, which is the one thing the
# one-writer rule exists to forbid. A conflict that arrives carrying instructions
# to violate an invariant is not a nuisance, it is a trap.
#
# WHY THE RULE IS PER-DIRECTORY AND NOT ONE SENTINEL AT THE TOP. Measured with
# real git (`trident/as-built-staging-floor-realgit.test.ts`): git skips
# directory-rename detection only for a directory that STILL EXISTS on the
# renaming side, and it decides that per directory. Branch names in this repo
# carry a slash, so a staged record lives at `.trident/as-built/fix/<name>.md` far
# more often than at the top — and a lone `.trident/as-built/.gitkeep` leaves
# `.trident/as-built/fix/` free to vanish and the conflict intact. That is not a
# prediction either: the four-way probe that produced this rule showed the
# top-level-sentinel-only tree still conflicting on a subdirectory record, and the
# same tree with `fix/.gitkeep` merging clean.
#
# WHAT COUNTS AS A FLOOR is read off the promoter rather than guessed: it globs
# `*.md` (`trident/as-built-appender.ts:101`), so any tracked file in the
# directory whose name does not end in `.md` is one the promoter can never carry
# away. That is also why the floor is NOT a `README.md` — a `.md` file here would
# be promoted as though it were a record.
#
# WHY A GUARD AND NOT A PARAGRAPH. `docs/as-built/README.md` says the placeholder
# must never be deleted. A rule that lives only in prose is advice to an agent
# that has never read it (root `AGENTS.md:65-67`); the mechanism that works is a
# machine-checked refusal at the moment of the mistake. This is that refusal.
#
# WHERE THE EVENT FILTER LIVES, AND WHY IT IS HERE RATHER THAN IN ci.yml.
# Identical to `as-built-write-guard.sh`, whose header states the evidence: no
# agent in this system can write `.github/workflows/` — the GitHub token is scoped
# `repo read:org`, `runtime/adapters` TESTS that `workflow` scope is absent, and
# GitHub rejects such a push outright. That is a deliberate boundary, not a
# missing credential, so the rule is expressed where the repo can own it: the
# guard reads the Actions event itself and the already-wired
# `check-governed-repo-attributes.ts` gate in the `layering` job calls it.
#
# THE FLOOR QUESTION IS ASKED OF THE PROPOSED TREE, NOT OF A DIFF, and that is
# deliberate. A `--no-renames` diff answers "did this branch touch the floor"; the
# property that matters is "can any directory in the tree this branch proposes
# empty itself". Reading the tree catches a deletion, a rename of the floor, a
# rename of the whole directory, a record staged into a directory that never had a
# floor, and a base that acquired records while the floor stayed behind — every
# route to the empty directory rather than the one spelled `D`. It also needs no
# merge base, so a depth-1 Actions checkout cannot make the guard indeterminate.
#
# PUSH-TO-MAIN IS NOT GUARDED HERE, AND IS NOT UNGUARDED. There is no legitimate
# deleter of a floor at all — the promoter only ever removes paths its own `*.md`
# glob produced (`trident/as-built-appender.ts:101`), so it cannot take a floor
# with it. Rather than invent a second code path with its own failure modes, the
# floor on main is pinned by a test that runs in every shard on every event:
# `scripts/ci/as-built-staging-floor-guard.test.ts` asserts this repo's own
# tracked tree carries a floor in every directory that holds a record, so main
# regressing reds the suite.
#
# ENV:
#   GUARD_BASE_SHA                  PR/merge-queue base commit — explicit override
#   GUARD_HEAD_SHA                  PR/merge-queue head commit — explicit override
#   AS_BUILT_STAGING_FLOOR_ROOT     repo root to operate on (default: this repo)
#   GITHUB_ACTIONS                  'true' inside Actions — makes the guard STRICT
#   GITHUB_EVENT_NAME               'pull_request' / 'merge_group' / 'push' / ...
#   GITHUB_EVENT_PATH               the event payload the shas are read from
#
# EXIT: 0 = every directory holding a staged record has a floor, and the top-level
#           floor survives (or the base has no floor yet, in which case this diff
#           is the change installing it),
#       1 = the branch proposes a directory that can empty,
#       2 = missing/unresolvable input, or git could not be asked.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AS_BUILT_STAGING_FLOOR_ROOT:-$(cd "$HERE/../.." && pwd)}"
STAGING_DIR='.trident/as-built'
FLOOR_NAME='.gitkeep'

# Read one dotted key out of the event payload without a JSON dependency (this
# repo's CI has no jq guarantee). Prints nothing when the key is absent.
event_sha() {
  [ -n "${GITHUB_EVENT_PATH:-}" ] || return 0
  [ -f "${GITHUB_EVENT_PATH}" ] || return 0
  GUARD_EVENT_KEY="$1" bun --eval '
    const path = process.env.GITHUB_EVENT_PATH
    const key = process.env.GUARD_EVENT_KEY
    let value = null
    try {
      value = key.split(".").reduce((node, part) => (node == null ? null : node[part]), require(path))
    } catch {
      value = null
    }
    if (typeof value === "string" && value.length > 0) process.stdout.write(value)
  ' 2>/dev/null
}

# An explicit pair always wins and is always strict — this is the contract the
# guard's own unit tests drive it through.
if [ -z "${GUARD_BASE_SHA:-}" ] && [ -z "${GUARD_HEAD_SHA:-}" ]; then
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request | pull_request_target)
      GUARD_BASE_SHA="$(event_sha pull_request.base.sha)"
      GUARD_HEAD_SHA="$(event_sha pull_request.head.sha)"
      ;;
    merge_group)
      GUARD_BASE_SHA="$(event_sha merge_group.base_sha)"
      GUARD_HEAD_SHA="$(event_sha merge_group.head_sha)"
      ;;
    *)
      # Every non-branch event: see PUSH-TO-MAIN above. Nothing off a branch
      # proposal deletes a floor, and the floor on main is pinned by test rather
      # than by a second code path here. OUTSIDE Actions this is also how a
      # developer running the gate by hand gets a pass — but INSIDE Actions a
      # guarded event with no shas must NEVER land here, which is what the strict
      # branch below enforces.
      echo "as-built-staging-floor-guard: event '${GITHUB_EVENT_NAME:-<none>}' is not a branch proposal. Nothing to guard."
      exit 0
      ;;
  esac
fi

# Inside Actions, on a guarded event, an unreadable payload is a BROKEN WIRE and
# must be loud. Exiting 0 here is the failure mode this whole gate exists to
# prevent: a check that parsed nothing and reported clean.
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${GUARD_BASE_SHA:-}${GUARD_HEAD_SHA:-}" ]; then
  echo "as-built-staging-floor-guard: event '${GITHUB_EVENT_NAME:-<none>}' is guarded but GITHUB_EVENT_PATH yielded no base/head sha; the guard REFUSES to skip." >&2
  exit 2
fi

if [ -z "${GUARD_BASE_SHA:-}" ]; then
  echo "as-built-staging-floor-guard: GUARD_BASE_SHA is unset or empty; the guard REFUSES to skip." >&2
  exit 2
fi

if [ -z "${GUARD_HEAD_SHA:-}" ]; then
  echo "as-built-staging-floor-guard: GUARD_HEAD_SHA is unset or empty; the guard REFUSES to skip." >&2
  exit 2
fi

# A SHALLOW CHECKOUT IS NOT A MISSING COMMIT. `actions/checkout` clones depth-1,
# so the base sha the event names is routinely absent from the worktree even
# though it exists on the remote — and a fail-closed guard meeting a shallow
# clone is indistinguishable from a guard catching a real problem. It cost this
# repo a red shard once already (see `as-built-write-guard.sh`). So: try to FETCH
# what we were given before judging it, and refuse only if the remote cannot
# produce it either. No history DEEPENING is needed here, because this guard
# reads two trees and never their merge base.
ensure_commit() {
  git -C "$ROOT" rev-parse --verify --quiet "${1}^{commit}" >/dev/null && return 0
  git -C "$ROOT" fetch --quiet --depth=1 origin "$1" >/dev/null 2>&1 || true
  git -C "$ROOT" rev-parse --verify --quiet "${1}^{commit}" >/dev/null
}

if ! ensure_commit "${GUARD_BASE_SHA}"; then
  echo "as-built-staging-floor-guard: GUARD_BASE_SHA '${GUARD_BASE_SHA}' could not be resolved even after fetching it; the guard REFUSES to skip." >&2
  exit 2
fi

if ! ensure_commit "${GUARD_HEAD_SHA}"; then
  echo "as-built-staging-floor-guard: GUARD_HEAD_SHA '${GUARD_HEAD_SHA}' could not be resolved even after fetching it; the guard REFUSES to skip." >&2
  exit 2
fi

# "NOTHING THERE" AND "COULD NOT LOOK" MUST NOT SHARE AN ANSWER. `git ls-tree`
# succeeds with EMPTY OUTPUT for a path absent from a readable tree and fails
# outright when the tree itself cannot be read. So the exit code carries the
# unknown and the output carries the verdict; collapsing the two into one boolean
# is how a guard reports clean over a repository it never managed to open.
#
# `-z`, and that is not style: without it `ls-tree` C-QUOTES any path with an
# unusual byte, and a quoted name ends in `"` rather than `.md` — so the one class
# of record the parser would misread is the one it would misread as a FLOOR,
# which is the permissive direction. NUL-delimited records are never quoted.
# Written to a file rather than a variable because command substitution drops NULs.
#
# Fills the two associative arrays with directory keys; returns 2 if git failed.
declare -A RECORD_DIRS=()
declare -A FLOOR_DIRS=()
read_tree() {
  local sha="$1" scratch entry meta path dir
  RECORD_DIRS=()
  FLOOR_DIRS=()
  scratch="$(mktemp)" || return 2
  if ! git -C "$ROOT" ls-tree -r -z "$sha" -- "$STAGING_DIR/" >"$scratch" 2>/dev/null; then
    rm -f "$scratch"
    return 2
  fi
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    [ -n "$path" ] || continue
    # Only a regular file holds a directory open. A submodule (`commit`) or a
    # symlink to nowhere would not, so they are not floors.
    case "$meta" in *' blob '*) ;; *) continue ;; esac
    dir="${path%/*}"
    case "$path" in
      *.md) RECORD_DIRS["$dir"]=1 ;;
      *) FLOOR_DIRS["$dir"]=1 ;;
    esac
  done <"$scratch"
  rm -f "$scratch"
  return 0
}

if ! read_tree "${GUARD_BASE_SHA}"; then
  echo "as-built-staging-floor-guard: could not read tree '${GUARD_BASE_SHA}'; the guard REFUSES to skip." >&2
  exit 2
fi
base_has_top_floor=0
[ -n "${FLOOR_DIRS[$STAGING_DIR]:-}" ] && base_has_top_floor=1

if ! read_tree "${GUARD_HEAD_SHA}"; then
  echo "as-built-staging-floor-guard: could not read tree '${GUARD_HEAD_SHA}'; the guard REFUSES to skip." >&2
  exit 2
fi
head_has_top_floor=0
[ -n "${FLOOR_DIRS[$STAGING_DIR]:-}" ] && head_has_top_floor=1

# THE VERDICT IS ASKED OF THE HEAD; ONLY THE BASE IS ALLOWED TO BE WRONG.
#
# The top-level floor is READ from the base rather than assumed — the same reason
# `as-built-write-guard.sh` reads the freeze note from the base. The change that
# INSTALLS the floor is judged against a base that does not have it yet, so a
# blind refusal would red the only PR that can ever make the guard's own claim
# true, and a gate that cannot be introduced is not strict, it is broken.
#
# BUT THE EXEMPTION IS SCOPED TO THE BASE SIDE, AND THE SCOPING IS THE WHOLE
# POINT. This first shipped as "fail when the base HAS a floor and the head does
# not", which reads as the same rule and is not: with neither side floored the
# condition is false, and if every record-holding subdirectory happened to carry
# its own floor the loop below passed too — so the guard exited 0 over a tree that
# never installs the top-level floor at all, contradicting the invariant
# `docs/as-built/README.md` states and this script's own header asserts. An
# exemption written to let a guard install itself must name the side that is
# allowed to be wrong. Scoped to EITHER side it exempts precisely the state the
# guard exists to refuse, and it does so on the first run, when nothing else is
# watching. Reproduced with real git before the fix and pinned by
# `scripts/ci/as-built-staging-floor-guard.test.ts` after it.
#
# So: the head must carry the floor, always. What the base says only changes which
# mistake the message names.
if [ "$head_has_top_floor" = 0 ]; then
  {
    if [ "$base_has_top_floor" = 1 ]; then
      echo "as-built-staging-floor-guard: FAILED — this branch removes the floor under ${STAGING_DIR}/."
      echo "The base has a tracked non-record file there and the proposed tree has none."
    else
      echo "as-built-staging-floor-guard: FAILED — the proposed tree has no floor under ${STAGING_DIR}/."
      echo "Neither the base nor this branch carries one, so this diff does not install it either. A"
      echo "floored subdirectory is not a substitute: it holds ITS OWN directory open and says nothing"
      echo "about this one, which is empty the moment its last subdirectory is drained."
    fi
    echo "A promotion that consumes the last staged record would then leave the directory with nothing"
    echo "in it. Git reads the promotion as a rename of ${STAGING_DIR}/ to docs/as-built/ and every open"
    echo "PR that stages a record acquires 'CONFLICT (file location) ... suggesting it should perhaps be"
    echo "moved to docs/as-built/<name>.md' — whose suggested resolution writes a shard FROM A BRANCH,"
    echo "which the one-writer rule forbids. Measured 2026-09-12: one promotion emptied the directory"
    echo "and two of seven open PRs acquired that conflict."
    if [ "$base_has_top_floor" = 1 ]; then
      echo "Restore it: git checkout ${GUARD_BASE_SHA} -- ${STAGING_DIR}/${FLOOR_NAME}"
    else
      echo "Add it: an empty, tracked ${STAGING_DIR}/${FLOOR_NAME}"
    fi
    echo "See docs/as-built/README.md."
  } >&2
  exit 1
fi

# EVERY DIRECTORY HOLDING A RECORD NEEDS ITS OWN FLOOR, because git decides
# directory-rename detection per directory. `.trident/as-built/fix/` emptying is
# the same defect as `.trident/as-built/` emptying, and in this repo it is the
# COMMON case: branch names carry a slash, so that is where records actually land.
unfloored=()
for dir in "${!RECORD_DIRS[@]}"; do
  [ -n "${FLOOR_DIRS[$dir]:-}" ] || unfloored+=("$dir")
done

if [ "${#unfloored[@]}" -gt 0 ]; then
  {
    echo "as-built-staging-floor-guard: FAILED — the proposed tree stages records in ${#unfloored[@]} directory(ies) that can EMPTY:"
    while IFS= read -r dir; do
      echo "    ${dir}/ — add ${dir}/${FLOOR_NAME}"
    done < <(printf '%s\n' "${unfloored[@]}" | LC_ALL=C sort)
    echo "A promotion consuming the last record in one of those directories leaves it with no tracked"
    echo "file, so it stops existing; git then reads the promotion as a rename of that directory to"
    echo "docs/as-built/ and every open PR staging a record there acquires 'CONFLICT (file location)"
    echo "... suggesting it should perhaps be moved to docs/as-built/<name>.md'. Accepting that"
    echo "suggestion writes a shard FROM A BRANCH, which the one-writer rule forbids. Measured"
    echo "2026-09-12: one promotion emptied the directory and two of seven open PRs acquired it."
    echo "A floor is any tracked file the promoter's *.md glob cannot carry away"
    echo "(trident/as-built-appender.ts:101) — an empty ${FLOOR_NAME} is the convention. NOT a README.md:"
    echo "a .md file here would be promoted as though it were a record."
    echo "See docs/as-built/README.md."
  } >&2
  exit 1
fi

if [ "$base_has_top_floor" = 0 ] && [ "$head_has_top_floor" = 1 ]; then
  echo "as-built-staging-floor-guard: the base carries no ${STAGING_DIR}/${FLOOR_NAME}, so this diff is the change that installs the staging floor. Every branch cut after it is vetoed for removing it." >&2
fi

echo "as-built-staging-floor-guard: OK — every directory staging a record in the proposed tree keeps a floor."
