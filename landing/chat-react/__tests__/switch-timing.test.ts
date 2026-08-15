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

import {
  SwitchTimer,
  buildSwitchReport,
  createSwitchTimingEmitter,
  type SwitchRecord,
} from '../switch-timing.ts'

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
    clock.advance(1_000)
    t.mark('transcript_read')
    clock.advance(400)
    t.mark('transcript')

    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.to).toBe('neutron-open')
    expect(r.from).toBe('general')
    expect(r.marks).toEqual({ vm_published: 12, socket_open: 312, transcript_read: 1312, transcript: 1712 })
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
    t.mark('transcript_read')
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
    t.mark('transcript_read')
    t.mark('transcript')

    expect(records[0]!.marks.socket_open).toBe(5)
  })

  test('marks after the flush are ignored rather than resurrecting the record', async () => {
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit })
    t.mark('vm_published')
    t.mark('socket_open')
    t.mark('transcript_read')
    t.mark('transcript')
    expect(records).toHaveLength(1)

    clock.advance(500)
    t.mark('transcript')
    expect(records).toHaveLength(1)
  })
})

describe('switch timing diagnostics', () => {
  test('vm → transcript → socket preserves absolute marks and invents no negative gap', () => {
    const record: SwitchRecord = {
      from: 'a',
      to: 'b',
      marks: { vm_published: 5, transcript: 10, socket_open: 20 },
      total: 20,
      incomplete: false,
    }

    const report = buildSwitchReport(record, 123)
    const context = report.events[0]!.context
    expect(context.marks).toEqual({ vm_published: 5, transcript: 10, socket_open: 20 })
    expect(context).not.toHaveProperty('gap_socket_to_transcript')
    expect(JSON.stringify(context)).not.toContain('-10')

    let line = ''
    const original = console.info
    console.info = (value?: unknown): void => { line = String(value) }
    try {
      createSwitchTimingEmitter(async () => {})(record)
    } finally {
      console.info = original
    }
    expect(line).toContain('vm=5ms socket=20ms transcript_read=- transcript=10ms')
    expect(line).not.toContain('gap_socket_to_transcript')
  })

  test('a rejected post is deferred, dropped, and cannot block or break emit', async () => {
    let called = false
    const emit = createSwitchTimingEmitter(async () => {
      called = true
      throw new Error('offline')
    })
    const record: SwitchRecord = {
      from: null,
      to: 'b',
      marks: { vm_published: 1 },
      total: 1,
      incomplete: true,
    }

    expect(() => emit(record)).not.toThrow()
    expect(called).toBe(false)
    await Promise.resolve()
    expect(called).toBe(true)
    await Promise.resolve()
  })

  test('A REUSED SOCKET COMPLETES THE SWITCH AND IS NOT REPORTED AS A FAILURE', async () => {
    // The warm cache returns a session whose socket is ALREADY open, so
    // `socket_open` never fires. That is the win. Reporting it as
    // `never_arrived` sent the owner a line that reads exactly like the failure
    // case — and did, once, before this test existed.
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit })
    clock.advance(1)
    t.mark('vm_published')
    clock.advance(800)
    t.mark('transcript_read')
    clock.advance(200)
    t.mark('transcript')

    // Completed WITHOUT socket_open — the optional mark must not hold it open
    // until the deadline.
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.incomplete).toBe(false)
    expect(r.marks.socket_open).toBeUndefined()
  })

  test('a MISSING REQUIRED mark still reports as incomplete', async () => {
    // The optional-mark change must not weaken the real failure case.
    const clock = fakeClock()
    const { emit, records } = collector()
    const t = new SwitchTimer('a', 'b', { now: clock.now, emit, deadlineMs: 5 })
    t.mark('vm_published')
    t.mark('socket_open')

    await new Promise((r) => setTimeout(r, 25))

    expect(records).toHaveLength(1)
    expect(records[0]!.incomplete).toBe(true)
    expect(records[0]!.marks.transcript).toBeUndefined()
  })
})

/**
 * The emitter's `.catch(() => undefined)` was the second of two silencers (the
 * first being a client that discarded its Response). Together they meant the
 * switch-timing pipeline could reject every single report and look exactly like
 * a system with nothing to say — which is what it did, for a day, while the
 * owner hand-pasted the numbers it was supposed to be delivering.
 */
describe('createSwitchTimingEmitter — a failed send is never silent', () => {
  const record = {
    to: 'beta',
    from: 'alpha',
    marks: { vm_published: 1.5, transcript_read: 900, transcript: 901 },
    total: 901,
  } as never

  function captureConsole(): { errs: string[]; restore: () => void } {
    const errs: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '))
    }
    return { errs, restore: () => { console.error = orig } }
  }

  test('a rejected send is reported to the console with its reason', async () => {
    const cap = captureConsole()
    try {
      const emit = createSwitchTimingEmitter(async () => {
        throw new Error('diagnostics report rejected: HTTP 403 from /api/app/admin/diagnostics/reports')
      })
      emit(record)
      await new Promise((r) => setTimeout(r, 0))
      expect(cap.errs.some((e) => e.includes('NOT delivered'))).toBe(true)
      expect(cap.errs.some((e) => e.includes('403'))).toBe(true)
    } finally {
      cap.restore()
    }
  })

  test('a repeated identical failure is latched — one line, not one per switch', async () => {
    // A broken ingest fails on EVERY switch. Forty identical lines is noise, and
    // noise is scrolled past, which is the same invisibility one layer up.
    const cap = captureConsole()
    try {
      const emit = createSwitchTimingEmitter(async () => {
        throw new Error('HTTP 403')
      })
      for (let i = 0; i < 5; i++) emit(record)
      await new Promise((r) => setTimeout(r, 0))
      expect(cap.errs.filter((e) => e.includes('NOT delivered')).length).toBe(1)
    } finally {
      cap.restore()
    }
  })

  test('a DIFFERENT failure reason still gets through the latch', async () => {
    const cap = captureConsole()
    try {
      let reason = 'HTTP 403'
      const emit = createSwitchTimingEmitter(async () => {
        throw new Error(reason)
      })
      emit(record)
      await new Promise((r) => setTimeout(r, 0))
      reason = 'HTTP 500'
      emit(record)
      await new Promise((r) => setTimeout(r, 0))
      expect(cap.errs.filter((e) => e.includes('NOT delivered')).length).toBe(2)
    } finally {
      cap.restore()
    }
  })

  test('a successful send logs nothing', async () => {
    const cap = captureConsole()
    try {
      const emit = createSwitchTimingEmitter(async () => undefined)
      emit(record)
      await new Promise((r) => setTimeout(r, 0))
      expect(cap.errs.filter((e) => e.includes('NOT delivered')).length).toBe(0)
    } finally {
      cap.restore()
    }
  })
})
