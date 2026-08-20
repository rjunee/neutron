#!/usr/bin/env bash
# =============================================================================
# trident cross-model review wrapper — ports the legacy harness's scripts/codex-review.sh into
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
#   exit 3   DEFERRED    — configured (auth.json present) but the review could not
#                          be PERFORMED: `codex login status` failed after retries
#                          (auth expired/unreachable), or there was NOTHING to
#                          review (empty diff — see CODEX_REVIEW_EMPTY_DIFF below).
#   exit 5   DEFERRED    — configured + authed, but the review call itself failed,
#                          or codex exited 0 but produced an EMPTY final message —
#                          including a content-policy REFUSAL (CODEX_REVIEW_REFUSED),
#                          which `codex exec` reports as exit 0 + empty stdout + the
#                          refusal on stderr.
#
# DEFERRED (3/5) means "configured, but NO REVIEW HAPPENED" — the call failed, or
# codex returned no review text (including a refusal), or there was nothing to
# review (empty diff) → the synthesis must
# NEVER silently APPROVE (mirror the legacy harness CODEX_REVIEW_PRECHECK_FAILED /
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
# recovers on attempt 2/3 (no false DEFERRED). Ported verbatim from the legacy harness.
#
# …AND `codex login status` ONLY READS A LOCAL FILE, so it passes on a seat the
# server has revoked (measured 2026-08-20: `Logged in using ChatGPT`, exit 0, one
# second before the same credential got 401 `token_revoked` from the models
# endpoint). A precheck that cannot tell those apart lets the review spend its
# whole budget before failing. The authenticated GET below can. Duplicated rather
# than sourced from `codex-build.sh`: these two wrappers are copied to other repos
# independently, and a missing sibling would fail in a way that reads as an auth
# error. ONLY 401/403 fails — every other answer leaves the local check in charge.
CODEX_AUTH_PROBE_URL="${NEUTRON_CODEX_AUTH_PROBE_URL:-https://chatgpt.com/backend-api/codex/models?client_version=0.147.0}"
codex_auth_probe_status() {
  command -v curl >/dev/null 2>&1 || { printf 'skip\n'; return 0; }
  local token cfg code
  token=$(perl -0777 -ne 'print $1 if /"access_token"\s*:\s*"([^"]+)"/' "$CODEX_HOME/auth.json" 2>/dev/null)
  [ -n "${token:-}" ] || { printf 'skip\n'; return 0; }
  cfg=$(mktemp "${TMPDIR:-/tmp}/codex-auth-probe.XXXXXX" 2>/dev/null) || { printf 'skip\n'; return 0; }
  chmod 600 "$cfg" 2>/dev/null || true
  # The token never enters argv — `ps` would publish it to every local user.
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$cfg"
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time "${NEUTRON_CODEX_AUTH_PROBE_TIMEOUT:-6}" \
    -K "$cfg" -H 'Accept: application/json' "$CODEX_AUTH_PROBE_URL" 2>/dev/null)
  rm -f "$cfg"
  [ -n "${code:-}" ] || code=000
  printf '%s\n' "$code"
}
codex_auth_ok=0
codex_auth_probe_code=''
for attempt in 1 2 3; do
  if perl -e 'alarm 6; exec @ARGV or exit 1' codex login status >/dev/null 2>&1; then
    codex_auth_probe_code="$(codex_auth_probe_status)"
    case "$codex_auth_probe_code" in
      401 | 403) : ;; # the server refused the seat — retry, then DEFER below
      *)
        codex_auth_ok=1
        break
        ;;
    esac
  fi
  [ "$attempt" -lt 3 ] && sleep "$AUTH_RETRY_DELAY"
