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
# The suite keeps growing (this script's own startup line — "N test files
# (bun-discovered: M) -> ... chunks" — reports today's live count; don't
# hardcode a snapshot here, it will just rot), so that single process's peak
# RSS (measured >1 GB and climbing on a dev box) OOMs the contended 30 GB
# production deploy box (ISSUES #78 / the 25GB-of-30GB observation). Raising
# RAM is not the fix; the single-process model is the architectural flaw.
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
# trident/forge clones, .git) from discovery, so those clone test files are NOT
# swept in — confirmed by `bun test` reporting "across N files" at the repo
# root, a count that intentionally excludes them (compare against a plain `find`
# with no dot-dir exclusion to see the gap). We mirror those exclusions when
# building the partition list and the cross-check makes any drift fatal.
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
# DEVICE-HARNESS ISOLATION LANE
# -----------------------------
# The mobile device harness (`app/__tests__/support/native-harness.ts`) registers a
# happy-dom DOM and aliases `react-native` for the whole PROCESS. That cannot share
# a process with the rest of the suite, and the reasons are not fixable from the
# harness side:
#   - `landing`'s happy-dom tests call `GlobalRegistrator.register()` unconditionally
#     and it THROWS if a DOM is already registered, so whichever runs second fails;
#   - other app tests own the `react-native` specifier with process-global
#     `mock.module` fakes;
#   - a DOM registered by the harness cannot be unregistered again without breaking
#     the harness files still queued in that process.
# Mixed into a general chunk it produced 68 failures across three CI shards in
# unrelated packages. So harness files get their OWN process, exactly like the
# PGLite lane. Membership is content-derived (any test file mentioning
# `installNativeHarness`), so a new harness suite is isolated automatically.
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
#   NEUTRON_TEST_SHARD        "<i>/<n>" — run only this shard's slice of the
#                             discovered set (default: unset = run everything).
#                             CROSS-RUNNER sharding, distinct from JOBS above
#                             (which is intra-machine). Discovery and the bun
#                             cross-check still run over the FULL set on every
#                             shard; only the EXECUTION list is sliced, so a
#                             coverage drift is still caught by every shard.
#   NEUTRON_BUN_BIN           bun binary                  (default: bun)
#   --- PGLite quarantine lane ---
#   NEUTRON_TEST_PGLITE_RETRIES      lane re-runs on transient failure (default 2)
#   NEUTRON_TEST_PGLITE_CONCURRENCY  --max-concurrency for the lane     (default 1)
#   NEUTRON_TEST_PGLITE_TIMEOUT      per-test timeout ms for the lane   (default 90000,
#                                    the real-WASM boots use 60s timeouts internally)
#   NEUTRON_TEST_NO_PGLITE_LANE      set =1 to fold PGLite files back into general
#                                    chunks (the pre-quarantine behaviour)
#   --- device-harness isolation lane ---
#   NEUTRON_TEST_NO_DEVICE_LANE      set =1 to fold the mobile-harness files back
#                                    into general chunks. Expect cross-file DOM /
#                                    module-registry collisions if you do.
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
SHARD_SPEC="${NEUTRON_TEST_SHARD:-}"
# Cost model for the general-lane shard split (§2c). Milliseconds, and only the
# RATIO between them matters — see "THE WEIGHTS ARE AN ESTIMATE" there. MIG_COST_MS
# is the measured cost of one `applyMigrations` replay of the whole tree; the base
# stands in for per-file import and setup. Not configurable by env on purpose: the
# weights must be identical on every shard runner or the partition breaks, and an
# env knob is the easiest way to make one runner disagree with the others.
BASE_COST_MS=150
MIG_COST_MS=137
SHARD_WEIGHT_LOG=""
# Validate the shard spec IMMEDIATELY, before the ~15s of discovery below. A bad
# spec is a configuration error, and the cost of getting it wrong is severe: a
# spec silently treated as "no files" would be a green run that tested nothing.
# Failing in milliseconds also keeps the partition test suite cheap.
if [ -n "$SHARD_SPEC" ]; then
  # Must literally contain a "/". Without this check `NEUTRON_TEST_SHARD=4`
  # parses as i=4,n=4 via the two suffix/prefix expansions and silently runs a
  # QUARTER of the suite while looking like a valid request.
  case "$SHARD_SPEC" in
    */*) ;;
    *) echo "run-tests: FATAL — NEUTRON_TEST_SHARD '$SHARD_SPEC' must be <i>/<n> (a bare number would silently run one shard)" >&2; exit 1 ;;
  esac
  SHARD_I="${SHARD_SPEC%%/*}"
  SHARD_N="${SHARD_SPEC##*/}"
  case "$SHARD_I" in ''|*[!0-9]*) echo "run-tests: FATAL — bad NEUTRON_TEST_SHARD '$SHARD_SPEC' (want <i>/<n>)" >&2; exit 1 ;; esac
  case "$SHARD_N" in ''|*[!0-9]*) echo "run-tests: FATAL — bad NEUTRON_TEST_SHARD '$SHARD_SPEC' (want <i>/<n>)" >&2; exit 1 ;; esac
  if [ "$SHARD_N" -lt 1 ] || [ "$SHARD_I" -lt 1 ] || [ "$SHARD_I" -gt "$SHARD_N" ]; then
    echo "run-tests: FATAL — NEUTRON_TEST_SHARD '$SHARD_SPEC' out of range (need 1 <= i <= n, n >= 1)" >&2
    exit 1
  fi
