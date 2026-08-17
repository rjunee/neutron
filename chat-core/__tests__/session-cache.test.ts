import { describe, expect, test } from 'bun:test'
import { WarmSessionCache } from '../session-cache.ts'

interface FakeSession {
  readonly key: string
  stopped: number
  state: string
  stop(): void
  setActive(active: boolean): void
  status(): string
}

function fake(key: string): FakeSession {
  return {
    key,
    stopped: 0,
    state: 'open',
    stop() { this.stopped += 1; this.state = 'closed' },
    setActive() {},
    status() { return this.state },
  }
}

describe('WarmSessionCache', () => {
  test('returns the identical live session only for its exact scope', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const a = cache.acquire('scope-a', () => fake('scope-a'))
    cache.release('scope-a')
    const b = cache.acquire('scope-b', () => fake('scope-b'))
    cache.release('scope-b')
    const again = cache.acquire('scope-a', () => fake('replacement'))
    expect(again).toBe(a)
    expect(again).not.toBe(b)
  })

  test('does not return a cached session whose socket has closed', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const dead = cache.acquire('scope-a', () => fake('scope-a'))
    cache.release('scope-a')
    dead.state = 'closed'
    const replacement = cache.acquire('scope-a', () => fake('scope-a-new'))
    expect(replacement).not.toBe(dead)
    expect(replacement.key).toBe('scope-a-new')
  })

  test('evicts and stops the least-recently-released idle session', () => {
    const cache = new WarmSessionCache<FakeSession>(2)
    const oldest = cache.acquire('a', () => fake('a'))
    cache.release('a')
    cache.acquire('b', () => fake('b'))
    cache.release('b')
    cache.acquire('c', () => fake('c'))
    cache.release('c')
    expect(cache.keys()).toEqual(['b', 'c'])
    expect(oldest.stopped).toBe(1)
  })

  // ── SIGN-OUT VS AN IN-FLIGHT CONSTRUCTION ────────────────────────────────────
  // `clear()` is what mobile sign-out calls. A construction already awaiting inside
  // `acquireAsync` used to install itself AFTERWARDS, so the cleared cache came back
  // holding a session authenticated as the signed-out identity.
  test('clear() during an async construction does not resurrect the prior-identity session', async () => {
    const cache = new WarmSessionCache<FakeSession>()
    const built = fake('old-user')
    let resolveFactory: (session: FakeSession) => void = () => {}
    const acquired = cache.acquireAsync('old-user', () => new Promise<FakeSession>((r) => { resolveFactory = r }))
    const settled = acquired.then(() => 'resolved' as const, () => 'rejected' as const)

    cache.clear()
    resolveFactory(built)

    expect(await settled).toBe('rejected')
    expect(cache.keys()).toEqual([])
    // Not merely un-cached: STOPPED. An orphaned live socket on the old identity is the
    // whole point of the sign-out path.
    expect(built.stopped).toBe(1)
  })

  test('a fresh acquire after clear() still works', async () => {
    const cache = new WarmSessionCache<FakeSession>()
    cache.clear()
    const session = await cache.acquireAsync('new-user', () => Promise.resolve(fake('new-user')))
    expect(cache.keys()).toEqual(['new-user'])
    expect(cache.refCount('new-user')).toBe(1)
    expect(session.stopped).toBe(0)
  })

  // ── REPLACING A CLOSED SESSION UNDER THE SAME KEY ────────────────────────────
  // `release` looks the entry up by KEY, so releases from the holders of a REPLACED
  // session used to be charged to its replacement — driving a live, still-held session
  // to refs=0, where the idle evictor stops it.
  test('releases owed by the holders of a replaced session are not charged to the replacement', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const first = cache.acquire('k', () => fake('first'))
    cache.acquire('k', () => fake('never-built')) // refs = 2 on `first`
    expect(cache.refCount('k')).toBe(2)

    first.state = 'closed'
    const replacement = cache.acquire('k', () => fake('replacement'))
    expect(replacement.key).toBe('replacement')
    expect(cache.refCount('k')).toBe(1)

    // The two old holders give their references back, by key, as they always have.
    cache.release('k')
    cache.release('k')
    expect(cache.refCount('k')).toBe(1)
    expect(cache.peek('k')).toBe(replacement)
    expect(replacement.stopped).toBe(0)

    // …and the replacement's own acquirer releasing DOES take it to idle.
    cache.release('k')
    expect(cache.refCount('k')).toBe(0)
    expect(cache.peek('k')).toBe(replacement)
  })

  test('the closed session is stopped when it is replaced, whatever its refcount', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const first = cache.acquire('k', () => fake('first'))
    first.state = 'closed'
    cache.acquire('k', () => fake('replacement'))
    expect(first.stopped).toBe(1)
  })
})
