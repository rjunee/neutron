#!/usr/bin/env bash
#
# scripts/run-tests.sh — the one documented command that runs the ENTIRE real
# source test suite to completion with BOUNDED MEMORY.
#
# WHY THIS EXISTS
# ---------------
# `bun test` loads ALL discovered test files into ONE long-lived process —
# file-level parallelism is intra-process via the JS event loop (--max-concurrency),
# NOT separate OS processes (verified; see
# docs/research/bun-test-parallel-load-flakiness-2026-05-19.md root cause #3).
# The suite has grown from 432 files / 4943 tests (May 2026) to ~859 files /
# ~8180 tests, so that single process's peak RSS (measured ~1.2 GB and climbing
# on a dev box) OOMs the contended 30 GB production deploy box (ISSUES #78 /
# the 25GB-of-30GB observation). Raising RAM is not the fix; the single-process
# model is the architectural flaw.
#
# This runner PARTITIONS the suite into chunks and runs each chunk in its own
# FRESH, short-lived `bun test` process. Peak RSS is therefore bounded to a
# single chunk's working set and freed when that process exits, before the next
# chunk starts (sequential default). 100% coverage is preserved and AUDITED:
# every discovered file runs exactly once and the discovered set is cross-checked
# against bun's own discovery count — a mismatch is a FATAL error, never silent
# truncation. This is partitioning-for-bounded-memory, NOT sharding-to-skip.
#
# Bun 1.3.9 already excludes node_modules and dot-directories (.claude/worktrees
# trident/forge clones, .git) from discovery, so those ~6810 clone test files
# are NOT swept in — confirmed by `bun test` reporting "across 859 files" at the
# repo root. We mirror those exclusions when building the partition list and the
# cross-check makes any drift fatal.
#
# USAGE
#   scripts/run-tests.sh                 # run the whole suite, bounded memory
#
# ENV
#   NEUTRON_TEST_CHUNK_SIZE   files per bun process       (default 100)
#   NEUTRON_TEST_CONCURRENCY  --max-concurrency / process (default physical cores)
#   NEUTRON_TEST_TIMEOUT      per-test timeout ms         (default 15000)
#   NEUTRON_TEST_JOBS         chunks to run concurrently  (default 1 = sequential,
#                             strictly bounded memory; raise on a quiet dev box
#                             for speed at the cost of higher peak RSS = JOBS×chunk)
#   NEUTRON_BUN_BIN           bun binary                  (default: bun)
#
# EXIT
#   0  every discovered file ran and passed
#   1  one or more chunks had failing tests, OR a fatal coverage/discovery error
#
set -uo pipefail

# SCRIPT_DIR = where this script + its sibling libs live (used to source the
# shared discovery helper). ROOT = the checkout under test (cwd for discovery +
# bun); defaults to this script's repo, NEUTRON_TEST_ROOT overrides it (CI / for
# validating the script against another checkout).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${NEUTRON_TEST_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$ROOT"

CHUNK_SIZE="${NEUTRON_TEST_CHUNK_SIZE:-100}"
CONCURRENCY="${NEUTRON_TEST_CONCURRENCY:-$(sysctl -n hw.physicalcpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"
TIMEOUT="${NEUTRON_TEST_TIMEOUT:-15000}"
JOBS="${NEUTRON_TEST_JOBS:-1}"
BUN="${NEUTRON_BUN_BIN:-bun}"

# --- 1. Discover the canonical real-source test set --------------------------
# Shared with the deploy gate so the two can never drift (the dot-dir exclusion
# that keeps .claude/worktrees clones out lives in ONE place).
# shellcheck source=scripts/lib/discover-test-files.sh
. "${SCRIPT_DIR}/lib/discover-test-files.sh"

FILES=()
while IFS= read -r f; do
  [ -n "$f" ] && FILES+=("$f")
done < <(neutron_discover_test_files)
TOTAL="${#FILES[@]}"

if [ "$TOTAL" -eq 0 ]; then
  echo "run-tests: FATAL — discovered 0 test files (cwd=$ROOT)" >&2
  exit 1
fi

# --- 2. Cross-check coverage against bun's OWN discovery ----------------------
# Run bun with an impossible test-name filter: it walks + loads every file it
# would run, executes ~no test bodies, and prints "Ran N tests across M files".
# M is bun's authoritative discovered-file count. If our find list != M we would
# either skip files bun runs (coverage hole) or run files bun ignores — both are
# fatal. This is the no-silent-truncation guarantee.
# `grep -a` (treat input as text): bun's output embeds control/NUL bytes from
# gateway boot logs, sd_notify, and spawned subprocesses. Without -a, grep
# classifies the stream as *binary* and emits ZERO matches, so the count silently
# parses as empty → the coverage audit fires a false "coverage hole" FATAL on a
# 100%-coverage run. LC_ALL=C makes -a portable across BSD/GNU/ugrep.
BUN_DISC="$(NO_COLOR=1 "$BUN" test -t '__neutron_runtests_no_match__' 2>&1 \
  | LC_ALL=C grep -aoE 'across [0-9]+ file' | LC_ALL=C grep -aoE '[0-9]+' | tail -1)"
