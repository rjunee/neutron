#!/usr/bin/env bash
# =============================================================================
# trident BUILD-ON-CODEX wrapper — runs the Forge build as a `codex exec`
# subprocess instead of as a Claude `agent()`.
#
# WHY THIS EXISTS. The build is by far the most expensive phase of a trident run,
# and until now it could only be dispatched through the workflow's own
# `agent({model})`, which resolves against Claude Code's endpoint. So every build
# spent Anthropic quota no matter what the settings pane said. A codex substrate
# adapter has existed and been registered for a while (`runtime/adapters/codex-cli/`,
# selected in `runtime/adapters/select-substrate.ts`) and trident's own review seat
# already shells into `codex exec` (`trident/codex-review.sh`) — what was missing was
# a route from the BUILD step to it. This is that route: the same shape as the review
# wrapper, one phase further up.
#
# WHAT IT IS HANDED, and what it hands back:
#
#   in  NEUTRON_CODEX_BUILD_BRIEF_FILE  the assembled Forge brief (contract + task).
#                                       Composed by `trident/inner-workflow.mjs` — the
#                                       SAME text the Claude builder gets, plus a coda
#                                       about how to report — so the two builders
#                                       cannot drift into building different things.
#   in  NEUTRON_CODEX_BUILD_DIFF_FILE   where the brief told the build to write the
#                                       branch diff, so this script can report whether
#                                       it actually appeared.
#   in  NEUTRON_CODEX_BUILD_TRAILER_FILE where to WRITE the measured trailer. Required
#                                       — see below for why it is not stdout.
#   in  CODEX_HOME                      the per-project subscription credential dir.
#   in  CODEX_BUILD_MODEL               which GPT tier to build on. A DIFFERENT knob
#                                       from the reviewer's `CODEX_REVIEW_MODEL` on
#                                       purpose: on a box that exports both, one name
#                                       would silently point the reviewer at the
#                                       build's model (or the reverse).
#   arg $1                              the branch the build is expected to land on.
#   arg $2                              the BASE branch, used only to regenerate the
#                                       branch diff when a build committed but never
#                                       wrote one. Optional; omitted means "no
#                                       last-resort diff", never a guessed base.
#
#   out  the codex transcript on stdout; the MEASURED trailer in the trailer file.
#
# ── THE TRAILER IS THE POINT ─────────────────────────────────────────────────
# The inner loop needs four facts from a build — branch, commit sha, PR number,
# diff file — and downstream those facts are load-bearing: `reviewedHead` pins the
# merge to the reviewed commit (`gh pr merge --match-head-commit`, #545) and
# `roundLanded` refuses to re-review a round that left no trace on the branch.
#
# A Claude Forge agent REPORTS those through a schema; it is reporting on itself.
# `codex exec` can be handed `--output-schema` (this CLI has the flag) — but a
# schema-shaped answer is still the MODEL's claim about its own work, and the failing
# case is exactly the one where the model believes it committed. A schema constrains
# the SHAPE of a wrong answer, not its truth. So this script does not ask. After codex
# exits it MEASURES the facts with git and gh and writes them itself:
#
#   NEUTRON_CODEX_BUILD_BRANCH=      `git rev-parse --abbrev-ref HEAD`
#   NEUTRON_CODEX_BUILD_HEAD=        the commit THIS RUN produced (see below)
#   NEUTRON_CODEX_BUILD_REMOTE_HEAD= that same commit, confirmed pushed, or empty
#   NEUTRON_CODEX_BUILD_PR=          `gh pr list --head` — the PR number, or empty
#   NEUTRON_CODEX_BUILD_DIFF=        the diff file path, or empty if it is missing
#                                    or empty
#   NEUTRON_CODEX_BUILD_WORKTREE=    `pwd`
#
# Every one of them is EMPTY rather than wrong when it cannot be established, and
# the bridge that reads them passes the empty value straight through. An empty sha
# fails closed at both gates: no review of an unbuilt branch, and no merge.
#
# ── THE TWO SHAS ARE BOTH ABOUT *THIS* BUILD, NEVER ABOUT THE BRANCH ─────────
# `HEAD` is recorded only when it is a commit that DID NOT ALREADY EXIST when codex
# started. "Already existed" is three shas, not one, and the first version of this
# script only knew about the first of them:
#
#   • the worktree's HEAD at launch;
#   • the LOCAL tip of the target branch (`refs/heads/<branch>`);
#   • the REMOTE tip of the target branch (`git ls-remote origin refs/heads/<branch>`).
#
# The last two are what make a re-entry honest. A second or third round starts in a
# worktree parked on the base commit and the brief's first instruction is
# `git switch <branch>` — so a build that switches and then decides it has nothing to
# do moves HEAD without committing anything. Measured against the launch HEAD alone
# that reads as "this build produced a commit", and the sha it hands back is the
# PREVIOUS round's. `roundLanded` would see a landed round, and
# `gh pr merge --match-head-commit` would pin to a commit this build never made and
# succeed. Comparing against all three pre-existing tips makes the empty answer the
# one that survives, which is the invariant above.
#
# `REMOTE_HEAD` is that measured local sha CONFIRMED PUSHED — it is emitted only when
# the remote branch tip EQUALS it, and is otherwise empty. It is deliberately not "the
# current tip of the remote branch": that is a fresh probe of a shared ref, and
# `trident/inner-workflow.mjs` forbids exactly that for `reviewedHead` (a commit pushed
# by anything else between the build and the probe would be read back and then pinned
# by `--match-head-commit`, certifying as reviewed a commit no reviewer saw). Equality
# turns the remote into a WITNESS for our own sha instead of a source for someone
# else's, and every disagreement — stale branch, concurrent push, failed push — comes
# out empty and fails closed.
#
# ── WHY THE TRAILER IS A FILE AND NOT THE TAIL OF STDOUT ─────────────────────
# stdout also carries the codex transcript, which is model-controlled text. A build
# that quotes this header, or narrates "I printed NEUTRON_CODEX_BUILD_HEAD=<sha>",
# puts a second trailer-shaped block in front of the reader with no way to tell which
# one was measured. The bridge reads THIS FILE and nothing else, and the file is
# written (truncating) after codex exits, so anything the model wrote there is gone.
#
# ── THE SANDBOX GRANT, AND WHY IT IS THIS WIDE ───────────────────────────────
# `--sandbox danger-full-access`. Deliberate, and the narrower policies were checked
# against what a build actually does rather than assumed:
#
#   • `read-only` (the exec default) cannot edit a file.
#   • `workspace-write` writes only inside the workspace, and a trident build writes
#     outside it twice over: it runs in a git WORKTREE, whose `.git` is a file pointing
#     at `<repo>/.git/worktrees/<name>` (so the first `git commit` writes out of tree),
#     and it writes its branch diff to a path under /tmp. `--add-dir` — a real flag on
#     this CLI — can widen the write set to cover both.
#   • What `--add-dir` cannot grant is NETWORK, which `workspace-write` denies. Steps 3
#     and 4 of the Forge contract are `git push` and `gh pr create`, and a build that
#     installs a dependency needs it too.
#
# So the narrow policy would have to be re-widened along both axes, one flag at a time,
# to arrive at the same reach with more moving parts and more ways to be subtly wrong.
#
# A build that cannot commit, push or open a PR is not a build; it produces no sha
# and the run stops at the trailer above. The blast radius is bounded by the same
# thing that bounds the Claude builder, which runs with the same powers: an isolated
# git worktree on its own branch, a review panel that reads the diff, and a merge
# pinned to the reviewed commit. This grant makes the codex builder EQUAL to the
# Claude builder, not more privileged than it.
#
# Usage (from inside the build worktree):
#   CODEX_HOME=<dir> NEUTRON_CODEX_BUILD_BRIEF_FILE=<file> \
#     NEUTRON_CODEX_BUILD_TRAILER_FILE=<file> bash trident/codex-build.sh <branch>
#
# Exit codes mirror `trident/codex-review.sh`, and the bridge maps them the same way:
#   0   BUILT         — codex ran to completion. Read the trailer.
#   10  NOT_CONNECTED — no CODEX_HOME / no auth.json.
#   11  NOT_CONNECTED — codex CLI not on PATH.
#   3   DEFERRED      — configured but the build could not be STARTED (auth precheck
#                       failed, or no brief was handed in).
#   5   DEFERRED      — codex ran and exited non-zero.
# Unlike the REVIEW lane, NOT_CONNECTED is not a graceful degrade here: a build that
# did not happen is not a reduced panel, it is no build. The bridge reports it and
# the workflow stops rather than quietly re-running on Claude — the owner moved the
# build off Anthropic on purpose, and a silent fallback would spend the quota they
# were trying to protect and hide that it had done so.
# =============================================================================

