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
#   in  NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY `<bytes>:<fnv32>` for the brief AS THE
#                                       WORKFLOW COMPOSED IT. Required — see THE
#                                       BRIEF ARRIVES THROUGH AN LLM below.
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
# ── THE BRANCH IS A GATE, NOT A FIELD ────────────────────────────────────────
# `NEUTRON_CODEX_BUILD_BRANCH` is measured and reported, and it is also CHECKED: when
# it disagrees with the branch this build was asked for (`$1`), the head is reported
# EMPTY. Reporting the sha anyway would satisfy every downstream gate with work that
# is not on the branch the run merges — the reviewers would read a real diff, and in
# local mode `git merge --no-ff <branch>` would then land nothing and delete the
# branch that held it. A build on the wrong branch is not a build; it is the same
# "EMPTY rather than wrong" rule applied to the one field that decides where the work
# lives. The measured branch name is still reported, so the failure names itself.
#
# ── THE BRIEF ARRIVES THROUGH AN LLM, SO IT IS COUNTED ───────────────────────
# The workflow cannot exec anything; it reaches a shell only through a thin bridge
# agent, and that agent has to reproduce the whole brief in a heredoc. A model that
# truncates or paraphrases it produces a REAL sha for a contract nobody wrote — and
# every check downstream is about the repository, not about the text. So the workflow
# hands over `<bytes>:<fnv32>` for what it composed and this script recomputes both
# from the file before spending a token; a mismatch is DEFERRED (exit 3), never a
# build against an approximation of the brief.
#
# FNV-1a/32 OVER THE BYTES, NOT SHA-256, and the reason is the composing side: the
# workflow script runs with no imports and no host API it is promised (see the
# `inner-workflow.mjs` header), so the digest has to be computable from language
# builtins alone. A 32-bit checksum plus an exact byte count is not a signature and is
# not claimed as one — it catches the failure that actually happens here, a bridge
# that dropped or reworded part of the text, and nothing in this script's threat model
# needs it to survive a deliberate collision: the brief's author and its verifier are
# the same run.
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
# ── AND THE SANDBOX GRANT IS NOT ENOUGH: THE CHILD SHELL NEEDS THE ENVIRONMENT ─
# `--sandbox danger-full-access` says the child shell MAY reach the network. It says
# nothing about whether the child shell is handed the credential it needs to get past
# GitHub, and by default it is not.
#
# `codex exec` filters the environment it gives the commands the model runs
# (`shell_environment_policy`). The defaults are `inherit = "core"` — HOME, PATH,
# SHELL, TMPDIR, LOGNAME and a handful more — plus a default EXCLUDE list of
# `*KEY*`, `*SECRET*`, `*TOKEN*` applied on top. Verified against the CLI shipped here
# (`codex-cli 0.147.0`): both field names are accepted by `--strict-config` and an
# invented one is refused, and the pattern list is in the binary beside the core set.
#
# That is exactly the wrong filter for this build, because of how the instance's
# GitHub token is handed to a child process. `github/credential.ts` deliberately writes
# NOTHING to any config file — no `credential.helper` on disk, no token in the remote
# URL — and passes the credential through the ENVIRONMENT ALONE, as `GH_TOKEN` plus a
# github.com-scoped helper in `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
# `GIT_CONFIG_VALUE_0`. Under the default policy `GH_TOKEN` matches `*TOKEN*` and
# `GIT_CONFIG_KEY_0` matches `*KEY*`, so BOTH are stripped: the build's `git push` and
# `gh pr create` run unauthenticated, `emit_trailer` then measures an empty
# REMOTE_HEAD, and the run aborts claiming "nothing was built" about a build that
# built the whole thing and could not post it.
#
#   -c shell_environment_policy.inherit=all
#   -c shell_environment_policy.ignore_default_excludes=true
#
# Both are required and neither is sufficient alone: `inherit=all` without the second
# still drops the two credential variables by pattern, and clearing the excludes
# without the first never sees them because `core` did not carry them in.
#
# WHAT THIS DOES *NOT* WIDEN. The one secret that must not reach the build — the
# metered `OPENAI_API_KEY` — is `unset` from THIS script's own environment before
# `codex` is launched at all (see the billing contract above), so it is not in the set
# being inherited. Everything else the child now sees is what the wrapper itself was
# given by the phase that started it. The child shell already has
# `danger-full-access`; withholding the environment from it does not contain it, it
# only makes it fail at the last step.
#
# Usage (from inside the build worktree):
#   CODEX_HOME=<dir> NEUTRON_CODEX_BUILD_BRIEF_FILE=<file> \
#     NEUTRON_CODEX_BUILD_TRAILER_FILE=<file> bash trident/codex-build.sh <branch>
#
# ── EVERY NETWORK CALL IS WALL-CLOCK BOUNDED, THROUGH A FILE ─────────────────
# `bounded()` below runs one command under `perl -e 'alarm N; exec …'` with stdout
# REDIRECTED TO A FILE. Both halves are load-bearing. The alarm caps a `git`/`gh` call
# that would otherwise wait forever on a wedged remote or a credential helper; the
# file is what makes the cap real, because `$(…)` returns when the PIPE closes, not
# when the process exits — a child left holding the write end keeps the substitution
# blocked long after the alarm killed the process it was waiting for. A caller that
# needs the output parses the file afterwards.
#
# `perl` is therefore a HARD DEPENDENCY of this script, checked up front with `codex`
# and refused loudly: without it the auth precheck below fails three times and reports
# expired credentials, which is a true-sounding lie about a box that simply has no
# perl.
#
# Exit codes mirror `trident/codex-review.sh`, and the bridge maps them the same way:
#   0   BUILT         — codex ran to completion. Read the trailer.
#   10  NOT_CONNECTED — no CODEX_HOME / no auth.json.
#   11  NOT_CONNECTED — codex CLI not on PATH.
#   3   DEFERRED      — configured but the build could not be STARTED (no perl, auth
#                       precheck failed, no brief, or a brief that did not survive
#                       the trip intact).
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

