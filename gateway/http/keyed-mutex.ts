/**
 * Per-instance mutex (2026-05-22) — close ISSUE #33.
 *
 * Serializes work keyed by `project_slug` so concurrent handlers on the
 * same instance run one-at-a-time. Different instances run in parallel.
 *
 * Modeled on the chained-promise pattern at
 * `gateway/git/doc-version-store.ts:withCommitLock` (per-project commit
 * serialization). Same shape: a tail promise per key, the next acquirer
 * awaits the tail, the release resolves it. No spinning, no `setInterval`,
 * no Mutex class with manual `_locked` state.
 *
 * Usage:
 *
 *   const mutex = createKeyedMutex()
 *   const release = await mutex.acquire(project_slug)
 *   try {
 *     // critical section
 *   } finally {
 *     release()
 *   }
 *
 * Or via the `withLock(project_slug, fn)` convenience:
 *
 *   await mutex.withLock(project_slug, async () => { ... })
 */

export interface KeyedMutex {
  /**
   * Acquire the lock for `project_slug`. Resolves to a `release` callback
   * that the caller MUST invoke (in a `finally` block) to free the lock.
   * Calling `release` more than once is a no-op.
   *
   * Concurrent acquires on the same `project_slug` queue up in arrival
   * order. Acquires on different slugs proceed in parallel.
   */
  acquire(project_slug: string): Promise<() => void>
  /**
   * Convenience wrapper — acquires the lock, runs `fn`, releases the
   * lock in a `finally` so an exception in `fn` does not strand the
   * instance's queue. Returns whatever `fn` returned. `fn` may be sync or
   * async; `await` on a non-promise is a no-op.
   */
  withLock<T>(project_slug: string, fn: () => T | Promise<T>): Promise<T>
  /**
   * @internal Test-only: number of instances whose queues are non-empty.
   * Useful for regression tests that want to assert the lock drained
   * cleanly (back to 0). Not part of the production API.
   */
  activeKeys(): number
}

export function createKeyedMutex(): KeyedMutex {
  // Per-key tail promise. The tail resolves when the LAST queued caller
  // for that key releases — i.e. when the queue is fully drained. New
  // acquirers chain onto the current tail; the new tail is the chained
  // promise that resolves only once the new acquirer's `release` fires.
  const tails = new Map<string, Promise<void>>()

  async function acquire(project_slug: string): Promise<() => void> {
    const previous = tails.get(project_slug) ?? Promise.resolve()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // Capture the tail by reference so the cleanup below can compare
    // against the exact promise we wrote into the map (a chained `.then`
    // would build a non-identical promise).
    const tail = previous.then(() => released)
    tails.set(project_slug, tail)
    await previous
    let released_once = false
    return (): void => {
      if (released_once) return
      released_once = true
      release()
      // Drop the map entry only if no later caller has chained onto OUR
      // tail. Reference equality is safe because `tail` is the exact
      // promise we wrote a moment ago. Without this check we'd leak
      // map entries (a key with an already-resolved tail stays forever).
      if (tails.get(project_slug) === tail) {
        tails.delete(project_slug)
      }
    }
  }

  async function withLock<T>(
    project_slug: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const release = await acquire(project_slug)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  function activeKeys(): number {
    return tails.size
  }

  return { acquire, withLock, activeKeys }
}
