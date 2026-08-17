/**
 * tests/support/migrated-db.test.ts — the clone must be indistinguishable from
 * a freshly-migrated database.
 *
 * This is the whole safety argument for `migrated-db.ts`. ~400 suites stopped
 * running `applyMigrations` per test and now open a clone of a page image
 * instead; the only thing that makes that a speed-up rather than a coverage cut
 * is that the clone carries the SAME schema and the SAME ledger the runner would
 * have written. So the control here is a real `applyMigrations` against a real
 * file, taken in this process, and the clones are diffed against IT — not
 * against a checked-in snapshot, which could agree with a template that had
 * drifted along with it.
 *
 * (`migrations/snapshot.test.ts` is the separate guard that the migration tree
 * itself still produces the expected schema. This file only asserts the clone
 * equals the tree — the two together are what pin the end-to-end property.)
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  migratedTemplateBytes,
  openMigratedDatabase,
  openMigratedDatabaseAt,
  openMigratedDb,
  openMigratedDbAt,
  writeMigratedDbFile,
} from './migrated-db.ts'

interface SchemaRow {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}

/**
 * Every object in the schema, ordered deterministically. `rootpage` is
 * deliberately NOT compared: it is a physical page number, so two databases that
 * ran the same DDL in the same order can still differ there without differing in
 * any way a caller can observe.
 */
function schemaOf(db: Database): SchemaRow[] {
  return db
    .query<SchemaRow, []>(
      `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name, sql`,
    )
    .all()
}

type LedgerRow = Record<string, unknown>

/**
 * The ledger, minus `applied_at`. The timestamp is wall-clock at apply time and
 * therefore differs between the template and the control by construction; every
 * other column is provenance the clone MUST carry, because the boot-time
 * identity reconciliation reads it.
 *
 * Columns are read from `pragma_table_info` rather than named literally, so the
 * comparison keeps covering the whole ledger the day a provenance column is
 * added — a hardcoded list would silently stop checking the new one.
 */
function ledgerOf(db: Database): LedgerRow[] {
  const columns = db
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('_migrations') ORDER BY name`)
    .all()
    .map((r) => r.name)
    .filter((name) => name !== 'applied_at')
  return db
    .query<LedgerRow, []>(`SELECT ${columns.join(', ')} FROM _migrations ORDER BY name`)
    .all()
}

let tmp: string
/** A REAL `applyMigrations` run, in this process — the control. */
let control: Database
let controlSchema: SchemaRow[]
let controlLedger: LedgerRow[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-migrated-db-kit-'))
  control = new Database(join(tmp, 'control.db'), { create: true })
  applyMigrations(control)
  controlSchema = schemaOf(control)
  controlLedger = ledgerOf(control)
})

afterEach(() => {
  control.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('migrated-db testkit — the clone equals a freshly-migrated database', () => {
  test('the control is not vacuously empty (the comparison can fail)', () => {
    // A schema diff between two empty databases passes for the wrong reason.
    // This is the positive control: the thing being compared has real content,
    // so an equality assertion below is a measurement rather than decoration.
    expect(controlSchema.length).toBeGreaterThan(50)
    expect(controlLedger.length).toBeGreaterThan(50)
    expect(controlSchema.some((r) => r.type === 'table' && r.name === '_migrations')).toBe(true)
  })

  test('in-memory clone carries the identical schema and ledger', () => {
    const clone = openMigratedDatabase()
    try {
      expect(schemaOf(clone)).toEqual(controlSchema)
      expect(ledgerOf(clone)).toEqual(controlLedger)
    } finally {
      clone.close()
    }
  })

  test('file-backed clone carries the identical schema and ledger', () => {
    const db = openMigratedDbAt(join(tmp, 'file-clone.db'))
    try {
      const raw = db.raw()
      expect(schemaOf(raw)).toEqual(controlSchema)
      expect(ledgerOf(raw)).toEqual(controlLedger)
    } finally {
      db.close()
    }
  })

  test('raw file-backed clone carries the identical schema and ledger', () => {
    const raw = openMigratedDatabaseAt(join(tmp, 'raw-file-clone.db'))
    try {
      expect(schemaOf(raw)).toEqual(controlSchema)
      expect(ledgerOf(raw)).toEqual(controlLedger)
    } finally {
      raw.close()
    }
  })

  test('a re-run of the real runner against a clone finds NOTHING pending', () => {
    // The sharpest single assertion in this file. The runner decides "pending"
    // by migration IDENTITY against the ledger, so if the clone's ledger were
    // short by even one row the runner would apply it — and this would report
    // that name. An empty `applied` is the runner itself agreeing that the clone
    // is fully migrated.
    const clone = openMigratedDatabase()
    try {
      expect(applyMigrations(clone).applied).toEqual([])
    } finally {
      clone.close()
    }
  })
})

describe('migrated-db testkit — clones are independent', () => {
  test('a write to one clone reaches neither the next clone nor the template', () => {
    const first = openMigratedDatabase()
    first.exec('CREATE TABLE clone_isolation_probe (id INTEGER)')
    first.run('INSERT INTO clone_isolation_probe (id) VALUES (1)')

    const second = openMigratedDatabase()
    try {
      const found = second
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'clone_isolation_probe'`,
        )
        .get()
      expect(found?.n).toBe(0)
      expect(schemaOf(second)).toEqual(controlSchema)
    } finally {
      first.close()
      second.close()
    }
  })

  test('a write to a file-backed clone does not reach an in-memory clone', () => {
    const onDisk = openMigratedDbAt(join(tmp, 'mutated.db'))
    onDisk.raw().exec('CREATE TABLE file_clone_probe (id INTEGER)')
    onDisk.close()

    const fresh = openMigratedDatabase()
    try {
      expect(schemaOf(fresh)).toEqual(controlSchema)
    } finally {
      fresh.close()
    }
  })
})

