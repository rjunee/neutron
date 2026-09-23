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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
// Drain runnable promise continuations without a wall-clock latency assertion.
const drain = () => new Promise<void>(resolve => setImmediate(resolve))

test('panel starts every enabled seat before release and synthesizes only after the last settles', async () => {
  const f = fixture()
  f.source.seats = [...f.source.seats, { ...f.source.seats[1]!, id: 'disabled', enabled: false }]
  const pending = new Map(['core', 'peer'].map(id => [id, deferred<SeatObservation>()]))
  const started: string[] = [], synthesized: string[] = []
  f.source.readSeat = config => { started.push(config.id); return pending.get(config.id)!.promise }
  f.source.readSynthesis = async () => { synthesized.push('synthesis'); return f.synthesis }
  let settled = false
  const result = f.check().then(value => { settled = true; return value })
  try {
    await drain()
    expect(started).toEqual(['core', 'peer'])
    expect(synthesized).toEqual([])
    expect(settled).toBe(false)
    const peer = f.source.seats[1]!
    pending.get('peer')!.resolve({ ...f.seat, provider: peer.provider, modelId: peer.modelId,
      payload: { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, symbol: 'peer' }] } })
    await drain()
    expect(synthesized).toEqual([])
    expect(settled).toBe(false)
    pending.get('core')!.resolve({ ...f.seat,
      payload: { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, symbol: 'core' }] } })
    expect(await result).toEqual({ kind: 'fix', findings: ['code.ts:core:correctness', 'code.ts:peer:correctness'], blockingCount: 2 })
    expect(synthesized).toEqual(['synthesis'])
    expect(f.retries()).toBe(0)
  } finally {
    for (const config of f.source.seats.filter(seat => seat.enabled)) {
      pending.get(config.id)!.resolve({ ...f.seat, provider: config.provider, modelId: config.modelId })
    }
    await result
  }
})

test('panel drains siblings after a rejected seat and preserves configured refusal order', async () => {
  for (const rejectFirst of [true, false]) {
    const f = fixture()
    const pending = [deferred<SeatObservation>(), deferred<SeatObservation>()]
    const started: string[] = []
    let synthesized = false, settled = false
    f.source.readSeat = config => { started.push(config.id); return pending[config.id === 'core' ? 0 : 1]!.promise }
    f.source.readSynthesis = async () => { synthesized = true; return f.synthesis }
    const result = f.check().then(value => { settled = true; return value })
    try {
      await drain()
      expect(started).toEqual(['core', 'peer'])
      pending[rejectFirst ? 0 : 1]!.reject(Error('transport offline'))
      await drain()
      expect(settled).toBe(false)
      expect(synthesized).toBe(false)
      // A lower-index bad observation wins over a faster higher-index rejection.
      const config = f.source.seats[rejectFirst ? 1 : 0]!
      pending[rejectFirst ? 1 : 0]!.resolve({ ...f.seat, provider: config.provider, modelId: config.modelId, head: 'wrong' })
      expect(await result).toEqual({ kind: 'blocked', on: rejectFirst
        ? 'infra-only: Review panel host observation failed: Error: transport offline'
        : 'infra-only: Review seat core (pi) provenance does not match run, revision, round, provider or model' })
      expect(synthesized).toBe(false)
    } finally {
      for (const [index, config] of f.source.seats.entries()) pending[index]!.resolve({ ...f.seat, provider: config.provider, modelId: config.modelId })
      await result
    }
  }
})

test('invalid panel admission starts no seat or synthesis work', async () => {
  for (const invalid of ['trailer', 'configuration'] as const) {
    const f = fixture()
    let syntheses = 0
    f.source.readSynthesis = async () => { syntheses++; return f.synthesis }
    if (invalid === 'configuration') f.source.seats = [...f.source.seats, f.source.seats[0]!]
    expect(await f.check(invalid === 'trailer' ? null : approve)).toMatchObject({ kind: 'blocked' })
    expect(f.reads()).toBe(0)
    expect(f.retries()).toBe(0)
    expect(syntheses).toBe(0)
  }
  const valid = fixture()
  expect(await valid.check()).toEqual({ kind: 'approve' })
  expect(valid.reads()).toBe(2)
})

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
test('host synthesis unavailability preserves its reason only after exact provenance validation', async () => {
  const f = fixture()
  const unavailable = { runId: 'run', head: snapshot.head, round: 1, unavailable: 'provider rate limit (HTTP 429)' }
  f.source.readSynthesis = async () => unavailable
  expect(await f.check()).toEqual({ kind: 'blocked', on: 'infra-only: Review synthesis unavailable: provider rate limit (HTTP 429)' })
  for (const change of [{ runId: 'other' }, { head: 'b'.repeat(40) }, { round: 2 }]) {
    f.source.readSynthesis = async () => ({ ...unavailable, ...change })
    expect(await f.check()).toEqual({ kind: 'blocked', on: 'infra-only: Review synthesis provenance does not match run, revision and round' })
  }
  f.source.readSynthesis = async () => f.synthesis
  expect(await f.check()).toEqual({ kind: 'approve' })
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
test('independent review and synthesis retain unresolved verdicts without requiring identical payloads', async () => {
  const f = fixture()
  expect(await f.check({ verdict: 'REQUEST_CHANGES', findings: [] })).toMatchObject({ kind: 'blocked' })
  expect(await f.check({ findings: [], verdict: 'APPROVE' })).toEqual({ kind: 'approve' })
})
test('independent review and synthesis blockers each veto approval and divergent findings reach fixes', async () => {
  const workerFinding = { ...finding, symbol: 'workerFinding', title: 'worker defect' }
  const synthesisFinding = { ...finding, symbol: 'synthesisFinding', title: 'synthesis defect' }
  for (const [workerFindings, synthesisFindings] of [
    [[workerFinding], []],
    [[], [synthesisFinding]],
    [[workerFinding], [synthesisFinding]],
  ]) {
    const f = fixture()
    f.synthesis.payload = { verdict: synthesisFindings!.length ? 'REQUEST_CHANGES' : 'APPROVE', findings: synthesisFindings }
    expect(await f.check({ verdict: workerFindings!.length ? 'REQUEST_CHANGES' : 'APPROVE', findings: workerFindings })).toEqual({
      kind: 'fix',
      findings: [...workerFindings!, ...synthesisFindings!].map(value => `code.ts:${value.symbol}:correctness`),
      blockingCount: workerFindings!.length + synthesisFindings!.length,
    })
    expect(f.reads()).toBe(2)
  }
})
test('standalone review exemptions and escalation cannot be hidden by approving synthesis', async () => {
  const f = fixture()
  expect(await f.check({ ...approve, findings: [{ ...finding, advisory: true, kind: 'suite' }] })).toEqual({
    kind: 'fix', findings: ['code.ts:f:correctness'], blockingCount: 1,
  })
  expect(await f.check({ ...approve, escalate: { kind: 'design-gap', whatIsMissing: 'missing requirement' } })).toMatchObject({
    kind: 'blocked', on: expect.stringContaining('orchestrator arbitration'),
  })
})
test('review severity, minority veto and stable identities drive fixes and arbitration', async () => {
  for (const severity of ['major', 'blocker', 'minor', 'nit']) {
    const f = fixture(); f.seat.payload = { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, severity }] }
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'], blockingCount: 2 } : { kind: 'approve' })
    f.synthesis.payload = f.seat.payload
    expect(await f.check()).toEqual(severity === 'major' || severity === 'blocker' ? { kind: 'fix', findings: ['code.ts:f:correctness'], blockingCount: 4 } : { kind: 'approve' })
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
