/**
 * The server-authoritative typing indicator's REFCOUNT, extracted so its guard
 * can be killed by a test.
 *
 * WHY THIS IS A MODULE AND NOT A CLOSURE ANY MORE. Concurrent mid-turn sends share
 * one visible typing lifetime, so the emitter refcounts starts and ends and
 * suppresses the inner pair — otherwise a quick second turn's `end` clears the
 * first turn's dots while it is still working. A lost `end` (process death, socket
 * failure) would then leave `depth > 0` forever and suppress EVERY future typing
 * start for that topic until restart, so there is a fail-safe timer that expires
 * the entry.
 *
 * The reviewers' remaining finding on that work was exact: *"Typing-refcount
 * suppression guard and 46-minute fail-safe have zero killing test coverage, and
 * depth can leak permanently."* It was true, and it was untestable where it lived —
 * a closure inside `wireAppWs`, keyed on a real `setTimeout(…, 46 * 60_000)`. No
 * test can wait 46 minutes, and a test that reaches into a closure is not a test of
 * the production path.
 *
 * So the decision logic is here, pure apart from an INJECTED scheduler, and
 * `app-ws.ts` holds one instance. The timer is a parameter, which is the whole
 * point: a test drives the expiry by calling the captured callback, exercising the
 * same code the 46-minute path runs.
 */

/** What the caller should DO with this transition. */
export interface TypingDecision {
  /**
   * True when this transition is the visible edge — the outermost `start` or the
   * final `end`. An inner start/end pair returns false and must emit nothing.
   */
  emit: boolean
  /** The refcount after this transition, for logging/assertions. */
  depth: number
}

/** Scheduler seam. Real callers pass `setTimeout`/`clearTimeout`. */
export interface TypingScheduler {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

export interface TypingRefcountOptions {
  scheduler: TypingScheduler
  /**
   * Called when an entry's fail-safe fires — i.e. a matching `end` never arrived.
   * The caller emits the synthetic `end` frame and clears its own derived state.
   */
  onExpire(key: string): void
  /**
   * The fail-safe window. Defaults to 46 minutes: one minute past the live turn's
   * own 45-minute absolute ceiling, so the ceiling always wins in the normal case
   * and this only ever fires when the `end` was genuinely lost.
   */
  ttlMs?: number
}

/** 46 minutes — deliberately OUTSIDE the turn's 45-minute absolute ceiling. */
export const TYPING_FAILSAFE_MS = 46 * 60_000

interface Entry {
  depth: number
  handle: unknown
}

export interface TypingRefcount {
  /** Apply a transition and report whether it is the visible edge. */
  transition(key: string, state: 'start' | 'end'): TypingDecision
  /** Current depth for a key (0 when absent). Test + log affordance. */
  depthOf(key: string): number
}

export function createTypingRefcount(opts: TypingRefcountOptions): TypingRefcount {
  const ttl = opts.ttlMs ?? TYPING_FAILSAFE_MS
  const entries = new Map<string, Entry>()

  return {
    transition(key: string, state: 'start' | 'end'): TypingDecision {
      const prior = entries.get(key)
      const previousDepth = prior?.depth ?? 0
      const nextDepth = state === 'start' ? previousDepth + 1 : Math.max(0, previousDepth - 1)
      if (prior !== undefined) opts.scheduler.cancel(prior.handle)
      if (nextDepth === 0) {
        entries.delete(key)
      } else {
        // Re-armed on EVERY transition that leaves the count positive, so a long
        // series of overlapping turns keeps extending the window rather than
        // expiring mid-conversation.
        const handle = opts.scheduler.schedule(() => {
          // Only the CURRENT timer may expire the entry. Without this an
          // already-cancelled timer that had begun running could delete an entry
          // a newer start had just re-armed — clearing the dots on a live turn.
          if (entries.get(key)?.handle !== handle) return
          entries.delete(key)
          opts.onExpire(key)
        }, ttl)
        entries.set(key, { depth: nextDepth, handle })
      }
      // The visible edge: the OUTERMOST start (nothing was showing) and the FINAL
      // end (nothing is left). Everything between is an inner pair whose emission
      // would clear a still-working turn's dots.
      const emit = state === 'start' ? previousDepth === 0 : nextDepth === 0
      return { emit, depth: nextDepth }
    },
    depthOf(key: string): number {
      return entries.get(key)?.depth ?? 0
    },
  }
}
