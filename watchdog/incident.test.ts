/**
 * @neutronai/watchdog — IncidentEdgeTracker (F4).
 *
 * Proves incident-edge dedup with COMMIT-ON-SUCCESS: a candidate is NOT latched
 * until `commitById` runs (after delivery), so a persist/notify failure re-emits
 * next tick; a committed incident stays silent while it holds; a resolved-then-
 * recurring condition is a NEW incident.
 */

import { describe, expect, test } from 'bun:test'
import { IncidentEdgeTracker } from './incident.ts'

describe('IncidentEdgeTracker (F4)', () => {
  test('candidates does NOT latch until commit — a failed delivery re-emits', () => {
    const t = new IncidentEdgeTracker()
    const id = (k: string) => `id-${k}`
    // First observation → candidate, but NOT committed (caller delivery failed).
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'id-k' }])
    expect(t.openKeys()).toEqual([]) // nothing latched
    // Next tick, still firing, still uncommitted → SAME candidate re-emitted
    // (stable id — a retry of the same incident, not a new one).
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'id-k' }])
    // Delivery now succeeds → commit.
    t.commitById('id-k')
    expect(t.openKeys()).toEqual(['k'])
    // Committed → suppressed while it holds.
    expect(t.candidates(['k'], id)).toEqual([])
  })

  test('a committed incident fires exactly once while the condition holds', () => {
    const t = new IncidentEdgeTracker()
    let n = 0
    const id = () => `k:${n}`
    const first = t.candidates(['k'], id)
    expect(first).toEqual([{ key: 'k', id: 'k:0' }])
    t.commitById('k:0') // delivered
    n = 1
    expect(t.candidates(['k'], id)).toEqual([]) // held — suppressed
    n = 2
    expect(t.candidates(['k'], id)).toEqual([]) // still held
  })

  test('a resolved-then-recurring condition is a fresh incident (new id)', () => {
    const t = new IncidentEdgeTracker()
    let n = 0
    const id = () => `k:${n}`
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'k:0' }])
    t.commitById('k:0')
    n = 1
    expect(t.candidates([], id)).toEqual([]) // resolved — cleared
    expect(t.openKeys()).toEqual([])
    n = 2
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'k:2' }]) // NEW incident
  })

  test('an uncommitted candidate that resolves before delivery is dropped (no stale latch)', () => {
    const t = new IncidentEdgeTracker()
    const id = (k: string) => `id-${k}`
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'id-k' }]) // never committed
    expect(t.candidates([], id)).toEqual([]) // condition cleared → pending dropped
    // A fresh occurrence is a clean rising edge again.
    expect(t.candidates(['k'], id)).toEqual([{ key: 'k', id: 'id-k' }])
  })

  test('tracks multiple keys independently', () => {
    const t = new IncidentEdgeTracker()
    const id = (k: string) => `id-${k}`
    expect(t.candidates(['a', 'b'], id).map((r) => r.key).sort()).toEqual(['a', 'b'])
    t.commitById('id-a')
    t.commitById('id-b')
    // b resolves, c appears, a holds → only c is a rising edge.
    expect(t.candidates(['a', 'c'], id)).toEqual([{ key: 'c', id: 'id-c' }])
    t.commitById('id-c')
    expect(t.openKeys().sort()).toEqual(['a', 'c'])
  })
})
