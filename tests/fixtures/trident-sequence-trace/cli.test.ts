import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The decoder and validator are deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
const RUN_ID = 'run-fixture-1'
let dir = ''

type Event = { task: number; kind: string; remainingTasks: number }
type Result = { code: number; stdout: string; stderr: string }

const C1 = { task: 1, kind: 'continued', remainingTasks: 2 }
const C2 = { task: 2, kind: 'continued', remainingTasks: 1 }
const M3 = { task: 3, kind: 'merged', remainingTasks: 0 }

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sequence-trace-cli-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function run(...args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: dir })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, stdout, stderr }
}

async function inputFile(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

async function traceFile(taskCount: number, events: readonly Event[], runId = RUN_ID): Promise<string> {
  return inputFile('trace.json', JSON.stringify({ runId, taskCount, events }))
}

/** A structurally valid trace: exactly one result line, the given exit, empty stderr. */
function expectResult(result: Result, code: number, expected: unknown): void {
  expect(result.code).toBe(code)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`)
  const lines = result.stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  expect(JSON.parse(lines[0]!)).toEqual(expected)
}

test('an accepted three-task trace prints exactly one JSON result line and exits zero', async () => {
  const result = await run(await traceFile(3, [C1, C2, M3]))
  expectResult(result, 0, { status: 'accepted', runId: RUN_ID, taskCount: 3 })
  expect(result.stdout).toBe('{"status":"accepted","runId":"run-fixture-1","taskCount":3}\n')
})

test('an accepted two-task trace exits zero', async () => {
  const result = await run(await traceFile(2, [
    { task: 1, kind: 'continued', remainingTasks: 1 },
    { task: 2, kind: 'merged', remainingTasks: 0 },
  ]))
  expectResult(result, 0, { status: 'accepted', runId: RUN_ID, taskCount: 2 })
})

test('a one-of-three prefix is incomplete: one result line, exit one, empty stderr', async () => {
  const result = await run(await traceFile(3, [C1]))
  expectResult(result, 1, { status: 'incomplete', runId: RUN_ID, taskCount: 3, completedTasks: 1, nextTask: 2 })
})

test('an empty event list is incomplete at task one', async () => {
  const result = await run(await traceFile(3, []))
  expectResult(result, 1, { status: 'incomplete', runId: RUN_ID, taskCount: 3, completedTasks: 0, nextTask: 1 })
})

test('no proper prefix of a legitimate trace ever exits zero', async () => {
  const full = [C1, C2, M3]
  for (let length = 0; length < full.length; length += 1) {
    const result = await run(await traceFile(3, full.slice(0, length)))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout).status).toBe('incomplete')
  }
})

test.each<[string, number, Event[], string]>([
  ['a merge before the final task', 3, [{ task: 1, kind: 'merged', remainingTasks: 2 }], 'event 0: merged before the final task'],
  ['a repeated task', 3, [C1, C1], 'event 1: task is not the next task'],
  ['a skipped task', 3, [C1, M3], 'event 1: task is not the next task'],
  ['an event after the merge', 2, [
    { task: 1, kind: 'continued', remainingTasks: 1 },
    { task: 2, kind: 'merged', remainingTasks: 0 },
    { task: 2, kind: 'merged', remainingTasks: 0 },
  ], 'event 2: follows the merge'],
  ['a remainingTasks mismatch', 3, [{ task: 1, kind: 'continued', remainingTasks: 1 }], 'event 0: remainingTasks does not match the task'],
  ['a final task that continued', 3, [C1, C2, { task: 3, kind: 'continued', remainingTasks: 0 }], 'event 2: final task did not merge'],
])('a rejected trace prints one result line and exits one: %s', async (_name, taskCount, events, reason) => {
  const result = await run(await traceFile(taskCount, events))
  expectResult(result, 1, { status: 'rejected', reason })
})

test('a rejected trace never echoes its run identity', async () => {
  const result = await run(await traceFile(3, [{ task: 1, kind: 'merged', remainingTasks: 2 }], sentinel))
  expectResult(result, 1, { status: 'rejected', reason: 'event 0: merged before the final task' })
  expect(result.stdout).not.toContain(sentinel)
  expect(result.stderr).not.toContain(sentinel)
})

function expectRefused(result: Result): void {
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim().length).toBeGreaterThan(0)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
  expect(result.stderr).not.toContain(sentinel)
}

test('no argument is refused as usage', async () => {
  const result = await run()
  expectRefused(result)
  expect(result.code).toBe(2)
})

test('two arguments are refused as usage', async () => {
  const path = await traceFile(3, [C1, C2, M3])
  const result = await run(path, path)
  expectRefused(result)
  expect(result.code).toBe(2)
})

test('a nonexistent path is refused', async () => {
  const result = await run(join(dir, `${sentinel}.json`))
  expectRefused(result)
  expect(result.code).toBe(1)
})

test('malformed JSON is refused without echoing its bytes', async () => {
  const result = await run(await inputFile('bad.json', `{"runId": "${sentinel}`))
  expectRefused(result)
  expect(result.code).toBe(1)
})

test.each<[string, unknown]>([
  ['a JSON array', [sentinel]],
  ['JSON null', null],
  ['a JSON string', sentinel],
  ['a runId with surrounding whitespace', { runId: ` ${sentinel} `, taskCount: 3, events: [] }],
  ['taskCount one', { runId: sentinel, taskCount: 1, events: [] }],
  ['events not an array', { runId: sentinel, taskCount: 3, events: sentinel }],
  ['an event kind outside the grammar', { runId: sentinel, taskCount: 3, events: [{ task: 1, kind: sentinel, remainingTasks: 2 }] }],
  ['an event task beyond taskCount', { runId: sentinel, taskCount: 2, events: [{ task: 3, kind: 'merged', remainingTasks: 0 }] }],
])('structurally invalid input is refused without echoing its bytes: %s', async (_name, body) => {
  const result = await run(await inputFile('invalid.json', JSON.stringify(body)))
  expectRefused(result)
  expect(result.code).toBe(1)
  expect(result.stderr).toStartWith('trace: ')
})

test('a refusal is distinguishable from a rejection by its empty stdout', async () => {
  const refused = await run(await inputFile('refused.json', JSON.stringify({ runId: RUN_ID, taskCount: 1, events: [] })))
  const rejected = await run(await traceFile(3, [{ task: 1, kind: 'merged', remainingTasks: 2 }]))
  expect(refused.code).not.toBe(0)
  expect(rejected.code).not.toBe(0)
  expect(refused.stdout).toBe('')
  expect(refused.stderr).not.toBe('')
  expect(rejected.stdout).not.toBe('')
  expect(rejected.stderr).toBe('')
})

test('the input file is never modified on success or failure', async () => {
  const good = await inputFile('good.json', JSON.stringify({ runId: RUN_ID, taskCount: 3, events: [C1, C2, M3] }))
  const bad = await inputFile('bad.json', JSON.stringify({ runId: RUN_ID, taskCount: 3, events: [{ task: 1, kind: sentinel, remainingTasks: 2 }] }))
  const goodBefore = await readFile(good)
  const badBefore = await readFile(bad)
  expect((await run(good)).code).toBe(0)
  expect((await run(bad)).code).not.toBe(0)
  expect((await readFile(good)).equals(goodBefore)).toBe(true)
  expect((await readFile(bad)).equals(badBefore)).toBe(true)
})
