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
#
# Every withdrawal below is a compare-and-swap, never a blind `reset --soft`: the branch is
# moved back to the probed HEAD ONLY if it still names the commit this wrapper is
# withdrawing (`git update-ref HEAD <probed> <expected>`; git refuses with `cannot lock ref`
# when it names anything else, and rewrites nothing). A blind reset withdrew whatever HEAD
# named, so a commit some other writer landed on top would have gone with it, and when HEAD
# was a dangling symref the reset "succeeded" by creating the missing branch at the probed
# oid while the real branch kept the trailer commit. The index and worktree are untouched
# either way (update-ref moves the ref only), so Forge can retry from the staged change.
# The reflog entry names the withdrawn commit.
withdraw_commit() {
  git update-ref -m "commit-with-resolved-head: withdraw $1 (Claude-Session check)" HEAD "$head_oid" "$1"
}
UNRESTORED='an in-progress merge, cherry-pick or revert that the withdrawn commit concluded is not restored (MERGE_HEAD and its siblings are gone) -- re-run it before retrying'

scratch_err=$(mktemp)
raw_object=$(mktemp)
stripped_message=$(mktemp)
raw_after=$(mktemp)
trap 'rm -f "$scratch_err" "$raw_object" "$stripped_message" "$raw_after"' EXIT

# The re-probe is checked on BOTH its exit status and its output. An unchecked answer let a
# failing `rev-parse` read as "HEAD did not move" (the `--dry-run`/no-op case above), which
# skipped the strip and exited 0 with the trailer on the branch -- fail OPEN. It now fails
# CLOSED with a code of this path's own -- 69 when the re-probe failed, 70 when it succeeded
# and named no object -- so the two are told apart on stderr and in tests. It does NOT
# withdraw: with no readable HEAD there is no expected value to compare against, so any
# rewrite of the ref would be blind (see withdraw_commit), and the wrapper refuses to move
# a branch it cannot read. The commit this invocation created, if any, stays where git put
# it and is named as possibly carrying the trailer; the caller inspects before retrying.
new_head=$(git rev-parse --verify HEAD 2>"$scratch_err")
reprobe_exit=$?
if [ "$reprobe_exit" -ne 0 ] || [ -z "$new_head" ]; then
  if [ "$reprobe_exit" -ne 0 ]; then
    detail=$(tr '\n' ' ' <"$scratch_err" | sed 's/[[:space:]]*$//')
    reprobe_why="git rev-parse --verify HEAD exited $reprobe_exit${detail:+: $detail}"
    reprobe_code=69
  else
    reprobe_why="git rev-parse --verify HEAD named no object"
    reprobe_code=70
  fi
  echo "commit refused: HEAD could not be re-read after the commit for the Claude-Session check ($reprobe_why); nothing was rewritten and the branch was NOT reset, because without a readable HEAD there is no value to compare against and a blind reset could discard a commit this invocation did not make; the commit this invocation created, if any, is on the branch and may carry the trailer (HEAD was $head_oid before the commit) -- inspect the branch before retrying" >&2
  exit "$reprobe_code"
