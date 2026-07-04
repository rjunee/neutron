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
# PGLITE-WASM QUARANTINE LANE (ISSUES #79 / #327)
# ----------------------------------------------
# A handful of test files boot a REAL Postgres-in-WASM (`@electric-sql/pglite`)
# + ~100 migrations. That first big WASM compile is the suite's single most
# expensive + flakiest step: under a contended box it intermittently fails
# `PGLite failed to initialize its WASM runtime` (#327) or races the boot probe
# (#79). Mixed into a general chunk it (a) inflates that chunk's peak RSS by
# tens of MB of WASM and (b) randomly reds an otherwise-green chunk.
#
# So these files run in their OWN dedicated lane, AFTER the general chunks, with:
#   - serial intra-lane execution (--max-concurrency=1) so two brains never
#     compile WASM at the same instant (the #79 boot race), and
#   - a bounded RETRY budget: a transient lane failure re-runs the WHOLE lane a
#     few times before the run is declared failed (the `withTransientBootRetry`
#     classifier inside boot-pglite-brain.ts self-heals most boots; this lane
#     retry is the belt-and-braces for the rest).
# The lane membership is content-derived (any test file that mentions `pglite`),
# so a new PGLite test is quarantined automatically — no allowlist to maintain.
# Coverage is unchanged: lane files are still counted in the audit (RAN_TOTAL).
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
#   --- PGLite quarantine lane ---
#   NEUTRON_TEST_PGLITE_RETRIES      lane re-runs on transient failure (default 2)
#   NEUTRON_TEST_PGLITE_CONCURRENCY  --max-concurrency for the lane     (default 1)
#   NEUTRON_TEST_PGLITE_TIMEOUT      per-test timeout ms for the lane   (default 90000,
#                                    the real-WASM boots use 60s timeouts internally)
#   NEUTRON_TEST_NO_PGLITE_LANE      set =1 to fold PGLite files back into general
#                                    chunks (the pre-quarantine behaviour)
#
# TUNING RECIPES (peak RSS ≈ JOBS × CHUNK_SIZE × per-file working set)
#   Contended 30 GB deploy box / CI (bounded memory is the priority):
#       NEUTRON_TEST_CHUNK_SIZE=60 NEUTRON_TEST_JOBS=1 bash scripts/run-tests.sh
#     Smaller chunks ⇒ lower per-chunk peak RSS; sequential ⇒ only one chunk's
#     RSS live at a time. This is the safest profile (and the CI default intent).
#   Quiet dev box / lots of free RAM (wall-clock is the priority):
#       NEUTRON_TEST_JOBS=4 NEUTRON_TEST_CHUNK_SIZE=100 bash scripts/run-tests.sh
#     Runs 4 chunks at once — ~Nx faster, but holds ~4 chunks' RSS concurrently,
#     so only do this with headroom. Drop JOBS first if the box starts swapping.
#   Single chunk still spiking? Lower intra-chunk parallelism:
#       NEUTRON_TEST_CONCURRENCY=2 bash scripts/run-tests.sh
#   See docs/testing-runner.md for the full matrix + rationale.
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
# PGLite-WASM quarantine lane (see header). Defaults: serial, generous timeout,
# 2 retries. NEUTRON_TEST_NO_PGLITE_LANE=1 disables the lane entirely.
PGLITE_RETRIES="${NEUTRON_TEST_PGLITE_RETRIES:-2}"
PGLITE_CONCURRENCY="${NEUTRON_TEST_PGLITE_CONCURRENCY:-1}"
PGLITE_TIMEOUT="${NEUTRON_TEST_PGLITE_TIMEOUT:-90000}"
NO_PGLITE_LANE="${NEUTRON_TEST_NO_PGLITE_LANE:-0}"

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
# An EMPTY BUN_DISC means bun's discovery probe printed no parseable "across N
# files" count — either bun failed to run or its summary format changed. The old
# `[ -n "$BUN_DISC" ] && …` guard treated that as a reason to SILENTLY SKIP the
# cross-check, so a broken discovery would let the partition list diverge from
# the real suite unnoticed — the exact silent-truncation this audit exists to
# forbid. So an empty probe is now LOUD by default: fatal, refusing to run blind.
# (NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC=1 downgrades it to a loud, non-silent WARNING
# — a documented, opt-in escape hatch for a future bun whose summary format drifts,
# never a silent default.)
if [ -z "$BUN_DISC" ]; then
  if [ "${NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC:-0}" = "1" ]; then
    echo "run-tests: WARNING — bun's discovery probe returned no 'across N files' count;" >&2
    echo "  the coverage cross-check is DISABLED for this run (NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC=1)." >&2
    echo "  A broken discovery could let the partition list silently diverge from the real suite." >&2
  else
    echo "run-tests: FATAL — bun's discovery probe returned no 'across N files' count." >&2
    echo "  Cannot cross-check the partition list against the real suite, so 100% coverage" >&2
    echo "  cannot be guaranteed and the run refuses to proceed blind. (bun failed to run, or" >&2
    echo "  its summary format changed — set NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC=1 to override.)" >&2
    exit 1
  fi
