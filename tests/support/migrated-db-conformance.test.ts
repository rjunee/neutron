/**
 * tests/support/migrated-db-conformance.test.ts — proof that a SEEDED database
 * and a REPLAYED database are the same database.
 *
 * `seedMigratedDb` (tests/support/migrated-db.ts) replaces hundreds of
 * per-test `applyMigrations` replays with a byte copy of a template the real
 * runner built once. The argument that this is safe is structural — a copy of
 * the runner's own output cannot contain re-implemented migration logic — but
 * "structurally safe" is exactly the kind of claim that rots quietly, so it is
 * DIFFED here rather than asserted.
 *
 * Build A with the real `applyMigrations` over the full tree, B with
 * `seedMigratedDb`, then compare on five axes:
 *
 *   1. SCHEMA, byte-identical, through the SAME serializer the snapshot test
 *      pins (`migrations/schema-serialize.ts`).
 *   2. `PRAGMA journal_mode` — WAL is set by a migration preamble and persists
 *      in the file header, so a copy that lost it would be a different database
 *      under concurrency.
 *   3. EVERY user table's full contents, ordered, minus an exhaustive allowlist
 *      of wall-clock columns — currently exactly one, `_migrations.applied_at`.
 *      This is the arm that covers the ledger itself: `version`, `name`,
 *      `content_sha256`, `applied_by_commit` and `tree_provenance` are all
 *      diffed. Two REAL replays already differ on `applied_at`, so this is the
 *      strongest equality that exists between two independently built
 *      databases. A future migration that seeds time-dependent or random data
 *      breaks this loudly; the resolution is a deliberate allowlist entry, not
 *      a loosened comparison.
 *   4. THE REAL RUNNER CERTIFIES THE SEED. Run `applyMigrations` on the seeded
 *      database and it must report `applied = []` with the whole tree
 *      `skipped` — the real classifier, not ours, deciding that this database
 *      is fully migrated, and engaging none of its refusals on the way.
 *   5. `PRAGMA integrity_check` = ok and `PRAGMA foreign_key_check` = empty.
 *
 * MUTATION-TESTED BOTH WAYS (a control that cannot fail is decoration): an
 * extra `_migrations` row must break arm 3, and an extra table must break arm
 * 1. Both are exercised below against a deliberately corrupted copy, so the
 * diff's ability to FAIL is itself part of the suite.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { serializeSchema } from '@neutronai/migrations/schema-serialize.ts'
import { seedMigratedDb } from './migrated-db.ts'

/**
 * Columns whose value is the wall clock at write time, and which therefore
 * differ between ANY two runs — including two real replays. Exhaustive on
 * purpose: everything not listed here must match exactly.
 */
const WALL_CLOCK_COLUMNS = new Set(['_migrations.applied_at'])

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-migrated-conformance-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Every user table in the database, name-ordered. */
function userTables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all()
    .map((r) => r.name)
}

/**
 * A deterministic text dump of one table's full contents: column names, then
 * every row, ordered by the whole row so the comparison never depends on
 * insertion order. Wall-clock columns are replaced by a marker rather than
 * dropped, so a column DISAPPEARING is still caught.
 */
