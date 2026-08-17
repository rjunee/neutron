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
#   NEUTRON_TEST_TIMINGS      timing manifest read by the shard partition
#                             (default scripts/test-timings.json; see below)
#   NEUTRON_TEST_TIMINGS_OUT  when set, every lane also writes a JUnit report and
#                             the run REGENERATES the manifest at this path.
#                             Documented regeneration command:
#                               NEUTRON_TEST_TIMINGS_OUT=scripts/test-timings.json \
#                                 bash scripts/run-tests.sh
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
# Duration manifest consumed by the shard partition (§2c) and, when
# NEUTRON_TEST_TIMINGS_OUT is set, regenerated by this run (§5).
TIMINGS_FILE="${NEUTRON_TEST_TIMINGS:-${SCRIPT_DIR}/test-timings.json}"
TIMINGS_OUT="${NEUTRON_TEST_TIMINGS_OUT:-}"
# Cost assumed for a file the manifest does not name — a NEW test file, or every
# file when the manifest is missing entirely. Roughly the observed cost of a
# small file (measured: a 12-test file with 0.02 s of test bodies takes 1.35 s
# wall, because bun pays process start + module graph per file), rounded up so a
# genuinely slow newcomer is under-, not over-, corrected. Only ever affects
# BALANCE — never which shard owns a file, and never whether it runs at all.
DEFAULT_FILE_SECONDS="${NEUTRON_TEST_DEFAULT_FILE_SECONDS:-2}"
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
# BALANCED BY MEASURED DURATION, NOT BY FILE COUNT. The previous partition was a
# round-robin on the file INDEX (`_k % SHARD_N`), which balances the file COUNT
# and nothing else. The suite is not uniform: a handful of files dominate, so
# equal counts produced very unequal runners — measured 2026-08-17 across four
# CI shards: 204 s / 304 s / 412 s. Wall-clock is set by the WORST shard, so
# roughly a third of it was imbalance rather than work.
#
# So each file is charged a cost from a committed manifest of observed durations
# (`scripts/test-timings.json`, regenerable — see NEUTRON_TEST_TIMINGS_OUT) and
# the files are assigned LONGEST-FIRST to whichever shard is currently lightest.
# Greedy longest-first is the standard multiway-partition heuristic and it is
# within 4/3 of optimal; more importantly it is a total function of (file list,
# manifest, N), so every shard computes the SAME assignment independently.
#
# STALE OR MISSING DATA CANNOT BREAK CORRECTNESS, only balance. The manifest is
# consulted for a COST and never for membership:
#   - a file the manifest does not name costs DEFAULT_FILE_SECONDS and is
#     assigned exactly like any other (a new test file needs no manifest bump);
#   - a manifest entry naming a file that no longer exists is never looked up;
#   - no manifest at all makes every cost equal, which degenerates to the
#     round-robin this replaced.
# In all three the partition is still a partition: every discovered file is
# assigned to exactly one bucket, because the assignment loop walks the file
# list, not the manifest. `scripts/__tests__/run-tests-shard.test.ts` pins that
# for the empty, partial and stale cases.
#
# The lanes are still spread across shards rather than dumped on one runner, and
# now for a better reason than round-robin phase: the PGLite files are the most
# expensive in the suite, so longest-first hands them out to distinct empty
# buckets before anything else is placed.
#
# The coverage guarantee changes shape and it is worth being explicit: a sharded
# run can no longer prove on its own that every file ran. It proves it ran
# exactly its own slice; the UNION is guaranteed by (a) identical deterministic
# discovery on every shard, (b) a partition function with no gaps or overlap
# (asserted in scripts/__tests__/run-tests-shard.test.ts), and (c) CI's
# aggregator job requiring every shard to report. Drop any one of those three
# and a silent coverage hole becomes possible.
if [ -n "$SHARD_SPEC" ]; then
  # Stage 1 (awk): charge every file its cost from the manifest, emitting
  #   "<zero-padded cost>\t<lane>\t<path>". The cost is zero-padded to a fixed
  #   width so stage 2 can sort it as TEXT — a numeric sort would depend on the
  #   locale's decimal separator, and this pipeline must produce byte-identical
  #   output on every shard or the partition stops being one.
  # Stage 2 (sort): cost DESCENDING, then path ASCENDING. The path tie-break is
  #   what makes the order total, so equal-cost files (e.g. every file when the
  #   manifest is absent) cannot be ordered differently on two runners.
  # Stage 3 (awk): walk that order, place each file in the lightest bucket, and
  #   print only the rows belonging to THIS shard, plus one `#predict` row
  #   carrying every bucket's predicted total for the log.
  _shard_rows="$(
    {
      for _f in ${GENERAL_FILES[@]+"${GENERAL_FILES[@]}"}; do printf 'g\t%s\n' "$_f"; done
      for _f in ${PGLITE_FILES[@]+"${PGLITE_FILES[@]}"}; do printf 'p\t%s\n' "$_f"; done
      for _f in ${DEVICE_FILES[@]+"${DEVICE_FILES[@]}"}; do printf 'd\t%s\n' "$_f"; done
    } | LC_ALL=C awk -F'\t' -v manifest="$TIMINGS_FILE" -v dflt="$DEFAULT_FILE_SECONDS" '
          BEGIN {
            # Deliberately a LINE-WISE regex read, not a JSON parser: the only
            # thing this needs from the manifest is "path" -> number pairs, and a
            # line it cannot understand must be skipped rather than fatal. A
            # corrupt manifest degrades to the no-manifest case (equal costs),
            # which is the round-robin behaviour that predates this partition.
            while ((getline line < manifest) > 0) {
              if (match(line, /"[^"]+"[ \t]*:[ \t]*[0-9]+(\.[0-9]+)?/) == 0) continue
              kv = substr(line, RSTART, RLENGTH)
              match(kv, /"[^"]+"/)
              key = substr(kv, RSTART + 1, RLENGTH - 2)
              sub(/^\.\//, "", key)
              val = kv
              sub(/^"[^"]+"[ \t]*:[ \t]*/, "", val)
              if (val + 0 > 0) cost[key] = val + 0
            }
            close(manifest)
          }
          {
            key = $2
            sub(/^\.\//, "", key)
            printf "%012.3f\t%s\t%s\n", (key in cost) ? cost[key] : dflt, $1, $2
          }
        ' | LC_ALL=C sort -t"$(printf '\t')" -k1,1r -k3,3 | LC_ALL=C awk -F'\t' -v i="$SHARD_I" -v n="$SHARD_N" '
          BEGIN { for (b = 0; b < n; b++) load[b] = 0 }
          {
            best = 0
            for (b = 1; b < n; b++) if (load[b] < load[best]) best = b
            load[best] += $1 + 0
            if (best == i - 1) print $2 "\t" $3
          }
          END {
            s = ""
            for (b = 0; b < n; b++) s = s sprintf("%s%d:%ds", (b ? " " : ""), b + 1, int(load[b] + 0.5))
            print "#predict\t" s
          }
        '
  )"
  _tmp_g=()
  _tmp_p=()
  _tmp_d=()
  _predict=""
  while IFS="$(printf '\t')" read -r _lane _val; do
    case "$_lane" in
      g) _tmp_g+=("$_val") ;;
      p) _tmp_p+=("$_val") ;;
      d) _tmp_d+=("$_val") ;;
      '#predict') _predict="$_val" ;;
    esac
  done <<EOF
