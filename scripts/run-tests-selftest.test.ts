/**
 * Unit G8 (Part A) — self-tests for scripts/run-tests.sh, the bounded-memory
 * partitioned runner that CI itself uses to run the WHOLE suite.
 *
 * A bug in run-tests.sh breaks ALL of CI, yet it had ZERO tests. These drive it
 * deterministically and WITHOUT ever launching the real suite, via two seams:
 *
 *   1. NEUTRON_TEST_DISCOVER_OVERRIDE (scripts/lib/discover-test-files.sh) — the
 *      injection seam that supplies the discovered file list verbatim instead of
 *      walking the FS, so we control exactly which files the runner partitions.
 *   2. NEUTRON_BUN_BIN — a FAKE `bun` (a tiny bash stub written per-test) that
 *      never runs a real test. It distinguishes the discovery probe (which
 *      carries the `__neutron_runtests_no_match__` sentinel) from chunk/lane runs
 *      and emits a controllable "Ran N tests across M files" line + exit code, so
 *      we can exercise chunk math, the PGLite lane split, the empty-BUN_DISC
 *      loud-fail (G8), and the audit-failure paths — all in milliseconds.
 *
 * The real files listed in the override must EXIST on disk because the runner
 * greps their CONTENTS to derive PGLite-lane membership (`grep -lEi pglite`), so
 * each fixture is a real temp file whose content we control.
 */
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_TESTS = fileURLToPath(new URL('./run-tests.sh', import.meta.url))

/**
 * A fake `bun` driven entirely by env:
 *   FAKE_BUN_DISC       count to print for the discovery probe; "none" ⇒ print no
 *                       "across N files" line (simulates a broken/empty probe).
 *   FAKE_BUN_CHUNK_RC   exit code for chunk/lane runs (default 0).
 *   FAKE_BUN_CHUNK_RAN  "count" ⇒ report the real file count (default);
 *                       "none"  ⇒ print no across-line (⇒ ran parses as 0);
 *                       <number> ⇒ print that count.
 * It tells the probe apart from a chunk run by the no-match sentinel arg.
 */
const FAKE_BUN = `#!/usr/bin/env bash
is_probe=0
for a in "$@"; do
  [ "$a" = "__neutron_runtests_no_match__" ] && is_probe=1
done
if [ "$is_probe" = "1" ]; then
  case "\${FAKE_BUN_DISC:-none}" in
    none) : ;;
    *) echo "Ran 0 tests across \${FAKE_BUN_DISC} files. [0.00s]" ;;
  esac
  exit 0
fi
nfiles=0
for a in "$@"; do
  case "$a" in
    test|-*) : ;;
    *) nfiles=$((nfiles+1)) ;;
  esac
done
case "\${FAKE_BUN_CHUNK_RAN:-count}" in
  none) : ;;
  count) echo "Ran $((nfiles*3)) tests across \${nfiles} files. [0.01s]" ;;
  *) echo "Ran 1 tests across \${FAKE_BUN_CHUNK_RAN} files. [0.01s]" ;;
esac
exit "\${FAKE_BUN_CHUNK_RC:-0}"
`

interface Harness {
  dir: string
  fakeBun: string
  files: string[]
}

/**
 * Build a temp dir with a fake bun + `count` real test-file fixtures. `pgliteIdx`
 * lists which fixtures should CONTAIN the literal `pglite` (so the runner's
 * content-derived lane split quarantines them).
 */
