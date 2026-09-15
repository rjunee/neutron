import { describe, expect, test } from 'bun:test'

import { ciReadinessForHead, isCiGreen, type CiRunObservation } from '../ci-readiness'

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OLD_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function verdict(observation: CiRunObservation) {
  return ciReadinessForHead(HEAD, observation)
}

describe('host-owned CI readiness', () => {
  test('only a successful completed run for the requested head is green', () => {
    const out = verdict({ kind: 'completed', headSha: HEAD, conclusion: 'success' })
    expect(out).toEqual({ kind: 'green', headSha: HEAD })
    expect(isCiGreen(out)).toBe(true)
  })

  test('a verdict for another head is refused', () => {
    const out = verdict({ kind: 'completed', headSha: OLD_HEAD, conclusion: 'success' })
    expect(out).toEqual({ kind: 'wrong-head', headSha: HEAD, observedHeadSha: OLD_HEAD })
    expect(isCiGreen(out)).toBe(false)
  })

  test('no run exists is explicit and is not green', () => {
    const out = verdict({ kind: 'absent' })
    expect(out).toEqual({ kind: 'no-run', headSha: HEAD })
    expect(isCiGreen(out)).toBe(false)
  })

  test('an in-progress run is distinct from no run and is not green', () => {
    const out = verdict({ kind: 'running', headSha: HEAD })
    expect(out).toEqual({ kind: 'in-progress', headSha: HEAD })
    expect(isCiGreen(out)).toBe(false)
  })

  test('a failed run is red', () => {
    const out = verdict({ kind: 'completed', headSha: HEAD, conclusion: 'failure' })
    expect(out).toEqual({ kind: 'red', headSha: HEAD })
    expect(isCiGreen(out)).toBe(false)
  })

  test('an unreadable run is neither red nor green', () => {
    const out = verdict({ kind: 'unreadable', reason: 'probe unavailable' })
    expect(out).toEqual({ kind: 'cannot-read', headSha: HEAD, reason: 'probe unavailable' })
    expect(out.kind).not.toBe('red')
    expect(isCiGreen(out)).toBe(false)
  })
})
