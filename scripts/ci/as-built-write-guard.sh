#!/usr/bin/env bash
#
# scripts/ci/as-built-write-guard.sh — enforce the as-built log's one-writer
# rule on pull requests and merge-queue commits.
#
# Branches that prepend to docs/AS_BUILT.md all edit the same offset and
# therefore conflict by construction. GitHub does not run merge drivers
# server-side, so branch entries are staged under .trident/as-built/ instead;
# the outer loop folds them into the canonical log on main after merge.
#
# WHERE THE EVENT FILTER LIVES, AND WHY IT IS HERE RATHER THAN IN ci.yml.
# The first design put the base/head shas and the pull_request-or-merge_group
# condition in `.github/workflows/ci.yml` as an eleven-line step. No agent in
# this system can write that file: the GitHub token is scoped `repo read:org`,
# `runtime/adapters` TESTS that `workflow` scope is absent, and a push touching
# `.github/workflows/` is rejected outright by GitHub ("refusing to allow an
# OAuth App to create or update workflow ... without `workflow` scope"). That is
# a deliberate boundary, not a missing credential, so the rule is expressed where
# the repo can actually own it: the guard reads the event itself, and an
# already-wired gate in the `layering` job calls it (see
# `check-governed-repo-attributes.ts`).
#
# ENV:
#   GUARD_BASE_SHA       PR/merge-queue base commit — explicit override
#   GUARD_HEAD_SHA       PR/merge-queue head commit — explicit override
#   AS_BUILT_GUARD_ROOT  repo root to operate on (default: this repo)
#   GITHUB_ACTIONS       'true' inside Actions — makes the guard STRICT
#   GITHUB_EVENT_NAME    'pull_request' / 'merge_group' / 'push' / ...
#   GITHUB_EVENT_PATH    the event payload the shas are read from
#
# EXIT: 0 = branch does not write the log, or there is no guarded diff to read,
#       1 = branch writes the log,
#       2 = missing/unresolvable input or an indeterminate diff.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${AS_BUILT_GUARD_ROOT:-$(cd "$HERE/../.." && pwd)}"

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
      # Push-to-main and every non-branch event: the outer-loop appender is the
      # canonical log's one legitimate writer, so there is nothing to guard.
      # OUTSIDE Actions this is also how a developer running the gate by hand
      # gets a pass — but INSIDE Actions a guarded event with no shas must NEVER
      # land here, which is what the strict branch below enforces.
      echo "as-built-write-guard: event '${GITHUB_EVENT_NAME:-<none>}' is not a branch proposal — the outer-loop appender is the log's legitimate writer. Nothing to guard."
      exit 0
      ;;
  esac
fi

# Inside Actions, on a guarded event, an unreadable payload is a BROKEN WIRE and
# must be loud. Exiting 0 here is the failure mode this whole gate exists to
# prevent: a check that parsed nothing and reported clean.
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${GUARD_BASE_SHA:-}${GUARD_HEAD_SHA:-}" ]; then
  echo "as-built-write-guard: event '${GITHUB_EVENT_NAME:-<none>}' is guarded but GITHUB_EVENT_PATH yielded no base/head sha; the guard REFUSES to skip." >&2
  exit 2
fi

if [ -z "${GUARD_BASE_SHA:-}" ]; then
  echo "as-built-write-guard: GUARD_BASE_SHA is unset or empty; the guard REFUSES to skip." >&2
  exit 2
fi

if [ -z "${GUARD_HEAD_SHA:-}" ]; then
  echo "as-built-write-guard: GUARD_HEAD_SHA is unset or empty; the guard REFUSES to skip." >&2
  exit 2
fi

# A SHALLOW CHECKOUT IS NOT A MISSING COMMIT. `actions/checkout` clones depth-1,
# so the base sha the event names is routinely absent from the worktree even
# though it exists on the remote — and a fail-closed guard meeting a shallow
# clone is indistinguishable from a guard catching a real problem. It cost this
# repo a red shard that read as a broken guard. So: try to FETCH what we were
# given before judging it, and refuse only if the remote cannot produce it
# either. Fail-closed is preserved; only the false refusal goes away.
ensure_commit() {
  git -C "$ROOT" rev-parse --verify --quiet "${1}^{commit}" >/dev/null && return 0
  git -C "$ROOT" fetch --quiet --depth=1 origin "$1" >/dev/null 2>&1 || true
  git -C "$ROOT" rev-parse --verify --quiet "${1}^{commit}" >/dev/null
}