set -uo pipefail

BRANCH="${1:-}"
BASE_BRANCH="${2:-}"
: "${CODEX_HOME:=}"
WORKTREE="$(pwd)"
# Every sha that ALREADY EXISTED when codex was launched — the worktree HEAD, the
# local branch tip, and the remote branch tip — one per line. Populated just before
# the launch below. A head found in this set is not this build's commit, whatever the
# transcript says. See the header for the re-entry case that needs all three.
PRE_EXISTING_HEADS=''

# A full-length lowercase-hex sha, or the empty string. Charset AND length, because
# `git rev-parse --verify HEAD` in a repo with no commits echoes the literal `HEAD`
# back, and a truncated or abbreviated value would be accepted by a charset test
# alone while being useless to `--match-head-commit`. Both object formats count: 40
# for sha1, 64 for sha256 — hard-coding 40 would collapse every measured sha on a
# sha256 repo to empty and report "no commit was made" for a build that made one.
sha_or_empty() {
  case "$1" in
    *[!0-9a-f]* | '') printf '' ;;
    *) { [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; } && printf '%s' "$1" || printf '' ;;
  esac
}

# Was this sha already on the branch (or under HEAD) before codex ran?
# Exact whole-line match against the captured set — a substring test would let an
# abbreviation match a full sha.
pre_existing() {
  [ -n "$PRE_EXISTING_HEADS" ] || return 1
  printf '%s\n' "$PRE_EXISTING_HEADS" | grep -qxF "$1"
}