fi
BUN="${NEUTRON_BUN_BIN:-bun}"
# PGLite-WASM quarantine lane (see header). Defaults: serial, generous timeout,
# 2 retries. NEUTRON_TEST_NO_PGLITE_LANE=1 disables the lane entirely.
PGLITE_RETRIES="${NEUTRON_TEST_PGLITE_RETRIES:-2}"
PGLITE_CONCURRENCY="${NEUTRON_TEST_PGLITE_CONCURRENCY:-1}"
PGLITE_TIMEOUT="${NEUTRON_TEST_PGLITE_TIMEOUT:-90000}"
NO_PGLITE_LANE="${NEUTRON_TEST_NO_PGLITE_LANE:-0}"
# Device-harness isolation lane (see header). Its own process; normal timeout.
NO_DEVICE_LANE="${NEUTRON_TEST_NO_DEVICE_LANE:-0}"

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
# PLAN-ONLY skips this block. It is the expensive step (bun WALKS AND LOADS every
# test file), and the shard-partition tests invoke the planner ~25 times — paying
# it each time would make that suite slower than the suite it guards. Skipping is
# safe because the cross-check validates FILES/TOTAL, the FULL discovered set,
# which sharding never touches; a real run always pays it. The ordering property
# (slice happens AFTER this check, so every shard still validates the whole set)
# is pinned structurally in scripts/__tests__/run-tests-shard.test.ts.
if [ "${NEUTRON_TEST_PLAN_ONLY:-0}" != "1" ]; then
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
fi


# --- 2b. Split out the PGLite-WASM quarantine lane ---------------------------
# Membership is content-derived (any test file that mentions `pglite`), so a new
# PGLite test is quarantined automatically. The general chunks run everything
# else; the lane runs last, serially, with its own retry budget (see header).
PGLITE_FILES=()
DEVICE_FILES=()
GENERAL_FILES=()
# One batched grep per lane over the discovered set (well under ARG_MAX for ~1100
# files). `|| true` so a zero-match grep (exit 1) doesn't trip `set -o pipefail`/`-e`.
PGLITE_MATCH=""
DEVICE_MATCH=""
if [ "$NO_PGLITE_LANE" != "1" ]; then
  PGLITE_MATCH="$(LC_ALL=C grep -lEi 'pglite' "${FILES[@]}" 2>/dev/null || true)"
fi
if [ "$NO_DEVICE_LANE" != "1" ]; then
  DEVICE_MATCH="$(LC_ALL=C grep -lE 'installNativeHarness' "${FILES[@]}" 2>/dev/null || true)"
fi
for f in "${FILES[@]}"; do
  # PGLite wins a tie: a hypothetical file in both would need the WASM lane's
  # serial execution + retry budget more than it needs DOM isolation.
  case $'\n'"${PGLITE_MATCH}"$'\n' in
    *$'\n'"$f"$'\n'*) PGLITE_FILES+=("$f") ; continue ;;
  esac
  case $'\n'"${DEVICE_MATCH}"$'\n' in
    *$'\n'"$f"$'\n'*) DEVICE_FILES+=("$f") ; continue ;;
  esac
  GENERAL_FILES+=("$f")
done