if [ -n "$BUN_DISC" ] && [ "$BUN_DISC" != "$TOTAL" ]; then
  echo "run-tests: FATAL coverage drift — find discovered ${TOTAL} files but bun" >&2
  echo "  discovers ${BUN_DISC}. The partition list would not match the real suite." >&2
  echo "  A new test-file pattern probably needs adding to discover() in this script." >&2
  exit 1
fi

# --- 3. Partition + run -------------------------------------------------------
NCHUNKS=$(( (TOTAL + CHUNK_SIZE - 1) / CHUNK_SIZE ))
echo "run-tests: ${TOTAL} test files (bun-discovered: ${BUN_DISC:-n/a}) → ${NCHUNKS} chunks of <=${CHUNK_SIZE}"
echo "run-tests: bun=${BUN} max-concurrency=${CONCURRENCY} timeout=${TIMEOUT}ms jobs=${JOBS}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/neutron-runtests-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

run_chunk() {
  local idx="$1"
  local start=$(( idx * CHUNK_SIZE ))
  local chunk=( "${FILES[@]:start:CHUNK_SIZE}" )
  local clog; clog="$WORK/chunk-$(printf '%03d' "$idx").log"
  {
    echo "==== chunk $((idx+1))/${NCHUNKS}: ${#chunk[@]} files (index ${start}..$((start+${#chunk[@]}-1))) ===="
    NO_COLOR=1 "$BUN" test "${chunk[@]}" --timeout="$TIMEOUT" --max-concurrency="$CONCURRENCY" 2>&1
  } >"$clog" 2>&1
  local rc=$?
  # grep -a: chunk logs contain control/NUL bytes (gateway boot, sd_notify,
  # subprocess output); without it grep treats the log as binary, returns 0
  # matches, ran defaults to 0, RAN_TOTAL undercounts, and the coverage audit
  # fires a FALSE "coverage hole" FATAL even though every file actually ran.
  local ran; ran="$(LC_ALL=C grep -aoE 'across [0-9]+ file' "$clog" | LC_ALL=C grep -aoE '[0-9]+' | tail -1)"
  echo "${idx} ${rc} ${#chunk[@]} ${ran:-0}" >> "$WORK/results"
  # Sequential mode: stream this chunk's output now (naturally in order) so the
  # run is observable live instead of buffered to the end.
  [ "$JOBS" -le 1 ] && cat "$clog"
}

idx=0
while [ "$idx" -lt "$NCHUNKS" ]; do
  if [ "$JOBS" -le 1 ]; then
    run_chunk "$idx"
  else
    run_chunk "$idx" &
    while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$JOBS" ]; do
      wait -n 2>/dev/null || sleep 0.2
    done
  fi
  idx=$((idx + 1))
done
wait

# Parallel mode buffered each chunk; emit them in chunk order now (the combined
# log humans read and the flake-tolerant deploy gate parses for failing files).
if [ "$JOBS" -gt 1 ]; then
  i=0
  while [ "$i" -lt "$NCHUNKS" ]; do
    cat "$WORK/chunk-$(printf '%03d' "$i").log"
    i=$((i + 1))
  done
fi

# --- 4. Aggregate + coverage audit -------------------------------------------
FAILED_CHUNKS=0
RAN_TOTAL=0
FAIL_LIST=""
while read -r r_idx r_rc r_nfiles r_ran; do
  RAN_TOTAL=$(( RAN_TOTAL + r_ran ))
  if [ "$r_rc" != "0" ]; then
    FAILED_CHUNKS=$(( FAILED_CHUNKS + 1 ))
    FAIL_LIST="${FAIL_LIST} $(( r_idx + 1 ))"
  fi
done < "$WORK/results"

echo "---- run-tests coverage audit ----"
echo "declared files: ${TOTAL}   bun-discovered: ${BUN_DISC:-n/a}   files executed across chunks: ${RAN_TOTAL}"
echo "chunks: ${NCHUNKS}   failed chunks: ${FAILED_CHUNKS}${FAIL_LIST:+ (chunk#${FAIL_LIST# })}"
if [ "$RAN_TOTAL" -lt "$TOTAL" ]; then
  echo "run-tests: FATAL — executed ${RAN_TOTAL} files < ${TOTAL} discovered (coverage hole)." >&2
  exit 1
fi
if [ "$FAILED_CHUNKS" -ne 0 ]; then
  echo "run-tests: FAIL — ${FAILED_CHUNKS}/${NCHUNKS} chunk(s) contained failing tests (see output above)."
  exit 1
fi
echo "run-tests: PASS — all ${TOTAL} files across ${NCHUNKS} bounded-memory chunks are green."
exit 0
