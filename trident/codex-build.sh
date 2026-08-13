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
#   arg $3                              the run's MERGE MODE — `pr` or `local`.
#                                       Defaults to `pr`, which is the strict side of
#                                       every check that reads it, so a caller that
#                                       forgets the argument gets the safe behaviour
#                                       rather than the permissive one. See THE MERGE
#                                       MODE DECIDES WHAT MUST BE TRUE below.
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
# The last four are measured AFTER this script has published (see THE PUBLISH
# BOUNDARY below), and they are still measurements: the push and the `gh pr create`
# happen here, and then `git ls-remote` and `gh pr list` are asked what is actually
# on GitHub. What this script did is not evidence of what landed.
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
# THE THIRD TIP IS THE FRAGILE ONE, because it is the only one that needs the network,
# and a baseline that is merely MISSING reads downstream exactly like a baseline that
# said "no such commit". So the remote probe is retried three times — the same as the
# post-build witness, because an asymmetry between them is itself the bug: a blip that
# defeats one attempt but not three would drop the tip from the baseline and then
# confirm it as pushed. And when all three attempts fail, the run is DEFERRED rather
# than started: this happens before codex is launched, so an unmeasurable baseline
# costs a round and not a build.
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
# ── THE CHILD SHELL'S ENVIRONMENT: THE DEFAULT FILTER STAYS ON ───────────────
# `codex exec` filters the environment it gives the commands the model runs
# (`shell_environment_policy`). The defaults are `inherit = "core"` — HOME, PATH,
# SHELL, TMPDIR, LOGNAME and a handful more — plus a default EXCLUDE list of
# `*KEY*`, `*SECRET*`, `*TOKEN*` applied on top.
#
# AN EARLIER VERSION OF THIS SCRIPT TURNED BOTH OF THOSE OFF
# (`inherit=all` + `ignore_default_excludes=true`) to deliver `GH_TOKEN` and
# `GIT_CONFIG_KEY_0` to the build's `git push`. THE PREMISE WAS FALSE and the grant was
# removed. Two separate things were wrong with it:
#
#   • IT DELIVERED NOTHING. The GitHub credential is wired to the OUTER loop only
#     (`open/composer.ts` composes `run_host: makeLazyCredentialedHostRunner(…)` over
#     `githubProcessEnv(…)` from `github/credential.ts`). The INNER workflow — which is
#     what launches this script, by way of a bridge agent's shell — never receives it.
#     `SPEC.md` records this as verified live on the fire REPL: `/proc/<pid>/environ`
#     contains no `GH_TOKEN` and no `GIT_CONFIG_*`. So `inherit=all` widened the filter
#     over a variable that was not there to inherit, and the push stayed anonymous.
#   • IT EXPOSED THE ONE CREDENTIAL THIS WHOLE LANE EXISTS TO PROTECT. That REPL's env
#     is where the owner's Anthropic credential lives: `gateway/wiring/build-import-
#     substrate.ts` sets `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` per spawn
#     (`runtime/adapters/claude-code/index.ts` documents the field). Both match the
#     default `*TOKEN*`/`*KEY*` patterns, so clearing the excludes handed the Anthropic
#     quota — the thing the owner moved this phase off Anthropic to conserve — to a
#     GPT-driven `danger-full-access` shell. Paying for a credential leak with a
#     credential leak, and getting neither.
#
# So the defaults stay on, and on top of them:
#
#   -c shell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]
#
# NOT REDUNDANT WITH THE DEFAULTS, and that is the point of writing it out. The default
# list catches these three families only by SUBSTRING COINCIDENCE — `ANTHROPIC_API_KEY`
# happens to contain `KEY`, `CLAUDE_CODE_OAUTH_TOKEN` happens to contain `TOKEN`. That
# list belongs to another project and can be re-tuned in any release, and a variable
# added tomorrow (`ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`) need not contain either
# word. Naming the families makes the protection intentional and auditable in one line
# instead of contingent on someone else's regex. `KIMI_*` is here for the same reason:
# `trident/kimi-key.ts` puts `KIMI_API_KEY` into this process's environment on purpose,
# and the review lane's key has no business in the build's shell.
#
# `GH_*` AND `GITHUB_*` ARE THE NEW ENTRIES, and they are the point of THE PUBLISH
# BOUNDARY below: this script's own environment may now hold a GitHub credential,
# because this script is the side that publishes. The build must not inherit it. The
# `exclude` line covers the whole family for the shells the model runs; the two names
# `gh` actually reads on github.com — `GH_TOKEN` and `GITHUB_TOKEN` — are additionally
# `env -u`'d off the `codex` process itself at the launch below, so they are gone one
# level higher than the CLI's own filter and their absence does not depend on the CLI
# honouring a config key at all. THE DIRECTION OF THIS CHANGE IS THE WHOLE DESIGN: the
# sandbox LOSES a capability it never had working, and the credential moves further
# from it, not closer.
#
# AND `--strict-config`, WHICH IS WHAT MAKES THE LINE ABOVE LOAD-BEARING RATHER THAN
# DECORATIVE. Without it an unrecognised `-c` key is accepted and ignored, so a future
# CLI that renamed the field would silently stop excluding anything and the leak would
# come back with no symptom at all. With it, the same rename is a config error before a
# token is spent, and it names the field. Measured on the CLI shipped here
# (`codex-cli 0.147.0`): `codex exec --strict-config -c
# shell_environment_policy.<invented>=true` refuses with `unknown configuration field`,
# while `exclude`, `inherit`, `ignore_default_excludes`, `set` and `include_only` are
# all accepted — the refusal proves the check can fail on this exact input shape, which
# is what makes the acceptance mean something.
#
# The metered `OPENAI_API_KEY` is handled separately and earlier: it is `unset` from
# this script's own environment before `codex` is launched at all (see the billing
# contract above), so it is not in the set being filtered.
#
# ── THE PUBLISH BOUNDARY: THE BUILD COMMITS, THE HOST PUBLISHES ──────────────
# THE SPLIT THIS SECTION DESCRIBES IS THE FIX FOR A MEASURED FAILURE. On 2026-08-13 a
# codex build wrote an entire feature across eleven files and got the suite green, and
# then delivered NOTHING: its trailer and its transcript were both 0 bytes, the workflow
# received empty BRANCH/HEAD/PR values, scored the seat `deferred`, and ended the round
# with no PR and no review panel. A build that cannot publish looks exactly like a build
# that produced nothing, and only a preserved dirty worktree made the work recoverable.
#
# The cause was that HALF the publish path had a surviving credential and half did not,
# and the half that did not is the half that REPORTS the result:
#
#   • `git push` could authenticate: the credential is a `store --file=…` helper named
#     in `~/.gitconfig`, and a FILE survives the child's environment filter.
#   • `gh pr create` could not, ever: `gh` on this host has no `hosts.yml` and
#     authenticates purely from `GH_TOKEN`, which is exactly what the default
#     `*TOKEN*` exclude strips from the shells the model runs — deliberately, and that
#     exclude is not going to be widened (see THE CHILD SHELL'S ENVIRONMENT: the last
#     attempt to widen it leaked the owner's Anthropic credential into a
#     `danger-full-access` GPT shell and still delivered nothing).
#
# So the contract is SPLIT AT THE PUBLISH BOUNDARY, which is what `SPEC.md` records the
# owner asking for — the build agent should not hold a credential at all, it should ask
# the HOST to publish:
#
#   THE BUILD (inside the sandbox) creates/checks out the branch, writes the code, runs
#   the tests until they pass, COMMITS LOCALLY, and writes the branch diff. It is told
#   not to push and not to open a PR (`codexBuildCoda` in `trident/inner-workflow.mjs`).
#
#   THE HOST (this script, outside the sandbox) pushes the branch and opens the PR, and
#   then MEASURES what landed. `publish()` below is that step.
#
# Nothing sensitive crosses into the GPT sandbox to make this work — the movement is the
# other way: the two names `gh` reads are now stripped from the codex process on top of
# the CLI's own filter. The sandbox loses a capability rather than gaining one.
#
# WHAT DOES NOT CHANGE, AND MUST NOT. The publish happens INSIDE the same
# `emit_trailer` that already refuses to report a pre-existing sha, and it is gated on
# that same `head`: only a commit THIS RUN PRODUCED, on the branch this run was asked
# for, is ever pushed. And `REMOTE_HEAD` is still the WITNESS probe — `git ls-remote`
# asked after the push and compared for equality with our own sha — never "the push
# command exited 0". This script doing the pushing is not evidence that the commit is
# on the remote; the remote saying so is (#545: a verdict may not land on a base the
# review never saw).
#
# ── THE PRECHECK NOW ASKS ABOUT THE HOST, AND STILL ASKS EARLY ───────────────
# The question "can the push authenticate" did not disappear with the split, it changed
# subject: it is now about THIS process, which is the one that will run the commands. It
# is still asked BEFORE codex is launched, because the value of asking is that a run
# that cannot deliver costs a round and no tokens instead of a full build reported as
# "produced no commitSha — nothing was built".
#
# Two capabilities are needed and both are probed, because half of one is what produced
# the incident above:
#
#   • `push_credential_ok` — `git credential fill` against the push remote's host, which
#     consults exactly the helpers a real `git push` consults. IT MEASURES CAPABILITY
#     AND DOES NOT ASSUME A MECHANISM: it does not test for `GH_TOKEN`, because a store
#     file, an osxkeychain or any other configured helper is a credential a push can
#     use. An `ssh://`/`git@` remote is SKIPPED rather than failed — a key
#     authenticates it and no helper is ever consulted, and failing those would break
#     every install that pushes over ssh in order to protect the ones that push over
#     https.
#   • `gh_auth_ok` — `gh auth status`, for the same reason and in the same spirit: the
#     tool that will open the PR is asked whether it can, through whatever mechanism it
#     is configured with. This half is NEW, and it is the half that was missing: the
#     run that failed had a working push and an unauthenticated `gh`, and nothing asked.
#
# Both are `pr`-mode-and-an-origin only. A `local` run pushes nothing and opens nothing.
#
# ── THE MERGE MODE DECIDES WHAT MUST BE TRUE ─────────────────────────────────
# `pr` and `local` are not the same build with a different ending, and three checks
# here have to know which one they are in. Before arg $3 existed they all behaved as if
# every run were a `pr` run, keyed off "does an `origin` exist" — which is a question
# about the CLONE, not about the RUN:
#
#   • THE REMOTE BASELINE (the third pre-existing tip). In `pr` mode it is mandatory:
#     without it a re-entry can report the previous round's remote-only commit as its
#     own. In `local` mode nothing is ever pushed, so the remote cannot be the source of
#     a commit this build did not make, and the baseline is not needed. Keyed on
#     `has_origin` alone, ANY local-mode clone that has an origin it cannot reach —
#     offline, a non-GitHub origin, a stale URL — hard-DEFERRED at exit 3 before codex
#     launched, every round, forever. The run could never make progress and the reason
#     named a remote it was never going to use.
#   • THE PUSH-CREDENTIAL PROBE. Same argument: a `local` build never pushes, so a
#     missing push credential is not a defect in it.
#   • THE PR NUMBER. `gh pr list` ran unconditionally, so a local-mode build standing on
#     a branch that happens to have an open PR reported that PR's number — where the
#     contract (`trident/inner-workflow.mjs`) says local mode reports null. Not a merge
#     hazard (`trident/merge.ts` routes on the run's own `merge_mode`, not on this), but
#     it is a fabricated fact in a trailer whose entire purpose is measured ones.
#   • THE PUSHED-SHA WITNESS. Same again: a local build pushes nothing and the bridge
#     reads HEAD rather than REMOTE_HEAD, so the probe can only ever confirm "not
#     pushed" about a commit that was never meant to be — while costing up to 3×10s
#     against a remote the run does not use, on the failure path too.
#
# `pr` is the default for an absent or unrecognised arg $3: it is the strict side of all
# three, so the failure mode of a caller that forgets is a run that checks too much,
# never one that checks too little.
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
#                       precheck failed, no brief, a brief that did not survive the
#                       trip intact, nowhere writable to put the trailer, a remote
#                       baseline that could not be measured, or — in `pr` mode — no
#                       credential that could authenticate the push this script will
#                       make, no `gh`, or a `gh` that cannot authenticate the PR this
#                       script will open). Every one of these is decided BEFORE codex
#                       is launched, so a DEFERRED build costs a round and no tokens.
#   5   DEFERRED      — codex ran and exited non-zero.
#
# A PUBLISH THAT FAILS IS NOT ON THIS LIST, and that is deliberate: it comes out as an
# empty REMOTE_HEAD (and an empty PR) in a trailer that still names the branch, the
# local sha and the diff. Exit 5 would map to `deferred` at the bridge, which blanks
# every field — throwing away the two facts an operator needs to recover a build that
# really did happen.
# Unlike the REVIEW lane, NOT_CONNECTED is not a graceful degrade here: a build that
# did not happen is not a reduced panel, it is no build. The bridge reports it and
# the workflow stops rather than quietly re-running on Claude — the owner moved the
# build off Anthropic on purpose, and a silent fallback would spend the quota they
# were trying to protect and hide that it had done so.
# =============================================================================

