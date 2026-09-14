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
        'real-HTTP isolation lane: 2 files (own process, max-concurrency=1, timeout=1234ms)',
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
})