done
if [ "$codex_auth_ok" -ne 1 ]; then
  case "$codex_auth_probe_code" in
    401 | 403)
      echo "CODEX_REVIEW_AUTH_EXPIRED: codex auth is REVOKED — 'codex login status' passes (it only reads the local file) but the ChatGPT backend answered HTTP $codex_auth_probe_code for this token (CODEX_HOME=$CODEX_HOME). DEFERRED — the review must NOT be treated as an approval. Waiting will not fix it: re-auth with 'codex login'." >&2
      ;;
    *)
      echo "CODEX_REVIEW_AUTH_EXPIRED: codex auth invalid/unreachable after 3 attempts (CODEX_HOME=$CODEX_HOME). DEFERRED — the review must NOT be treated as an approval. Re-auth with 'codex login'." >&2
      ;;
  esac
  exit 3
fi

# ── Build the review prompt from the branch diff ─────────────────────────────
# Prefer an explicit diff FILE (NEUTRON_CODEX_DIFF_FILE). In the trident flow
# Forge builds in an ISOLATED worktree and writes the branch diff to a file; the
# review runs from repoPath, which is STILL on the base branch — so a `git diff`
# here would see an EMPTY/stale diff and codex could "approve" without reviewing
# the actual change. Every trident reviewer reviews that diff file; so does codex.
# Fall back to `git diff base..HEAD` for standalone use (the legacy harness-style).
# BOTH sources land in FULL_DIFF first so truncation is decided ONE way. `$(<file)`
# and `$(...)` strip trailing newlines, which is what makes the comparison below
# exact: a diff whose only "extra" lines are trailing blanks was NOT truncated.
if [ -n "${NEUTRON_CODEX_DIFF_FILE:-}" ] && [ -f "$NEUTRON_CODEX_DIFF_FILE" ]; then
  FULL_DIFF=$(<"$NEUTRON_CODEX_DIFF_FILE")
  DIFF_SRC="$NEUTRON_CODEX_DIFF_FILE"
else
  FULL_DIFF=$(git diff "${BASE_REF}..HEAD" 2>/dev/null)
  DIFF_SRC="${BASE_REF}..HEAD"
fi
DIFF=$(printf '%s\n' "$FULL_DIFF" | head -n "$DIFF_LINE_LIMIT")
# The FULL size, for the disclosure text only. The `printf '%s\n'` is what makes the
# count exact, NOT the choice of counter: `$(...)` already ate FULL_DIFF's trailing
# newline, and re-terminating it counts a final unterminated line that the FILE's own
# newline count (`wc -l < "$NEUTRON_CODEX_DIFF_FILE"`, the shape git writes for
# "\ No newline at end of file") is one short of. Through THIS pipeline `wc -l` counts
# the same (measured) — the counter is not the load-bearing part and no claim is made
# for awk over it; the `case` below is what rejects whatever a counter prints if it is
# not a bare integer.
# Truncation itself is decided WITHOUT this count (below), so a missing/broken awk
# degrades the disclosure's NUMBERS and can never silence the disclosure.
DIFF_TOTAL_LINES=$(printf '%s\n' "$FULL_DIFF" | awk 'END { print NR }' 2>/dev/null)
case "$DIFF_TOTAL_LINES" in
  '' | *[!0-9]*) DIFF_TOTAL_LINES='' ;;
esac

# A diff that is only WHITESPACE is nothing to review either. `$(...)` already eats
# trailing newlines, but spaces/tabs survive and would sail past a bare -z test and
# hand codex a blank DIFF section — the very approval-about-nothing this guards.
# `case` and not `[ -z "${DIFF//[[:space:]]/}" ]`: that substitution is QUADRATIC in
# bash (33s on a 550KB diff, and it runs on EVERY review); this form is O(n).
case "$DIFF" in
  *[![:space:]]*) ;;
  *)
    # NOTHING TO REVIEW — the diff file failed to write, the base ref resolved wrong,
    # the branch is empty, or the diff could not be read at all. This is DEFERRED,
    # never an approval: a reviewer handed nothing to review must not answer, or the
    # cross-model seat returns a confident APPROVE about nothing and the bridge
    # records it as connected. Mirrors the kimi lane (trident/kimi-review.ts — empty
    # diff → status 'deferred').
    echo "CODEX_REVIEW_EMPTY_DIFF: no diff for ${DIFF_SRC} — nothing to review. DEFERRED — do NOT treat as an approval." >&2
    exit 3
    ;;