describe('migrated-db testkit — mechanics', () => {
  test('the template is built ONCE per process', () => {
    // Identity, not equality: a second build would be a second ~340 ms
    // `applyMigrations`, which is the whole cost this testkit exists to remove.
    expect(migratedTemplateBytes()).toBe(migratedTemplateBytes())
  })

  test('the in-memory ProjectDb clone enforces foreign keys', () => {
    // `ProjectDb.adopt` shares `STARTUP_PRAGMAS` with `open` precisely so an
    // adopted connection cannot silently skip constraint enforcement.
    const db = openMigratedDb()
    try {
      expect(db.pragma('foreign_keys')).toBe(1)
      expect(db.path).toBe(':memory:')
    } finally {
      db.close()
    }
  })

  test('the file-backed clone is a real file at the path the caller named', () => {
    const path = join(tmp, 'nested', 'project.db')
    mkdtempSync(join(tmp, 'x-'))
    // Parent must exist — same requirement SQLite imposes on `ProjectDb.open`.
    expect(() => writeMigratedDbFile(path)).toThrow()

    const flat = join(tmp, 'project.db')
    const db = openMigratedDbAt(flat)
    try {
      expect(db.path).toBe(flat)
      expect(statSync(flat).size).toBe(migratedTemplateBytes().byteLength)
      expect(db.pragma('foreign_keys')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('a store can write through the clone (it is not read-only)', async () => {
    const db = openMigratedDb()
    try {
      await db.exec('CREATE TABLE writable_probe (id INTEGER PRIMARY KEY)')
      await db.run('INSERT INTO writable_probe (id) VALUES (?)', [7])
      expect(db.get<{ id: number }>('SELECT id FROM writable_probe')?.id).toBe(7)
    } finally {
      db.close()
    }
  })

  test('ProjectDb.adopt records the path it is given', () => {
    const raw = openMigratedDatabase()
    const db = ProjectDb.adopt('/some/declared/path.db', raw)
    try {
      expect(db.path).toBe('/some/declared/path.db')
    } finally {
      db.close()
    }
  })
})
