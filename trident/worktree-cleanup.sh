#!/usr/bin/env bash
# =============================================================================
# trident/worktree-cleanup.sh — DIRTY WORKTREES ARE PRESERVED, NEVER FORCED
# =============================================================================
#
# THE INCIDENT (ISSUES #541). The inner workflow's `finally{}` used to hand a
# cheap-model agent this prompt: "MUST succeed on every path; ignore individual
# command failures … git worktree remove --force <path> … git branch -D". That
# block fires on success, on REQUEST_CHANGES, on THROW and on ABORT — i.e.
# precisely when Forge died mid-edit and its worktree holds the only copy of the
# work. On this repo's PR #171 it destroyed 197 insertions across 7 files.
# Nothing about that is recoverable: `--force` discards the working tree, and
# `-D` discards the commits with it.
#
# So the destructive path stops being a judgement call. This script is the whole
# decision, deterministic, exit-code'd:
#
#   * DIRTY (tracked modifications, staged changes, OR untracked files) →
#     PRESERVE. The worktree is left exactly as it is, its path and its dirty
#     paths are printed, and the script exits 3.
#   * UNVERIFIABLE (`git status` cannot run in that worktree at all) → PRESERVE.
#     A tree we cannot prove clean is treated as dirty; the only safe default in
#     a path whose failure mode is unrecoverable data loss.
#   * CLEAN → removed with a PLAIN `git worktree remove` (no `--force`, ever).
#     git's own dirty check is then a second, independent gate on top of ours.
#   * A worktree whose directory is GONE is left to `git worktree prune`, which
#     only ever drops stale ADMIN entries — it never deletes a working tree.
#
# BRANCH TEARDOWN (`delete-branch`, pr-mode only) is gated the same way, because
# `git branch -D` loses commits that exist nowhere else just as thoroughly as
# `--force` loses edits: the branch is deleted ONLY when nothing was preserved
# AND `git ls-remote` proves origin already holds this exact sha. No remote copy
# (never pushed / behind / ls-remote failed) → the branch is KEPT and reported.
# In local-mode (`keep-branch`) the branch is the only copy of the build by
# design — the OUTER loop merges it — so it is never touched here.
#
# THE SHARED CHECKOUT (git's "main working tree") IS NEVER TOUCHED. It is not a
# disposable build tree — it is the repo the operator works in, and merge.ts
# legitimately leaves it ON a feature branch after a stale-rebase recovery.
# `git worktree remove` refuses it outright ("is a main working tree"), which
# used to be scored as an unverifiable preservation and jammed pr-mode branch
# teardown at exit 3 forever. It is now skipped before the decision.
#
# Usage:
#   worktree-cleanup.sh <repo> <branch> <delete-branch|keep-branch>
#
# Exit codes — the caller BRANCHES ON THESE, so they are a contract:
#   0  nothing needed preserving (clean worktrees removed, branch handled)
#   2  usage error (wrong argument count, empty argument, bad mode, non-repo)
#   3  something was PRESERVED — a dirty/unverifiable worktree, or a branch
#      whose commits are not on origin. NOT a failure of this script: it is the
#      signal that a human has work waiting. The caller must report it, never
#      "retry" it and never work around it.
#   anything else is a FAILURE of this script (it crashed, or never ran) and
#   means NOTHING was inspected — it must NOT be reported as preserved work.
#
# Output is machine-greppable, one record per line:
#   REMOVED <path>
#   PRESERVED worktree <path> reason=<dirty|unverifiable>
#   PRESERVED branch <name> reason=<worktree-preserved|not-on-origin|unpushed|ls-remote-failed>
#   SKIPPED <path> reason=not-a-worktree-root
#   KEPT branch <name> reason=checked-out
#   DELETED branch <name>
#   RESULT preserved=<n> removed=<n>
#
# `preserved` counts ITEMS KEPT, not worktrees — a worktree and a branch are two
# separate things that can each hold the only copy of some work. So ONE dirty
# worktree in `delete-branch` mode reports `preserved=2`: the tree, plus the
# branch whose commits sit underneath it. The number is a magnitude for the log;
# the exit code (3) and the per-item records above are the contract.
#
# THE OUTPUT IS BOUNDED BY CONSTRUCTION. It is read back through the run log and,
# in the inner workflow, transcribed by a cheap agent — so a 20k-line dirty tree
# (one un-ignored `dist/`) must not be able to push the trailing RESULT line and
# the caller's exit marker out of the reader's window and invert the "work was
# preserved" alarm into "nothing was inspected". Every unbounded thing git can
# hand us (the dirty file list, git's stderr) is capped below, with the exact
# command to see the rest printed in its place.
set -uo pipefail