esac

# ── TRUNCATION DISCLOSURE ─────────────────────────────────────────────────────
# The diff is capped at DIFF_LINE_LIMIT lines above. Told nothing, the model scopes
# its verdict to "the diff" and APPROVEs an 11k-line change on the strength of its
# first 3000 lines. So when we truncate, SAY SO in the prompt and make the verdict
# scope itself to what was actually read.
#
# TRUNCATION IS A STRING COMPARISON, NOT A LINE COUNT. Comparing what we will send
# against the whole diff is exact and needs no external tool: it can neither MISS a
# truncation (a line count that failed to compute used to fail OPEN — silently
# truncated, no notice) nor INVENT one (trailing blank lines used to inflate the
# count into a false "content was withheld" claim about a diff delivered in full).
# The line NUMBERS are cosmetic, so they degrade on their own when awk is unusable.
TRUNCATION_NOTICE=""
if [ "$DIFF" != "$FULL_DIFF" ]; then
  if [ -n "$DIFF_TOTAL_LINES" ]; then
    SEEN="the FIRST ${DIFF_LINE_LIMIT} lines of a ${DIFF_TOTAL_LINES}-line diff; the remaining $((DIFF_TOTAL_LINES - DIFF_LINE_LIMIT)) lines were NOT provided"
    SCOPE="reviewed only the first ${DIFF_LINE_LIMIT} of ${DIFF_TOTAL_LINES} lines"
    echo "CODEX_REVIEW_DIFF_TRUNCATED: showing the first ${DIFF_LINE_LIMIT} of ${DIFF_TOTAL_LINES} diff lines to codex." >&2
  else
    SEEN="the FIRST ${DIFF_LINE_LIMIT} lines of a LONGER diff (its total length could not be measured); the rest was NOT provided"
    SCOPE="reviewed only the first ${DIFF_LINE_LIMIT} lines of a longer diff"
    echo "CODEX_REVIEW_DIFF_TRUNCATED: showing the first ${DIFF_LINE_LIMIT} diff lines to codex (total length unmeasurable)." >&2
  fi
  TRUNCATION_NOTICE="!! TRUNCATED DIFF — YOU ARE NOT SEEING THE WHOLE CHANGE. You have ONLY ${SEEN} and you cannot request them.
SCOPE YOUR VERDICT TO WHAT YOU ACTUALLY READ: say in your findings that you ${SCOPE}, and NEVER claim the change as a whole is correct or complete. APPROVE means only 'no blocker in the portion I read'.
"
fi

REVIEW_RUBRIC="${NEUTRON_CODEX_REVIEW_RUBRIC:-You are a CROSS-MODEL code reviewer (GPT-5 via the Codex CLI), giving an INDEPENDENT second opinion alongside Claude/Argus on a trident build.
Review the git diff below for correctness, security, spec/as-built drift, and TEST-QUALITY (reject assertion-free / call-count-only tests; demand boundary coverage). Every finding needs EVIDENCE (file:line or a concrete repro) — verify before you assert.}"

PROMPT="${REVIEW_RUBRIC}
Respond with your findings, then END with a SINGLE final line, exactly one of:
  VERDICT: APPROVE
  VERDICT: REQUEST_CHANGES
Use REQUEST_CHANGES if there is any evidence-backed blocker.
${TRUNCATION_NOTICE}
DIFF (${DIFF_SRC}):
${DIFF}"

# ── Run the review SYNCHRONOUSLY (never backgrounded) ─────────────────────────
# `codex exec` is the CLI's non-interactive one-shot form. A test seam
# (NEUTRON_CODEX_EXEC_CMD) replaces the real invocation so tests never call OpenAI.
CODEX_STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/trident-codex-review-stderr.XXXXXX") || CODEX_STDERR_FILE=/dev/null
# With the /dev/null fallback the refusal DIAGNOSIS degrades to the generic
# empty-output message, but the fail-closed gate itself never degrades.
if [ -n "${NEUTRON_CODEX_EXEC_CMD:-}" ]; then
  REVIEW_OUTPUT=$(printf '%s' "$PROMPT" | sh -c "$NEUTRON_CODEX_EXEC_CMD" 2>"$CODEX_STDERR_FILE")
  CALL_EXIT=$?
