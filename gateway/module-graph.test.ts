import { describe, expect, test } from 'bun:test'
import { GatewayModuleGraph } from './module-graph.ts'

describe('GatewayModuleGraph', () => {
  test('topological order respects deps', async () => {
    const graph = new GatewayModuleGraph()
    const order: string[] = []
    graph.register({ name: 'c', deps: ['b'], init: () => { order.push('c'); return 'C' } })
    graph.register({ name: 'a', init: () => { order.push('a'); return 'A' } })
    graph.register({ name: 'b', deps: ['a'], init: () => { order.push('b'); return 'B' } })
    await graph.compose()
    expect(order).toEqual(['a', 'b', 'c'])
    expect(graph.get<string>('a')).toBe('A')
    expect(graph.get<string>('b')).toBe('B')
    expect(graph.get<string>('c')).toBe('C')
  })

  test('async init is awaited', async () => {
    const graph = new GatewayModuleGraph()
    graph.register({
      name: 'slow',
      init: async () => {
        await Bun.sleep(5)
        return 'ready'
      },
    })
    await graph.compose()
    expect(graph.get<string>('slow')).toBe('ready')
  })

  test('duplicate registration throws', () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', init: () => null })
    expect(() => graph.register({ name: 'a', init: () => null })).toThrow(
      /already registered/,
    )
  })

  test('missing dep throws at compose()', async () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', deps: ['nope'], init: () => null })
    await expect(graph.compose()).rejects.toThrow(/unknown module 'nope'/)
  })

  test('cycle throws at compose() with the path reported', async () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', deps: ['b'], init: () => null })
    graph.register({ name: 'b', deps: ['a'], init: () => null })
    await expect(graph.compose()).rejects.toThrow(/cycle detected/)
  })

  test('shutdown runs in reverse-init order', async () => {
    const graph = new GatewayModuleGraph()
    const fired: string[] = []
    graph.register({
      name: 'a',
      init: () => 'a',
      shutdown: () => { fired.push('a') },
    })
    graph.register({
      name: 'b',
      deps: ['a'],
      init: () => 'b',
      shutdown: () => { fired.push('b') },
    })
    await graph.compose()
    await graph.shutdown()
    expect(fired).toEqual(['b', 'a'])
  })

  test('shutdown swallows individual failures', async () => {
    const graph = new GatewayModuleGraph()
    let bShut = false
    graph.register({
      name: 'a',
      init: () => 'a',
      shutdown: () => { throw new Error('a-fail') },
    })
    graph.register({
      name: 'b',
      deps: ['a'],
      init: () => 'b',
      shutdown: () => { bShut = true },
    })
    await graph.compose()
    await graph.shutdown()
    expect(bShut).toBe(true)
  })

  test('register-after-compose throws', async () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', init: () => null })
    await graph.compose()
    expect(() => graph.register({ name: 'b', init: () => null })).toThrow(
      /cannot register after compose/,
    )
  })

  test('get() before compose throws', () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', init: () => null })
    expect(() => graph.get('a')).toThrow(/not yet initialised/)
  })

  test('get() unknown module throws', async () => {
    const graph = new GatewayModuleGraph()
    await graph.compose()
    expect(() => graph.get('nope')).toThrow(/unknown module/)
  })

  test('compose() can only run once', async () => {
    const graph = new GatewayModuleGraph()
    graph.register({ name: 'a', init: () => null })
    await graph.compose()
    await expect(graph.compose()).rejects.toThrow(/already called/)
  })

  test('config is readable from init', async () => {
    const graph = new GatewayModuleGraph({ project_slug: 'acme' })
    graph.register({
      name: 'a',
      init: (ctx) => ctx.config['project_slug'] as string,
    })
    await graph.compose()
    expect(graph.get<string>('a')).toBe('acme')
  })

  test('get() returns the handle even when init returned undefined (Argus r1 M1)', async () => {
    // Argus r1 MINOR (M1) fix: a module whose `init()` legitimately
    // returns `undefined` (a side-effect-only module that registers a
    // listener and has nothing to expose) MUST still be reachable via
    // `graph.get(name)` after compose. Pre-fix, the readiness gate used
    // `instance === undefined` as the not-yet-initialised sentinel,
    // which conflated "init has not run" with "init returned
    // undefined". The fix is a dedicated `initialised` boolean that
    // flips to true only after init resolves.
    const graph = new GatewayModuleGraph()
    let initRan = false
    graph.register({
      name: 'side-effect',
      init: () => {
        initRan = true
        return undefined
      },
    })
    await graph.compose()
    expect(initRan).toBe(true)
    // `get` should NOT throw "not yet initialised" even though the
    // returned handle is undefined.
    expect(() => graph.get('side-effect')).not.toThrow()
    expect(graph.get('side-effect')).toBeUndefined()
  })

  test('get() of self mid-init still throws "not yet initialised" (Argus r1 M1 edge)', async () => {
    // Defense against the M1 fix flipping the sentinel too early.
    // Inside its own init, a module asking for itself MUST see the
    // not-yet-ready error — the readiness flag flips only AFTER init
    // resolves.
    const graph = new GatewayModuleGraph()
    let selfLookupErr: unknown
    graph.register({
      name: 'self-asker',
      init: (ctx) => {
        try {
          ctx.graph.get('self-asker')
        } catch (err) {
          selfLookupErr = err
        }
        return 'ready'
      },
    })
    await graph.compose()
    expect(selfLookupErr).toBeInstanceOf(Error)
    expect((selfLookupErr as Error).message).toMatch(/not yet initialised/)
  })
})
