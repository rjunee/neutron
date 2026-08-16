import { describe, expect, test } from 'bun:test'
import { WarmSessionCache } from '../session-cache.ts'

interface FakeSession {
  readonly key: string
  stopped: number
  state: string
  attentive: boolean[]
  stop(): void
  setActive(active: boolean): void
  setAttentive(attentive: boolean): void
  status(): string
}

function fake(key: string): FakeSession {
  return {
    key,
    stopped: 0,
    state: 'open',
    attentive: [],
    stop() { this.stopped += 1; this.state = 'closed' },
    setActive() {},
    setAttentive(attentive: boolean) { this.attentive.push(attentive) },
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

  // ── Web presence: the multi-session seam (Argus round 2) ──────────────────
  //
  // This is the seam the live bug lived in, and it had no test: every presence
  // suite exercised ONE `WebChatSession`, while the browser runs up to three.
  // The cache is where "the owner is attentive" turns into "which conversation
  // is he attentive TO", and answering that with the same value for every warm
  // session silenced pushes for chats that were nowhere on his screen.
  test('gives attention ONLY to the on-screen session, and takes it from the warm ones', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const general = cache.acquire('general', () => fake('general'))
    cache.release('general')
    const alpha = cache.acquire('alpha', () => fake('alpha'))
    cache.release('alpha')
    const beta = cache.acquire('beta', () => fake('beta'))

    cache.setAttentive(true, 'beta')

    expect(beta.attentive).toEqual([true])
    // The off-screen sockets are told the OPPOSITE, not merely left alone: each
    // holds its own server-side presence claim scoped to its own project, and a
    // claim that is never withdrawn suppresses that project's push until the TTL.
    expect(general.attentive).toEqual([false])
    expect(alpha.attentive).toEqual([false])
  })

  test('an inattentive tab claims nothing anywhere, not even on screen', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const general = cache.acquire('general', () => fake('general'))
    cache.release('general')
    const alpha = cache.acquire('alpha', () => fake('alpha'))

    cache.setAttentive(false, 'alpha')

    expect(alpha.attentive).toEqual([false])
    expect(general.attentive).toEqual([false])
  })

  test('an active key that is not cached leaves every session unattentive', () => {
    const cache = new WarmSessionCache<FakeSession>()
    const alpha = cache.acquire('alpha', () => fake('alpha'))

    cache.setAttentive(true, 'not-in-the-cache')

    expect(alpha.attentive).toEqual([false])
  })
})
