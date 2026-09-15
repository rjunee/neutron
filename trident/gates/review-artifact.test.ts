import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { BuildSnapshot } from '../build-run.ts'
import { briefIntegrity } from './brief-integrity.ts'
import { reviewArtifact } from './review-artifact.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'review-artifact-'))
  dirs.push(dir)
  const path = join(dir, 'brief')
  const context = `${path}.context.json`
  const request: BoundedWorkRequest = {
    run_id: 'run', step_id: 'run:review:1', role: 'review', needs_approval_decision: false,
    model_id: 'test', effort: null, cwd: dir, writable: false, network: false, tools: 'edit-and-run',
    brief: { path, integrity: briefIntegrity(context) }, result: { path: join(dir, 'result'), schema: 'test' },
    thread: null, budget: { wall_ms: 1000 },
  }
  const snapshot: BuildSnapshot = { head: 'a'.repeat(40), diff: 'diff --git a/code b/code\n-old\n+new\n', pr: null }
  await writeFile(path, context)
  const write = (value: unknown = { request, snapshot }) => writeFile(context, JSON.stringify(value))
  await write()
  return { path, context, request, snapshot, write, check: () => reviewArtifact(request, snapshot) }
}

test('G102 materialized measured bytes allow both local and PR review', async () => {
  const f = await fixture()
  expect(await f.check()).toEqual({ kind: 'allow' })
  f.snapshot.head = 'b'.repeat(64)
  f.snapshot.pr = { number: 3, head: f.snapshot.head, state: 'OPEN' }
  await f.write()
  expect(await f.check()).toEqual({ kind: 'allow' })
})

test('G102 unreadable and malformed files cannot establish an artifact', async () => {
  const f = await fixture()
  await rm(f.context)
  expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('read or decoded') })
  await writeFile(f.context, '{')
  expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('read or decoded') })
  await f.write()
  await rm(f.path)
  expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('read or decoded') })
})
test('G102 thrown read cause is bounded and normal refusal text is unchanged', async () => {
  const f = await fixture()
  expect(await reviewArtifact(f.request, f.snapshot, async () => { throw new Error('recognisable artifact failure') })).toEqual({
    kind: 'unknown', detail: 'Review context artifact or brief could not be read or decoded: Error: recognisable artifact failure',
  })
  await writeFile(f.path, 'different context')
  expect(await f.check()).toEqual({ kind: 'unknown', detail: 'Review brief does not reference its verified context artifact' })
})

test('G102 brief integrity and context reference are independently required', async () => {
  const f = await fixture()
  await writeFile(f.path, `modified ${f.context}`)
  expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('verified context') })
  await writeFile(f.path, 'different context')
  const request = { ...f.request, brief: { ...f.request.brief, integrity: briefIntegrity('different context') } }
  expect(await reviewArtifact(request, f.snapshot)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('verified context') })
})

test('G102 empty change and invalid head refuse even matching materialization', async () => {
  const f = await fixture()
  for (const field of ['head', 'diff'] as const) {
    const before = f.snapshot[field]
    f.snapshot[field] = ' '
    await f.write()
    expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('nonempty measured diff') })
    f.snapshot[field] = before
  }
})

test('G102 artifact identity is current run and review step', async () => {
  const f = await fixture()
  for (const value of [null, {}, { request: {} }, ...['run_id', 'step_id', 'role'].map(field => ({ request: { ...f.request, [field]: 'other' }, snapshot: f.snapshot }))]) {
    await f.write(value)
    expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('dispatch identity') })
  }
})

test('G102 stale head diff and PR observations cannot reach review', async () => {
  const f = await fixture()
  const assertMismatch = async (snapshot: unknown) => {
    await f.write({ request: f.request, snapshot })
    expect(await f.check()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('measured revision') })
  }
  await assertMismatch(null)
  await assertMismatch({ ...f.snapshot, head: 'b'.repeat(40) })
  await assertMismatch({ ...f.snapshot, diff: '+stale' })
  await assertMismatch({ ...f.snapshot, pr: { number: 1, head: f.snapshot.head, state: 'OPEN' } })
  f.snapshot.pr = { number: 3, head: f.snapshot.head, state: 'OPEN' }
  for (const field of ['number', 'head', 'state']) await assertMismatch({ ...f.snapshot, pr: { ...f.snapshot.pr, [field]: 'other' } })
  await assertMismatch({ ...f.snapshot, pr: null })
  await f.write()
  expect(JSON.parse(await readFile(f.context, 'utf8')).snapshot.diff).toBe(f.snapshot.diff)
  expect(await f.check()).toEqual({ kind: 'allow' })
})