fi
if [ "$new_head" != "$head_oid" ]; then
  # Raw object bytes in, raw message bytes out (see strip_session_trailer); the files, not
  # shell variables, carry them, so no trailing newline is lost on the way to `-F`.
  git cat-file commit "$new_head" >"$raw_object"
  cat_exit=$?
  if [ "$cat_exit" -ne 0 ]; then
    # Fail CLOSED, and check the withdrawal (see the amend path below for why): a
    # compare-and-swap that is refused must be reported as the commit REMAINING, never as
    # "was withdrawn".
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit) AND the commit could not be withdrawn (git update-ref HEAD $head_oid $new_head exited $withdraw_exit -- the branch no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on the branch and may carry the trailer" >&2
      exit "$cat_exit"
    fi
    echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit); the commit was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
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
    # mistaken for a signing flag and handed to the amend as a key id. No option's value is
    # ever forwarded: the amend keeps the first commit's author, date and message source,
    # so the scan only ever skips. Short flags cluster: git reads `-aS` as `-a -S` and
    # `-sSkey` as `-s -Skey`, so a signing letter inside a cluster of boolean short flags is
    # forwarded as its own `-S[<keyid>]`, or a signed first commit would be re-stored
    # unsigned.
    amend_flags=()
    skip_value=0
    for arg in "$@"; do
      if [ "$skip_value" -eq 1 ]; then
        skip_value=0
        continue
      fi
      case "$arg" in
        --) break ;;
        -S|-S?*|--gpg-sign|--gpg-sign=*|--no-gpg-sign|--allow-empty|--allow-empty-message) amend_flags+=("$arg") ;;
        -m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--fixup|--squash|--reuse-message|--reedit-message|--trailer|--pathspec-from-file|--cleanup) skip_value=1 ;;
        # A cluster of boolean short flags with `S` inside it (-aS, -sS, -asS, -aSkeyid). Git
        # reads every letter before the first `S` as its own flag and everything after it as
        # the optional key id, so the signing half is forwarded alone as `-S<rest>`; the
        # boolean half means nothing to an `--only` amend with no paths. A value-taking
        # letter before the `S` (`-mS`, `-CS`) makes the `S` that option's attached value,
        # not a flag, so such a cluster forwards nothing.
        -[!-]*S*)
          case "${arg%%S*}" in
            -*[!apqvnseioz]*) ;;
            *) amend_flags+=("-S${arg#*S}") ;;
          esac ;;
        # A cluster of boolean short flags whose LAST letter takes the next argv element
        # (-am, -qm, -sm, -nm, -om, -aF, ...). An attached value (`-Ffile.txt`, `-Cabc`) is
        # not a cluster: a non-flag letter before the last one leaves the next arg alone.
        -[!-]*[mFCct])
          case "${arg%?}" in
            -*[!apqvnseioz]*) ;;
            *) skip_value=1 ;;
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
      # The compare-and-swap moves the branch back to where the probe found it, if and only
      # if it still names the commit being withdrawn, and keeps the index and worktree as
      # the first commit left them, so Forge can retry; the trailer-bearing commit survives
      # only in the reflog. What it cannot restore is the sequencer state the first commit
      # CONSUMED: a merge, cherry-pick or revert in progress (MERGE_HEAD, MERGE_MSG,
      # CHERRY_PICK_HEAD, REVERT_HEAD) is concluded by that commit and gone. The loss is
      # named on stderr rather than snapshotted and restored: the wrapper's contract is the
      # trailer, not the sequencer.
      withdraw_commit "$new_head"
      withdraw_exit=$?
      if [ "$withdraw_exit" -ne 0 ]; then
        echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit) AND the commit could not be withdrawn (git update-ref HEAD $head_oid $new_head exited $withdraw_exit -- the branch no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on the branch WITH the trailer" >&2
        exit "$amend_exit"
      fi
      echo "commit refused: the Claude-Session trailer could not be stripped (git commit --amend exited $amend_exit); the commit $new_head was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
      exit "$amend_exit"
    fi
    # A zero exit from the amend is not evidence the trailer is gone: `--no-verify` skips
    # pre-commit and commit-msg only, so a `prepare-commit-msg` hook still runs on the amend
    # and can hand git a message with the trailer put back (measured: the amend then stores
    # an object identical to the pre-strip one and exits 0). The post-condition is therefore
    # MEASURED, not inferred: read the commit that is on the branch now as the raw object and
    # run the same filter over it; a filter that finds a line to remove means the trailer is
    # still there, and the commit is withdrawn (compare-and-swap against the head just read)
    # with exit 73. A HEAD that cannot be re-read here is refused without any rewrite, as
    # after the first commit (71 failed, 72 named nothing); a read-back that fails withdraws
    # against the head just read and exits git's code, as on the pre-amend path.
    stripped_head=$(git rev-parse --verify HEAD 2>"$scratch_err")
    after_exit=$?
    if [ "$after_exit" -ne 0 ] || [ -z "$stripped_head" ]; then
      if [ "$after_exit" -ne 0 ]; then
        detail=$(tr '\n' ' ' <"$scratch_err" | sed 's/[[:space:]]*$//')
        after_why="git rev-parse --verify HEAD exited $after_exit${detail:+: $detail}"
        after_code=71
      else
        after_why="git rev-parse --verify HEAD named no object"
        after_code=72
      fi
      echo "commit refused: HEAD could not be re-read after the Claude-Session strip amend ($after_why); nothing was rewritten and the branch was NOT reset, because without a readable HEAD there is no value to compare against; the amended commit is on the branch and its message was not verified, so it may carry the trailer (HEAD was $head_oid before the commit, $new_head before the amend) -- inspect the branch before retrying" >&2
      exit "$after_code"
    fi
    git cat-file commit "$stripped_head" >"$raw_after"
    after_cat_exit=$?
    if [ "$after_cat_exit" -ne 0 ]; then
      withdraw_commit "$stripped_head"
      withdraw_exit=$?
      if [ "$withdraw_exit" -ne 0 ]; then
        echo "commit refused: the amended commit $stripped_head could not be read back to verify the Claude-Session strip (git cat-file exited $after_cat_exit) AND the commit could not be withdrawn (git update-ref HEAD $head_oid $stripped_head exited $withdraw_exit -- the branch no longer names $stripped_head, or the ref could not be locked; nothing was rewritten); $stripped_head is on the branch and may carry the trailer" >&2
        exit "$after_cat_exit"
      fi
      echo "commit refused: the amended commit $stripped_head could not be read back to verify the Claude-Session strip (git cat-file exited $after_cat_exit); the commit was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
      exit "$after_cat_exit"
    fi
    if strip_session_trailer <"$raw_after" >/dev/null; then
      withdraw_commit "$stripped_head"
      withdraw_exit=$?
      if [ "$withdraw_exit" -ne 0 ]; then
        echo "commit refused: the Claude-Session trailer is STILL on the amended commit $stripped_head (a prepare-commit-msg hook, which --no-verify does not skip, can put it back) AND the commit could not be withdrawn (git update-ref HEAD $head_oid $stripped_head exited $withdraw_exit -- the branch no longer names $stripped_head, or the ref could not be locked; nothing was rewritten); $stripped_head is on the branch WITH the trailer" >&2
        exit 73
      fi
      echo "commit refused: the Claude-Session trailer is STILL on the amended commit $stripped_head (a prepare-commit-msg hook, which --no-verify does not skip, can put it back); the commit was withdrawn, HEAD is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
      exit 73
    fi
    # The pre-strip commit $new_head was amended away and survives only in the reflog; a
    # `[branch sha]` summary line naming it (printed unless the commit ran `-q`) is stale.
    # Anyone copying a sha from stdout must take this one; Forge is told to `git rev-parse HEAD`.
    # The two shas differ by construction: an amend that stored the same object stored the
    # same message, trailer included, and was withdrawn just above.
    echo "commit-with-resolved-head: Claude-Session trailer stripped; HEAD is now $stripped_head (pre-strip commit $new_head was amended away; a [branch sha] summary line naming it is stale)"
  fi
fi
