import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoundedWorkOutcome, BoundedWorkRequest, WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { createProjectReviewSource, type ProjectReviewSourceOptions } from './project-review-source.ts'
import { reviewPanel } from './gates/review-panel.ts'
const approve = { verdict: 'APPROVE', findings: [] }
const snapshot = { head: 'a'.repeat(40), diff: 'actual diff', pr: null }
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const completed = (result: unknown = approve): BoundedWorkOutcome => ({ kind: 'completed', result, model_reported: 'untrusted-model-claim', usage: { input_tokens: 0, output_tokens: 0 }, thread_id: null })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'review-source-test-')); dirs.push(dir)
  const calls: BoundedWorkRequest[] = []
  const bindings: string[] = []
  let answer: (request: BoundedWorkRequest) => Promise<BoundedWorkOutcome> = async () => completed()
  const options: ProjectReviewSourceOptions = {
    runId: 'host-run', projectSlug: 'project', cwd: dir, evidenceRoot: dir, env: {},
    phaseModels: { review_rubric: { model: 'none' }, review_adversarial: { model: 'sol' },
      review_codex: { model: 'none' }, review_kimi: { model: 'none' } },
    replProvider: 'openai-codex', wallMs: 1000, signal: new AbortController().signal,
    runnerFor: (model, seat): WorkerRunner => {
      bindings.push(`${model.tier}:${model.endpoint ?? ''}:${model.credential ?? ''}`)
      return { provider: seat.provider, supports: () => ({ ok: true }), liveness: async () => 'unknown',
        run: async request => { calls.push(request); return answer(request) } }
    },
  }
  const source = () => createProjectReviewSource(options)
  const check = (s = source()) => reviewPanel(s, approve, snapshot, 1, 'host-run')
  return { options, calls, bindings, source, check, answer: (fn: typeof answer) => { answer = fn } }
}
test('non-Claude core and explicit configured peer reach selected transport with host identity', async () => {
  const f = await fixture()
  f.options.env = { NEUTRON_REVIEW_SEATS: JSON.stringify([{ tier: 'custom', provider: 'independent', model: 'review-model', endpoint: 'https://192.0.2.1/review', credential: 'REVIEW_KEY' }]) }
  f.options.phaseModels = { ...f.options.phaseModels, review_codex: { model: 'custom' } }
  const source = f.source()
  expect(await f.check(source)).toEqual({ kind: 'approve' })
  expect(f.bindings).toContain('custom:https://192.0.2.1/review:REVIEW_KEY')
  expect(f.calls.map(row => row.model_id)).toContain('gpt-5.6-sol')
  expect(f.calls.map(row => row.model_id)).toContain('review-model')
  const seat = source.seats.find(row => row.id === 'review_adversarial')!
  expect(await source.readSeat(seat, snapshot, 1)).toMatchObject({ runId: 'host-run', round: 1, provider: 'openai-codex', modelId: 'gpt-5.6-sol' })
  expect(f.calls.every(row => row.run_id === 'host-run' && row.budget.wall_ms === 1000 && !row.writable)).toBe(true)
  const synthesis = JSON.parse(await readFile(f.calls.at(-1)!.brief.path, 'utf8'))
  expect(synthesis.panel).toHaveLength(2)
  expect(synthesis.snapshot.diff).toBe(snapshot.diff)
  await f.check(source); expect(f.calls).toHaveLength(3)
})
test('unknown configured seat refuses by name with a known tier positive control', async () => {
  const f = await fixture(); expect(f.source().seats[1]!.modelId).toBe('gpt-5.6-sol')
  f.options.phaseModels = { ...f.options.phaseModels, review_adversarial: { model: 'missing-model' } }
  expect(f.source).toThrow('review_adversarial: unknown configured model missing-model')
})
test('unreadable seat and thrown round block infrastructure; refusal stays unavailable', async () => {
  const f = await fixture()
  for (const answer of [async (): Promise<BoundedWorkOutcome> => { throw Error('round lost') }, async (): Promise<BoundedWorkOutcome> => ({ kind: 'unknown', detail: 'cannot read' })]) {
    f.answer(answer); expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
  }
  f.answer(async () => ({ kind: 'refused', reason: 'provider-not-connected' }))
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
  f.options.runnerFor = () => undefined
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
})
test('missing and unusable synthesis are separate infrastructure answers', async () => {
  const f = await fixture()
  f.answer(async req => req.role === 'synthesis' ? { kind: 'refused', reason: 'provider-not-connected' } : completed())
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('synthesis provenance') })
  f.answer(async req => completed(req.role === 'synthesis' ? null : approve))
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('synthesis is unusable') })
  f.answer(async () => completed()); expect(await f.check()).toEqual({ kind: 'approve' })
})
test('deferred retry is bounded and cannot replace a completed observation', async () => {
  const f = await fixture(); let attempts = 0
  f.answer(async () => ++attempts === 1 ? { kind: 'failed', class: 'infra', detail: 'provider deferred' } : completed())
  const source = f.source(); expect(await f.check(source)).toEqual({ kind: 'approve' })
  const seat = source.seats[1]!
  await expect(source.retrySeat(seat, snapshot, 1)).rejects.toThrow('retry already consumed')
  const other = f.source(); await other.readSeat(other.seats[1]!, snapshot, 1)
  await expect(other.retrySeat(other.seats[1]!, snapshot, 1)).rejects.toThrow('retry unavailable for completed')
  expect(attempts).toBe(4)
})
test('retry failure retains deferral and host timeout cannot approve', async () => {
  const f = await fixture(); let count = 0
  f.answer(async () => { if (++count === 1) return { kind: 'failed', class: 'infra', detail: 'deferred' }; throw Error('retry unavailable') })
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('deferred') })
  f.options.wallMs = 5
  f.answer(async () => new Promise(() => {}))
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
})
test('findings remain findings and revision/round changes force fresh observations', async () => {
  const f = await fixture()
  const finding = { severity: 'major', title: 'bug', evidence: 'code.ts:1', file: 'code.ts', symbol: 'f', rule: 'correctness', line: 1 }
  f.answer(async req => completed(req.role === 'review' ? { verdict: 'REQUEST_CHANGES', findings: [finding] } : approve))
  expect(await f.check()).toMatchObject({ kind: 'fix', blockingCount: 1 })
  f.answer(async () => completed())
  const source = f.source(); const seat = source.seats[1]!
  await source.readSeat(seat, snapshot, 1)
  await source.readSeat(seat, { ...snapshot, head: 'b'.repeat(40) }, 1)
  await source.readSeat(seat, snapshot, 2)
  expect(f.calls).toHaveLength(5)
  await expect(source.readSeat({ ...seat }, snapshot, 1)).rejects.toThrow('configuration does not belong')
  await expect(source.readSeat(seat, { ...snapshot, diff: '' }, 1)).rejects.toThrow('measured revision')
})
test('configuration and dispatch admission reject unsupported values with valid controls', async () => {
  const f = await fixture(); expect(f.source().seats[1]!.enabled).toBe(true)
  f.options.wallMs = 0; expect(f.source).toThrow('positive wall budget'); f.options.wallMs = 1000
  f.options.phaseModels = { ...f.options.phaseModels, review_adversarial: { model: 'k3' } }
  expect(f.source).toThrow('unsupported configured model')
  f.options.phaseModels = { ...f.options.phaseModels, review_adversarial: { model: 'sol' } }
  const binding = f.options.runnerFor
  f.options.runnerFor = (model, seat) => ({ ...binding(model, seat)!, provider: 'openai' })
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
  f.options.runnerFor = (model, seat) => ({ ...binding(model, seat)!, supports: () => ({ ok: false, reason: 'capability-unsupported', detail: 'unsupported' }) })
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
  expect(f.calls).toHaveLength(0)
  f.options.runnerFor = binding
  const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
  expect(f.calls).toHaveLength(0)
})
test('synthesis requires prior completed seats and never fabricates checkpoint approval', async () => {
  const f = await fixture(); const source = f.source()
  expect(await source.readSynthesis(snapshot, 1)).toBeNull()
  f.answer(async req => completed(req.role === 'synthesis' ? { verdict: 'COMMENT', findings: [] } : approve))
  const ready = f.source(); await ready.readSeat(ready.seats[1]!, snapshot, 1)
  expect(await ready.readSynthesis(snapshot, 1)).toMatchObject({ checkpoint: 'review-recorded', payload: { verdict: 'COMMENT' } })
})

