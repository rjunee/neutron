import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, applyProjectScopedMigrations } from '../runner.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ordinal-collision-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function tree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents)
  return dir
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null
}

test('a recorded migration this build does not contain refuses and preserves its record', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', { '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);' })
  applyMigrations(db, a)

  // Not because the two share ordinal 1 — that is irrelevant now — but because
  // `alpha` ran here and tree `b` describes it nowhere.
  expect(() => applyMigrations(db, b)).toThrow(/NO migration file in this build/)
  expect(tableExists(db, 't2')).toBe(false)
  expect(db.query('SELECT version, name FROM _migrations').all()).toEqual([{ version: 1, name: 'alpha' }])
})

test('the unexplained-row refusal applies no later migrations', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    '0002_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
  })
  applyMigrations(db, a)
  expect(() => applyMigrations(db, b)).toThrow()
  expect(tableExists(db, 't2')).toBe(false)
  expect(tableExists(db, 't3')).toBe(false)
  expect(db.query('SELECT version FROM _migrations WHERE version = 2').get()).toBeNull()
})

test('same-name re-run skips without throwing', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  applyMigrations(db, a)
  expect(applyMigrations(db, a)).toEqual({ applied: [], skipped: [1] })
})

test('a migration recorded at ANOTHER ordinal is skipped, not re-applied', () => {
  // The renumber case, which the ordinal-keyed runner got wrong in the harmless
  // direction and then in the harmful one: `alpha` merged at 0002 after running here
  // as 0001. Re-running it would fail on the duplicate table.
  const db = new Database(':memory:')
  applyMigrations(db, tree('before', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' }))
  const after = tree('after', {
    '0002_alpha.sql': 'CREATE TABLE t1 (id INTEGER);',
    '0003_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
  })
  expect(applyMigrations(db, after)).toEqual({ applied: [3], skipped: [2] })
  // The original row keeps the ordinal it was written with. Nothing is renumbered.
  expect(db.query("SELECT version FROM _migrations WHERE name = 'alpha'").get()).toEqual({ version: 1 })
})

test('a NEW file whose bytes duplicate an applied one REFUSES instead of skipping itself', () => {
  // THE SILENT-SKIP THE HASH WIDENING OPENED. `beta` is a new, distinctly-named,
  // perfectly ordinary migration that happens to be byte-identical to `alpha`, which
  // already ran. Widening on the hash alone answered "already applied" — so beta never
  // ran, was never recorded, and the boot reported success with beta under `skipped`.
  // That is the ordinal bug's own failure mode reached through its fix.
  //
  // IT TAKES TWO BOOTS, and that is why the shape is easy to miss. In a SINGLE boot
  // both files are pending (the ledger is read once, before anything applies), so both
  // run and the second throws `duplicate column name` — loud, and not this bug. The
  // silent version needs alpha recorded by an EARLIER boot, which is exactly what
  // happens when the duplicate is added later.
  const body = 'ALTER TABLE t ADD COLUMN b TEXT;'
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (id TEXT)')
  expect(applyMigrations(db, tree('one', { '0001_alpha.sql': body }))).toEqual({
    applied: [1],
    skipped: [],
  })

  const two = tree('two', { '0001_alpha.sql': body, '0002_beta.sql': body })
  let message = ''
  try {
    applyMigrations(db, two)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  // It refuses, and it names BOTH sides — neither is actionable alone.
  expect(message).toContain('0002_beta.sql')
  expect(message).toContain('recorded as "alpha"')
  expect(message).toContain('they never run at all')
  // Nothing was written, and beta is still not in the ledger.
  expect(db.query("SELECT 1 FROM _migrations WHERE name = 'beta'").get()).toBeNull()

  // CONTROL, and it has to be able to fail for the reason under test: the SAME two-boot
  // sequence with beta's bytes merely differing by a comment applies normally. So the
  // refusal is the byte-identity, not "a second file arrived on a later boot" — which
  // would have made the assertion above pass for a reason that has nothing to do with
  // this guard.
  const control = new Database(':memory:')
  control.exec('CREATE TABLE t (id TEXT)')
  applyMigrations(control, tree('c-one', { '0001_alpha.sql': body }))
  expect(
    applyMigrations(
      control,
      tree('c-two', {
        '0001_alpha.sql': body,
        '0002_beta.sql': `-- a different migration that happens to touch the same table\n${body.replace(' b ', ' c ')}`,
      }),
    ),
  ).toEqual({ applied: [2], skipped: [1] })
})

test('a RENAMED migration is still recognised by its bytes — the widening the guard must keep', () => {
  // The other side of the test above, and the reason the guard is scoped to owners
  // rather than refusing every byte match. `alpha` was renamed to `alpha_renamed` in
  // the tree; nothing here is named `alpha` any more, so the row recording those bytes
  // is a row no file accounts for, and the bytes ARE the evidence this migration has
  // run. It must skip, not re-apply and not refuse.
  const body = 'CREATE TABLE t1 (id INTEGER);'
  const db = new Database(':memory:')
  applyMigrations(db, tree('was', { '0001_alpha.sql': body }))
  expect(applyMigrations(db, tree('now', { '0002_alpha_renamed.sql': body }))).toEqual({
    applied: [],
    skipped: [2],
  })
  // And the original row is untouched — no rename, no renumber.
  expect(db.query('SELECT version, name FROM _migrations').all()).toEqual([
    { version: 1, name: 'alpha' },
  ])
})

test('a hash mismatch under a matching name is REPORTED and still boots', () => {
  // The decision this must not break: a hash mismatch is recorded and reported, NEVER
  // enforced (migrations/README.md). Already-applied files are edited in place for
  // benign reasons and a gate would turn each one into a crash loop. So the boot
  // succeeds and the migration stays skipped.
  //
  // What is fixed is the SILENCE. A migration amended during review and renumbered by
  // the merge reads as applied, its added statements never run, and nothing was said
  // while both hashes were in hand.
  const db = new Database(':memory:')
  applyMigrations(db, tree('was', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' }))

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    // Same name, same ordinal, different bytes — the benign in-place-edit shape.
    expect(
      applyMigrations(db, tree('edited', { '0001_alpha.sql': '-- reflowed\nCREATE TABLE t1 (id INTEGER);' })),
    ).toEqual({ applied: [], skipped: [1] })
  } finally {
    console.warn = original
  }

  const drift = warnings.filter((line) => line.includes('migration_content_drift'))
  expect(drift).toHaveLength(1)
  expect(drift[0]).toContain('migration=alpha')
  expect(drift[0]).toContain('enforced=false')
  // Same ordinal, so it is NOT flagged as the shape an in-place edit cannot produce.
  expect(drift[0]).toContain('renumbered=false')
})

test('bytes AND ordinal both moving is called out as the shape an edit cannot produce', () => {
  // The discriminating half of the notice. A benign in-place edit keeps its filename,
  // so a changed number beside changed bytes means the file that ran is not the file on
  // disk — the amended-during-review-then-renumbered case. It is a field rather than
  // prose so it can be grepped for, and it still does not refuse.
  const db = new Database(':memory:')
  applyMigrations(db, tree('was', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' }))

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    expect(
      applyMigrations(
        db,
        tree('amended', { '0007_alpha.sql': 'CREATE TABLE t1 (id INTEGER);\nCREATE TABLE t2 (id INTEGER);' }),
      ),
    ).toEqual({ applied: [], skipped: [7] })
  } finally {
    console.warn = original
  }

  const drift = warnings.filter((line) => line.includes('migration_content_drift'))
  expect(drift).toHaveLength(1)
  expect(drift[0]).toContain('renumbered=true')
  expect(drift[0]).toContain('recorded_ordinal=1')
  expect(drift[0]).toContain('on_disk=0007_alpha.sql')
  // The point of the warning: those added statements really did not run.
  expect(tableExists(db, 't2')).toBe(false)
})

test('a steady-state boot says nothing — the notice is silent when nothing drifted', () => {
  // The control for both tests above. Without it, an assertion that a warning appeared
  // cannot distinguish "the notice works" from "the notice fires on every boot", which
  // would make it noise an operator learns to ignore.
  const db = new Database(':memory:')
  const dir = tree('steady', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  applyMigrations(db, dir)

  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })
  } finally {
    console.warn = original
  }
  expect(warnings.filter((line) => line.includes('migration_content_drift'))).toEqual([])
})

test('an acknowledged repair suppresses its named migration, audits, and never rewrites', () => {
  // The live ordinal-122 shape: a migration whose schema change was applied BY HAND
  // and never recorded, beside a ledger row naming something else entirely. The
  // entry's `file_name` is what stops the hand-applied migration running again.
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    '0002_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
    'repairs.json': JSON.stringify([{ version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'verified', date: '2026-08-16' }]),
  })
  applyMigrations(db, a)
  expect(applyMigrations(db, b)).toEqual({ applied: [2], skipped: [1] })
  expect(tableExists(db, 't2')).toBe(false)
  expect(tableExists(db, 't3')).toBe(true)
  expect(db.query('SELECT name FROM _migrations WHERE version = 1').get()).toEqual({ name: 'alpha' })
  expect(db.query('SELECT version, recorded_name, file_name, note FROM _migration_repairs').all()).toEqual([
    { version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'verified' },
  ])
})

test('a repair whose row is absent stays inert — a fresh install applies everything', () => {
  // THE PROPERTY THAT MAKES `repairs.json` SAFE TO SHIP IN A PUBLIC REPOSITORY.
  // Entry 122 says `trident_checkpoint_head` is already applied on the one instance
  // where it was applied by hand; on every new database that migration must run.
  const db = new Database(':memory:')
  const dir = tree('fresh', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    'repairs.json': JSON.stringify([{ version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'v', date: '2026-08-16' }]),
  })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(tableExists(db, 't2')).toBe(true)
  expect(tableExists(db, '_migration_repairs')).toBe(false)
})

