import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { isolatePackageLauncherEnvironment } from './package-launcher-fixture-env.ts'

test('nested launcher fixture restores its owned inputs without reverting unrelated changes', () => {
  const env: Record<string, string | undefined> = {
    npm_lifecycle_event: 'outer-test', NODE: 'outer-node', ENV: '', NODE_ENV: 'test', PATH: 'outer-path', UNRELATED: 'before',
  }
  const restore = isolatePackageLauncherEnvironment(env)
  expect(env).toEqual({ NODE_ENV: 'test', PATH: 'outer-path', UNRELATED: 'before' })
  env.npm_lifecycle_event = 'nested-test'
  env.BUN_OPTIONS = 'fixture-added'
  env.UNRELATED = 'during'
  restore()
  expect(env).toEqual({ npm_lifecycle_event: 'outer-test', NODE: 'outer-node', ENV: '', NODE_ENV: 'test', PATH: 'outer-path', UNRELATED: 'during' })
  env.npm_lifecycle_event = 'after-restore'
  restore()
  expect(env.npm_lifecycle_event).toBe('after-restore')
})

for (const [file, pattern] of [
  ['project-suite-identity.test.ts', '^portable package launcher observes its inner closure and retains package PATH semantics$'],
  ['project-build-e2e.test.ts', '^prepared cross-run package suite proof handles none inputs in a distinct retry worktree$'],
] as const) test(`real outer package script preserves the ${file} nested launcher control`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'package-fixture-outer-'))
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  const target = fileURLToPath(new URL(file, import.meta.url))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'outer-launcher-fixture', scripts: { test: `${quote(process.execPath)} entry.ts` },
    }))
    await writeFile(join(directory, 'entry.ts'), `
if (process.env.npm_lifecycle_event !== 'test' || !process.env.npm_package_json || !process.env.NODE) {
  throw new Error('Outer package launcher inputs were not established')
}
const child = Bun.spawn(${JSON.stringify([process.execPath, 'test', target, '--test-name-pattern', pattern])},
  { cwd: ${JSON.stringify(repository)}, stdout: 'pipe', stderr: 'pipe' })
const [exit, stdout, stderr] = await Promise.all([child.exited,
  new Response(child.stdout).text(), new Response(child.stderr).text()])
process.stdout.write(stdout)
process.stderr.write(stderr)
process.exit(exit)
`)
    const result = await spawnCapture([process.execPath, 'run', 'test'], directory, undefined, 60_000)
    expect(result.exit_code, result.stdout + result.stderr).toBe(0)
    expect(result.stderr).toContain('1 pass')
    expect(result.stderr).toContain('0 fail')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 70_000)