# Never BLOCK. This script runs from the inner workflow's `finally{}` — which
# fires on throw and on abort, with nobody at a keyboard — and `ls-remote` below
# talks to origin. Without this, an expired credential helper or a bare-HTTPS
# remote sits on a username prompt forever and takes the whole cleanup with it.
# Same setting the rest of the repo uses wherever it shells git at a remote.
export GIT_TERMINAL_PROMPT=0

# How many dirty paths are printed per worktree before the list is summarised.
max_dirty_lines=50
# How many bytes of git's stderr are quoted in a diagnostic.
max_stderr_bytes=2000
# `git` for the one command that touches the network, wall-clock capped where
# coreutils `timeout` exists (see the ls-remote call for why). The deadline is a
# BOUND, not a tuning knob — it is overridable only so the hang guard itself is
# testable in under a second instead of twenty. Behaviour is identical either
# way: blowing the deadline is just another unreachable origin.
ls_remote_timeout="${TRIDENT_CLEANUP_LS_REMOTE_TIMEOUT:-20}"
ls_remote=(git)
if command -v timeout >/dev/null 2>&1; then
  ls_remote=(timeout "$ls_remote_timeout" git)
fi

usage="usage: worktree-cleanup.sh <repo> <branch> <delete-branch|keep-branch>"
# Argument validation exits 2, the DOCUMENTED usage code. `${1:?}` would exit 1
# — indistinguishable from a crash — and the caller reads exit 3 vs "anything
# else" as "work is waiting" vs "cleanup broke", so every code has to mean what
# the header says it means.
if [ "$#" -ne 3 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
  echo "worktree-cleanup.sh: $usage" >&2
  exit 2
fi
repo="$1"
branch="$2"
mode="$3"

case "$mode" in
  delete-branch | keep-branch) ;;
  *)
    echo "worktree-cleanup.sh: mode must be delete-branch or keep-branch, got '$mode'" >&2
    exit 2
    ;;
esac

if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "worktree-cleanup.sh: '$repo' is not a git repository" >&2
  exit 2
fi

preserved=0
removed=0

# Every LINKED worktree that has THIS branch checked out. `worktree list
# --porcelain` emits a `worktree <path>` line followed by that entry's
# attributes, so the branch match is attributed to the most recent path line
# (same parse as merge.ts `freeBranchFromWorktrees`).
#
# `n > 1` skips the FIRST entry, which git documents as the main working tree —
# the shared checkout (git-worktree(1): "The main worktree is listed first").
# It is not ours to remove: `git worktree remove` refuses it, and scoring that
# refusal as a preservation pins the exit at 3 and blocks branch teardown for
# good whenever the shared checkout is parked on the build branch.
worktrees="$(
  git -C "$repo" worktree list --porcelain 2>/dev/null | awk -v want="refs/heads/$branch" '
    /^worktree /{ w = substr($0, 10); n++; next }
    /^branch /{ if (substr($0, 8) == want && n > 1) print w }
  '
)"

# `git status`'s STDERR is captured HERE, apart from its stdout. Folding the two
# together (`2>&1`) made anything git writes to stderr on a perfectly CLEAN tree
# — `warning: could not open directory 'x/': Permission denied`, a GIT_TRACE line
# from the operator's environment — parse as a dirty path: the worktree was never
# removed, pr-mode branch teardown never ran, and the "PRESERVED WORK" alarm
# fired on runs that had preserved nothing. Only stdout decides dirtiness;
# stderr is diagnostics for the operator.
#
# A failed `mktemp` must not leave an EMPTY redirect target (`2>""` fails the
# whole command): fall back to a pid-keyed path. If that is unwritable too the
# probe fails, which lands on PRESERVE — the safe direction, by construction.
git_err="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/worktree-cleanup-err.$$")"
trap 'rm -f "$git_err"' EXIT