# RESOLVING BOTH SHAS IS NOT ENOUGH. The diff below is three-dot, so it needs the
# MERGE BASE, and depth-1 fetches of two individual commits share no ancestor —
# the shas resolve and the diff then fails, which is how the first version of this
# fix still reddened the shard. Deepen once when the checkout is shallow so a base
# exists; on a full clone this is a no-op.
ensure_history() {
  [ -f "$(git -C "$ROOT" rev-parse --git-dir)/shallow" ] || return 0
  git -C "$ROOT" fetch --quiet --unshallow origin >/dev/null 2>&1 ||
    git -C "$ROOT" fetch --quiet --deepen=200 origin >/dev/null 2>&1 || true
}

if ! ensure_commit "${GUARD_BASE_SHA}"; then
  echo "as-built-write-guard: GUARD_BASE_SHA '${GUARD_BASE_SHA}' could not be resolved even after fetching it; the guard REFUSES to skip." >&2
  exit 2
fi

if ! ensure_commit "${GUARD_HEAD_SHA}"; then
  echo "as-built-write-guard: GUARD_HEAD_SHA '${GUARD_HEAD_SHA}' could not be resolved even after fetching it; the guard REFUSES to skip." >&2
  exit 2
fi

ensure_history

if ! changed_paths="$(git -C "$ROOT" diff --name-only --no-renames "${GUARD_BASE_SHA}...${GUARD_HEAD_SHA}" -- docs/AS_BUILT.md 2>/dev/null)"; then
  echo "as-built-write-guard: diff for GUARD_BASE_SHA '${GUARD_BASE_SHA}' and GUARD_HEAD_SHA '${GUARD_HEAD_SHA}' failed; the guard REFUSES to skip." >&2
  exit 2
fi

council_warn() {
  {
    echo "as-built-write-guard: WARNING — this branch writes docs/AS_BUILT.md."
    echo "Branches prepend at the same offset, and GitHub does not run merge drivers server-side,"
    echo "so two branches that both append can conflict there."
    echo "Prefer staging .trident/as-built/<branch>.md; the outer loop folds it onto main after the merge lands."
    echo 'See CONTRIBUTING § "The as-built log has ONE writer".'
    echo "This is ADVISORY. It does not fail the build — see the note in this script for why."
  } >&2
}

# WHY THIS WARNS INSTEAD OF FAILING — MEASURED 2026-08-19, AND THE MEASUREMENT
# REVERSED THE ORIGINAL DESIGN.
#
# This guard was written as a hard `exit 1` on the premise that AS_BUILT.md is
# what makes build PRs conflict. That premise was tested against the live
# backlog before landing it, and it did not survive:
#
#     open PRs                     45
#     touch docs/AS_BUILT.md       31
#     conflicting PRs measured     34
#       conflict ON AS_BUILT.md     6
#       conflict on other files    34
#       blocked SOLELY by it        0
#
# Not one open PR is blocked by this file. Every conflicting branch has a real
# code conflict elsewhere — orchestrator.ts, controller.ts, migrations/runner.ts
# — and AS_BUILT.md merely rides along in 6 of 34. The `merge=union` attribute
# this repo already ships is evidently doing its job.
#
# So a hard failure would have refused 31 of 45 open PRs to eliminate a conflict
# class that is currently blocking none of them: a large, certain cost against a
# benefit measured at zero. The detection is still worth having — 6 of 34 do
# co-conflict here, and the day the union attribute stops working this is the
# check that will say so — but it earns a warning, not a veto.
#
# Restoring the veto is a one-line change (`council_warn` then `exit 1`), and the
# evidence for whether it is deserved will be sitting in the CI logs.
if [ -n "$changed_paths" ]; then
  council_warn
  exit 0
fi

echo "as-built-write-guard: OK — branch diff does not write docs/AS_BUILT.md."
