#!/usr/bin/env bash
set -uo pipefail

# #1133 -- the message rewrite below must be byte-exact except for the line it removes, so
# this filter works on the raw commit OBJECT (`git cat-file commit`, headers up to the first
# empty line, then the message) and never on `git log` output, which is porcelain: re-encoded
# per `i18n.logOutputEncoding` and decorated per `log.showSignature`. `read -r` with an empty
# IFS keeps every byte but the newline, and a final line without one is written back without
# one. The match is a bracket pattern (`[Cc][Ll]...:*`): it runs on bash 3.2 (stock macOS;
# the bash-4 lowercasing expansion dies there with `bad substitution` AFTER the commit
# landed, before the withdrawal), it is case-insensitive for ASCII only, the way git's own
# trailer tokens are, and no non-ASCII byte is touched. `LC_ALL=C` is defence in depth (a byte comparison regardless of the REPL's
# locale -- collation, a Turkish-locale fold); no test discriminates it. Removed: every line
# beginning `Claude-Session:` and, when that emptied its paragraph (the CLI reminder makes the
# agent write the trailer as its own `-m` paragraph), the one empty line that separated that
# paragraph -- the next one, or the previous one when it was last. That removes only that one
# separator; any other blank line the first commit stored (for example under verbatim
# cleanup) is kept as it is. Nothing else changes. Returns 0 when a line was removed.
strip_session_trailer() {
  local LC_ALL=C
  local line in_message=0 ended_with_newline=1
  local -a lines=() drop=()
  while IFS= read -r line; do
    if [ "$in_message" -eq 0 ]; then
      [ -z "$line" ] && in_message=1
      continue
    fi
    lines+=("$line")
  done
  if [ "$in_message" -eq 1 ] && [ -n "$line" ]; then
    lines+=("$line")
    ended_with_newline=0
  fi
  local n=${#lines[@]} i removed=0
  for ((i = 0; i < n; i++)); do
    case "${lines[i]}" in
      [Cc][Ll][Aa][Uu][Dd][Ee]-[Ss][Ee][Ss][Ss][Ii][Oo][Nn]:*) drop[i]=1; removed=1 ;;
      *) drop[i]=0 ;;
    esac
  done
  i=0
  while ((i < n)); do
    if [ -z "${lines[i]}" ]; then ((i++)); continue; fi
    local start=$i whole=1
    while ((i < n)) && [ -n "${lines[i]}" ]; do
      [ "${drop[i]}" -eq 0 ] && whole=0
      ((i++))
    done
    if ((whole)); then
      if ((i < n)) && [ -z "${lines[i]}" ]; then drop[i]=1
      elif ((start > 0)) && [ -z "${lines[start - 1]}" ]; then drop[start - 1]=1
      fi
    fi
  done
  local last=-1
  for ((i = 0; i < n; i++)); do [ "${drop[i]}" -eq 0 ] && last=$i; done
  for ((i = 0; i <= last; i++)); do
    [ "${drop[i]}" -eq 1 ] && continue
    if ((i < last)) || [ "$ended_with_newline" -eq 1 ] || ((last < n - 1)); then
      printf '%s\n' "${lines[i]}"
    else
      printf '%s' "${lines[i]}"
    fi
  done
  return $((1 - removed))
}

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
  # Raw object bytes in, raw message bytes out (see strip_session_trailer); the files, not
  # shell variables, carry them, so no trailing newline is lost on the way to `-F`.
  raw_object=$(mktemp)
  stripped_message=$(mktemp)
  trap 'rm -f "$raw_object" "$stripped_message"' EXIT
  git cat-file commit "$new_head" >"$raw_object"
  cat_exit=$?
  if [ "$cat_exit" -ne 0 ]; then
    # Fail CLOSED, and check the withdrawal (see the amend path below for why): a reset
    # that fails must be reported as the commit REMAINING, never as "was withdrawn".
    git reset -q --soft "$head_oid"
    reset_exit=$?
    if [ "$reset_exit" -ne 0 ]; then
      echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit) AND the commit could not be withdrawn (git reset --soft $head_oid exited $reset_exit); $new_head is on the branch and may carry the trailer" >&2
      exit "$cat_exit"
    fi
    echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit); the commit was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; an in-progress merge, cherry-pick or revert that the withdrawn commit concluded is not restored (MERGE_HEAD and its siblings are gone) -- re-run it before retrying" >&2
    exit "$cat_exit"
  fi
  if strip_session_trailer <"$raw_object" >"$stripped_message"; then
    # The amend must repeat the flags of the commit it rewrites, or the two halves
    # disagree: a `-S`/`--gpg-sign` commit would be amended unsigned, and `--allow-empty` or
    # `--allow-empty-message` would be refused the second time round. Scan the original argv
    # for exactly those and forward them; a bare `--` ends the options, so stop there.
    # `--cleanup` is NOT forwarded: the first commit already applied whatever mode argv or
    # `commit.cleanup` asked for, and the amend below stores the filtered bytes verbatim.
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
        -S|-S?*|--gpg-sign|--gpg-sign=*|--no-gpg-sign|--allow-empty|--allow-empty-message) amend_flags+=("$arg") ;;
        -m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--fixup|--squash|--reuse-message|--reedit-message|--trailer|--pathspec-from-file|--cleanup) value_of=skip ;;
        # A cluster of boolean short flags whose LAST letter takes the next argv element
        # (-am, -qm, -sm, -nm, -om, -aF, ...). An attached value (`-Ffile.txt`, `-Cabc`) is
        # not a cluster: a non-flag letter before the last one leaves the next arg alone.
        -[!-]*[mFCct])
          case "${arg%?}" in
            -*[!apqvnseioz]*) ;;
            *) value_of=skip ;;
          esac ;;
      esac
    done
    # `--only`: an amend without paths re-snapshots the CURRENT index, so a pathspec commit
    # (`git commit -m ... -- a.txt` with b.txt also staged) would silently absorb every other
    # staged file into the published commit. `--only --amend` with no paths rewrites the
    # message over the tree the first commit already has; the index is left as it was.
    # `--cleanup=verbatim`: the bytes in $stripped_message are the first commit's message
    # minus the trailer, already cleaned by whatever mode that commit ran under, so the amend
    # must not clean them again (`whitespace` would trim every line's trailing spaces and
    # override a `commit.cleanup` the agent never overrode on argv). `--amend` keeps the
    # author. `--no-verify` because the hooks already
    # vetted this exact tree seconds ago and the amend changes only the message: re-running a
    # hook that the first commit skipped with `--no-verify` (an unlinked managed hook exits
    # 68) would fail the amend and leave the trailer in. Not `-q`: git's second
    # `[branch sha] subject` line names the commit that is actually on the branch, and the
    # line printed below spells out both shas in full.
    git commit --amend --only --no-verify --cleanup=verbatim -F "$stripped_message" ${amend_flags[@]+"${amend_flags[@]}"}
    amend_exit=$?
    if [ "$amend_exit" -ne 0 ]; then
      # Fail CLOSED. The commit that landed a moment ago is exactly the one this guard
      # promises can never reach the branch, and in pr mode the outer loop publishes the
      # branch head, so it must not be left at HEAD for a later commit to carry along.
      # `reset --soft` moves the branch back to where the probe found it and keeps the
      # index and worktree as the first commit left them, so Forge can retry; the
      # trailer-bearing commit survives only in the reflog. What it cannot restore is the
      # sequencer state the first commit CONSUMED: a merge, cherry-pick or revert in
      # progress (MERGE_HEAD, MERGE_MSG, CHERRY_PICK_HEAD, REVERT_HEAD) is concluded by that
      # commit and gone after the reset. The loss is named on stderr rather than snapshotted
      # and restored: the wrapper's contract is the trailer, not the sequencer.
      git reset -q --soft "$head_oid"
      reset_exit=$?
      if [ "$reset_exit" -ne 0 ]; then
        echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit) AND the commit could not be withdrawn (git reset --soft $head_oid exited $reset_exit); $new_head is on the branch WITH the trailer" >&2
        exit "$amend_exit"
      fi
      echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit); the commit $new_head was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; an in-progress merge, cherry-pick or revert that the withdrawn commit concluded is not restored (MERGE_HEAD and its siblings are gone) -- re-run it before retrying" >&2
      exit "$amend_exit"
    fi
    # The pre-strip commit $new_head was amended away and survives only in the reflog; a
    # `[branch sha]` summary line naming it (printed unless the commit ran `-q`) is stale.
    # Anyone copying a sha from stdout must take this one; Forge is told to `git rev-parse HEAD`.
    stripped_head=$(git rev-parse --verify HEAD)
    echo "commit-with-resolved-head: Claude-Session trailer stripped; HEAD is now $stripped_head (pre-strip commit $new_head was amended away; a [branch sha] summary line naming it is stale)"
  fi
fi