# ── The trailer, written on EVERY path that got as far as running codex ───────
# A function so the measurement is written once and cannot drift between the
# success and failure exits. It measures; it never infers.
emit_trailer() {
  local head remote_head pr_number diff_path branch_name _pr_out
  branch_name="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  # A detached HEAD has no branch name, and `--abbrev-ref` spells that "HEAD".
  [ "$branch_name" = "HEAD" ] && branch_name=''
  head="$(sha_or_empty "$(git rev-parse --verify HEAD 2>/dev/null || true)")"
  # A HEAD THAT ALREADY EXISTED IS NOT THIS BUILD'S COMMIT. See the header: reporting
  # a pre-existing head — the launch HEAD for a build that edited but never committed,
  # or the previous round's branch tip for a re-entry that switched onto it and did
  # nothing — would hand the round a sha whose tree holds none of its work, and both
  # downstream gates would accept it.
  [ -n "$head" ] && pre_existing "$head" && head=''
  remote_head=''
  if [ -n "$head" ] && [ -n "$BRANCH" ]; then
    local tip
    # THE REMOTE IS A WITNESS, NOT A SOURCE — this answers "was OUR sha pushed?", and
    # any other answer is discarded (header: the `reviewedHead` rule). `awk` splits the
    # `<sha>\trefs/heads/<branch>` line; no match prints nothing.
    #
    # Bounded the same way the auth precheck is: by this point the codex tokens are
    # already spent, so a remote that hangs must cost the run a fact, not the build.
    tip="$(GIT_TERMINAL_PROMPT=0 perl -e 'alarm 10; exec @ARGV or exit 1' \
      git ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    [ "$(sha_or_empty "$tip")" = "$head" ] && remote_head="$head"
  fi
  pr_number=''
  if [ -n "$BRANCH" ] && command -v gh >/dev/null 2>&1; then
    # BOUNDED, exactly like the `git ls-remote` probes: `gh` talks to the network and
    # to a credential helper, either of which can block forever, and this function runs
    # on the FAILURE path too — an unbounded call here does not merely lose the PR
    # number, it hangs the build phase and the DEFERRED report never reaches the
    # bridge. `</dev/null` because `gh` waits on stdin when it wants to prompt.
    #
    # THROUGH A FILE, NOT A COMMAND SUBSTITUTION, and that is the part that makes the
    # bound real. `$(…)` returns when the PIPE closes, not when the command exits — so
    # a credential helper `gh` left holding stdout keeps the substitution blocked long
    # after the alarm killed `gh` itself. A redirect makes the shell wait for the
    # process, which is what was bounded.
    _pr_out="${TMPDIR:-/tmp}/trident-codex-build-pr.$$"
    perl -e 'alarm 10; exec @ARGV or exit 1' \
      gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' \
      </dev/null >"$_pr_out" 2>/dev/null || true
    pr_number="$(head -n 1 "$_pr_out" 2>/dev/null || true)"
    rm -f "$_pr_out"
    # `--jq` prints `null` when the list is empty, and a literal "null" reported as a
    # PR number is worse than none at all.
    case "$pr_number" in
      '' | *[!0-9]*) pr_number='' ;;
    esac
  fi
  # THE DIFF OF LAST RESORT. The launch below DELETES this path so a stale diff from an
  # earlier round can never be reported as this one's (#545). That leaves a real gap on
  # a FIX round: the workflow captures the diff path ONCE and hands the same one to
  # every review round, so a round that COMMITTED but forgot to re-write the diff would
  # send the panel at a path that no longer exists. The diff is not a judgement call —
  # it is `git diff <base>..HEAD`, which this script can take itself — so when the
  # build left a commit and no diff, take it. Still a MEASUREMENT of the repository,
  # not an inference about it.
  #
  # Only when `head` is non-empty: with no commit of this build's own there is nothing
  # to diff, and an empty `NEUTRON_CODEX_BUILD_DIFF=` is exactly the signal the round-1
  # gate reads to stop an unbuilt branch reaching the panel.
  if [ -n "${NEUTRON_CODEX_BUILD_DIFF_FILE:-}" ] && [ ! -s "${NEUTRON_CODEX_BUILD_DIFF_FILE}" ] \
    && [ -n "$head" ] && [ -n "$BASE_BRANCH" ]; then
    # `..`, not `...`, to match the diff the brief asks the build for — and because a
    # shallow clone's grafted base has no merge-base to resolve. Failure leaves the
    # file empty and the trailer says so.
    git diff "${BASE_BRANCH}..HEAD" > "${NEUTRON_CODEX_BUILD_DIFF_FILE}" 2>/dev/null || true
  fi
  diff_path=''
  if [ -n "${NEUTRON_CODEX_BUILD_DIFF_FILE:-}" ] && [ -s "${NEUTRON_CODEX_BUILD_DIFF_FILE}" ]; then
    diff_path="${NEUTRON_CODEX_BUILD_DIFF_FILE}"
  fi
  # `>` TRUNCATES, deliberately: the build had full write access and may have created
  # this path itself. What the reader gets is what this function measured, nothing
  # appended to it.
  printf '%s\n' \
    "NEUTRON_CODEX_BUILD_BRANCH=${branch_name}" \
    "NEUTRON_CODEX_BUILD_HEAD=${head}" \
    "NEUTRON_CODEX_BUILD_REMOTE_HEAD=${remote_head}" \
    "NEUTRON_CODEX_BUILD_PR=${pr_number}" \
    "NEUTRON_CODEX_BUILD_DIFF=${diff_path}" \
    "NEUTRON_CODEX_BUILD_WORKTREE=${WORKTREE}" \
    > "$TRAILER_FILE"
}