elif [ "$BUN_DISC" != "$TOTAL" ]; then
  echo "run-tests: FATAL coverage drift — find discovered ${TOTAL} files but bun" >&2
  echo "  discovers ${BUN_DISC}. The partition list would not match the real suite." >&2
  echo "  A new test-file pattern probably needs adding to discover() in this script." >&2
  exit 1
fi

# --- 2b. Split out the PGLite-WASM quarantine lane ---------------------------
# Membership is content-derived (any test file that mentions `pglite`), so a new
# PGLite test is quarantined automatically. The general chunks run everything
# else; the lane runs last, serially, with its own retry budget (see header).
PGLITE_FILES=()
GENERAL_FILES=()
if [ "$NO_PGLITE_LANE" = "1" ]; then
  GENERAL_FILES=( "${FILES[@]}" )
else
  # One batched grep over the discovered set (well under ARG_MAX for ~800 files).
  # `|| true` so a zero-match grep (exit 1) doesn't trip `set -o pipefail`/`-e`.
  PGLITE_MATCH="$(LC_ALL=C grep -lEi 'pglite' "${FILES[@]}" 2>/dev/null || true)"
  for f in "${FILES[@]}"; do
    case $'\n'"${PGLITE_MATCH}"$'\n' in
      *$'\n'"$f"$'\n'*) PGLITE_FILES+=("$f") ;;
      *)                GENERAL_FILES+=("$f") ;;
    esac
  done
