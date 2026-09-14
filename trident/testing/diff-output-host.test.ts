import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMergeCleanupDeps } from '../merge.ts'
import { buildTridentOrchestrator } from '../orchestrator.ts'
import {
  makeCredentialedHostRunner,
  makeLazyCredentialedHostRunner,
  spawnCapture,
  type DiffOutputHost,
} from '../git-mode.ts'
import { honourDiffOutput } from './diff-output-host.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'diff-output-host-test-'))
  directories.push(path)
  return path
}
const ok = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '' })

test('bare fake is rejected synchronously at merge construction before any command', () => {
  let calls = 0
  const fake = async () => { calls++; return ok() }
  // @ts-expect-error A command callback alone is structurally incomplete.
  const construct = () => buildMergeCleanupDeps(fake)
  expect(construct).toThrow('run_host must implement git diff --output=')
  expect(calls).toBe(0)
  expect(() => buildMergeCleanupDeps(honourDiffOutput(fake))).not.toThrow()
  expect(calls).toBe(0)
})

test('orchestrator rejects a bare fake even with custom merge dependencies', () => {
  let calls = 0
  const fake = async () => { calls++; return ok() }
  const construct = (run_host: DiffOutputHost) => buildTridentOrchestrator({
    run_host,
    fire_workflow: async () => { throw new Error('must not launch') },
    db_path: join(directory(), 'project.db'),
    merge_deps: {},
  })
  // @ts-expect-error Even an orchestrator bypassing default merge needs a complete host.
  expect(() => construct(fake)).toThrow('run_host must implement git diff --output=')
  expect(() => construct(honourDiffOutput(fake))).not.toThrow()
  expect(calls).toBe(0)
})

test('shared factory writes UTF-8 bytes, including measured zero, and forwards command context', async () => {
  const dir = directory()
  for (const patch of ['', 'é\n🛠\n']) {
    const path = join(dir, `patch-${Buffer.byteLength(patch)}`)
    const cmd = ['git', 'diff', `--output=${path}`]
    const env = { DIFF_TEST: 'sentinel' }
    const host = honourDiffOutput(async (actual: string[], cwd?: string, actualEnv?: Record<string, string>, timeout?: number) => {
      expect(actual).toBe(cmd)
      expect(cwd).toBe(dir)
      expect(actualEnv).toBe(env)
      expect(timeout).toBe(123)
      return ok(patch)
    })
    expect(() => buildMergeCleanupDeps(host)).not.toThrow()
    await host(cmd, dir, env, 123)
    expect(statSync(path).size).toBe(Buffer.byteLength(patch))
    expect(readFileSync(path, 'utf8')).toBe(patch)
  }
})

test('shared factory preserves explicitly supplied binary evidence', async () => {
  const path = join(directory(), 'patch')
  const bytes = Buffer.from([0, 255, 128, 10])
  const host = honourDiffOutput(async () => { writeFileSync(path, bytes); return ok('different') })
  await host(['git', 'diff', `--output=${path}`])
  expect(readFileSync(path)).toEqual(bytes)
})

for (const [name, makeHost] of [
  ['spawn', () => spawnCapture],
  ['credentialed', () => makeCredentialedHostRunner({})],
  ['lazy credentialed', () => makeLazyCredentialedHostRunner(async () => ({}))],
] as const) {
  test(`${name} host supplies actual byte-exact git output, including failed-command files`, async () => {
    const dir = directory()
    const host = makeHost()
    expect(() => buildMergeCleanupDeps(host)).not.toThrow()
    expect((await host(['git', 'init', '-q', dir])).ok).toBe(true)
    writeFileSync(join(dir, 'file'), 'before\n')
    expect((await host(['git', 'add', 'file'], dir)).ok).toBe(true)
    writeFileSync(join(dir, 'file'), 'after é\n')
    // spawnCapture trims stdout; compare with raw git bytes instead.
    const raw = Bun.spawn(['git', 'diff', '--binary', '--full-index'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(raw.stdout).arrayBuffer()
    expect(await raw.exited).toBe(0)
    const path = join(dir, 'patch')
    const output = await host(['git', 'diff', '--binary', '--full-index', `--output=${path}`], dir)
    expect(output.ok).toBe(true)
    expect(output.stdout).toBe('')
    expect(statSync(path).size).toBe(stdout.byteLength)
    expect(statSync(path).size).toBeGreaterThan(0)
    const failurePath = join(dir, 'failed-patch')
    const failure = await host(['git', 'diff', `--output=${failurePath}`, 'missing-ref'], dir)
    expect(failure.exit_code).toBe(128)
    expect(failure.ok).toBe(false)
    expect(statSync(failurePath).size).toBe(0)
  })
}
