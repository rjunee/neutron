/**
 * Connect FEATURES B2 — the one-way host→collaborator memory mirror
 * (connect-spec §1.8 + §2.4), IMPORT-ON-JOIN milestone.
 *
 * Two layers:
 *   1. **Real GBrain PGLite round-trip** — stands up TWO actual in-memory GBrain
 *      brains (a host brain seeded with a real entity graph + a fresh
 *      collaborator brain) and proves that a collaborator JOIN (via the real
 *      acceptTrustedMember / acceptGuestMember accept path with the
 *      mirrorMemoryOnJoin seam wired) lands the host's graph in the
 *      collaborator's OWN GBrain, scoped `source=<project>@<host>` + author-
 *      tagged, with the import recorded in the SQLite ledger. NOT a stub — the
 *      data transits GBrain's real storage layer, and the join runs through the
 *      real engine.advance-equivalent accept transaction (no SQL-stub past it).
 *   2. **Unit** — pure tag/slug/degradation behavior against fake clients.
 *
 * Per CLAUDE.md anti-placeholder rule: the join tests assert the on-disk
 * artifact (the mirrored page is READ BACK out of the collaborator GBrain), not
 * merely that a seam was called.
 *
 * The gbrain devDependency is imported via a computed specifier so the repo's
 * `bunx tsc --noEmit` gate treats it as `any` (it must NOT pull gbrain's .ts
 * source into the strict type-check program); bun resolves it at runtime.
 */

import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { GBrainUnavailableError } from '@neutronai/gbrain-memory/memory-store.ts'
import type { McpClient } from '@neutronai/gbrain-memory/mcp-client.ts'
import { ConnectedMembersStore } from '../connected-members-store.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import {
  acceptTrustedMember,
  acceptGuestMember,
  type MirrorMemoryOnJoinFn,
} from '../member-join.ts'
import { SharedProjectMirrorStore } from '../shared-project-mirror-store.ts'
import {
  exportProjectGraphSnapshot,
  importGraphSnapshot,
  importSharedProjectMemoryOnJoin,
  InProcessGraphSource,
  formatMirrorSource,
  mirroredSlug,
  tagPageContent,
  OWNER_AUTHOR_ID,
  type GraphSnapshot,
  type SharedProjectGraphSource,
} from '../shared-project-memory-mirror.ts'
import { bootPgliteBrain } from '@neutronai/gbrain-memory/__tests__/boot-pglite-brain.ts'

const RECEIVING = 'owner-host' // the host / owner instance slug

// ─── GBrain brain boot helper (real PGLite engine) ───────────────────────────

interface Brain {
  client: McpClient
  disconnect: () => Promise<void>
}

async function bootBrain(): Promise<Brain> {
  // Serialised + retry-hardened real-PGLite boot (see boot-pglite-brain.ts).
  const { engine: eng, operations } = await bootPgliteBrain()
  const ctx = {
    engine: eng,
    config: { engine: 'pglite' },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  }
  const client: McpClient = {
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const op = operations.find((o) => o.name === name)
      if (op === undefined) throw new Error(`no gbrain op: ${name}`)
      return op.handler(ctx, args)
    },
  }
  return { client, disconnect: () => eng.disconnect() }
}