set -uo pipefail

BRANCH="${1:-}"
BASE_BRANCH="${2:-}"
# `pr` unless the caller explicitly said `local` — see THE MERGE MODE DECIDES WHAT MUST
# BE TRUE. Anything else, including an empty or misspelled value, lands on `pr`, which
# is the strict side of all three checks that read it: a caller that forgets this
# argument gets a run that verifies too much, never one that verifies too little.
MERGE_MODE='pr'
[ "${3:-}" = 'local' ] && MERGE_MODE='local'
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
# Prints exactly one of three things, and the THIRD is the point:
#
#   <sha>                the remote answered and the branch is at this commit
#   '' (empty)           the remote ANSWERED and the branch is not there
#   'unknown' (UNKNOWN)  every attempt failed — the remote never answered at all
#
# "Not there" and "never answered" are the same non-answer to a caller that only sees
# an empty string, and they mean opposite things: the first is a fact to act on, the
# second is a hole where a fact should be. The baseline caller below now REFUSES on
# UNKNOWN rather than treating it as "the branch is not on the remote", which is the
# misreading that let a pre-existing remote-only commit be reported as this build's.
#
# `attempts` (default 3, which is the safe value — a caller that forgets the argument
# gets the resilient probe, not the brittle one) is how many times to ASK WHEN THE
# PROBE FAILS: a non-zero `git ls-remote`, or the alarm cutting it off. A probe that
# COMPLETED ends the loop whatever it found, including finding nothing: "the branch is
# not on the remote" is a real answer, and re-asking it would be waiting for the remote
# to change its mind (and, in the witness case below, is the one way a true "not
# pushed" could become a false "pushed" if something else landed mid-loop). Only the
# failure — which is the outcome that cannot be told apart from a blip — is retried.
#
# THE RETRY LIVES IN HERE, not in the caller, because the caller reads this through
# `$(…)`: a subshell, whose variables never reach the parent, so a caller could not see
# whether the probe failed or merely came back empty.
remote_tip() {
  local out tip attempts n answered
  attempts="${2:-3}"
  out="${TMPDIR:-/tmp}/trident-codex-build-ls.$$"
  tip=''
  answered=0
  n=1
  while [ "$n" -le "$attempts" ]; do
    if bounded "$out" 10 env GIT_TERMINAL_PROMPT=0 git ls-remote origin "refs/heads/$1"; then
      tip="$(awk 'NR==1 {print $1}' "$out" 2>/dev/null || true)"
      answered=1
      break
    fi
    n=$((n + 1))
  done
  rm -f "$out"
  if [ "$answered" -ne 1 ]; then
    printf 'unknown'
    return 0
  fi
  sha_or_empty "$tip"
}

