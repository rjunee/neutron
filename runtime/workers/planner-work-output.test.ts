import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { interpretSinkToolResponse } from '../adapters/claude-code/persistent/tools-bridge-response.ts'
import { bindPlannerWork, dispatchPlannerWork } from './planner-work.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const wire = (result: unknown) => JSON.stringify(interpretSinkToolResponse({ status: 200, body: JSON.stringify({ ok: true, result }) }))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'planner-output-')); roots.push(root)
  const cwd = join(root, 'worktree'), state = join(root, 'state')
  await mkdir(cwd); await mkdir(state)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'source.ts'), 'export const value = 1\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const source = '// ordinary context\n'.repeat(6000) + 'export const nextTaskMarker = 2\n'
  await writeFile(join(cwd, 'source.ts'), source)
  git('add', '.'); git('commit', '-qm', 'completed prior task')
  const head = git('rev-parse', 'HEAD')
  const context = { planner: 'next', executionStrategy: 'task_sequence',
    committedPlan: { body: '- [x] T1: Previous task\n- [ ] T2: Next task\n', uncheckedCount: 1 },
    snapshot: { head, diff: execFileSync('git', ['-C', cwd, 'diff', '--binary', '--full-index', `${base}...${head}`, '--'], { encoding: 'utf8' }) }, previous: { executionSpec: 'Prior instructions. '.repeat(5000) } }
  const brief = 'Read the committed plan and implement only its next task.\n'.repeat(1000)
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'run:task:1:plan:0', role: 'plan', model_id: 'planner', effort: 'high',
    cwd, writable: true, network: false, tools: 'edit', brief: { path: join(state, 'brief'), integrity: sha(brief) },
    result: { path: join(state, 'result'), schema: 'fixture' }, thread: null, budget: { wall_ms: 60_000 }, needs_approval_decision: false }
  const session = {}, controller = new AbortController()
  const capability = await bindPlannerWork({ session, request, base, pr: null, brief, context,
    signal: controller.signal, deadline: Date.now() + 60_000, current: () => true, validate: () => true })
  const call = (operation: string, fields: object = {}) => dispatchPlannerWork(session, { run_id: request.run_id, step_id: request.step_id, capability, operation, ...fields })
  return { cwd, request, brief, context, head, source, controller, call }
}

test('large continuation context stays usable through the real native tool response', async () => {
  const f = await fixture()
  // Positive control: this wire measurement exposes the observed oversized form.
  expect(Buffer.byteLength(wire({ brief: f.brief, context: f.context }))).toBeGreaterThan(100_000)
  const manifest = await f.call('brief')
  expect(Buffer.byteLength(wire(manifest))).toBeLessThanOrEqual(16 * 1024)
  expect(manifest).toMatchObject({ planner: 'next', executionStrategy: 'task_sequence' })
  const ledger = await f.call('read', { resource: 'context', pointer: ['committedPlan'] }) as { content: string }
  expect(JSON.parse(ledger.content)).toEqual(f.context.committedPlan)
  const measured = await f.call('state')
  expect(Buffer.byteLength(wire(measured))).toBeLessThanOrEqual(16 * 1024)
  expect(measured).toMatchObject({ head: f.head })
  const found = await f.call('find', { path: 'source.ts', query: 'nextTaskMarker' }) as { matches: { offset: number }[] }
  expect(found.matches).toHaveLength(1)
  const fragment = await f.call('read', { path: 'source.ts', offset: found.matches[0]!.offset, sha256: sha(f.source), limit: 100 }) as { content: string }
  expect(fragment.content).toContain('nextTaskMarker = 2')
  await f.call('publish', { payload: { executionSpec: 'Implement T2 using the complete owned ledger.' } })
  const result = JSON.parse(await readFile(f.request.result.path, 'utf8'))
  expect(result.result.diff).toBe(f.context.snapshot.diff)
})

test('paged instructions reconstruct exactly and cannot silently mix changed source', async () => {
  const f = await fixture()
  let text = '', offset = 0, digest: string | undefined
  do {
    const page = await f.call('read', { resource: 'brief', offset, ...(digest ? { sha256: digest } : {}) }) as {
      content: string; sha256: string; nextOffset: number | null }
    expect(Buffer.byteLength(wire(page))).toBeLessThanOrEqual(16 * 1024)
    digest ??= page.sha256
    expect(page.sha256).toBe(digest)
    text += page.content
    if (page.nextOffset === null) break
    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  } while (true)
  expect(text).toBe(f.brief)
  await writeFile(join(f.cwd, 'source.ts'), 'changed')
  await expect(f.call('read', { path: 'source.ts', offset: 1, sha256: sha(f.source) })).rejects.toThrow('changed')
  await expect(f.call('read', { path: '../state/brief' })).rejects.toThrow('scope')
  await expect(f.call('read', { resource: 'context', pointer: ['__proto__'] })).rejects.toThrow()
  await expect(f.call('find', { path: '.git/config', query: 'url' })).rejects.toThrow('scope')
  f.controller.abort()
  await expect(f.call('read', { resource: 'brief' })).rejects.toThrow('expired')
})


test('escaped text and Unicode paginate losslessly within the native response ceiling', async () => {
  const f = await fixture()
  const source = ('\u0000\u0001\\"\n😀漢字').repeat(3000)
  await writeFile(join(f.cwd, 'escaped.txt'), source)
  let restored = '', offset = 0
  do {
    const result = await f.call('read', { path: 'escaped.txt', offset, sha256: sha(source) }) as { content: string; nextOffset: number | null }
    expect(Buffer.byteLength(wire(result))).toBeLessThanOrEqual(16 * 1024)
    restored += result.content
    if (result.nextOffset === null) break
    expect(result.nextOffset).toBeGreaterThan(offset)
    offset = result.nextOffset
  } while (true)
  expect(restored).toBe(source)
  await expect(f.call('read', { path: 'escaped.txt', offset: 1 })).rejects.toThrow('digest missing')
  await expect(f.call('read', { path: 'escaped.txt', offset: -1 })).rejects.toThrow('offset')
  await expect(f.call('read', { path: 'escaped.txt', limit: 12001 })).rejects.toThrow('limit')
  await expect(f.call('read', { resource: 'brief', path: 'escaped.txt' })).rejects.toThrow('Choose one')
})

test('literal find pages all matches and refuses stale continuation', async () => {
  const f = await fixture(), source = 'a.*b\n'.repeat(70)
  await writeFile(join(f.cwd, 'literal.txt'), source)
  let offset = 0
  const observed: number[] = []
  do {
    const result = await f.call('find', { path: 'literal.txt', query: '.*', offset, sha256: sha(source) }) as {
      matches: { offset: number; line: number }[]; nextOffset: number | null }
    expect(Buffer.byteLength(wire(result))).toBeLessThanOrEqual(16 * 1024)
    observed.push(...result.matches.map(match => match.offset))
    if (result.nextOffset === null) break
    offset = result.nextOffset
  } while (true)
  expect(observed).toEqual(Array.from({ length: 70 }, (_, i) => i * 5 + 1))
  await writeFile(join(f.cwd, 'literal.txt'), source + 'changed')
  await expect(f.call('find', { path: 'literal.txt', query: '.*', offset: 1, sha256: sha(source) })).rejects.toThrow('changed')
})
