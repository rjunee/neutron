#!/usr/bin/env bash
# Shared retry vocabulary for the two out-of-process Trident SQLite writers.
# Source this file, then call sqlite_write_with_retry <db> <sql>.

sqlite_write_with_retry() {
  local db="$1" sql="$2" attempt=0 output status
  local max_attempts=120

  while :; do
    if output="$(printf '%s\n' "$sql" | sqlite3 -init /dev/null -bail -list -separator '|' "$db" 2>&1)"; then
      printf '%s' "$output"
      return 0
    else
      status=$?
    fi

    case "$output" in
      *'database is locked'*|*'database is busy'*|*'SQLITE_BUSY'*) ;;
      *)
        printf '%s\n' "$output" >&2
        return "$status"
        ;;
    esac

    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      printf 'SQLITE_BUSY: retry budget exhausted after %s attempts: %s\n' "$attempt" "$output" >&2
      return 75
    fi
    sleep 0.15
  done
}
