import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { CHILD_OBSERVATION_MAX_BYTES, CHILD_OBSERVATION_MAX_LINE, observeClaudeChildUsage, observeClaudeChildBinding } from './claude-child-observation.ts'

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

test('archived child selection ignores mutable metadata but retains exact request and provider envelope ownership', async () => {
  const f = await fixture()
  await f.save([f.initial, f.assistant])
  await writeFile(join(f.dir, 'agent-child.meta.json'), '{}')
  await writeFile(join(f.dir, 'agent-other.meta.json'), JSON.stringify({ description: 'build: step' }))
  expect((await observeClaudeChildUsage(f.dir, 'session', f.request, 'child'))?.usage.input_tokens).toBe(10)
  for (const child of ['other', '../child']) expect(await observeClaudeChildUsage(f.dir, 'session', f.request, child)).toBeUndefined()
  expect(await observeClaudeChildUsage(f.dir, 'foreign', f.request, 'child')).toBeUndefined()
  expect(await observeClaudeChildUsage(f.dir, 'session', { ...f.request, model_id: 'foreign' }, 'child')).toBeUndefined()
  const traversal = 'x/../agent-child'
  await f.save([{ ...f.initial, agentId: traversal }, { ...f.assistant, agentId: traversal }])
  expect(await observeClaudeChildUsage(f.dir, 'session', f.request, traversal)).toBeUndefined()
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
    if (scenario.startsWith('transcript') || scenario === 'line too large') {
      expect(await observeClaudeChildUsage(f.dir, 'session', f.request, 'child')).toBeUndefined()
      const sibling = await fixture(); await sibling.save([sibling.initial, sibling.assistant])
      expect((await observeClaudeChildUsage(sibling.dir, 'session', sibling.request, 'child'))?.usage.input_tokens).toBe(10)
    }
  })
}

for (const bound of [false, true]) test(`stalled I/O times out and late completion cannot continue parsing: archived=${bound}`, async () => {
  const f = await fixture()
  await f.save([f.initial, f.assistant])
  const original = fs.open
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let delayed = false
  const mock = spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(bound ? '.jsonl' : '.meta.json')) { delayed = true; await blocked }
    return original(...args)
  })
  try {
    expect(await observeClaudeChildUsage(f.dir, 'session', f.request, bound ? 'child' : undefined)).toBeUndefined()
    expect(delayed).toBe(true)
  } finally { release(); mock.mockRestore() }
  expect((await f.observe())?.usage.input_tokens).toBe(10)
})

for (const fault of ['oversized-first', 'blank-first', 'malformed-first', 'wrong-request', 'duplicate-request',
  'foreign-session', 'duplicate-child', 'metadata-too-large', 'metadata-symlink', 'transcript-symlink',
  'metadata-fifo', 'transcript-fifo'] as const)
test(`binding-only observation retains first-envelope and safe-file refusal: ${fault}`, async () => {
  const f = await fixture()
  await f.save([f.initial])
  expect(await observeClaudeChildBinding(f.dir, 'session', f.request)).toEqual({ agentId: 'child' })
  if (fault === 'oversized-first') await f.save([{ ...f.initial, padding: 'x'.repeat(CHILD_OBSERVATION_MAX_LINE) }])
  if (fault === 'blank-first') await writeFile(join(f.dir, 'agent-child.jsonl'), '\n' + JSON.stringify(f.initial))
  if (fault === 'malformed-first') await writeFile(join(f.dir, 'agent-child.jsonl'), '{\n' + JSON.stringify(f.initial))
  if (fault === 'wrong-request') await f.save([{ ...f.initial, message: { role: 'user', content: `Request (data): ${JSON.stringify({ ...f.request, model_id: 'other' })}` } }])
  if (fault === 'duplicate-request') await f.save([{ ...f.initial, message: { role: 'user', content: f.initial.message.content + '\n' + f.initial.message.content } }])
  if (fault === 'foreign-session') await f.save([{ ...f.initial, sessionId: 'foreign' }])
  if (fault === 'duplicate-child') await writeFile(join(f.dir, 'agent-other.meta.json'), JSON.stringify({ description: 'build: step' }))
  if (fault === 'metadata-too-large') await writeFile(join(f.dir, 'agent-child.meta.json'), JSON.stringify({ description: 'build: step', padding: 'x'.repeat(16 * 1024) }))
  if (fault.endsWith('-symlink') || fault.endsWith('-fifo')) {
    const path = join(f.dir, fault.startsWith('metadata') ? 'agent-child.meta.json' : 'agent-child.jsonl')
    await fs.rename(path, path + '.target')
    if (fault.endsWith('-symlink')) await symlink(path + '.target', path)
    else expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0)
  }
  expect(await observeClaudeChildBinding(f.dir, 'session', f.request)).toBeUndefined()
})

for (const suffix of ['large-transcript', 'large-later-line'] as const)
test(`binding-only reader stops at first envelope despite ${suffix}`, async () => {
  const f = await fixture()
  const tail = suffix === 'large-transcript' ? ('x'.repeat(8192) + '\n').repeat(1025) : 'x'.repeat(CHILD_OBSERVATION_MAX_LINE + 1)
  await f.save([f.initial], tail)
  expect(await observeClaudeChildBinding(f.dir, 'session', f.request)).toEqual({ agentId: 'child' })
  // The telemetry reader deliberately retains its whole-transcript limits.
  expect(await f.observe()).toBeUndefined()
})

for (const block of ['.jsonl', '.meta.json']) test(`binding-only I/O timeout remains bounded: ${block}`, async () => {
  const f = await fixture()
  await f.save([f.initial])
  const original = fs.open
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const mock = spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith(block)) await blocked
    return original(...args)
  })
  try { expect(await observeClaudeChildBinding(f.dir, 'session', f.request)).toBeUndefined() }
  finally { release(); mock.mockRestore() }
  expect(await observeClaudeChildBinding(f.dir, 'session', f.request)).toEqual({ agentId: 'child' })
})
