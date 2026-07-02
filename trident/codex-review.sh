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
DIFF=$(git diff "${BASE_REF}..HEAD" 2>/dev/null | head -n "$DIFF_LINE_LIMIT")
if [ -z "$DIFF" ]; then
  # No diff to review (empty branch / bad base) — surface it but don't fail hard;
  # the reviewer treats an empty codex verdict as no-blocker.
  echo "CODEX_REVIEW_EMPTY_DIFF: no diff for ${BASE_REF}..HEAD." >&2
fi

PROMPT="You are a CROSS-MODEL code reviewer (GPT-5 via the Codex CLI), giving an INDEPENDENT second opinion alongside Claude/Argus on a trident build.
Review the git diff below for correctness, security, spec/as-built drift, and TEST-QUALITY (reject assertion-free / call-count-only tests; demand boundary coverage). Every finding needs EVIDENCE (file:line or a concrete repro) — verify before you assert.
Respond with your findings, then END with a SINGLE final line, exactly one of:
  VERDICT: APPROVE
  VERDICT: REQUEST_CHANGES
Use REQUEST_CHANGES if there is any evidence-backed blocker.

DIFF (${BASE_REF}..HEAD):
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

if codex exec "$PROMPT"; then
  exit 0
fi
echo "CODEX_REVIEW_CALL_FAILED: 'codex exec' returned non-zero. DEFERRED — do NOT treat as an approval." >&2
exit 5