while IFS= read -r wt; do
  [ -n "$wt" ] || continue

  # The directory is already gone — there is nothing to preserve and nothing to
  # remove; `prune` below drops the stale admin entry.
  if [ ! -d "$wt" ]; then
    continue
  fi

  # THE PROBE MUST BE POINTED AT A WORKTREE ROOT — the same guard merge.ts's
  # `worktreeDirt` applies, and the reason this loop cannot just call `status`.
  # `git -C <dir> status` WALKS UP to the enclosing repo, so a registered path
  # that is no longer a worktree root (a crashed `worktree add`, a `.git` file
  # deleted while the directory survived INSIDE the checkout, a plain directory
  # recreated at the deterministic path) reports the SHARED CHECKOUT's dirt as
  # this tree's. That is a false preservation in every direction that matters:
  # exit 3 on a run that preserved nothing, recovery instructions naming files
  # that are not in the named tree, and pr-mode branch teardown pinned at 3 for
  # good. `--show-toplevel` must name `$wt` itself; git prints the
  # SYMLINK-RESOLVED root, so the resolved path counts as a match too (`/tmp` is
  # a symlink on macOS).
  #
  # A rev-parse that says NOTHING (empty/failed — the directory is not in any
  # repo at all) is deliberately NOT skipped: it falls through to the status
  # probe, fails there, and lands on `unverifiable` → PRESERVE. "git cannot
  # classify this directory" and "git says this directory belongs to some other
  # repo" are different answers, and only the second one is evidence of absence.
  wt_top="$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null)"
  wt_real="$(cd "$wt" 2>/dev/null && pwd -P)"
  if [ -n "$wt_top" ] && [ "$wt_top" != "$wt" ] && [ "$wt_top" != "$wt_real" ]; then
    echo "SKIPPED $wt reason=not-a-worktree-root"
    echo "worktree-cleanup.sh: '$wt' is registered as a worktree but its git root is '$wt_top' — NOT probing it; its 'git status' would be that repo's dirt, not this tree's" >&2
    continue
  fi

  # THE DECISION. Untracked files count as dirt: the #541 incident's lost work
  # included files git had never seen. `--untracked-files=all` then EXPANDS an
  # untracked DIRECTORY into its individual files — plain `--porcelain` collapses
  # a whole new `src/feature/` to one `?? src/feature/` line, which still marks
  # the tree dirty but tells the operator nothing about WHAT is in there, and
  # this output is the recovery instructions. Ignored files (node_modules, build
  # output, .env) are deliberately NOT included — they are not work, and treating
  # them as work would preserve every worktree forever.
  if ! dirty="$(git -C "$wt" status --porcelain --untracked-files=all 2>"$git_err")"; then
    echo "PRESERVED worktree $wt reason=unverifiable"
    echo "worktree-cleanup.sh: cannot read git status in '$wt' — PRESERVING it: $(head -c "$max_stderr_bytes" "$git_err")" >&2
    preserved=$((preserved + 1))
    continue
  fi

  if [ -n "$dirty" ]; then
    echo "PRESERVED worktree $wt reason=dirty"
    # The paths (git's own porcelain lines, indented), so the operator can
    # recover the work without guessing what was in there — CAPPED, because this
    # list is the one part of the output whose length is attacker-shaped (an
    # un-ignored build directory is thousands of untracked files) and losing the
    # RESULT line below it would invert the alarm this whole script exists for.
    dirty_lines="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
    printf '%s\n' "$dirty" | head -n "$max_dirty_lines" | sed 's|^|  |'
    if [ "$dirty_lines" -gt "$max_dirty_lines" ]; then
      echo "  … and $((dirty_lines - max_dirty_lines)) more path(s) — see them all with: git -C '$wt' status --porcelain --untracked-files=all"
    fi
    preserved=$((preserved + 1))
    continue
  fi

  # CLEAN — plain remove, never `--force`.
  if rm_err="$(git -C "$repo" worktree remove "$wt" 2>&1)"; then
    echo "REMOVED $wt"
    removed=$((removed + 1))
  else
    # git declined (locked worktree, submodules, a race that dirtied it between
    # our status and this call). Leave it: an orphan worktree is cosmetic, and
    # this script has exactly one job it must never get wrong.
    echo "PRESERVED worktree $wt reason=unverifiable"
    echo "worktree-cleanup.sh: 'git worktree remove' declined for '$wt' — PRESERVING it: $(printf '%s' "$rm_err" | head -c "$max_stderr_bytes")" >&2
    preserved=$((preserved + 1))
  fi
