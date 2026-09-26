import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { needsProcessTestIsolation } from './process-test-isolation.ts'

test('physical suite selection contains the complete invocation and preserves filter arguments', () => {
  for (const args of [[], ['trident'], ['host-suite'], ['trident/codex-build.test.ts'],
    ['open/__tests__/project-build-e2e.test.ts'], ['/tmp/mutation/host-suite.test.ts'],
    ['-t', '__no_matching_case__'], ['--unknown-option', 'pure.test.ts']]) {
    expect(needsProcessTestIsolation(['bun', 'test', ...args], '/repo')).toBe(true)
  }
  for (const args of [['trident/process-test-isolation.test.ts'],
    ['pure.test.ts', '-t', 'host-suite', '--timeout', '15000'],
    ['pure.test.ts', '--test-name-pattern=host-suite', '--timeout=15000']]) {
    expect(needsProcessTestIsolation(['bun', 'test', ...args], '/repo')).toBe(false)
  }
})

test('the isolation preload precedes both existing environment scrubbers', () => {
  const config = readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8')
  expect(config).toContain('preload = ["./tests/support/process-test-isolation-preload.ts", "./tests/support/scrub-substrate-env.ts", "./tests/support/scrub-instance-env.ts"]')
  const preload = readFileSync(new URL('../tests/support/process-test-isolation-preload.ts', import.meta.url), 'utf8')
  expect(preload).toContain("readFileSync('/proc/self/cmdline'")
  expect(preload).toContain('...argv.slice(1)')
  expect(preload).toContain("'--parent-pid', String(process.pid)")
  expect(preload).toContain('process.exit(result.status ?? 3)')
})

test('namespace refusal and honest-boundary controls use only mocked process operations', async () => {
  const child = Bun.spawn(['python3', '-B', fileURLToPath(new URL('./process-test-isolation-test.py', import.meta.url)), '-v'], {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
  })
  const [status, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, stdout, stderr: status === 0 ? '' : stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
  expect(stderr).toContain('Ran 13 tests')
})

test('unavailable isolation refuses before loading a synthetic suite and preserves the exact Bun CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'process-boundary-proof-'))
  const fixture = join(dir, 'host-suite.test.ts'), loaded = join(dir, 'loaded'), received = join(dir, 'argv')
  try {
    // This synthetic suite has no process operations, even if the refusal breaks.
    await writeFile(fixture, `import { test, expect } from 'bun:test'; import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(loaded)}, 'loaded'); test('selected fixture', () => expect(true).toBe(true));`)
    // No namespace syscall or process signalling can occur through this stub.
    await writeFile(join(dir, 'bwrap'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ISOLATION_ARGV_RECEIPT"\necho "fixture namespace unavailable" >&2\nexit 69\n')
    await chmod(join(dir, 'bwrap'), 0o755)
    const child = Bun.spawn([process.execPath, 'test', fixture, '-t', 'selected fixture', '--timeout=2345'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ISOLATION_ARGV_RECEIPT: received },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
    expect(status).toBe(3)
    expect(stderr).toContain('fixture namespace unavailable')
    await expect(readFile(loaded, 'utf8')).rejects.toThrow()
    const argv = (await readFile(received, 'utf8')).trim().split('\n')
    expect(argv.slice(-6)).toEqual([process.execPath, 'test', fixture, '-t', 'selected fixture', '--timeout=2345'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
