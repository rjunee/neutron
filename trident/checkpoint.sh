#!/usr/bin/env bash
# =============================================================================
# trident/checkpoint.sh — hardened idempotent checkpoint writes (refactor P10)
# =============================================================================
#
# The inner workflow's Bash checkpoint steps used to embed raw sqlite UPDATE
# statements in the agent prompt (LLM-transcribed) and ran `sqlite3` with the
# default busy_timeout=0 — a write that landed while another process held the
# db lock FAILED INSTANTLY, and a lost terminal write meant no harvest until
# the 25m reaper. This checked-in script replaces that inline SQL:
#
#   * `PRAGMA busy_timeout=5000;` is prepended IN THE SAME sqlite3 invocation
#     (busy_timeout is per-connection), so writes retry for up to 5s under
#     lock instead of failing instantly.
#   * The agent now invokes ONE fixed command with field/value args — no SQL
#     for the LLM to transcribe (and mistranscribe).
#
# Usage:
#   checkpoint.sh <db> <run-id> <field> <value> [<field> <value> ...]
#
# Fields (whitelisted; anything else is an error):
#   pr <int>                 → pr=<int>                          (numeric)
#   branch <str>             → branch='<str>'
#   inner_checkpoint <str>   → inner_checkpoint='<str>'
#   subagent_status <str>    → subagent_status='<str>'
#   inner_verdict <str>      → inner_verdict='<str>'
#   inner_result_file <path> → inner_result=CAST(readfile('<path>') AS TEXT),
#                              subagent_status=CASE WHEN
#                                length(CAST(readfile('<path>') AS TEXT)) > 0
#                                THEN 'completed' ELSE subagent_status END
#
# `last_advanced_at='<now UTC, %FT%TZ>'` is ALWAYS appended — both legacy
# inline call sites unconditionally stamped it via `$(date -u +%FT%TZ)`; the
# script computes it so the prompt carries no command substitution either.
#
# SEMANTICS ARE UNCHANGED from the inline SQL this replaces
# (trident/inner-workflow.mjs checkpoint()/writeTerminalResult()), EXCEPT that
# the UPDATE now also refuses a row that has already reached a terminal phase
# (see the guard at the bottom):
#   * same table (code_trident_runs), same WHERE id='<run-id>' row selection;
#   * same column/value SET pairs (SET order is irrelevant in SQLite — every
#     RHS sees the OLD row, incl. the `ELSE subagent_status` in the CASE);
#   * idempotent: re-running the same checkpoint yields the same row state.
#   * `inner_result_file` keeps the readfile()-CAST-AS-TEXT indirection so the
#     JSON's own quotes can never break the sqlite argument, and keeps the
#     COLUMN-CONSISTENCY guard: subagent_status flips to 'completed' ONLY when
#     the SAME readfile() yields non-empty text (a missing/empty temp file
#     leaves inner_result NULL and subagent_status untouched).
#
# Values are SQL-escaped (' → '') — strictly safer than the raw interpolation
# it replaces; the values that actually occur (uuids, slugs, enum names,
# /tmp paths) contain no quotes, so emitted SQL is unchanged for them.
set -euo pipefail

usage="usage: checkpoint.sh <db> <run-id> <field> <value> [<field> <value> ...]"
db="${1:?$usage}"
run="${2:?$usage}"
shift 2

if [ "$#" -eq 0 ]; then
  echo "checkpoint.sh: no fields given — $usage" >&2
  exit 2
fi

# Escape a value for inclusion inside a single-quoted SQL string literal
# (' → ''). Uses a variable for the quote char — macOS bash 3.2 treats quote
# characters embedded in a ${var//pat/rep} replacement as LITERAL text.
sql_quote() {
  local s="$1"
  local q="'"
  printf '%s' "${s//$q/$q$q}"
}

sets=()
while [ "$#" -gt 0 ]; do
  field="$1"
  if [ "$#" -lt 2 ]; then
    echo "checkpoint.sh: missing value for field '$field'" >&2
    exit 2
  fi
  value="$2"
  shift 2
  case "$field" in
    pr)
      case "$value" in
        '' | *[!0-9]*)
          echo "checkpoint.sh: pr must be a non-negative integer, got '$value'" >&2
          exit 2
          ;;
      esac
      sets+=("pr=$value")
      ;;
    branch | inner_checkpoint | subagent_status | inner_verdict)
      sets+=("$field='$(sql_quote "$value")'")
      ;;
    inner_result_file)
      f="$(sql_quote "$value")"
      sets+=("inner_result=CAST(readfile('$f') AS TEXT)")
      sets+=("subagent_status=CASE WHEN length(CAST(readfile('$f') AS TEXT)) > 0 THEN 'completed' ELSE subagent_status END")
      ;;
    *)
      echo "checkpoint.sh: unknown field '$field'" >&2
      exit 2
      ;;
  esac
done

# Both legacy inline UPDATEs unconditionally re-stamped last_advanced_at.
sets+=("last_advanced_at='$(date -u +%FT%TZ)'")

set_clause="$(printf '%s, ' "${sets[@]}")"
set_clause="${set_clause%, }"

# A TERMINAL ROW IS FROZEN — `AND phase NOT IN ('done','failed','stopped')`.
#
# Cancelling a build (`/code stop`, board X-cancel) writes the terminal phase but
# does NOT kill the detached workflow that was building it: the workflow keeps
# going and its next per-phase checkpoint would land `subagent_status='running'`
# plus a fresh `last_advanced_at` back onto the terminal row — re-creating exactly
# the stale "still running" claim `TridentRunStore.terminalTransition` retracts,
# and re-stamping the branch/timestamp of a finished run. Same predicate as the
# store's TERMINAL_PHASE_SQL (trident/store.ts) and `crashRunningByLauncher`'s
# guard, so the terminal chokepoint and this out-of-band writer agree.
#
# Nothing useful is dropped: `advanceTridentRun`'s `step()` no-ops on a terminal
# row (trident/orchestrator.ts), so no reader ever consults the values a
# post-terminal checkpoint would have written — including `inner_result`, which is
# only ever harvested from a non-terminal row.
#
# A skipped write is NOT an error (the checkpoint step must never fail the build),
# but it IS reported on stderr so a missing checkpoint or harvest signal is
# explainable rather than silent. busy_timeout is a per-connection PRAGMA: it MUST
# run in the SAME sqlite3 invocation as the UPDATE (';'-separated), not as a
# separate process — `tail -1` drops that PRAGMA's own "5000" echo and keeps only
# `changes()`. Errors still reach stderr and fail the script (set -e + pipefail).
changed="$(sqlite3 "$db" "PRAGMA busy_timeout=5000; UPDATE code_trident_runs SET $set_clause WHERE id='$(sql_quote "$run")' AND phase NOT IN ('done', 'failed', 'stopped'); SELECT changes()" | tail -1)"
if [ "$changed" = "0" ]; then
  echo "checkpoint.sh: run '$run' is already terminal (or gone) — checkpoint NOT applied" >&2
fi
