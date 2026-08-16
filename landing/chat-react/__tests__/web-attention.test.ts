/**
 * "Actively using" — the decision, and the DOM shell around it.
 *
 * The owner asked for a phone that stays quiet while he is *actively using* the
 * web app. The first cut answered "is the tab un-hidden?", which is a different
 * question with a much larger true-set: a chat window on a second monitor is
 * un-hidden for as long as the machine is awake. Since the only observable
 * consequence of getting this wrong is a phone that stops notifying — silence,
 * which nobody reports — the predicate gets a suite rather than a comment.
 *
 * Every negative assertion below sits next to the positive it is the absence of.
 */

import { describe, expect, it } from 'bun:test'

import {
  ATTENTION_POLL_MS,
  DEFAULT_ATTENTION_IDLE_MS,
  decideAttention,
  observeWebAttention,
} from '../web-attention.ts'

describe('decideAttention', () => {
  const USING = { visible: true, focused: true, ms_since_interaction: 1_000 }

  it('all three signals together mean he is using it', () => {
    expect(decideAttention(USING)).toBe(true)
  })

  it('a HIDDEN tab is not being used, however recently he touched it', () => {
    expect(decideAttention({ ...USING, visible: false })).toBe(false)
  })

  it('a VISIBLE but UNFOCUSED window is not being used — the second-monitor case', () => {
    // This is the one that matters most in practice, and the one visibility
    // alone gets wrong: the window is right there, he can see it, and he is
    // typing in something else.
    expect(decideAttention({ ...USING, focused: false })).toBe(false)
  })

  it('a focused visible window he walked away from goes idle', () => {
    expect(decideAttention({ ...USING, ms_since_interaction: DEFAULT_ATTENTION_IDLE_MS + 1 })).toBe(
      false,
    )
    // Control on the boundary: one millisecond earlier he is still reading.
    expect(decideAttention({ ...USING, ms_since_interaction: DEFAULT_ATTENTION_IDLE_MS - 1 })).toBe(
      true,
    )
  })

  it('the idle window is generous, because the two ways of being wrong are not symmetric', () => {
    // Pinned as a number so shrinking it is a deliberate act with a test to
    // change: too short buzzes a man reading a long reply (annoying, obvious,
    // self-correcting); too long loses him a message (silent, unnoticeable).
    expect(DEFAULT_ATTENTION_IDLE_MS).toBe(5 * 60_000)
    // And the poll must be well inside the server's 20 s refresh, or going idle
    // would cost up to a full refresh interval of extra silence.
    expect(ATTENTION_POLL_MS).toBeLessThan(20_000)
  })

  it('a broken clock reads as NOT attentive — the direction that notifies', () => {
    expect(decideAttention({ ...USING, ms_since_interaction: Number.NaN })).toBe(false)
    expect(decideAttention({ ...USING, ms_since_interaction: Number.POSITIVE_INFINITY })).toBe(false)
    expect(decideAttention({ ...USING, ms_since_interaction: -1 })).toBe(false)
  })
})