# Run one command with a hard wall-clock cap, its stdout captured in $1.
#
#   bounded <outfile> <seconds> <cmd> [args…]
#
# THROUGH A FILE, NEVER A COMMAND SUBSTITUTION, and that is the half that makes the
# bound real: `$(…)` returns when the PIPE closes, not when the process exits, so a
# child that inherited the write end keeps the substitution blocked long after the
# alarm killed the process it was waiting for. A redirect makes the shell wait for the
# PROCESS, which is the thing that was bounded. Measured both ways: a 30s command under
# `alarm 10` returns in 30s inside `$( )` and in 10s with this redirect.
#
# `</dev/null` because a network tool that decides to prompt (git for a password, gh
# for a credential) waits on stdin forever otherwise. Returns the command's status;
# the alarm shows up as a signal death, which is a non-zero status like any other.
bounded() {
  local out="$1" secs="$2"
  shift 2
  perl -e 'my $s = shift; alarm $s; exec @ARGV or exit 1' "$secs" "$@" </dev/null >"$out" 2>/dev/null
}

# The tip of `refs/heads/$1` on origin, or the empty string — bounded, and never a
# reason for the build to hang. `awk` splits the `<sha>\trefs/heads/<branch>` line off
# the file `bounded` captured; no match prints nothing.
#
#   remote_tip <branch> [attempts]
#
# `attempts` (default 1) is how many times to ASK WHEN THE PROBE FAILS — a non-zero
# `git ls-remote`, or the alarm cutting it off. A probe that COMPLETED ends the loop
# whatever it found, including finding nothing: "the branch is not on the remote" is a
# real answer, and re-asking it would be waiting for the remote to change its mind
# (and, in the witness case below, is the one way a true "not pushed" could become a
# false "pushed" if something else landed mid-loop). Only the failure — which is the
# outcome that cannot be told apart from a blip — is retried.
#
# THE RETRY LIVES IN HERE, not in the caller, because the caller reads this through
# `$(…)`: a subshell, whose variables never reach the parent, so a caller could not see
# whether the probe failed or merely came back empty.
remote_tip() {
  local out tip attempts n
  attempts="${2:-1}"
  out="${TMPDIR:-/tmp}/trident-codex-build-ls.$$"
  tip=''
  n=1
  while [ "$n" -le "$attempts" ]; do
    if bounded "$out" 10 env GIT_TERMINAL_PROMPT=0 git ls-remote origin "refs/heads/$1"; then
      tip="$(awk 'NR==1 {print $1}' "$out" 2>/dev/null || true)"
      break
    fi
    n=$((n + 1))
  done
  rm -f "$out"
  sha_or_empty "$tip"
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
  # A COMMIT ON THE WRONG BRANCH IS NOT THIS BUILD'S COMMIT EITHER (header: THE BRANCH
  # IS A GATE). The build was asked for `$BRANCH`; a head measured while standing
  # anywhere else is work the run cannot merge, and handing the sha over would let the
  # panel review a diff that `git merge <branch>` will not land. The measured name
  # still goes out in the trailer, so the reader is told WHICH branch it ended up on.
  if [ -n "$head" ] && [ -n "$BRANCH" ] && [ "$branch_name" != "$BRANCH" ]; then
    head=''
  fi
  remote_head=''
  if [ -n "$head" ] && [ -n "$BRANCH" ]; then
    # THE REMOTE IS A WITNESS, NOT A SOURCE — this answers "was OUR sha pushed?", and
    # any other answer is discarded (header: the `reviewedHead` rule).
    #
    # Bounded the same way every other network call here is: by this point the codex
    # tokens are already spent, so a remote that hangs must cost the run a fact, not
    # the build — and this function also runs on the FAILURE path, where a hang would
    # eat the DEFERRED report the bridge is waiting for.
    #
    # RETRIED 3×, AND ONLY ON A FAILED PROBE. This is the single most consequential
    # probe in the script: one that never answers empties REMOTE_HEAD, the bridge then
    # reports no commitSha, and the workflow throws "produced no commitSha — nothing
    # was built" about a build that committed, pushed and opened a PR. The claim is
    # false and the entire build is discarded to make it, so one blip on a shared
    # remote must not be the last word — the auth precheck above already retries three
    # times for a far cheaper mistake. See `remote_tip` for why an ANSWER, even an
    # unwelcome one, ends the loop.
    [ "$(remote_tip "$BRANCH" 3)" = "$head" ] && remote_head="$head"
  fi
  pr_number=''
  if [ -n "$BRANCH" ] && command -v gh >/dev/null 2>&1; then
    # BOUNDED, exactly like the `git ls-remote` probes: `gh` talks to the network and
    # to a credential helper, either of which can block forever, and this function runs
    # on the FAILURE path too — an unbounded call here does not merely lose the PR
    # number, it hangs the build phase and the DEFERRED report never reaches the
    # bridge.
    _pr_out="${TMPDIR:-/tmp}/trident-codex-build-pr.$$"
    bounded "$_pr_out" 10 \
      gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' || true
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

# ── DEFERRED: no `perl`, and every bounded call here needs it ─────────────────
# Checked BESIDE the codex CLI rather than discovered at the first call: without perl
# the auth precheck below fails all three attempts and reports invalid credentials,
# and the pushed-sha probe silently comes back empty — a box with a healthy codex
# login and a pushed commit would be told its auth expired and its build produced no
# sha. Both messages would be false, and neither names the actual missing piece.
if ! command -v perl >/dev/null 2>&1; then
  echo "CODEX_BUILD_NO_PERL: perl is not on PATH — every network call in this wrapper is wall-clock bounded with 'perl -e alarm', and the brief's integrity is checked with it. DEFERRED — install perl." >&2
  exit 3
fi

# ── DEFERRED: nothing to build ────────────────────────────────────────────────
# An empty brief would hand codex a blank prompt and let it invent a task inside a
# real worktree with full write access. Refuse, loudly.
BRIEF_FILE="${NEUTRON_CODEX_BUILD_BRIEF_FILE:-}"
if [ -z "$BRIEF_FILE" ] || [ ! -s "$BRIEF_FILE" ]; then
  echo "CODEX_BUILD_NO_BRIEF: NEUTRON_CODEX_BUILD_BRIEF_FILE is unset, missing or empty — there is no build brief to run. DEFERRED." >&2
  exit 3
fi

# ── DEFERRED: the brief did not survive the trip ──────────────────────────────
# NON-EMPTY IS NOT INTACT. The brief reaches this file by way of a bridge agent that
# had to reproduce it in a heredoc (header: THE BRIEF ARRIVES THROUGH AN LLM), and a
# truncated or reworded one still spends a full build and comes back with a real sha
# for a contract nobody wrote — a failure no gate downstream can see, because they all
# ask about the repository. So the composing side hands over `<bytes>:<fnv32>` and this
# recomputes both from the file. Required, not optional-with-a-skip: an unset value
# would make the check disappear on exactly the call path that lost the bytes.
BRIEF_INTEGRITY="${NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY:-}"
if [ -z "$BRIEF_INTEGRITY" ]; then
  echo "CODEX_BUILD_NO_BRIEF_INTEGRITY: NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY is unset — the brief travelled through a bridge agent and nothing here can tell an intact one from a truncated one. DEFERRED." >&2
  exit 3
fi
# FNV-1a/32 over the raw bytes, and the byte count, in one token. `use integer` keeps
# the multiply in 64-bit C arithmetic (the intermediate exceeds 2**53, so a float
# would round and every checksum after the first byte would be wrong).
BRIEF_MEASURED="$(perl -e 'use integer; open my $f, "<:raw", $ARGV[0] or exit 1; local $/; my $d = <$f>; my $h = 0x811c9dc5; for my $b (unpack "C*", $d) { $h = ($h ^ $b) & 0xffffffff; $h = ($h * 0x01000193) & 0xffffffff; } printf "%d:%08x", length($d), $h' "$BRIEF_FILE" 2>/dev/null || true)"
if [ "$BRIEF_MEASURED" != "$BRIEF_INTEGRITY" ]; then
  echo "CODEX_BUILD_BRIEF_CORRUPT: the brief in $BRIEF_FILE measures ${BRIEF_MEASURED:-<unreadable>} but the workflow composed ${BRIEF_INTEGRITY} (<bytes>:<fnv32>) — it was truncated or altered on the way here. DEFERRED: building against an approximation of the brief produces a real commit for a task nobody wrote." >&2
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
  if bounded /dev/null 6 codex login status; then
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
  _pre="$(remote_tip "$BRANCH")"
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

# HAND THE CHILD SHELL THE ENVIRONMENT IT WAS GIVEN — see the header. Without both of
# these, `codex exec`'s default `shell_environment_policy` (inherit=core, then exclude
# `*KEY*`/`*SECRET*`/`*TOKEN*`) strips `GH_TOKEN` and `GIT_CONFIG_KEY_0`, which is the
# ONLY channel `github/credential.ts` uses to authenticate a push. The build then
# commits, fails to push, and the run reports that nothing was built.
set -- -c shell_environment_policy.inherit=all \
  -c shell_environment_policy.ignore_default_excludes=true

# PIN THE BUILD MODEL, for the same reason the review lane pins its own: unpinned,
# `codex exec` takes the CLI's own default, which OpenAI moved to the cheapest 5.6
# tier — so an owner who moved the build to the flagship tier would silently get the
# weakest one. Set CODEX_BUILD_MODEL to the EMPTY string to fall back to the CLI
# default (the `-` in `${VAR-x}` substitutes only when UNSET, so an explicit empty
# value is respected). `trident/__tests__/model-tiers.test.ts` pins this literal to
# the `sol` registry entry, so the two cannot drift.
BUILD_MODEL="${CODEX_BUILD_MODEL-gpt-5.6-sol}"
if [ -n "$BUILD_MODEL" ]; then
  set -- "$@" --model "$BUILD_MODEL"
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
