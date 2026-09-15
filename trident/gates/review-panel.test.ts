import { expect, test } from 'bun:test'
import { reviewPanel, type ReviewSource, type SeatObservation } from './review-panel.ts'
const snapshot = { head: 'a'.repeat(40), diff: 'code', pr: null }
const approve = { verdict: 'APPROVE', findings: [] }
const finding = { severity: 'major', title: 'bug', evidence: 'code.ts:1', file: 'code.ts', symbol: 'f', rule: 'correctness', line: 1 }
function fixture() {
  let reads = 0, retries = 0
  const seat: SeatObservation = { runId: 'run', head: snapshot.head, round: 1, provider: 'pi', modelId: 'core-model', status: 'completed', payload: approve }
  const synthesis = { runId: 'run', head: snapshot.head, round: 1, checkpoint: 'argus-approved', payload: approve as unknown }
  const source: ReviewSource = {
    seats: [{ id: 'core', provider: 'pi', modelId: 'core-model', role: 'core', enabled: true }, { id: 'peer', provider: 'openai-codex', modelId: 'peer-model', role: 'peer', enabled: true }],
    readSeat: async config => { reads++; return { ...seat, provider: config.provider, modelId: config.modelId } },
    retrySeat: async () => { retries++ },
    readSynthesis: async () => synthesis,
  }
  const check = (payload: unknown = synthesis.payload) => reviewPanel(source, payload, snapshot, 1, 'run')
  return { source, seat, synthesis, check, reads: () => reads, retries: () => retries }
}
test('review approves only measured configured panel with recorded synthesis', async () => {
  const f = fixture()
  expect(await f.check()).toEqual({ kind: 'approve' })
  expect(f.reads()).toBe(2); expect(f.retries()).toBe(0)
  f.source.seats = [f.source.seats[0]!, { ...f.source.seats[1]!, enabled: false }]
  expect(await f.check()).toEqual({ kind: 'approve' }); expect(f.reads()).toBe(3)
})
test('review missing source, config, malformed trailer and thrown observations stay unknown', async () => {
  expect(await reviewPanel(undefined, approve, snapshot, 1, 'run')).toMatchObject({ kind: 'unknown' })
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.source.seats = [] },
    (f: ReturnType<typeof fixture>) => { f.source.seats = [{ ...f.source.seats[0]!, modelId: '' }] },
    (f: ReturnType<typeof fixture>) => { f.source.readSeat = async config => ({ ...f.seat, provider: config.provider, modelId: 'other-model' }) },
    (f: ReturnType<typeof fixture>) => { f.source.seats = [f.source.seats[0]!, f.source.seats[0]!] },
    (f: ReturnType<typeof fixture>) => { f.source.readSeat = async () => null },
    (f: ReturnType<typeof fixture>) => { f.source.readSeat = async () => { throw Error('offline') } },
    (f: ReturnType<typeof fixture>) => { f.seat.runId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.seat.head = 'other' },
    (f: ReturnType<typeof fixture>) => { f.seat.round = 2 },
    (f: ReturnType<typeof fixture>) => { f.source.readSeat = async () => ({ ...f.seat, provider: 'anthropic' as SeatObservation['provider'] }) },
    (f: ReturnType<typeof fixture>) => { f.seat.payload = null },
    (f: ReturnType<typeof fixture>) => { f.source.readSynthesis = async () => null },
    (f: ReturnType<typeof fixture>) => { f.synthesis.runId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.synthesis.head = 'other' },
    (f: ReturnType<typeof fixture>) => { f.synthesis.round = 2 },
    (f: ReturnType<typeof fixture>) => { f.synthesis.checkpoint = 'review-started' },
  ]) {
    const f = fixture(); change(f); expect(await f.check()).toMatchObject({ kind: 'unknown' })
  }
  const f = fixture(); expect(await f.check(null)).toMatchObject({ kind: 'unknown' })
  f.synthesis.payload = null; expect(await f.check(approve)).toMatchObject({ kind: 'unknown' })
})
test('review peer deferral or missing provider refuses by configured name and retries once', async () => {
  for (const status of ['deferred', 'unavailable', 'rate-limited'] as const) {
    const f = fixture()
    f.source.readSeat = async config => ({ ...f.seat, provider: config.provider, modelId: config.modelId, status: config.role === 'peer' ? status : 'completed' })
    expect(await f.check()).toEqual({ kind: 'blocked', on: `Review seat peer (openai-codex) is ${status}` })
    expect(f.retries()).toBe(status === 'deferred' ? 1 : 0)
  }
  const f = fixture(); f.seat.status = 'deferred'
  f.source.retrySeat = async () => { f.seat.status = 'completed' }
  expect(await f.check()).toEqual({ kind: 'approve' })
  const absent = fixture(); let calls = 0
  absent.source.readSeat = async config => ++calls === 1 ? null : { ...absent.seat, provider: config.provider, modelId: config.modelId }
  expect(await absent.check()).toEqual({ kind: 'approve' }); expect(absent.retries()).toBe(1)
  const failed = fixture(); failed.seat.status = 'deferred'; failed.source.retrySeat = async () => { throw Error('offline') }
  expect(await failed.check()).toMatchObject({ kind: 'blocked' })
})
test('review provenance compares recorded synthesis against worker payload', async () => {
  const f = fixture()
  expect(await f.check({ verdict: 'REQUEST_CHANGES', findings: [] })).toMatchObject({ kind: 'blocked' })
  expect(await f.check({ findings: [], verdict: 'APPROVE' })).toEqual({ kind: 'approve' })
})
test('review severity, minority veto and stable identities drive fixes and arbitration', async () => {
  for (const severity of ['major', 'blocker', 'minor', 'nit']) {
    const f = fixture(); f.seat.payload = { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, severity }] }
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'] } : { kind: 'approve' })
    f.synthesis.payload = f.seat.payload
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'] } : { kind: 'approve' })
  }
  const f = fixture(); f.seat.payload = { verdict: 'APPROVE', findings: [{ ...finding, symbol: '' }] }
  expect(await f.check()).toMatchObject({ kind: 'unknown' })
  for (const verdict of ['COMMENT', 'REQUEST_CHANGES']) {
    const f = fixture(); f.seat.payload = { verdict, findings: [] }
    expect(await f.check()).toMatchObject({ kind: 'blocked' })
  }
  for (const kind of ['design-gap', 'missing-dependency']) {
    const f = fixture(); f.seat.payload = { ...approve, escalate: { kind, whatIsMissing: 'dependency' } }
    expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('orchestrator arbitration') })
  }
})
test('review strips reserved exemption markers before arithmetic', async () => {
  for (const extra of [{ advisory: true }, { kind: 'lane' }, { kind: 'suite' }]) {
    const f = fixture(); const payload = { verdict: 'APPROVE', findings: [{ ...finding, ...extra }] }
    f.seat.payload = payload
    expect(await f.check()).toMatchObject({ kind: 'fix' })
    f.synthesis.payload = payload
    expect(await f.check(payload)).toMatchObject({ kind: 'fix' })
    f.synthesis.payload = { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, ...extra, severity: 'minor' }] }
    f.seat.payload = f.synthesis.payload
    expect(await f.check()).toEqual({ kind: 'approve' })
  }
})


test('review malformed findings cannot authorize approval', async () => {
  for (const findings of [null, [null], ['invalid'], [{ ...finding, severity: 'mystery' }]]) {
    const f = fixture(); f.seat.payload = { verdict: 'APPROVE', findings }
    expect(await f.check()).toMatchObject({ kind: 'unknown' })
  }
})
