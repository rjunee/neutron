/**
 * #451 — the boot scope reconciler's POLICY, against a real migrated database.
 *
 * The companion suite `open/__tests__/open-scope-rekey-boot.test.ts` proves the
 * defect itself through the production composition (a renamed instance stops
 * reading as "still onboarding"). This file pins the three policy decisions
 * that suite cannot isolate:
 *
 *   1. CONFLICT — a row under both keys resolves to the CURRENT-key row, except
 *      in `onboarding_state`, where the more AUTHORITATIVE row survives. Blind
 *      new-wins there would let a post-rename fresh row shadow `completed`,
 *      which is the defect made permanent rather than repaired.
 *   2. SCOPE-KEY SAFETY — `work_board_items` stores `workBoardScopeKey` output,
 *      which is the owner slug for the General board and a raw project id for a
 *      real project. Owner rows must move; project rows must not, and the
 *      exact-match predicate is the only thing that distinguishes them.
 *   3. IDEMPOTENCY — the second reconcile is a single SELECT: no snapshot, no
 *      writes, nothing to undo.
 *
 * Every case runs against a REAL on-disk database with the full migration tree
 * applied (not `:memory:`) so the `VACUUM INTO` snapshot path is exercised the
 * way it runs in production, including its retention prune.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../runner.ts'
import { reconcileInstanceScope, SCOPE_SWEEP_COLUMNS } from '../scope-rekey.ts'

const OLD = 'owner-before'
const NEW = 'owner-after'

let dir: string
let dbPath: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-scope-rekey-'))
  dbPath = join(dir, 'project.db')
  db = new Database(dbPath, { create: true })
  applyMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function snapshots(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('project.db.pre-rekey-'))
}

function seedOnboarding(
  slug: string,
  user_id: string,
  phase: string,
  last_advanced_at: number,
): void {
  db.prepare(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run(slug, user_id, phase, last_advanced_at, last_advanced_at)
}

function onboardingRows(): Array<{ project_slug: string; user_id: string; phase: string }> {
  return db
    .query<{ project_slug: string; user_id: string; phase: string }, []>(
      `SELECT project_slug, user_id, phase FROM onboarding_state
        ORDER BY project_slug, user_id`,
    )
    .all()
}

/**
 * Rows still sitting under the stale key, ACROSS THE WHOLE SWEEP LIST. The
 * per-table assertions below say "the right thing moved"; this says "nothing at
 * all was left behind", which is the property the owner actually experiences.
 */
function rowsRemainingUnder(slug: string): Array<{ table: string; count: number }> {
  const out: Array<{ table: string; count: number }> = []
  for (const { table, column } of SCOPE_SWEEP_COLUMNS) {
    const row = db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(slug)
    if (row !== null && row.n > 0) out.push({ table, count: row.n })
  }
  return out
}

