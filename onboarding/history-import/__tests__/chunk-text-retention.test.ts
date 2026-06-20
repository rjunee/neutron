/**
 * Item 4 (post-onboarding-experience spec § ITEM 4 / § 4.2b) — raw
 * transcript retention.
 *
 * Migration 0063 adds `import_pass1_chunks.chunk_text`; the runner's
 * claim INSERT persists the raw chunk markdown at claim time so the
 * project materializer can slice it per project after onboarding. The
 * ON CONFLICT branch backfills chunk_text onto cache-hit rows from
 * PRE-retention imports (NULL chunk_text) without disturbing the $0
 * idempotency dedup.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'
import type { ConversationRecord } from '../types.ts'

let tmp: string
let db: ProjectDb
let pass1Calls: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-chunk-text-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  pass1Calls = 0
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const records: ConversationRecord[] = [
  {
    conversation_id: 'c1',
    messages: [
      { role: 'user', text: 'how should we price the Topline invoicing tiers?' },
      { role: 'assistant', text: 'three tiers, anchor the middle one' },
    ],
  },
]

const parser: SourceParser = async function* () {
  for (const r of records) yield r
}

const pass1: Pass1LlmCall = async () => {
  pass1Calls += 1
  return {
    result: {
      candidate_entities: [{ name: 'Topline', kind: 'company', mention_count: 1 }],
      candidate_topics: [],
      candidate_tasks: [],
      voice_signals: {},
    },
    dollars_billed: 0.05,
  }
}

const pass2: Pass2LlmCall = async () => ({
  result: { proposed_projects: [], proposed_tasks: [], proposed_reminders: [] },
  dollars_billed: 0.5,
})

function buildRunner(): ImportJobRunner {
  return new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    chunkOptions: { min_user_content_chars: 0 },
  })
}

async function runImport(runner: ImportJobRunner): Promise<void> {
  const job = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job.job_id)
  const status = await runner.status(job.job_id)
  expect(status?.status).toBe('completed')
}

function readChunkTexts(): Array<{ chunk_text: string | null; analyzed: number }> {
  return db
    .prepare<{ chunk_text: string | null; analyzed: number }, []>(
      `SELECT chunk_text, analyzed FROM import_pass1_chunks ORDER BY conversation_id, chunk_index`,
    )
    .all()
}

test('an import run retains the raw chunk text on import_pass1_chunks', async () => {
  await runImport(buildRunner())
  const rows = readChunkTexts()
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.analyzed).toBe(1)
    expect(row.chunk_text ?? '').toContain('Topline invoicing tiers')
  }
})

test('re-import backfills NULL chunk_text on pre-retention cache rows at $0 LLM cost', async () => {
  const runner = buildRunner()
  await runImport(runner)
  const callsAfterFirst = pass1Calls
  expect(callsAfterFirst).toBeGreaterThan(0)

  // Simulate a PRE-retention row: the import ran before migration 0063,
  // so the analyzed cache row exists but carries no raw text.
  db.raw().run(`UPDATE import_pass1_chunks SET chunk_text = NULL`)
  expect(readChunkTexts().every((r) => r.chunk_text === null)).toBe(true)

  await runImport(runner)
  // Cache hit — Pass-1 never re-billed…
  expect(pass1Calls).toBe(callsAfterFirst)
  // …but the raw text is retained again.
  for (const row of readChunkTexts()) {
    expect(row.chunk_text ?? '').toContain('Topline invoicing tiers')
    expect(row.analyzed).toBe(1)
  }
})
