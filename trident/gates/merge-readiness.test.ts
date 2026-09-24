import { expect, spyOn, test } from 'bun:test'
import { awaitMergeReadiness } from './merge-readiness.ts'
import { REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS } from './review-readiness.ts'

test('merge readiness bounds pending checks and accepts only a timely settled sibling', async () => {
  for (const settle of [true, false]) {
    let now = 0, probes = 0
    const waits: number[] = []
    const result = await awaitMergeReadiness(async () => ++probes === 2 && settle
      ? { kind: 'allow' } : { kind: 'pending', detail: 'CI: in-progress' }, new AbortController().signal,
    { now: () => now, wait: async ms => { waits.push(ms); now += ms } })
    expect(result).toEqual(settle ? { kind: 'allow' } : { kind: 'unknown', detail: 'Merge readiness deferred: CI: in-progress; budget exhausted' })
    expect(waits).toEqual(Array(settle ? 1 : 30).fill(REVIEW_READINESS_RETRY_MS))
    expect(now).toBe(settle ? REVIEW_READINESS_RETRY_MS : REVIEW_READINESS_BUDGET_MS)
  }
})

test('merge readiness rejects late green and propagates an immediate red refusal', async () => {
  let now = 0
  const time = { now: () => now, wait: async () => { throw new Error('unexpected wait') } }
  expect(await awaitMergeReadiness(async () => { now += REVIEW_READINESS_BUDGET_MS; return { kind: 'allow' } }, new AbortController().signal, time))
    .toMatchObject({ kind: 'unknown', detail: expect.stringContaining('budget exhausted') })
  expect(await awaitMergeReadiness(async () => ({ kind: 'blocked', on: 'CI: red' }), new AbortController().signal, time))
    .toEqual({ kind: 'blocked', on: 'CI: red' })
})

test('merge readiness cancellation releases a hung observer and never probes after pre-abort', async () => {
  const controller = new AbortController()
  let probes = 0
  const observe = async () => { probes++; controller.abort(); return new Promise<never>(() => {}) }
  expect(await awaitMergeReadiness(observe, controller.signal)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('cancelled') })
  expect(probes).toBe(1)
  expect(await awaitMergeReadiness(observe, controller.signal)).toMatchObject({ kind: 'unknown' })
  expect(probes).toBe(1)
})

test('merge readiness watchdog bounds a hung observer even when its elapsed clock stalls', async () => {
  const original = globalThis.setTimeout
  let expire: (() => void) | undefined, observedSignal: AbortSignal | undefined
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
    if (ms === REVIEW_READINESS_BUDGET_MS) expire = callback
    return original(callback, ms)
  }) as typeof setTimeout)
  try {
    const result = awaitMergeReadiness(async signal => { observedSignal = signal; return new Promise(() => {}) }, new AbortController().signal,
      { now: () => 0, wait: async () => {} })
    expect(expire).toBeDefined()
    expire!()
    expect(await result).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('budget exhausted') })
    expect(observedSignal?.aborted).toBe(true)
  } finally { timer.mockRestore() }
})
