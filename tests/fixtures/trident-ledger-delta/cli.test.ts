import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// These tests observe the real CLI as a child process: exit status, stdout and
// stderr. The decoder and comparator are deliberately never imported here.
const cli = join(import.meta.dir, 'cli.ts')
const sentinel = 'SENTINEL-DO-NOT-ECHO'
let dir = ''

const T1 = '- [ ] T1 record the note'
const T2 = '- [ ] T2 record another note'
const T1_DONE = '- [x] T1 record the note'
const T2_DONE = '- [x] T2 record another note'

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ledger-delta-cli-')) })
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

async function delta(before: unknown, after: unknown): Promise<string> {
  return inputFile('delta.json', JSON.stringify({ before, after }))
}

test('an accepted handoff delta prints exactly one JSON result line and exits zero', async () => {
  const result = await run(await delta(`${T1}\n${T2}\n`, `${T1_DONE}\n${T2}`))
  const expected = { ok: true, completedLabel: 'T1 record the note', after: { completed: 1, remaining: 1, firstUnchecked: T2 } }
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`)
  const lines = result.stdout.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  expect(JSON.parse(lines[0]!)).toEqual(expected)
})

test('an accepted final completion reports a measured zero remaining', async () => {
  const result = await run(await delta('- [x] a\n- [ ] b', '- [x] a\n- [x] b'))
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(`${JSON.stringify({ ok: true, completedLabel: 'b', after: { completed: 2, remaining: 0, firstUnchecked: null } })}\n`)
})

test('a skipped task is a rejected delta: one result line, exit one, empty stderr', async () => {
  const result = await run(await delta(`${T1}\n${T2}\n`, `${T1}\n${T2_DONE}`))
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('{"ok":false,"reason":"task 0: first unchecked task not completed"}\n')
})

test('a no-op is a rejected delta', async () => {
  const result = await run(await delta(`${T1}\n${T2}`, `${T1}\n${T2}`))
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('{"ok":false,"reason":"task 0: first unchecked task not completed"}\n')
})

test('a relabel is a rejected delta without echoing the labels', async () => {
  const result = await run(await delta(`${T1}\n${T2}`, `${T1_DONE}\n- [ ] ${sentinel}`))
  expect(result.code).toBe(1)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('{"ok":false,"reason":"task 1: label differs"}\n')
  expect(result.stdout).not.toContain(sentinel)
})

async function expectRefused(result: { code: number; stdout: string; stderr: string }): Promise<void> {
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr.trim().length).toBeGreaterThan(0)
  expect(result.stderr.trim().split('\n')).toHaveLength(1)
  expect(result.stderr).not.toContain(sentinel)
}

test('no argument is refused as usage', async () => {
  const result = await run()
  await expectRefused(result)
  expect(result.code).toBe(2)
})

test('two arguments are refused as usage', async () => {
  const path = await delta(T1, T1_DONE)
  const result = await run(path, path)
  await expectRefused(result)
  expect(result.code).toBe(2)
})

test('a nonexistent path is refused', async () => {
  await expectRefused(await run(join(dir, `${sentinel}.json`)))
})

test('malformed JSON is refused without echoing its bytes', async () => {
  await expectRefused(await run(await inputFile('bad.json', `{"before": "${sentinel}`)))
})

test.each<[string, unknown]>([
  ['a JSON array', [`- [ ] ${sentinel}`, `- [x] ${sentinel}`]],
  ['a JSON string', `- [ ] ${sentinel}`],
  ['JSON null', null],
  ['an object missing after', { before: `- [ ] ${sentinel}` }],
  ['an object with an extra key', { before: T1, after: T1_DONE, extra: sentinel }],
  ['before a number', { before: 7, after: `- [x] ${sentinel}` }],
  ['after null', { before: `- [ ] ${sentinel}`, after: null }],
  ['a malformed before ledger (uppercase X)', { before: `- [X] ${sentinel}`, after: T1_DONE }],
  ['an after ledger with a duplicate label', { before: `- [ ] ${sentinel}\n${T2}`, after: `- [x] ${sentinel}\n- [ ] ${sentinel}` }],
  ['an empty before ledger', { before: '', after: `- [x] ${sentinel}` }],
])('structurally invalid input is refused without echoing its bytes: %s', async (_name, body) => {
  const result = await run(await inputFile('invalid.json', JSON.stringify(body)))
  await expectRefused(result)
  expect(result.code).toBe(1)
})

test('the input file is never modified on success or failure', async () => {
  const good = await inputFile('good.json', JSON.stringify({ before: `${T1}\n${T2}`, after: `${T1_DONE}\n${T2}` }))
  const bad = await inputFile('bad.json', JSON.stringify({ before: `${T1}\n${T2}`, after: `- [X] ${sentinel}` }))
  const goodBefore = await readFile(good)
  const badBefore = await readFile(bad)
  expect((await run(good)).code).toBe(0)
  expect((await run(bad)).code).not.toBe(0)
  expect((await readFile(good)).equals(goodBefore)).toBe(true)
  expect((await readFile(bad)).equals(badBefore)).toBe(true)
})