# --- 2c. Cross-runner shard slice (NEUTRON_TEST_SHARD="<i>/<n>") --------------
# Deliberately placed AFTER discovery, the bun coverage cross-check, and the
# lane split. Every shard therefore still verifies the FULL discovered set
# against bun's own walk — a shard is a slice of what gets EXECUTED, never a
# slice of what gets VERIFIED. (Sharding earlier would have made each runner
# blind to a discovery drift affecting files it does not own.)
#
# The PGLite and device lanes are split round-robin by index, so each shard gets a
# proportional share of the slow PGLite files instead of one runner absorbing the
# entire serial lane. The GENERAL lane is split by ESTIMATED COST instead — see
# "WHY THE GENERAL LANE IS WEIGHTED" below.
#
# The round-robin cursor CARRIES ACROSS the two round-robin lanes rather than
# resetting to 0 for each one. That is load-bearing for balance, not a tidiness
# preference: a per-lane reset sends every lane's remainder to the SAME low-index
# shards, so `max - min` can exceed the partition guard's tolerance
# (scripts/__tests__/run-tests-shard.test.ts). It held on main by arithmetic luck
# and broke the first time a PR added three files. Carrying the cursor makes those
# lanes one continuous round-robin over a fixed concatenated order, so each is
# still spread proportionally. Gaps/overlap are unaffected — it is the same
# partition function, only phase-shifted per lane.
#
# WHY THE GENERAL LANE IS WEIGHTED AND NOT ROUND-ROBIN
# ---------------------------------------------------
# Round-robin balances FILE COUNT, which is only the right thing to balance if
# every file costs about the same. In this suite they do not, and the spread is
# not subtle: a fully-migrated project database is built by replaying the entire
# migration tree, measured at ~137 ms of CPU per call, and 334 test call sites do
# exactly that (`applyMigrations(db.raw())`). A file with thirty such tests costs
# multiple seconds; a file asserting a pure function costs milliseconds. Splitting
# those by count lets one runner draw a disproportionate share of the expensive
# ones, and because CI's wall-clock is the SLOWEST shard, that runner alone sets
# how long every PR waits.
#
# So the general lane is bin-packed by estimated cost: weights are assigned from
# file CONTENT, sorted heaviest-first, and each file goes to whichever shard is
# currently lightest (longest-processing-time-first, the standard greedy for this).
# Every shard runs the identical computation over the identical input, so all four
# reach the same assignment independently — the partition property is unchanged
# and still asserted directly.
#
# THE WEIGHTS ARE AN ESTIMATE, AND THAT IS ENOUGH. `MIG_COST_MS` is the one
# measured number (~137 ms per migration replay); `BASE_COST_MS` is a stand-in for
# per-file import and setup. They are not a claim about any file's true runtime,
# and nothing depends on them being accurate — the bar a cost model has to clear
# here is "better than assuming every file costs the same", which is what
# round-robin assumed. Deliberately content-derived rather than a checked-in
# timing manifest: a manifest is a second source of truth that rots silently every
# time a test is added, and a stale weight is indistinguishable from a fresh one.
#
# The coverage guarantee changes shape and it is worth being explicit: a sharded
# run can no longer prove on its own that every file ran. It proves it ran
# exactly its own slice; the UNION is guaranteed by (a) identical deterministic
# discovery on every shard, (b) a partition function with no gaps or overlap
# (asserted in scripts/__tests__/run-tests-shard.test.ts), and (c) CI's
# aggregator job requiring every shard to report. Drop any one of those three
# and a silent coverage hole becomes possible.
if [ -n "$SHARD_SPEC" ]; then
  # $1 = the round-robin cursor this lane starts at; the rest are its files.
  # `_slice` runs in a subshell (it is read through a process substitution), so
  # the cursor cannot be a mutated global — the caller advances it by the lane's
  # PRE-SLICE length, captured before the array is reassigned.
  _slice() {
    _k=$1
    shift
    _out=()
    for _f in "$@"; do
      if [ "$(( _k % SHARD_N ))" -eq "$(( SHARD_I - 1 ))" ]; then _out+=("$_f"); fi
      _k=$(( _k + 1 ))
    done
    printf '%s\n' ${_out[@]+"${_out[@]}"}
  }

  # --- the general lane: bin-pack by estimated cost ---------------------------
  # Weight = BASE_COST_MS + MIG_COST_MS × (migration replays in the file). One
  # batched `grep -c` over the lane (the same shape as the lane-membership greps
  # above, well under ARG_MAX at this file count) so the whole model costs a
  # single extra pass over files already on the page cache from discovery.
  _weigh_and_pack() {
    [ "$#" -eq 0 ] && return 0
    # `grep -cE` over multiple files prints `path:count` per file, including
    # zero-count files, so every input gets exactly one line and nothing is
    # dropped. `|| true` because a zero-match grep exits 1 under `pipefail`.
    LC_ALL=C grep -cE 'applyMigrations(ToProjectDb)?\(' "$@" 2>/dev/null \
      | LC_ALL=C awk -F: -v base="$BASE_COST_MS" -v mig="$MIG_COST_MS" \
          '{ n = $NF; p = $0; sub(/:[^:]*$/, "", p); print (base + mig * n) "\t" p }' \
      | LC_ALL=C sort -t"$(printf '\t')" -k1,1nr -k2,2 \
      | LC_ALL=C awk -F"$(printf '\t')" -v n="$SHARD_N" -v mine="$SHARD_I" '
          BEGIN { for (b = 1; b <= n; b++) load[b] = 0 }
          {
            # Longest-processing-time-first: heaviest remaining file goes to the
            # lightest bin. Ties break to the LOWEST bin index, which — with the
            # sort above being total (weight desc, then path asc) — makes the
            # assignment a pure function of the input. Every shard therefore
            # computes the same partition without talking to any other shard.
            pick = 1
            for (b = 2; b <= n; b++) if (load[b] < load[pick]) pick = b
            load[pick] += $1
            if (pick == mine) print $2
            total[pick] = total[pick] + 1
          }
          END {
            for (b = 1; b <= n; b++) printf("weight\t%d\t%d\t%d\n", b, load[b], total[b]) > "/dev/stderr"
          }
        '
  }

  SHARD_WEIGHT_LOG="$(mktemp "${TMPDIR:-/tmp}/neutron-shard-weight-XXXXXX")"
  _tmp=()
  # Weights are emitted on stderr by the packer so the balance is visible in CI
  # logs without polluting the file list on stdout.
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(_weigh_and_pack ${GENERAL_FILES[@]+"${GENERAL_FILES[@]}"} 2>"$SHARD_WEIGHT_LOG")
  # Restore discovery order. The packer emits heaviest-first, and chunk membership
  # is taken by index off this array, so leaving it weight-sorted would pile every
  # expensive file into chunk 1 — a needless change to peak RSS shape that has
  # nothing to do with balancing across shards.
  GENERAL_FILES=()
  if [ "${#_tmp[@]}" -gt 0 ]; then
    _mine=$'\n'"$(printf '%s\n' "${_tmp[@]}")"$'\n'
    for _f in ${FILES[@]+"${FILES[@]}"}; do
      case "$_mine" in *$'\n'"$_f"$'\n'*) GENERAL_FILES+=("$_f") ;; esac
    done
  fi

  # --- the two serial lanes: unchanged round-robin ----------------------------
  # Left on round-robin deliberately. Both are small and both are dominated by a
  # fixed per-file cost (a WASM compile; a DOM + module-registry install) rather
  # than by how much migration work the file does, so counting IS the cost model
  # for them and a proportional spread is exactly right.
  _shard_cursor=0
  _lane_n=${#PGLITE_FILES[@]}
  _tmp=()
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(_slice "$_shard_cursor" ${PGLITE_FILES[@]+"${PGLITE_FILES[@]}"})
  PGLITE_FILES=( ${_tmp[@]+"${_tmp[@]}"} )
  _shard_cursor=$(( _shard_cursor + _lane_n ))
  _tmp=()
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(_slice "$_shard_cursor" ${DEVICE_FILES[@]+"${DEVICE_FILES[@]}"})
  DEVICE_FILES=( ${_tmp[@]+"${_tmp[@]}"} )

  echo "run-tests: SHARD ${SHARD_I}/${SHARD_N} — executing ${#GENERAL_FILES[@]} general + ${#PGLITE_FILES[@]} PGLite + ${#DEVICE_FILES[@]} device of ${TOTAL} discovered"
  # The estimated general-lane cost per shard, printed by every shard so a future
  # imbalance is visible in the log rather than only in the wall-clock.
  if [ -s "$SHARD_WEIGHT_LOG" ]; then
    LC_ALL=C awk -F"$(printf '\t')" -v i="$SHARD_I" \
      '$1 == "weight" { printf("run-tests: shard %d general est %dms over %d files%s\n", $2, $3, $4, ($2 == i ? "  <= this shard" : "")) }' \
      "$SHARD_WEIGHT_LOG"
  fi
  rm -f "$SHARD_WEIGHT_LOG"
fi

NPGLITE=${#PGLITE_FILES[@]}
NDEVICE=${#DEVICE_FILES[@]}
GEN_TOTAL=${#GENERAL_FILES[@]}

# Plan-only seam — print exactly what THIS invocation would execute, then stop.
# Exists so the shard partition can be asserted directly (no gaps, no overlap)
# without running the suite N times; a partition bug is otherwise invisible,
# because a missing file looks identical to a passing one.
if [ "${NEUTRON_TEST_PLAN_ONLY:-0}" = "1" ]; then
  echo "declared files: ${TOTAL}"
  echo "run-tests: PLAN-ONLY BEGIN"
  printf '%s\n' ${GENERAL_FILES[@]+"${GENERAL_FILES[@]}"} ${PGLITE_FILES[@]+"${PGLITE_FILES[@]}"} ${DEVICE_FILES[@]+"${DEVICE_FILES[@]}"}
  echo "run-tests: PLAN-ONLY END"
  exit 0
fi

# What THIS invocation is accountable for executing. Unsharded this is TOTAL, so
# the audit below is unchanged; sharded it is this shard's slice.
SHARD_TOTAL=$(( GEN_TOTAL + NPGLITE + NDEVICE ))

# --- 3. Partition + run -------------------------------------------------------
NCHUNKS=$(( (GEN_TOTAL + CHUNK_SIZE - 1) / CHUNK_SIZE ))
echo "run-tests: ${TOTAL} test files (bun-discovered: ${BUN_DISC:-n/a}) → ${NCHUNKS} general chunks of <=${CHUNK_SIZE} + ${NPGLITE}-file PGLite lane + ${NDEVICE}-file device lane"
echo "run-tests: bun=${BUN} max-concurrency=${CONCURRENCY} timeout=${TIMEOUT}ms jobs=${JOBS}"
if [ "$NPGLITE" -gt 0 ]; then
  echo "run-tests: PGLite lane → ${NPGLITE} files, serial=${PGLITE_CONCURRENCY}, timeout=${PGLITE_TIMEOUT}ms, retries=${PGLITE_RETRIES}"
fi
if [ "$NDEVICE" -gt 0 ]; then
  echo "run-tests: device-harness lane → ${NDEVICE} files, isolated process (DOM + module-alias globals)"
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

# Run the mobile device-harness files in their OWN process. They register a
# happy-dom DOM and alias `react-native` for the whole process, which collides with
# `landing`'s happy-dom tests (their `GlobalRegistrator.register()` throws when a DOM
# already exists) and with other app tests' process-global `mock.module('react-native')`
# fakes. Mixed into a general chunk that cost 68 failures across three CI shards in
# unrelated packages. No retry budget: these are deterministic, not flaky.
run_device_lane() {
  local llog="$WORK/lane-device.log"
  {
    echo "==== device-harness isolation lane: ${NDEVICE} files (own process) ===="
    NO_COLOR=1 "$BUN" test "${DEVICE_FILES[@]}" --timeout="$TIMEOUT" --max-concurrency="$CONCURRENCY" 2>&1
  } >"$llog" 2>&1
  local rc=$?
  local ran; ran="$(LC_ALL=C grep -aoE 'across [0-9]+ file' "$llog" | LC_ALL=C grep -aoE '[0-9]+' | tail -1)"
  cat "$llog"
  # Sentinel idx 'device'; `ran` falls back to NDEVICE so the coverage audit still
  # accounts for the lane files if bun's count line was eaten by log noise.
  echo "device ${rc} ${NDEVICE} ${ran:-$NDEVICE}" >> "$WORK/results"
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

if [ "$NDEVICE" -gt 0 ]; then
  run_device_lane
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
    elif [ "$r_idx" = "device" ]; then
      FAIL_LIST="${FAIL_LIST} device-lane"
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
if [ "$NDEVICE" -gt 0 ]; then
  LANES=$(( LANES + 1 ))
  LANE_DESC="${LANE_DESC} + device lane"
fi

echo "---- run-tests coverage audit ----"
echo "declared files: ${TOTAL}   bun-discovered: ${BUN_DISC:-n/a}   assigned here: ${SHARD_TOTAL}${SHARD_SPEC:+ (shard ${SHARD_SPEC})}   files executed: ${RAN_TOTAL} (${GEN_TOTAL} general + ${NPGLITE} PGLite + ${NDEVICE} device)"
echo "lanes: ${LANE_DESC}   failed: ${FAILED_CHUNKS}${FAIL_LIST:+ (${FAIL_LIST# })}"
if [ "$RAN_TOTAL" -lt "$SHARD_TOTAL" ]; then
  echo "run-tests: FATAL — executed ${RAN_TOTAL} files < ${SHARD_TOTAL} assigned (coverage hole)." >&2
  exit 1
fi
if [ "$FAILED_CHUNKS" -ne 0 ]; then
  echo "run-tests: FAIL — ${FAILED_CHUNKS}/${LANES} lane(s) contained failing tests (see output above)."
  exit 1
fi
echo "run-tests: PASS — all ${SHARD_TOTAL}${SHARD_SPEC:+/${TOTAL}} files across ${LANES} bounded-memory lane(s) are green."
exit 0