done <<EOF
$worktrees
EOF

# Branch teardown — pr-mode only, and only once the work is provably elsewhere.
if [ "$mode" = "delete-branch" ]; then
  if local_sha="$(git -C "$repo" rev-parse --verify -q "refs/heads/$branch")"; then
    if [ "$preserved" -gt 0 ]; then
      # A preserved worktree still has this branch checked out (git would refuse
      # the delete anyway), and its work is un-committed on top of these commits.
      echo "PRESERVED branch $branch reason=worktree-preserved"
      preserved=$((preserved + 1))
    # THE ONLY NETWORK CALL IN THE SCRIPT, and it runs inside a `finally{}`. It
    # is hard-capped in wall-clock as well as un-promptable (GIT_TERMINAL_PROMPT
    # at the top): a black-holed origin answers neither, and a cleanup that hangs
    # forever is a hung run. `timeout` is coreutils and not universal (a bare
    # macOS has no such binary), so it is used only when present — and a timeout
    # kill exits non-zero, which lands on `ls-remote-failed` → KEEP the branch,
    # the safe direction, exactly like an unreachable remote.
    #
    # stderr kept OUT of `remote_out` for the same reason as the status probe:
    # anything git writes there (a trace, a "Warning: Permanently added … to the
    # list of known hosts") would otherwise become line 1 and be read as the
    # remote sha — a pushed branch would look "unpushed" forever.
    elif ! remote_out="$("${ls_remote[@]}" -C "$repo" ls-remote origin "refs/heads/$branch" 2>"$git_err")"; then
      echo "PRESERVED branch $branch reason=ls-remote-failed"
      echo "worktree-cleanup.sh: cannot reach origin to prove '$branch' is pushed — KEEPING it: $(head -c "$max_stderr_bytes" "$git_err")" >&2
      preserved=$((preserved + 1))
    else
      remote_sha="$(printf '%s\n' "$remote_out" | awk 'NR==1{print $1}')"
      if [ -z "$remote_sha" ]; then
        echo "PRESERVED branch $branch reason=not-on-origin"
        echo "worktree-cleanup.sh: origin has no '$branch' — its commits exist ONLY here; KEEPING it" >&2
        preserved=$((preserved + 1))
      elif [ "$remote_sha" != "$local_sha" ]; then
        echo "PRESERVED branch $branch reason=unpushed"
        echo "worktree-cleanup.sh: origin/$branch is $remote_sha but local is $local_sha — KEEPING the local branch" >&2
        preserved=$((preserved + 1))
      else
        # origin holds this exact sha: the local branch is a disposable copy.
        if git -C "$repo" branch -D "$branch" >/dev/null 2>&1; then
          echo "DELETED branch $branch"
        else
          # git refuses while SOME worktree still has the branch checked out. The
          # linked ones were all walked above (removed, or preserved — and then
          # `$preserved` is non-zero and we never got here), so what is left is
          # the SHARED CHECKOUT, deliberately skipped. Nothing is at risk: origin
          # was just proved to hold this exact sha. Report it and stay exit 0 —
          # scoring it as a preservation would cry wolf on every run.
          echo "KEPT branch $branch reason=checked-out"
        fi
      fi
    fi
  fi
fi

# Safe unconditionally: `prune` only drops admin entries whose working directory
# is already gone. It never deletes a working tree, so a preserved one survives.
git -C "$repo" worktree prune >/dev/null 2>&1

echo "RESULT preserved=$preserved removed=$removed"
[ "$preserved" -eq 0 ] || exit 3
