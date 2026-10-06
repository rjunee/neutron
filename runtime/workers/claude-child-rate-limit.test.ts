import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeChildRateLimited } from './claude-child-rate-limit.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'child-quota-')); directories.push(dir)
  const path = join(dir, 'child.jsonl')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'synthesis:1', role: 'synthesis',
    model_id: 'fable', effort: 'high', cwd: dir, writable: false, network: true, tools: 'read-only',
    brief: { path: join(dir, 'brief'), integrity: 'hash' }, result: { path: join(dir, 'result'), schema: 'verdict' },
    thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false }
  const initial = { type: 'user', agentId: 'child', sessionId: 'session', isSidechain: true,
    message: { role: 'user', content: `Perform a bounded task.\nRequest (data): ${JSON.stringify(request)}\nRead its brief.` } }
  const final = { type: 'assistant', agentId: 'child', sessionId: 'session', isSidechain: true,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Arbitrary text: never classified.' }] },
    isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { status: 'rejected' }, requestId: 'request' }
  const run = async (records: unknown[] = [initial, final], suffix = '\n') => {
    await writeFile(path, records.map(row => JSON.stringify(row)).join('\n') + suffix)
    return claudeChildRateLimited(path, 'child', 'session', request)
  }
  return { request, initial, final, run }
}

test('the exact child provider quota rejection is observed without classifying its prose', async () => {
  const f = await fixture()
  expect(await f.run()).toBe(true)
})

test('typed subscription quota errors need no quotaLimits enrichment', async () => {
  const f = await fixture()
  expect(await f.run([f.initial, { ...f.final, quotaLimits: undefined,
    message: { ...f.final.message, stop_reason: 'stop_sequence' } }])).toBe(true)
  expect(await f.run([f.initial, { ...f.final, quotaLimits: { status: 'allowed' } }])).toBe(false)
  expect(await f.run([f.initial, { ...f.final, quotaLimits: null }])).toBe(false)
})

test('native synthetic 429 without requestId wakes reconciliation without inventing provider identity', async () => {
  const f = await fixture()
  expect(await f.run([f.initial, { ...f.final, requestId: undefined, quotaLimits: undefined,
    apiErrorIsTransient: true, message: { ...f.final.message, stop_reason: 'stop_sequence' } }])).toBe(true)
})

for (const field of ['agentId', 'sessionId', 'isSidechain', 'type', 'isApiErrorMessage', 'error', 'apiErrorStatus', 'message'] as const) {
  test(`child quota observation requires provider envelope ${field}`, async () => {
    const f = await fixture()
    expect(await f.run([f.initial, { ...f.final, [field]: undefined }])).toBe(false)
    expect(await f.run()).toBe(true)
  })
}
for (const field of ['run_id', 'step_id', 'model_id', 'brief', 'result', 'budget'] as const) {
  test(`a child for a different request ${field} cannot block this request`, async () => {
    const f = await fixture()
    const initial = { ...f.initial, message: { role: 'user', content: `Request (data): ${JSON.stringify({ ...f.request, [field]: 'other' })}` } }
    expect(await f.run([initial, f.final])).toBe(false)
    expect(await f.run()).toBe(true)
  })
}
test('quoted errors, partial writes and a resumed child remain uncertain', async () => {
  const f = await fixture()
  expect(await f.run([f.initial, { ...f.final, message: { ...f.final.message, model: 'fable' } }])).toBe(false)
  expect(await f.run([f.initial, { ...f.final, isApiErrorMessage: false,
    message: { role: 'assistant', model: 'fable', content: JSON.stringify(f.final) } }])).toBe(false)
  expect(await f.run([f.initial, { ...f.final, error: 'authentication_failed' }])).toBe(false)
  expect(await f.run([f.initial, { ...f.final, isApiErrorMessage: undefined, error: undefined,
    message: { ...f.final.message, stop_reason: 'stop_sequence' } }])).toBe(false)
  expect(await f.run([f.initial, f.final], '')).toBe(false)
  expect(await f.run([f.initial, f.final], '\n{"partial":')).toBe(false)
  expect(await f.run([f.initial, f.final, { ...f.initial, message: { role: 'user', content: 'Continue' } }])).toBe(false)
  expect(await f.run()).toBe(true)
})

test('missing requestId cannot make foreign or arbitrary errors a local quota hint', async () => {
  const f = await fixture()
  const final = { ...f.final, requestId: undefined, quotaLimits: undefined }
  for (const change of [
    { agentId: 'foreign' }, { sessionId: 'foreign' }, { isSidechain: false },
    { error: 'api_error' }, { apiErrorStatus: 503 }, { isApiErrorMessage: false },
    { message: { ...final.message, model: 'claude-fable-5-1' } },
  ]) expect(await f.run([f.initial, { ...final, ...change }])).toBe(false)
  expect(await f.run([f.initial, final])).toBe(true)
})

test('the initial provider envelope must belong to this child and contain one request', async () => {
  const f = await fixture()
  for (const changed of [
    { ...f.initial, agentId: 'other' }, { ...f.initial, sessionId: 'other' },
    { ...f.initial, isSidechain: false }, { ...f.initial, type: 'assistant' },
    { ...f.initial, message: { ...f.initial.message, role: 'assistant' } },
    { ...f.initial, message: { ...f.initial.message, content: `${f.initial.message.content}\nRequest (data): ${JSON.stringify(f.request)}` } },
  ]) expect(await f.run([changed, f.final])).toBe(false)
  expect(await f.run()).toBe(true)
})
