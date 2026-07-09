/**
 * GBrainSyncHook tests.
 *
 * Two layers:
 *   1. **Real PGLite round-trip** — stands up an actual in-memory GBrain brain
 *      (the `gbrain` devDependency's `PGLiteEngine` + `operations`, 100+ real
 *      schema migrations applied), routes the hook's `McpClient` to GBrain's
 *      real operation handlers, and proves a write through `GBrainSyncHook`
 *      lands a page + typed edge in GBrain and is retrievable. NOT a stub —
 *      the data actually transits GBrain's storage layer.
 *   2. **Failure modes** — fast unit tests against a capturing fake `McpClient`
 *      + `MemoryStore`, asserting the best-effort failure model (log + continue,
 *      never crash; dedupe-probe failures skip the edge; bad paths throw).
 *
 * The gbrain devDependency is imported via a computed specifier so the repo's
 * `bunx tsc --noEmit` gate treats it as `any` (it must NOT pull gbrain's .ts
 * source into the strict type-check program); bun resolves it at runtime.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Triple } from '@neutronai/runtime/auto-link.ts'
import { GBrainUnavailableError, type McpClient, type MemoryStore } from '../memory-store.ts'
import { GBrainSyncHook, type SyncHookFailureEvent, _parseEntityPath } from '../GBrainSyncHook.ts'
import { GBrainMemoryStore } from '../gbrain-memory-store.ts'
import { bootPgliteBrain } from './boot-pglite-brain.ts'

const PERSON = '/srv/owner/entities/people/jane-doe.md'
const BODY = '---\nkind: person\n---\n\nSam runs things.\n'

function triple(subject: string, predicate: string, object: string): Triple {
  return { subject, predicate, object, source: subject }
}

// ─── Layer 1: real GBrain PGLite round-trip ──────────────────────────────

describe('GBrainSyncHook — real GBrain PGLite round-trip', () => {
  let engine: { disconnect(): Promise<void> }
  let client: McpClient

  beforeAll(async () => {
    // Serialised + retry-hardened real-PGLite boot (see boot-pglite-brain.ts).
    const { engine: eng, operations } = await bootPgliteBrain()
    engine = eng
    const ctx = {
      engine: eng,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    }
    client = {
      async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        const op = operations.find((o) => o.name === name)
        if (op === undefined) throw new Error(`no gbrain op: ${name}`)
        return op.handler(ctx, args)
      },
    }
    // Standing up a real GBrain brain applies 100+ schema migrations against
    // an in-memory PGLite DB (~7s), so the default 5s hook timeout is too
    // tight — give the boot a generous budget.
  }, 60_000)

  afterAll(async () => {
    if (engine !== undefined) await engine.disconnect()
  }, 30_000)

  function edgesTo(links: unknown, object: string, predicate: string): unknown[] {
    const rows = Array.isArray(links) ? links : []
    return rows.filter((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      return o['to_slug'] === object && o['link_type'] === predicate
    })
  }

  test('entity write lands a page + typed edge that are retrievable', async () => {
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    // Pre-create the target so the edge endpoint exists.
    await client.call('put_page', { slug: 'topline', content: '---\nkind: company\n---\n\nTopline.\n' })

    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })

    // Page body landed in GBrain (put_page via the MemoryStore).
    const page = (await client.call('get_page', { slug: 'jane-doe' })) as Record<string, unknown> | null
    expect(page).not.toBeNull()
    expect(page!['slug']).toBe('jane-doe')

    // Typed edge landed in GBrain (add_link) and is retrievable.
    const links = await client.call('get_links', { slug: 'jane-doe' })
    expect(edgesTo(links, 'topline', 'works_at').length).toBe(1)
  })

  test('re-writing the same triple does not duplicate the edge (dedupe via get_links)', async () => {
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    const links = await client.call('get_links', { slug: 'jane-doe' })
    expect(edgesTo(links, 'topline', 'works_at').length).toBe(1)
  })

  test('removed triple is dropped from the GBrain graph (remove_link)', async () => {
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [],
      removedLinks: [triple('jane-doe', 'works_at', 'topline')],
    })
    const links = await client.call('get_links', { slug: 'jane-doe' })
    expect(edgesTo(links, 'topline', 'works_at').length).toBe(0)
  })

  // BLOCKING regression (Argus r1): GBrain's remove_link is predicate-blind —
  // it deletes ALL link_types for a {from,to} pair. When a page keeps one
  // predicate but drops another on the SAME pair, the removed-then-added order
  // must re-assert the survivor. Before the fix, newLinks ran first (added
  // works_at) and removedLinks ran second (predicate-blind remove nuked BOTH
  // works_at AND founded) → the survivor silently vanished.
  test('keep works_at + drop founded on same pair → works_at still queryable', async () => {
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    // Seed BOTH predicates on the same (jane-doe, topline) pair.
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [
        triple('jane-doe', 'works_at', 'topline'),
        triple('jane-doe', 'founded', 'topline'),
      ],
      removedLinks: [],
    })
    expect(edgesTo(await client.call('get_links', { slug: 'jane-doe' }), 'topline', 'works_at').length).toBe(1)
    expect(edgesTo(await client.call('get_links', { slug: 'jane-doe' }), 'topline', 'founded').length).toBe(1)

    // Rewrite: keep works_at, drop founded. newLinks carries the surviving
    // compiled truth; removedLinks carries only the dropped predicate.
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [triple('jane-doe', 'founded', 'topline')],
    })

    const links = await client.call('get_links', { slug: 'jane-doe' })
    // The survivor must still be present (re-asserted after the predicate-blind
    // remove), and exactly once (no duplicate).
    expect(edgesTo(links, 'topline', 'works_at').length).toBe(1)
    // The dropped predicate is gone.
    expect(edgesTo(links, 'topline', 'founded').length).toBe(0)
  })

  // ISSUES #102: an add_link whose target slug isn't written yet throws
  // (gbrain addLink requires BOTH endpoints to exist). Before the deferred-edge
  // retry queue, the catch logged + DROPPED it → KG fan-out was order-dependent
  // (edges to later-written pages were silently lost). Now the edge is deferred
  // and re-attempted after the target page lands via a subsequent put_page.
  test('deferred-edge retry: an add_link to a not-yet-written target is deferred, then lands once the target is written', async () => {
    const events: SyncHookFailureEvent[] = []
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
      logFailure: (e) => events.push(e),
    })
    const SRC = '/srv/owner/entities/people/deferred-src.md'
    const TGT = '/srv/owner/entities/companies/deferred-tgt.md'

    // Write the source page with an edge to a target that does NOT exist yet.
    await hook.onEntityWrite({
      path: SRC,
      body: BODY,
      newLinks: [triple('deferred-src', 'works_at', 'deferred-tgt')],
      removedLinks: [],
    })

    // The edge is NOT in the graph yet (target absent) — but it was NOT silently
    // dropped. It is deferred for retry.
    const before = await client.call('get_links', { slug: 'deferred-src' })
    expect(edgesTo(before, 'deferred-tgt', 'works_at').length).toBe(0)
    expect(hook.deferredEdgeCount).toBe(1)
    expect(events.some((e) => e.stage === 'gbrain_add_link_deferred')).toBe(true)

    // Now write the target page through the SAME hook. The post-put_page drain
    // re-attempts any deferred edge whose target slug just landed.
    await hook.onEntityWrite({
      path: TGT,
      body: '---\nkind: company\n---\n\nTarget.\n',
      newLinks: [],
      removedLinks: [],
    })

    // The previously-deferred edge now lands exactly once, and the queue drains.
    const after = await client.call('get_links', { slug: 'deferred-src' })
    expect(edgesTo(after, 'deferred-tgt', 'works_at').length).toBe(1)
    expect(hook.deferredEdgeCount).toBe(0)
  })

  // ISSUES #102 (Codex P2): a deferred edge dropped from compiled truth BEFORE
  // its target lands must NOT be resurrected when the target finally arrives —
  // that would reintroduce a link the page no longer asserts.
  test('a deferred edge removed from compiled truth before its target lands is purged, not reintroduced', async () => {
    const hook = new GBrainSyncHook({
      memoryStore: new GBrainMemoryStore(client),
      gbrainMcp: client,
    })
    const SRC = '/srv/owner/entities/people/purge-src.md'
    const TGT = '/srv/owner/entities/companies/purge-tgt.md'

    // 1. Write src with an edge to a not-yet-written target → deferred.
    await hook.onEntityWrite({
      path: SRC,
      body: BODY,
      newLinks: [triple('purge-src', 'works_at', 'purge-tgt')],
      removedLinks: [],
    })
    expect(hook.deferredEdgeCount).toBe(1)

    // 2. Rewrite src DROPPING that edge before the target exists. Compiled truth
    //    no longer asserts it → the deferred edge must be purged.
    await hook.onEntityWrite({
      path: SRC,
      body: BODY,
      newLinks: [],
      removedLinks: [triple('purge-src', 'works_at', 'purge-tgt')],
    })
    expect(hook.deferredEdgeCount).toBe(0)

    // 3. Now the target lands. The purged edge must NOT be reintroduced.
    await hook.onEntityWrite({
      path: TGT,
      body: '---\nkind: company\n---\n\nTarget.\n',
      newLinks: [],
      removedLinks: [],
    })
    const links = await client.call('get_links', { slug: 'purge-src' })
    expect(edgesTo(links, 'purge-tgt', 'works_at').length).toBe(0)
  })
})

// ─── Layer 2: failure modes (capturing fakes, no brain) ──────────────────

class FakeStore implements MemoryStore {
  added: Array<{ content: string; metadata?: Record<string, unknown> }> = []
  constructor(private readonly failAdd = false) {}
  async add(input: { content: string; metadata?: Record<string, unknown> }): Promise<{ id: string }> {
    if (this.failAdd) throw new Error('put_page boom')
    this.added.push(input)
    return { id: String(input.metadata?.['slug'] ?? 'x') }
  }
  async query(): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>> {
    return []
  }
  async delete(): Promise<void> {}
  async stats(): Promise<{ count: number; size_bytes: number }> {
    return { count: 0, size_bytes: 0 }
  }
}

function fakeMcp(behavior: (name: string, args: Record<string, unknown>) => unknown): {
  client: McpClient
  calls: Array<{ name: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    calls,
    client: {
      async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        calls.push({ name, args })
        return behavior(name, args)
      },
    },
  }
}

describe('GBrainSyncHook — failure modes', () => {
  test('put_page failure logs gbrain_put_page and the graph half still runs', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => (name === 'get_links' ? [] : { ok: true }))
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(true),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(events.map((e) => e.stage)).toContain('gbrain_put_page')
    // The add_link still fired despite the put_page failure.
    expect(mcp.calls.some((c) => c.name === 'add_link')).toBe(true)
  })

  test('get_links dedupe-probe failure logs gbrain_link_query and skips add_link', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') throw new Error('query boom')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(events.map((e) => e.stage)).toContain('gbrain_link_query')
    expect(mcp.calls.some((c) => c.name === 'add_link')).toBe(false)
  })

  test('existing edge (get_links returns a match) skips add_link', async () => {
    const mcp = fakeMcp((name) =>
      name === 'get_links'
        ? [{ from_slug: 'jane-doe', to_slug: 'topline', link_type: 'works_at' }]
        : { ok: true },
    )
    const hook = new GBrainSyncHook({ memoryStore: new FakeStore(), gbrainMcp: mcp.client })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(mcp.calls.some((c) => c.name === 'add_link')).toBe(false)
  })

  test('add_link failure logs gbrain_add_link and continues the batch', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') return []
      if (name === 'add_link') throw new Error('add boom')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline'), triple('jane-doe', 'advises', 'foo')],
      removedLinks: [],
    })
    expect(events.filter((e) => e.stage === 'gbrain_add_link').length).toBe(2)
  })

  test('remove_link failure logs gbrain_remove_link', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'remove_link') throw new Error('rm boom')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [],
      removedLinks: [triple('jane-doe', 'works_at', 'topline')],
    })
    expect(events.map((e) => e.stage)).toContain('gbrain_remove_link')
  })

  test('unrecognised entity path rejects (writer contract violation surfaces)', async () => {
    const hook = new GBrainSyncHook({ memoryStore: new FakeStore(), gbrainMcp: fakeMcp(() => ({})).client })
    await expect(
      hook.onEntityWrite({ path: 'not-a-real-path', body: BODY, newLinks: [], removedLinks: [] }),
    ).rejects.toThrow()
  })

  // ISSUES #102: ONLY a missing-target add_link error defers; any other
  // add_link error keeps the existing log-and-drop best-effort behaviour (no
  // deferral, no retry — that path is covered by the auto_link backstop).
  test('a non-missing-target add_link error keeps the existing drop behaviour (not deferred)', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') return []
      if (name === 'add_link') throw new Error('connection reset by peer')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(events.map((e) => e.stage)).toContain('gbrain_add_link')
    expect(events.some((e) => e.stage === 'gbrain_add_link_deferred')).toBe(false)
    expect(hook.deferredEdgeCount).toBe(0)
  })

  // ISSUES #102: the deferred queue is bounded — when a new deferral would
  // exceed the cap, the oldest deferred edge is abandoned with a single warning
  // (no unbounded growth for targets that never land).
  test('deferred queue is capped — oldest is abandoned with a single warning when the cap is exceeded', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') return []
      // gbrain's real missing-page error shape.
      if (name === 'add_link') throw new Error('addLink failed: page "jane-doe" (source=default) or "x" (source=default) not found')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
      maxDeferredEdges: 2,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [
        triple('jane-doe', 'a', 't1'),
        triple('jane-doe', 'b', 't2'),
        triple('jane-doe', 'c', 't3'),
      ],
      removedLinks: [],
    })
    // Three deferrals attempted, but the queue holds at most 2; the oldest was
    // evicted with exactly one abandon warning.
    expect(events.filter((e) => e.stage === 'gbrain_add_link_deferred').length).toBe(3)
    expect(events.filter((e) => e.stage === 'gbrain_add_link_abandoned').length).toBe(1)
    expect(hook.deferredEdgeCount).toBe(2)
  })

  // ISSUES #102: an edge re-attempted on every drain but never satisfiable
  // (e.g. its OTHER endpoint never lands) is abandoned after the attempt cap,
  // so a re-drain loop can't churn forever.
  test('a deferred edge is abandoned after the attempt cap is reached on repeated drains', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') return []
      // add_link ALWAYS reports missing-page (the other endpoint never lands).
      if (name === 'add_link') throw new Error('addLink failed: page "deferred-src" or "deferred-tgt" not found')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
      maxDeferredAttempts: 2,
    })
    const SRC = '/srv/owner/entities/people/deferred-src.md'
    const TGT = '/srv/owner/entities/companies/deferred-tgt.md'
    // First write: source page lands, edge to deferred-tgt is deferred (attempt 0).
    await hook.onEntityWrite({ path: SRC, body: BODY, newLinks: [triple('deferred-src', 'works_at', 'deferred-tgt')], removedLinks: [] })
    expect(hook.deferredEdgeCount).toBe(1)
    // Write the target slug repeatedly → each put_page drains deferred-tgt's
    // bucket and re-attempts; add_link still reports missing → attempts climb
    // until the cap abandons the edge.
    await hook.onEntityWrite({ path: TGT, body: BODY, newLinks: [], removedLinks: [] })
    await hook.onEntityWrite({ path: TGT, body: BODY, newLinks: [], removedLinks: [] })
    expect(hook.deferredEdgeCount).toBe(0)
    expect(events.filter((e) => e.stage === 'gbrain_add_link_abandoned').length).toBe(1)
  })
})

// 2026-06-10 wow-hang-resilience (prod incident t-33333333) — when the
// gbrain binary is absent, the stdio client throws a latched
// GBrainUnavailableError per op. The hook must log the degradation
// exactly ONCE and short-circuit every subsequent write — pre-fix prod
// logged "stage=gbrain_put_page … err=Executable not found in $PATH:
// gbrain" for EVERY entity-page seed during onboarding.
describe('GBrainSyncHook — gbrain-unavailable latch', () => {
  class UnavailableStore implements MemoryStore {
    async add(): Promise<{ id: string }> {
      throw new GBrainUnavailableError('Executable not found in $PATH: gbrain')
    }
    async query(): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>> {
      return []
    }
    async delete(): Promise<void> {}
    async stats(): Promise<{ count: number; size_bytes: number }> {
      return { count: 0, size_bytes: 0 }
    }
  }

  test('binary-missing is logged exactly once; subsequent writes short-circuit silently', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp(() => {
      throw new GBrainUnavailableError('Executable not found in $PATH: gbrain')
    })
    const hook = new GBrainSyncHook({
      memoryStore: new UnavailableStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    // First write: latches + logs ONE gbrain_unavailable event. No
    // per-edge gbrain_link_query / gbrain_add_link spam.
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [
        triple('jane-doe', 'works_at', 'topline'),
        triple('jane-doe', 'founded', 'acme'),
      ],
      removedLinks: [triple('jane-doe', 'advises', 'beacon')],
    })
    expect(events.length).toBe(1)
    expect(events[0]!.stage).toBe('gbrain_unavailable')
    // Second + third writes: fully silent (no new events, no MCP calls).
    const callsAfterFirst = mcp.calls.length
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [],
      removedLinks: [triple('jane-doe', 'works_at', 'topline')],
    })
    expect(events.length).toBe(1)
    expect(mcp.calls.length).toBe(callsAfterFirst)
  })

  test('unavailable detected mid-edge-pass (page landed, links fail) latches without edge spam', async () => {
    const events: SyncHookFailureEvent[] = []
    const mcp = fakeMcp(() => {
      throw new GBrainUnavailableError('Executable not found in $PATH: gbrain')
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [
        triple('jane-doe', 'works_at', 'topline'),
        triple('jane-doe', 'founded', 'acme'),
      ],
      removedLinks: [],
    })
    // One latch event — NOT one per triple.
    expect(events.filter((e) => e.stage === 'gbrain_unavailable').length).toBe(1)
    expect(events.length).toBe(1)
  })

  test('an ordinary transient error does NOT latch — later writes still try', async () => {
    const events: SyncHookFailureEvent[] = []
    let putPageAttempts = 0
    class TransientStore implements MemoryStore {
      async add(): Promise<{ id: string }> {
        putPageAttempts += 1
        throw new Error('transient db lock')
      }
      async query(): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>> {
        return []
      }
      async delete(): Promise<void> {}
      async stats(): Promise<{ count: number; size_bytes: number }> {
        return { count: 0, size_bytes: 0 }
      }
    }
    const mcp = fakeMcp((name) => (name === 'get_links' ? [] : { ok: true }))
    const hook = new GBrainSyncHook({
      memoryStore: new TransientStore(),
      gbrainMcp: mcp.client,
      logFailure: (e) => events.push(e),
    })
    await hook.onEntityWrite({ path: PERSON, body: BODY, newLinks: [], removedLinks: [] })
    await hook.onEntityWrite({ path: PERSON, body: BODY, newLinks: [], removedLinks: [] })
    expect(putPageAttempts).toBe(2) // no latch — both writes attempted
    expect(events.filter((e) => e.stage === 'gbrain_put_page').length).toBe(2)
  })
})

describe('_parseEntityPath', () => {
  test('derives kind + slug from a writer path', () => {
    expect(_parseEntityPath('/srv/t/entities/companies/topline.md')).toEqual({ kind: 'company', slug: 'topline' })
  })
  test('throws on unknown subdir', () => {
    expect(() => _parseEntityPath('/srv/t/entities/bogus/x.md')).toThrow()
  })
})
