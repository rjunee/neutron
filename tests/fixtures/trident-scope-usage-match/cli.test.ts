import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The comparator is deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
let dir = ''

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'scope-usage-match-cli-')) })
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

const scope = { task: 'build card 42', gates: 'suite+typecheck', models: 'opus/high' }

function expectOneLine(stdout: string, expected: unknown): void {
  expect(stdout).toBe(`${JSON.stringify(expected)}\n`)
  const lines = stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  expect(JSON.parse(lines[0]!)).toEqual(expected)
}

function expectRefused(result: { code: number; stdout: string; stderr: string }, code: number): void {
  expect(result.code).toBe(code)
  expect(result.stdout).toBe('')
  const lines = result.stderr.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]!.length).toBeGreaterThan(0)
  expect(lines[1]).toBe('')
  expect(result.stderr).not.toContain(sentinel)
}

test('a known match prints exactly one JSON comparison line and exits zero', async () => {
  const path = await inputFile('known.json', JSON.stringify({
    before: { scope, attempts: [{ attemptId: 'a', inputTokens: 120 }, { attemptId: 'b', inputTokens: 80 }] },
    after: { scope, attempts: [{ attemptId: 'a', inputTokens: 90 }, { attemptId: 'c', inputTokens: 0 }] },
  }))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result.stdout, {
    kind: 'matched',
    before: { knownInputTokens: 200, unknownAttempts: 0, complete: true },
    after: { knownInputTokens: 90, unknownAttempts: 0, complete: true },
    inputTokenReduction: 110,
  })
})

test('a match with unknown usage is reported, exits zero, and leaves the reduction null', async () => {
  const path = await inputFile('unknown.json', JSON.stringify({
    before: { scope, attempts: [{ attemptId: 'a', inputTokens: 50 }] },
    after: { scope, attempts: [{ attemptId: 'b', inputTokens: 10 }, { attemptId: 'c', inputTokens: null }] },
  }))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result.stdout, {
    kind: 'matched',
    before: { knownInputTokens: 50, unknownAttempts: 0, complete: true },
    after: { knownInputTokens: 10, unknownAttempts: 1, complete: false },
    inputTokenReduction: null,
  })
})

test('unmatched scopes are reported, exit zero, and never get a reduction', async () => {
  const path = await inputFile('unmatched.json', JSON.stringify({
    before: { scope, attempts: [{ attemptId: 'a', inputTokens: 100 }] },
    after: { scope: { ...scope, models: 'Opus/high' }, attempts: [{ attemptId: 'b', inputTokens: 40 }] },
  }))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result.stdout, {
    kind: 'unmatched',
    before: { knownInputTokens: 100, unknownAttempts: 0, complete: true },
    after: { knownInputTokens: 40, unknownAttempts: 0, complete: true },
    inputTokenReduction: null,
  })
})

test('empty attempts on both sides exit zero with a zero reduction', async () => {
  const path = await inputFile('empty.json', JSON.stringify({ before: { scope, attempts: [] }, after: { scope, attempts: [] } }))
  const result = await run(path)
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expectOneLine(result.stdout, {
    kind: 'matched',
    before: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
    after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
    inputTokenReduction: 0,
  })
})

test('no argument is a usage error with exit 2', async () => {
  const result = await run()
  expectRefused(result, 2)
  expect(result.stderr).toBe('usage: bun cli.ts <input.json>\n')
})

test('two arguments are a usage error with exit 2', async () => {
  const path = await inputFile('valid.json', JSON.stringify({ before: { scope, attempts: [] }, after: { scope, attempts: [] } }))
  expectRefused(await run(path, path), 2)
})

test('an unreadable path is refused with exit 1', async () => {
  const result = await run(join(dir, `${sentinel}.json`))
  expectRefused(result, 1)
  expect(result.stderr).toBe('cannot read input file\n')
})

test('malformed JSON is refused without echoing its bytes', async () => {
  const result = await run(await inputFile('malformed.json', `{"before": ${sentinel}`))
  expectRefused(result, 1)
  expect(result.stderr).toBe('input is not valid JSON\n')
})

const side = (attempts: unknown[], declared: unknown = scope): unknown => ({ scope: declared, attempts })
const tagged = { task: sentinel, gates: sentinel, models: sentinel }

test.each([
  ['a JSON array', [side([]), side([])]],
  ['an extra top-level key', { before: side([]), after: side([]), [sentinel]: sentinel }],
  ['a padded scope string', { before: side([], tagged), after: side([], { ...tagged, gates: `${sentinel} ` }) }],
  ['a duplicate attemptId in one side', { before: side([{ attemptId: sentinel, inputTokens: 1 }, { attemptId: sentinel, inputTokens: 2 }], tagged), after: side([], tagged) }],
  ['negative inputTokens', { before: side([{ attemptId: sentinel, inputTokens: -1 }], tagged), after: side([], tagged) }],
  ['numeric-string inputTokens', { before: side([{ attemptId: sentinel, inputTokens: '7' }], tagged), after: side([], tagged) }],
  ['a summed overflow', { before: side([], tagged), after: side([{ attemptId: sentinel, inputTokens: Number.MAX_SAFE_INTEGER }, { attemptId: 'b', inputTokens: 1 }], tagged) }],
])('rejected input is refused with exit 1: %s', async (_label, body) => {
  const result = await run(await inputFile('rejected.json', JSON.stringify(body)))
  expectRefused(result, 1)
  expect(result.stderr).toStartWith('invalid scope-usage input: ')
})

test('input files are byte-identical after a successful and a failing run', async () => {
  const okBody = `${JSON.stringify({ before: side([{ attemptId: 'z', inputTokens: 3 }, { attemptId: 'a', inputTokens: null }]), after: side([]) }, null, 2)}\n`
  const badBody = JSON.stringify({ before: side([{ attemptId: 'a', inputTokens: 1.5 }]), after: side([]) })
  const okPath = await inputFile('ok.json', okBody)
  const badPath = await inputFile('bad.json', badBody)
  expect((await run(okPath)).code).toBe(0)
  expect((await run(badPath)).code).toBe(1)
  expect(await readFile(okPath, 'utf8')).toBe(okBody)
  expect(await readFile(badPath, 'utf8')).toBe(badBody)
})
