/**
 * @neutronai/watchdog — IncidentEdgeTracker (F4 Blocker-1 fix).
 *
 * Proves the storm fix: a persistent condition fires ONCE (rising edge) and
 * stays silent while it holds; a resolved-then-recurring condition is a NEW
 * incident that fires again.
 */

import { describe, expect, test } from 'bun:test'
import { IncidentEdgeTracker } from './incident.ts'

describe('IncidentEdgeTracker (F4)', () => {
  test('fires once on the rising edge, silent while the condition holds', () => {
    const t = new IncidentEdgeTracker()
    let n = 0
    const id = () => `k:${n}`
    expect(t.rising(['k'], id)).toEqual([{ key: 'k', id: 'k:0' }]) // rising
    n = 1
    expect(t.rising(['k'], id)).toEqual([]) // held — suppressed
    n = 2
    expect(t.rising(['k'], id)).toEqual([]) // still held
    expect(t.openKeys()).toEqual(['k'])
  })

  test('a resolved-then-recurring condition is a fresh incident', () => {
    const t = new IncidentEdgeTracker()
    let n = 0
    const id = () => `k:${n}`
    expect(t.rising(['k'], id)).toEqual([{ key: 'k', id: 'k:0' }]) // incident 1
    n = 1
    expect(t.rising([], id)).toEqual([]) // resolved — cleared
    expect(t.openKeys()).toEqual([])
    n = 2
    expect(t.rising(['k'], id)).toEqual([{ key: 'k', id: 'k:2' }]) // incident 2 — NEW id
  })

  test('tracks multiple keys independently', () => {
    const t = new IncidentEdgeTracker()
    const id = (k: string) => `id-${k}`
    expect(t.rising(['a', 'b'], id).map((r) => r.key).sort()).toEqual(['a', 'b'])
    // b resolves, c appears, a holds → only c is a rising edge.
    expect(t.rising(['a', 'c'], id)).toEqual([{ key: 'c', id: 'id-c' }])
    expect(t.openKeys().sort()).toEqual(['a', 'c'])
  })
})
