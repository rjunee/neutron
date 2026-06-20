import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import type { ImportResult } from '../../onboarding/history-import/types.ts'
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