# ── NOT CONNECTED: no per-project credential configured ───────────────────────
if [ -z "$CODEX_HOME" ] || [ ! -f "$CODEX_HOME/auth.json" ]; then
  if [ -z "$CODEX_HOME" ]; then
    echo "CODEX_BUILD_NOT_CONNECTED: CODEX_HOME is not set — no codex credential for this project. The build cannot run on codex." >&2
  else
    echo "CODEX_BUILD_NOT_CONNECTED: no auth.json under CODEX_HOME=$CODEX_HOME — codex not connected. The build cannot run on codex." >&2
  fi
  exit 10
fi
export CODEX_HOME

# ── HARD BILLING CONTRACT: subscription OAuth ONLY, never a metered API key ────
# Identical to the review wrapper's, and for the identical reason: the codex CLI
# PREFERS OPENAI_API_KEY over the persisted OAuth, and the gateway process may carry
# one (it also backs gbrain embeddings + the GPT adapter). A build is far more
# tokens than a review, so an accidental metered key costs correspondingly more.
unset OPENAI_API_KEY OPENAI_KEY 2>/dev/null || true

# ── NOT CONNECTED: the codex CLI itself is absent ─────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  echo "CODEX_BUILD_NOT_CONNECTED: codex CLI not on PATH (install with 'brew install codex' or 'npm install -g @openai/codex'). The build cannot run on codex." >&2
  exit 11
