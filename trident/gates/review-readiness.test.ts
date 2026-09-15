import { expect, spyOn, test } from 'bun:test'
import { awaitReviewReadiness, classifyReviewReadiness, type ReviewReadinessObservation, type ReadinessClock } from './review-readiness.ts'

const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
type Known = Extract<ReviewReadinessObservation, { kind: 'known' }>
const observation = (patch: Partial<Known> = {}): Known => ({ kind: 'known', head: snapshot.head, configuration: { kind: 'resolved', required: ['test'] }, mergeability: 'mergeable', checksComplete: true, checks: [{ name: 'test', state: 'passed' }], ...patch })
const classify = (patch: Partial<Known>) => classifyReviewReadiness(snapshot, observation(patch))
function clock() {
  let now = 0
  const waits: number[] = []
  const time: ReadinessClock = { now: () => now, wait: async ms => { waits.push(ms); now += ms } }
  return { time, waits, advance: (ms: number) => { now += ms } }
}

test('G044 configuration must be known, independently of green check rows', () => {
  expect(classify({ configuration: { kind: 'unknown', detail: 'protection unreadable' } })).toEqual({ kind: 'unknown', detail: 'Required check configuration: protection unreadable' })
  expect(classify({})).toEqual({ kind: 'passed', failed: [] })
})
test('G047 mergeability must be measured; conflicts stop and pending waits', () => {
  expect(classify({ mergeability: 'conflicting' })).toMatchObject({ kind: 'blocked' })
  expect(classify({ mergeability: 'pending' })).toMatchObject({ kind: 'pending' })
  expect(classify({})).toMatchObject({ kind: 'passed' })
})
test('G049 every named check must run and settle, including duplicate rows', () => {
  for (const checks of [[], [{ name: 'test', state: 'skipped' }], [{ name: 'test', state: 'running' }], [{ name: 'test', state: 'passed' }, { name: 'test', state: 'running' }]] as Known['checks'][]) {
    expect(classify({ checks })).toMatchObject({ kind: 'pending' })
  }
  expect(classify({ checks: [{ name: 'test', state: 'passed' }, { name: 'other', state: 'running' }] })).toMatchObject({ kind: 'passed' })
  expect(classify({ checks: [{ name: 'test', state: 'failed' }] })).toEqual({ kind: 'failed', failed: ['test'] })
})
test('G052 unnamed checks cannot be empty, skipped-only or unsettled', () => {
  const configuration = { kind: 'resolved', required: [] } as const
  for (const checks of [[], [{ name: 'test', state: 'skipped' }], [{ name: 'test', state: 'passed' }, { name: 'other', state: 'running' }]] as Known['checks'][]) expect(classify({ configuration, checks })).toMatchObject({ kind: 'pending' })
  expect(classify({ configuration })).toMatchObject({ kind: 'passed' })
})
test('G053 readiness spends 900000 ms in 30000 ms waits without review', async () => {
  const c = clock(); let probes = 0
  const result = await awaitReviewReadiness({ observe: async () => { probes++; return observation({ checks: [] }) } }, snapshot, new AbortController().signal, c.time)
  expect(result).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('budget exhausted') })
  expect(c.waits).toEqual(Array(30).fill(30000))
  expect(probes).toBe(30)
  const ready = clock(); let attempts = 0
  expect(await awaitReviewReadiness({ observe: async () => observation({ checks: ++attempts === 1 ? [] : [{ name: 'test', state: 'passed' }] }) }, snapshot, new AbortController().signal, ready.time)).toEqual({ kind: 'allow' })
  expect(ready.waits).toEqual([30000])
})
test('G054 only settled pass and failure can spend review', async () => {
  for (const state of ['passed', 'failed'] as const) expect(await awaitReviewReadiness({ observe: async () => observation({ checks: [{ name: 'test', state }] }) }, snapshot, new AbortController().signal)).toEqual({ kind: 'allow' })
  for (const value of [observation({ mergeability: 'conflicting' }), { kind: 'unknown', detail: 'configuration error cannot be established' }, observation({ configuration: { kind: 'unknown', detail: 'offline' } })] as ReviewReadinessObservation[]) {
    const c = clock()
    expect((await awaitReviewReadiness({ observe: async () => value }, snapshot, new AbortController().signal, c.time)).kind).not.toBe('allow')
    expect(c.waits).toEqual([])
  }
})
test('readiness cannot outlive cancellation or accept late and wrong-head observations', async () => {
  expect(classify({ head: 'b'.repeat(40) })).toMatchObject({ kind: 'unknown' })
  expect(classify({ checks: [{ name: '', state: 'passed' }] })).toMatchObject({ kind: 'unknown' })
  expect(await awaitReviewReadiness(undefined, snapshot, new AbortController().signal)).toMatchObject({ kind: 'unknown' })
  expect(await awaitReviewReadiness({ observe: async () => { throw Error('offline') } }, snapshot, new AbortController().signal)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('offline') })
  const c = clock()
  expect(await awaitReviewReadiness({ observe: async () => { c.advance(900000); return observation() } }, snapshot, new AbortController().signal, c.time)).toMatchObject({ kind: 'unknown' })
  const controller = new AbortController()
  const pending = awaitReviewReadiness({ observe: async () => { controller.abort(); return new Promise(() => {}) } }, snapshot, controller.signal)
  expect(await pending).toMatchObject({ kind: 'unknown' })
})


test('G053 watchdog defers even when the observation never settles', async () => {
  const original = globalThis.setTimeout
  let expire: (() => void) | undefined
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
    if (ms === 900000) expire = callback
    return original(callback, ms)
  }) as typeof setTimeout)
  try {
    const result = awaitReviewReadiness({ observe: async () => new Promise(() => {}) }, snapshot, new AbortController().signal)
    expect(expire).toBeDefined()
    expire!()
    expect(await result).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('budget exhausted') })
  } finally { timer.mockRestore() }
})

test('malformed configuration tags cannot masquerade as a resolved empty set', () => {
  const configuration = { kind: 'garbled', required: [] } as unknown as Known['configuration']
  expect(classify({ configuration })).toEqual({ kind: 'unknown', detail: 'Required check configuration is not resolved' })
  expect(classify({})).toMatchObject({ kind: 'passed' })
})


test('G046 truncated evidence cannot satisfy a required name', () => {
  expect(classify({ checksComplete: false })).toMatchObject({ kind: 'pending' })
  const missing = observation(); delete missing.checksComplete
  expect(classifyReviewReadiness(snapshot, missing)).toMatchObject({ kind: 'pending' })
  expect(classify({ checksComplete: true })).toEqual({ kind: 'passed', failed: [] })
})

test('G046 unreadable evidence waits and retries rather than refusing', async () => {
  const c = clock(); let probes = 0
  const result = await awaitReviewReadiness({ observe: async () => observation({
    checksComplete: ++probes > 1, checks: [{ name: 'test', state: 'failed' }],
  }) }, snapshot, new AbortController().signal, c.time)
  expect(c.waits).toEqual([30000])
  expect(probes).toBe(2)
  expect(result).toEqual({ kind: 'allow' })
})
