/**
 * RC1 — nexus-store integration tests.
 *
 * Real on-disk tmp SQLite sidecar (same harness shape as
 * gateway/comments/__tests__/comment-store.test.ts); covers:
 *   - schema init (migration applies, expected table + indexes exist)
 *   - appendEvent → reads back via readRecent (round-trip)
 *   - CONCURRENT append round-trips (the RC1 accept criterion),
 *     including cross-connection contention via a second store
 *     instance on the same sidecar file
 *   - readRecent filtering by kinds / since / limit + chronological
 *     return order
 *   - taxonomy enforcement (store-level validation AND the schema
 *     CHECK constraints for raw-SQL writers)
 *   - refs serialization round-trip + tolerant parseNexusRefs
 *   - body / refs_json size caps
 *   - lazy-init dance for first-write-to-fresh-project
 *   - rm-with-project lifecycle
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_NEXUS_BODY_BYTES,
  MAX_NEXUS_REFS_JSON_BYTES,
  NexusStore,
  NexusStoreError,
  parseNexusRefs,
  type AppendNexusEventInput,
  type NexusEventKind,
  type NexusRef,
} from '../nexus-store.ts'

interface Harness {
  store: NexusStore
  owner_home: string
  tmp: string
  cleanup(): void
}

function startStore(opts: { ulid?: () => string; now?: () => number } = {}): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nexus-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const storeOpts: ConstructorParameters<typeof NexusStore>[0] = { owner_home }
  if (opts.ulid !== undefined) storeOpts.ulid = opts.ulid
  if (opts.now !== undefined) storeOpts.now = opts.now
  const store = new NexusStore(storeOpts)
  return {
    store,
    owner_home,
    tmp,
    cleanup: () => {
      store.closeAll()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const PROJECT_ID = 'demo-project'

function input(overrides: Partial<AppendNexusEventInput> = {}): AppendNexusEventInput {
  return {
    actor_kind: 'argus',
    actor_id: 'argus-r1',
    kind: 'decision',
    body: 'APPROVE — trident run rc1-nexus round 1',
    refs: null,
    ...overrides,
  }
}

function sidecarPath(owner_home: string): string {
  return join(owner_home, 'Projects', PROJECT_ID, '.nexus', 'nexus.db')
}

describe('NexusStore — schema init', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('creates .nexus/nexus.db on first write', async () => {
    await h.store.ensureInit(PROJECT_ID)
    expect(existsSync(sidecarPath(h.owner_home))).toBe(true)
  })

  it('applies the migration producing the expected table + indexes', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const db = new Database(sidecarPath(h.owner_home), {
      create: false,
      readonly: true,
    })
    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name)
      expect(tables).toContain('agent_nexus_events')
      expect(tables).toContain('_migrations')
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
        )
        .all()
        .map((r) => r.name)
      expect(indexes).toContain('idx_agent_nexus_events_kind_id')
      expect(indexes).toContain('idx_agent_nexus_events_created_at')
    } finally {
      db.close()
    }
  })

  it('rejects an invalid project_id', async () => {
    await expect(h.store.ensureInit('../escape')).rejects.toThrow(NexusStoreError)
  })

  it('two concurrent first-writes share one init (lazy-init dance)', async () => {
    const [a, b] = await Promise.all([
      h.store.appendEvent(PROJECT_ID, input({ body: 'first' })),
      h.store.appendEvent(PROJECT_ID, input({ body: 'second' })),
    ])
    expect(a.id).not.toBe(b.id)
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.length).toBe(2)
  })

  it('rm-with-project removes the log (sidecar lifecycle)', async () => {
    await h.store.appendEvent(PROJECT_ID, input())
    h.store.closeAll()
    rmSync(join(h.owner_home, 'Projects', PROJECT_ID), {
      recursive: true,
      force: true,
    })
    expect(existsSync(sidecarPath(h.owner_home))).toBe(false)
    // A fresh write re-inits an EMPTY log — no cross-project residue.
    await h.store.appendEvent(PROJECT_ID, input({ body: 'reborn' }))
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.length).toBe(1)
    expect(events[0]?.body).toBe('reborn')
  })
})

describe('NexusStore — append + readRecent round-trip', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('round-trips one event with refs', async () => {
    const refs: NexusRef[] = [
      { kind: 'pr', ref: '#311', note: 'RC1 store PR' },
      { kind: 'doc', ref: 'plans/2026-07-02-world-class-refactor-plan.md' },
      { kind: 'run', ref: 'trident-rc1-nexus' },
    ]
    const written = await h.store.appendEvent(
      PROJECT_ID,
      input({
        actor_kind: 'forge',
        actor_id: 'forge-worker-3',
        kind: 'handoff',
        body: 'inner build finished; PR open, gates green',
        refs,
      }),
    )
    expect(written.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(written.created_at).toBeGreaterThan(0)

    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.length).toBe(1)
    const got = events[0]
    expect(got).toEqual(written)
    expect(got?.actor_kind).toBe('forge')
    expect(got?.kind).toBe('handoff')
    expect(parseNexusRefs(got?.refs_json ?? null)).toEqual(refs)
  })

  it('persists across store instances (real on-disk durability)', async () => {
    await h.store.appendEvent(PROJECT_ID, input({ body: 'durable' }))
    h.store.closeAll()
    const reopened = new NexusStore({ owner_home: h.owner_home })
    try {
      const events = await reopened.readRecent(PROJECT_ID)
      expect(events.length).toBe(1)
      expect(events[0]?.body).toBe('durable')
    } finally {
      reopened.closeAll()
    }
  })

  it('empty/null refs both persist as refs_json = NULL', async () => {
    const a = await h.store.appendEvent(PROJECT_ID, input({ refs: null }))
    const b = await h.store.appendEvent(PROJECT_ID, input({ refs: [] }))
    expect(a.refs_json).toBeNull()
    expect(b.refs_json).toBeNull()
    expect(parseNexusRefs(a.refs_json)).toEqual([])
  })
})

describe('NexusStore — concurrent append (RC1 accept criterion)', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('50 concurrent appends all land with distinct ids and round-trip', async () => {
    const kinds: NexusEventKind[] = ['decision', 'observation', 'learning', 'handoff']
    const writes = Array.from({ length: 50 }, (_, i) =>
      h.store.appendEvent(
        PROJECT_ID,
        input({
          kind: kinds[i % kinds.length] as NexusEventKind,
          body: `concurrent event ${i}`,
        }),
      ),
    )
    const written = await Promise.all(writes)
    const ids = new Set(written.map((e) => e.id))
    expect(ids.size).toBe(50)

    const events = await h.store.readRecent(PROJECT_ID, { limit: 100 })
    expect(events.length).toBe(50)
    expect(new Set(events.map((e) => e.id))).toEqual(ids)
    // Chronological (id-ascending) return order.
    const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(events.map((e) => e.id)).toEqual(sorted.map((e) => e.id))
  })

  it('concurrent appends from TWO connections serialise (BEGIN IMMEDIATE)', async () => {
    // Second store instance = second SQLite connection on the same
    // sidecar file — exercises real cross-connection write contention,
    // not just same-connection interleaving.
    const other = new NexusStore({ owner_home: h.owner_home })
    try {
      await h.store.ensureInit(PROJECT_ID)
      await other.ensureInit(PROJECT_ID)
      const writes: Array<Promise<unknown>> = []
      for (let i = 0; i < 20; i++) {
        writes.push(h.store.appendEvent(PROJECT_ID, input({ body: `a${i}` })))
        writes.push(other.appendEvent(PROJECT_ID, input({ body: `b${i}` })))
      }
      await Promise.all(writes)
      const events = await h.store.readRecent(PROJECT_ID, { limit: 100 })
      expect(events.length).toBe(40)
      expect(new Set(events.map((e) => e.id)).size).toBe(40)
    } finally {
      other.closeAll()
    }
  })
})

describe('NexusStore — readRecent filtering', () => {
  let h: Harness
  let tick: number
  beforeEach(() => {
    tick = 1_000
    h = startStore({ now: () => tick })
  })
  afterEach(() => {
    h.cleanup()
  })

  async function seed(): Promise<void> {
    const rows: Array<[NexusEventKind, string]> = [
      ['decision', 'd1'],
      ['observation', 'o1'],
      ['learning', 'l1'],
      ['handoff', 'h1'],
      ['decision', 'd2'],
    ]
    for (const [kind, body] of rows) {
      tick += 1_000
      await h.store.appendEvent(PROJECT_ID, input({ kind, body }))
    }
  }

  it('filters by kinds', async () => {
    await seed()
    const events = await h.store.readRecent(PROJECT_ID, {
      kinds: ['decision', 'handoff'],
    })
    expect(events.map((e) => e.body)).toEqual(['d1', 'h1', 'd2'])
  })

  it('filters by since (inclusive created_at lower bound)', async () => {
    await seed()
    const events = await h.store.readRecent(PROJECT_ID, { since: 4_000 })
    expect(events.map((e) => e.body)).toEqual(['l1', 'h1', 'd2'])
  })

  it('kinds + since + limit compose; limit keeps the NEWEST matches', async () => {
    await seed()
    const events = await h.store.readRecent(PROJECT_ID, {
      kinds: ['decision', 'observation'],
      since: 3_000,
      limit: 2,
    })
    // Matches are o1 (3000), d2 (6000); limit 2 keeps both, oldest first.
    expect(events.map((e) => e.body)).toEqual(['o1', 'd2'])
    const newest = await h.store.readRecent(PROJECT_ID, { limit: 2 })
    expect(newest.map((e) => e.body)).toEqual(['h1', 'd2'])
  })

  it('rejects an unknown kind filter', async () => {
    await seed()
    await expect(
      h.store.readRecent(PROJECT_ID, {
        kinds: ['verdict' as NexusEventKind],
      }),
    ).rejects.toThrow(NexusStoreError)
  })
})

describe('NexusStore — taxonomy + caps enforcement', () => {
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  it('rejects an unknown actor_kind at the write surface', async () => {
    await expect(
      h.store.appendEvent(
        PROJECT_ID,
        input({ actor_kind: 'nova' as AppendNexusEventInput['actor_kind'] }),
      ),
    ).rejects.toThrow(NexusStoreError)
  })

  it('rejects an unknown event kind at the write surface', async () => {
    await expect(
      h.store.appendEvent(
        PROJECT_ID,
        input({ kind: 'verdict' as NexusEventKind }),
      ),
    ).rejects.toThrow(NexusStoreError)
  })

  it('rejects empty actor_id / body', async () => {
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ actor_id: '' })),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ body: '' })),
    ).rejects.toThrow(NexusStoreError)
  })

  it('rejects an unknown ref kind', async () => {
    await expect(
      h.store.appendEvent(
        PROJECT_ID,
        input({ refs: [{ kind: 'ticket' as NexusRef['kind'], ref: 'X-1' }] }),
      ),
    ).rejects.toThrow(NexusStoreError)
  })

  it('enforces the body cap', async () => {
    await expect(
      h.store.appendEvent(
        PROJECT_ID,
        input({ body: 'x'.repeat(MAX_NEXUS_BODY_BYTES + 1) }),
      ),
    ).rejects.toThrow(NexusStoreError)
  })

  it('enforces the refs_json cap', async () => {
    const refs: NexusRef[] = Array.from({ length: 200 }, (_, i) => ({
      kind: 'url',
      ref: `https://example.com/${'x'.repeat(64)}/${i}`,
    }))
    expect(JSON.stringify(refs).length).toBeGreaterThan(MAX_NEXUS_REFS_JSON_BYTES)
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ refs })),
    ).rejects.toThrow(NexusStoreError)
  })

  it('schema CHECK constraints stop raw-SQL writers that bypass the store', async () => {
    await h.store.ensureInit(PROJECT_ID)
    const db = new Database(sidecarPath(h.owner_home), {
      create: false,
      readwrite: true,
    })
    try {
      expect(() =>
        db.run(
          `INSERT INTO agent_nexus_events
             (id, actor_kind, actor_id, kind, body, refs_json, created_at)
           VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'nova', 'x', 'decision', 'b', NULL, 1)`,
        ),
      ).toThrow()
      expect(() =>
        db.run(
          `INSERT INTO agent_nexus_events
             (id, actor_kind, actor_id, kind, body, refs_json, created_at)
           VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'chat', 'x', 'verdict', 'b', NULL, 1)`,
        ),
      ).toThrow()
    } finally {
      db.close()
    }
  })
})

describe('parseNexusRefs — tolerant read', () => {
  it('null → []', () => {
    expect(parseNexusRefs(null)).toEqual([])
  })

  it('malformed JSON → []', () => {
    expect(parseNexusRefs('{nope')).toEqual([])
  })

  it('non-array JSON → []', () => {
    expect(parseNexusRefs('{"kind":"doc","ref":"a.md"}')).toEqual([])
  })

  it('skips non-conforming entries, keeps valid ones', () => {
    const raw = JSON.stringify([
      { kind: 'doc', ref: 'plans/a.md' },
      { kind: 'ticket', ref: 'X-1' }, // unknown kind → skipped
      { kind: 'pr' }, // missing ref → skipped
      { kind: 'run', ref: '' }, // empty ref → skipped
      42, // not an object → skipped
      { kind: 'entity', ref: 'people/sam', note: 'owner' },
    ])
    expect(parseNexusRefs(raw)).toEqual([
      { kind: 'doc', ref: 'plans/a.md' },
      { kind: 'entity', ref: 'people/sam', note: 'owner' },
    ])
  })
})
