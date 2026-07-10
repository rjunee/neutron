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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      expect(indexes).toContain('idx_agent_nexus_events_kind_created')
      expect(indexes).toContain('idx_agent_nexus_events_created_at')
      const triggers = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
        )
        .all()
        .map((r) => r.name)
      expect(triggers).toContain('agent_nexus_events_no_update')
      expect(triggers).toContain('agent_nexus_events_no_delete')
    } finally {
      db.close()
    }
  })

  it('rejects an invalid project_id', async () => {
    await expect(h.store.ensureInit('../escape')).rejects.toThrow(NexusStoreError)
  })

  it('rejects "." and ".." project_ids (path-resolution escape)', async () => {
    // Both pass sanitizeProjectId's charset but would resolve the
    // sidecar OUTSIDE the per-project root (`Projects/..` ==
    // owner_home, `Projects/.` == the shared Projects dir).
    await expect(h.store.ensureInit('..')).rejects.toThrow(NexusStoreError)
    await expect(h.store.ensureInit('.')).rejects.toThrow(NexusStoreError)
    expect(existsSync(join(h.owner_home, '.nexus'))).toBe(false)
    expect(existsSync(join(h.owner_home, 'Projects', '.nexus'))).toBe(false)
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

  it('closeAll() DURING an in-flight ensureInit aborts it + caches no live handle (generation guard)', async () => {
    // Peek at the private lifecycle maps — the invariant under test is
    // internal (no handle retained past closeAll, no duplicate init).
    const internals = h.store as unknown as {
      handles: Map<string, unknown>
      initPromises: Map<string, unknown>
    }
    // Kick off init, tear down before it resolves, THEN await it. The
    // continuation must observe the bumped generation, close its own
    // connection, refuse to cache it, and abort the op cleanly.
    const p = h.store.ensureInit(PROJECT_ID)
    h.store.closeAll()
    await expect(p).rejects.toThrow(NexusStoreError)
    expect(internals.handles.size).toBe(0)
    expect(internals.initPromises.size).toBe(0)

    // No double-init leak: a subsequent op inits cleanly under the new
    // generation and retains EXACTLY one live handle.
    const written = await h.store.appendEvent(PROJECT_ID, input({ body: 'after-close' }))
    expect(internals.handles.size).toBe(1)
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.map((e) => e.id)).toEqual([written.id])
  })

  it('closeAll() DURING an in-flight appendEvent aborts the write on a closed handle (not a raw driver error)', async () => {
    const internals = h.store as unknown as { handles: Map<string, unknown> }
    // Operation-level boundary: the append awaits openHandle before it
    // touches the db, so a closeAll() landing in that window must abort
    // the write with a typed NexusStoreError — NOT run BEGIN IMMEDIATE
    // on a closed connection (Codex).
    const p = h.store.appendEvent(PROJECT_ID, input({ body: 'racing-write' }))
    h.store.closeAll()
    await expect(p).rejects.toThrow(NexusStoreError)
    expect(internals.handles.size).toBe(0)
    // The store recovers: a later append succeeds and is the only row.
    const ok = await h.store.appendEvent(PROJECT_ID, input({ body: 'recovered' }))
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.map((e) => e.id)).toEqual([ok.id])
  })

  it('closeAll() racing an op that reuses a CACHED handle aborts it (not a raw driver error)', async () => {
    const internals = h.store as unknown as { handles: Map<string, unknown> }
    // Prime the cache so openHandle resolves the CACHED handle (no
    // init). The op still awaits openHandle, so a closeAll() in that
    // await gap closes the cached db underneath it — the op must abort
    // with a typed error, not run SQL on the closed connection (Codex).
    await h.store.ensureInit(PROJECT_ID)
    expect(internals.handles.size).toBe(1)

    const w = h.store.appendEvent(PROJECT_ID, input({ body: 'cached-race' }))
    h.store.closeAll()
    await expect(w).rejects.toThrow(NexusStoreError)
    expect(internals.handles.size).toBe(0)

    // Same boundary for the read path.
    await h.store.ensureInit(PROJECT_ID)
    const r = h.store.readRecent(PROJECT_ID)
    h.store.closeAll()
    await expect(r).rejects.toThrow(NexusStoreError)

    // Store recovers cleanly afterward.
    const ok = await h.store.appendEvent(PROJECT_ID, input({ body: 'recovered' }))
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.map((e) => e.id)).toEqual([ok.id])
  })

  it('closeAll() racing init lets a concurrent op start a clean new generation', async () => {
    const internals = h.store as unknown as { handles: Map<string, unknown> }
    // A: in-flight init (aborts under closeAll). B: a concurrent op
    // started AFTER closeAll must init fresh (not race A's dead handle)
    // and its handle is the one retained.
    const a = h.store.ensureInit(PROJECT_ID)
    h.store.closeAll()
    const b = h.store.appendEvent(PROJECT_ID, input({ body: 'gen-2' }))
    await expect(a).rejects.toThrow(NexusStoreError)
    await b
    // Only B's live handle survives; A's was closed + dropped.
    expect(internals.handles.size).toBe(1)
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.map((e) => e.body)).toEqual(['gen-2'])
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

  it('interleaved appends from TWO connections all land with distinct ids', async () => {
    // Second store instance = second SQLite connection on the same
    // sidecar file. NOTE: bun:sqlite is synchronous on one JS thread,
    // so these transactions do NOT overlap — this covers cross-
    // connection correctness (ids, visibility), while the subprocess
    // tests below cover genuinely overlapping write locks.
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

describe('NexusStore — REAL cross-process concurrency (subprocess)', () => {
  const FIXTURES = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
  )
  let h: Harness
  beforeEach(() => {
    h = startStore()
  })
  afterEach(() => {
    h.cleanup()
  })

  /** Read a piped stream until `needle` shows up, the stream ends, or
   *  `timeoutMs` elapses. Every `reader.read()` is raced against the
   *  remaining deadline (Codex r2 — a silent-but-alive child must not
   *  leave the await pending forever); on timeout the reader is
   *  cancelled so the pending read settles. */
  async function waitForLine(
    stream: ReadableStream<Uint8Array>,
    needle: string,
    timeoutMs: number,
  ): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + timeoutMs
    let buf = ''
    try {
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          await reader.cancel().catch(() => {})
          throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got: ${buf}`)
        }
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(remaining).then(() => 'timeout' as const),
        ])
        if (next === 'timeout') {
          await reader.cancel().catch(() => {})
          throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got: ${buf}`)
        }
        if (next.value !== undefined) {
          buf += decoder.decode(next.value, { stream: true })
        }
        if (buf.includes(needle)) return buf
        if (next.done) {
          throw new Error(`stream ended without ${JSON.stringify(needle)}; got: ${buf}`)
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* a cancelled reader may already be detached */
      }
    }
  }

  it(
    'simultaneous first-writes from 3 PROCESSES to a fresh sidecar all land (init race)',
    async () => {
      const go_file = join(h.tmp, 'go')
      const procs = Array.from({ length: 3 }, (_, i) =>
        Bun.spawn({
          cmd: [
            process.execPath,
            'run',
            join(FIXTURES, 'append-first-write.ts'),
            h.owner_home,
            PROJECT_ID,
            `proc-${i}`,
            go_file,
          ],
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      )
      try {
        // Barrier: release the go file only once every process is
        // booted + store-constructed, so all three hit the FRESH
        // sidecar's migration path at (near) the same instant.
        const readies = await Promise.all(
          procs.map((p) => waitForLine(p.stdout, 'READY', 15_000)),
        )
        expect(readies.length).toBe(3)
        writeFileSync(go_file, 'go')
        const exits = await Promise.all(procs.map((p) => p.exited))
        const errs = await Promise.all(
          procs.map((p) => new Response(p.stderr).text()),
        )
        expect(exits.map((c, i) => `${i}:${c} ${errs[i]?.trim() ?? ''}`.trim())).toEqual([
          '0:0',
          '1:0',
          '2:0',
        ])
      } finally {
        for (const p of procs) p.kill()
      }
      const events = await h.store.readRecent(PROJECT_ID)
      expect(events.length).toBe(3)
      expect(new Set(events.map((e) => e.id)).size).toBe(3)
      expect(new Set(events.map((e) => e.body))).toEqual(
        new Set(['proc-0', 'proc-1', 'proc-2']),
      )
    },
    30_000,
  )

  it(
    'appendEvent OVERLAPPING a write lock held 400ms by another process succeeds (busy-retry ladder)',
    async () => {
      await h.store.ensureInit(PROJECT_ID)
      const db_path = sidecarPath(h.owner_home)
      const holder = Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          join(FIXTURES, 'hold-write-lock.ts'),
          db_path,
          '400',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        // Synchronize on HELD — the holder has BEGIN IMMEDIATE + a
        // pending INSERT at this point, so the append below provably
        // starts while the write lock is held. 400ms > the 100ms
        // C-level busy_timeout, so only the withBusyRetry ladder can
        // carry this write through.
        await waitForLine(holder.stdout, 'HELD', 15_000)
        const t0 = Date.now()
        const written = await h.store.appendEvent(
          PROJECT_ID,
          input({ body: 'wrote through contention' }),
        )
        const elapsed = Date.now() - t0
        // Proves the write actually contended (an uncontended append
        // is single-digit ms) and waited out the holder's window.
        expect(elapsed).toBeGreaterThan(150)
        const exit = await holder.exited
        expect(exit).toBe(0)
        const events = await h.store.readRecent(PROJECT_ID)
        // Holder's marker row + our append.
        expect(events.length).toBe(2)
        expect(events.some((e) => e.id === written.id)).toBe(true)
        expect(events.some((e) => e.actor_id === 'lock-holder')).toBe(true)
      } finally {
        holder.kill()
      }
    },
    30_000,
  )

  it(
    'closeAll() BETWEEN busy-retry attempts aborts the append cleanly (no closed-db write)',
    async () => {
      await h.store.ensureInit(PROJECT_ID)
      const internals = h.store as unknown as { handles: Map<string, unknown> }
      const db_path = sidecarPath(h.owner_home)
      // Hold the write lock long enough that the append is still in its
      // busy-retry loop (yielding via await Bun.sleep between attempts)
      // when we tear the store down.
      const holder = Bun.spawn({
        cmd: [
          process.execPath,
          'run',
          join(FIXTURES, 'hold-write-lock.ts'),
          db_path,
          '800',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      try {
        await waitForLine(holder.stdout, 'HELD', 15_000)
        // Enters withBusyRetry; first BEGIN IMMEDIATE blocks the busy
        // window then the loop yields.
        const w = h.store.appendEvent(
          PROJECT_ID,
          input({ body: 'contention-close', actor_id: 'racer' }),
        )
        // Land closeAll() during an inter-attempt yield — past the
        // first ~100ms busy_timeout attempt, well inside the 800ms hold.
        await Bun.sleep(250)
        h.store.closeAll()
        // The next retry attempt re-checks handle.closed and aborts
        // with a TYPED error, not a raw "database is closed".
        await expect(w).rejects.toThrow(NexusStoreError)
        expect(internals.handles.size).toBe(0)
        await holder.exited
      } finally {
        holder.kill()
      }
      // Recovery: fresh init; the aborted append left NO row (only the
      // holder's marker survives), and a new append lands.
      const ok = await h.store.appendEvent(PROJECT_ID, input({ body: 'recovered' }))
      const events = await h.store.readRecent(PROJECT_ID, { limit: 100 })
      expect(events.some((e) => e.body === 'contention-close')).toBe(false)
      expect(events.some((e) => e.id === ok.id)).toBe(true)
    },
    30_000,
  )
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

  it('orders + limits by created_at even when id order disagrees (injected clock/ULID)', async () => {
    // ids DESCEND while the clock ASCENDS — created_at is the recency
    // truth, so readRecent must ignore the id order for selection and
    // only tie-break on it (Codex r2).
    const ids = ['03-id-sorts-last', '02-id-sorts-middle', '01-id-sorts-first']
    let clock = 0
    const g = startStore({
      ulid: () => ids.shift() ?? 'exhausted',
      now: () => (clock += 1_000),
    })
    try {
      await g.store.appendEvent(PROJECT_ID, input({ body: 'e1' }))
      await g.store.appendEvent(PROJECT_ID, input({ body: 'e2' }))
      await g.store.appendEvent(PROJECT_ID, input({ body: 'e3' }))
      const all = await g.store.readRecent(PROJECT_ID)
      expect(all.map((e) => e.body)).toEqual(['e1', 'e2', 'e3'])
      // limit keeps the NEWEST by created_at — under ORDER BY id these
      // would wrongly be e1, e2.
      const newest = await g.store.readRecent(PROJECT_ID, { limit: 2 })
      expect(newest.map((e) => e.body)).toEqual(['e2', 'e3'])
    } finally {
      g.cleanup()
    }
  })

  it('rejects an unknown kind filter', async () => {
    await seed()
    await expect(
      h.store.readRecent(PROJECT_ID, {
        kinds: ['verdict' as NexusEventKind],
      }),
    ).rejects.toThrow(NexusStoreError)
  })

  it('limit boundaries: 0/negative/NaN/fractional/over-cap clamp per clampLimit', async () => {
    await seed() // 5 rows: d1,o1,l1,h1,d2 (oldest→newest)
    const bodies = async (limit: number) =>
      (await h.store.readRecent(PROJECT_ID, { limit })).map((e) => e.body)
    // ≤0 / non-finite → fallback 50 → all 5.
    expect(await bodies(0)).toEqual(['d1', 'o1', 'l1', 'h1', 'd2'])
    expect(await bodies(-5)).toEqual(['d1', 'o1', 'l1', 'h1', 'd2'])
    expect(await bodies(Number.NaN)).toEqual(['d1', 'o1', 'l1', 'h1', 'd2'])
    expect(await bodies(Number.POSITIVE_INFINITY)).toEqual([
      'd1', 'o1', 'l1', 'h1', 'd2',
    ])
    // 1 → newest single; fractional floors to 2.
    expect(await bodies(1)).toEqual(['d2'])
    expect(await bodies(2.9)).toEqual(['h1', 'd2'])
    // Over-cap (501 → 500) still returns all 5 available.
    expect((await bodies(501)).length).toBe(5)
  })

  it('rejects a non-finite since', async () => {
    await seed()
    await expect(
      h.store.readRecent(PROJECT_ID, { since: Number.NaN }),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.readRecent(PROJECT_ID, { since: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(NexusStoreError)
  })

  it('invalid readRecent options rejected BEFORE the sidecar is created', async () => {
    // Same amplification guard as appendEvent — validation precedes
    // openHandle (Codex). Fresh project id, never otherwise touched.
    const fresh = 'read-never-init'
    const dir = join(h.owner_home, 'Projects', fresh)
    await expect(
      h.store.readRecent(fresh, { kinds: ['verdict' as NexusEventKind] }),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.readRecent(fresh, { since: Number.NaN }),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.readRecent(fresh, null as unknown as Parameters<typeof h.store.readRecent>[1]),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.readRecent(fresh, {
        kinds: 'decision' as unknown as NexusEventKind[],
      }),
    ).rejects.toThrow(NexusStoreError)
    expect(existsSync(dir)).toBe(false)
  })

  it('since = 0 is a real (inclusive) filter, not treated as absent', async () => {
    await seed() // created_at values 2000..6000
    const events = await h.store.readRecent(PROJECT_ID, { since: 0 })
    expect(events.length).toBe(5)
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

  it('malformed runtime input yields NexusStoreError, not a raw TypeError', async () => {
    // The store is the validated seam — an untyped caller (`as any`, a
    // future JSON boundary) must get a typed error, never a TypeError
    // from dereferencing .length/.kind on a bad shape (Codex).
    const bad = (o: Record<string, unknown>) =>
      h.store.appendEvent(PROJECT_ID, { ...input(), ...o } as unknown as AppendNexusEventInput)
    await expect(bad({ body: null })).rejects.toThrow(NexusStoreError)
    await expect(bad({ body: 42 })).rejects.toThrow(NexusStoreError)
    await expect(bad({ actor_id: null })).rejects.toThrow(NexusStoreError)
    await expect(bad({ actor_id: 7 })).rejects.toThrow(NexusStoreError)
    await expect(bad({ refs: [null] })).rejects.toThrow(NexusStoreError)
    await expect(bad({ refs: ['not-an-object'] })).rejects.toThrow(NexusStoreError)
    await expect(bad({ refs: { kind: 'doc', ref: 'a' } })).rejects.toThrow(
      NexusStoreError,
    )
    // Top-level payload shape guard: null / undefined / array / primitive.
    const badTop = (v: unknown) =>
      h.store.appendEvent(PROJECT_ID, v as unknown as AppendNexusEventInput)
    await expect(badTop(null)).rejects.toThrow(NexusStoreError)
    await expect(badTop(undefined)).rejects.toThrow(NexusStoreError)
    await expect(badTop([])).rejects.toThrow(NexusStoreError)
    await expect(badTop('nope')).rejects.toThrow(NexusStoreError)
    await expect(badTop(42)).rejects.toThrow(NexusStoreError)
    // And none of these left a row behind.
    const events = await h.store.readRecent(PROJECT_ID)
    expect(events.length).toBe(0)
  })

  it('invalid input rejected BEFORE the sidecar is created (no unbounded init)', async () => {
    // Validation must precede openHandle, else a stream of rejected
    // payloads on distinct project_ids spawns unbounded .nexus/ dbs
    // (Codex). Use a FRESH project id and never read it (a read would
    // itself init the sidecar).
    const fresh = 'never-initialized'
    const freshSidecar = join(h.owner_home, 'Projects', fresh, '.nexus', 'nexus.db')
    await expect(
      h.store.appendEvent(fresh, null as unknown as AppendNexusEventInput),
    ).rejects.toThrow(NexusStoreError)
    await expect(
      h.store.appendEvent(fresh, input({ body: '' })),
    ).rejects.toThrow(NexusStoreError)
    expect(existsSync(freshSidecar)).toBe(false)
    expect(existsSync(join(h.owner_home, 'Projects', fresh))).toBe(false)
  })

  it('body cap: exactly-cap accepted, cap+1 rejected (byte boundary)', async () => {
    const atCap = await h.store.appendEvent(
      PROJECT_ID,
      input({ body: 'x'.repeat(MAX_NEXUS_BODY_BYTES) }),
    )
    expect(atCap.body.length).toBe(MAX_NEXUS_BODY_BYTES)
    await expect(
      h.store.appendEvent(
        PROJECT_ID,
        input({ body: 'x'.repeat(MAX_NEXUS_BODY_BYTES + 1) }),
      ),
    ).rejects.toThrow(NexusStoreError)
  })

  it('body cap counts UTF-8 BYTES, not chars', async () => {
    // '€' is 3 bytes UTF-8 — this string is under the cap in chars
    // (~2.7k) but over it in bytes, so it must be rejected.
    const multibyte = '€'.repeat(Math.floor(MAX_NEXUS_BODY_BYTES / 3) + 1)
    expect(multibyte.length).toBeLessThan(MAX_NEXUS_BODY_BYTES)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(MAX_NEXUS_BODY_BYTES)
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ body: multibyte })),
    ).rejects.toThrow(NexusStoreError)
  })

  it('refs_json cap: exactly-cap accepted, over-cap rejected (byte boundary)', async () => {
    // Pad an ASCII note so the SERIALIZED refs_json lands exactly on
    // the cap (ASCII ⇒ bytes == JSON string length).
    const base: NexusRef[] = [{ kind: 'url', ref: 'https://x.test', note: '' }]
    const overhead = JSON.stringify(base).length
    const refsAtCap: NexusRef[] = [
      {
        kind: 'url',
        ref: 'https://x.test',
        note: 'a'.repeat(MAX_NEXUS_REFS_JSON_BYTES - overhead),
      },
    ]
    const serialized = JSON.stringify(refsAtCap)
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(MAX_NEXUS_REFS_JSON_BYTES)
    const written = await h.store.appendEvent(PROJECT_ID, input({ refs: refsAtCap }))
    expect(written.refs_json).toBe(serialized)

    const refsOverCap: NexusRef[] = [
      {
        kind: 'url',
        ref: 'https://x.test',
        note: 'a'.repeat(MAX_NEXUS_REFS_JSON_BYTES - overhead + 1),
      },
    ]
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ refs: refsOverCap })),
    ).rejects.toThrow(NexusStoreError)
  })

  it('refs_json cap counts UTF-8 BYTES, not UTF-16 code units', async () => {
    // The note is ~1.4k chars (well under the cap as code units) but
    // >4 KB as UTF-8 — must be rejected.
    const note = '€'.repeat(Math.floor(MAX_NEXUS_REFS_JSON_BYTES / 3) + 40)
    const refs: NexusRef[] = [{ kind: 'url', ref: 'https://x.test', note }]
    expect(JSON.stringify(refs).length).toBeLessThan(MAX_NEXUS_REFS_JSON_BYTES)
    expect(Buffer.byteLength(JSON.stringify(refs), 'utf8')).toBeGreaterThan(
      MAX_NEXUS_REFS_JSON_BYTES,
    )
    await expect(
      h.store.appendEvent(PROJECT_ID, input({ refs })),
    ).rejects.toThrow(NexusStoreError)
  })

  it('append-only is enforced at the DATABASE: raw UPDATE and DELETE both fail', async () => {
    const written = await h.store.appendEvent(PROJECT_ID, input({ body: 'immutable' }))
    h.store.closeAll()
    const db = new Database(sidecarPath(h.owner_home), {
      create: false,
      readwrite: true,
    })
    try {
      expect(() =>
        db.run(`UPDATE agent_nexus_events SET body = 'rewritten' WHERE id = ?`, [
          written.id,
        ]),
      ).toThrow(/append-only/)
      expect(() => db.run('DELETE FROM agent_nexus_events')).toThrow(/append-only/)
      const row = db
        .query<{ body: string }, [string]>(
          'SELECT body FROM agent_nexus_events WHERE id = ?',
        )
        .get(written.id)
      expect(row?.body).toBe('immutable')
    } finally {
      db.close()
    }
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
