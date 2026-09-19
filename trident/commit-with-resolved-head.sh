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

# #1133 -- PROVENANCE, captured before the commit. Everything after `git commit` below acts
# on the REF this commit moves and the OBJECT it created, never on "whatever HEAD names
# now": a branch switch, a re-pointed symref or a hook that moves HEAD between the commit
# and the strip must not redirect a rewrite or a withdrawal onto some other branch. So the
# ref is resolved here -- `refs/heads/<x>` when HEAD is a symref, the literal `HEAD` when
# it is detached (`symbolic-ref -q` exits 1 and prints nothing) -- and every later read and
# every ref update names $target_ref. The parent the new commit must have is known here
# too: the probed HEAD, or, for an `--amend`, the amended commit's own first parent (empty
# for a root commit); a commit on the ref whose first parent is anything else was made by
# some other writer and is never rewritten or withdrawn (see the provenance check below).
target_ref=$(git symbolic-ref -q HEAD 2>"$probe_err")
symref_exit=$?
if [ "$symref_exit" -eq 1 ] && [ -z "$target_ref" ]; then
  target_ref=HEAD
elif [ "$symref_exit" -ne 0 ] || [ -z "$target_ref" ]; then
  detail=$(tr '\n' ' ' <"$probe_err" | sed 's/[[:space:]]*$//')
  echo "commit refused: the ref HEAD names could not be determined for branch '$expected_branch' (git symbolic-ref -q HEAD exited $symref_exit${detail:+: $detail})" >&2
  exit 77
fi

# THE ONE ARGV SCAN. Everything this wrapper needs to know about the agent's `git commit`
# argv is read here, once, before the commit, by one set of rules: whether this is an
# `--amend` (decides the expected parent for the provenance check below), the signing key
# to repeat on the rebuilt commit (`-S<key>`, `--gpg-sign=<key>`, the signing letter inside
# a boolean short-flag cluster such as `-aS<key>` / `-sSkey`; a bare `-S` for the
# configured default key when argv named none), and `--allow-empty-message` (commit-tree
# accepts an empty message, git commit does not, and the rebuilt commit must not be one
# git would have refused). An option that takes its VALUE as the next argv element (`-m`,
# `-F`, `--author`, ...) has that value skipped, so a paragraph that happens to be `--amend`
# or to begin with `-S` is never read as the flag it spells: the former would derive the
# wrong expected parent and refuse a legitimate commit with the trailer left on the ref,
# the latter would hand commit-tree a key id. Short flags cluster: git reads `-aS` as
# `-a -S` and `-sSkey` as `-s -Skey`. A bare `--` ends the options, so the scan stops there.
scan_commit_argv() {
  local arg skip_value=0
  amending=0
  sign_flag=-S
  allow_empty_message=0
  for arg in "$@"; do
    if [ "$skip_value" -eq 1 ]; then
      skip_value=0
      continue
    fi
    case "$arg" in
      --) break ;;
      --amend) amending=1 ;;
      -S|--gpg-sign|--no-gpg-sign) sign_flag=-S ;;
      -S?*) sign_flag=$arg ;;
      --gpg-sign=*) sign_flag="-S${arg#--gpg-sign=}" ;;
      --allow-empty-message) allow_empty_message=1 ;;
      -m|-F|-C|-c|-t|--message|--file|--author|--date|--template|--fixup|--squash|--reuse-message|--reedit-message|--trailer|--pathspec-from-file|--cleanup) skip_value=1 ;;
      # A cluster of boolean short flags with `S` inside it (-aS, -sS, -asS, -aSkeyid). Git
      # reads every letter before the first `S` as its own flag and everything after it as
      # the optional key id. A value-taking letter before the `S` (`-mS`, `-CS`) makes the
      # `S` that option's attached value, not a flag, so such a cluster forwards nothing.
      -[!-]*S*)
        case "${arg%%S*}" in
          -*[!apqvnseioz]*) ;;
          *) sign_flag="-S${arg#*S}" ;;
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
}
scan_commit_argv "$@"
expected_parent=$head_oid
if [ "$amending" -eq 1 ]; then
  amend_raw=$(git cat-file commit "$head_oid" 2>"$probe_err")
  amend_read_exit=$?
  expected_parent=$(printf '%s\n' "$amend_raw" | sed -n '/^$/q; s/^parent //p' | sed -n '1p')
  if [ "$amend_read_exit" -ne 0 ]; then
    detail=$(tr '\n' ' ' <"$probe_err" | sed 's/[[:space:]]*$//')
    echo "commit refused: the commit to amend ($head_oid on $target_ref) could not be read for the Claude-Session provenance check (git cat-file exited $amend_read_exit${detail:+: $detail})" >&2
    exit 77
  fi