function harness(count: number, pgliteIdx: number[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-selftest-'))
  const fakeBun = join(dir, 'fake-bun')
  writeFileSync(fakeBun, FAKE_BUN)
  chmodSync(fakeBun, 0o755)
  const files: string[] = []
  for (let i = 0; i < count; i++) {
    const f = join(dir, `f${i}.test.ts`)
    const body = pgliteIdx.includes(i)
      ? `import { test } from 'bun:test'\n// boots pglite WASM\ntest('x', () => {})\n`
      : `import { test } from 'bun:test'\ntest('x', () => {})\n`
    writeFileSync(f, body)
    files.push(f)
  }
  return { dir, fakeBun, files }
}

interface RunResult {
  code: number
  out: string
}

/**
 * Run run-tests.sh with the discover override + fake bun; return code + combined
 * output. stderr is MERGED into stdout (`2>&1`) because run-tests.sh writes its
 * FATAL/WARNING lines to stderr, and execFileSync returns only stdout on exit 0 —
 * without the merge a success-path WARNING would be invisible to assertions.
 */
function runRunTests(h: Harness, extraEnv: Record<string, string> = {}): RunResult {
  try {
    const out = execFileSync('bash', ['-c', 'bash "$1" 2>&1', 'bash', RUN_TESTS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEUTRON_TEST_DISCOVER_OVERRIDE: h.files.join(' '),
        NEUTRON_BUN_BIN: h.fakeBun,
        ...extraEnv,
      },
    })
    return { code: 0, out }
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('G8 run-tests.sh — chunk math', () => {
  test('5 files, CHUNK_SIZE=2 → 3 general chunks and a clean PASS', () => {
    const h = harness(5)
    try {
      const { code, out } = runRunTests(h, {
        NEUTRON_TEST_CHUNK_SIZE: '2',
        FAKE_BUN_DISC: '5',
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('3 general chunks of <=2')
      expect(out).toContain('run-tests: PASS')
      expect(code).toBe(0)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('exactly CHUNK_SIZE files → 1 chunk (no off-by-one)', () => {
    const h = harness(4)
    try {
      const { out } = runRunTests(h, {
        NEUTRON_TEST_CHUNK_SIZE: '4',
        FAKE_BUN_DISC: '4',
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('1 general chunks of <=4')
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('G8 run-tests.sh — PGLite quarantine lane split', () => {
  test('files whose CONTENT mentions pglite go to the lane, AFTER the general chunks', () => {
    // 4 files, two of them contain `pglite` → 2 general + a 2-file PGLite lane.
    const h = harness(4, [1, 3])
    try {
      const { code, out } = runRunTests(h, {
        NEUTRON_TEST_CHUNK_SIZE: '10',
        FAKE_BUN_DISC: '4',
      })
      expect(out).toContain('2-file PGLite lane')
      expect(out).toContain('PGLite lane → 2 files')
      // Lane runs after the chunks: the "quarantine lane" banner appears in output.
      expect(out).toContain('PGLite quarantine lane: 2 files')
      expect(out).toContain('run-tests: PASS')
      expect(code).toBe(0)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('NEUTRON_TEST_NO_PGLITE_LANE=1 folds pglite files back into general chunks', () => {
    const h = harness(3, [0])
    try {
      const { out } = runRunTests(h, {
        NEUTRON_TEST_CHUNK_SIZE: '10',
        FAKE_BUN_DISC: '3',
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('0-file PGLite lane')
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('G8 run-tests.sh — empty BUN_DISC is LOUD (G8 fix)', () => {
  test('empty discovery count is a FATAL failure by default (no silent skip)', () => {
    const h = harness(3)
    try {
      const { code, out } = runRunTests(h, {
        FAKE_BUN_DISC: 'none', // probe prints no "across N files" line
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('run-tests: FATAL')
      expect(out).toContain("no 'across N files' count")
      expect(code).toBe(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC=1 downgrades to a loud WARNING, run continues', () => {
    const h = harness(3)
    try {
      const { code, out } = runRunTests(h, {
        FAKE_BUN_DISC: 'none',
        NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC: '1',
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('run-tests: WARNING')
      expect(out).toContain('cross-check is DISABLED')
      expect(out).toContain('run-tests: PASS')
      expect(code).toBe(0)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('G8 run-tests.sh — coverage drift + audit-failure paths', () => {
  test('bun-discovered count != find count → FATAL coverage drift', () => {
    const h = harness(3)
    try {
      const { code, out } = runRunTests(h, {
        FAKE_BUN_DISC: '99', // pretend bun sees a different file count
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('FATAL coverage drift')
      expect(code).toBe(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('a failing chunk (non-zero rc) → run-tests FAIL, exit 1', () => {
    const h = harness(3)
    try {
      const { code, out } = runRunTests(h, {
        FAKE_BUN_DISC: '3',
        FAKE_BUN_CHUNK_RC: '1',
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('contained failing tests')
      expect(out).toContain('run-tests: FAIL')
      expect(code).toBe(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('chunks that execute FEWER files than discovered → FATAL coverage hole', () => {
    const h = harness(3)
    try {
      const { code, out } = runRunTests(h, {
        FAKE_BUN_DISC: '3',
        FAKE_BUN_CHUNK_RAN: 'none', // chunk prints no across-line ⇒ ran counts as 0
        NEUTRON_TEST_NO_PGLITE_LANE: '1',
      })
      expect(out).toContain('coverage hole')
      expect(code).toBe(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })

  test('discovering 0 files is FATAL', () => {
    const h = harness(1)
    try {
      const { code, out } = runRunTests(h, {
        NEUTRON_TEST_DISCOVER_OVERRIDE: '   ', // whitespace ⇒ zero files
      })
      expect(out).toContain('discovered 0 test files')
      expect(code).toBe(1)
    } finally {
      rmSync(h.dir, { recursive: true, force: true })
    }
  })
})

describe('G8 run-tests.sh — end-to-end smoke on the REAL bun', () => {
  test('a trivial one-file override runs to a real PASS (chunk + audit paths intact)', () => {
    // No fake bun: point NEUTRON_BUN_BIN at the REAL bun and run ONE tiny real
    // test file, proving the script + our edits still drive real bun to a PASS
    // without touching the full suite. NEUTRON_TEST_ROOT is scoped to the isolated
    // dir so the discovery probe walks ONLY this one file.
    //
    // In this isolated dir the probe's impossible `-t` filter skips the single
    // test, so bun prints "Searched 1 file" (not "Ran … across …") → an EMPTY
    // BUN_DISC, which the G8 change treats as loud-fatal by design. That empty
    // probe is an artifact of the tiny dir (the real 915-file suite always runs
    // ≥1 test → "across 915 files" → non-empty). So the smoke opts into the
    // documented allow-empty override to exercise the real chunk-run + audit end
    // to end; the loud-fatal itself is covered by the fake-bun cases above.
    const dir = mkdtempSync(join(tmpdir(), 'run-tests-smoke-'))
    try {
      const f = join(dir, 'trivial.test.ts')
      writeFileSync(f, `import { expect, test } from 'bun:test'\ntest('trivial', () => { expect(1).toBe(1) })\n`)
      const out = execFileSync('bash', ['-c', 'bash "$1" 2>&1', 'bash', RUN_TESTS], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NEUTRON_TEST_ROOT: dir,
          NEUTRON_TEST_DISCOVER_OVERRIDE: f,
          NEUTRON_TEST_NO_PGLITE_LANE: '1',
          NEUTRON_TEST_ALLOW_EMPTY_BUN_DISC: '1',
        },
      })
      expect(out).toContain('run-tests: PASS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