describe('#451 scope reconciler — conflict policy', () => {
  test('current-key row WINS a generic collision; the stale row is discarded', () => {
    // `cron_state` has a composite PK (job_name, project_slug), so the same job
    // can legitimately exist under both keys — exactly the collision shape.
    db.prepare(
      `INSERT INTO cron_state (job_name, project_slug, last_run_status) VALUES (?, ?, ?)`,
    ).run('health-check', OLD, 'stale-loser')
    db.prepare(
      `INSERT INTO cron_state (job_name, project_slug, last_run_status) VALUES (?, ?, ?)`,
    ).run('health-check', NEW, 'live-winner')
    // A job that exists ONLY under the old key must be carried forward.
    db.prepare(
      `INSERT INTO cron_state (job_name, project_slug, last_run_status) VALUES (?, ?, ?)`,
    ).run('vault-backup', OLD, 'carried-forward')
    // Anchor the reconcile on the anchor table.
    seedOnboarding(OLD, 'owner', 'completed', 1_000)

    const result = reconcileInstanceScope(db, NEW, { dbPath })
    expect(result.action).toBe('rekeyed')

    const rows = db
      .query<{ job_name: string; project_slug: string; last_run_status: string }, []>(
        `SELECT job_name, project_slug, last_run_status FROM cron_state ORDER BY job_name`,
      )
      .all()
    expect(rows).toEqual([
      // The live row survived; the stale duplicate did not overwrite it.
      { job_name: 'health-check', project_slug: NEW, last_run_status: 'live-winner' },
      { job_name: 'vault-backup', project_slug: NEW, last_run_status: 'carried-forward' },
    ])

    // And ZERO rows are left under the old key anywhere in the sweep.
    expect(rowsRemainingUnder(OLD)).toEqual([])
  })

  test('onboarding_state EXCEPTION — completed-under-old beats fresh-under-new', () => {
    // The defect, in miniature. After a rename the fail-closed predicate starts
    // onboarding again and writes a fresh non-terminal row under the NEW key.
    // The generic "current wins" rule would keep that one and delete the
    // `completed` row — locking the owner into onboarding permanently, which is
    // the thing being repaired.
    seedOnboarding(OLD, 'owner', 'completed', 1_000)
    seedOnboarding(NEW, 'owner', 'signup', 9_999) // newer, but far less authoritative

    reconcileInstanceScope(db, NEW, { dbPath })

    expect(onboardingRows()).toEqual([{ project_slug: NEW, user_id: 'owner', phase: 'completed' }])
  })

  test('onboarding_state EXCEPTION — ties break on the greater last_advanced_at', () => {
    // Same authority rank on both sides (both mid-flight), so recency decides.
    seedOnboarding(OLD, 'owner', 'signup', 9_000)
    seedOnboarding(NEW, 'owner', 'persona', 1_000)

    reconcileInstanceScope(db, NEW, { dbPath })

    expect(onboardingRows()).toEqual([{ project_slug: NEW, user_id: 'owner', phase: 'signup' }])
  })

  test('onboarding_state EXCEPTION — completed under the CURRENT key is not displaced', () => {
    // The mirror case: the authoritative row is already where it belongs and a
    // stale non-terminal leftover must not clobber it.
    seedOnboarding(OLD, 'owner', 'signup', 9_999)
    seedOnboarding(NEW, 'owner', 'completed', 1_000)

    reconcileInstanceScope(db, NEW, { dbPath })

    expect(onboardingRows()).toEqual([{ project_slug: NEW, user_id: 'owner', phase: 'completed' }])
  })
})

