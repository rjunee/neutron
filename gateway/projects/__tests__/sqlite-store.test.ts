/**
 * Unit tests for `SqliteProjectSettingsStore` (ISSUES #9).
 *
 * Covers:
 *   - get-or-seed auto-creates a generic default row on first access
 *     (the hardcoded KNOWN_PROJECTS demo seed was removed in R6 —
 *     single-owner Open has no demo data)
 *   - get returns a coherent doc for unknown project_ids (generic
 *     default builder seeds + persists)
 *   - PATCH privacy_mode round-trips through SQLite + bumps
 *     updated_at
 *   - PATCH on an unseeded project_id seeds + applies the patch in
 *     one call (matches the in-memory store's get-then-update flow)
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

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  buildDefaultSettings,
  type ProjectSettings,
} from '../../http/app-projects-surface.ts'
import { SqliteProjectSettingsStore } from '../sqlite-store.ts'

const OWNER = 'sqlite-projects-project'

let tmp: string
let db: ProjectDb
let store: SqliteProjectSettingsStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-projects-store-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new SqliteProjectSettingsStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('SqliteProjectSettingsStore — get + auto-seed', () => {
  test('get auto-seeds a generic default row on first access', async () => {
    const project = await store.get(OWNER, 'neutron')
    expect(project).not.toBeNull()
    expect(project!.id).toBe('neutron')
    // Humanised id — no hardcoded demo seed (R6 removed KNOWN_PROJECTS).
    expect(project!.name).toBe('Neutron')
    expect(project!.persona).toBe('')
    expect(project!.privacy_mode).toBe('private')
    expect(project!.billing_mode).toBe('personal')
    expect(project!.members).toEqual([])
  })

  test('get auto-seeds an unknown project_id with a generic doc', async () => {
    const project = await store.get(OWNER, 'mystery-slug-xyz')
    expect(project).not.toBeNull()
    expect(project!.id).toBe('mystery-slug-xyz')
    expect(project!.privacy_mode).toBe('private')
    expect(project!.billing_mode).toBe('personal')
    expect(project!.members.length).toBe(0)
    // Humanised default name.
    expect(project!.name).toBe('Mystery Slug Xyz')
  })

  test('seeded row survives a second store/db reopen — settings persist', async () => {
    await store.get(OWNER, 'acme')
    db.close()
    db = ProjectDb.open(join(tmp, 'owner.db'))
    const store2 = new SqliteProjectSettingsStore(db)
    const project = await store2.get(OWNER, 'acme')
    expect(project!.name).toBe('Acme')
    expect(project!.members).toEqual([])
  })

  test('concurrent first-access reads on the same project are idempotent', async () => {
    // The store uses INSERT OR IGNORE so two parallel get() calls
    // can't double-seed. Verify the row count stays at 1.
    await Promise.all([
      store.get(OWNER, 'northwind'),
      store.get(OWNER, 'northwind'),
      store.get(OWNER, 'northwind'),
    ])
    const all = await store.list(OWNER)
    const matching = all.filter((p) => p.id === 'northwind')
    expect(matching.length).toBe(1)
  })
})

describe('SqliteProjectSettingsStore — update PATCH', () => {
  test('update flips privacy_mode + bumps updated_at; row persists', async () => {
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

  test('update on an unseeded project_id seeds + applies the patch', async () => {
    const after = await store.update(OWNER, 'fresh-project', {
      privacy_mode: 'public',
    })
    expect(after).not.toBeNull()
    expect(after!.id).toBe('fresh-project')
    expect(after!.privacy_mode).toBe('public')

    // Confirm via list that the row was seeded.
    const all = await store.list(OWNER)
    expect(all.some((p) => p.id === 'fresh-project')).toBe(true)
  })

  test('update with no privacy_mode in patch returns the existing doc unchanged', async () => {
    await store.get(OWNER, 'neutron')
    const result = await store.update(OWNER, 'neutron', {})
    expect(result).not.toBeNull()
    expect(result!.privacy_mode).toBe('private')
  })

  test('update flips agent_engagement_mode independently of privacy_mode; persists', async () => {
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
    await store.get(OWNER, 'neutron')
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
  test('list returns every seeded project (generic default shells)', async () => {
    await store.get(OWNER, 'neutron')
    await store.get(OWNER, 'acme')
    await store.get(OWNER, 'northwind')
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
    // Rail-redesign: ordering is ACTIVITY-based. Seed acme then neutron (so
    // neutron's seed activity is later), then post activity to acme — acme must
    // float to the top. A plain settings edit does NOT count as activity.
    await store.get(OWNER, 'acme')
    await new Promise((r) => setTimeout(r, 5))
    await store.get(OWNER, 'neutron')
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
  test('auto-seeded row carries a deterministic default emoji from the name', async () => {
    // 'read-books' humanises to 'Read Books' → the 📚 keyword pick.
    const project = await store.get(OWNER, 'read-books')
    expect(project!.emoji).toBe('📚')
    // Persisted, not just resolved on read.
    const stored = db
      .prepare<{ emoji: string | null }, [string]>(`SELECT emoji FROM projects WHERE id = ?`)
      .get('read-books')
    expect(stored?.emoji).toBe('📚')
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
    await store.get(OWNER, 'legacy2') // seed
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
    await store.get(OWNER, 'acme') // seed the project row
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
    await store.get(OWNER, 'acme')
    await addAgentMsg('acme', 1)
    const list = await store.list(OWNER)
    expect(list.find((p) => p.id === 'acme')!.unread_count).toBe(0)
  })

  test('list exposes last_activity_at (column value, else updated_at fallback)', async () => {
    await store.get(OWNER, 'acme') // seed stamps last_activity_at = now
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
    await store.get(OWNER, 'neutron') // seed
    await softDelete('neutron')

    const result = await store.get(OWNER, 'neutron')
    expect(result).toBeNull()

    // The row must NOT have been re-seeded / un-deleted by the auto-seed
    // path — it stays archived.
    const stillDeleted = db
      .prepare<{ deleted_at: string | null }, [string]>(
        `SELECT deleted_at FROM projects WHERE id = ?`,
      )
      .get('neutron')
    expect(stillDeleted?.deleted_at).not.toBeNull()
  })

  test('update (PATCH) on a soft-deleted project returns not-found + does NOT mutate it', async () => {
    await store.get(OWNER, 'neutron') // seed (private)
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
    await store.get(OWNER, 'neutron')
    await store.get(OWNER, 'acme')
    await softDelete('acme')

    const all = await store.list(OWNER)
    expect(all.some((p) => p.id === 'neutron')).toBe(true)
    expect(all.some((p) => p.id === 'acme')).toBe(false)
  })

  test('a genuinely-new project_id still auto-seeds (filter does not over-reach)', async () => {
    // Regression guard: the deleted_at filter on readRow must NOT break
    // the auto-seed path for ids that have never existed.
    const fresh = await store.get(OWNER, 'brand-new-id')
    expect(fresh).not.toBeNull()
    expect(fresh!.id).toBe('brand-new-id')
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
    await store.get(OWNER, 'keep')
    await store.get(OWNER, 'gone')
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
    await store.get(OWNER, 'back')
    await store.archive(OWNER, 'back')
    expect((await store.list(OWNER)).length).toBe(0)

    expect(await store.restore(OWNER, 'back')).toBe(true)
    expect((await store.list(OWNER)).map((p) => p.id)).toEqual(['back'])
    expect(await store.listArchived(OWNER)).toEqual([])
    expect(await store.get(OWNER, 'back')).not.toBeNull()
  })

  test('archive/restore are idempotent; unknown id returns false', async () => {
    await store.get(OWNER, 'p1')
    expect(await store.archive(OWNER, 'p1')).toBe(true)
    expect(await store.archive(OWNER, 'p1')).toBe(true) // already archived → ok
    expect(await store.restore(OWNER, 'p1')).toBe(true)
    expect(await store.restore(OWNER, 'p1')).toBe(true) // already active → ok
    // Unknown id → false (nothing to archive/restore).
    expect(await store.archive(OWNER, 'nope')).toBe(false)
    expect(await store.restore(OWNER, 'nope')).toBe(false)
  })

  test('a soft-deleted project can never be archived or restored', async () => {
    await store.get(OWNER, 'del')
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
