import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The decoder and validator are deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
let dir = ''

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sequence-trace-cli-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface CliResult { code: number; stdout: string; stderr: string }

async function run(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: dir })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, stdout, stderr }
}

async function inputFile(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

const c = (task: number, remainingTasks: number) => ({ task, kind: 'continued', remainingTasks })
const m = (task: number, remainingTasks: number) => ({ task, kind: 'merged', remainingTasks })

function traceFile(name: string, taskCount: number, events: readonly unknown[]): Promise<string> {
  return inputFile(name, JSON.stringify({ runId: 'run-1', taskCount, events }))
}

function resultLine(result: CliResult): Record<string, unknown> {
  const lines = result.stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

test('an accepted two-task trace prints exactly one JSON result line and exits zero', async () => {
  const result = await run(await traceFile('accepted.json', 2, [c(1, 1), m(2, 0)]))
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('{"runId":"run-1","taskCount":2,"events":2,"verdict":"accepted"}\n')
  expect(resultLine(result)).toEqual({ runId: 'run-1', taskCount: 2, events: 2, verdict: 'accepted' })
})

test('an accepted three-task trace exits zero', async () => {
  const result = await run(await traceFile('accepted3.json', 3, [c(1, 2), c(2, 1), m(3, 0)]))
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(resultLine(result)).toEqual({ runId: 'run-1', taskCount: 3, events: 3, verdict: 'accepted' })
})

test.each([
  ['a proper prefix', [c(1, 1)], 1],
  ['no events', [], 0],
] as const)('an incomplete trace prints its verdict and exits nonzero: %s', async (_label, events, count) => {
  const result = await run(await traceFile('incomplete.json', 2, events))
  expect(result.code).not.toBe(0)
  expect(result.stderr).toBe('')
  expect(resultLine(result)).toEqual({ runId: 'run-1', taskCount: 2, events: count, verdict: 'incomplete' })
})

test.each([
  ['premature merge', [m(1, 0)]],
  ['events after merge', [c(1, 1), m(2, 0), m(2, 0)]],
  ['wrong remaining count', [c(1, 0), m(2, 0)]],
] as const)('a rejected trace prints its verdict and exits nonzero: %s', async (_label, events) => {
  const result = await run(await traceFile('rejected.json', 2, events))
  expect(result.code).not.toBe(0)
  expect(result.stderr).toBe('')
  expect(resultLine(result)).toEqual({ runId: 'run-1', taskCount: 2, events: events.length, verdict: 'rejected' })
})

async function expectRefused(result: CliResult): Promise<void> {
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim().length).toBeGreaterThan(0)
  expect(result.stderr).not.toContain(sentinel)
}

test('no argument is refused', async () => {
  await expectRefused(await run())
})

test('two arguments are refused', async () => {
  const path = await traceFile('accepted.json', 2, [c(1, 1), m(2, 0)])
  await expectRefused(await run(path, path))
})

test('a nonexistent path is refused', async () => {
  await expectRefused(await run(join(dir, 'missing.json')))
})

test('malformed JSON is refused without echoing its bytes', async () => {
  await expectRefused(await run(await inputFile('bad.json', `{"runId": "${sentinel}", `)))
})

test.each([
  ['an array', [{ runId: sentinel, taskCount: 2, events: [] }]],
  ['an object missing events', { runId: sentinel, taskCount: 2 }],
  ['taskCount 1', { runId: sentinel, taskCount: 1, events: [] }],
  ['an unknown event kind', { runId: 'run-1', taskCount: 2, events: [{ task: 1, kind: sentinel, remainingTasks: 1 }] }],
  ['task 0', { runId: 'run-1', taskCount: 2, events: [{ task: 0, kind: 'continued', remainingTasks: 1, note: sentinel }] }],
  ['negative remainingTasks', { runId: 'run-1', taskCount: 2, events: [{ task: 1, kind: 'continued', remainingTasks: -1, note: sentinel }] }],
] as const)('structurally invalid JSON is refused without echoing values: %s', async (_label, value) => {
  await expectRefused(await run(await inputFile('invalid.json', JSON.stringify(value))))
})

test('the input file is never modified on an accepted or a refused run', async () => {
  const good = await traceFile('good.json', 2, [c(1, 1), m(2, 0)])
  const bad = await inputFile('bad.json', JSON.stringify({ runId: 'run-1', taskCount: 2, events: [{ task: 1.5, kind: 'continued', remainingTasks: 1 }] }))
  const goodBefore = await readFile(good)
  const badBefore = await readFile(bad)
  expect((await run(good)).code).toBe(0)
  const refused = await run(bad)
  expect(refused.code).not.toBe(0)
  expect(refused.stdout).toBe('')
  expect((await readFile(good)).equals(goodBefore)).toBe(true)
  expect((await readFile(bad)).equals(badBefore)).toBe(true)
})