test('two files sharing a migration NAME refuse, naming both', () => {
  // The name is the ledger identity, so a duplicate slug makes one of the two read
  // as already-applied forever and its statements never run — the same silent
  // missing-schema failure the ordinal used to cause, one level over.
  const db = new Database(':memory:')
  const dir = tree('dupname', {
    '0001_same.sql': 'CREATE TABLE a (id INTEGER);',
    '0002_same.sql': 'CREATE TABLE b (id INTEGER);',
  })
  expect(() => applyMigrations(db, dir)).toThrow(/name collision on "same".*0001_same\.sql.*0002_same\.sql/s)
  expect(db.query('SELECT name FROM sqlite_master').all()).toEqual([])
})

test('duplicate ordinals name both files and apply nothing', () => {
  const db = new Database(':memory:')
  const dir = tree('dupe', {
    '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '0001_b.sql': 'CREATE TABLE b (id INTEGER);',
  })
  expect(() => applyMigrations(db, dir)).toThrow(/1.*0001_a\.sql.*0001_b\.sql/)
  expect(tableExists(db, 'a')).toBe(false)
  expect(tableExists(db, 'b')).toBe(false)
  // Nothing at all was written — not even the ledger. `_migrations` is created on
  // the path that writes a row and on no other, so every refusal in this runner
  // leaves the database exactly as it found it. (Stronger than the empty-ledger
  // assertion this replaced, which a created-then-unused table also satisfied.)
  expect(db.query('SELECT name FROM sqlite_master').all()).toEqual([])
})