/** A fake document/window pair with hand-driven listeners. */
function fakeEnv(init: { visible?: boolean; focused?: boolean } = {}): {
  doc: Parameters<typeof observeWebAttention>[0]['doc']
  win: Parameters<typeof observeWebAttention>[0]['win']
  fire: (type: string) => void
  set: (next: { visible?: boolean; focused?: boolean }) => void
  listenerCount: () => number
} {
  let visible = init.visible ?? true
  let focused = init.focused ?? true
  const listeners = new Map<string, Set<() => void>>()
  const add = (type: string, fn: () => void): void => {
    const set = listeners.get(type) ?? new Set()
    set.add(fn)
    listeners.set(type, set)
  }
  const remove = (type: string, fn: () => void): void => void listeners.get(type)?.delete(fn)
  return {
    doc: {
      get visibilityState(): string {
        return visible ? 'visible' : 'hidden'
      },
      hasFocus: () => focused,
      addEventListener: add,
      removeEventListener: remove,
    },
    win: { addEventListener: add, removeEventListener: remove },
    fire: (type) => {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    set: (next) => {
      if (next.visible !== undefined) visible = next.visible
      if (next.focused !== undefined) focused = next.focused
    },
    listenerCount: () => {
      let n = 0
      for (const set of listeners.values()) n += set.size
      return n
    },
  }
}

/** A hand-cranked interval so the idle poll is asserted rather than waited out. */
function fakeInterval(): {
  setIntervalFn: (fn: () => void, ms: number) => unknown
  clearIntervalFn: (h: unknown) => void
  tick: () => void
} {
  let fn: (() => void) | null = null
  return {
    setIntervalFn: (f) => {
      fn = f
      return 1
    },
    clearIntervalFn: () => void (fn = null),
    tick: () => fn?.(),
  }
}

describe('observeWebAttention', () => {
  function observe(
    env: ReturnType<typeof fakeEnv>,
    clock: { now: () => number },
  ): { seen: boolean[]; timers: ReturnType<typeof fakeInterval>; stop: () => void } {
    const seen: boolean[] = []
    const timers = fakeInterval()
    const stop = observeWebAttention({
      doc: env.doc,
      win: env.win,
      onChange: (a) => seen.push(a),
      now: clock.now,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    })
    return { seen, timers, stop }
  }

  it('emits the CURRENT answer once at start, so an already-unfocused tab is corrected', () => {
    // The session's `attentive` defaults optimistically to `true`. Without this
    // start emission, a tab that mounted unfocused (opened in the background, a
    // restored session) would silence his phone and never say otherwise.
    const env = fakeEnv({ visible: true, focused: false })
    const { seen, stop } = observe(env, { now: () => 0 })
    expect(seen).toEqual([false])
    stop()
  })

  it('CONTROL: a tab that mounted focused and visible emits true at start', () => {
    const env = fakeEnv({ visible: true, focused: true })
    const { seen, stop } = observe(env, { now: () => 0 })
    expect(seen).toEqual([true])
    stop()
  })

  it('emits on CHANGE only — not once per event', () => {
    // Each emission becomes a wire frame. An unconditional emit would be a frame
    // per mousemove.
    const env = fakeEnv()
    const { seen, stop } = observe(env, { now: () => 0 })
    expect(seen).toEqual([true])
    env.fire('pointerdown')
    env.fire('keydown')
    env.fire('scroll')
    expect(seen).toEqual([true])
    stop()
  })

  it('blur makes it inattentive and focus brings it back', () => {
    const env = fakeEnv()
    const { seen, stop } = observe(env, { now: () => 0 })
    env.set({ focused: false })
    env.fire('blur')
    expect(seen).toEqual([true, false])
    env.set({ focused: true })
    env.fire('focus')
    expect(seen).toEqual([true, false, true])
    stop()
  })

  it('hiding the tab makes it inattentive', () => {
    const env = fakeEnv()
    const { seen, stop } = observe(env, { now: () => 0 })
    env.set({ visible: false })
    env.fire('visibilitychange')
    expect(seen).toEqual([true, false])
    stop()
  })

  it('going idle on the POLL — nothing fires an event when a human stops', () => {
    let t = 0
    const env = fakeEnv()
    const { seen, timers, stop } = observe(env, { now: () => t })
    expect(seen).toEqual([true])

    // Still inside the window: the poll changes nothing. (Control — without it,
    // the assertion below would pass against a poll that always reports idle.)
    t = DEFAULT_ATTENTION_IDLE_MS - 1
    timers.tick()
    expect(seen).toEqual([true])

    t = DEFAULT_ATTENTION_IDLE_MS + 1
    timers.tick()
    expect(seen).toEqual([true, false])
    stop()
  })

  it('an interaction after going idle brings him back', () => {
    let t = 0
    const env = fakeEnv()
    const { seen, timers, stop } = observe(env, { now: () => t })
    t = DEFAULT_ATTENTION_IDLE_MS + 1
    timers.tick()
    expect(seen).toEqual([true, false])
    env.fire('pointerdown') // resets the interaction stamp and re-evaluates
    expect(seen).toEqual([true, false, true])
    stop()
  })

  it('teardown removes every listener and the poll', () => {
    const env = fakeEnv()
    const { timers, stop } = observe(env, { now: () => 0 })
    expect(env.listenerCount()).toBeGreaterThan(0) // control
    stop()
    expect(env.listenerCount()).toBe(0)
    // The poll is cleared too: ticking it after teardown must be inert.
    timers.tick()
  })
})