// ─── SQLite instance DB helper ──────────────────────────────────────────────

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeDb(projectId: string): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-mirror-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  // project_members FK → projects(id); seed the owner's project.
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'workspace', 'personal', ?, ?)`,
    [projectId, 'Owner Project', new Date(0).toISOString(), new Date(0).toISOString()],
  )
  return db
}

function pageContent(client: McpClient, slug: string): Promise<Record<string, unknown> | null> {
  return client.call('get_page', { slug }).then((p) => (p as Record<string, unknown> | null) ?? null)
}

function edgesTo(links: unknown, toSlug: string, predicate: string): unknown[] {
  const rows = Array.isArray(links) ? links : []
  return rows.filter((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    return o['to_slug'] === toSlug && o['link_type'] === predicate
  })
}

// ─── Layer 1: real GBrain PGLite round-trip ─────────────────────────────────

describe('B2 memory mirror — real GBrain round-trip', () => {
  let host: Brain
  let collab: Brain

  beforeAll(async () => {
    host = await bootBrain()
    collab = await bootBrain()
    // Seed the host brain with a small real entity graph: two pages + one edge.
    await host.client.call('put_page', {
      slug: 'ryan',
      content: '---\nkind: person\n---\n\nRyan runs Neutron.\n',
    })
    await host.client.call('put_page', {
      slug: 'neutron',
      content: '---\nkind: project\n---\n\nNeutron is the product.\n',
    })
    await host.client.call('add_link', {
      from: 'ryan',
      to: 'neutron',
      link_type: 'works_at',
      context: 'seed',
    })
  }, 90_000)

  afterAll(async () => {
    if (host !== undefined) await host.disconnect()
    if (collab !== undefined) await collab.disconnect()
  }, 30_000)

  test('exportProjectGraphSnapshot reads the host graph layer (pages + typed edges)', async () => {
    const snap = await exportProjectGraphSnapshot(host.client)
    const slugs = snap.pages.map((p) => p.slug).sort()
    expect(slugs).toEqual(['neutron', 'ryan'])
    const ryan = snap.pages.find((p) => p.slug === 'ryan')!
    expect(ryan.content).toContain('Ryan runs Neutron')
    const edge = snap.edges.find((e) => e.from === 'ryan' && e.to === 'neutron')
    expect(edge?.link_type).toBe('works_at')
  })

  test('trusted collaborator join imports the host graph into the collaborator GBrain, scoped + author-tagged', async () => {
    const PROJECT_ID = 'p-trusted'
    const source = formatMirrorSource(PROJECT_ID, RECEIVING)
    const db = makeDb(PROJECT_ID)
    const store = new ConnectedMembersStore(db)
    const mirrorStore = new SharedProjectMirrorStore(db)

    // The real import-on-join seam: pull the host snapshot, write into the
    // COLLABORATOR's own GBrain. (Host context baked into the closure.)
    let seamFired = false
    const mirror: MirrorMemoryOnJoinFn = async ({ project_id, author }) => {
      seamFired = true
      await importSharedProjectMemoryOnJoin(
        {
          source: new InProcessGraphSource(host.client),
          memory: collab.client,
          store: mirrorStore,
          now: () => 0,
        },
        { projectId: project_id, host: RECEIVING, author },
      )
    }

    const result = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db, mirrorMemoryOnJoin: mirror, now: () => 0 },
    )
    expect(seamFired).toBe(true)
    const localSlug = result.member.local_slug

    // ARTIFACT-ON-DISK: the host's pages are READ BACK out of the collaborator's
    // own GBrain under the mirror partition (not a "seam was called" assertion).
    // GBrain `get_page` splits the body into `compiled_truth` + parsed
    // `frontmatter` (it preserves arbitrary frontmatter keys).
    const ryanPage = await pageContent(collab.client, mirroredSlug(source, 'ryan'))
    expect(ryanPage).not.toBeNull()
    const body = String(ryanPage!['compiled_truth'] ?? '')
    const fm = (ryanPage!['frontmatter'] ?? {}) as Record<string, unknown>
    expect(body).toContain('Ryan runs Neutron') // host fact landed
    expect(fm['source']).toBe(source) // scoped
    expect(fm['author']).toBe(OWNER_AUTHOR_ID) // author-tagged (host owner)

    const neutronPage = await pageContent(collab.client, mirroredSlug(source, 'neutron'))
    expect(neutronPage).not.toBeNull()

    // The typed relation is re-pointed onto the mirrored slugs.
    const links = await collab.client.call('get_links', { slug: mirroredSlug(source, 'ryan') })
    expect(edgesTo(links, mirroredSlug(source, 'neutron'), 'works_at').length).toBe(1)

    // The collaborator's OWN un-namespaced graph is NOT clobbered by the import —
    // if a same-named page exists at all, it is not the mirrored (source-tagged) copy.
    let ownRyan: Record<string, unknown> | null = null
    try {
      ownRyan = await pageContent(collab.client, 'ryan')
    } catch {
      ownRyan = null
    }
    if (ownRyan !== null) {
      expect((ownRyan['frontmatter'] as Record<string, unknown> | undefined)?.['source']).toBeUndefined()
    }

    // Ledger: one-time import recorded, attributed to the join trigger (the
    // collaborator's local_slug), with the page/edge counts.
    const ledger = mirrorStore.get(PROJECT_ID, source)
    expect(ledger).not.toBeNull()
    expect(ledger!.page_count).toBe(2)
    expect(ledger!.edge_count).toBeGreaterThanOrEqual(1)
    expect(ledger!.author_id).toBe(localSlug)
    expect(ledger!.host).toBe(RECEIVING)
  })

  test('read-only collaborator ALSO gets the mirror (read gates posting, not recall)', async () => {
    const PROJECT_ID = 'p-readonly'
    const source = formatMirrorSource(PROJECT_ID, RECEIVING)
    const db = makeDb(PROJECT_ID)
    const store = new ConnectedMembersStore(db)
    const inviteStore = new ConnectGuestInviteStore(db)
    const mirrorStore = new SharedProjectMirrorStore(db)

    // A READ-only invite (access='read').
    const invited = await inviteStore.issue({
      project_id: PROJECT_ID,
      ttl_ms: 60_000,
      now: 1,
      access: 'read',
    })

    const mirror: MirrorMemoryOnJoinFn = async ({ project_id, author }) => {
      await importSharedProjectMemoryOnJoin(
        {
          source: new InProcessGraphSource(host.client),
          memory: collab.client,
          store: mirrorStore,
          now: () => 0,
        },
        { projectId: project_id, host: RECEIVING, author },
      )
    }

    const accepted = await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Reed', guest_handle: 'reed.example' },
      { store, inviteStore, db, mirrorMemoryOnJoin: mirror, now: () => 2 },
    )
    // Sanity: the member really is read-only.
    expect(store.get(accepted.member.local_slug)!.access).toBe('read')

    // …and the mirror still landed in the read-only collaborator's GBrain.
    const ryanPage = await pageContent(collab.client, mirroredSlug(source, 'ryan'))
    expect(ryanPage).not.toBeNull()
    expect(mirrorStore.has(PROJECT_ID, source)).toBe(true)
  })

  test('re-join is idempotent — the one-time import is not duplicated', async () => {
    const PROJECT_ID = 'p-idempotent'
    const source = formatMirrorSource(PROJECT_ID, RECEIVING)
    const db = makeDb(PROJECT_ID)
    const store = new ConnectedMembersStore(db)
    const mirrorStore = new SharedProjectMirrorStore(db)

    let imports = 0
    const countingSource: SharedProjectGraphSource = {
      async fetchSnapshot(projectId) {
        imports++
        return new InProcessGraphSource(host.client).fetchSnapshot(projectId)
      },
    }
    const mirror: MirrorMemoryOnJoinFn = async ({ project_id, author }) => {
      await importSharedProjectMemoryOnJoin(
        { source: countingSource, memory: collab.client, store: mirrorStore, now: () => 0 },
        { projectId: project_id, host: RECEIVING, author },
      )
    }

    const deps = { store, db, mirrorMemoryOnJoin: mirror, now: () => 0 }
    const input = {
      display_name: 'Mona',
      home_instance_slug: 'mona-home',
      home_user_id: 'u-mona',
      project_id: PROJECT_ID,
      receiving_instance_slug: RECEIVING,
    }
    const first = await acceptTrustedMember(input, deps)
    const second = await acceptTrustedMember(input, deps)

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true) // accept idempotency
    // The snapshot was fetched + imported exactly ONCE (ledger gates the second).
    expect(imports).toBe(1)
    expect(mirrorStore.get(PROJECT_ID, source)!.page_count).toBe(2)
  })

  test('best-effort: a THROWING mirror does NOT fail the join (call-site guard, §1.8)', async () => {
    const PROJECT_ID = 'p-besteffort'
    const db = makeDb(PROJECT_ID)
    const store = new ConnectedMembersStore(db)
    const boom: MirrorMemoryOnJoinFn = async () => {
      throw new Error('transport down / gbrain unreachable / scoping missing')
    }

    // Trusted path: the join MUST still succeed + record the member despite the
    // mirror throwing (the mirror is recall convenience, not join-critical).
    const trusted = await acceptTrustedMember(
      {
        display_name: 'Mona',
        home_instance_slug: 'mona-home',
        home_user_id: 'u-mona',
        project_id: PROJECT_ID,
        receiving_instance_slug: RECEIVING,
      },
      { store, db, mirrorMemoryOnJoin: boom, now: () => 0 },
    )
    expect(trusted.member.local_slug).toBeTruthy()
    expect(store.get(trusted.member.local_slug)).not.toBeNull()

    // Guest path: same best-effort guarantee.
    const inviteStore = new ConnectGuestInviteStore(db)
    const invited = await inviteStore.issue({
      project_id: PROJECT_ID,
      ttl_ms: 60_000,
      now: 1,
      access: 'write',
    })
    const guest = await acceptGuestMember(
      { invite_token: invited.token, display_name: 'Reed', guest_handle: 'reed.example' },
      { store, inviteStore, db, mirrorMemoryOnJoin: boom, now: () => 2 },
    )
    expect(guest.member.local_slug).toBeTruthy()
  })
})

// ─── Layer 2b: pagination (>100-page projects must mirror in full) ──────────

/**
 * A pure fake host GBrain whose `list_pages` faithfully mimics the REAL gbrain
 * op (operations.ts): ascending `updated_at` sort, a STRICT `updated_after > v`
 * keyset filter, and `limit` clamped to 100. Seeded with `pageCount` pages where
 * p095..p110 deliberately SHARE one `updated_at` so that 16-page tie group
 * STRADDLES the 100-row first-batch boundary — the exact shape that a naive
 * one-shot (or a strict-keyset-without-hold-back) loop would silently drop.
 */
function makePagedHostFake(pageCount: number): McpClient {
  const baseSec = Math.floor(Date.UTC(2026, 0, 1) / 1000)
  const pages = new Map<string, { content: string; updatedAt: string }>()
  for (let i = 0; i < pageCount; i++) {
    const slug = `p${String(i).padStart(3, '0')}`
    const sec = i >= 95 && i <= 110 ? 95 : i // tie cluster straddling row 100
    pages.set(slug, {
      content: `body for ${slug}`,
      updatedAt: new Date((baseSec + sec) * 1000).toISOString(),
    })
  }
  return {
    async call(name, args) {
      if (name === 'list_pages') {
        const after =
          typeof args['updated_after'] === 'string' ? (args['updated_after'] as string) : undefined
        const limRaw = typeof args['limit'] === 'number' ? (args['limit'] as number) : 50
        const lim = Math.min(limRaw, 100) // gbrain clampSearchLimit(.,50,100)
        return [...pages.entries()]
          .map(([slug, v]) => ({ slug, updated_at: v.updatedAt }))
          .filter((r) => (after === undefined ? true : r.updated_at > after))
          .sort((a, b) =>
            a.updated_at < b.updated_at
              ? -1
              : a.updated_at > b.updated_at
                ? 1
                : a.slug < b.slug
                  ? -1
                  : 1,
          )
          .slice(0, lim)
      }
      if (name === 'get_page') {
        const v = pages.get(String(args['slug']))
        return v !== undefined ? { slug: String(args['slug']), content: v.content } : null
      }
      if (name === 'get_links') return []
      throw new Error(`unexpected op ${name}`)
    },
  }
}

describe('B2 memory mirror — pagination', () => {
  test('exportProjectGraphSnapshot pages through ALL pages past the list_pages 100-cap (no silent truncation)', async () => {
    const TOTAL = 230
    const snap = await exportProjectGraphSnapshot(makePagedHostFake(TOTAL))
    expect(snap.pages.length).toBe(TOTAL)
    const slugs = new Set(snap.pages.map((p) => p.slug))
    expect(slugs.size).toBe(TOTAL) // every page distinct + present
    // The 16-page tie cluster that straddles the 100-row first batch is fully
    // present — a naive strict-`updated_after` keyset (no hold-back) drops it.
    for (let i = 95; i <= 110; i++) {
      expect(slugs.has(`p${String(i).padStart(3, '0')}`)).toBe(true)
    }
  })

  test('the one-time ledger records the TRUE total page count for a >100-page project', async () => {
    const TOTAL = 230
    const PROJECT_ID = 'p-paged'
    const db = makeDb(PROJECT_ID)
    const mirrorStore = new SharedProjectMirrorStore(db)
    const written = new Set<string>()
    const collab: McpClient = {
      async call(name, args) {
        if (name === 'put_page') written.add(String((args as Record<string, unknown>)['slug']))
        return {}
      },
    }
    const res = await importSharedProjectMemoryOnJoin(
      {
        source: new InProcessGraphSource(makePagedHostFake(TOTAL)),
        memory: collab,
        store: mirrorStore,
        now: () => 0,
      },
      { projectId: PROJECT_ID, host: RECEIVING, author: { id: 'mona' } },
    )
    expect(res.page_count).toBe(TOTAL) // import wrote every page
    expect(written.size).toBe(TOTAL) // …into the collaborator GBrain
    const ledger = mirrorStore.get(PROJECT_ID, formatMirrorSource(PROJECT_ID, RECEIVING))
    // The ledger's COMPLETE count is the true total, NOT a truncated 50/100.
    expect(ledger!.page_count).toBe(TOTAL)
  })
})

// ─── Layer 2: unit (tags / slugs / degradation) ─────────────────────────────

describe('B2 memory mirror — unit', () => {
  test('formatMirrorSource + mirroredSlug build a slug-safe namespaced partition', () => {
    const source = formatMirrorSource('p-1', 'owner-host')
    expect(source).toBe('p-1@owner-host')
    const s = mirroredSlug(source, 'ryan')
    expect(s).toBe('mirror-p-1-owner-host-ryan')
    expect(s).toMatch(/^[a-z0-9-]+$/) // no '@' or other unsafe chars
  })

  test('tagPageContent injects source + author into existing frontmatter (no double block)', () => {
    const out = tagPageContent('---\nkind: person\n---\n\nBody.\n', 'p@h', 'owner')
    expect(out).toContain('kind: person')
    expect(out).toContain('source: p@h')
    expect(out).toContain('author: owner')
    expect(out).toContain('Body.')
    // exactly two frontmatter fences (one block), not four.
    expect(out.split('---').length - 1).toBe(2)
  })

  test('tagPageContent wraps a frontmatter block when the body has none', () => {
    const out = tagPageContent('Just a body.', 'p@h', 'owner')
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('source: p@h')
    expect(out).toContain('Just a body.')
  })

  test('importGraphSnapshot preserves a per-fact author when present, else falls back', async () => {
    const writes: Array<{ slug: string; content: string }> = []
    const fake: McpClient = {
      async call(name, args) {
        if (name === 'put_page') writes.push(args as { slug: string; content: string })
        return {}
      },
    }
    const snap: GraphSnapshot = {
      pages: [
        { slug: 'a', content: 'A', author: 'alice' },
        { slug: 'b', content: 'B', author: null },
      ],
      edges: [],
    }
    await importGraphSnapshot(fake, snap, 'p@h', OWNER_AUTHOR_ID)
    expect(writes[0]!.content).toContain('author: alice') // preserved
    expect(writes[1]!.content).toContain('author: owner') // fallback
  })

  test('a missing GBrain binary degrades gracefully — no ledger row, no throw, join survives', async () => {
    const db = makeDb('p-degrade')
    const mirrorStore = new SharedProjectMirrorStore(db)
    const source: SharedProjectGraphSource = {
      async fetchSnapshot() {
        return { pages: [{ slug: 'x', content: 'X' }], edges: [] }
      },
    }
    const deadMemory: McpClient = {
      async call() {
        throw new GBrainUnavailableError('Executable not found in $PATH: gbrain')
      },
    }
    const res = await importSharedProjectMemoryOnJoin(
      { source, memory: deadMemory, store: mirrorStore, now: () => 0 },
      { projectId: 'p-degrade', host: RECEIVING, author: { id: 'mona' } },
    )
    expect(res.reused).toBe(false)
    expect(res.page_count).toBe(0)
    // No ledger row — so a retry once GBrain is present re-imports cleanly.
    expect(mirrorStore.has('p-degrade', formatMirrorSource('p-degrade', RECEIVING))).toBe(false)
  })
})
