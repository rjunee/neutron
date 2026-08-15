/**
 * The project-switch stopwatch (`landing/chat-react/switch-timing.ts`).
 *
 * The headline tests are the two that decide whether this instrument is worth
 * trusting at all: that an INCOMPLETE switch still reports (a recorder silent on
 * the worst case measures nothing), and that the GAPS are what it reports — the
 * whole question is which step is slow, and a single elapsed number reproduces
 * exactly the ambiguity the module exists to remove.
 */

import { describe, expect, test } from 'bun:test'

import { SwitchTimer, type SwitchRecord } from '../switch-timing.ts'

/** A clock the test drives by hand, so no assertion depends on real elapsed time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0
  return { now: () => t, advance: (ms) => { t += ms } }
}

function collector(): { emit: (r: SwitchRecord) => void; records: SwitchRecord[] } {
  const records: SwitchRecord[] = []
  return { emit: (r) => { records.push(r) }, records }
}

describe('SwitchTimer', () => {
  test('a complete switch reports every mark, measured from the CLICK', async () => {
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('general', 'neutron-open', { now: clock.now, emit })

    clock.advance(12)
    t.mark('vm_published')
    clock.advance(300)
    t.mark('socket_open')
    clock.advance(1_400)
    t.mark('transcript')

    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.to).toBe('neutron-open')
    expect(r.from).toBe('general')
    expect(r.marks).toEqual({ vm_published: 12, socket_open: 312, transcript: 1712 })
    // The number the owner feels is the LAST mark, not the sum of the gaps.
    expect(r.total).toBe(1712)
    expect(r.incomplete).toBe(false)
  })

  test('it emits ONCE, on the final mark — not per mark', async () => {
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer(null, 'p', { now: clock.now, emit })
    t.mark('vm_published')
    expect(records).toHaveLength(0)
    t.mark('socket_open')
    expect(records).toHaveLength(0)
    t.mark('transcript')
    expect(records).toHaveLength(1)
  })

  test('AN INCOMPLETE SWITCH STILL REPORTS, and names what never arrived', async () => {
    // The switch that never finishes is the most interesting one. A recorder that
    // only emits on completion is silent for exactly that case.
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit, deadlineMs: 5 })
    clock.advance(9)
    t.mark('vm_published')

    await new Promise((r) => setTimeout(r, 25))

    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.incomplete).toBe(true)
    expect(r.marks.vm_published).toBe(9)
    expect(r.marks.socket_open).toBeUndefined()
    expect(r.marks.transcript).toBeUndefined()
    // It still carries the one number it managed to observe.
    expect(r.total).toBe(9)
  })

  test('a superseded switch reports its partial marks — the user gave up waiting', async () => {
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit })
    clock.advance(7)
    t.mark('vm_published')
    t.supersede()

    expect(records).toHaveLength(1)
    expect(records[0]!.incomplete).toBe(true)
    expect(records[0]!.marks.vm_published).toBe(7)
  })

  test('the FIRST stamp of a mark wins, so a reconnect cannot rewrite history', async () => {
    // A second `socket_open` from a later reconnect must not overwrite the one
    // the user actually waited through.
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit })
    clock.advance(5)
    t.mark('socket_open')
    clock.advance(900)
    t.mark('socket_open')
    t.mark('vm_published')
    t.mark('transcript')

    expect(records[0]!.marks.socket_open).toBe(5)
  })

  test('marks after the flush are ignored rather than resurrecting the record', async () => {
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit })
    t.mark('vm_published')
    t.mark('socket_open')
    t.mark('transcript')
    expect(records).toHaveLength(1)

    clock.advance(500)
    t.mark('transcript')
    expect(records).toHaveLength(1)
  })
})
