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
test('G057 G060 missing panel facts are infrastructure blocks', async () => {
  expect(await reviewPanel(undefined, approve, snapshot, 1, 'run')).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
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
    (f: ReturnType<typeof fixture>) => { f.source.readSynthesis = async () => { throw Error('synthesis offline') } },
    (f: ReturnType<typeof fixture>) => { f.synthesis.runId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.synthesis.head = 'other' },
    (f: ReturnType<typeof fixture>) => { f.synthesis.round = 2 },
    (f: ReturnType<typeof fixture>) => { f.synthesis.checkpoint = 'review-started' },
  ]) {
    const f = fixture(); change(f); expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
  }
  const f = fixture(); expect(await f.check(null)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
  f.synthesis.payload = null; expect(await f.check(approve)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
})
test('review host exceptions retain their cause without changing the infrastructure classification', async () => {
  const f = fixture()
  f.source.readSynthesis = async () => { throw Error('synthesis transport offline') }
  expect(await f.check()).toEqual({
    kind: 'blocked',
    on: 'infra-only: Review panel host observation failed: Error: synthesis transport offline',
  })
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
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'], blockingCount: 2 } : { kind: 'approve' })
    f.synthesis.payload = f.seat.payload
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'], blockingCount: 3 } : { kind: 'approve' })
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
    expect(await f.check()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
  }
})

test('valid design gap buys one re-plan; later gaps and other declarations stop', async () => {
  const f = fixture()
  f.seat.payload = { verdict: 'REQUEST_CHANGES', findings: [finding], escalate: { kind: 'design-gap', whatIsMissing: 'execution spec lacks a requirement' } }
  expect(await f.check()).toMatchObject({ kind: 're-plan', findings: ['code.ts:f:correctness'] })
  expect(await reviewPanel(f.source, f.synthesis.payload, snapshot, 1, 'run', 1)).toMatchObject({ kind: 'blocked' })
  f.seat.payload = { verdict: 'REQUEST_CHANGES', findings: [], escalate: { kind: 'design-gap', whatIsMissing: '  ' } }
  expect(await f.check()).toMatchObject({ kind: 'blocked' })
  f.seat.payload = { verdict: 'REQUEST_CHANGES', findings: [], escalate: { kind: 'missing-dependency', whatIsMissing: 'required dependency' } }
  expect(await f.check()).toMatchObject({ kind: 'blocked' })
})

test('G140 same family warns and accepts; mixed families and disabled seats are respected', async () => {
  const { spyOn } = await import('bun:test')
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const f = fixture()
    f.source.seats = f.source.seats.map(seat => ({ ...seat, family: 'example-family' }))
    expect(await f.check()).toEqual({ kind: 'approve' })
    expect(warning.mock.calls.flat().join(' ')).toContain('panel-single-family')
    expect(warning.mock.calls.flat().join(' ')).toContain('configuration-accepted=true')
    warning.mockClear()
    expect(await reviewPanel(f.source, approve, snapshot, 1, 'run', 0,
      { provider: 'pi', modelId: 'builder', family: 'other-family' })).toEqual({ kind: 'approve' })
    expect(warning).not.toHaveBeenCalled()
    f.source.seats = [...f.source.seats, { id: 'disabled', provider: 'pi', modelId: 'other', family: 'other-family', role: 'peer', enabled: false }]
    expect(await f.check()).toEqual({ kind: 'approve' })
    expect(warning).toHaveBeenCalledTimes(1)
  } finally { warning.mockRestore() }
})

test('G140 identical model configuration warns without family metadata', async () => {
  const { spyOn } = await import('bun:test')
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const f = fixture()
    f.source.seats = f.source.seats.map(seat => ({ ...seat, provider: 'pi', modelId: 'same-model' }))
    expect(await f.check()).toEqual({ kind: 'approve' })
    expect(warning.mock.calls.flat().join(' ')).toContain('panel-single-family')
  } finally { warning.mockRestore() }
})
