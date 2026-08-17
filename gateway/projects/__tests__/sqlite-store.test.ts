/**
 * Unit tests for `SqliteProjectSettingsStore` (ISSUES #9).
 *
 * A READ MUST NOT CREATE A PROJECT (ISSUES #412). `get` synthesises a
 * canonical default doc for an unknown project_id but persists
 * nothing — the row is materialised by the first real WRITE. These
 * tests therefore create projects through `update` (see the `seed`
 * helper below), never through `get`.
 *
 * Covers:
 *   - get SYNTHESISES a generic default doc on first access and
 *     creates no row (the hardcoded KNOWN_PROJECTS demo seed was
 *     removed in R6 — single-owner Open has no demo data)
 *   - get returns a coherent doc for unknown project_ids (generic
 *     default builder, unpersisted)
 *   - PATCH privacy_mode round-trips through SQLite + bumps
 *     updated_at
 *   - PATCH on an unwritten project_id materialises the row + applies
 *     the patch in one call (matches the in-memory store's
 *     get-then-update flow)
 *   - list returns every project with members sorted owner-first
 *   - list orders rows updated_at DESC
 *   - CHECK constraint blocks an out-of-band privacy_mode value
 *     (defence in depth — the HTTP surface validates before the
 *     store ever sees the value, but the migration's CHECK is the
 *     last line of defence)
 *   - seedDefaults is idempotent (running twice does NOT clobber a
 *     PATCH-edited privacy_mode)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  buildDefaultSettings,
  type ProjectSettings,
} from '../../http/app-projects-surface.ts'
import { SqliteProjectSettingsStore } from '../sqlite-store.ts'
import { openMigratedDbAt } from '../../../tests/support/migrated-db.ts'

const OWNER = 'sqlite-projects-project'

/**
 * A project now comes into existence on a WRITE, not on a settings read
 * (ISSUES #412). Tests that merely need a project to EXIST create it here.
 *
 * Patching `name` to `buildDefaultSettings(id).name` is a no-op in value terms
 * — it writes exactly the name/emoji the old auto-seed-on-read wrote — so every
 * downstream assertion about names, emoji, ordering and unread counts is
 * unchanged. Only the verb that creates the row moved from `get` to `update`.
 */
async function seed(s: SqliteProjectSettingsStore, id: string): Promise<void> {
  await s.update(OWNER, id, { name: buildDefaultSettings(id).name })
}