fi
NPGLITE=${#PGLITE_FILES[@]}
GEN_TOTAL=${#GENERAL_FILES[@]}

# --- 3. Partition + run -------------------------------------------------------
NCHUNKS=$(( (GEN_TOTAL + CHUNK_SIZE - 1) / CHUNK_SIZE ))
echo "run-tests: ${TOTAL} test files (bun-discovered: ${BUN_DISC:-n/a}) → ${NCHUNKS} general chunks of <=${CHUNK_SIZE} + ${NPGLITE}-file PGLite lane"
echo "run-tests: bun=${BUN} max-concurrency=${CONCURRENCY} timeout=${TIMEOUT}ms jobs=${JOBS}"
if [ "$NPGLITE" -gt 0 ]; then
  echo "run-tests: PGLite lane → ${NPGLITE} files, serial=${PGLITE_CONCURRENCY}, timeout=${PGLITE_TIMEOUT}ms, retries=${PGLITE_RETRIES}"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/neutron-runtests-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

run_chunk() {
  local idx="$1"
  local start=$(( idx * CHUNK_SIZE ))
  local chunk=( "${GENERAL_FILES[@]:start:CHUNK_SIZE}" )
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

# Run the PGLite-WASM files in their own serial lane with a bounded retry budget.
# A transient lane failure (the #79 boot race / #327 WASM-init flake) re-runs the
# WHOLE lane up to PGLITE_RETRIES extra times before the run is declared failed.
# Lane files are still counted in the coverage audit (RAN_TOTAL).
run_pglite_lane() {
  local llog="$WORK/lane-pglite.log"
  local attempt=1 max=$(( PGLITE_RETRIES + 1 )) rc=1 ran=0
  while [ "$attempt" -le "$max" ]; do
    {
      echo "==== PGLite quarantine lane: ${NPGLITE} files (attempt ${attempt}/${max}, max-concurrency=${PGLITE_CONCURRENCY}, timeout=${PGLITE_TIMEOUT}ms) ===="
      NO_COLOR=1 "$BUN" test "${PGLITE_FILES[@]}" --timeout="$PGLITE_TIMEOUT" --max-concurrency="$PGLITE_CONCURRENCY" 2>&1
    } >"$llog" 2>&1
    rc=$?
    ran="$(LC_ALL=C grep -aoE 'across [0-9]+ file' "$llog" | LC_ALL=C grep -aoE '[0-9]+' | tail -1)"
    cat "$llog"
    [ "$rc" = "0" ] && break
    if [ "$attempt" -lt "$max" ]; then
      echo "run-tests: PGLite lane attempt ${attempt}/${max} failed (rc=${rc}) — retrying (transient WASM-init/boot flake, ISSUES #79/#327)…"
    fi
    attempt=$(( attempt + 1 ))
  done
  # Sentinel idx 'pglite'; ran falls back to NPGLITE so the coverage audit still
  # accounts for the lane files if bun's count line was eaten by log noise.
  echo "pglite ${rc} ${NPGLITE} ${ran:-$NPGLITE}" >> "$WORK/results"
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

# PGLite lane runs AFTER the general chunks (and after their buffered emit), in
# its own process with serial intra-lane concurrency + retry — never mixed into a
# general chunk's RSS or parallelism.
if [ "$NPGLITE" -gt 0 ]; then
  run_pglite_lane
fi

# --- 4. Aggregate + coverage audit -------------------------------------------
FAILED_CHUNKS=0
RAN_TOTAL=0
FAIL_LIST=""
while read -r r_idx r_rc r_nfiles r_ran; do
  RAN_TOTAL=$(( RAN_TOTAL + r_ran ))
  if [ "$r_rc" != "0" ]; then
    FAILED_CHUNKS=$(( FAILED_CHUNKS + 1 ))
    if [ "$r_idx" = "pglite" ]; then
      FAIL_LIST="${FAIL_LIST} PGLite-lane"
    else
      FAIL_LIST="${FAIL_LIST} $(( r_idx + 1 ))"
    fi
  fi
done < "$WORK/results"

LANES=$NCHUNKS
LANE_DESC="${NCHUNKS} general chunks"
if [ "$NPGLITE" -gt 0 ]; then
  LANES=$(( NCHUNKS + 1 ))
  LANE_DESC="${LANE_DESC} + PGLite lane"
fi

echo "---- run-tests coverage audit ----"
echo "declared files: ${TOTAL}   bun-discovered: ${BUN_DISC:-n/a}   files executed: ${RAN_TOTAL} (${GEN_TOTAL} general + ${NPGLITE} PGLite)"
echo "lanes: ${LANE_DESC}   failed: ${FAILED_CHUNKS}${FAIL_LIST:+ (${FAIL_LIST# })}"
if [ "$RAN_TOTAL" -lt "$TOTAL" ]; then
  echo "run-tests: FATAL — executed ${RAN_TOTAL} files < ${TOTAL} discovered (coverage hole)." >&2
  exit 1
fi
if [ "$FAILED_CHUNKS" -ne 0 ]; then
  echo "run-tests: FAIL — ${FAILED_CHUNKS}/${LANES} lane(s) contained failing tests (see output above)."
  exit 1
fi
echo "run-tests: PASS — all ${TOTAL} files across ${LANES} bounded-memory lane(s) are green."
exit 0
