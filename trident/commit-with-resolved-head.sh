#!/usr/bin/env bash
set -uo pipefail

expected_branch=${1-}
if [ -z "$expected_branch" ]; then
  echo "commit refused: expected branch was not supplied" >&2
  exit 64
fi
shift

probe_err=$(mktemp)
trap 'rm -f "$probe_err"' EXIT

head_oid=$(git rev-parse --verify HEAD 2>"$probe_err")
probe_exit=$?
if [ "$probe_exit" -ne 0 ]; then
  detail=$(tr '\n' ' ' <"$probe_err" | sed 's/[[:space:]]*$//')
  echo "commit refused: HEAD does not resolve for branch '$expected_branch' (git rev-parse --verify HEAD exited $probe_exit${detail:+: $detail})" >&2
  exit 65
fi

if [ -z "$head_oid" ]; then
  echo "commit refused: HEAD resolution returned no object for branch '$expected_branch'" >&2
  exit 66
fi

case "$head_oid" in
  *[!0-9a-fA-F]*|'')
    echo "commit refused: HEAD resolved unexpectedly for branch '$expected_branch': '$head_oid'" >&2
    exit 67
    ;;
esac

# The probe's temp file used to leak on the success path because the commit was `exec`ed
# (measured at 5 files for 5 guarded commits). The commit now runs as a child so this
# shell survives to strip the trailer below; the EXIT trap therefore runs, but tidy up
# here explicitly too, so the scratch file never outlives the probe it was made for.
rm -f "$probe_err"
trap - EXIT

git commit "$@"
commit_exit=$?
if [ "$commit_exit" -ne 0 ]; then
  exit "$commit_exit"
fi

# #1133 -- no loop-authored commit carries a `Claude-Session:` trailer. The agent writes the
# message itself, obeying whatever attribution reminder its CLI injected; the per-session
# settings silence that reminder at the source, and this is the one deterministic,
# model-independent place every Forge commit passes through, so the guarantee lives here
# regardless of what the model was told. Only the session trailer is dropped; the
# `Co-Authored-By:` trailer, the subject, the author and the parent are left untouched.
# Only rewrite the commit THIS invocation created: `--dry-run` or a no-op commit leaves
# HEAD where the probe found it, and an older commit must never be amended by mistake.
new_head=$(git rev-parse --verify HEAD 2>/dev/null)
if [ -n "$new_head" ] && [ "$new_head" != "$head_oid" ]; then
  message=$(git log -1 --format=%B)
  stripped=$(printf '%s\n' "$message" | grep -v -e '^Claude-Session:')
  if [ "$stripped" != "$message" ]; then
    # The amend must repeat the flags of the commit it rewrites, or the two halves
    # disagree: a `-S`/`--gpg-sign` commit would be amended unsigned, `--allow-empty` or
    # `--allow-empty-message` would be refused the second time round, and an explicit
    # `--cleanup=<mode>` would be overridden by the default below. Scan the original argv
    # for exactly those and forward them; a bare `--` ends the options, so stop there.
    # An option that takes its VALUE as the next argv element (`-m`, `-F`, `--author`, ...)
    # has that value skipped, so a paragraph that happens to begin with `-S` is never
    # mistaken for a signing flag and handed to the amend as a key id.
    amend_flags=()
    value_of=''
    for arg in "$@"; do
      if [ -n "$value_of" ]; then
        [ "$value_of" = forward ] && amend_flags+=("$arg")
        value_of=''
        continue
      fi
      case "$arg" in
        --) break ;;
        -S|-S?*|--gpg-sign|--gpg-sign=*|--no-gpg-sign|--allow-empty|--allow-empty-message|--cleanup=*) amend_flags+=("$arg") ;;
        --cleanup) amend_flags+=("$arg"); value_of=forward ;;
        -m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--fixup|--squash|--reuse-message|--reedit-message|--trailer|--pathspec-from-file) value_of=skip ;;
      esac
    done
    # `--only`: an amend without paths re-snapshots the CURRENT index, so a pathspec commit
    # (`git commit -m ... -- a.txt` with b.txt also staged) would silently absorb every other
    # staged file into the published commit. `--only --amend` with no paths rewrites the
    # message over the tree the first commit already has; the index is left as it was.
    # `--cleanup=whitespace` collapses the blank line the removed trailer leaves and is the
    # same cleanup a `-m` commit already had (a forwarded `--cleanup=<mode>` comes later on
    # the line and wins); `--amend` keeps the author. `--no-verify` because the hooks already
    # vetted this exact tree seconds ago and the amend changes only the message: re-running a
    # hook that the first commit skipped with `--no-verify` (an unlinked managed hook exits
    # 68) would fail the amend and leave the trailer in. Not `-q`: git's second
    # `[branch sha] subject` line names the commit that is actually on the branch, and the
    # line printed below spells out both shas in full.
    printf '%s\n' "$stripped" | git commit --amend --only --no-verify --cleanup=whitespace -F - ${amend_flags[@]+"${amend_flags[@]}"}
    amend_exit=$?
    if [ "$amend_exit" -ne 0 ]; then
      # Fail CLOSED. The commit that landed a moment ago is exactly the one this guard
      # promises can never reach the branch, and in pr mode the outer loop publishes the
      # branch head, so it must not be left at HEAD for a later commit to carry along.
      # `reset --soft` moves the branch back to where the probe found it and keeps the
      # index and worktree as the first commit left them, so Forge can retry; the
      # trailer-bearing commit survives only in the reflog.
      git reset -q --soft "$head_oid"
      reset_exit=$?
      if [ "$reset_exit" -ne 0 ]; then
        echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit) AND the commit could not be withdrawn (git reset --soft $head_oid exited $reset_exit); $new_head is on the branch WITH the trailer" >&2
        exit "$amend_exit"
      fi
      echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit); the commit $new_head was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes" >&2
      exit "$amend_exit"
    fi
    # The pre-strip commit $new_head was amended away and survives only in the reflog; a
    # `[branch sha]` summary line naming it (printed unless the commit ran `-q`) is stale.
    # Anyone copying a sha from stdout must take this one; Forge is told to `git rev-parse HEAD`.
    stripped_head=$(git rev-parse --verify HEAD)
    echo "commit-with-resolved-head: Claude-Session trailer stripped; HEAD is now $stripped_head (pre-strip commit $new_head was amended away; a [branch sha] summary line naming it is stale)"
  fi
fi
