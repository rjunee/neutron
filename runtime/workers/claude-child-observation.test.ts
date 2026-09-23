import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { CHILD_OBSERVATION_MAX_BYTES, CHILD_OBSERVATION_MAX_LINE, observeClaudeChildUsage } from './claude-child-observation.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'child-observation-')); dirs.push(dir)
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'step', role: 'build', model_id: 'requested', effort: 'high',
    cwd: dir, writable: true, network: false, tools: 'edit', brief: { path: join(dir, 'brief'), integrity: 'digest' },
    result: { path: join(dir, 'result'), schema: 'v1' }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
  const identity = { agentId: 'child', sessionId: 'session', isSidechain: true }
  const initial = { ...identity, type: 'user', message: { role: 'user', content: `Request (data): ${JSON.stringify(request)}` } }
  const assistant = { ...identity, type: 'assistant', message: { role: 'assistant', id: 'msg-1', model: 'reported',
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } }
  await writeFile(join(dir, 'agent-child.meta.json'), JSON.stringify({ description: 'build: step' }))
  const save = (rows: unknown[], tail = '') => writeFile(join(dir, 'agent-child.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n' + tail)
  return { dir, request, identity, initial, assistant, save, observe: () => observeClaudeChildUsage(dir, 'session', request) }
}

test('bound provider usage survives partial failure, duplicate blocks and repeated recovery reads', async () => {
  const f = await fixture()
  const later = { ...f.assistant, message: { ...f.assistant.message, usage: { ...f.assistant.message.usage, output_tokens: 7 } } }
  await f.save([f.initial, f.assistant, later, f.assistant,
    { ...f.identity, type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>' } }], '{"partial":')
  const first = await f.observe(), second = await f.observe()
  expect(first?.usage).toEqual({ input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, cost_usd: null })
  expect(second?.usage).toEqual(first?.usage)
  expect(first?.model_reported).toBe('reported')
  expect(first?.thread_id).toBe('child')
  expect(first?.source).toBe('claude-repl-jsonl')
  expect(first!.finished_at_ms).toBeGreaterThanOrEqual(first!.started_at_ms)
  expect(first!.observed_at_ms).toBe(first!.finished_at_ms)
})

test('distinct message usage is summed, reported model diversity remains unknown, and explicit zero survives', async () => {
  const f = await fixture()
  const zero = { ...f.assistant, message: { ...f.assistant.message, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  await f.save([f.initial, zero])
  expect((await f.observe())?.usage).toEqual({ ...zero.message.usage, cost_usd: null })
  await f.save([f.initial, f.assistant, { ...f.assistant, message: { ...f.assistant.message, id: 'msg-2', model: 'other' } }])
  expect((await f.observe())?.usage.input_tokens).toBe(20)
  expect((await f.observe())?.model_reported).toBeNull()
})

test('missing usage stays unknown and assistant content never supplies usage', async () => {
  const f = await fixture()
  await f.save([f.initial, { ...f.assistant, message: { ...f.assistant.message, usage: undefined,
    content: JSON.stringify({ usage: f.assistant.message.usage, total_cost_usd: 40 }) } }])
  expect((await f.observe())?.usage).toEqual({ input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null })
})

for (const field of ['agentId', 'sessionId', 'isSidechain', 'request', 'duplicate child'] as const) {
  test(`rejects usage without unique exact child ownership: ${field}`, async () => {
    const f = await fixture()
    const initial = field === 'request' ? { ...f.initial, message: { role: 'user', content: `Request (data): ${JSON.stringify({ ...f.request, run_id: 'other' })}` } }
      : field === 'duplicate child' ? f.initial : { ...f.initial, [field]: 'wrong' }
    if (field === 'duplicate child') await writeFile(join(f.dir, 'agent-other.meta.json'), JSON.stringify({ description: 'build: step' }))
    await f.save([initial, f.assistant])
    expect(await f.observe()).toBeUndefined()
  })
}

test('foreign assistant envelopes and synthetic errors cannot inflate a bound child', async () => {
  const f = await fixture()
  await f.save([f.initial, f.assistant, { ...f.assistant, agentId: 'foreign', message: { ...f.assistant.message, id: 'foreign' } },
    { ...f.assistant, isApiErrorMessage: true, message: { ...f.assistant.message, id: 'error' } }])
  expect((await f.observe())?.usage.input_tokens).toBe(10)
})

for (const scenario of ['transcript too large', 'line too large', 'metadata too large', 'transcript symlink', 'metadata symlink'] as const) {
  test(`bounded observation refuses ${scenario} and still reads legitimate siblings`, async () => {
    const f = await fixture()
    await f.save([f.initial, f.assistant])
    expect((await f.observe())?.usage.input_tokens).toBe(10)
    if (scenario === 'transcript too large') await f.save([f.initial, f.assistant], (JSON.stringify({ padding: 'x'.repeat(8192) }) + '\n').repeat(Math.ceil(CHILD_OBSERVATION_MAX_BYTES / 8192)))
    if (scenario === 'line too large') await f.save([f.initial, f.assistant], JSON.stringify({ padding: 'x'.repeat(CHILD_OBSERVATION_MAX_LINE + 1) }))
    if (scenario === 'metadata too large') await writeFile(join(f.dir, 'agent-child.meta.json'), JSON.stringify({ description: 'build: step', padding: 'x'.repeat(16 * 1024 + 1) }))
    if (scenario.endsWith('symlink')) {
      const path = join(f.dir, scenario === 'metadata symlink' ? 'agent-child.meta.json' : 'agent-child.jsonl')
      await fs.rename(path, path + '.target'); await symlink(path + '.target', path)
    }
    expect(await f.observe()).toBeUndefined()
  })
}

test('stalled metadata I/O times out and late completion cannot continue parsing', async () => {
  const f = await fixture()
  await f.save([f.initial, f.assistant])
  const original = fs.open
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let delayed = false
  const mock = spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.meta.json')) { delayed = true; await blocked }
    return original(...args)
  })
  try {
    expect(await f.observe()).toBeUndefined()
    expect(delayed).toBe(true)
  } finally { release(); mock.mockRestore() }
  expect((await f.observe())?.usage.input_tokens).toBe(10)
})
