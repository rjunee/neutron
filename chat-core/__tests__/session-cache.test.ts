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
})
