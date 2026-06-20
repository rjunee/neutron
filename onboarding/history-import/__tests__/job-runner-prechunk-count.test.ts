/**
 * Job-runner unit test — pre-count chunks BEFORE Pass 1 begins
 * (2026-05-22 UX fix follow-up to PR #264 / v0.1.75).
 *
 * Pre-fix behavior: `pass1_chunks_total` was incremented inside the
 * chunker for-await loop alongside `pass1_chunks_done`. The user saw
 * `5/5 batches` for every tick — no real progress signal because the
 * denominator moved with the numerator.
 *
 * Post-fix: the runner materializes the entire parser → chunker
 * pipeline into a `Chunk[]` BEFORE pass1 starts, writes
 * `pass1_chunks_total` once + flips `chunks_total_known = 1`, then
 * iterates the array. The user sees a stable denominator (`0/N` →
 * `N/N`) for the entire pass.
 *
 * If pre-count throws (corrupted ZIP, transient parser error), the
 * runner falls back to the pre-fix streaming behavior with
 * `chunks_total_known = 0`. Clients render a count-only "N batches
 * processed" body in that mode (no fake denominator).
 *
 * Spec: `docs/plans/2026-05-22-001-fix-import-progress-ux-plan.md`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportError, type ConversationRecord } from '../types.ts'
import { ImportJobRunner, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-prechunk-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const FIVE_CONVOS: ConversationRecord[] = Array.from({ length: 5 }).map((_, i) => ({
  conversation_id: `c${i}`,
  messages: [
    { role: 'user', text: `Conversation ${i} about projects + people.` },
    { role: 'assistant', text: `Acknowledged conversation ${i}.` },
  ],
}))

const happyParser: SourceParser = async function* () {
  for (const r of FIVE_CONVOS) yield r
}

const pass1: Pass1LlmCall = async () => ({
  result: {
    candidate_entities: [],
    candidate_topics: [],
    candidate_tasks: [],
    voice_signals: {},
  },
  dollars_billed: 0.01,
})

const pass2: Pass2LlmCall = async () => ({
  result: {
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
  },
  dollars_billed: 0.05,
})

test('pre-count: pass1_chunks_total set ONCE upfront + chunks_total_known=true', async () => {
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: happyParser,
    // 2026-05-31 — fixtures use one-sentence messages well under the
    // 500-char pre-filter floor; disable the floor so the LLM
    // dispatches on every chunk (this test asserts pass1_chunks_done
    // tracks total, not LLM-call count).
    chunkOptions: { min_user_content_chars: 0 },
  })

  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't-prechunk',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status).not.toBeNull()
  expect(status!.status).toBe('completed')
  // 5 conversations → 5 small chunks (each well under the 50k-token
  // target so the chunker emits one chunk per conversation).
  expect(status!.pass1_chunks_done).toBe(5)
  expect(status!.pass1_chunks_total).toBe(5)
  // The flag is the primary signal — `pass1_chunks_total === done`
  // could happen incidentally in the streaming fallback at the END of
  // an import, but `chunks_total_known === true` proves the runner
  // pre-counted.
  expect(status!.chunks_total_known).toBe(true)
})

test('pre-count fallback: parser throws → chunks_total_known=false, job marked failed', async () => {
  // A parser that throws immediately on first iteration — simulating a
  // corrupted ZIP. The runner's pre-count attempt should swallow the
  // throw and re-construct the iterable for streaming mode. But the
  // streaming-mode parser call will ALSO throw (same code path), so
  // the runner's outer catch will mark the job 'failed' with the
  // observed error_code. What we're pinning here:
  //   1. The pre-count failure does NOT crash the process.
  //   2. The runner observes a sensible error_code on the final job
  //      row (not a silent 'completed' with zero entities — the
  //      "Spec is the source of truth" no-op pattern is forbidden).
  //   3. `chunks_total_known` stays at the row default `false`.
  const throwingParser: SourceParser = async function* () {
    throw new ImportError('parse_failed', 'chatgpt-zip', 'corrupted zip stub')
    // eslint-disable-next-line no-unreachable
    yield FIVE_CONVOS[0] as ConversationRecord
  }
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: throwingParser,
  })

  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't-prechunk-fail',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status).not.toBeNull()
  // Streaming-fallback parse also throws → outer catch marks 'failed'.
  // Note: the runner's "all chunks failed" branch flags 'pass1_all_failed'
  // when chunksTotal > 0 but all chunks failed mid-loop. Here the
  // parser dies BEFORE yielding a single chunk, so the outer catch
  // bubbles the original code as the substrate_error/parse_failed
  // surface. Either non-completed status is acceptable evidence that
  // the runner did NOT silently flip to 'completed' with zero data.
  expect(status!.status).not.toBe('completed')
  // The row default is `chunks_total_known = 0` and the runner never
  // gets to flip it because the materialization throws. Confirms the
  // streaming-fallback path never sets the flag.
  expect(status!.chunks_total_known).toBe(false)
})

test('pre-count: pass1_chunks_total is persisted BEFORE the first pass1 call (real progress, not after-the-fact)', async () => {
  // The whole point of the pre-count fix is that the UI sees a stable
  // denominator from the very first envelope. If we only wrote
  // `pass1_chunks_total` after the loop terminates, the user's first
  // tick would still show "0/0" → "1/1" → "2/2" — the exact pre-fix
  // pattern Sam flagged. Pin the ordering by holding the first
  // pass1 call open until we've inspected the row.
  let allowFirstPass1: (() => void) = (): void => undefined
  const firstPass1Started = new Promise<void>((resolve) => {
    allowFirstPass1 = resolve
  })
  let pass1Resolve: (() => void) = (): void => undefined
  const pass1Gate = new Promise<void>((resolve) => {
    pass1Resolve = resolve
  })
  let pass1HitOnce = false
  const gatedPass1: Pass1LlmCall = async () => {
    if (!pass1HitOnce) {
      pass1HitOnce = true
      allowFirstPass1()
      await pass1Gate
    }
    return {
      result: {
        candidate_entities: [],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.01,
    }
  }

  const runner = new ImportJobRunner({
    db,
    pass1: gatedPass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: happyParser,
    // 2026-05-31 — pin sequential ordering (pass1Concurrency=1) so the
    // first gated pass1 holds the entire pipeline open, AND disable the
    // skip_llm pre-filter so the short-fixture chunks actually dispatch
    // to the LLM (the test's whole point is "pass1_chunks_total is
    // persisted BEFORE the first pass1 call" — without an LLM call
    // there's nothing to gate on).
    pass1Concurrency: 1,
    chunkOptions: { min_user_content_chars: 0 },
  })

  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't-prechunk-ordering',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  // Wait for pass1 to start firing — at that point the runner has
  // already persisted the pre-counted total + flipped chunks_total_known.
  await firstPass1Started

  const midStatus = await runner.status(job_id)
  expect(midStatus).not.toBeNull()
  expect(midStatus!.chunks_total_known).toBe(true)
  // The runner has fired pass1 for the first chunk but is blocked
  // INSIDE the call, so pass1_chunks_done is still 0. pass1_chunks_total
  // is already 5 — exactly the "real progress denominator" property
  // the fix promises.
  expect(midStatus!.pass1_chunks_total).toBe(5)
  expect(midStatus!.pass1_chunks_done).toBe(0)

  // Release the gate so the import can complete cleanly.
  pass1Resolve()
  await runner.awaitJob(job_id)
  const finalStatus = await runner.status(job_id)
  expect(finalStatus!.status).toBe('completed')
  expect(finalStatus!.pass1_chunks_done).toBe(5)
  expect(finalStatus!.pass1_chunks_total).toBe(5)
  expect(finalStatus!.chunks_total_known).toBe(true)
})

test('pre-count fallback: parser yields then throws → streaming mode pre-count failed but later chunks discovered', async () => {
  // Parser throws AFTER yielding one chunk — this exercises the
  // "pre-count succeeds with N chunks accumulated, then crashes" path
  // where the runner discards the partial accumulation and falls back
  // to streaming. The streaming-mode call also throws after one yield
  // → ImportJobRunner records 'failed' with chunks_total_known=false.
  let invocations = 0
  const partialParser: SourceParser = async function* () {
    invocations += 1
    yield FIVE_CONVOS[0] as ConversationRecord
    throw new Error('mid-stream parser failure')
  }
  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: partialParser,
  })

  const { job_id } = await runner.start({
    user_id: 'test-user',
    project_slug: 't-prechunk-partial',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  // Parser was called twice: once for pre-count attempt, once for the
  // streaming fallback path. Proves we DID retry as the brief requires
  // ("fall back to the existing streaming behavior").
  expect(invocations).toBeGreaterThanOrEqual(2)
  const status = await runner.status(job_id)
  expect(status!.status).not.toBe('completed')
  expect(status!.chunks_total_known).toBe(false)
})
