import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import {
  historyImportTaskHash,
  priorityHintToInt,
  seedTasksFromImportResult,
} from '../history-import-seeder.ts'
import { TaskStore } from '../store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-history-seeder-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function emptyImportResult(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {
      addressing_style: 'friend',
      formality: 'casual',
      humor: 'dry',
      verbosity: 'medium',
      directness: 'direct',
      cadence: 'short',
      sample_phrases: [],
      forbidden_phrases: [],
    } as ImportResult['voice_signals'],
    facts: {},
  }
}

describe('priorityHintToInt', () => {
  test('maps P0..P3 → 3..0', () => {
    expect(priorityHintToInt('P0')).toBe(3)
    expect(priorityHintToInt('P1')).toBe(2)
    expect(priorityHintToInt('P2')).toBe(1)
    expect(priorityHintToInt('P3')).toBe(0)
    expect(priorityHintToInt(undefined)).toBeNull()
  })
})

describe('historyImportTaskHash', () => {
  test('stable across calls with the same input', () => {
    const a = historyImportTaskHash({
      project_slug: 't1',
      project_id: '',
      title: 'submit Q3 report',
    })
    const b = historyImportTaskHash({
      project_slug: 't1',
      project_id: '',
      title: 'submit Q3 report',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^hi_[a-f0-9]{24}$/)
  })

  test('different titles → different hashes', () => {
    const a = historyImportTaskHash({
      project_slug: 't1',
      project_id: '',
      title: 'one',
    })
    const b = historyImportTaskHash({
      project_slug: 't1',
      project_id: '',
      title: 'two',
    })
    expect(a).not.toBe(b)
  })

  // Unit G7 — LOCKED id stability. `historyImportTaskHash` used a RAW 0x00 NUL
  // byte as its field separator, which made grep classify the source file as
  // binary and skip it (hiding the frozen hash-seed prefix from the leak
  // gate). G7 replaced the raw NUL with the byte-identical `\x00` escape. These
  // golden vectors were captured from the ORIGINAL raw-NUL implementation
  // (b8501a5) — they MUST NOT change, because the hash is the on-disk task `id`
  // and any drift silently re-mints every history-import task id in every
  // existing project db and breaks the idempotent re-seed guard. If this test
  // ever fails, the hash INPUT changed (a seed constant or the separator) — that
  // is a data-corrupting regression, not a test to update.
  test('golden `hi_<sha256>` ids are byte-stable across the NUL→\\x00 escape', () => {
    expect(
      historyImportTaskHash({
        project_slug: 'acme-widgets',
        project_id: 'proj_123',
        title: 'Ship the thing',
      }),
    ).toBe('hi_23a40d5e80d8da901537859e')
    expect(
      historyImportTaskHash({
        project_slug: 't1',
        project_id: '',
        title: 'submit Q3 report',
      }),
    ).toBe('hi_acfa36ca748c3aab03a44213')
    expect(
      historyImportTaskHash({ project_slug: '', project_id: '', title: '' }),
    ).toBe('hi_0e2b2bf8b4a149fc677197d1')
    expect(
      historyImportTaskHash({ project_slug: 'a', project_id: 'b', title: 'c' }),
    ).toBe('hi_8f72b6804ee0029a94c5aaab')
  })

  // Guard the separator's disambiguation property: the NUL boundary must keep
  // `(a, bc)` and `(ab, c)` from colliding. (Proves the separator is still a
  // real, non-empty delimiter and wasn't accidentally dropped.)
  test('field separator disambiguates adjacent components', () => {
    const ab_c = historyImportTaskHash({
      project_slug: 'a',
      project_id: 'b',
      title: 'c',
    })
    const a_bc = historyImportTaskHash({
      project_slug: 'a',
      project_id: '',
      title: 'bc',
    })
    expect(ab_c).not.toBe(a_bc)
  })
})

describe('seedTasksFromImportResult', () => {
  test('empty array produces no rows', async () => {
    const store = new TaskStore(db)
    const result = await seedTasksFromImportResult({
      project_slug: 't1',
      store,
      importResult: emptyImportResult(),
    })
    expect(result.created).toBe(0)
    expect(store.list({ project_slug: 't1', status: 'all', limit: 100 })).toHaveLength(0)
  })

  test('seeds every proposed task with source=history-import', async () => {
    const store = new TaskStore(db)
    const importResult: ImportResult = {
      ...emptyImportResult(),
      proposed_tasks: [
        { title: 'do A', priority_hint: 'P0' },
        { title: 'do B', priority_hint: 'P2', due_at: Date.parse('2026-07-01') },
        { title: 'do C' },
      ],
    }
    const result = await seedTasksFromImportResult({
      project_slug: 't1',
      store,
      importResult,
    })
    expect(result.created).toBe(3)
    expect(result.skipped_dupe).toBe(0)
    const rows = store.list({ project_slug: 't1', status: 'all', limit: 100 })
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.source).toBe('history-import')
      expect(r.id.startsWith('hi_')).toBe(true)
    }
    const a = rows.find((r) => r.title === 'do A')
    expect(a?.priority).toBe(3)
    const b = rows.find((r) => r.title === 'do B')
    expect(b?.priority).toBe(1)
    expect(b?.due_date).not.toBeNull()
  })

  test('idempotent — second run skips dupes', async () => {
    const store = new TaskStore(db)
    const importResult: ImportResult = {
      ...emptyImportResult(),
      proposed_tasks: [{ title: 'only one' }, { title: 'only two' }],
    }
    const r1 = await seedTasksFromImportResult({
      project_slug: 't1',
      store,
      importResult,
    })
    const r2 = await seedTasksFromImportResult({
      project_slug: 't1',
      store,
      importResult,
    })
    expect(r1.created).toBe(2)
    expect(r2.created).toBe(0)
    expect(r2.skipped_dupe).toBe(2)
    expect(store.list({ project_slug: 't1', status: 'all', limit: 100 })).toHaveLength(2)
  })

  test('skips invalid entries (empty / non-string titles)', async () => {
    const store = new TaskStore(db)
    const importResult: ImportResult = {
      ...emptyImportResult(),
      proposed_tasks: [
        { title: '' },
        { title: '   ' },
        // @ts-expect-error — testing wire-format tolerance
        { title: 42 },
        { title: 'good one' },
      ],
    }
    const result = await seedTasksFromImportResult({
      project_slug: 't1',
      store,
      importResult,
    })
    expect(result.created).toBe(1)
    expect(result.skipped_invalid).toBe(3)
  })
})
