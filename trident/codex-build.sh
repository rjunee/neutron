#!/usr/bin/env bash
# =============================================================================
# trident CODEX BUILD wrapper — runs a BUILD step on the Codex CLI.
#
# ── Why this exists, and why it is not a new adapter (ISSUES #565) ────────────
# The owner asked to move the build step off Claude: "The whole point is I want
# to be able to switch build to sol". Twice this was reported back as needing a
# new executor, and twice that was wrong — his correction is the design:
#
#   "We do not have to swap the substrate. Codex builds can be kicked off from
#    cli, doesn't need to be an inner agent. You are literally doing it right
#    now in the trident script."
#
# He is describing `trident/codex-review.sh`, which already pipes a prompt into
# `codex exec`. This file is the same seam for the BUILD role: same auth, same
# billing contract, same exit-code vocabulary — a different prompt and a
# different sandbox posture, because a build has to write files and commit.
#
# NOT ROUTED THROUGH `runtime/adapters/select-substrate.ts`, DELIBERATELY. That
# selector carries an explicit contract at its head: it is for conversational /
# utility LLM turns only, trident's inner loop drives the native Workflow tool
# which has no OpenAI analogue, and "callers wiring trident MUST NOT route it
# through this selector". Its own capability table backs that up —
# `providerCapabilities('openai-codex-cli').detachedWorkflows` is `false`, and
# the comment beside it says trident MUST gate on that field. The codex-cli
# substrate is real and registered, but it is a substrate for a conversational
# turn, not a detached workflow; routing a Forge build through it would violate
# the contract the module states about itself. The CLI is the route that
# actually reaches codex from trident, and it is the one the owner named.
#
# ── Exit codes: the same vocabulary the review wrapper uses ───────────────────
#   exit 0   BUILT          — codex ran to completion; its transcript is on stdout.
#   exit 10  NOT_CONNECTED  — no CODEX_HOME / no auth.json. The caller falls back
#                             to the Claude builder and SAYS SO.
#   exit 11  NOT_CONNECTED  — codex CLI not on PATH.
#   exit 3   FAILED         — configured (auth.json present) but the build could
#                             not be STARTED: `codex login status` failed after
#                             retries, or no prompt arrived on stdin.
#   exit 4   EXHAUSTED      — the provider reports no remaining quota (#567). A
#                             DISTINCT code from 3/5 on purpose: quota is the
#                             owner's decision to make and never clears on its
#                             own, so the caller must surface it rather than
#                             retry it. See `trident/provider-health.ts`.
#   exit 5   FAILED         — configured + authed, but `codex exec` itself failed.
#
# Usage:  CODEX_HOME=… CODEX_BUILD_MODEL=gpt-5.6-sol \
#           bash trident/codex-build.sh <worktree-dir> < prompt.txt
# The BUILD PROMPT arrives on STDIN, never as an argv entry: a Forge contract
# plus a task brief routinely exceeds a comfortable argv, and a build that died
# on E2BIG before codex started would look identical to a build that failed.
# =============================================================================

set -uo pipefail

WORKTREE="${1:-}"
: "${CODEX_HOME:=}"
AUTH_RETRY_DELAY="${NEUTRON_CODEX_AUTH_RETRY_DELAY:-2}"

if [ -z "$WORKTREE" ] || [ ! -d "$WORKTREE" ]; then
  echo "CODEX_BUILD_FAILED: worktree directory '$WORKTREE' does not exist — nothing to build in." >&2
  exit 3
fi

# ── NOT CONNECTED: no per-project credential configured ───────────────────────
if [ -z "$CODEX_HOME" ] || [ ! -f "$CODEX_HOME/auth.json" ]; then
  if [ -z "$CODEX_HOME" ]; then
    echo "CODEX_BUILD_NOT_CONNECTED: CODEX_HOME is not set — no codex credential for this project." >&2
  else
    echo "CODEX_BUILD_NOT_CONNECTED: no auth.json under CODEX_HOME=$CODEX_HOME — codex not connected." >&2
  fi
  exit 10
fi
export CODEX_HOME

# ── HARD BILLING CONTRACT: subscription OAuth ONLY, never a metered API key ────
# Identical to the review wrapper's, and load-bearing for the same reason: the
# codex CLI PREFERS OPENAI_API_KEY over persisted OAuth, and the gateway process
# may carry one in its env (it also backs embeddings and the GPT adapter), which
# would silently bill a metered key for every build.
unset OPENAI_API_KEY OPENAI_KEY 2>/dev/null || true

