import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The validator is deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
let dir = ''

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'child-overlap-cli-')) })
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

function expectOneLine(result: CliResult, expected: Record<string, unknown>): void {
  expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`)
  const lines = result.stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  expect(JSON.parse(lines[0]!)).toEqual(expected)
}

test('overlap with one unknown input count prints one result line and exits zero', async () => {
  const path = await inputFile('unknown.json', JSON.stringify([
    { childId: 'child-a', acceptedAt: 1000, finishedAt: 5000, inputTokens: 1200 },
    { childId: 'child-b', acceptedAt: 3000, finishedAt: 9000, inputTokens: null },
  ]))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result, { overlap: true, overlapDuration: 2000, knownInputTokens: 1200, unknownChildren: 1, complete: false })
})

test('overlap with a measured zero keeps the zero known and exits zero', async () => {
  const path = await inputFile('zero.json', JSON.stringify([
    { childId: 'child-a', acceptedAt: 1000, finishedAt: 5000, inputTokens: 0 },
    { childId: 'child-b', acceptedAt: 3000, finishedAt: 9000, inputTokens: 450 },
  ]))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result, { overlap: true, overlapDuration: 2000, knownInputTokens: 450, unknownChildren: 0, complete: true })
})

test('valid touching intervals print the result once and exit nonzero', async () => {
  const path = await inputFile('touching.json', JSON.stringify([
    { childId: 'child-a', acceptedAt: 1000, finishedAt: 5000, inputTokens: 10 },
    { childId: 'child-b', acceptedAt: 5000, finishedAt: 9000, inputTokens: 20 },
  ]))
  const result = await run(path)
  expect(result.code).toBe(3)
  expect(result.stderr).toBe('')
  expectOneLine(result, { overlap: false, overlapDuration: 0, knownInputTokens: 30, unknownChildren: 0, complete: true })
})

test('valid serial intervals print the result once and exit nonzero', async () => {
  const path = await inputFile('serial.json', JSON.stringify([
    { childId: 'child-b', acceptedAt: 6000, finishedAt: 9000, inputTokens: null },
    { childId: 'child-a', acceptedAt: 1000, finishedAt: 5000, inputTokens: 10 },
  ]))
  const result = await run(path)
  expect(result.code).toBe(3)
  expect(result.stderr).toBe('')
  expectOneLine(result, { overlap: false, overlapDuration: 0, knownInputTokens: 10, unknownChildren: 1, complete: false })
})

async function expectRefused(result: CliResult): Promise<void> {
  expect(result.code).not.toBe(0)
  expect(result.code).not.toBe(3)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim().length).toBeGreaterThan(0)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
  expect(result.stderr).not.toContain(sentinel)
}

test('no argument is refused as a usage error', async () => {
  const result = await run()
  await expectRefused(result)
  expect(result.code).toBe(2)
})

test('two arguments are refused as a usage error', async () => {
  const path = await inputFile('valid.json', '[]')
  const result = await run(path, path)
  await expectRefused(result)
  expect(result.code).toBe(2)
})

test('a nonexistent path is refused', async () => {
  const result = await run(join(dir, 'missing.json'))
  await expectRefused(result)
  expect(result.stderr).toBe('cannot read input file\n')
})

test('malformed JSON is refused without echoing its bytes', async () => {
  const result = await run(await inputFile('bad.json', `[{"childId": "${sentinel}", `))
  await expectRefused(result)
  expect(result.stderr).toBe('input is not valid JSON\n')
})

test.each([
  ['a single object', { childId: sentinel, acceptedAt: 0, finishedAt: 10, inputTokens: 1 }],
  ['one record', [{ childId: sentinel, acceptedAt: 0, finishedAt: 10, inputTokens: 1 }]],
  ['three records', [
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: 'b', acceptedAt: 5, finishedAt: 15, inputTokens: 1 },
    { childId: sentinel, acceptedAt: 6, finishedAt: 16, inputTokens: 1 },
  ]],
  ['an extra key', [
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: 'b', acceptedAt: 5, finishedAt: 15, inputTokens: 1, note: sentinel },
  ]],
  ['a duplicate childId', [
    { childId: sentinel, acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: sentinel, acceptedAt: 5, finishedAt: 15, inputTokens: 1 },
  ]],
  ['a reversed interval', [
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: sentinel, acceptedAt: 15, finishedAt: 5, inputTokens: 1 },
  ]],
  ['a negative inputTokens', [
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: sentinel, acceptedAt: 5, finishedAt: 15, inputTokens: -1 },
  ]],
  ['a numeric-string inputTokens', [
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1 },
    { childId: sentinel, acceptedAt: 5, finishedAt: 15, inputTokens: '7' },
  ]],
] as const)('validator rejection is refused without echoing record values: %s', async (_label, payload) => {
  const result = await run(await inputFile('invalid.json', JSON.stringify(payload)))
  await expectRefused(result)
  expect(result.code).toBe(1)
  expect(result.stderr).toStartWith('invalid child-overlap input: ')
})

test('the input file is never modified on success, non-overlap or refusal', async () => {
  const good = await inputFile('good.json', JSON.stringify([
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: null },
    { childId: 'b', acceptedAt: 5, finishedAt: 15, inputTokens: 3 },
  ]))
  const serial = await inputFile('serial.json', JSON.stringify([
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 0 },
    { childId: 'b', acceptedAt: 10, finishedAt: 15, inputTokens: 3 },
  ]))
  const bad = await inputFile('bad.json', JSON.stringify([
    { childId: 'a', acceptedAt: 0, finishedAt: 10, inputTokens: 1.5 },
    { childId: 'b', acceptedAt: 5, finishedAt: 15, inputTokens: 3 },
  ]))
  const goodBefore = await readFile(good)
  const serialBefore = await readFile(serial)
  const badBefore = await readFile(bad)
  expect((await run(good)).code).toBe(0)
  expect((await run(serial)).code).toBe(3)
  expect((await run(bad)).code).toBe(1)
  expect((await readFile(good)).equals(goodBefore)).toBe(true)
  expect((await readFile(serial)).equals(serialBefore)).toBe(true)
  expect((await readFile(bad)).equals(badBefore)).toBe(true)
})
