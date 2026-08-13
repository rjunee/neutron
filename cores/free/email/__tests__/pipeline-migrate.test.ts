/**
 * The Core's OWN migration applier.
 *
 * It exists because a bundled Core may not import `migrations/` (nor the host
 * logger that module pulls in behind it) — see `src/pipeline/migrate.ts`. A
 * copy of someone else's mechanics is exactly the kind of code that looks
 * finished and is subtly wrong, so the two properties that are easy to drop in
 * the copying are pinned here rather than left to the store suites to imply.
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyCoreMigrations, loadCoreMigrations } from '../src/pipeline/migrate.ts'

function withDir(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'email-migrate-'))
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the Core applies its own sidecar migrations', () => {
  test('a COMMENT-ONLY header is not mistaken for a pragma preamble', () => {
    // THE BUG THIS CAUGHT. SQLite rejects an exec of nothing but comments, and
    // two of this Core's three real migrations open with a header comment and
    // no pragma — so a copy that lifts any matched preamble throws on the first
    // one and the sidecar never migrates at all.
    withDir(
      {
        '0001_commented.sql': '-- a header, and nothing else up here\nCREATE TABLE t (id INTEGER);',
      },
      (dir) => {
        const db = new Database(':memory:')
        expect(applyCoreMigrations(db, dir).applied).toEqual([1])
        expect(db.query('SELECT name FROM sqlite_master WHERE name = ?').all('t')).toHaveLength(1)
        db.close()
      },
    )
  })

  test('a header that merely MENTIONS the word pragma is still comments', () => {
    // The near-miss the strip exists for: word-matching the raw preamble passes
    // a comment-only string through to exec and fails the same way.
    withDir(
      {
        '0001_mentions.sql': '-- No PRAGMA preamble is needed here.\nCREATE TABLE t (id INTEGER);',
      },
      (dir) => {
        const db = new Database(':memory:')
        expect(applyCoreMigrations(db, dir).applied).toEqual([1])
        db.close()
      },
    )
  })

  test('a REAL pragma preamble is lifted out of the transaction', () => {
    // `journal_mode` is one SQLite refuses inside a transaction, so it only
    // succeeds if the preamble really ran before BEGIN.
    withDir(
      {
        '0001_pragma.sql': 'PRAGMA journal_mode = WAL;\nCREATE TABLE t (id INTEGER);',
      },
      (dir) => {
        const dbdir = mkdtempSync(join(tmpdir(), 'email-migrate-db-'))
        const db = new Database(join(dbdir, 'x.db'))
        expect(applyCoreMigrations(db, dir).applied).toEqual([1])
        expect(
          (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        ).toBe('wal')
        db.close()
        rmSync(dbdir, { recursive: true, force: true })
      },
    )
  })

  test('a failed migration lands NOTHING and is not recorded', () => {
    withDir(
      {
        '0001_ok.sql': 'CREATE TABLE a (id INTEGER);',
        '0002_broken.sql': 'CREATE TABLE b (id INTEGER);\nTHIS IS NOT SQL;',
      },
      (dir) => {
        const db = new Database(':memory:')
        expect(() => applyCoreMigrations(db, dir)).toThrow()
        // 0001 stands, 0002 left no half-applied table and no version row —
        // otherwise the next open retries against split state.
        const names = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((r) => r.name)
        expect(names).toContain('a')
        expect(names).not.toContain('b')
        expect(
          db.query<{ version: number }, []>('SELECT version FROM _migrations').all(),
        ).toEqual([{ version: 1 }])
        db.close()
      },
    )
  })

  test('re-applying is a no-op: every version is skipped the second time', () => {
    withDir({ '0001_ok.sql': 'CREATE TABLE a (id INTEGER);' }, (dir) => {
      const db = new Database(':memory:')
      expect(applyCoreMigrations(db, dir).applied).toEqual([1])
      const second = applyCoreMigrations(db, dir)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([1])
      db.close()
    })
  })

  test('only NNNN_-prefixed .sql files are migrations, in numeric order', () => {
    withDir(
      {
        '0002_second.sql': 'SELECT 1;',
        '0001_first.sql': 'SELECT 1;',
        'notes.md': 'not a migration',
        'helper.sql': 'SELECT 1;',
      },
      (dir) => {
        expect(loadCoreMigrations(dir).map((m) => m.version)).toEqual([1, 2])
      },
    )
  })
})
