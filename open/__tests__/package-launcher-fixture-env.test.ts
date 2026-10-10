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

// Nested budgets, innermost first; each layer outlives the one it contains.
// `caseMs` is the selected case's own limit. The nested `bun test` receives it
// as `--timeout`, replacing Bun's 5s default that the suite runner never uses
// (scripts/run-tests.sh defaults to 15s). The prepared retry case declares its
// own 120s limit, which an explicit per-test timeout keeps over `--timeout`.
const NESTED_STARTUP_MARGIN_MS = 15_000 // nested Bun start, preloads, import and hooks
const LAUNCHER_MARGIN_MS = 5_000 // outer `bun run test` and entry reporting
const CLEANUP_MARGIN_MS = 10_000 // outer temp-directory removal and assertions

/** Exact Bun summary counts; a missing or repeated line is null. */
function testSummary(output: string) {
  const count = (label: string) => {
    const lines = [...output.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, 'gm'))]
    return lines.length === 1 ? Number(lines[0]![1]) : null
  }
  const ran = [...output.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)]
  return {
    pass: count('pass'), fail: count('fail'),
    ran: ran.length === 1 ? Number(ran[0]![1]) : null,
    files: ran.length === 1 ? Number(ran[0]![2]) : null,
  }
}

test('nested summary parser reads exact counts and refuses near misses', () => {
  const exact = ' 1 pass\n 45 filtered out\n 0 fail\n 3 expect() calls\nRan 1 test across 1 file. [844.00ms]'
  expect(testSummary(exact)).toEqual({ pass: 1, fail: 0, ran: 1, files: 1 })
  expect(testSummary(exact.replace(' 1 pass', ' 11 pass').replace(' 0 fail', ' 10 fail')))
    .toEqual({ pass: 11, fail: 10, ran: 1, files: 1 })
  expect(testSummary('(pass) 1 pass\n')).toEqual({ pass: null, fail: null, ran: null, files: null })
  expect(testSummary(`${exact}\n${exact}`)).toEqual({ pass: null, fail: null, ran: null, files: null })
  expect(testSummary('error: regex "^x$" matched 0 tests. Searched 1 file (skipping 46 tests) [67.00ms]'))
    .toEqual({ pass: null, fail: null, ran: null, files: null })
})

for (const { file, pattern, caseMs } of [
  { file: 'project-suite-identity.test.ts', pattern: '^portable package launcher observes its inner closure and retains package PATH semantics$', caseMs: 30_000 },
  { file: 'project-build-e2e.test.ts', pattern: '^prepared cross-run package suite proof handles none inputs in a distinct retry worktree$', caseMs: 120_000 },
] as const) {
  const childMs = caseMs + NESTED_STARTUP_MARGIN_MS
  const launcherMs = childMs + LAUNCHER_MARGIN_MS
  test(`real outer package script preserves the ${file} nested launcher control`, async () => {
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
const child = Bun.spawn(${JSON.stringify([process.execPath, 'test', target, '--timeout', String(caseMs), '--test-name-pattern', pattern])},
  { cwd: ${JSON.stringify(repository)}, stdout: 'pipe', stderr: 'pipe' })
let expired = false
const watchdog = setTimeout(() => { expired = true; child.kill() }, ${childMs})
const [exit, stdout, stderr] = await Promise.all([child.exited,
  new Response(child.stdout).text(), new Response(child.stderr).text()])
clearTimeout(watchdog)
process.stdout.write(stdout)
process.stderr.write(stderr)
if (expired) {
  process.stderr.write('\\nnested bun test exceeded its ${childMs}ms budget and was killed\\n')
  process.exit(124)
}
process.exit(exit)
`)
      const started = performance.now()
      const result = await spawnCapture([process.execPath, 'run', 'test'], directory, undefined, launcherMs)
      const summary = testSummary(result.stderr)
      const diagnostic = `${JSON.stringify({ file, pattern, exit: result.exit_code, timedOut: result.timed_out === true,
        elapsedMs: Math.round(performance.now() - started), caseMs, childMs, launcherMs, summary })}\n${result.stdout}\n${result.stderr}`
      expect(result.timed_out === true, diagnostic).toBe(false)
      expect(result.exit_code, diagnostic).toBe(0)
      // Exactly one selected case ran and passed; zero matches is a failure.
      expect(summary, diagnostic).toEqual({ pass: 1, fail: 0, ran: 1, files: 1 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, launcherMs + CLEANUP_MARGIN_MS)
}
