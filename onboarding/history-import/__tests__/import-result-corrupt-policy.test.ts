/**
 * P11 (world-class refactor, 2026-07) — corrupt-policy pins for the
 * `import_results` JSON-column codec routing.
 *
 * The loader now decodes each `*_json` column through the shared
 * `parseJsonColumn` codec instead of a hand-rolled `JSON.parse`. This test
 * pins the TWO divergent corrupt-policies the columns carry, BYTE-FOR-BYTE:
 *   - CORE fields (entities_json, …): `onCorrupt: 'throw'` — a malformed core
 *     column is a hard data-integrity failure and propagates the SyntaxError.
 *   - LEGACY inference fields (inferred_interests_json,
 *     confidence_by_inference_json): silent skip — a malformed column leaves
 *     the optional field unset (no throw).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { loadImportResult, persistImportResult } from '../import-result-store.ts'
import type { ImportResult } from '../types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-p11-import-'))
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
    proposed_projects: [{ name: 'Neutron', rationale: 'ships', suggested_topics: ['a'] }],
    proposed_tasks: [{ title: 'write plan', priority_hint: 'P1' }],
    proposed_reminders: [{ pattern: 'daily', body: 'standup' }],
    voice_signals: { tone: 'terse', verbosity: 'low', signature_phrases: ['ship it'] },
    facts: { user_role: 'founder', key_people: ['Casey Rivera'] },
    ...over,
  }
}

async function seed(job_id: string, r: ImportResult): Promise<void> {
  await persistImportResult(db, {
    job_id,
    owner_slug: 'general',
    source: 'chatgpt-zip',
    result: r,
    partial: false,
    now: 1_700_000_000_000,
  })
}

test('parse-ok: valid core columns round-trip through the codec', async () => {
  await seed('job-ok', fixture())
  const loaded = loadImportResult(db, 'job-ok')
  expect(loaded).not.toBeNull()
  expect(loaded!.result.entities).toEqual(fixture().entities)
})

test("corrupt-policy: a malformed CORE column throws (onCorrupt: 'throw')", async () => {
  await seed('job-core', fixture())
  await db.run(`UPDATE import_results SET entities_json = '{oops' WHERE job_id = ?`, ['job-core'])
  expect(() => loadImportResult(db, 'job-core')).toThrow(SyntaxError)
})

test('corrupt-policy: a malformed LEGACY inference column is silently skipped (no throw)', async () => {
  await seed(
    'job-legacy',
    fixture({
      inferred_interests: [{ name: 'sailing' }],
    }),
  )
  await db.run(
    `UPDATE import_results SET inferred_interests_json = '{oops' WHERE job_id = ?`,
    ['job-legacy'],
  )
  const loaded = loadImportResult(db, 'job-legacy')
  // Core fields still load; the malformed optional field is left unset.
  expect(loaded).not.toBeNull()
  expect(loaded!.result.entities).toEqual(fixture().entities)
  expect(loaded!.result.inferred_interests).toBeUndefined()
})
