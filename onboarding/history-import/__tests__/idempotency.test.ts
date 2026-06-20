/**
 * Idempotency dedup test — re-running an import skips already-analyzed
 * chunks at $0 cost. Locked behavior per § 2.3.
 *
 * v0.1.78 (2026-05-22) — pruned every budget-cap / 80%-warning test
 * (subsystem killed). The remaining tests prove the still-live core
 * primitives: chunk-hash cache, per-project scoping, cancel mid-run,
 * placeholder cleanup.
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
let pass2Calls: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-idempo-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  pass1Calls = 0
  pass2Calls = 0
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const fakeRecords: ConversationRecord[] = [
  {
    conversation_id: 'c1',
    messages: [
      { role: 'user', text: 'hello there' },
      { role: 'assistant', text: 'hi' },
    ],
  },
  {
    conversation_id: 'c2',
    messages: [
      { role: 'user', text: 'second convo about Topline' },
    ],
  },
]

const parser: SourceParser = async function* () {
  for (const r of fakeRecords) yield r
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

const pass2: Pass2LlmCall = async () => {
  pass2Calls += 1
  return {
    result: {
      proposed_projects: [{ name: 'Topline', rationale: 'recurring' }],
      proposed_tasks: [],
      proposed_reminders: [],
    },
    dollars_billed: 0.5,
  }
}

test('first run analyzes both chunks; second run hits cache and skips Pass-1', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // 2026-05-31 — disable the skip_llm pre-filter for these tests. The
    // fixtures use short messages ("hello there", "hi") which fall under
    // the 500-char production floor; these tests assert one LLM call per
    // chunk, so the floor would skip the LLM and break the assertion.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const first = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(first.job_id)
  const firstStatus = await runner.status(first.job_id)
  expect(firstStatus?.status).toBe('completed')
  expect(pass1Calls).toBe(2)
  expect(pass2Calls).toBe(1)
  expect(firstStatus?.pass1_chunks_done).toBe(2)

  // Second run: should hit chunk_hash cache and re-use Pass-1 results
  // at $0 cost, but Pass-2 still runs.
  const second = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(second.job_id)
  const secondStatus = await runner.status(second.job_id)
  expect(secondStatus?.status).toBe('completed')
  expect(pass1Calls).toBe(2) // unchanged — chunks were cached
  expect(pass2Calls).toBe(2) // Pass-2 always runs
  expect(secondStatus?.pass1_chunks_done).toBe(2)
})

test('Pass-1 cache lookups are scoped per project (Codex r3 P1 fix)', async () => {
  // Same chunk text imported by two different owners should produce
  // two billable Pass-1 calls — the cache row for owner 1 must NOT
  // satisfy owner 2's lookup.
  let calls = 0
  const countingPass1: Pass1LlmCall = async () => {
    calls += 1
    return {
      result: { candidate_entities: [], candidate_topics: [], candidate_tasks: [], voice_signals: {} },
      dollars_billed: 0.05,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: countingPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // 2026-05-31 — disable the skip_llm pre-filter for these tests. The
    // fixtures use short messages ("hello there", "hi") which fall under
    // the 500-char production floor; these tests assert one LLM call per
    // chunk, so the floor would skip the LLM and break the assertion.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const t1 = await runner.start({
    user_id: 'test-user',
    project_slug: 'project-A',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(t1.job_id)
  expect(calls).toBe(2) // Two chunks for owner-A
  // Now owner-B imports the same content. Cache should NOT hit.
  const t2 = await runner.start({
    user_id: 'test-user',
    project_slug: 'project-B',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(t2.job_id)
  expect(calls).toBe(4) // owner-B paid for its own analysis
})

test('cancel() mid-run stops new chunks from launching (Codex r1 P1 fix)', async () => {
  let pass1Seen = 0
  const slowPass1: Pass1LlmCall = async () => {
    pass1Seen += 1
    return {
      result: { candidate_entities: [], candidate_topics: [], candidate_tasks: [], voice_signals: {} },
      dollars_billed: 0.05,
    }
  }
  const runner = new ImportJobRunner({
    db,
    pass1: slowPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // 2026-05-31 — disable the skip_llm pre-filter for these tests. The
    // fixtures use short messages ("hello there", "hi") which fall under
    // the 500-char production floor; these tests assert one LLM call per
    // chunk, so the floor would skip the LLM and break the assertion.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.cancel(job_id)
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  expect(status?.status).toBe('cancelled')
  expect(pass1Seen).toBeLessThanOrEqual(1)
})

test('cached chunks land in import_pass1_chunks with chunk_hash PK', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // 2026-05-31 — disable the skip_llm pre-filter for these tests. The
    // fixtures use short messages ("hello there", "hi") which fall under
    // the 500-char production floor; these tests assert one LLM call per
    // chunk, so the floor would skip the LLM and break the assertion.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const result = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(result.job_id)
  const rows = db
    .raw()
    .query<{ chunk_hash: string }, []>(
      `SELECT chunk_hash FROM import_pass1_chunks ORDER BY chunk_hash`,
    )
    .all()
  expect(rows.length).toBe(2)
  for (const r of rows) expect(r.chunk_hash).toMatch(/^[0-9a-f]{64}$/)
})

test('dollars_spent accumulates for telemetry even though nothing reads it for enforcement', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    // 2026-05-31 — disable the skip_llm pre-filter for these tests. The
    // fixtures use short messages ("hello there", "hi") which fall under
    // the 500-char production floor; these tests assert one LLM call per
    // chunk, so the floor would skip the LLM and break the assertion.
    chunkOptions: { min_user_content_chars: 0 },
  })
  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)
  const status = await runner.status(job_id)
  // 2 Pass-1 chunks @ $0.05 + 1 Pass-2 @ $0.50 = $0.60
  expect(status?.dollars_spent).toBeCloseTo(0.6, 2)
})
