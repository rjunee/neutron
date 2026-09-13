/**
 * Migration 0140 — THE REBUILD MUST NOT LOSE A COLUMN.
 *
 * 0140 widens `work_board_items.status` with a BLOCKED lane. SQLite cannot ALTER a CHECK
 * constraint on a STRICT table, so the migration does what 0097 and 0130 did before it:
 * CREATE a new table, `INSERT … SELECT` the rows across, `DROP TABLE` the old one, rename.
 *
 * THAT `DROP TABLE` IS WHY THIS FILE EXISTS. The transfer is an explicit column list, and
 * a column omitted from it is not a lint error — it is DELETED DATA. This table holds the
 * owner's real Work Board: every card, its run links, its PR provenance, its declared
 * dependencies. The migration runs ONCE against live data, and a silently dropped column
 * is unrecoverable and invisible until someone notices a card is wrong. Writing the
 * migration caught exactly this for 0139's `blockers`, and only because the committed
 * schema snapshot changed shape — a check that sees the COLUMN SET, never the CONTENTS.
 *
 * WHAT THE OTHER TESTS CANNOT SEE. `migrations/runner.test.ts` and the live-ledger suites
 * assert that ordinal 140 RAN. The fresh-schema snapshot asserts the resulting shape. The
 * store tests run against a database where 0140 has already applied. None of them ever
 * holds a POPULATED 0139-shaped row, so none of them can lose one.
 *
 * NON-DEFAULT VALUES IN EVERY COLUMN, deliberately. A fixture that leaves a column at its
 * default looks correct against a rebuild that dropped that column and let the default
 * refill it — the fixture-unrepresentative failure in its most expensive form. Every
 * column below therefore carries a value that could not arise by accident, and the row is
 * compared as a WHOLE object so a column added later without being transferred fails here
 * rather than shipping.
 *
 * WHY THE REBUILD AT ALL (asked, and answered NO). SQLite has no `ALTER TABLE … DROP
 * CONSTRAINT`, and the only way to change a CHECK without a rebuild is `PRAGMA
 * writable_schema=ON` surgery on `sqlite_master` — which SQLite's own documentation calls
 * dangerous and which can corrupt a database outright if the rewritten text is wrong. The
 * 12-step rebuild is the documented safe procedure, it is what 0053/0097/0130 already do
 * on this table, and a fourth spelling of "change a CHECK" would be a second thing to get
 * right. So the rebuild stays and this test is what makes it safe.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../runner.ts'

const MIGRATIONS_DIR = dirname(fileURLToPath(new URL('../runner.ts', import.meta.url)))
/** The ordinal under test. Everything BELOW it builds the "before" database. */
const ORDINAL = 140