${_shard_rows}
EOF
  # Back to PATH order inside each lane. The partition arrives cost-descending,
  # which would put this shard's 100 most expensive files together in chunk 0 —
  # and a chunk's peak RSS is the property the chunking exists to bound, so it
  # should not be quietly correlated with test DURATION. Sorting is free here and
  # keeps chunk composition the same shape it has always had.
  _tmp=()
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(printf '%s\n' ${_tmp_g[@]+"${_tmp_g[@]}"} | LC_ALL=C sort)
  GENERAL_FILES=( ${_tmp[@]+"${_tmp[@]}"} )
  _tmp=()
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(printf '%s\n' ${_tmp_p[@]+"${_tmp_p[@]}"} | LC_ALL=C sort)
  PGLITE_FILES=( ${_tmp[@]+"${_tmp[@]}"} )
  _tmp=()
  while IFS= read -r _l; do [ -n "$_l" ] && _tmp+=("$_l"); done < <(printf '%s\n' ${_tmp_d[@]+"${_tmp_d[@]}"} | LC_ALL=C sort)
  DEVICE_FILES=( ${_tmp[@]+"${_tmp[@]}"} )
  echo "run-tests: SHARD ${SHARD_I}/${SHARD_N} — executing ${#GENERAL_FILES[@]} general + ${#PGLITE_FILES[@]} PGLite + ${#DEVICE_FILES[@]} device of ${TOTAL} discovered"
  # Printed REPO-RELATIVE. `TIMINGS_FILE` is derived from SCRIPT_DIR, so it is an
  # absolute path — which in a CI log or a pasted transcript means printing
  # somebody's home directory for no informational gain.
  echo "run-tests: predicted shard seconds (from ${TIMINGS_FILE#"${ROOT}"/}): ${_predict:-unavailable}"
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
  local jflags=()
  [ -n "$TIMINGS_OUT" ] && jflags=(--reporter=junit --reporter-outfile="$WORK/junit-chunk-$(printf '%03d' "$idx").xml")
  {
    echo "==== chunk $((idx+1))/${NCHUNKS}: ${#chunk[@]} files (index ${start}..$((start+${#chunk[@]}-1))) ===="
    NO_COLOR=1 "$BUN" test "${chunk[@]}" --timeout="$TIMEOUT" --max-concurrency="$CONCURRENCY" ${jflags[@]+"${jflags[@]}"} 2>&1
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
  local jflags=()
  [ -n "$TIMINGS_OUT" ] && jflags=(--reporter=junit --reporter-outfile="$WORK/junit-lane-pglite.xml")
  while [ "$attempt" -le "$max" ]; do
    {
      echo "==== PGLite quarantine lane: ${NPGLITE} files (attempt ${attempt}/${max}, max-concurrency=${PGLITE_CONCURRENCY}, timeout=${PGLITE_TIMEOUT}ms) ===="
      NO_COLOR=1 "$BUN" test "${PGLITE_FILES[@]}" --timeout="$PGLITE_TIMEOUT" --max-concurrency="$PGLITE_CONCURRENCY" ${jflags[@]+"${jflags[@]}"} 2>&1
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
  local jflags=()
  [ -n "$TIMINGS_OUT" ] && jflags=(--reporter=junit --reporter-outfile="$WORK/junit-lane-device.xml")
  {
    echo "==== device-harness isolation lane: ${NDEVICE} files (own process) ===="
    NO_COLOR=1 "$BUN" test "${DEVICE_FILES[@]}" --timeout="$TIMEOUT" --max-concurrency="$CONCURRENCY" ${jflags[@]+"${jflags[@]}"} 2>&1
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

# --- 4b. Regenerate the duration manifest (opt-in) ----------------------------
# Written BEFORE the audit's exit paths so a run that ends red still leaves the
# timings it measured — a red suite's files still cost what they cost.
#
# The value stored per file is the MODELLED COST, not a raw stopwatch reading:
#
#     cost(file) = DEFAULT_FILE_SECONDS + Σ(its testcase times)
#
# The Σ term comes from bun's own JUnit report (`<testcase … time=… file=…>`);
# the constant is the per-file floor bun pays whatever the tests do (process
# start + module graph). Both halves matter: the Σ term is what makes the few
# dominant files dominant, and the floor is what stops a shard being handed 400
# nominally-free files. A file that appears in no testcase line (no tests ran in
# it) is simply absent, and the partition then charges it exactly the floor — the
# same number, reached by the same formula.
write_timings_manifest() {
  local out="$1"
  local tmp="${out}.tmp.$$"
  # shellcheck disable=SC2211  # the glob is intentional: one report per lane.
  if ! ls "$WORK"/junit-*.xml >/dev/null 2>&1; then
    echo "run-tests: WARNING — NEUTRON_TEST_TIMINGS_OUT is set but no JUnit reports were produced; manifest NOT rewritten." >&2
    return 0
  fi
  LC_ALL=C awk '
    /<testcase/ {
      t = ""; f = ""
      if (match($0, /time="[^"]*"/)) t = substr($0, RSTART + 6, RLENGTH - 7)
      if (match($0, /file="[^"]*"/)) f = substr($0, RSTART + 6, RLENGTH - 7)
      if (f == "") next
      sub(/^\.\//, "", f)
      total[f] += t + 0
    }
    END { for (f in total) printf "%s\t%.3f\n", f, total[f] }
  ' "$WORK"/junit-*.xml \
    | LC_ALL=C sort \
    | LC_ALL=C awk -v floor="$DEFAULT_FILE_SECONDS" -F'\t' '
        BEGIN { print "{" }
        { printf "%s  \"./%s\": %.3f", (n++ ? ",\n" : ""), $1, $2 + floor }
        END { if (n) printf "\n"; print "}" }
      ' >"$tmp"
  if [ -s "$tmp" ]; then
    mv "$tmp" "$out"
    echo "run-tests: wrote duration manifest → ${out}"
  else
    rm -f "$tmp"
    echo "run-tests: WARNING — timings merge produced nothing; manifest NOT rewritten." >&2
  fi
}

if [ -n "$TIMINGS_OUT" ]; then
  # A SHARDED run measured a QUARTER of the suite, and writing that over the
  # manifest would delete three quarters of the costs — after which every deleted
  # file falls back to the default and the partition quietly returns to balancing
  # by count. Correctness would survive it (a missing entry is just a default) and
  # nothing would look wrong, which is exactly why it has to refuse rather than
  # warn-and-proceed.
  if [ -n "$SHARD_SPEC" ]; then
    echo "run-tests: REFUSING to write ${TIMINGS_OUT} from shard ${SHARD_SPEC} — a shard measures its own" >&2
    echo "  slice only, and the manifest must cover the WHOLE suite. Re-run unsharded to regenerate." >&2
  else
    write_timings_manifest "$TIMINGS_OUT"
  fi
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