fi

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
# `Co-Authored-By:` trailer, the subject, the author, the tree and the parents are left
# untouched. Only the commit THIS invocation created is rewritten: `--dry-run` or a no-op
# commit leaves $target_ref where the probe found it, and a commit whose first parent is
# not the one this invocation was going to produce belongs to another writer.
#
# The rewrite is BUILT, not amended. `git commit --amend` was the one remaining branch
# rewrite with no expected-value check (a commit another writer landed between the
# read-back and the amend got ITS message replaced by the stripped one over their tree),
# and it ran hooks (`--no-verify` skips pre-commit and commit-msg only; a
# `prepare-commit-msg` hook put the trailer straight back, and a `post-commit` hook could
# land a follow-up on top of a trailer commit). So the stripped commit is made with
# `git commit-tree` from the raw object's own tree, parents, author, committer and encoding
# (no hook runs, no index is read), the CANDIDATE is read back and verified before any ref
# names it, and it is published by compare-and-swap: `git update-ref $target_ref
# <candidate> <the exact object this invocation created>`. A lost swap rewrites nothing.
#
# Every withdrawal is the same compare-and-swap, never a blind reset: the ref is moved back
# to the probed HEAD ONLY if it still names the commit this wrapper is withdrawing (git
# refuses with `cannot lock ref` when it names anything else, and rewrites nothing). The
# index and worktree are untouched either way (update-ref moves the ref only), so Forge can
# retry from the staged change. The reflog entry names the withdrawn commit.
withdraw_commit() {
  git update-ref -m "commit-with-resolved-head: withdraw $1 (Claude-Session check)" "$target_ref" "$head_oid" "$1"
}
UNRESTORED='an in-progress merge, cherry-pick or revert that the withdrawn commit concluded is not restored (MERGE_HEAD and its siblings are gone) -- re-run it before retrying'

# Header parse of a raw commit object on stdin (headers up to the first empty line). A line
# beginning with a space continues the previous header (`gpgsig`, `gpgsig-sha256`,
# `mergetag`). Only the headers `commit-tree` can rebuild are accepted: tree, parent (in
# order), author, committer, encoding, and a signature, which is not copied but
# re-made (a signature over the old bytes would not verify over the new). Any other header
# -- `mergetag`, or one this wrapper does not know -- is named in $obj_bad_header and the
# commit is refused rather than rebuilt without it.
parse_commit_object() {
  local LC_ALL=C
  local line prev=''
  obj_tree='' obj_author='' obj_committer='' obj_encoding='' obj_signed=0 obj_bad_header=''
  obj_parents=()
  while IFS= read -r line; do
    [ -z "$line" ] && break
    case "$line" in
      ' '*)
        case "$prev" in
          gpgsig|gpgsig-sha256) ;;
          *) [ -z "$obj_bad_header" ] && obj_bad_header=$prev ;;
        esac
        continue ;;
      'tree '*) obj_tree=${line#tree }; prev=tree ;;
      'parent '*) obj_parents+=("${line#parent }"); prev=parent ;;
      'author '*) obj_author=${line#author }; prev=author ;;
      'committer '*) obj_committer=${line#committer }; prev=committer ;;
      'encoding '*) obj_encoding=${line#encoding }; prev=encoding ;;
      'gpgsig '*|'gpgsig-sha256 '*) obj_signed=1; prev=${line%% *} ;;
      *) prev=${line%% *}; [ -z "$obj_bad_header" ] && obj_bad_header=${prev:-'(empty)'} ;;
    esac
  done
  if [ -z "$obj_tree" ] || [ -z "$obj_author" ] || [ -z "$obj_committer" ]; then
    [ -z "$obj_bad_header" ] && obj_bad_header='(missing tree, author or committer)'
  fi
}