function dumpTable(db: Database, table: string): string {
  const columns = db
    .query<{ name: string }, []>(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .map((r) => r.name)

  const selected = columns
    .map((c) =>
      WALL_CLOCK_COLUMNS.has(`${table}.${c}`)
        ? `'<wall-clock>' AS ${JSON.stringify(c)}`
        : JSON.stringify(c),
    )
    .join(', ')

  const rows = db
    .query<Record<string, unknown>, []>(
      `SELECT ${selected} FROM ${JSON.stringify(table)} ORDER BY ${columns
        .map((c) => JSON.stringify(c))
        .join(', ')}`,
    )
    .all()

  const lines = [`### ${table}`, columns.join('\t')]
  for (const row of rows) {
    lines.push(columns.map((c) => JSON.stringify(row[c] ?? null)).join('\t'))
  }
  return lines.join('\n')
}

/** The full-data dump used by arm 3, across every user table. */
function dumpAll(db: Database): string {
  return userTables(db)
    .map((t) => dumpTable(db, t))
    .join('\n\n')
}

function openReplayed(path: string): { db: Database; applied: number[] } {
  const db = new Database(path, { create: true })
  const result = applyMigrations(db)
  return { db, applied: result.applied }
}

test('a seeded database is indistinguishable from a real migration replay', () => {
  const replayedPath = join(tmp, 'replayed.db')
  const seededPath = join(tmp, 'seeded.db')

  const { db: a, applied } = openReplayed(replayedPath)
  expect(applied.length).toBeGreaterThan(0)

  seedMigratedDb(seededPath)
  const b = new Database(seededPath)

  try {
    // ── ARM 1: schema, byte-identical, via the pinned serializer ──────────
    expect(serializeSchema(b)).toBe(serializeSchema(a))

    // ── ARM 2: persisted journal mode ─────────────────────────────────────
    const journalOf = (db: Database): string =>
      db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode ?? ''
    expect(journalOf(b)).toBe(journalOf(a))
    // A positive control on arm 2: the value under test is the interesting one
    // (WAL), not the default a blank file would report.
    expect(journalOf(a)).toBe('wal')

    // ── ARM 3: full contents of every user table ──────────────────────────
    expect(userTables(b)).toEqual(userTables(a))
    expect(dumpAll(b)).toBe(dumpAll(a))
    // The ledger is the row set this whole change most has to get right, so
    // name it explicitly rather than trusting it to be inside the bulk diff.
    expect(dumpTable(b, '_migrations')).toBe(dumpTable(a, '_migrations'))

    // ── ARM 4: the REAL runner certifies the seed ─────────────────────────
    const certification = applyMigrations(b)
    expect(certification.applied).toEqual([])
    expect(certification.skipped).toEqual(applied)

    // ── ARM 5: integrity + foreign keys ───────────────────────────────────
    expect(
      b.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check,
    ).toBe('ok')
    expect(b.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    a.close()
    b.close()
  }
})

test('the conformance diff FAILS on an injected ledger row (arm 3 mutation)', () => {
  const replayedPath = join(tmp, 'replayed.db')
  const mutatedPath = join(tmp, 'mutated.db')

  const { db: a } = openReplayed(replayedPath)
  seedMigratedDb(mutatedPath)
  const b = new Database(mutatedPath)

  try {
    // Sanity: identical BEFORE the mutation, so the failure below is caused by
    // the mutation and not by some pre-existing difference.
    expect(dumpTable(b, '_migrations')).toBe(dumpTable(a, '_migrations'))

    b.exec(
      `INSERT INTO _migrations (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
       VALUES (999999, 'not_a_real_migration', 0, NULL, NULL, NULL)`,
    )

    expect(dumpTable(b, '_migrations')).not.toBe(dumpTable(a, '_migrations'))
    expect(dumpAll(b)).not.toBe(dumpAll(a))
  } finally {
    a.close()
    b.close()
  }
})

test('the conformance diff FAILS on an injected table (arm 1 mutation)', () => {
  const replayedPath = join(tmp, 'replayed.db')
  const mutatedPath = join(tmp, 'mutated.db')

  const { db: a } = openReplayed(replayedPath)
  seedMigratedDb(mutatedPath)
  const b = new Database(mutatedPath)

  try {
    expect(serializeSchema(b)).toBe(serializeSchema(a))

    b.exec('CREATE TABLE not_a_real_table (id INTEGER PRIMARY KEY)')

    expect(serializeSchema(b)).not.toBe(serializeSchema(a))
    expect(userTables(b)).not.toEqual(userTables(a))
  } finally {
    a.close()
    b.close()
  }
})

test('seedMigratedDb refuses a target that already has content', () => {
  const path = join(tmp, 'occupied.db')

  seedMigratedDb(path)

  expect(() => seedMigratedDb(path)).toThrow(/already exists and is non-empty/)
})

test('seedMigratedDb accepts a zero-length placeholder file', () => {
  // A caller that touched the path — or a tmpdir helper that did — must not be
  // refused: an empty file is not a database with content, and `Database(path,
  // { create: true })` leaves exactly this state until the first write.
  const path = join(tmp, 'placeholder.db')
  writeFileSync(path, '')

  expect(() => seedMigratedDb(path)).not.toThrow()

  const db = new Database(path)
  try {
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM _migrations').get()?.n).toBeGreaterThan(0)
  } finally {
    db.close()
  }
})