test('the live 0122 incident acknowledgment is pinned', () => {
  const repairs = JSON.parse(readFileSync(join(import.meta.dir, '..', 'repairs.json'), 'utf8'))
  expect(repairs).toContainEqual(expect.objectContaining({
    version: 122,
    recorded_name: 'work_board_items_pr',
    file_name: 'trident_checkpoint_head',
  }))
})

test('the real migration tree still applies cleanly', () => {
  const db = new Database(':memory:')
  expect(() => applyMigrations(db)).not.toThrow()
})

test('sidecar trees without a repairs ledger remain unaffected', () => {
  const db = new Database(':memory:')
  expect(() => applyProjectScopedMigrations(db, join(import.meta.dir, '..', 'comments'))).not.toThrow()
})

/**
 * THE REPAIR PREDICATE, for a `recorded_name` THIS BUILD SHIPS AS A FILE.
 *
 * Fails without the exact-ordinal conjunct. Under a name-only or
 * ordinal-differs-from-tree rule, an entry written about ordinal 5 activates on this
 * ledger's row at ordinal 1 purely because the tree now numbers `alpha` 2 — and
 * silently drops `beta`, a migration the entry was never about, on an instance that
 * merely renumbered. Renumbering is explicitly legitimate here, so this is a healthy
 * database being quietly denied a migration.
 */
test('a repair naming a tree file stays inert on a row it was not written about', () => {
  const db = new Database(':memory:')
  const first = tree('renumber-before', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  applyMigrations(db, first)
  expect(db.query('SELECT version, name FROM _migrations').all()).toEqual([
    { version: 1, name: 'alpha' },
  ])

  // The same migration, legitimately renumbered, alongside one the repair never names.
  const after = tree('renumber-after', {
    '0002_alpha.sql': 'CREATE TABLE t1 (id INTEGER);',
    '0003_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
  })
  writeFileSync(
    join(after, 'repairs.json'),
    JSON.stringify([
      { version: 5, recorded_name: 'alpha', file_name: 'beta', note: 'other', date: '2026-08-17' },
    ]),
  )

  const result = applyMigrations(db, after)

  // The entry names ordinal 5; the row sits at 1. It says nothing about this database.
  expect(result.applied).toContain(3)
  expect(tableExists(db, 't2')).toBe(true)
  // And nothing was acknowledged, because nothing was repaired.
  expect(
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migration_repairs'").get(),
  ).toBeNull()
})