# `Name <email> <epoch> <tz>` -> the three parts commit-tree takes from the environment.
# Git never writes `<` or `>` into a name, so the first `<` is where the name ends; a name
# may be empty, in which case the line begins with `<`.
split_ident() {
  local ident=$1 rest
  ident_name=${ident%%<*}
  ident_name=${ident_name% }
  rest=${ident#*<}
  ident_email=${rest%%>*}
  ident_date=${rest#*> }
}

scratch_err=$(mktemp)
raw_object=$(mktemp)
stripped_message=$(mktemp)
raw_after=$(mktemp)
trap 'rm -f "$scratch_err" "$raw_object" "$stripped_message" "$raw_after"' EXIT

# The re-probe reads $target_ref, not HEAD, and is checked on BOTH its exit status and its
# output. An unchecked answer let a failing `rev-parse` read as "nothing moved" (the
# `--dry-run`/no-op case), which skipped the strip and exited 0 with the trailer on the
# branch -- fail OPEN. It now fails CLOSED with a code of this path's own -- 69 when the
# re-probe failed, 70 when it succeeded and named no object -- so the two are told apart on
# stderr and in tests. It does NOT withdraw: with no readable value there is nothing to
# compare against, so any rewrite of the ref would be blind (see withdraw_commit), and the
# wrapper refuses to move a ref it cannot read. The commit this invocation created, if any,
# stays where git put it and is named as carrying the trailer if the message had one; the
# caller inspects before retrying.
new_head=$(git rev-parse --verify "$target_ref" 2>"$scratch_err")
reprobe_exit=$?
if [ "$reprobe_exit" -ne 0 ] || [ -z "$new_head" ]; then
  if [ "$reprobe_exit" -ne 0 ]; then
    detail=$(tr '\n' ' ' <"$scratch_err" | sed 's/[[:space:]]*$//')
    reprobe_why="git rev-parse --verify $target_ref exited $reprobe_exit${detail:+: $detail}"
    reprobe_code=69
  else
    reprobe_why="git rev-parse --verify $target_ref named no object"
    reprobe_code=70
  fi
  echo "commit refused: $target_ref could not be re-read after the commit for the Claude-Session check ($reprobe_why); nothing was rewritten and the ref was NOT reset, because without a readable value there is nothing to compare against and a blind reset could discard a commit this invocation did not make; the commit this invocation created, if any, is on $target_ref and carries the trailer if the message had one ($target_ref was $head_oid before the commit) -- inspect the branch before retrying" >&2
  exit "$reprobe_code"
fi
if [ "$new_head" = "$head_oid" ]; then
  exit 0
fi

# Raw object bytes in, raw message bytes out (see strip_session_trailer); the files, not
# shell variables, carry them, so no trailing newline is lost on the way to `-F`.
git cat-file commit "$new_head" >"$raw_object"
cat_exit=$?
if [ "$cat_exit" -ne 0 ]; then
  # Fail CLOSED, and check the withdrawal: a compare-and-swap that is refused must be
  # reported as the commit REMAINING, never as "was withdrawn".
  withdraw_commit "$new_head"
  withdraw_exit=$?
  if [ "$withdraw_exit" -ne 0 ]; then
    echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit) AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref and carries the trailer if the message had one" >&2
    exit "$cat_exit"
  fi
  echo "commit refused: the commit $new_head could not be read back for the Claude-Session check (git cat-file exited $cat_exit); the commit was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
  exit "$cat_exit"
fi

# The provenance check. `git commit` returns no oid, so the object this invocation created
# is identified by its first parent: the commit $target_ref named before (or, for an
# `--amend`, that commit's own first parent). A first parent that is anything else means
# another writer moved the ref after the commit and $new_head is THEIR commit (on top of,
# or in place of, this invocation's): nothing is rewritten -- amending it would replace
# their message, withdrawing it would discard their work -- and both objects are named.
# What this cannot tell apart is a SIBLING: a commit another writer landed from the same
# parent inside the gap, replacing this invocation's. The rewrite below is
# content-preserving (same tree, parents, author, committer; only `Claude-Session:` lines
# removed), so the worst case for such a sibling is losing a Claude-Session line of its own.
parse_commit_object <"$raw_object"
first_parent=${obj_parents[0]-}
if [ "$first_parent" != "$expected_parent" ]; then
  echo "commit refused: $target_ref now names $new_head, whose first parent is ${first_parent:-none}, not the expected ${expected_parent:-none} ($target_ref was $head_oid before the commit), so it was made by another writer after this invocation's commit; nothing was rewritten and nothing was withdrawn; the commit this invocation created is reachable from $new_head and carries the trailer if the message had one -- inspect the branch before retrying" >&2
  exit 76
fi

if strip_session_trailer <"$raw_object" >"$stripped_message"; then
  if [ -n "$obj_bad_header" ]; then
    # commit-tree cannot carry this header (a `mergetag` from a signed-tag merge, or one
    # this wrapper does not know), and a rebuild that silently dropped it would publish a
    # different commit than the one git made. Fail closed: withdraw, and say why.
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: the commit $new_head carries a '$obj_bad_header' header the Claude-Session strip cannot rebuild AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref WITH the trailer" >&2
      exit 75
    fi
    echo "commit refused: the commit $new_head carries a '$obj_bad_header' header the Claude-Session strip cannot rebuild (only tree, parent, author, committer, encoding and a signature are); the commit was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
    exit 75
  fi

  # The rebuilt commit must repeat what the first one was given, or the two halves
  # disagree. The signature is decided by the OBJECT (a `gpgsig` header on $new_head; a
  # `commit.gpgsign` config signs the first commit but `commit-tree` ignores that config,
  # so a config-signed commit would otherwise come out unsigned); the KEY ($sign_flag) and
  # `--allow-empty-message` ($allow_empty_message) come from the one argv scan that ran
  # before the commit (scan_commit_argv, above).

  if [ ! -s "$stripped_message" ] && [ "$allow_empty_message" -eq 0 ]; then
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: the Claude-Session trailer could not be stripped (the message is empty without it, and --allow-empty-message was not given) AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref WITH the trailer" >&2
      exit 1
    fi
    echo "commit refused: the Claude-Session trailer could not be stripped (the message is empty without it, and --allow-empty-message was not given); the commit $new_head was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
    exit 1
  fi

  # Build the candidate from the object's own headers. Author and committer (name, email
  # and the raw `<epoch> <tz>`) go in through the environment, so the candidate's ident
  # lines are byte-identical to $new_head's -- the committer date is not bumped the way an
  # amend bumps it. `</dev/null`: commit-tree reads its message from stdin when the one it
  # was given is empty, and an `--allow-empty-message` commit must not block on the
  # caller's terminal.
  split_ident "$obj_author"
  author_name=$ident_name author_email=$ident_email author_date=$ident_date
  split_ident "$obj_committer"
  committer_name=$ident_name committer_email=$ident_email committer_date=$ident_date
  tree_args=()
  for p in ${obj_parents[@]+"${obj_parents[@]}"}; do
    tree_args+=(-p "$p")
  done
  tree_args+=(-F "$stripped_message")
  if [ "$obj_signed" -eq 1 ]; then
    tree_args+=("$sign_flag")
  fi
  cfg_args=()
  if [ -n "$obj_encoding" ]; then
    cfg_args=(-c "i18n.commitEncoding=$obj_encoding")
  fi
  candidate=$(GIT_AUTHOR_NAME="$author_name" GIT_AUTHOR_EMAIL="$author_email" GIT_AUTHOR_DATE="$author_date" \
    GIT_COMMITTER_NAME="$committer_name" GIT_COMMITTER_EMAIL="$committer_email" GIT_COMMITTER_DATE="$committer_date" \
    git ${cfg_args[@]+"${cfg_args[@]}"} commit-tree "$obj_tree" "${tree_args[@]}" </dev/null 2>"$scratch_err")
  build_exit=$?
  case "$candidate" in
    *[!0-9a-fA-F]*|'') [ "$build_exit" -eq 0 ] && build_exit=1 ;;
  esac
  if [ "$build_exit" -ne 0 ]; then
    # Fail CLOSED. The commit that landed a moment ago is exactly the one this guard
    # promises can never reach the branch, and in pr mode the outer loop publishes the
    # branch head, so it must not be left on the ref for a later commit to carry along.
    # What the withdrawal cannot restore is the sequencer state the first commit CONSUMED:
    # a merge, cherry-pick or revert in progress (MERGE_HEAD, MERGE_MSG, CHERRY_PICK_HEAD,
    # REVERT_HEAD) is concluded by that commit and gone. The loss is named on stderr rather
    # than snapshotted and restored: the wrapper's contract is the trailer, not the sequencer.
    detail=$(tr '\n' ' ' <"$scratch_err" | sed 's/[[:space:]]*$//')
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: the Claude-Session trailer could not be stripped (git commit-tree exited $build_exit${detail:+: $detail}) AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref WITH the trailer" >&2
      exit "$build_exit"
    fi
    echo "commit refused: the Claude-Session trailer could not be stripped (git commit-tree exited $build_exit${detail:+: $detail}); the commit $new_head was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes; $UNRESTORED" >&2
    exit "$build_exit"
  fi

  # The post-condition is MEASURED on the candidate OBJECT before any ref names it: read it
  # back raw, run the same filter over it (a line removed means the trailer is still
  # there), and require the same tree and parents as $new_head. A candidate that fails is
  # never referenced; the trailer commit is withdrawn and the caller told with exit 73.
  git cat-file commit "$candidate" >"$raw_after"
  after_cat_exit=$?
  if [ "$after_cat_exit" -ne 0 ]; then
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: the rebuilt commit $candidate could not be read back to verify the Claude-Session strip (git cat-file exited $after_cat_exit) AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref WITH the trailer, and $candidate is referenced by nothing" >&2
      exit "$after_cat_exit"
    fi
    echo "commit refused: the rebuilt commit $candidate could not be read back to verify the Claude-Session strip (git cat-file exited $after_cat_exit); the commit $new_head was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes, and $candidate is referenced by nothing; $UNRESTORED" >&2
    exit "$after_cat_exit"
  fi
  want_tree=$obj_tree
  want_parents=${obj_parents[*]-}
  parse_commit_object <"$raw_after"
  verify_why=''
  if strip_session_trailer <"$raw_after" >/dev/null; then
    verify_why="the Claude-Session trailer is STILL on the rebuilt commit $candidate"
  elif [ "$obj_tree" != "$want_tree" ] || [ "${obj_parents[*]-}" != "$want_parents" ]; then
    verify_why="the rebuilt commit $candidate does not have the tree and parents of $new_head"
  fi
  if [ -n "$verify_why" ]; then
    withdraw_commit "$new_head"
    withdraw_exit=$?
    if [ "$withdraw_exit" -ne 0 ]; then
      echo "commit refused: $verify_why AND the commit could not be withdrawn (git update-ref $target_ref $head_oid $new_head exited $withdraw_exit -- $target_ref no longer names $new_head, or the ref could not be locked; nothing was rewritten); $new_head is on $target_ref WITH the trailer, and $candidate is referenced by nothing" >&2
      exit 73
    fi
    echo "commit refused: $verify_why; the commit $new_head was withdrawn, $target_ref is back at $head_oid and the index still holds the staged changes, and $candidate is referenced by nothing; $UNRESTORED" >&2
    exit 73
  fi

  # Publish by compare-and-swap: $target_ref moves to the verified candidate ONLY if it
  # still names the exact object the provenance check read. A lost swap (another writer
  # moved the ref since) rewrites nothing and names all three objects.
  git update-ref -m "commit-with-resolved-head: strip Claude-Session (rewrite $new_head)" "$target_ref" "$candidate" "$new_head" 2>"$scratch_err"
  swap_exit=$?
  if [ "$swap_exit" -ne 0 ]; then
    detail=$(tr '\n' ' ' <"$scratch_err" | sed 's/[[:space:]]*$//')
    now_at=$(git rev-parse --verify -q "$target_ref" 2>/dev/null)
    echo "commit refused: $target_ref moved while the Claude-Session strip was being built (git update-ref $target_ref $candidate $new_head exited $swap_exit${detail:+: $detail}); nothing was rewritten and nothing was withdrawn: the stripped commit $candidate was built but is referenced by nothing, the commit $new_head this invocation created is still reachable from $target_ref and carries the trailer, and $target_ref now names ${now_at:-an unreadable value} -- inspect the branch before retrying" >&2
    exit 74
  fi
  # The pre-strip commit $new_head was replaced and survives only in the reflog; a
  # `[branch sha]` summary line naming it (printed unless the commit ran `-q`) is stale.
  # Anyone copying a sha from stdout must take this one; Forge is told to `git rev-parse HEAD`.
  echo "commit-with-resolved-head: Claude-Session trailer stripped; HEAD is now $candidate ($target_ref moved from the pre-strip commit $new_head, which was rewritten and is referenced by nothing; a [branch sha] summary line naming it is stale)"
fi