describe('#451 scope reconciler — scope-key table safety', () => {
  test('work_board OWNER rows move; raw project-id rows are untouched', () => {
    // `work_board_items.project_slug` holds `workBoardScopeKey` output: the
    // owner slug for the General board, the raw project id for a real project.
    // Only exact-match on the stale owner slug distinguishes them.
    const insert = db.prepare(
      `INSERT INTO work_board_items
         (id, project_slug, title, status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 'upcoming', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    insert.run('wb-general', OLD, 'general board item', 1)
    insert.run('wb-acme', 'acme', 'project board item', 2)
    // A project whose id happens to equal the NEW slug must also be left alone.
    insert.run('wb-lookalike', 'unrelated-project', 'sibling project item', 3)
    seedOnboarding(OLD, 'owner', 'completed', 1_000)

    reconcileInstanceScope(db, NEW, { dbPath })

    const rows = db
      .query<{ id: string; project_slug: string }, []>(
        `SELECT id, project_slug FROM work_board_items ORDER BY id`,
      )
      .all()
    expect(rows).toEqual([
      { id: 'wb-acme', project_slug: 'acme' },
      { id: 'wb-general', project_slug: NEW },
      { id: 'wb-lookalike', project_slug: 'unrelated-project' },
    ])
  })

  test('columns naming ANOTHER instance are never rewritten', () => {
    // `connected_members.home_instance_slug` is a FOREIGN key in the plain-English
    // sense: it names the instance a connected member belongs to. If a member's
    // home instance happens to share our old slug, rewriting it would silently
    // re-address that person's home to us.
    db.prepare(
      `INSERT INTO connected_members
         (local_slug, display_name, role, home_instance_slug, access, status)
       VALUES (?, ?, 'collaborator', ?, 'write', 'active')`,
    ).run('mona', 'Mona', OLD)
    seedOnboarding(OLD, 'owner', 'completed', 1_000)

    reconcileInstanceScope(db, NEW, { dbPath })

    const row = db
      .query<{ home_instance_slug: string }, []>(
        `SELECT home_instance_slug FROM connected_members WHERE local_slug = 'mona'`,
      )
      .get()
    expect(row?.home_instance_slug).toBe(OLD)
  })
})

describe('#451 scope reconciler — ledger + idempotency', () => {
  test('a never-renamed install seeds the ledger and moves nothing', () => {
    seedOnboarding(NEW, 'owner', 'completed', 1_000)

    const result = reconcileInstanceScope(db, NEW, { dbPath })

    expect(result.action).toBe('seeded')
    expect(result.rekeys).toEqual([])
    expect(result.moved_total).toBe(0)
    // Nothing moved ⇒ nothing to preserve ⇒ no snapshot cost on a normal box.
    expect(snapshots()).toEqual([])
    expect(result.snapshot_path).toBeNull()
  })

  test('the SECOND reconcile does nothing — no snapshot, no writes, zero counts', () => {
    seedOnboarding(OLD, 'owner', 'completed', 1_000)
    db.prepare(`INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, ?)`).run(
      OLD,
      'America/Los_Angeles',
    )

    const first = reconcileInstanceScope(db, NEW, { dbPath })
    expect(first.action).toBe('rekeyed')
    expect(first.moved_total).toBeGreaterThan(0)
    expect(snapshots().length).toBe(1)

    const second = reconcileInstanceScope(db, NEW, { dbPath })
    expect(second.action).toBe('noop')
    expect(second.rekeys).toEqual([])
    expect(second.moved_total).toBe(0)
    expect(second.dropped_total).toBe(0)
    // The idempotency claim in bytes: a no-op run leaves no new snapshot behind.
    expect(snapshots().length).toBe(1)

    // A third, for the "restart loop doesn't grind the disk" case.
    expect(reconcileInstanceScope(db, NEW, { dbPath }).action).toBe('noop')
    expect(snapshots().length).toBe(1)

    // The instance's own metadata row followed the rename.
    const meta = db
      .query<{ instance_slug: string; timezone: string }, []>(
        `SELECT instance_slug, timezone FROM instance_metadata`,
      )
      .all()
    expect(meta).toEqual([{ instance_slug: NEW, timezone: 'America/Los_Angeles' }])
  })

  test('a pre-re-key snapshot is taken and retention keeps the newest two', () => {
    // Three successive renames ⇒ three snapshots taken, two retained.
    seedOnboarding('slug-a', 'owner', 'completed', 1_000)
    let now = 1_000_000
    const clock = (): number => now
    reconcileInstanceScope(db, 'slug-b', { dbPath, now: clock })
    now += 1_000
    reconcileInstanceScope(db, 'slug-c', { dbPath, now: clock })
    now += 1_000
    const third = reconcileInstanceScope(db, 'slug-d', { dbPath, now: clock })

    expect(third.action).toBe('rekeyed')
    expect(snapshots().sort()).toEqual([
      'project.db.pre-rekey-1001000',
      'project.db.pre-rekey-1002000',
    ])
    // The snapshot is a real, readable database — the point of taking one.
    const snap = new Database(join(dir, 'project.db.pre-rekey-1002000'), { readonly: true })
    try {
      const row = snap
        .query<{ project_slug: string }, []>(`SELECT project_slug FROM onboarding_state`)
        .get()
      // Taken BEFORE the third re-key, so it holds the pre-repair key.
      expect(row?.project_slug).toBe('slug-c')
    } finally {
      snap.close()
    }

    expect(onboardingRows()).toEqual([
      { project_slug: 'slug-d', user_id: 'owner', phase: 'completed' },
    ])
  })

  test('a ledger that disagrees drives the re-key even with no anchor row', () => {
    // The steady-state rename path: the ledger, not a scan, is the authority.
    db.prepare(`INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, ?)`)
      .run(OLD, 1)
    db.prepare(`INSERT INTO tasks (id, project_slug, title, created_at, updated_at)
                VALUES (?, ?, ?, '2026-01-01', '2026-01-01')`).run('t1', OLD, 'stranded task')

    const result = reconcileInstanceScope(db, NEW, { dbPath })

    expect(result.action).toBe('rekeyed')
    expect(result.rekeys.map((r) => r.from)).toEqual([OLD])
    const task = db
      .query<{ project_slug: string }, []>(`SELECT project_slug FROM tasks WHERE id = 't1'`)
      .get()
    expect(task?.project_slug).toBe(NEW)
  })
})