fi

# ── DEFERRED: nothing to build ────────────────────────────────────────────────
# An empty brief would hand codex a blank prompt and let it invent a task inside a
# real worktree with full write access. Refuse, loudly.
BRIEF_FILE="${NEUTRON_CODEX_BUILD_BRIEF_FILE:-}"
if [ -z "$BRIEF_FILE" ] || [ ! -s "$BRIEF_FILE" ]; then
  echo "CODEX_BUILD_NO_BRIEF: NEUTRON_CODEX_BUILD_BRIEF_FILE is unset, missing or empty — there is no build brief to run. DEFERRED." >&2
  exit 3
fi

# ── DEFERRED: nowhere to put the trailer ──────────────────────────────────────
# Refused before codex is launched rather than discovered after it: without a place to
# write the measurement, a completed build reports nothing and the tokens are spent.
TRAILER_FILE="${NEUTRON_CODEX_BUILD_TRAILER_FILE:-}"
if [ -z "$TRAILER_FILE" ]; then
  echo "CODEX_BUILD_NO_TRAILER_FILE: NEUTRON_CODEX_BUILD_TRAILER_FILE is unset — there is nowhere to write the measured trailer, so a completed build could not be reported. DEFERRED." >&2
  exit 3
fi

# ── DEFERRED precheck: auth must be live. 3× retry, 6s per-attempt wall cap ────
# Ported from the review wrapper: a genuine expiry fails every attempt; a transient
# blip recovers on attempt 2/3, so a flaky network is not a failed build.
AUTH_RETRY_DELAY="${NEUTRON_CODEX_AUTH_RETRY_DELAY:-2}"
codex_auth_ok=0
for attempt in 1 2 3; do
  if perl -e 'alarm 6; exec @ARGV or exit 1' codex login status >/dev/null 2>&1; then
    codex_auth_ok=1
    break
  fi
  [ "$attempt" -lt 3 ] && sleep "$AUTH_RETRY_DELAY"
done
if [ "$codex_auth_ok" -ne 1 ]; then
  echo "CODEX_BUILD_AUTH_EXPIRED: codex auth invalid/unreachable after 3 attempts (CODEX_HOME=$CODEX_HOME). DEFERRED — re-auth with 'codex login'." >&2
  exit 3
fi

# ── Run the build SYNCHRONOUSLY (never backgrounded) ──────────────────────────
# The prompt goes in on STDIN (`codex exec -`), never as an argv entry: the brief
# carries the whole task text and a long one in a single argument can exceed the OS
# ARG_MAX and fail before codex starts — the same hazard the review wrapper hit with
# a near-cap diff.
#
# WHAT ALREADY EXISTED, captured here and nowhere else: everything after this line is
# the build's, and the trailer's "did it commit" question is answered by comparing
# against this set. All three tips, because the brief tells a re-entry to
# `git switch <branch>` and that moves HEAD onto the previous round's commit without
# producing one (header: THE TWO SHAS).
for _pre in \
  "$(git rev-parse --verify HEAD 2>/dev/null || true)" \
  "$(git rev-parse --verify "refs/heads/${BRANCH}" 2>/dev/null || true)"; do
  _pre="$(sha_or_empty "$_pre")"
  [ -n "$_pre" ] && PRE_EXISTING_HEADS="${PRE_EXISTING_HEADS}${_pre}
