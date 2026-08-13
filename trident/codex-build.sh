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
#   in  CODEX_HOME                      the per-project subscription credential dir.
#   in  CODEX_BUILD_MODEL               which GPT tier to build on. A DIFFERENT knob
#                                       from the reviewer's `CODEX_REVIEW_MODEL` on
#                                       purpose: on a box that exports both, one name
#                                       would silently point the reviewer at the
#                                       build's model (or the reverse).
#   arg $1                              the branch the build is expected to land on.
#
#   out  the codex transcript on stdout, then a MEASURED trailer (see below).
#
# ── THE TRAILER IS THE POINT ─────────────────────────────────────────────────
# The inner loop needs four facts from a build — branch, commit sha, PR number,
# diff file — and downstream those facts are load-bearing: `reviewedHead` pins the
# merge to the reviewed commit (`gh pr merge --match-head-commit`, #545) and
# `roundLanded` refuses to re-review a round that left no trace on the branch.
#
# A Claude Forge agent REPORTS those through a schema; it is reporting on itself. A
# `codex exec` subprocess has no schema tool at all, so the naive port would be "ask
# the model to print them" — and the failing case is exactly the one where the model
# believes it succeeded. So this script does not ask. After codex exits it MEASURES
# them with git and gh and prints them itself:
#
#   NEUTRON_CODEX_BUILD_BRANCH=      `git rev-parse --abbrev-ref HEAD`
#   NEUTRON_CODEX_BUILD_HEAD=        `git rev-parse HEAD` — the LOCAL commit
#   NEUTRON_CODEX_BUILD_REMOTE_HEAD= `git ls-remote` — the PUSHED commit, or empty
#   NEUTRON_CODEX_BUILD_PR=          `gh pr list --head` — the PR number, or empty
#   NEUTRON_CODEX_BUILD_DIFF=        the diff file path, or empty if it is missing
#                                    or empty
#   NEUTRON_CODEX_BUILD_WORKTREE=    `pwd`
#
# Every one of them is EMPTY rather than wrong when it cannot be established, and
# the bridge that reads them passes the empty value straight through. An empty sha
# fails closed at both gates: no review of an unbuilt branch, and no merge.
#
# ── THE SANDBOX GRANT, AND WHY IT IS THIS WIDE ───────────────────────────────
# `--sandbox danger-full-access`. Deliberate, and the narrower policies were tried
# against what a build actually does:
#
#   • `read-only` (the exec default) cannot edit a file.
#   • `workspace-write` cannot COMMIT. The build runs in a git WORKTREE, whose `.git`
#     is a file pointing at `<repo>/.git/worktrees/<name>` — so every commit writes
#     outside the workspace, and the first `git commit` fails.
#   • `workspace-write` has no network by default, so `git push`, `gh pr create` and
#     any dependency install fail. Steps 3 and 4 of the Forge contract are exactly
#     those.
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
#     bash trident/codex-build.sh <branch>
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
: "${CODEX_HOME:=}"
WORKTREE="$(pwd)"

# ── The trailer, printed on EVERY path that got as far as running codex ───────
# A function so the measurement is written once and cannot drift between the
# success and failure exits. It measures; it never infers.
emit_trailer() {
  local head remote_head pr_number diff_path branch_name
  branch_name="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  # A detached HEAD has no branch name, and `--abbrev-ref` spells that "HEAD".
  [ "$branch_name" = "HEAD" ] && branch_name=''
  # `--verify`, because a repo with NO commits makes plain `git rev-parse HEAD` echo
  # the literal string `HEAD` back on stdout — a value that is not a sha and is not
  # empty either, which is the worst of both. The shape check below is the backstop:
  # nothing that is not 40 hex characters is allowed to be reported as a commit.
  head="$(git rev-parse --verify HEAD 2>/dev/null || true)"
  case "$head" in
    *[!0-9a-f]* | '') head='' ;;
  esac
  remote_head=''
  if [ -n "$BRANCH" ]; then
    # The PUSHED head, which is the only one a reviewer or a merge will ever see.
    # `awk` splits the `<sha>\trefs/heads/<branch>` line; no match prints nothing.
    remote_head="$(git ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    case "$remote_head" in
      *[!0-9a-f]* | '') remote_head='' ;;
    esac
  fi
  pr_number=''
  if [ -n "$BRANCH" ] && command -v gh >/dev/null 2>&1; then
    pr_number="$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
    # `--jq` prints `null` when the list is empty, and a literal "null" reported as a
    # PR number is worse than none at all.
    case "$pr_number" in
      '' | *[!0-9]*) pr_number='' ;;
    esac
  fi
  diff_path=''
  if [ -n "${NEUTRON_CODEX_BUILD_DIFF_FILE:-}" ] && [ -s "${NEUTRON_CODEX_BUILD_DIFF_FILE}" ]; then
    diff_path="${NEUTRON_CODEX_BUILD_DIFF_FILE}"
  fi
  printf '%s\n' \
    "NEUTRON_CODEX_BUILD_BRANCH=${branch_name}" \
    "NEUTRON_CODEX_BUILD_HEAD=${head}" \
    "NEUTRON_CODEX_BUILD_REMOTE_HEAD=${remote_head}" \
    "NEUTRON_CODEX_BUILD_PR=${pr_number}" \
    "NEUTRON_CODEX_BUILD_DIFF=${diff_path}" \
    "NEUTRON_CODEX_BUILD_WORKTREE=${WORKTREE}"
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
# A test seam (NEUTRON_CODEX_EXEC_CMD) replaces the real invocation so tests never
# call OpenAI. It reads the same STDIN and runs in the same cwd, so the trailer below
# measures a REAL git state either way — which is what makes the seam worth having:
# the interesting behaviour here is the measurement, not the model.
if [ -n "${NEUTRON_CODEX_EXEC_CMD:-}" ]; then
  if <"$BRIEF_FILE" sh -c "$NEUTRON_CODEX_EXEC_CMD"; then
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