let tmp: string
let db: Database

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0140-'))
})
afterEach(() => {
  try {
    db.close()
  } catch {
    /* a test that never opened one */
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** A migrations directory containing only the files `keep` accepts. */
function treeUpTo(name: string, keep: (version: number) => boolean): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const m = /^(\d{4})_.*\.sql$/.exec(file)
    if (m === null) continue
    if (!keep(Number.parseInt(m[1] ?? '', 10))) continue
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
  }
  // `repairs.json` is read by the runner; copy it so the tree is a real one.
  try {
    copyFileSync(join(MIGRATIONS_DIR, 'repairs.json'), join(dir, 'repairs.json'))
  } catch {
    /* absent is fine */
  }
  return dir
}

/**
 * THE ROW. Every column carries a value that could not arise from a default, a NULL, or a
 * plausible re-derivation — so a column that failed to transfer shows up as a difference
 * rather than as a coincidence.
 */
const ROW = {
  id: '01J0PRESERVEDCARD000000001',
  project_slug: 'acme-preserve',
  title: 'a card whose every column must survive the rebuild',
  // A lane that EXISTS before 0140 and is not the DEFAULT ('upcoming'), so a dropped
  // `status` column would refill as 'upcoming' and be caught.
  status: 'in_progress',
  sort_order: 4242,
  design_doc_ref: 'plans/acme/preserve-me.md',
  // NOT the default 0.
  inline_active: 1,
  linked_run_id: 'run-preserve-0140',
  created_at: '2026-01-02T03:04:05.006Z',
  updated_at: '2026-02-03T04:05:06.007Z',
  completed_at: '2026-03-04T05:06:07.008Z',
  // NOT the default 'build'.
  task_type: 'research',
  blocked_by: '["01J0OTHERCARD0000000000001"]',
  declared_surfaces: '["trident/**","work-board/store.ts"]',
  pr: 1234,
  pr_url: 'https://github.com/acme/widgets/pull/1234',
  blockers: '["01J0BLOCKERCARD000000000A"]',
} as const

function seedBeforeRow(target: Database): void {
  const cols = Object.keys(ROW)
  target.run(
    `INSERT INTO work_board_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    Object.values(ROW) as (string | number)[],
  )
}

function readRow(target: Database): Record<string, unknown> | null {
  return (
    (target
      .query<Record<string, unknown>, [string]>('SELECT * FROM work_board_items WHERE id = ?')
      .get(ROW.id) as Record<string, unknown> | null) ?? null
  )
}

function indexNames(target: Database): string[] {
  return target
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_board_items' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name)
}

test('the PRE-migration row really is 0139-shaped (the fixture is not vacuous)', () => {
  // Asserted first and alone. If the "before" tree already contained 0140 — or if the
  // seed silently failed — every comparison below would be about a row the migration
  // never had to carry, and would pass for the wrong reason.
  db = new Database(join(tmp, 'before-only.db'), { create: true })
  applyMigrations(db, treeUpTo('before-only', (v) => v < ORDINAL))
  seedBeforeRow(db)

  const before = readRow(db)
  expect(before).not.toBeNull()
  expect(Object.keys(before ?? {}).sort()).toEqual(Object.keys(ROW).slice().sort())
  // And the lane this migration adds is REFUSED by the old CHECK, which is the whole
  // reason a rebuild is needed.
  expect(() => db.run("UPDATE work_board_items SET status = 'blocked' WHERE id = ?", [ROW.id])).toThrow()
})

test('HEADLINE: 0140 carries EVERY column across the rebuild, value for value', () => {
  db = new Database(join(tmp, 'carry.db'), { create: true })
  applyMigrations(db, treeUpTo('carry-before', (v) => v < ORDINAL))
  seedBeforeRow(db)
  const before = readRow(db)

  const result = applyMigrations(db, treeUpTo('carry-full', () => true))
  expect(result.applied).toContain(ORDINAL)

  // Compared as a WHOLE OBJECT, not column by column: a column added to the table later
  // and forgotten in a future rebuild's SELECT list fails HERE rather than shipping.
  expect(readRow(db)).toEqual(before)
  // …and nothing else arrived or vanished.
  expect(
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM work_board_items').get()?.n,
  ).toBe(1)
})

test('both indexes from 0090 are restored by name', () => {
  // A rebuild DROPs the table, and its indexes go with it. An index that is not
  // recreated is invisible until the board list gets slow on a big project.
  db = new Database(join(tmp, 'idx.db'), { create: true })
  applyMigrations(db, treeUpTo('idx-before', (v) => v < ORDINAL))
  const before = indexNames(db)
  expect(before).toContain('idx_work_board_items_list')
  expect(before).toContain('idx_work_board_items_linked_run')

  applyMigrations(db, treeUpTo('idx-full', () => true))
  expect(indexNames(db)).toEqual(before)
})

test('foreign_keys is ON again after the rebuild, and the table is still STRICT', () => {
  // The migration opens with `PRAGMA foreign_keys = OFF`. The runner hoists that out of
  // the transaction and re-asserts ON after commit; a rebuild that left it off would
  // silently disable referential integrity for the rest of the process.
  db = new Database(join(tmp, 'pragma.db'), { create: true })
  applyMigrations(db, treeUpTo('pragma-full', () => true))
  expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)

  const sql =
    db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_board_items'",
      )
      .get()?.sql ?? ''
  expect(sql).toContain('STRICT')
})

test('the widened CHECK accepts `blocked` and still refuses a lane nobody declared', () => {
  db = new Database(join(tmp, 'check.db'), { create: true })
  applyMigrations(db, treeUpTo('check-full', () => true))
  seedBeforeRow(db)

  db.run("UPDATE work_board_items SET status = 'blocked' WHERE id = ?", [ROW.id])
  expect(readRow(db)?.status).toBe('blocked')
  // The constraint is still a constraint — widening it must not have removed it.
  expect(() => db.run("UPDATE work_board_items SET status = 'made-up' WHERE id = ?", [ROW.id])).toThrow()
})
