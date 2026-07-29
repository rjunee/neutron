# shellcheck shell=bash
# scripts/lib/discover-test-files.sh
#
# Single source of truth for "what is the real test suite?" — used by the
# human/CI runner (scripts/run-tests.sh). Isolating discovery here means any
# future consumer (a deploy gate, another lane) shares the exact same file set,
# so the dot-dir/node_modules exclusion below can never drift between callers.
#
# neutron_discover_test_files prints, one per line, every real-source test file
# bun would run, EXCLUDING node_modules and ALL dot-directories. The dot-dir
# exclusion is what keeps the ~6810 stale `.claude/worktrees/` trident/forge
# clone test files out of the suite — bun 1.3.9 already skips them, and we mirror
# that here so the partition list equals bun's own discovery (run-tests.sh
# cross-checks the counts and aborts on drift; no silent truncation).
#
# Injection seam (tests only): NEUTRON_TEST_DISCOVER_OVERRIDE — when set, its
# whitespace-separated contents are emitted verbatim instead of walking the FS,
# so unit tests can drive a deterministic file list without a real `find`.

neutron_discover_test_files() {
  if [ -n "${NEUTRON_TEST_DISCOVER_OVERRIDE:-}" ]; then
    printf '%s\n' ${NEUTRON_TEST_DISCOVER_OVERRIDE}
    return 0
  fi
  find . -type f \
    \( -name '*.test.ts'  -o -name '*.test.tsx' \
    -o -name '*.test.js'  -o -name '*.test.jsx' \
    -o -name '*.test.mjs' -o -name '*.test.cjs' \
    -o -name '*.spec.ts'  -o -name '*.spec.tsx' \
    -o -name '*.spec.js'  -o -name '*.spec.jsx' \
    -o -name '*.spec.mjs' -o -name '*.spec.cjs' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/.*/*' \
    | sort
}
