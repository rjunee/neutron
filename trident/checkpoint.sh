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
#   inner_checkpoint_head <str>
#                            → inner_checkpoint_head='<str>'
#   inner_findings_file <path>
#                            → inner_checkpoint_findings=CAST(readfile('<path>')
#                                                             AS TEXT)
#   subagent_status <str>    → subagent_status='<str>'          (LIVENESS: frozen)
#   inner_verdict <str>      → inner_verdict='<str>'
#   inner_result_file <path> → inner_result=CAST(readfile('<path>') AS TEXT),
#                              subagent_status=CASE WHEN
#                                length(CAST(readfile('<path>') AS TEXT)) > 0
#                                THEN 'completed' ELSE subagent_status END
#                                                               (LIVENESS: frozen)
#
# Every value above is wrapped in `frozen()` when it targets one of the two
# LIVENESS columns — see the block above the field loop for what that means.
#
# `last_advanced_at='<now UTC, %FT%TZ>'` is ALWAYS appended — both legacy
# inline call sites unconditionally stamped it via `$(date -u +%FT%TZ)`; the
# script computes it so the prompt carries no command substitution either. It
# and `subagent_status` are the LIVENESS pair, frozen on a terminal row.
#
# SEMANTICS ARE UNCHANGED from the inline SQL this replaces
# (trident/inner-workflow.mjs checkpoint()/writeTerminalResult()), EXCEPT that
# the two LIVENESS columns are frozen once the row reaches a terminal phase
# (see `frozen()` below):
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

# A TERMINAL ROW'S LIVENESS COLUMNS ARE FROZEN — and ONLY those two.
#
# Cancelling a build (`/code stop`, board X-cancel) writes the terminal phase but
# does NOT kill the detached workflow that was building it (rjunee/neutron#177):
# the workflow keeps going and its next per-phase checkpoint would land
# `subagent_status='running'` plus a fresh `last_advanced_at` back onto the
# terminal row — re-creating exactly the stale "still running" claim
# `TridentRunStore.terminalTransition` retracts, and re-stamping the heartbeat of a
# finished run. Terminal-set literal identical to the store's TERMINAL_PHASE_SQL
# (trident/store.ts) and `state-machine.ts` TERMINAL_PHASES — pinned against them
# by trident/inner-workflow.test.ts, since this is a fourth copy of that set.
#
# The freeze is SCOPED, not a blanket refusal of the whole write, because the
# orphan's `branch`/`pr`/`inner_checkpoint`/`inner_result`/`inner_verdict` are the
# only trail back to work it did AFTER the cancel — a PR it opened, a branch it
# pushed. Dropping those would leave an untraceable orphan PR and no row pointing
# at it — on a FIRST launch this script is the ONLY writer of either: the launch
# persist carries `branch`/`pr` forward but cannot invent them (a fresh run has
# `branch = null`, and `detectExistingPr` probes `trident/<slug>`, which does not
# exist yet — trident/orchestrator.ts `launch`). Which matters precisely BECAUSE
# #177 leaves the workflow alive. They are inert on a terminal
# row — `advanceTridentRun`'s `step()` no-ops on it (trident/orchestrator.ts), so
# nothing resumes from a checkpoint or harvests a result — but they stay readable,
# and `run-progress.ts` surfaces `pr` to the board. A cancelled row carrying a
# stale parseable `inner_result` is already an ANTICIPATED state, not a new one:
# `isTridentHarvestTerminal` keys on the durable `harvested_at` marker, which
# `terminalTransition` never sets, precisely so such a row emits no handoff
# (trident/orchestrator.ts, RC2).
#
# `frozen <column> <new-value-sql>` → the new value on an active row, the OLD
# value on a terminal one.
terminal_phases="('done', 'failed', 'stopped')"
frozen() {
  printf 'CASE WHEN phase IN %s THEN %s ELSE %s END' "$terminal_phases" "$1" "$2"
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
    subagent_status)
      # LIVENESS — frozen on a terminal row.
      sets+=("subagent_status=$(frozen subagent_status "'$(sql_quote "$value")'")")
      ;;
    branch | inner_checkpoint | inner_verdict | inner_checkpoint_head)
      # `inner_checkpoint_head` is the branch head OID the checkpoint APPLIES TO,
      # and the workflow writes it in the SAME invocation as `inner_checkpoint`
      # so the name and the commit can never drift apart. An EMPTY value is a
      # legitimate write, not a no-op: it CLEARS a previous checkpoint's OID so a
      # phase that could not report a sha never inherits the last one's.
      sets+=("$field='$(sql_quote "$value")'")
      ;;
    inner_findings_file)
      # The synthesised findings the checkpoint was recorded with, loaded through
      # the same readfile()-CAST-AS-TEXT indirection `inner_result_file` uses so
      # the JSON's own quotes can never break the sqlite argument. A missing file
      # makes readfile() yield NULL → no recorded findings → a resume re-reviews
      # rather than fixing blind. NOT a liveness column: no freeze, and no
      # `subagent_status` side effect (a mid-run checkpoint is not a result).
      sets+=("inner_checkpoint_findings=CAST(readfile('$(sql_quote "$value")') AS TEXT)")
      ;;
    inner_result_file)
      f="$(sql_quote "$value")"
      sets+=("inner_result=CAST(readfile('$f') AS TEXT)")
      # Two guards, outermost first: the terminal freeze, then the original
      # column-consistency CASE (flip to 'completed' ONLY when the SAME readfile()
      # yields non-empty text).
      sets+=("subagent_status=CASE WHEN phase IN $terminal_phases THEN subagent_status WHEN length(CAST(readfile('$f') AS TEXT)) > 0 THEN 'completed' ELSE subagent_status END")
      ;;
    *)
      echo "checkpoint.sh: unknown field '$field'" >&2
      exit 2
      ;;
  esac
