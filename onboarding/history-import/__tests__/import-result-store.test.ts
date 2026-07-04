/**
 * Golden test for the `import_results` write-back / read-on-miss helpers
 * extracted (K3, 2026-07-03) from the deleted `job-runner.ts`. Proves the
 * SQL + JSON round-trip P6 reuses survives the evacuation byte-for-byte:
 *   - persist → load returns the same result;
 *   - upsert on `job_id` overwrites (partial → full);
 *   - read-on-miss returns null;
 *   - optional interest/confidence/model columns round-trip;
 *   - a malformed legacy interests column degrades gracefully (no throw).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { loadImportResult, persistImportResult } from '../import-result-store.ts'
import type { ImportResult } from '../types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-result-store-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function fixture(over: Partial<ImportResult> = {}): ImportResult {
  return {
    entities: [{ name: 'Casey Rivera', kind: 'person', mention_count: 3 }],
    topics: [{ name: 'launch', recurrence_score: 0.8, recency_score: 0.9 }],
    proposed_projects: [{ name: 'Neutron', rationale: 'ships', suggested_topics: ['a', 'b'] }],
    proposed_tasks: [{ title: 'write plan', priority_hint: 'P1' }],
    proposed_reminders: [{ pattern: 'daily', body: 'standup' }],
    voice_signals: { tone: 'terse', verbosity: 'low', signature_phrases: ['ship it'] },
    facts: { user_role: 'founder', key_people: ['Casey Rivera'] },
    ...over,
  }
}

test('persist → load round-trips the full result', () => {
  const r = fixture({
    inferred_interests: [{ name: 'sailing' }],
    confidence_by_inference: [{ field: 'proposed_projects', score: 0.7 }],
    synthesizer_model: 'claude-opus-4-7',
  })
  ;(r as ImportResult & { conversation_count?: number }).conversation_count = 42
  return (async () => {
    await persistImportResult(db, {
      job_id: 'job-1',
      project_slug: 'general',
      source: 'chatgpt-zip',
      result: r,
      partial: false,
      now: 1_700_000_000_000,
    })
    const loaded = loadImportResult(db, 'job-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.partial).toBe(false)
    expect(loaded!.result.entities).toEqual(r.entities)
    expect(loaded!.result.topics).toEqual(r.topics)
    expect(loaded!.result.proposed_projects).toEqual(r.proposed_projects)
    expect(loaded!.result.proposed_tasks).toEqual(r.proposed_tasks)
    expect(loaded!.result.proposed_reminders).toEqual(r.proposed_reminders)
    expect(loaded!.result.voice_signals).toEqual(r.voice_signals)
    expect(loaded!.result.facts).toEqual(r.facts)
    expect(loaded!.result.inferred_interests).toEqual([{ name: 'sailing' }])
    expect(loaded!.result.confidence_by_inference).toEqual([
      { field: 'proposed_projects', score: 0.7 },
    ])
    expect(loaded!.result.synthesizer_model).toBe('claude-opus-4-7')
    expect(
      (loaded!.result as ImportResult & { conversation_count?: number }).conversation_count,
    ).toBe(42)
  })()
})

test('upsert on job_id: a partial write is overwritten by the full write', () => {
  return (async () => {
    await persistImportResult(db, {
      job_id: 'job-2',
      project_slug: 'general',
      source: 'claude-zip',
      result: fixture({ proposed_projects: [] }),
      partial: true,
      now: 1,
    })
    await persistImportResult(db, {
      job_id: 'job-2',
      project_slug: 'general',
      source: 'claude-zip',
      result: fixture({
        proposed_projects: [{ name: 'Final', rationale: 'done', suggested_topics: [] }],
      }),
      partial: false,
      now: 2,
    })
    const loaded = loadImportResult(db, 'job-2')
    expect(loaded!.partial).toBe(false)
    expect(loaded!.result.proposed_projects).toEqual([
      { name: 'Final', rationale: 'done', suggested_topics: [] },
    ])
    // Exactly one row for the job_id (upsert, not insert).
    const count = db
      .raw()
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM import_results WHERE job_id = ?`)
      .get('job-2')
    expect(count?.n).toBe(1)
  })()
})

test('read-on-miss returns null', () => {
  expect(loadImportResult(db, 'nonexistent')).toBeNull()
})

test('malformed legacy interests column degrades gracefully', () => {
  return (async () => {
    await persistImportResult(db, {
      job_id: 'job-3',
      project_slug: 'general',
      source: 'chatgpt-zip',
      result: fixture(),
      partial: false,
      now: 1,
    })
    // Simulate a legacy row whose interests column is not valid JSON.
    await db.run(`UPDATE import_results SET inferred_interests_json = ? WHERE job_id = ?`, [
      'not-json',
      'job-3',
    ])
    const loaded = loadImportResult(db, 'job-3')
    expect(loaded).not.toBeNull()
    expect(loaded!.result.inferred_interests).toBeUndefined()
    expect(loaded!.result.entities).toEqual(fixture().entities)
  })()
})
