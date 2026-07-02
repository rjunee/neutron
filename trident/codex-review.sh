#!/usr/bin/env bash
# =============================================================================
# trident cross-model review wrapper — ports Vajra's scripts/codex-review.sh into
# the Neutron trident inner loop.
#
# Runs a Codex (OpenAI ChatGPT-SUBSCRIPTION — NEVER a metered API key) review of
# the current branch diff, using a PER-PROJECT credential dir passed via the
# CODEX_HOME env var (Part B populates this per project; for now the outer loop
# threads NEUTRON_CODEX_HOME through the workflow args → this env). The codex
# reviewer agent in `trident/inner-workflow.mjs` invokes this synchronously in the
# foreground (NEVER run_in_background — there is no mechanism to feed an async
# review back to a headless workflow agent) and maps the EXIT CODE to a panel
# verdict:
#
#   exit 0   CONNECTED   — codex ran; the review text (ending in a `VERDICT:` line)
#                          is on stdout. The reviewer parses it into findings.
#   exit 10  NOT_CONNECTED — no CODEX_HOME / no auth.json. GRACEFUL: the review
#                          falls back to Claude-only + a "codex not connected" note.
#   exit 11  NOT_CONNECTED — codex CLI not on PATH (best-effort install skipped).
#   exit 3   DEFERRED    — configured (auth.json present) but `codex login status`
#                          failed after retries → auth expired/unreachable.
#   exit 5   DEFERRED    — configured + authed, but the review call itself failed.
#
# DEFERRED (3/5) means "configured but the call FAILED" → the synthesis must
# NEVER silently APPROVE (mirror Vajra CODEX_REVIEW_PRECHECK_FAILED /
# CODEX_REVIEW_TIMEOUT never-silent-downgrade). NOT_CONNECTED (10/11) is the
# benign never-set-up path and degrades to Claude-only.
#
# Usage:  CODEX_HOME=/path/to/project/codex bash trident/codex-review.sh [base-ref]
# Default base is `main`. Output/verdict streamed to stdout verbatim.
# =============================================================================

set -uo pipefail

BASE_REF="${1:-main}"
: "${CODEX_HOME:=}"
# How many lines of diff to hand codex — mirror Argus's oversized-diff guard so a
# huge diff can't blow the arg length / codex context. Overridable for tests.
DIFF_LINE_LIMIT="${NEUTRON_CODEX_DIFF_LINE_LIMIT:-3000}"
AUTH_RETRY_DELAY="${NEUTRON_CODEX_AUTH_RETRY_DELAY:-2}"

# ── NOT CONNECTED: no per-project credential configured ───────────────────────
if [ -z "$CODEX_HOME" ] || [ ! -f "$CODEX_HOME/auth.json" ]; then
  if [ -z "$CODEX_HOME" ]; then
    echo "CODEX_REVIEW_NOT_CONNECTED: CODEX_HOME is not set — no codex credential for this project. Falling back to Claude-only review." >&2
  else
    echo "CODEX_REVIEW_NOT_CONNECTED: no auth.json under CODEX_HOME=$CODEX_HOME — codex not connected. Falling back to Claude-only review." >&2
  fi
  exit 10
fi
export CODEX_HOME

# ── HARD BILLING CONTRACT: subscription OAuth ONLY, never a metered API key ────
# This review MUST use the ChatGPT-subscription OAuth persisted under CODEX_HOME.
# The codex CLI PREFERS OPENAI_API_KEY over persisted OAuth, and the gateway
# process may carry one in its env (it also backs gbrain embeddings + the GPT
# adapter), which would silently bill a metered key. Scrub the API-key variants so
# codex falls back to the CODEX_HOME OAuth for BOTH the precheck and the review
# (Codex review [P1]).
unset OPENAI_API_KEY OPENAI_KEY 2>/dev/null || true

# ── NOT CONNECTED: the codex CLI itself is absent (best-effort install skipped) ─
if ! command -v codex >/dev/null 2>&1; then
  echo "CODEX_REVIEW_NOT_CONNECTED: codex CLI not on PATH (install with 'brew install codex' or 'npm install -g @openai/codex'). Falling back to Claude-only review." >&2
  exit 11
fi

