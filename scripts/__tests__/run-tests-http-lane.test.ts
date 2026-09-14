import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const RUN_TESTS = join(ROOT, 'scripts', 'run-tests.sh')

describe('run-tests.sh real-HTTP isolation lane', () => {
  test('listener-opening files run serially with the unchanged per-test timeout', () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-http-lane-'))
    try {
      mkdirSync(join(root, 'pkg'), { recursive: true })
      writeFileSync(join(root, 'pkg', 'plain.test.ts'), "test('plain', () => {})\n")
      writeFileSync(
        join(root, 'pkg', 'direct-http.test.ts'),
        "test('http', () => { const server = Bun.serve({ port: 0, fetch() {} }); server.stop() })\n",
      )
      writeFileSync(
        join(root, 'pkg', 'boot-http.test.ts'),
        "test('boot', async () => { const handle = await boot({ port: 0 }); await handle.shutdown() })\n",
      )

      const calls = join(root, 'bun-calls.txt')
      const fakeBun = join(root, 'fake-bun')
      writeFileSync(
        fakeBun,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
count=0
for arg in "$@"; do case "$arg" in *.test.ts|*.test.tsx) count=$((count + 1));; esac; done
if [ "$count" -eq 0 ]; then count=3; fi
echo "Ran 1 tests across $count files."
`,
      )
      chmodSync(fakeBun, 0o755)

      const result = spawnSync('bash', [RUN_TESTS], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...(process.env as Record<string, string>),
          NEUTRON_TEST_ROOT: root,
          NEUTRON_BUN_BIN: fakeBun,
          NEUTRON_TEST_DISCOVER_OVERRIDE:
            './pkg/plain.test.ts ./pkg/direct-http.test.ts ./pkg/boot-http.test.ts',
          NEUTRON_TEST_CONCURRENCY: '7',
          NEUTRON_TEST_TIMEOUT: '1234',
        },
      })

      const output = `${result.stdout}${result.stderr}`
      expect(result.status).toBe(0)
      expect(output).toContain(
        'real-HTTP isolation lane batch 1/1: 2 files (own process, max-concurrency=1, timeout=1234ms)',
      )

      const invocations = readFileSync(calls, 'utf8').trim().split('\n')
      const general = invocations.find((line) => line.includes('./pkg/plain.test.ts'))
      expect(general).toContain('--timeout=1234')
      expect(general).toContain('--max-concurrency=7')
      expect(general).not.toContain('direct-http.test.ts')
      expect(general).not.toContain('boot-http.test.ts')

      const http = invocations.find((line) => line.includes('./pkg/direct-http.test.ts'))
      expect(http).toContain('./pkg/boot-http.test.ts')
      expect(http).toContain('--timeout=1234')
      expect(http).toContain('--max-concurrency=1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The lane is the suite's LARGEST special lane (157 files on this tree). One
  // `bun test` process holding all of them measured 1.1 GB peak RSS — the
  // unbounded-single-process condition this runner exists to prevent (#78). So
  // the lane is chunked at CHUNK_SIZE like the general lane. The isolation is
  // unaffected: batches run one after another, each at --max-concurrency=1, so
  // at most one listener-opening test is ever in flight.
  test('the lane is chunked at CHUNK_SIZE, and every batch keeps serial execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-http-lane-chunk-'))
    try {
      mkdirSync(join(root, 'pkg'), { recursive: true })
      const httpFiles = ['a', 'b', 'c', 'd', 'e']
      for (const name of httpFiles) {
        writeFileSync(
          join(root, 'pkg', `${name}.test.ts`),
          "test('http', () => { const server = Bun.serve({ port: 0, fetch() {} }); server.stop() })\n",
        )
      }
      writeFileSync(join(root, 'pkg', 'plain.test.ts'), "test('plain', () => {})\n")

      const calls = join(root, 'bun-calls.txt')
      const fakeBun = join(root, 'fake-bun')
      writeFileSync(
        fakeBun,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
count=0
for arg in "$@"; do case "$arg" in *.test.ts|*.test.tsx) count=$((count + 1));; esac; done
if [ "$count" -eq 0 ]; then count=6; fi
echo "Ran 1 tests across $count files."
`,
      )
      chmodSync(fakeBun, 0o755)

      const result = spawnSync('bash', [RUN_TESTS], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...(process.env as Record<string, string>),
          NEUTRON_TEST_ROOT: root,
          NEUTRON_BUN_BIN: fakeBun,
          NEUTRON_TEST_DISCOVER_OVERRIDE: [
            './pkg/plain.test.ts',
            ...httpFiles.map((n) => `./pkg/${n}.test.ts`),
          ].join(' '),
          NEUTRON_TEST_CHUNK_SIZE: '2',
        },
      })

      const output = `${result.stdout}${result.stderr}`
      // 5 HTTP files at CHUNK_SIZE 2 => three batches, none larger than 2.
      expect(result.status).toBe(0)
      expect(output).toContain('real-HTTP isolation lane batch 1/3: 2 files')
      expect(output).toContain('real-HTTP isolation lane batch 2/3: 2 files')
      expect(output).toContain('real-HTTP isolation lane batch 3/3: 1 files')

      const invocations = readFileSync(calls, 'utf8').trim().split('\n')
      const httpInvocations = invocations.filter((line) =>
        httpFiles.some((n) => line.includes(`./pkg/${n}.test.ts`)),
      )
      expect(httpInvocations).toHaveLength(3)
      for (const line of httpInvocations) {
        // Every batch is its own process, serial, at or under CHUNK_SIZE files.
        expect(line).toContain('--max-concurrency=1')
        const fileCount = line.split(/\s+/).filter((tok) => tok.endsWith('.test.ts')).length
        expect(fileCount).toBeLessThanOrEqual(2)
        // and it never absorbs the general-lane file
        expect(line).not.toContain('plain.test.ts')
      }
      // Every HTTP file still ran exactly once, and the coverage audit agrees.
      const httpRan = httpInvocations
        .join(' ')
        .split(/\s+/)
        .filter((tok) => tok.endsWith('.test.ts'))
      expect(httpRan.sort()).toEqual(httpFiles.map((n) => `./pkg/${n}.test.ts`).sort())
      expect(output).toContain('files executed: 6 (1 general + 0 PGLite + 0 device + 5 real-HTTP)')
      expect(output).toContain('run-tests: PASS')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
