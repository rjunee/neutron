/**
 * #451 — SCHEMA-COVERAGE guard for the boot scope reconciler's table lists.
 *
 * WHAT FAILS WITHOUT THIS. `migrations/scope-rekey.ts` moves rows off a stale
 * scope key using an EXPLICIT, hand-maintained list of `(table, column)` pairs.
 * That explicitness is deliberate — a generated "every column matching /slug/"
 * sweep would happily rewrite the columns that name OTHER instances, turning a
 * repair into corruption. But a hand list rots: someone adds a table with a
 * `project_slug`, nobody touches this file, and that table's rows are silently
 * stranded on the next rename. The stranding is invisible — no error, no
 * failing test, just data the owner can no longer see.
 *
 * So this asserts, against the committed schema snapshot, that EVERY slug-ish
 * column is CLASSIFIED: it is either swept or explicitly excluded with a
 * reason. A new table forces a decision at review time instead of at incident
 * time. Both directions are checked, so a list entry naming a column that no
 * longer exists fails too.
 *
 * `expected-schema.txt` is the right source: it is regenerated from the real
 * migrations (`bun run migrations/regen-snapshot.ts`) and its own snapshot test
 * blocks drift, so it cannot lag the schema this guard is protecting.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SCOPE_EXCLUDED_COLUMNS,
  SCOPE_SWEEP_COLUMNS,
  type ScopedColumn,
} from '../scope-rekey.ts'

const SCHEMA_PATH = fileURLToPath(new URL('../expected-schema.txt', import.meta.url))

/** `table.column` — the comparable key for both lists and the schema. */
function key(c: ScopedColumn): string {
  return `${c.table}.${c.column}`
}

/**
 * Every `(table, column)` in the committed schema whose column name contains
 * "slug", i.e. everything that COULD be an instance scope key and therefore
 * needs a verdict. Deliberately over-broad: an over-broad discovery makes the
 * guard demand a classification for a column that turns out not to need one,
 * which costs one line in the exclusion list. An under-broad one would let the
 * next stranded table through, which is the failure this exists to stop.
 */
function discoverSlugColumns(): ScopedColumn[] {
  const txt = readFileSync(SCHEMA_PATH, 'utf8')
  const out: ScopedColumn[] = []
  // Records are separated by a blank line before the next `[type] name` header.
  for (const record of txt.split(/\n\n(?=\[)/)) {
    const header = record.match(/^\[table\] (\S+) \(tbl=/)
    if (header === null) continue
    const table = header[1] as string
    const body = record.slice(record.indexOf('('))
    // Strip `-- …` comments so a column NAMED in a comment is never mistaken
    // for a declaration.
    const clean = body.replace(/--[^\n]*/g, '')
    const seen = new Set<string>()
    for (const m of clean.matchAll(
      /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/gim,
    )) {
      const column = m[1] as string
      if (!/slug/i.test(column)) continue
      if (seen.has(column)) continue
      seen.add(column)
      out.push({ table, column })
    }
  }
  return out
}

const discovered = discoverSlugColumns()
const sweep = new Set(SCOPE_SWEEP_COLUMNS.map(key))
const excluded = new Set(SCOPE_EXCLUDED_COLUMNS.map(key))

describe('scope-rekey sweep list covers the schema (#451)', () => {
  test('discovery sanity — the schema parse actually saw the tables', () => {
    // ~46 slug-ish columns at time of writing. A broken parse (moved snapshot,
    // changed record format) must fail loudly rather than pass on an empty set
    // and declare perfect coverage of nothing.
    expect(discovered.length).toBeGreaterThan(40)
    // Two anchors: the table the defect is ABOUT, and a column that must never
    // be swept. If either stops being discovered, the parse is wrong.
    expect(discovered.some((c) => key(c) === 'onboarding_state.project_slug')).toBe(true)
    expect(discovered.some((c) => key(c) === 'connected_members.home_instance_slug')).toBe(true)
  })

  test('every slug-ish column in the schema is classified', () => {
    const unclassified = discovered
      .map(key)
      .filter((k) => !sweep.has(k) && !excluded.has(k))
      .sort()
    expect(
      unclassified,
      'unclassified slug-ish column(s). Add each to SCOPE_SWEEP_COLUMNS (it holds ' +
        'THIS instance\'s scope key and must move forward on a rename) or to ' +
        'SCOPE_EXCLUDED_COLUMNS with a reason (it names ANOTHER instance, or is ' +
        'not an instance key at all) in migrations/scope-rekey.ts.',
    ).toEqual([])
  })

  test('no list entry names a column that no longer exists', () => {
    const present = new Set(discovered.map(key))
    const phantomSweep = [...sweep].filter((k) => !present.has(k)).sort()
    const phantomExcluded = [...excluded].filter((k) => !present.has(k)).sort()
    expect(phantomSweep, 'SCOPE_SWEEP_COLUMNS entry not in expected-schema.txt').toEqual([])
    expect(phantomExcluded, 'SCOPE_EXCLUDED_COLUMNS entry not in expected-schema.txt').toEqual([])
  })

  test('the two lists are disjoint and internally unique', () => {
    expect(sweep.size, 'duplicate entry in SCOPE_SWEEP_COLUMNS').toBe(SCOPE_SWEEP_COLUMNS.length)
    expect(excluded.size, 'duplicate entry in SCOPE_EXCLUDED_COLUMNS').toBe(
      SCOPE_EXCLUDED_COLUMNS.length,
    )
    const both = [...sweep].filter((k) => excluded.has(k)).sort()
    expect(both, 'a column cannot be both swept and excluded').toEqual([])
  })

  test('every exclusion carries a non-trivial reason', () => {
    // The reason is the whole value of the exclusion list: it is what a future
    // reader consults to decide whether a lookalike column belongs here too.
    for (const c of SCOPE_EXCLUDED_COLUMNS) {
      expect(c.why.length, `${key(c)} needs a real reason`).toBeGreaterThan(20)
    }
  })
})