# Is there an `origin` to ask at all? A LOCAL config read, so it costs nothing and
# cannot hang. Without it `git ls-remote origin` fails instantly and identically to a
# wedged network, and the two must not be confused: a repo with no remote cannot have a
# remote-only branch, so its remote baseline is complete by being empty, while a repo
# whose remote will not answer has a baseline nobody measured.
has_origin() {
  git config --get remote.origin.url >/dev/null 2>&1
}

# Is this a `pr`-mode run? See THE MERGE MODE DECIDES WHAT MUST BE TRUE in the header:
# the remote baseline, the push-credential precheck and the PR probe are all `pr`-only,
# and keying them on `has_origin` instead is what wedged local-mode runs on any clone
# whose origin was unreachable.
is_pr_mode() {
  [ "$MERGE_MODE" = 'pr' ]
}

# Can a `git push` to origin actually authenticate? Prints nothing; the STATUS is the
# answer. See SO HOW DOES THE BUILD PUSH in the header for why this is asked at all.
#
# Three outcomes, and two of them are "yes, proceed":
#
#   0  a credential answered for the push remote's host          → proceed
#   0  the remote does not use a credential helper (ssh, local)  → proceed, not our call
#   1  the remote is http(s) and NOTHING answered                → the push will be
#                                                                  anonymous
#
# `git credential fill` is the probe rather than a test for `GH_TOKEN` because it asks
# THE SAME MACHINERY A REAL PUSH ASKS: whatever helpers are configured, in their
# configured order, including ones this script has never heard of. A test for a specific
# variable would answer a question about a mechanism instead of about the capability,
# and would fail an install that authenticates some other way.
#
# `GIT_TERMINAL_PROMPT=0` so a box with no helper fails immediately instead of blocking
# on a username prompt nobody is there to answer, and `bounded` on top of that because a
# credential helper can reach the network (a keychain unlock, a token refresh) and this
# runs before the build gets to spend anything.
#
# THE SECRET IS NEVER PRINTED, LOGGED OR STORED. The output goes to a file that is read
# once with `grep -q` for the PRESENCE of a non-empty `password=` line and deleted in the
# same breath; no branch here interpolates it, and the caller only ever sees the status.
push_credential_ok() {
  local url host proto out req rc
  url="$(git remote get-url --push origin 2>/dev/null || true)"
  # No push URL at all is not this function's failure to report — `has_origin` and the
  # caller's `is_pr_mode` guard decide whether an origin was required.
  [ -n "$url" ] || return 0
  case "$url" in
    https://*)
      proto='https'
      host="${url#https://}"
      ;;
    http://*)
      proto='http'
      host="${url#http://}"
      ;;
    # ssh://…, git@host:…, /a/local/path, file://… — a key or the filesystem
    # authenticates these and no credential helper is ever consulted, so there is
    # nothing here to measure and refusing them would break every install that pushes
    # over ssh in order to protect the ones that push over https.
    *) return 0 ;;
  esac
  # Strip any `user@` prefix and everything from the first `/` — what is left is the
  # host (with its port, if any), which is the granularity git scopes a credential to.
  host="${host#*@}"
  host="${host%%/*}"
  [ -n "$host" ] || return 0
  out="${TMPDIR:-/tmp}/trident-codex-build-cred.$$"
  req="${TMPDIR:-/tmp}/trident-codex-build-credreq.$$"
  printf 'protocol=%s\nhost=%s\n\n' "$proto" "$host" > "$req"
  # NOT `bounded`, and deliberately: that helper hard-codes `</dev/null` (a network tool
  # that decides to prompt would otherwise wait on stdin forever), and `git credential
  # fill` reads its REQUEST from stdin. Passing it /dev/null would ask about no host at
  # all. Same alarm, same redirect-to-a-file discipline, different stdin — through a
  # FILE rather than a pipe, for the reason `bounded`'s own comment gives: `$(…)` and a
  # pipe both return when the fd closes, not when the process exits.
  perl -e 'my $s = shift; alarm $s; exec @ARGV or exit 1' 10 \
    env GIT_TERMINAL_PROMPT=0 git credential fill <"$req" >"$out" 2>/dev/null
  # `password=` followed by at least one character. An empty `password=` line is a
  # helper that answered without a secret, which authenticates nothing.
  grep -q '^password=.' "$out" 2>/dev/null
  rc=$?
  rm -f "$out" "$req"
  return "$rc"
}