# ── NOT CONNECTED: the codex CLI itself is absent ─────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  echo "CODEX_BUILD_NOT_CONNECTED: codex CLI not on PATH (install with 'brew install codex' or 'npm install -g @openai/codex')." >&2
  exit 11
fi

# ── THE FREE PRECHECK (#567) ──────────────────────────────────────────────────
# `codex login status` costs no quota — it reads the persisted OAuth and asks
# the auth endpoint, not the model endpoint. Running it BEFORE the build is what
# lets an exhausted or expired account be reported in seconds instead of after a
# full build's worth of spend. 3 attempts with a 6s per-attempt wall cap: a
# genuine failure fails all three, a transient blip recovers on 2 or 3.
codex_auth_out=""
codex_auth_ok=0
for attempt in 1 2 3; do
  if codex_auth_out="$(perl -e 'alarm 6; exec @ARGV or exit 1' codex login status 2>&1)"; then
    codex_auth_ok=1
    break
  fi
  [ "$attempt" -lt 3 ] && sleep "$AUTH_RETRY_DELAY"
done

# An auth probe that comes back naming a quota problem is EXHAUSTED, not a
# generic failure — and it is worth checking even on the success path, because
# some accounts authenticate fine and still have nothing left to spend.
if printf '%s' "$codex_auth_out" | grep -Eqi 'insufficient[_ ]quota|quota exceeded|usage limit reached|out of credit|no credits remaining|plan limit reached'; then
  echo "CODEX_BUILD_EXHAUSTED: codex reports no remaining quota for this account. $codex_auth_out" >&2
  exit 4
fi

if [ "$codex_auth_ok" -ne 1 ]; then
  echo "CODEX_BUILD_PRECHECK_FAILED: 'codex login status' failed after 3 attempts (auth expired or unreachable). $codex_auth_out" >&2
  exit 3
fi

# ── The prompt arrives on stdin. An EMPTY one is a caller bug, not a build. ───
PROMPT="$(cat)"
if [ -z "${PROMPT//[[:space:]]/}" ]; then
  echo "CODEX_BUILD_EMPTY_PROMPT: no build prompt arrived on stdin — refusing to run codex with nothing to do." >&2
  exit 3
fi

# PIN THE BUILD MODEL. Unpinned, `codex exec` takes the CLI's own default, which
# OpenAI moves without notice — so the tier the owner selected in the settings
# pane would silently not be the tier that built. Set the variable to the EMPTY
# string to fall back to the CLI default deliberately (the `-` in `${VAR-x}`
# substitutes only when UNSET, so an explicit empty value is respected).
BUILD_MODEL="${CODEX_BUILD_MODEL-gpt-5.6-sol}"
if [ -n "$BUILD_MODEL" ]; then
  set -- --model "$BUILD_MODEL"
else
  set --
fi

# `--full-auto` is what makes this a BUILD rather than a review: codex may edit
# files and run commands inside its sandbox. It is scoped to `--cd $WORKTREE`,
# which is the throwaway worktree the workflow created for this round — the same
# blast radius the Claude builder already has, and the reason the caller must
# never pass the repo of record here.
ERRFILE="$(mktemp -t trident-codex-build.XXXXXX)"
trap 'rm -f "$ERRFILE"' EXIT

# A test seam, mirroring the review wrapper's NEUTRON_CODEX_EXEC_CMD: lets the
# shipped argv be exercised without a codex subscription in CI.
if [ -n "${NEUTRON_CODEX_BUILD_CMD:-}" ]; then
  if printf '%s' "$PROMPT" | sh -c "$NEUTRON_CODEX_BUILD_CMD" 2> >(tee "$ERRFILE" >&2); then
    exit 0
  fi
else
  if printf '%s' "$PROMPT" | codex exec --full-auto --cd "$WORKTREE" "$@" - 2> >(tee "$ERRFILE" >&2); then
    exit 0
  fi
fi

# A build that failed AFTER starting can still be an exhaustion — a long run can
# burn through the last of an account's quota mid-way. Classify before reporting
# so the caller is told which of the two it was.
if grep -Eqi 'insufficient[_ ]quota|quota exceeded|usage limit reached|out of credit|no credits remaining|plan limit reached|billing_hard_limit_reached' "$ERRFILE" 2>/dev/null; then
  echo "CODEX_BUILD_EXHAUSTED: codex ran out of quota during the build." >&2
  exit 4
fi

echo "CODEX_BUILD_CALL_FAILED: 'codex exec' returned non-zero." >&2
exit 5
