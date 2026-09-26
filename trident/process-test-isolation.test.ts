import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProcessTestIsolation, needsProcessTestIsolation, processTestLauncher } from './process-test-isolation.ts'

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

for (const refuseCheck of [true, false]) test(refuseCheck
  ? 'unavailable isolation refuses before loading a synthetic suite and preserves the exact Bun CLI'
  : 'an honestly contained synthetic suite reuses its verified boundary without invoking the unavailable launcher', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'process-boundary-proof-'))
  const fixture = join(dir, 'host-suite.test.ts'), loaded = join(dir, 'loaded'), received = join(dir, 'argv')
  try {
    // This synthetic suite has no process operations, even if the refusal breaks.
    await writeFile(fixture, `import { test, expect } from 'bun:test'; import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(loaded)}, 'loaded'); test('selected fixture', () => expect(true).toBe(true));
test('unselected fixture', () => { throw Error('filter was lost'); });`)
    // No namespace syscall or process signalling can occur through this stub.
    await writeFile(join(dir, 'bwrap'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ISOLATION_ARGV_RECEIPT"\necho "fixture namespace unavailable" >&2\nexit 69\n')
    await chmod(join(dir, 'bwrap'), 0o755)
    const python = Bun.spawnSync(['python3', '-c', 'import sys; print(sys.executable)'])
    expect(python.exitCode).toBe(0)
    const realPython = python.stdout.toString().trim()
    const checked = join(dir, 'check-refused')
    if (refuseCheck) {
      // A full-suite parent is already isolated. Force only the verification
      // observation to refuse so the negative control still reaches entry.
      // All real launcher work retains the unchanged Python implementation.
      await writeFile(join(dir, 'python3'), '#!/bin/sh\n'
        + 'if [ "$#" -eq 3 ] && [ "$1" = "-B" ] && [ "$2" = "$ISOLATION_TEST_LAUNCHER" ] && [ "$3" = "--check" ]; then\n'
        + '  printf "refused\\n" > "$ISOLATION_TEST_CHECK"\n  exit 3\nfi\n'
        + 'exec "$ISOLATION_TEST_PYTHON" "$@"\n')
      await chmod(join(dir, 'python3'), 0o755)
    }
    const command = [process.execPath, 'test', fixture, '-t', '^selected fixture$', '--timeout=2345']
    const fixtureEnv = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ISOLATION_ARGV_RECEIPT: received,
      ISOLATION_TEST_LAUNCHER: processTestLauncher, ISOLATION_TEST_PYTHON: realPython, ISOLATION_TEST_CHECK: checked }
    let argv = command, env = fixtureEnv
    if (!refuseCheck) {
      try { assertProcessTestIsolation() } catch {
        // Establish a genuine boundary before installing the fake launcher in
        // the child's PATH. The honest nested child must not need that launcher.
        argv = [realPython, '-B', processTestLauncher, '--', realPython, '-c',
          'import os,sys; os.environ["PATH"] = sys.argv[1]; os.execv(sys.argv[2], sys.argv[2:])',
          fixtureEnv.PATH, ...command]
        env = { ...fixtureEnv, PATH: process.env.PATH! }
      }
    }
    const child = Bun.spawn(argv, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      stdout: 'pipe', stderr: 'pipe',
    })
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
    if (refuseCheck) {
      expect(status).toBe(3)
      expect(await readFile(checked, 'utf8')).toBe('refused\n')
      expect(stderr).toContain('fixture namespace unavailable')
      await expect(readFile(loaded, 'utf8')).rejects.toThrow()
      const receivedArgv = (await readFile(received, 'utf8')).trim().split('\n')
      expect(receivedArgv.slice(-6)).toEqual(command)
    } else {
      expect({ status, stderr: status === 0 ? '' : stderr }).toEqual({ status: 0, stderr: '' })
      expect(stderr).toContain('Process test isolation verified:')
      expect(stderr).toContain('1 pass')
      expect(stderr).toContain('1 filtered out')
      expect(await readFile(loaded, 'utf8')).toBe('loaded')
      await expect(readFile(received, 'utf8')).rejects.toThrow()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
