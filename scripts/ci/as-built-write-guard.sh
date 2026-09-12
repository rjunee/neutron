#!/usr/bin/env bash
#
# scripts/ci/as-built-write-guard.sh — docs/AS_BUILT.md is FROZEN. No branch
# may touch it, on a pull request or in the merge queue.
#
# The file is the record up to 2026-09-12 and nothing appends to it again (see
# the note at its top). Records for later changes are one file per change under
# docs/as-built/: a branch stages exactly one entry at
# .trident/as-built/<branch>.md, and the outer loop promotes it to
# docs/as-built/<slug>.md on the base after the merge lands.
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
# EXIT: 0 = branch does not write the frozen log, or there is no guarded diff,
#       1 = branch writes the frozen log,
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
      # Push-to-main and every non-branch event: the frozen log has no writer
      # at all, and the outer-loop appender writes docs/as-built/ rather than
      # this path, so there is nothing on a non-branch event to guard.
      # OUTSIDE Actions this is also how a developer running the gate by hand
      # gets a pass — but INSIDE Actions a guarded event with no shas must NEVER
      # land here, which is what the strict branch below enforces.
      echo "as-built-write-guard: event '${GITHUB_EVENT_NAME:-<none>}' is not a branch proposal. Nothing to guard."
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

council_fail() {
  {
    echo "as-built-write-guard: FAILED — this branch writes docs/AS_BUILT.md, which is FROZEN."
    echo "That file is the record up to 2026-09-12 and takes no further entries; its 405 existing"
    echo "entries are cited by other documents and must stay byte-for-byte."
    echo "Stage your entry at .trident/as-built/<branch>.md instead; after the merge lands the outer"
    echo "loop promotes it to docs/as-built/<slug>.md. Format: docs/as-built/README.md."
    echo 'See CONTRIBUTING § "The as-built log has ONE writer".'
  } >&2
}

# WHY THIS IS A HARD FAILURE AGAIN, AND WHY THE 2026-08-19 MEASUREMENT NO LONGER
# APPLIES.
#
# This guard shipped as `exit 1`, was downgraded to advisory on a measurement of
# the live backlog, and is a veto again because the thing that was measured has
# ceased to exist. The measurement was:
#
#     open PRs                     45
#     touch docs/AS_BUILT.md       31
#     conflicting PRs measured     34
#       conflict ON AS_BUILT.md     6
#       conflict on other files    34
#       blocked SOLELY by it        0
#
# The argument it supported was a cost/benefit one: failing 31 of 45 open PRs to
# eliminate a conflict class blocking none of them is a large certain cost for a
# benefit of zero. Every one of those 31 PRs was appending a legitimate entry to
# an append-only log, and the `merge=union` attribute was absorbing the overlap.
#
# Neither half is true now. The log is FROZEN, so there is no legitimate write
# left to refuse — a branch touching this path is unambiguously wrong rather than
# merely inconvenient, and the count of correct PRs a veto would cost is zero by
# construction. And `merge=union` is GONE from .gitattributes (see the comment
# there): union never reports a conflict, so on a file nobody may write it would
# silently double an edit instead of stopping it. Warning about a write that
# nothing downstream will now catch is the failure mode this gate exists to
# prevent.
#
# The refusals above (exit 2) are untouched: "I looked and found a write" and "I
# could not look" remain different failures.

# THE FREEZE IS READ FROM THE BASE, NOT ASSUMED — AND THAT IS WHAT MAKES THE VETO
# LANDABLE AT ALL.
#
# This guard's message asserts that docs/AS_BUILT.md is frozen. Asserting it
# blindly has one immediate consequence and one lasting one. The immediate one:
# the change that INSTALLS the freeze necessarily writes the freeze note into
# this very file, so a blind veto reds the only PR that can ever make its own
# claim true — a gate that cannot be introduced is not a strict gate, it is a
# broken one. The lasting one: pointed at a governed repo whose log is still
# append-only (Managed keeps AS-BUILT.md), it would refuse correct work.
#
# So the precondition is READ: does the log AT THE BASE already carry the freeze
# note? If it does, the freeze is in force on every branch cut from that base and
# any write to it is wrong. If it does not, this diff is the change installing it,
# and the guard says so out loud rather than passing silently.
#
# This is not an escape hatch a branch can take. Removing the note is itself a
# diff that touches this path, and it is judged against the BASE, which still has
# it. And it cannot rot quietly: `scripts/ci/as-built-write-guard.test.ts` pins
# that this repo's real docs/AS_BUILT.md carries the note, so a reformat that
# dropped it would red the suite rather than silently disarm this veto.
#
# NO PIPE INTO `grep -q` HERE, AND THAT IS NOT STYLE. This script runs under `set
# -o pipefail`, and `grep -q` exits the instant it matches — which closes the pipe
# under a `git show` that is still writing, killing it with SIGPIPE (141). Under
# pipefail the PIPELINE then reports that failure, so the function answers "not
# frozen" on precisely the inputs that ARE frozen. Measured against this repo's
# real 2.0 MB log: the veto did not fire. It DID fire on a small fixture, because
# git finishes writing before grep can exit — so the bug was invisible to a small
# test and visible only on the file the gate exists to protect. The match is done
# in the shell instead, with no second process to race.
frozen_at_base() {
  case "$(git -C "$ROOT" show "${GUARD_BASE_SHA}:docs/AS_BUILT.md" 2>/dev/null)" in
    *'FROZEN as of'*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "$changed_paths" ]; then
  if frozen_at_base; then
    council_fail
    exit 1
  fi
  echo "as-built-write-guard: docs/AS_BUILT.md at the base carries no freeze note, so this diff is the change that installs it. Passing THIS diff only; every branch cut after it is vetoed." >&2
  exit 0
fi

echo "as-built-write-guard: OK — branch diff does not write docs/AS_BUILT.md."
