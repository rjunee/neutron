import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { assertProcessTestIsolation, processTestLauncher } from './process-test-isolation.ts'

assertProcessTestIsolation()

test('real lane process lifecycle and pidfd refusal proofs', async () => {
  // unittest's verbose stream names the exact lifecycle proof before running it.
  // Keep successful output quiet, but preserve that stream verbatim on failure.
  const child = Bun.spawn(['python3', '-B', fileURLToPath(new URL('./lane-processes-test.py', import.meta.url)), '-v'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stdout: '', stderr: '' })
}, 30_000)

test('the consuming project and composer suites survive a claim from their parent PID namespace', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const owner = fileURLToPath(new URL('./lane-processes.py', import.meta.url))
  // This test's verified outer boundary contains every signal even when the
  // owner is mutated. The inner boundary reproduces the inherited foreign PID.
  for (const claimed of [false, true]) {
    const command = ['python3', '-B', processTestLauncher, '--', process.execPath, 'test',
      'open/__tests__/project-build-e2e.test.ts', 'open/__tests__/route-slot-coverage.test.ts',
      '-t', 'review trace normalization accepts|the probe is alive', '--timeout=15000']
    const env = { ...process.env }
    delete env.NEUTRON_LANE_CLAIM
    const child = Bun.spawn(claimed ? ['python3', '-B', owner, 'run', '--', ...command] : command, {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect({ claimed, code, stdout: code === 0 ? '' : stdout, stderr: code === 0 ? '' : stderr })
      .toEqual({ claimed, code: 0, stdout: '', stderr: '' })
    expect(stderr).toContain('2 pass')
    expect(stderr).toContain('0 fail')
    expect(stderr).toContain('Process test isolation verified:')
  }
}, 45_000)