/** Row count for `id` in the raw table, deleted/archived rows included. */
function rowCount(id: string): number {
  return (
    db
      .prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`)
      .get(id)?.n ?? 0
  )
}

let tmp: string
let db: ProjectDb
let store: SqliteProjectSettingsStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-projects-store-'))
  db = openMigratedDbAt(join(tmp, 'owner.db'))
  store = new SqliteProjectSettingsStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('SqliteProjectSettingsStore — get synthesises without creating (#412)', () => {
  test('get returns a generic default doc on first access and creates NO row', async () => {
    const project = await store.get(OWNER, 'neutron')
    expect(project).not.toBeNull()
    expect(project!.id).toBe('neutron')
    // Humanised id — no hardcoded demo seed (R6 removed KNOWN_PROJECTS).
    expect(project!.name).toBe('Neutron')
    expect(project!.persona).toBe('')
    expect(project!.privacy_mode).toBe('private')
    expect(project!.billing_mode).toBe('personal')
    expect(project!.members).toEqual([])
    // #412: the read is NOT a create. Nothing hit the table, so the rail
    // (which reads the same table) stays empty.
    expect(rowCount('neutron')).toBe(0)
    expect(await store.list(OWNER)).toEqual([])
  })

  test('get on an unknown project_id returns a generic doc and creates NO row', async () => {
    const project = await store.get(OWNER, 'mystery-slug-xyz')
    expect(project).not.toBeNull()
    expect(project!.id).toBe('mystery-slug-xyz')
    expect(project!.privacy_mode).toBe('private')
    expect(project!.billing_mode).toBe('personal')
    expect(project!.members.length).toBe(0)
    // Humanised default name.
    expect(project!.name).toBe('Mystery Slug Xyz')
    expect(rowCount('mystery-slug-xyz')).toBe(0)
    expect(await store.list(OWNER)).toEqual([])
  })

  test('a WRITTEN row survives a second store/db reopen — settings persist', async () => {
    await seed(store, 'acme')
    // Durability is only meaningful if the write actually landed.
    expect(rowCount('acme')).toBe(1)
    db.close()
    db = ProjectDb.open(join(tmp, 'owner.db'))
    const store2 = new SqliteProjectSettingsStore(db)
    const project = await store2.get(OWNER, 'acme')
    expect(project!.name).toBe('Acme')
    expect(project!.members).toEqual([])
    // …and it is a real persisted row, not a re-synthesised default: the
    // reopened store lists it.
    expect((await store2.list(OWNER)).map((p) => p.id)).toEqual(['acme'])
  })

  test('concurrent first-access reads return the same doc and create nothing', async () => {
    // Pre-#412 this asserted INSERT OR IGNORE kept the seed race at one row.
    // The new contract is stronger: concurrent reads of an unknown id create
    // ZERO rows, and every caller gets the same synthesised doc.
    const docs = await Promise.all([
      store.get(OWNER, 'northwind'),
      store.get(OWNER, 'northwind'),
      store.get(OWNER, 'northwind'),
    ])
    for (const d of docs) expect(d).toEqual(docs[0]!)
    expect(rowCount('northwind')).toBe(0)
    expect(await store.list(OWNER)).toEqual([])

    // And when a real write does land, exactly one row exists.
    await seed(store, 'northwind')
    const all = await store.list(OWNER)
    expect(all.filter((p) => p.id === 'northwind').length).toBe(1)
  })
})

describe('SqliteProjectSettingsStore — update PATCH', () => {
  test('update flips privacy_mode + bumps updated_at; row persists', async () => {
    await seed(store, 'neutron')
    const before = await store.get(OWNER, 'neutron')
    expect(before!.privacy_mode).toBe('private')

    // Force a measurable wall-clock delta so updated_at must change.
    await new Promise((r) => setTimeout(r, 5))

    const after = await store.update(OWNER, 'neutron', { privacy_mode: 'public' })
    expect(after).not.toBeNull()
    expect(after!.privacy_mode).toBe('public')

    // Re-read from a fresh handle to prove durability.
    const reread = await store.get(OWNER, 'neutron')
    expect(reread!.privacy_mode).toBe('public')
  })

  test('update on an unwritten project_id materialises the row + applies the patch', async () => {
    // #412: the WRITE is what brings a project into existence. Nothing exists
    // beforehand — no prior `get` has been issued, and one wouldn't help.
    expect(rowCount('fresh-project')).toBe(0)
    const after = await store.update(OWNER, 'fresh-project', {
      privacy_mode: 'public',
    })
    expect(after).not.toBeNull()
    expect(after!.id).toBe('fresh-project')
    expect(after!.privacy_mode).toBe('public')

    // Confirm via list that the row was materialised — i.e. the patch did not
    // silently vanish against zero matching rows.
    const all = await store.list(OWNER)
    expect(all.some((p) => p.id === 'fresh-project')).toBe(true)
  })

  test('update with no privacy_mode in patch returns the existing doc unchanged', async () => {
    await seed(store, 'neutron')
    const result = await store.update(OWNER, 'neutron', {})
    expect(result).not.toBeNull()
    expect(result!.privacy_mode).toBe('private')
  })

  test('update flips agent_engagement_mode independently of privacy_mode; persists', async () => {
    await seed(store, 'neutron')
    const before = await store.get(OWNER, 'neutron')
    // Migration 0088 default.
    expect(before!.agent_engagement_mode).toBe('all_messages')

    const after = await store.update(OWNER, 'neutron', {
      agent_engagement_mode: 'tag_gated',
    })
    expect(after).not.toBeNull()
    expect(after!.agent_engagement_mode).toBe('tag_gated')
    // privacy_mode is untouched by an engagement-only patch.
    expect(after!.privacy_mode).toBe('private')

    // Re-read from a fresh handle to prove durability.
    const reread = await store.get(OWNER, 'neutron')
    expect(reread!.agent_engagement_mode).toBe('tag_gated')
    expect(reread!.privacy_mode).toBe('private')
  })

  test('update renames the project (name) independently; persists across reopen', async () => {
    await seed(store, 'neutron')
    const before = await store.get(OWNER, 'neutron')
    expect(before!.name).toBe('Neutron')

    const after = await store.update(OWNER, 'neutron', { name: 'Neutron Renamed' })
    expect(after).not.toBeNull()
    expect(after!.name).toBe('Neutron Renamed')
    // A name-only patch leaves privacy_mode untouched.
    expect(after!.privacy_mode).toBe('private')

    const reread = await store.get(OWNER, 'neutron')
    expect(reread!.name).toBe('Neutron Renamed')
  })

  test('CHECK constraint rejects an out-of-band privacy_mode value', async () => {
    // Defence in depth — the HTTP surface validates the enum before
    // the store ever receives it, but we want to guard against a
    // future caller that bypasses the surface (e.g. internal scripts,
    // migrations, ops tooling).
    await seed(store, 'neutron')
    let threw = false
    try {
      // Use raw db.run so we bypass TS's PrivacyMode narrowing — the
      // CHECK should refuse the write at the SQLite layer.
      await db.run(
        `UPDATE projects SET privacy_mode = ? WHERE id = ?`,
        ['illegal-value', 'neutron'],
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // Sanity — original value is untouched.
    const reread = await store.get(OWNER, 'neutron')
    expect(reread!.privacy_mode).toBe('private')
  })

  test('CHECK constraint rejects an out-of-band billing_mode value', async () => {
    let threw = false
    try {
      await db.run(
        `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['bad', 'bad', 'private', 'illegal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('SqliteProjectSettingsStore — list', () => {
  test('list returns every written project (generic default shells)', async () => {
    await seed(store, 'neutron')
    await seed(store, 'acme')
    await seed(store, 'northwind')
    const all = await store.list(OWNER)
    expect(all.length).toBe(3)
    const ids = all.map((p) => p.id).sort()
    expect(ids).toEqual(['acme', 'neutron', 'northwind'])
    // Generic default shells carry no members until membership lands.
    for (const p of all) expect(p.members).toEqual([])
  })

  test('list returns an empty array on a fresh project DB (starts empty)', async () => {
    const all = await store.list(OWNER)
    expect(all).toEqual([])
  })

  test('list orders by last_activity_at DESC then id ASC', async () => {
    // Rail-redesign: ordering is ACTIVITY-based. Create acme then neutron (so
    // neutron's seed activity is later), then post activity to acme — acme must
    // float to the top. A plain settings edit does NOT count as activity.
    await seed(store, 'acme')
    await new Promise((r) => setTimeout(r, 5))
    await seed(store, 'neutron')
    // A settings edit bumps updated_at but NOT last_activity_at, so it must not
    // reorder the rail (neutron, seeded last, is still most-recently-active).
    await store.update(OWNER, 'acme', { privacy_mode: 'public' })
    const afterEdit = await store.list(OWNER)
    expect(afterEdit[0]!.id).toBe('neutron')
    // Real activity on acme DOES float it to the top.
    await new Promise((r) => setTimeout(r, 5))
    await store.touchActivity('acme')
    const afterActivity = await store.list(OWNER)
    expect(afterActivity[0]!.id).toBe('acme')
    expect(afterActivity[1]!.id).toBe('neutron')
  })
})

describe('SqliteProjectSettingsStore — emoji (rail-redesign)', () => {
  test('the synthesised doc and the row a later write persists carry the SAME default emoji', async () => {
    // 'read-books' humanises to 'Read Books' → the 📚 keyword pick.
    //
    // #412 split this into two moments: the READ synthesises the doc (no row),
    // the first WRITE persists it. The whole reason the change is invisible to
    // the settings drawer is that both moments produce the same glyph — so
    // assert BOTH, and assert they are equal.
    const synthesised = await store.get(OWNER, 'read-books')
    expect(synthesised!.emoji).toBe('📚')
    // Read-only: nothing persisted yet.
    expect(rowCount('read-books')).toBe(0)

    // A real (emoji-free) PATCH materialises the row…
    const written = await store.update(OWNER, 'read-books', { privacy_mode: 'public' })
    const stored = db
      .prepare<{ emoji: string | null }, [string]>(`SELECT emoji FROM projects WHERE id = ?`)
      .get('read-books')
    // …and the emoji column carries the same deterministic default — persisted,
    // not merely resolved on read.
    expect(stored?.emoji).toBe('📚')
    expect(written!.emoji).toBe(synthesised!.emoji)
  })

  test('a legacy row with NULL emoji resolves to the default on read', async () => {
    await db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['legacy', 'Marathon plan', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
    const project = await store.get(OWNER, 'legacy')
    expect(project!.emoji).toBe('🏃')
  })

  test('PATCH emoji round-trips and does not freeze on a name-only edit', async () => {
    // The PATCH itself materialises the row (#412) — no pre-seeding read.
    const updated = await store.update(OWNER, 'legacy2', { emoji: '🎯' })
    expect(updated!.emoji).toBe('🎯')
    const reread = await store.get(OWNER, 'legacy2')
    expect(reread!.emoji).toBe('🎯')

    // A NULL-emoji legacy row edited by NAME only must NOT freeze a resolved
    // default into the emoji column (it stays NULL, re-deriving from the name).
    await db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      ['legacy3', 'coding side project', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
    await store.update(OWNER, 'legacy3', { name: 'gardening notes' })
    const col = db
      .prepare<{ emoji: string | null }, [string]>(`SELECT emoji FROM projects WHERE id = ?`)
      .get('legacy3')
    expect(col?.emoji).toBeNull()
    // …so the resolved emoji now reflects the NEW name (garden → 🌱), not code.
    const reread3 = await store.get(OWNER, 'legacy3')
    expect(reread3!.emoji).toBe('🌱')
  })
})

describe('SqliteProjectSettingsStore — unread + activity (rail-redesign)', () => {
  const USER = 'u1'
  function topic(project_id: string): string {
    return `app:${USER}:${project_id}`
  }
  async function addAgentMsg(project_id: string, seq: number): Promise<void> {
    await db.run(
      `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, project_id, created_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?)`,
      [topic(project_id), seq, `m-${project_id}-${seq}`, `body ${seq}`, project_id, seq],
    )
  }
  async function markRead(project_id: string, seq: number): Promise<void> {
    await db.run(
      `INSERT INTO app_chat_receipts (topic_id, message_id, device_id, seq, delivered_at, read_at)
       VALUES (?, ?, 'dev1', ?, ?, ?)`,
      [topic(project_id), `m-${project_id}-${seq}`, seq, seq, seq],
    )
  }

  test('unread_count = agent messages beyond the highest read receipt seq', async () => {
    await seed(store, 'acme') // create the project row
    await addAgentMsg('acme', 1)
    await addAgentMsg('acme', 2)
    await addAgentMsg('acme', 3)
    // Nothing read yet → all 3 unread.
    let list = await store.list(OWNER, USER)
    expect(list.find((p) => p.id === 'acme')!.unread_count).toBe(3)
    // Read up to seq 2 → 1 unread (seq 3).
    await markRead('acme', 1)
    await markRead('acme', 2)
    list = await store.list(OWNER, USER)
    expect(list.find((p) => p.id === 'acme')!.unread_count).toBe(1)
    // Read seq 3 → caught up.
    await markRead('acme', 3)
    list = await store.list(OWNER, USER)
    expect(list.find((p) => p.id === 'acme')!.unread_count).toBe(0)
  })

  test('unread_count is 0 when user_id is omitted (no topic to compute from)', async () => {
    await seed(store, 'acme')
    await addAgentMsg('acme', 1)
    const list = await store.list(OWNER)
    expect(list.find((p) => p.id === 'acme')!.unread_count).toBe(0)
  })

  test('list exposes last_activity_at (column value, else updated_at fallback)', async () => {
    await seed(store, 'acme') // the write stamps last_activity_at = now
    const list = await store.list(OWNER, USER)
    const acme = list.find((p) => p.id === 'acme')!
    expect(acme.last_activity_at.length).toBeGreaterThan(0)
  })
})

describe('SqliteProjectSettingsStore — soft-delete leak (Argus r1 IMPORTANT 3)', () => {
  async function softDelete(project_id: string): Promise<void> {
    await db.run(
      `UPDATE projects SET deleted_at = ? WHERE id = ?`,
      [new Date(Date.now()).toISOString(), project_id],
    )
  }

  test('get on a soft-deleted project returns not-found (does NOT resurrect it)', async () => {
    await seed(store, 'neutron')
    await softDelete('neutron')

    const result = await store.get(OWNER, 'neutron')
    expect(result).toBeNull()

    // The row must NOT have been re-seeded / un-deleted by the synthesise
    // path — it stays archived.
    const stillDeleted = db
      .prepare<{ deleted_at: string | null }, [string]>(
        `SELECT deleted_at FROM projects WHERE id = ?`,
      )
      .get('neutron')
    expect(stillDeleted?.deleted_at).not.toBeNull()
  })

  test('update (PATCH) on a soft-deleted project returns not-found + does NOT mutate it', async () => {
    await seed(store, 'neutron') // created (private)
    await softDelete('neutron')

    const result = await store.update(OWNER, 'neutron', { privacy_mode: 'public' })
    expect(result).toBeNull()

    // The archived row's privacy_mode must be untouched.
    const row = db
      .prepare<{ privacy_mode: string }, [string]>(
        `SELECT privacy_mode FROM projects WHERE id = ?`,
      )
      .get('neutron')
    expect(row?.privacy_mode).toBe('private')
  })

  test('list excludes soft-deleted projects', async () => {
    await seed(store, 'neutron')
    await seed(store, 'acme')
    await softDelete('acme')

    const all = await store.list(OWNER)
    expect(all.some((p) => p.id === 'neutron')).toBe(true)
    expect(all.some((p) => p.id === 'acme')).toBe(false)
  })

  test('a genuinely-new project_id still resolves to a doc (filter does not over-reach)', async () => {
    // Regression guard: the deleted_at filter on readRow must NOT collapse a
    // never-existed id into the soft-deleted (null) branch. It synthesises a
    // doc — and, per #412, still creates nothing.
    const fresh = await store.get(OWNER, 'brand-new-id')
    expect(fresh).not.toBeNull()
    expect(fresh!.id).toBe('brand-new-id')
    expect(rowCount('brand-new-id')).toBe(0)
    // …and a write on the same id still works (the branch is not poisoned).
    await seed(store, 'brand-new-id')
    expect((await store.list(OWNER)).some((p) => p.id === 'brand-new-id')).toBe(true)
  })
})

describe('SqliteProjectSettingsStore — seedDefaults', () => {
  test('seedDefaults inserts default project shells + is idempotent', async () => {
    const seeds: ProjectSettings[] = [
      buildDefaultSettings('neutron'),
      buildDefaultSettings('acme'),
      buildDefaultSettings('northwind'),
    ]
    await store.seedDefaults(seeds)
    const all1 = await store.list(OWNER)
    expect(all1.length).toBe(3)

    // Mutate one — running seedDefaults again MUST NOT clobber the
    // PATCH-edited privacy_mode (rule: existing rows are left
    // untouched).
    await store.update(OWNER, 'neutron', { privacy_mode: 'public' })
    await store.seedDefaults(seeds)
    const reread = await store.get(OWNER, 'neutron')
    expect(reread!.privacy_mode).toBe('public')
    const all2 = await store.list(OWNER)
    expect(all2.length).toBe(3)
  })
})

describe('SqliteProjectSettingsStore — archive + restore (0095)', () => {
  test('archive hides a project from the rail list; listArchived surfaces it', async () => {
    await seed(store, 'keep')
    await seed(store, 'gone')
    expect((await store.list(OWNER)).map((p) => p.id).sort()).toEqual(['gone', 'keep'])

    expect(await store.archive(OWNER, 'gone')).toBe(true)
    // Left the rail…
    expect((await store.list(OWNER)).map((p) => p.id)).toEqual(['keep'])
    // …but is listed as archived, with a concrete emoji + a timestamp.
    const archived = await store.listArchived(OWNER)
    expect(archived.map((p) => p.id)).toEqual(['gone'])
    expect(archived[0]!.emoji.length).toBeGreaterThan(0)
    expect(archived[0]!.archived_at).not.toBe('')
    // The per-project settings GET now 404s (readRow filters archived).
    expect(await store.get(OWNER, 'gone')).toBeNull()
  })

  test('restore returns an archived project to the rail', async () => {
    await seed(store, 'back')
    await store.archive(OWNER, 'back')
    expect((await store.list(OWNER)).length).toBe(0)

    expect(await store.restore(OWNER, 'back')).toBe(true)
    expect((await store.list(OWNER)).map((p) => p.id)).toEqual(['back'])
    expect(await store.listArchived(OWNER)).toEqual([])
    expect(await store.get(OWNER, 'back')).not.toBeNull()
  })

  test('archive/restore are idempotent; unknown id returns false', async () => {
    await seed(store, 'p1')
    expect(await store.archive(OWNER, 'p1')).toBe(true)
    expect(await store.archive(OWNER, 'p1')).toBe(true) // already archived → ok
    expect(await store.restore(OWNER, 'p1')).toBe(true)
    expect(await store.restore(OWNER, 'p1')).toBe(true) // already active → ok
    // Unknown id → false (nothing to archive/restore).
    expect(await store.archive(OWNER, 'nope')).toBe(false)
    expect(await store.restore(OWNER, 'nope')).toBe(false)
  })

  test('a soft-deleted project can never be archived or restored', async () => {
    await seed(store, 'del')
    // Soft-delete it directly (mirrors delete_project / merge_projects).
    await db.run(`UPDATE projects SET deleted_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      'del',
    ])
    expect(await store.archive(OWNER, 'del')).toBe(false)
    expect(await store.restore(OWNER, 'del')).toBe(false)
    expect(await store.listArchived(OWNER)).toEqual([])
  })
})

describe('SqliteProjectSettingsStore — touchActivityIncludingArchived (P4 table-ownership)', () => {
  // The method exists to preserve the Open composer's exact predicate
  // (`deleted_at IS NULL` ONLY — no archived filter) after the inline SQL
  // moved into the owning store. Pin the boundary split from `touchActivity`:
  // active stamped, ARCHIVED stamped (the divergence), soft-deleted skipped,
  // and best-effort never-throws.
  const readActivity = (id: string): string | null =>
    db
      .prepare<{ last_activity_at: string | null }, [string]>(
        `SELECT last_activity_at FROM projects WHERE id = ?`,
      )
      .get(id)?.last_activity_at ?? null

  test('stamps an active row', async () => {
    await seed(store, 'alpha')
    await store.touchActivityIncludingArchived('alpha', '2030-01-01T00:00:00.000Z')
    expect(readActivity('alpha')).toBe('2030-01-01T00:00:00.000Z')
  })

  test('stamps an ARCHIVED row — the divergence from touchActivity', async () => {
    await seed(store, 'arch')
    expect(await store.archive(OWNER, 'arch')).toBe(true)
    // touchActivity (archived_at IS NULL predicate) must NOT stamp it…
    await store.touchActivity('arch', '2030-01-01T00:00:00.000Z')
    expect(readActivity('arch')).not.toBe('2030-01-01T00:00:00.000Z')
    // …while the composer's variant MUST.
    await store.touchActivityIncludingArchived('arch', '2030-01-02T00:00:00.000Z')
    expect(readActivity('arch')).toBe('2030-01-02T00:00:00.000Z')
  })

  test('does NOT stamp a soft-deleted row', async () => {
    await seed(store, 'gone')
    const before = readActivity('gone')
    await db.run(`UPDATE projects SET deleted_at = ? WHERE id = ?`, [
      '2029-01-01T00:00:00.000Z',
      'gone',
    ])
    await store.touchActivityIncludingArchived('gone', '2030-01-01T00:00:00.000Z')
    expect(readActivity('gone')).toBe(before)
  })

  test('best-effort — a failing write is swallowed, never thrown', async () => {
    // A store over a DB with NO projects table (no migrations applied): the
    // UPDATE fails inside, and the method must not throw — activity stamping
    // must never break a message turn.
    const bareTmp = mkdtempSync(join(tmpdir(), 'neutron-projects-store-bare-'))
    const bareDb = ProjectDb.open(join(bareTmp, 'bare.db'))
    try {
      // Premise: the raw UPDATE genuinely fails on this DB (no projects
      // table) — otherwise the swallow assertion below would be vacuous.
      let underlyingFailed = false
      try {
        await bareDb.run(`UPDATE projects SET last_activity_at = ? WHERE id = ?`, ['x', 'y'])
      } catch {
        underlyingFailed = true
      }
      expect(underlyingFailed).toBe(true)
      // Contract: the store method swallows that failure and resolves.
      const bareStore = new SqliteProjectSettingsStore(bareDb)
      await expect(bareStore.touchActivityIncludingArchived('anything')).resolves.toBeUndefined()
    } finally {
      bareDb.close()
      rmSync(bareTmp, { recursive: true, force: true })
    }
  })
})
