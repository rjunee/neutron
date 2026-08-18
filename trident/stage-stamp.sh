#!/usr/bin/env bash
# =============================================================================
# trident/stage-stamp.sh — durable append-only pre-build stage stamps
# =============================================================================
# Usage: stage-stamp.sh <db> <run-id> <stage> [<meta>]
#
# CONTRACT DIFFERENCE FROM checkpoint.sh: this script ALWAYS exits 0. It rides
# inline in load-bearing launch/build command chains, so a missing database or
# table, a lock timeout, bad arguments, or any other stamp failure must never
# change whether a build launches or how its wrapper exits.

usage="usage: stage-stamp.sh <db> <run-id> <stage> [<meta>]"
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "stage-stamp.sh: $usage" >&2
  exit 0
fi

db="$1"
run="$2"
stage="$3"
meta="${4:-}"

# Escape a value for inclusion inside a single-quoted SQL string literal
# (' -> ''). Uses a variable for the quote char because macOS bash 3.2 treats
# quote characters embedded in a ${var//pat/rep} replacement as literal text.
sql_quote() {
  local s="$1"
  local q="'"
  printf '%s' "${s//$q/$q$q}"
}

# GNU date provides milliseconds. BSD/macOS date echoes %3N literally, so use
# checkpoint.sh's exact validation and whole-second ISO-8601 UTC fallback.
now_iso="$(date -u +%FT%T.%3NZ 2>/dev/null || true)"
case "$now_iso" in
  *[0-9].[0-9][0-9][0-9]Z) : ;;
  *) now_iso="$(date -u +%FT%TZ)" ;;
esac

quoted_run="$(sql_quote "$run")"
quoted_stage="$(sql_quote "$stage")"
if [ -n "$meta" ]; then
  meta_sql="'$(sql_quote "$meta")'"
else
  meta_sql="NULL"
fi

# busy_timeout is per connection, so the PRAGMA and INSERT intentionally share
# this sqlite3 invocation. Pin an empty init file so user sqlite configuration
# cannot redirect output or alter execution.
if ! sqlite_output="$(sqlite3 -init /dev/null "$db" "PRAGMA busy_timeout=5000; INSERT INTO code_trident_stage_events (run_id, stage, at, meta) VALUES ('$quoted_run', '$quoted_stage', '$now_iso', $meta_sql);" 2>&1)"; then
  echo "stage-stamp.sh: stamp not recorded${sqlite_output:+: $sqlite_output}" >&2
fi

exit 0
