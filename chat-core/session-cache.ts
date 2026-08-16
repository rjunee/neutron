/** Platform-neutral bounded cache for live chat sessions. */
export const MAX_WARM_SESSIONS = 3
export const SESSION_BUILD_TIMEOUT_MS = 8_000

export interface CacheableChatSession {
  stop(): void
  setActive(active: boolean): void
  /**
   * Web presence (2026-08-15) — is the owner actively using this surface?
   *
   * OPTIONAL so the native surface and existing fakes satisfy the interface
   * unchanged: a session that does not implement it simply never reports
   * inattention, which leaves it exactly where it was before this signal existed.
   * That is the safe default in the only direction that matters — a missing
   * implementation costs a redundant buzz, never a missed one.
   */
  setAttentive?(attentive: boolean): void
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
  private tick = 0

  constructor(private readonly limit = MAX_WARM_SESSIONS) {}

  acquire(key: string, factory: () => T): T {
    const hit = this.liveHit(key)
    if (hit !== undefined) return hit
    const session = factory()
    this.entries.set(key, { session, refs: 1, lastReleased: 0 })
    return session
  }

  async acquireAsync(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.liveHit(key)
    if (hit !== undefined) return hit
    const inFlight = this.pending.get(key)
    if (inFlight !== undefined) {
      const session = await inFlight
      const entry = this.entries.get(key)
      if (entry !== undefined) entry.refs += 1
      return session
    }

    const build = withDeadline(factory(), SESSION_BUILD_TIMEOUT_MS)
    this.pending.set(key, build)
    try {
      const session = await build
      this.entries.set(key, { session, refs: 1, lastReleased: 0 })
      return session
    } finally {
      if (this.pending.get(key) === build) this.pending.delete(key)
    }
  }

  release(key: string): void {
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

  /**
   * Web presence — only the ON-SCREEN session may claim the owner's attention.
   *
   * EVERY session is told, and that half was always right: the cache keeps up to
   * {@link MAX_WARM_SESSIONS} sockets alive across a project switch, each holding
   * its own presence declaration on the server, so telling only the checked-out
   * one that the owner walked away would leave the others declaring `foreground`
   * on their own conversations until the TTL expired them.
   *
   * WHAT THEY ARE TOLD IS THE FIX (Argus round 2, reproduced end-to-end). The
   * first cut fanned the SAME value to all of them, and a warm session is by
   * definition the one the owner is NOT looking at — so an attentive tab on
   * project A re-declared `foreground` on up to two off-screen sockets, each
   * carrying its OWN `project_id` at the server
   * (`gateway/http/app-ws-surface.ts` reports `data.project_id`), and
   * `gateway/push/web-presence.ts` `isForeground` then suppressed the phone push
   * for conversations that were nowhere on his screen. Three chats silenced at
   * once, with every suite green: the fan-out was tested, the fact that it fanned
   * a LIE was not.
   *
   * So `attentive` applies to `active_key` and every other entry is told `false`.
   * `active_key` is the cache key of the conversation currently rendered
   * (`landing/chat-react/controller.ts` `topicForProject(this.projectId)`); a key
   * that is not in the cache simply means nothing claims presence, which is the
   * direction that notifies.
   */
  setAttentive(attentive: boolean, active_key: string): void {
    for (const [key, entry] of this.entries) {
      entry.session.setAttentive?.(attentive && key === active_key)
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.session.stop()
    this.entries.clear()
    this.pending.clear()
    this.tick = 0
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
