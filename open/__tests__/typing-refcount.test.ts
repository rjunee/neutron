/**
 * The typing refcount's suppression guard and its fail-safe — the two things the
 * reviewers said had no killing coverage.
 *
 * THE FINDING, verbatim, on PR #145: *"Typing-refcount suppression guard and
 * 46-minute fail-safe have zero killing test coverage, and depth can leak
 * permanently."* Both halves were true, and neither was reachable: the logic was a
 * closure inside `wireAppWs`, and the fail-safe was a real
 * `setTimeout(…, 46 * 60_000)`. No test waits 46 minutes, and a test that reaches
 * into a closure is not testing the production path.
 *
 * So `createTypingRefcount` takes its scheduler as a PARAMETER, and these tests
 * capture the scheduled callback and invoke it. What runs is the same code the
 * 46-minute path runs — the only difference is who calls it.
 *
 * WHY THE LEAK MATTERS, in the owner's terms: `depth` gates whether an
 * `agent_typing` frame is emitted at all. A depth stuck above zero means every
 * later turn on that topic shows NO typing indicator — the chat looks dead while
 * the agent is working — and it stays that way until the process restarts.
 */
import { describe, expect, test } from 'bun:test'

import {
  createTypingRefcount,
  TYPING_FAILSAFE_MS,
  type TypingScheduler,
} from '../wiring/typing-refcount.ts'
import { sendTypingCatchUp } from '../wiring/typing-catchup.ts'

/** A scheduler that records instead of waiting, so a test can fire the timer. */
function fakeScheduler(): TypingScheduler & {
  fireAll(): void
  pending(): number
  cancelled: number
  lastMs: number | null
} {
  let seq = 0
  const timers = new Map<number, () => void>()
  return {
    cancelled: 0,
    lastMs: null,
    schedule(fn, ms) {
      seq += 1
      this.lastMs = ms
      timers.set(seq, fn)
      return seq
    },
    cancel(handle) {
      if (timers.delete(handle as number)) this.cancelled += 1
    },
    fireAll() {
      // Copy first: a callback may schedule again.
      for (const [, fn] of [...timers]) fn()
    },
    pending() {
      return timers.size
    },
  }
}

const KEY = 'app:owner:proj'

function make(onExpire: (key: string) => void = () => {}) {
  const scheduler = fakeScheduler()
  const rc = createTypingRefcount({ scheduler, onExpire })
  return { rc, scheduler }
}

describe('the suppression guard — one visible typing lifetime per topic', () => {
  test('connect catch-up neither changes depth nor re-arms the fail-safe', () => {
    const { rc, scheduler } = make()
    rc.transition(KEY, 'start')
    const scheduledMs = scheduler.lastMs
    const pending = scheduler.pending()
    const sent: unknown[] = []
    expect(sendTypingCatchUp({ active: new Set(['proj']), key: 'proj', now: () => 7, send: (f) => sent.push(f) })).toBe(true)
    expect(sent).toHaveLength(1)
    expect(rc.depthOf(KEY)).toBe(1)
    expect(scheduler.pending()).toBe(pending)
    expect(scheduler.lastMs).toBe(scheduledMs)
    rc.transition(KEY, 'end')
    expect(rc.transition(KEY, 'start').emit).toBe(true)
  })

  test('connect catch-up sends nothing when the shared active set is quiet', () => {
    const sent: unknown[] = []
    expect(sendTypingCatchUp({ active: new Set(), key: 'proj', now: () => 7, send: (f) => sent.push(f) })).toBe(false)
    expect(sent).toEqual([])
  })
  test('the first start emits; a nested start does NOT', () => {
    const { rc } = make()
    expect(rc.transition(KEY, 'start').emit).toBe(true)
    expect(rc.transition(KEY, 'start').emit).toBe(false)
  })

  test('the INNER end does not emit — this is the bug it exists to prevent', () => {
    // Two overlapping turns. Turn two finishes fast. If its `end` emitted, turn
    // one's dots would clear while it is still working, which is exactly what the
    // owner reported as the indicator "stopping early".
    const { rc } = make()
    rc.transition(KEY, 'start')
    rc.transition(KEY, 'start')
    expect(rc.transition(KEY, 'end').emit).toBe(false)
    expect(rc.transition(KEY, 'end').emit).toBe(true)
  })

  test('depth returns to zero, so the NEXT turn emits again', () => {
    const { rc } = make()
    rc.transition(KEY, 'start')
    rc.transition(KEY, 'end')
    expect(rc.depthOf(KEY)).toBe(0)
    expect(rc.transition(KEY, 'start').emit).toBe(true)
  })

  test('a stray end never drives depth negative', () => {
    // A negative depth would make the next real `end` fail to emit, wedging the
    // dots on — the mirror image of the leak.
    const { rc } = make()
    expect(rc.transition(KEY, 'end').emit).toBe(true)
    expect(rc.depthOf(KEY)).toBe(0)
    expect(rc.transition(KEY, 'start').emit).toBe(true)
  })

  test('topics are independent — one busy topic cannot suppress another', () => {
    const { rc } = make()
    rc.transition('a:1', 'start')
    expect(rc.transition('b:2', 'start').emit).toBe(true)
    expect(rc.depthOf('a:1')).toBe(1)
  })
})

