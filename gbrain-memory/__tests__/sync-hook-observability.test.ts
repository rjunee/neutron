/**
 * GBrainSyncHook — P9 observability (`gbrain_sync_state`) tests.
 *
 * Pins the pure side-observation contract added by P9:
 *   1. a health snapshot is published on a successful write (status ok,
 *      last-success stamped, deferred depth reported),
 *   2. the once-only unavailable latch publishes an 'unavailable' snapshot with
 *      the reason + timestamp,
 *   3. a deferred edge is reflected in the published `deferredCount`,
 *   4. **fail-soft is byte-identical**: a THROWING sink can never break, reorder,
 *      or abort the sync path (the entity write still completes + the graph half
 *      still fires), and
 *   5. no sink wired → no publish, no crash (today's default behavior).
 *
 * Capturing fakes only (no real brain) — the observation points are control-flow,
 * not storage, so the fast fakes exercise them directly.
 */

import { describe, test, expect } from 'bun:test'
import type { Triple } from '@neutronai/runtime/auto-link.ts'
import { GBrainUnavailableError, type McpClient, type MemoryStore } from '../memory-store.ts'
import {
  GBrainSyncHook,
  type GbrainSyncStateSnapshot,
  type GbrainSyncStateSink,
} from '../GBrainSyncHook.ts'

const PERSON = '/srv/owner/entities/people/jane-doe.md'
const BODY = '---\nkind: person\n---\n\nSam runs things.\n'

function triple(subject: string, predicate: string, object: string): Triple {
  return { subject, predicate, object, source: subject }
}

class FakeStore implements MemoryStore {
  added: Array<{ content: string; metadata?: Record<string, unknown> }> = []
  constructor(private readonly addErr?: unknown) {}
  async add(input: { content: string; metadata?: Record<string, unknown> }): Promise<{ id: string }> {
    if (this.addErr !== undefined) throw this.addErr
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

/** Capturing sink recording every published snapshot. */
function capturingSink(): { sink: GbrainSyncStateSink; snaps: GbrainSyncStateSnapshot[] } {
  const snaps: GbrainSyncStateSnapshot[] = []
  return { snaps, sink: { publish: (s) => snaps.push({ ...s }) } }
}

describe('GBrainSyncHook — P9 observability', () => {
  test('publishes an ok snapshot with last-success stamped on a clean write', async () => {
    const { sink, snaps } = capturingSink()
    const mcp = fakeMcp((name) => (name === 'get_links' ? [] : { ok: true }))
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      syncStateSink: sink,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    const last = snaps.at(-1)!
    expect(last.status).toBe('ok')
    expect(last.latchReason).toBeNull()
    expect(last.latchedAt).toBeNull()
    expect(last.deferredCount).toBe(0)
    expect(last.lastSuccessAt).not.toBeNull()
    // Valid ISO-8601.
    expect(Number.isNaN(Date.parse(last.lastSuccessAt as string))).toBe(false)
  })

  test('unavailable latch publishes exactly one unavailable snapshot with reason + ts', async () => {
    const { sink, snaps } = capturingSink()
    // put_page throws the binary-missing error → latch.
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(new GBrainUnavailableError('gbrain missing')),
      gbrainMcp: fakeMcp(() => ({ ok: true })).client,
      syncStateSink: sink,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    const unavailable = snaps.filter((s) => s.status === 'unavailable')
    expect(unavailable.length).toBe(1)
    expect(unavailable[0]!.latchReason).toContain('gbrain missing')
    expect(unavailable[0]!.latchedAt).not.toBeNull()
    expect(unavailable[0]!.lastSuccessAt).toBeNull()

    // A SECOND write short-circuits at the top (already latched) → no further
    // publish (no storm), mirroring the once-only latch.
    const before = snaps.length
    await hook.onEntityWrite({ path: PERSON, body: BODY, newLinks: [], removedLinks: [] })
    expect(snaps.length).toBe(before)
  })

  test('a deferred edge (missing target page) is reflected in deferredCount', async () => {
    const { sink, snaps } = capturingSink()
    const mcp = fakeMcp((name) => {
      if (name === 'get_links') return []
      if (name === 'add_link') throw new Error('addLink failed: page "topline" not found')
      return { ok: true }
    })
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      syncStateSink: sink,
    })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    const last = snaps.at(-1)!
    expect(last.deferredCount).toBe(1)
    expect(hook.deferredEdgeCount).toBe(1)
    // The published depth mirrors the hook's own accessor (single source).
    expect(last.deferredCount).toBe(hook.deferredEdgeCount)
  })

  test('FAIL-SOFT: a throwing sink never breaks or aborts the sync path', async () => {
    const throwingSink: GbrainSyncStateSink = {
      publish() {
        throw new Error('sink boom — must be swallowed')
      },
    }
    const mcp = fakeMcp((name) => (name === 'get_links' ? [] : { ok: true }))
    const hook = new GBrainSyncHook({
      memoryStore: new FakeStore(),
      gbrainMcp: mcp.client,
      syncStateSink: throwingSink,
    })
    // Must resolve (not reject) despite the throwing sink.
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    // And the graph half still fired — the sink throw did not short-circuit.
    expect(mcp.calls.some((c) => c.name === 'add_link')).toBe(true)
  })

  test('no sink wired → no crash (byte-identical default)', async () => {
    const mcp = fakeMcp((name) => (name === 'get_links' ? [] : { ok: true }))
    const hook = new GBrainSyncHook({ memoryStore: new FakeStore(), gbrainMcp: mcp.client })
    await hook.onEntityWrite({
      path: PERSON,
      body: BODY,
      newLinks: [triple('jane-doe', 'works_at', 'topline')],
      removedLinks: [],
    })
    expect(mcp.calls.some((c) => c.name === 'add_link')).toBe(true)
  })
})