# Can THIS PROCESS — the host side of the publish boundary — open a PR? Prints
# nothing; the STATUS is the answer.
#
# `gh auth status` is the probe for exactly the reason `git credential fill` is the
# probe for the push: it asks THE TOOL THAT WILL DO THE WORK whether it can, through
# whatever mechanism it is configured with (a token in this environment, a hosts.yml, a
# keychain), instead of testing for one variable and calling that a capability. On this
# host it happens to resolve to `GH_TOKEN`, but nothing here depends on that.
#
# BOUNDED, AND ASKED UP TO THREE TIMES. `gh auth status` validates against the API, so
# on a single attempt a network blip is indistinguishable from a missing credential —
# and the answer here DEFERS a build, so a false negative costs the run a round. Same
# retry shape as every other network probe in this script.
#
# NOTHING FROM ITS OUTPUT IS PRINTED OR KEPT: `gh auth status` names the credential's
# source, and with `--show-token` (never passed here) prints the secret itself, so both
# streams go to /dev/null and only the status is read.
gh_auth_ok() {
  local n
  n=1
  while [ "$n" -le 3 ]; do
    bounded /dev/null 10 gh auth status && return 0
    n=$((n + 1))
  done
  return 1
}

# The number of the OPEN PR for branch `$1`, or the empty string. Bounded like every
# other network call here: `gh` talks to the API and to a credential helper, either of
# which can block forever, and one of this function's two callers runs on the failure
# path where a hang would eat the DEFERRED report the bridge is waiting for.
#
# ONE READER FOR TWO QUESTIONS, deliberately. `publish` asks it before `gh pr create`
# ("is there already one, so this is a fix round and not a duplicate"), and
# `emit_trailer` asks it AGAIN afterwards to measure what goes in the trailer. The
# second call is not redundant with the first: it makes the reported number a fact read
# back from GitHub rather than this script's memory of what it just did — the same rule
# `REMOTE_HEAD` follows, for the same reason.
open_pr_number() {
  local out n
  out="${TMPDIR:-/tmp}/trident-codex-build-pr.$$"
  bounded "$out" 10 \
    gh pr list --head "$1" --state open --json number --jq '.[0].number' || true
  n="$(head -n 1 "$out" 2>/dev/null || true)"
  rm -f "$out"
  # `--jq` prints `null` when the list is empty, and a literal "null" reported as a PR
  # number is worse than none at all.
  case "$n" in
    '' | *[!0-9]*) printf '' ;;
    *) printf '%s' "$n" ;;
  esac
}