describe('the fail-safe — a lost end cannot suppress typing forever', () => {
  test('a never-ended turn expires, and the expiry is reported', () => {
    // THE LEAK, killed. Without the fail-safe, depth stays 1 for the process's
    // whole life and every later turn on this topic shows no indicator at all.
    const expired: string[] = []
    const { rc, scheduler } = make((k) => expired.push(k))
    rc.transition(KEY, 'start')
    expect(rc.depthOf(KEY)).toBe(1)

    scheduler.fireAll()

    expect(expired).toEqual([KEY])
    expect(rc.depthOf(KEY)).toBe(0)
    // And the topic is usable again: the next start is a visible edge.
    expect(rc.transition(KEY, 'start').emit).toBe(true)
  })

  test('the window sits OUTSIDE the turn ceiling, so it only fires when the end was lost', () => {
    // 46 minutes against the live turn's own 45-minute absolute ceiling. Inside
    // it, this would race the ceiling and clear the dots on a turn that is still
    // legitimately running.
    const { rc, scheduler } = make()
    rc.transition(KEY, 'start')
    expect(scheduler.lastMs).toBe(TYPING_FAILSAFE_MS)
    expect(TYPING_FAILSAFE_MS).toBeGreaterThan(45 * 60_000)
  })

  test('a completed turn leaves NO timer behind', () => {
    const { rc, scheduler } = make()
    rc.transition(KEY, 'start')
    rc.transition(KEY, 'end')
    expect(scheduler.pending()).toBe(0)
  })

  test('the window is RE-ARMED while the count stays positive', () => {
    // A long conversation of overlapping turns must not expire mid-flight: each
    // transition that leaves the count positive cancels the old timer and arms a
    // fresh one.
    const { rc, scheduler } = make()
    rc.transition(KEY, 'start')
    rc.transition(KEY, 'start')
    rc.transition(KEY, 'end')
    expect(scheduler.cancelled).toBe(2)
    expect(scheduler.pending()).toBe(1)
    expect(rc.depthOf(KEY)).toBe(1)
  })

  test('an already-cancelled timer that runs anyway does NOT clear a live entry', () => {
    // The stale-timer race. A timer can be cancelled after its callback has been
    // queued; if it then deleted the entry, a brand-new start's dots would be
    // cleared by the previous turn's expiry. The identity check is what stops it.
    const expired: string[] = []
    // Held in an object: a plain `let` assigned only inside the closure is narrowed
    // to `never` by control-flow analysis, so `captured?.()` fails to typecheck.
    const box: { fn: (() => void) | null } = { fn: null }
    const scheduler: TypingScheduler = {
      schedule(fn) {
        if (box.fn === null) box.fn = fn // keep only the FIRST timer
        return Symbol('h')
      },
      cancel() {
        /* deliberately a no-op: model a cancel that lost the race */
      },
    }
    const rc = createTypingRefcount({ scheduler, onExpire: (k) => expired.push(k) })
    rc.transition(KEY, 'start') // arms timer #1
    rc.transition(KEY, 'start') // re-arms; timer #1 is now stale
    box.fn?.()
    expect(expired).toEqual([])
    expect(rc.depthOf(KEY)).toBe(2)
  })
})
