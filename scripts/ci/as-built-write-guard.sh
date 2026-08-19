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

if [ -n "$changed_paths" ]; then
  {
    echo "as-built-write-guard: docs/AS_BUILT.md may not be written by a branch."
    echo "Branches prepend at the same offset and conflict by construction; GitHub never runs merge drivers server-side."
    echo "Stage .trident/as-built/<branch>.md instead; the outer loop folds it onto main after the merge lands."
    echo 'See CONTRIBUTING § "The as-built log has ONE writer".'
  } >&2
  exit 1
fi

echo "as-built-write-guard: OK — branch diff does not write docs/AS_BUILT.md."