done

# Both legacy inline UPDATEs unconditionally re-stamped last_advanced_at. It is
# the hang watchdog's heartbeat, so it is LIVENESS — frozen on a terminal row.
sets+=("last_advanced_at=$(frozen last_advanced_at "'$(date -u +%FT%TZ)'")")

set_clause="$(printf '%s, ' "${sets[@]}")"
set_clause="${set_clause%, }"

quoted_run="$(sql_quote "$run")"

# A frozen or missing write is NOT an error (the checkpoint step must never fail
# the build), but it IS reported on stderr so a missing liveness update — or a
# checkpoint against a run that no longer exists — is explainable rather than
# silent. `changes()` cannot distinguish the two here: the freeze lives in the SET
# expressions, not the WHERE clause, so a terminal row still matches and reports
# 1 change. Hence the second column, which re-reads the row's phase.
#
# The phase re-read is a SEPARATE statement from the UPDATE with no
# `BEGIN IMMEDIATE` around the pair, so a `terminalTransition` landing in between can
# make this print FROZEN for a checkpoint that actually applied. Left as-is
# deliberately: the two branches are stderr diagnostics only — the UPDATE itself is a
# single atomic statement whose outcome does not depend on this SELECT — and wrapping
# them would take a write lock for the whole read on the hot checkpoint path.
#
# busy_timeout is a per-connection PRAGMA: it MUST run in the SAME sqlite3
# invocation as the UPDATE (';'-separated), not as a separate process — `tail -1`
# drops that PRAGMA's own "5000" echo and keeps only the final SELECT. Errors
# still reach stderr and fail the script (set -e + pipefail).
#
# `-init /dev/null -list -separator '|'` pins the OUTPUT FORMAT the `case` below
# parses: an rc file setting `.mode`/`.separator`/`.output` makes both branches fall
# through silently, so a frozen or missing write would stop being reported on the one
# host where someone customised their CLI. Environment hardening, NOT a fix for a
# reproduced bug, and the difference is worth recording: on the sqlite3 this was
# measured against (3.43.2, Apple) an rc file changes the format when passed as
# `-init <file>`, but a `HOME` override does not make the CLI pick one up — so the
# failure is unreachable there and untestable without writing to a real home dir
# (see the note in trident/checkpoint-sh.test.ts). Other builds do read it.
outcome="$(sqlite3 -init /dev/null -list -separator '|' "$db" "PRAGMA busy_timeout=5000; UPDATE code_trident_runs SET $set_clause WHERE id='$quoted_run'; SELECT changes(), COALESCE((SELECT CASE WHEN phase IN $terminal_phases THEN 'terminal' ELSE 'active' END FROM code_trident_runs WHERE id='$quoted_run'), 'gone')" | tail -1)"
case "$outcome" in
  0'|'*)
    echo "checkpoint.sh: run '$run' not found — checkpoint NOT applied" >&2
    ;;
  *'|terminal')
    echo "checkpoint.sh: run '$run' is already terminal — liveness (subagent_status, last_advanced_at) FROZEN; branch/pr/checkpoint/result still recorded" >&2
    ;;
esac