# ── DEFERRED precheck: auth must be live. 3× retry, 6s per-attempt wall cap ────
# A genuine expiry fails every attempt (detected → DEFERRED); a transient blip
# recovers on attempt 2/3 (no false DEFERRED). Ported verbatim from Vajra.
codex_auth_ok=0
for attempt in 1 2 3; do
  if perl -e 'alarm 6; exec @ARGV or exit 1' codex login status >/dev/null 2>&1; then
    codex_auth_ok=1
    break
  fi
  [ "$attempt" -lt 3 ] && sleep "$AUTH_RETRY_DELAY"
done
if [ "$codex_auth_ok" -ne 1 ]; then
  echo "CODEX_REVIEW_AUTH_EXPIRED: codex auth invalid/unreachable after 3 attempts (CODEX_HOME=$CODEX_HOME). DEFERRED — the review must NOT be treated as an approval. Re-auth with 'codex login'." >&2
  exit 3
fi

# ── Build the review prompt from the branch diff ─────────────────────────────
# Prefer an explicit diff FILE (NEUTRON_CODEX_DIFF_FILE). In the trident flow
# Forge builds in an ISOLATED worktree and writes the branch diff to a file; the
# review runs from repoPath, which is STILL on the base branch — so a `git diff`
# here would see an EMPTY/stale diff and codex could "approve" without reviewing
# the actual change. Every trident reviewer reviews that diff file; so does codex.
# Fall back to `git diff base..HEAD` for standalone use (Vajra-style).
if [ -n "${NEUTRON_CODEX_DIFF_FILE:-}" ] && [ -f "$NEUTRON_CODEX_DIFF_FILE" ]; then
  DIFF=$(head -n "$DIFF_LINE_LIMIT" "$NEUTRON_CODEX_DIFF_FILE")
  DIFF_SRC="$NEUTRON_CODEX_DIFF_FILE"
else
  DIFF=$(git diff "${BASE_REF}..HEAD" 2>/dev/null | head -n "$DIFF_LINE_LIMIT")
  DIFF_SRC="${BASE_REF}..HEAD"
fi
if [ -z "$DIFF" ]; then
  # No diff to review (empty branch / bad base / missing diff file) — surface it
  # but don't fail hard; the reviewer treats an empty codex verdict as no-blocker.
  echo "CODEX_REVIEW_EMPTY_DIFF: no diff for ${DIFF_SRC}." >&2
fi

PROMPT="You are a CROSS-MODEL code reviewer (GPT-5 via the Codex CLI), giving an INDEPENDENT second opinion alongside Claude/Argus on a trident build.
Review the git diff below for correctness, security, spec/as-built drift, and TEST-QUALITY (reject assertion-free / call-count-only tests; demand boundary coverage). Every finding needs EVIDENCE (file:line or a concrete repro) — verify before you assert.
Respond with your findings, then END with a SINGLE final line, exactly one of:
  VERDICT: APPROVE
  VERDICT: REQUEST_CHANGES
Use REQUEST_CHANGES if there is any evidence-backed blocker.

DIFF (${DIFF_SRC}):
${DIFF}"

# ── Run the review SYNCHRONOUSLY (never backgrounded) ─────────────────────────
# `codex exec` is the CLI's non-interactive one-shot form. A test seam
# (NEUTRON_CODEX_EXEC_CMD) replaces the real invocation so tests never call OpenAI.
if [ -n "${NEUTRON_CODEX_EXEC_CMD:-}" ]; then
  if printf '%s' "$PROMPT" | sh -c "$NEUTRON_CODEX_EXEC_CMD"; then
    exit 0
  fi
  echo "CODEX_REVIEW_CALL_FAILED: the codex review call failed. DEFERRED — do NOT treat as an approval." >&2
  exit 5
fi

# Pipe the prompt via STDIN (`codex exec -`), NOT as an argv entry: a near-cap
# diff (up to DIFF_LINE_LIMIT lines) in a single argument can exceed the OS
# ARG_MAX and fail before codex runs → a false DEFERRED (Codex review [P2]).
if printf '%s' "$PROMPT" | codex exec -; then
  exit 0
fi
echo "CODEX_REVIEW_CALL_FAILED: 'codex exec' returned non-zero. DEFERRED — do NOT treat as an approval." >&2
exit 5