test('worker block cannot claim retryability, including rate limits', async () => {
  const f = await fixture()
  f.answer(async () => ({ kind: 'blocked', on: 'rate-limited' }))
  expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('unavailable') })
  expect(f.calls).toHaveLength(1)
})
test('observation copies cannot rewrite the authoritative host record', async () => {
  const f = await fixture(); const source = f.source(); const seat = source.seats[1]!
  const observed = await source.readSeat(seat, snapshot, 1)
  observed!.modelId = 'forged'
  observed!.payload = null
  expect(await source.readSeat(seat, snapshot, 1)).toMatchObject({ modelId: 'gpt-5.6-sol', payload: approve })
})

for (const effort of ['xhigh', 'max'] as const) {
  test(`review source dispatches selected effort ${effort}`, async () => {
    const f = await fixture()
    f.options.phaseModels = { ...f.options.phaseModels, review_adversarial: { model: 'sol', effort } }
    expect(await f.check()).toEqual({ kind: 'approve' })
    expect(f.calls[0]!.effort).toBe(effort)
  })
}
test('null model telemetry preserves completion and reports unknown panel family', async () => {
  const f = await fixture()
  f.options.phaseModels = { ...f.options.phaseModels, review_codex: { model: 'sol' } }
  f.answer(async () => ({ kind: 'completed', result: approve, usage: null, model_reported: null, thread_id: null }))
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const source = f.source()
    expect(await f.check(source)).toEqual({ kind: 'approve' })
    expect(await source.readSeat(source.seats[1]!, snapshot, 1)).toMatchObject({ status: 'completed', family: null })
    expect(warning.mock.calls.flat().join(' ')).toContain('panel-unknown-family')
    expect(warning.mock.calls.flat().join(' ')).not.toContain('panel-single-family')
  } finally { warning.mockRestore() }
})
