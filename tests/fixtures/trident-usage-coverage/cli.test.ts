import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The reducer is deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
let dir = ''

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'usage-coverage-cli-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cli, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: dir })
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code, stdout, stderr }
}

async function inputFile(name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

test('valid input prints exactly one JSON summary line and exits zero', async () => {
  const path = await inputFile('valid.json', JSON.stringify([
    { attemptId: 'a', outcome: 'completed', tokens: 7 },
    { attemptId: 'b', outcome: 'failed', tokens: 5 },
    { attemptId: 'c', outcome: 'completed', tokens: 0 },
  ]))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(`${JSON.stringify({ knownTokens: 12, unknownAttempts: 0, complete: true })}\n`)
  const lines = result.stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  expect(JSON.parse(lines[0]!)).toEqual({ knownTokens: 12, unknownAttempts: 0, complete: true })
})

test('valid input with an unknown measurement still succeeds and reports incomplete coverage', async () => {
  const path = await inputFile('unknown.json', JSON.stringify([
    { attemptId: 'a', outcome: 'completed', tokens: 7 },
    { attemptId: 'b', outcome: 'completed', tokens: null },
  ]))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(`${JSON.stringify({ knownTokens: 7, unknownAttempts: 1, complete: false })}\n`)
})

test('an empty record array is a valid, complete input', async () => {
  const result = await run(await inputFile('empty.json', '[]'))
  expect(result.code).toBe(0)
  expect(result.stdout).toBe(`${JSON.stringify({ knownTokens: 0, unknownAttempts: 0, complete: true })}\n`)
})

async function expectRefused(result: { code: number; stdout: string; stderr: string }): Promise<void> {
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim().length).toBeGreaterThan(0)
  expect(result.stderr).not.toContain(sentinel)
}

test('no argument is refused', async () => {
  await expectRefused(await run())
})

test('two arguments are refused', async () => {
  const path = await inputFile('valid.json', '[]')
  await expectRefused(await run(path, path))
})

test('a nonexistent path is refused', async () => {
  await expectRefused(await run(join(dir, 'missing.json')))
})

test('malformed JSON is refused without echoing its bytes', async () => {
  await expectRefused(await run(await inputFile('bad.json', `[{"attemptId": "${sentinel}", `)))
})

test('valid JSON that is not an array is refused', async () => {
  await expectRefused(await run(await inputFile('object.json', JSON.stringify({ attemptId: sentinel, outcome: 'completed', tokens: 1 }))))
})

test.each([
  ['duplicate attemptId', [{ attemptId: sentinel, outcome: 'completed', tokens: 1 }, { attemptId: sentinel, outcome: 'failed', tokens: 2 }]],
  ['negative tokens', [{ attemptId: sentinel, outcome: 'completed', tokens: -1 }]],
  ['outcome blocked', [{ attemptId: sentinel, outcome: 'blocked', tokens: 1 }]],
] as const)('reducer rejection is refused without echoing record values: %s', async (_label, records) => {
  await expectRefused(await run(await inputFile('invalid.json', JSON.stringify(records))))
})

test('the input file is never modified on success or failure', async () => {
  const good = await inputFile('good.json', JSON.stringify([{ attemptId: 'a', outcome: 'completed', tokens: 3 }]))
  const bad = await inputFile('bad.json', JSON.stringify([{ attemptId: 'a', outcome: 'completed', tokens: 1.5 }]))
  const goodBefore = await readFile(good)
  const badBefore = await readFile(bad)
  expect((await run(good)).code).toBe(0)
  expect((await run(bad)).code).not.toBe(0)
  expect((await readFile(good)).equals(goodBefore)).toBe(true)
  expect((await readFile(bad)).equals(badBefore)).toBe(true)
})
