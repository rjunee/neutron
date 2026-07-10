import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PersistenceError } from './errors.ts'
import { mapRow, mapRows, openSidecar, parseJsonColumn, resolveNow } from './sidecar.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function pragmaValue(db: ReturnType<typeof openSidecar>, name: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get()
  return row === null ? undefined : Object.values(row)[0]
}

describe('openSidecar', () => {
  test('applies the full ProjectDb startup-pragma set', () => {
    const db = openSidecar(join(tempDir(), 'side.db'))
    cleanups.push(() => db.close())
    expect(pragmaValue(db, 'journal_mode')).toBe('wal')
    expect(pragmaValue(db, 'foreign_keys')).toBe(1)
    expect(pragmaValue(db, 'synchronous')).toBe(1) // NORMAL
    expect(pragmaValue(db, 'busy_timeout')).toBe(100)
    expect(pragmaValue(db, 'cache_size')).toBe(-64000)
  })

  test(':memory: works (WAL degrades to memory journal, no throw)', () => {
    const db = openSidecar(':memory:')
    cleanups.push(() => db.close())
    expect(pragmaValue(db, 'journal_mode')).toBe('memory')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.run('INSERT INTO t (id) VALUES (1)', [])
    expect(db.query<{ id: number }, []>('SELECT id FROM t').get()).toEqual({ id: 1 })
  })

  test('create: false on a missing file throws PersistenceError', () => {
    expect(() => openSidecar(join(tempDir(), 'nope.db'), { create: false })).toThrow(
      PersistenceError,
    )
  })
})

describe('parseJsonColumn', () => {
  test('valid JSON parses under every policy', () => {
    expect(parseJsonColumn('["a","b"]', { onCorrupt: 'throw' })).toEqual(['a', 'b'])
    expect(parseJsonColumn('{"task":"x"}', { onCorrupt: 'raw' })).toEqual({ task: 'x' })
    expect(parseJsonColumn('null', { onCorrupt: 'fallback', fallback: 7 })).toBeNull()
  })

  test("policy 'throw' propagates the SyntaxError", () => {
    expect(() => parseJsonColumn('{oops', { onCorrupt: 'throw' })).toThrow(SyntaxError)
  })

  test("policy 'fallback' returns the caller's value", () => {
    expect(parseJsonColumn('{oops', { onCorrupt: 'fallback', fallback: null })).toBeNull()
    expect(parseJsonColumn('{oops', { onCorrupt: 'fallback', fallback: [] })).toEqual([])
  })

  test("policy 'raw' returns the raw column text", () => {
    expect(parseJsonColumn('fix the login bug', { onCorrupt: 'raw' })).toBe('fix the login bug')
  })
})

describe('mapRow / mapRows', () => {
  const decode = (r: { n: number }): number => r.n * 2

  test('mapRow propagates null and decodes hits', () => {
    expect(mapRow(null, decode)).toBeNull()
    expect(mapRow({ n: 21 }, decode)).toBe(42)
  })

  test('mapRows decodes every row', () => {
    expect(mapRows([{ n: 1 }, { n: 2 }], decode)).toEqual([2, 4])
  })
})

describe('resolveNow', () => {
  test('passes an injected clock through', () => {
    const fixed = (): number => 1234
    expect(resolveNow(fixed)()).toBe(1234)
  })

  test('defaults to Date.now', () => {
    const before = Date.now()
    const got = resolveNow()()
    expect(got).toBeGreaterThanOrEqual(before)
    expect(got).toBeLessThanOrEqual(Date.now())
  })
})
