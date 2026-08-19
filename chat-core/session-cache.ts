/** Platform-neutral bounded cache for live chat sessions. */
export const MAX_WARM_SESSIONS = 3
export const SESSION_BUILD_TIMEOUT_MS = 8_000

export interface CacheableChatSession {
  stop(): void
  setActive(active: boolean): void
  /** Closed sessions are discarded on checkout. Optional for legacy adapters. */
  status?(): string
}

interface Entry<T> {
  readonly session: T
  refs: number
  lastReleased: number
}

export class WarmSessionCache<T extends CacheableChatSession> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly pending = new Map<string, Promise<T>>()
  /**
   * Outstanding `release(key)` calls owed by holders of an entry that has already been
   * REPLACED under the same key. See `liveHit` and `release`.
   */
  private readonly retiredRefs = new Map<string, number>()
  private tick = 0
  /**
   * Bumped by `clear()`. An async construction that was already in flight when the cache
   * was cleared belongs to the PREVIOUS generation and may not be installed. See
   * `acquireAsync`.
   */
  private generation = 0

  constructor(private readonly limit = MAX_WARM_SESSIONS) {}

  acquire(key: string, factory: () => T): T {
    const hit = this.liveHit(key)
    if (hit !== undefined) return hit
    const session = factory()
    this.entries.set(key, { session, refs: 1, lastReleased: 0 })
    return session
  }

  /**
   * SIGN-OUT MUST WIN AGAINST A HALF-BUILT SESSION.
   *
   * `clear()` is what mobile sign-out calls (`clearSessionCache`), and its whole job is
   * "no session of the previous identity survives". It used to stop the entries it could
   * see and empty `pending` — but a construction ALREADY AWAITING here was not in either
   * place in any useful sense: the `await` resumed afterwards, `entries.set(key, …)` ran
   * unconditionally, and the cleared cache came back holding a live socket authenticated
   * as the signed-out user, which the next `acquire` of that key would hand straight to
   * the new one. `keys()` showed `["old-user"]` and `stop()` had never been called.
   *
   * The generation captured before the await is the fix. A session built for a cache that
   * no longer exists is STOPPED and the caller is rejected — a caller that asked during
   * sign-out must not receive a session, and every call site already handles a rejection
   * because `withDeadline` has always been able to produce one.
   */
  async acquireAsync(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.liveHit(key)
    if (hit !== undefined) return hit
    const generation = this.generation
    const inFlight = this.pending.get(key)
    if (inFlight !== undefined) {
      const session = await inFlight
      // The OWNER of the build stops it on a cleared cache; this waiter only declines to
      // take a reference on it.
      if (this.generation !== generation) throw clearedDuringBuild()
      const entry = this.entries.get(key)
      if (entry !== undefined) entry.refs += 1
      return session
    }

    const build = withDeadline(factory(), SESSION_BUILD_TIMEOUT_MS)
    this.pending.set(key, build)
    try {
      const session = await build
      if (this.generation !== generation) {
        session.stop()
        throw clearedDuringBuild()
      }
      this.entries.set(key, { session, refs: 1, lastReleased: 0 })
      return session
    } finally {
      if (this.pending.get(key) === build) this.pending.delete(key)
    }
  }

  /**
   * A RELEASE PAYS THE OLDEST DEBT ON THE KEY FIRST.
   *
   * `release` identifies its entry by KEY alone, which is fine until a key holds a
   * DIFFERENT session than the one the releasing holder acquired — which `liveHit` can
   * do, by evicting a closed session that still has references and letting the next
   * acquire install a replacement. Two holders of the closed session A then released the
   * key and drove the REPLACEMENT B's refcount to 0 while its own acquirer was still
   * using it: B became idle-evictable, and eviction calls `stop()` on a live session.
   *
   * So a replacement records the references still owed by the old holders, and those are
   * paid off first. Releases arrive in arbitrary order and nothing here can tell an old
   * holder from a new one, but it does not need to: the AGGREGATE is what matters, and
   * draining the debt first errs toward keeping B alive slightly too long rather than
   * stopping it while it is held. After every holder has released, B's count is 0 and it
   * is idle-evictable exactly as it should be.
   */
  release(key: string): void {
    const owed = this.retiredRefs.get(key) ?? 0
    if (owed > 0) {
      if (owed === 1) this.retiredRefs.delete(key)
      else this.retiredRefs.set(key, owed - 1)
      return
    }
    const entry = this.entries.get(key)
    if (entry === undefined) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0) return
    entry.lastReleased = ++this.tick
    this.evictIdleBeyondLimit()
  }

  setActive(active: boolean): void {
    for (const entry of this.entries.values()) entry.session.setActive(active)
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.session.stop()
    this.entries.clear()
    this.pending.clear()
    this.retiredRefs.clear()
    this.tick = 0
    // AFTER the clear, so an in-flight `acquireAsync` resuming later sees the bump and
    // declines to install itself. This is the line that makes sign-out final.
    this.generation += 1
  }

  keys(): readonly string[] {
    return [...this.entries.keys()]
  }

  refCount(key: string): number {
    return this.entries.get(key)?.refs ?? 0
  }

  peek(key: string): T | null {
    return this.entries.get(key)?.session ?? null
  }

  private liveHit(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.session.status?.() === 'closed') {
      entry.session.stop()
      this.entries.delete(key)
      // Its holders have not released yet, and they will do so BY KEY — against whatever
      // session occupies the key by then. Record the debt so those releases cannot be
      // charged to the replacement. See `release`.
      if (entry.refs > 0) this.retiredRefs.set(key, (this.retiredRefs.get(key) ?? 0) + entry.refs)
      return undefined
    }
    entry.refs += 1
    return entry.session
  }

  private evictIdleBeyondLimit(): void {
    const idle = [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].lastReleased - b[1].lastReleased)
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - this.limit))) {
      entry.session.stop()
      this.entries.delete(key)
    }
  }
}

function clearedDuringBuild(): Error {
  return new Error('session cache was cleared while this session was being built')
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle: unknown = setTimeout(() => {
      reject(new Error(`session construction did not settle within ${String(ms)}ms`))
    }, ms)
    ;(handle as { unref?: () => void }).unref?.()
    promise.then(
      (session) => {
        clearTimeout(handle as never)
        resolve(session)
      },
      (err: unknown) => {
        clearTimeout(handle as never)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