# ── THE HOST PUBLISHES: push the branch, then open the PR ─────────────────────
# Called with the sha THIS BUILD PRODUCED — `emit_trailer` has already blanked a head
# that pre-existed or that was made on the wrong branch, so this can only ever publish
# a commit the run is entitled to.
#
# NOTHING IT DOES IS REPORTED AS A FACT. The trailer's REMOTE_HEAD and PR are measured
# afterwards by asking the remote and `gh`; a push that exits 0 is not evidence that
# the commit is on the branch, and a `gh pr create` that exits 0 is not evidence that a
# PR is open. This function only makes the facts possible.
#
# A FAILED PUBLISH DOES NOT FAIL THE SCRIPT. See the exit-code list in the header: the
# fail-closed answer is an empty REMOTE_HEAD in a trailer that still carries the branch,
# the local sha and the diff path, which is what an operator recovers the work from.
#
# THE TOOLS' OWN OUTPUT IS NEVER ECHOED. `git push` and `gh` both quote the remote URL
# in their errors, and a URL can carry an embedded credential
# (`https://x-access-token:<secret>@host/…`), so the failure is named and the text is
# dropped. `emit_trailer`'s measurements are what diagnose it.
publish() {
  local head="$1" existing rc
  # THE REFSPEC IS EXPLICIT and it is never forced. `git push origin <branch>` obeys
  # `push.default` and the branch's upstream config, neither of which this script set;
  # naming `refs/heads/X:refs/heads/X` pushes exactly the branch that was measured and
  # nothing else. A non-fast-forward is a real refusal — the remote moved under us —
  # and it must stay one: the witness probe below then reports an empty REMOTE_HEAD
  # and the run stops, which is the correct end for a branch this build no longer
  # understands.
  #
  # BOUNDED AT 300s rather than the 10s the read-only probes use: this one sends the
  # whole branch, and a slow-but-working link must not be cut off into a false "the
  # build produced nothing".
  if ! bounded /dev/null 300 \
    env GIT_TERMINAL_PROMPT=0 git push origin "refs/heads/${BRANCH}:refs/heads/${BRANCH}"; then
    echo "CODEX_BUILD_PUSH_FAILED: 'git push origin refs/heads/${BRANCH}' did not succeed, so ${head} exists only in this worktree. The trailer reports an empty REMOTE_HEAD and the run stops rather than review a commit no reviewer can fetch." >&2
    return 1
  fi
  # REUSE, NEVER A DUPLICATE — the same rule the Forge contract states for the Claude
  # builder. A fix round runs this function again on a branch that already has its PR,
  # and `gh pr create` on that branch would either fail or open a second PR for the
  # same work.
  existing="$(open_pr_number "$BRANCH")"
  if [ -n "$existing" ]; then
    return 0
  fi
  # `--fill` takes the title and body from the commits, which is the only source here
  # that is not a model asked to describe itself. `--base` only when the caller named
  # one: an empty `$2` means "no base was passed", and inventing one would open the PR
  # against a branch this run never heard of.
  if [ -n "$BASE_BRANCH" ]; then
    bounded /dev/null 60 gh pr create --head "$BRANCH" --base "$BASE_BRANCH" --fill
    rc=$?
  else
    bounded /dev/null 60 gh pr create --head "$BRANCH" --fill
    rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "CODEX_BUILD_PR_CREATE_FAILED: the branch was pushed but 'gh pr create --head ${BRANCH}' did not succeed. The trailer reports whatever 'gh pr list' can still see for the branch, which may be nothing." >&2
    return 1
  fi
  return 0
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
#
#   emit_trailer <outcome>   — `ok` when codex exited 0, anything else when it did not.
#
# THE OUTCOME DECIDES EXACTLY ONE THING: whether the host publishes. A codex run that
# died may still have left a commit, and the trailer reports it either way so an
# operator can recover the work — but pushing a branch and opening a PR for a round
# the workflow is about to discard leaves a stray PR nobody asked for. Anything other
# than the literal `ok` is treated as "did not complete", so a caller that forgets the
# argument lands on the side that publishes nothing.
emit_trailer() {
  local outcome head remote_head pr_number diff_path branch_name
  outcome="${1:-}"
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
  # ── THE PUBLISH, and it happens HERE for a reason ───────────────────────────
  # Behind the same `$head` the two gates above just established. That is the whole
  # safety argument for moving the push into this script: the only sha it can publish
  # is one THIS RUN PRODUCED, on the branch this run was ASKED FOR. A publish placed
  # before those gates — or keyed off "did the build commit something" — would push a
  # re-entry's `git switch` onto the previous round's tip and open a PR for work this
  # invocation did not do.
  #
  # `pr` mode with an origin only, and only when codex actually completed. The push
  # credential and `gh auth` were both proved before launch, so reaching here without
  # them means something changed mid-build; the failure is named on stderr and the
  # measurements below tell the truth about what landed.
  if [ "$outcome" = 'ok' ] && is_pr_mode && [ -n "$head" ] && [ -n "$BRANCH" ] && has_origin; then
    publish "$head" || true
  fi
  remote_head=''
  # `pr` MODE ONLY, like the baseline and the PR probe. In local mode nothing is ever
  # pushed and the bridge reads HEAD rather than REMOTE_HEAD, so this probe can only
  # ever confirm "not pushed" about a commit that was never meant to be — at a cost of
  # up to 3×10s against a remote the run does not use, on the failure path included.
  if is_pr_mode && [ -n "$head" ] && [ -n "$BRANCH" ] && has_origin; then
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
    #
    # `remote_tip` prints the literal `unknown` when it never got an answer, which is
    # not a sha and so can never equal `$head`: an unanswerable remote leaves
    # REMOTE_HEAD empty, which is the fail-closed direction.
    [ "$(remote_tip "$BRANCH" 3)" = "$head" ] && remote_head="$head"
  fi
  pr_number=''
  # `pr` MODE ONLY. A local-mode run never opens a PR, and the workflow's own contract
  # says it reports null — but this probe used to run unconditionally, so a local build
  # standing on a branch that happened to have an open PR (a re-run of a branch already
  # pushed, say) reported that unrelated PR's number as its own. Every other field here
  # is a measurement; this one would have been a coincidence.
  #
  # ASKED AGAIN AFTER `publish`, never taken from it. `gh pr create` printing a URL is
  # this script's claim about what it did; `gh pr list` is GitHub's answer about what
  # exists. On a fix round nothing was created at all and this is the only source there
  # has ever been.
  if is_pr_mode && [ -n "$BRANCH" ] && command -v gh >/dev/null 2>&1; then
    pr_number="$(open_pr_number "$BRANCH")"
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
# SET IS NOT WRITABLE, and it is the second of those this check is for. A path
# under a directory that does not exist passes the emptiness test above and then fails
# at the single `> "$TRAILER_FILE"` in `emit_trailer` — which, with no `set -e`, is a
# line of stderr and nothing else: the script exits 0, the bridge finds no trailer,
# and the workflow reports "produced no commitSha — nothing was built" about a build
# that spent every token and built the whole thing. So the write is PROVED here, by
# doing it, while the only cost of being wrong is a round.
if ! : > "$TRAILER_FILE" 2>/dev/null; then
  echo "CODEX_BUILD_TRAILER_UNWRITABLE: cannot write NEUTRON_CODEX_BUILD_TRAILER_FILE=$TRAILER_FILE (missing directory, or no permission) — a completed build would report nothing and the tokens would be spent. DEFERRED." >&2
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
if is_pr_mode && [ -n "$BRANCH" ] && has_origin; then
  # RETRIED 3× — THE SAME AS THE WITNESS PROBE, and the symmetry is the whole point.
  # This probe used to ask once while the post-build witness asked three times, and a
  # blip long enough to defeat one attempt but not three resolves that asymmetry into
  # FABRICATED PROVENANCE: on a re-entry whose previous round exists only on the remote
  # (a crash-resume, or a fix round in a fresh worktree — the case the local pair above
  # cannot see), the missed baseline lets `pre_existing` pass a commit this build never
  # made, the branch-name gate passes too, and the retried witness then confirms it as
  # "pushed". The run would hand the panel a sha and a diff for someone else's round.
  #
  # AND AN UNANSWERED PROBE IS REFUSED, not treated as "the branch is not there". The
  # baseline is the only thing standing between a switched-onto commit and a reported
  # one, so a baseline nobody measured is not a baseline. Refusing costs a round; it
  # costs NO TOKENS, because this runs before codex is launched — which is why the
  # answer here is DEFERRED and not "build anyway and hope".
  _pre="$(remote_tip "$BRANCH" 3)"
  if [ "$_pre" = 'unknown' ]; then
    echo "CODEX_BUILD_NO_REMOTE_BASELINE: 'git ls-remote origin refs/heads/${BRANCH}' never answered in 3 attempts, so this run cannot tell a commit it makes from one that was already on the branch. DEFERRED before any tokens were spent — retry when the remote answers." >&2
    exit 3
  fi
  [ -n "$_pre" ] && PRE_EXISTING_HEADS="${PRE_EXISTING_HEADS}${_pre}
"
fi

# ── DEFERRED: pr mode, and THIS PROCESS cannot publish what it is about to build ─
# See THE PRECHECK NOW ASKS ABOUT THE HOST in the header. In `pr` mode the run is graded
# on the PUSHED sha and on an open PR, and BOTH are this script's job now — so a host
# that cannot do them has already failed the round, it just does not know it yet. Asking
# here turns a full build that ends in "produced no commitSha — nothing was built" into a
# free, named deferral one round earlier.
#
# Ordered AFTER the baseline probe and BEFORE the launch, with the rest of the pre-launch
# refusals: everything above this line costs a round and no tokens, and this belongs on
# that side of the line.
#
# THE PUSH HALF FIRST, because it is the local, instant one — `git credential fill`
# consults configured helpers and returns, while `gh auth status` is a round trip to the
# API. A host missing both should hear about the cheaper check.
if is_pr_mode && has_origin && ! push_credential_ok; then
  echo "CODEX_BUILD_NO_PUSH_CREDENTIAL: 'git credential fill' found no credential for the push remote's host, so the 'git push' THIS WRAPPER makes after the build would be anonymous and would fail. DEFERRED before any tokens were spent. Connect GitHub, configure a credential helper for the push host, or run this build in local merge-mode." >&2
  exit 3
fi
# THE PR HALF, which is the one that was missing. A host with a working push and an
# unauthenticated `gh` is exactly the run this split exists to fix: it built the whole
# feature, committed, and then had nowhere to deliver it — and because the delivery step
# is also the reporting step, the round looked identical to one that produced nothing.
if is_pr_mode && has_origin; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "CODEX_BUILD_NO_GH_CLI: 'gh' is not on PATH, and in pr mode THIS WRAPPER opens the PR after the build (the build itself is told not to, and holds no GitHub credential). DEFERRED before any tokens were spent — install the GitHub CLI, or run this build in local merge-mode." >&2
    exit 3
  fi
  if ! gh_auth_ok; then
    echo "CODEX_BUILD_NO_GH_CREDENTIAL: 'gh auth status' could not authenticate in 3 attempts, so the 'gh pr create' THIS WRAPPER makes after the build would fail and the build would have nowhere to be delivered. DEFERRED before any tokens were spent — authenticate gh (a GH_TOKEN in this process's environment, or 'gh auth login'), or run this build in local merge-mode." >&2
    exit 3
  fi
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
#
# THE SEAM IS SCRUBBED THE SAME WAY THE REAL LAUNCH IS (`env -u GH_TOKEN
# -u GITHUB_TOKEN`, below). A seam standing in for the sandbox must inherit the
# SANDBOX's blindness, not the host's reach: without this a test build could reach for
# a credential the thing it stands in for cannot see, and would "prove" a publish path
# that does not exist in production.
if [ -n "${NEUTRON_CODEX_BUILD_EXEC_CMD:-}" ]; then
  if <"$BRIEF_FILE" env -u GH_TOKEN -u GITHUB_TOKEN sh -c "$NEUTRON_CODEX_BUILD_EXEC_CMD"; then
    emit_trailer ok
    exit 0
  fi
  emit_trailer failed
  echo "CODEX_BUILD_CALL_FAILED: the codex build call failed. DEFERRED — no build happened." >&2
  exit 5
fi

# KEEP `codex exec`'s DEFAULT ENVIRONMENT FILTER (inherit=core, then exclude
# `*KEY*`/`*SECRET*`/`*TOKEN*`) AND NAME THE FAMILIES THAT MUST NEVER CROSS — see THE
# CHILD SHELL'S ENVIRONMENT in the header. The owner's Anthropic credential is in this
# process's environment (`gateway/wiring/build-import-substrate.ts` sets
# `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` per REPL spawn), and handing it to a
# GPT-driven `danger-full-access` shell would spend the very quota this route exists to
# protect. The defaults already catch these three by substring; this line makes it
# intentional rather than contingent on another project's pattern list.
#
# `GH_*` AND `GITHUB_*` JOIN THEM NOW THAT THE HOST PUBLISHES. This process may hold a
# GitHub credential — it is the side that pushes and opens the PR — and the build must
# not inherit it. See THE PUBLISH BOUNDARY: the sandbox loses a capability here, it does
# not gain one.
#
# `--strict-config` IS PART OF THE SAME FIX, not a tidy-up beside it. Without it the CLI
# accepts an unrecognised `-c` key and moves on, so the day the field is renamed the line
# below becomes decoration and the leak returns with no symptom. With it a renamed field
# is a config error that names itself, raised before any tokens are spent.
set -- --strict-config \
  -c 'shell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]'

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
# cannot do. `--cd "$WORKTREE"` keeps codex rooted in THIS worktree (the bridge agent's
# isolated checkout) rather than wherever the CLI would otherwise infer a workspace
# root, which on a git worktree is not the directory we are standing in. The RESOLVED
# path, captured as `pwd` at the top, not a bare `.`: equivalent today, but it is what
# the trailer reports as `NEUTRON_CODEX_BUILD_WORKTREE` and pinning the same value in
# both places is what stops them drifting.
#
# `env -u GH_TOKEN -u GITHUB_TOKEN` — THE TWO NAMES `gh` READS, TAKEN OFF THE CODEX
# PROCESS ITSELF. The `-c shell_environment_policy.exclude` line above asks the CLI to
# keep them out of the shells the model runs; this takes them out one level higher, so
# their absence does not depend on the CLI honouring a config key, on the default
# `*TOKEN*` pattern surviving another project's next release, or on the model never
# reading its own `/proc/self/environ`. Both, because the exclude covers the whole
# family (`GH_ENTERPRISE_TOKEN`, anything added later) and this covers the two that
# matter absolutely.
if <"$BRIEF_FILE" env -u GH_TOKEN -u GITHUB_TOKEN \
  codex exec "$@" --sandbox danger-full-access --cd "$WORKTREE" -; then
  emit_trailer ok
  exit 0
fi
emit_trailer failed
echo "CODEX_BUILD_CALL_FAILED: 'codex exec' returned non-zero. DEFERRED — the build did not complete." >&2
exit 5