else
  # Pipe the prompt via STDIN (`codex exec -`), NOT as an argv entry: a near-cap
  # diff (up to DIFF_LINE_LIMIT lines) in a single argument can exceed the OS
  # ARG_MAX and fail before codex runs → a false DEFERRED (Codex review [P2]).
  # PIN THE REVIEW MODEL. Unpinned, `codex exec` takes the CLI's default, and OpenAI
  # moved auto-review to the cheapest 5.6 tier — so the "independent GPT-5 second
  # opinion" this panelist exists to provide was quietly being served by the weakest
  # available model. gpt-5.6-sol is the flagship tier with the strongest capability
  # for this kind of judgement work.
  #
  # Overridable via CODEX_REVIEW_MODEL for a deployment that wants a different tier;
  # set it to the EMPTY string to fall back to the CLI default (the `-` in `${VAR-x}`
  # is deliberate — it substitutes only when UNSET, so an explicit empty value is
  # respected rather than replaced).
  REVIEW_MODEL="${CODEX_REVIEW_MODEL-gpt-5.6-sol}"
  if [ -n "$REVIEW_MODEL" ]; then
    set -- --model "$REVIEW_MODEL"
  else
    set --
  fi
  REVIEW_OUTPUT=$(printf '%s' "$PROMPT" | codex exec "$@" - 2>"$CODEX_STDERR_FILE")
  CALL_EXIT=$?
fi

# Replay the tool's own stderr so the operator/bridge errFile still sees it
# (refusal text included).
if [ "$CODEX_STDERR_FILE" != /dev/null ]; then cat "$CODEX_STDERR_FILE" >&2; fi
if [ "$CALL_EXIT" -ne 0 ]; then
  [ -n "$REVIEW_OUTPUT" ] && printf '%s\n' "$REVIEW_OUTPUT"
  [ "$CODEX_STDERR_FILE" != /dev/null ] && rm -f "$CODEX_STDERR_FILE"
  echo "CODEX_REVIEW_CALL_FAILED: 'codex exec' returned non-zero (exit $CALL_EXIT). DEFERRED — do NOT treat as an approval." >&2
  exit 5
fi

# THE NEW GATE — exit 0 alone is NOT an approval. A content-policy refusal arrives as exit 0 +
# EMPTY final message + the refusal on stderr, indistinguishable by exit code from
# a clean review. An empty answer is a review that DID NOT HAPPEN. Same O(n)
# whitespace case-pattern as the empty-diff guard (never ${VAR//...} — quadratic).
case "$REVIEW_OUTPUT" in
  *[![:space:]]*)
    [ "$CODEX_STDERR_FILE" != /dev/null ] && rm -f "$CODEX_STDERR_FILE"
    printf '%s\n' "$REVIEW_OUTPUT"
    exit 0
    ;;
esac
if grep -qi 'flagged for possible cybersecurity risk' "$CODEX_STDERR_FILE" 2>/dev/null; then
  echo "CODEX_REVIEW_REFUSED: 'codex exec' exited 0 with an EMPTY final message and its stderr carries a content-policy refusal ('flagged for possible cybersecurity risk'). The reviewer was REFUSED — it did not review this diff, and 'no findings' would be false. DEFERRED — do NOT treat as an approval, and do NOT reword/retry the review to dodge the refusal: the operator must learn the review did not run." >&2
else
  echo "CODEX_REVIEW_EMPTY_OUTPUT: 'codex exec' exited 0 but produced an EMPTY final message — no review text to parse, and no cause was measured on stderr. DEFERRED — do NOT treat as an approval." >&2
fi
[ "$CODEX_STDERR_FILE" != /dev/null ] && rm -f "$CODEX_STDERR_FILE"
exit 5