"
done
if [ -n "$BRANCH" ]; then
  # Bounded like every other remote probe here: a remote that hangs must cost the run
  # a baseline, not the build. Missing it only ever costs PRECISION in one direction —
  # a re-entry whose previous round exists only on the remote — and the local tips
  # above already cover the common case.
  _pre="$(sha_or_empty "$(GIT_TERMINAL_PROMPT=0 perl -e 'alarm 10; exec @ARGV or exit 1' \
    git ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk 'NR==1 {print $1}' || true)")"
  [ -n "$_pre" ] && PRE_EXISTING_HEADS="${PRE_EXISTING_HEADS}${_pre}
"
fi

# CLEAR THE DIFF FILE BEFORE THE BUILD, never after. `emit_trailer` reports this path
# when it is non-empty, and a path left over from an earlier round is non-empty with
# SOMEONE ELSE'S diff in it — the reviewers would then read a diff this build never
# wrote (the #545 class: a review of a diff no one built). Removed rather than
# truncated so a build that never writes it leaves nothing at all behind — and when
# that build DID commit, `emit_trailer` regenerates the diff from `$BASE_BRANCH` rather
# than reporting a path it just deleted.
[ -n "${NEUTRON_CODEX_BUILD_DIFF_FILE:-}" ] && rm -f "${NEUTRON_CODEX_BUILD_DIFF_FILE}"

# A test seam (NEUTRON_CODEX_BUILD_EXEC_CMD) replaces the real invocation so tests
# never call OpenAI. It reads the same STDIN and runs in the same cwd, so the trailer
# below measures a REAL git state either way — which is what makes the seam worth
# having: the interesting behaviour here is the measurement, not the model.
#
# NAMED FOR THIS WRAPPER, not shared with the review one. `codex-review.sh` has its own
# `NEUTRON_CODEX_EXEC_CMD`; one name across both would mean a value exported to stub
# the reviewer silently replaced the BUILD's entire invocation — the same cross-talk
# the two model knobs (CODEX_BUILD_MODEL vs CODEX_REVIEW_MODEL) exist to prevent.
if [ -n "${NEUTRON_CODEX_BUILD_EXEC_CMD:-}" ]; then
  if <"$BRIEF_FILE" sh -c "$NEUTRON_CODEX_BUILD_EXEC_CMD"; then
    emit_trailer
    exit 0
  fi
  emit_trailer
  echo "CODEX_BUILD_CALL_FAILED: the codex build call failed. DEFERRED — no build happened." >&2
  exit 5
fi

# PIN THE BUILD MODEL, for the same reason the review lane pins its own: unpinned,
# `codex exec` takes the CLI's own default, which OpenAI moved to the cheapest 5.6
# tier — so an owner who moved the build to the flagship tier would silently get the
# weakest one. Set CODEX_BUILD_MODEL to the EMPTY string to fall back to the CLI
# default (the `-` in `${VAR-x}` substitutes only when UNSET, so an explicit empty
# value is respected). `trident/__tests__/model-tiers.test.ts` pins this literal to
# the `sol` registry entry, so the two cannot drift.
BUILD_MODEL="${CODEX_BUILD_MODEL-gpt-5.6-sol}"
if [ -n "$BUILD_MODEL" ]; then
  set -- --model "$BUILD_MODEL"
else
  set --
fi

# `--sandbox danger-full-access` — see the header for what each narrower policy
# cannot do. `--cd .` keeps codex rooted in THIS worktree (the bridge agent's
# isolated checkout) rather than wherever the CLI would otherwise infer a workspace
# root, which on a git worktree is not the directory we are standing in.
if <"$BRIEF_FILE" codex exec "$@" --sandbox danger-full-access --cd "$WORKTREE" -; then
  emit_trailer
  exit 0
fi
emit_trailer
echo "CODEX_BUILD_CALL_FAILED: 'codex exec' returned non-zero. DEFERRED — the build did not complete." >&2
exit 5
