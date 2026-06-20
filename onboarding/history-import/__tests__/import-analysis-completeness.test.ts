/**
 * 2026-06-17 (import-analysis-completeness) — regression suite for the
 * Ryan-directed import fix: the import must ANALYZE EVERY CHUNK and
 * SURVIVE transient rate-limits (no skipped analysis, no silent data loss).
 *
 *   "I dont want it to skip analysis ... that's a dumb code path and we
 *    should not have it." — Ryan, 2026-06-17
 *
 * Both tests are written to FAIL on the pre-fix code:
 *
 *   1. ANALYZE EVERY CHUNK — under the DEFAULT production import path
 *      (no `chunkOptions` opt-out), an import whose chunks are ALL under
 *      the 500-char skip floor still LLM-analyzes every chunk. Pre-fix,
 *      `chatgpt-zip` / `claude-zip` defaulted `enable_skip_llm=true`, so
 *      every thin chunk took the $0 skip fast-path and the LLM was never
 *      invoked (pass1Calls would be 0). Now pass1 is invoked per chunk and
 *      ZERO chunks are skipped.
 *
 *   2. COOLDOWN = WAIT + RETRY, NOT SKIP — when the substrate surfaces an
 *      all-credential cooldown carrying the pool's soonest `cooldown_until`
 *      (threaded as `ImportError.retry_after_ms`), the runner WAITS for the
 *      quota window, surfaces the `waiting_on_cooldown` phase +
 *      `cooldown_resume_at` to the progress UI, then RETRIES and analyzes
 *      the chunk for real — it is NEVER finalized as analyzed-with-empty.
 *      Pre-fix there was no `waiting_on_cooldown` phase / `cooldown_resume_at`
 *      signal at all.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ImportJobRunner, MAX_COOLDOWN_WAIT_MS, type SourceParser } from '../job-runner.ts'
import type { Pass1LlmCall } from '../pass1-triage.ts'
import type { Pass2LlmCall } from '../pass2-synthesis.ts'
import { ImportError, MIN_USER_CONTENT_CHARS, type ConversationRecord } from '../types.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-completeness-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Three conversations, each with well under MIN_USER_CONTENT_CHARS (500)
 * of non-assistant content — exactly the "thin" shape the old skip floor
 * dropped. Each conversation is its own chunk (chunks always start at a
 * conversation boundary), so this materializes 3 sub-floor chunks.
 */
const thinRecords: ConversationRecord[] = [
  {
    conversation_id: 'c1',
    messages: [
      { role: 'user', text: 'Follow up with Priya about the Q3 invoice.' },
      { role: 'assistant', text: 'Sure, I can help draft that.' },
    ],
  },
  {
    conversation_id: 'c2',
    messages: [
      { role: 'user', text: 'Remind me to renew the domain next week.' },
      { role: 'assistant', text: 'Done.' },
    ],
  },
  {
    conversation_id: 'c3',
    messages: [{ role: 'user', text: 'thanks' }],
  },
]

const thinParser: SourceParser = async function* () {
  for (const r of thinRecords) yield r
}

const pass2Ok: Pass2LlmCall = async () => ({
  result: {
    entities: [],
    topics: [],
    proposed_projects: [{ name: 'Topline', rationale: 'recurring' }],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  },
  dollars_billed: 0.3,
})

test('ANALYZE EVERY CHUNK — sub-floor chunks are all LLM-analyzed under the default import path (zero skips)', async () => {
  // Sanity-check the fixtures really are sub-floor (so this test would have
  // been a no-op on the pre-fix skip-default path).
  for (const r of thinRecords) {
    const nonAssistantChars = r.messages
      .filter((m) => m.role !== 'assistant')
      .reduce((acc, m) => acc + m.text.length, 0)
    expect(nonAssistantChars).toBeLessThan(MIN_USER_CONTENT_CHARS)
  }

  let pass1Calls = 0
  const seenHashes = new Set<string>()
  const pass1: Pass1LlmCall = async ({ chunk }) => {
    pass1Calls += 1
    seenHashes.add(chunk.chunk_hash)
    return {
      result: {
        candidate_entities: [{ name: 'Priya', kind: 'person', mention_count: 1 }],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.01,
    }
  }

  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2: pass2Ok,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: thinParser,
    sleep: async () => undefined,
    // CRITICAL: NO `chunkOptions` here — exercise the PRODUCTION default.
    // Pre-fix this defaulted enable_skip_llm=true for chatgpt-zip and the
    // assertions below would fail (pass1Calls === 0).
    pass1Concurrency: 1,
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  const status = await runner.status(job_id)
  expect(status?.status).toBe('completed')

  // Every chunk reached the LLM — no $0 skip fast-path taken.
  expect(pass1Calls).toBe(thinRecords.length)
  expect(seenHashes.size).toBe(thinRecords.length)

  // Every chunk row is analyzed=1 and NONE carries the skip placeholder
  // (empty candidates). Each analyzed row got the real Priya entity.
  const rows = db
    .raw()
    .query<{ analyzed: number; candidate_entities_json: string }, [string]>(
      `SELECT analyzed, candidate_entities_json FROM import_pass1_chunks WHERE project_slug = ?`,
    )
    .all('t1')
  expect(rows.length).toBe(thinRecords.length)
  for (const row of rows) {
    expect(row.analyzed).toBe(1)
    expect(row.candidate_entities_json).toContain('Priya')
  }
})

test('COOLDOWN = WAIT + RETRY — all-credential cooldown waits, emits waiting_on_cooldown, then analyzes the chunk (never finalized empty)', async () => {
  const oneRecord: ConversationRecord[] = [
    {
      conversation_id: 'cooldown-1',
      messages: [
        { role: 'user', text: 'Plan the Topline launch and follow up with the team.' },
        { role: 'assistant', text: 'On it.' },
      ],
    },
  ]
  const parser: SourceParser = async function* () {
    for (const r of oneRecord) yield r
  }

  const COOLDOWN_MS = 60_000
  let pass1Calls = 0
  const pass1: Pass1LlmCall = async () => {
    pass1Calls += 1
    if (pass1Calls === 1) {
      // Simulate the substrate's all-credential cooldown error carrying
      // the pool's soonest cooldown_until as retry_after_ms.
      const err = new ImportError(
        'substrate_error',
        null,
        'pass1 substrate error: cc-import substrate: all Anthropic credentials are in cooldown ' +
          '(429/402/401). Retry once the rate-limit window passes.',
      )
      err.retry_after_ms = COOLDOWN_MS
      throw err
    }
    // Cooldown "cleared" — the retry analyzes the chunk for real.
    return {
      result: {
        candidate_entities: [{ name: 'Topline', kind: 'company', mention_count: 2 }],
        candidate_topics: [],
        candidate_tasks: [],
        voice_signals: {},
      },
      dollars_billed: 0.02,
    }
  }

  // Capture the job's observable phase WHILE it sleeps inside the cooldown
  // window (the persistWaitingOnCooldown write happens before this.sleep).
  const observed: Array<{
    status: string
    phase: string | undefined
    cooldown_resume_at: number | undefined
  }> = []
  let runner!: ImportJobRunner
  const sleepProbe = async (_ms: number): Promise<void> => {
    const row = db
      .raw()
      .query<{ job_id: string }, []>(`SELECT job_id FROM import_jobs LIMIT 1`)
      .get()
    if (row !== null) {
      const job = await runner.status(row.job_id)
      if (job !== null) {
        observed.push({
          status: job.status,
          phase: job.phase,
          cooldown_resume_at: job.cooldown_resume_at,
        })
      }
    }
  }

  runner = new ImportJobRunner({
    db,
    pass1,
    pass2: pass2Ok,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 100, 200],
    sleep: sleepProbe,
    pass1Concurrency: 1,
    // Single small chunk — disable the skip floor here so the chunk
    // dispatches (this test exercises the cooldown path, not the floor;
    // the floor itself is covered by the first test).
    chunkOptions: { min_user_content_chars: 0 },
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  // It WAITED + RETRIED: pass1 called twice (cooldown, then success).
  expect(pass1Calls).toBe(2)

  // It emitted the waiting_on_cooldown phase with a concrete resume time
  // while parked (this is the signal the progress UI consumes).
  const waiting = observed.find((o) => o.phase === 'waiting_on_cooldown')
  expect(waiting).toBeDefined()
  expect(waiting?.status).toBe('rate_limit_cooling_off')
  expect(typeof waiting?.cooldown_resume_at).toBe('number')
  expect(waiting!.cooldown_resume_at!).toBeGreaterThan(0)

  // The job completed and the chunk was analyzed FOR REAL — never finalized
  // as analyzed-with-empty-result on cooldown.
  const status = await runner.status(job_id)
  expect(status?.status).toBe('completed')
  // Recovered → the stale cooldown signal is cleared.
  expect(status?.phase).toBeUndefined()
  expect(status?.cooldown_resume_at).toBeUndefined()

  const rows = db
    .raw()
    .query<{ analyzed: number; candidate_entities_json: string }, [string]>(
      `SELECT analyzed, candidate_entities_json FROM import_pass1_chunks WHERE project_slug = ?`,
    )
    .all('t1')
  expect(rows.length).toBe(1)
  expect(rows[0]!.analyzed).toBe(1)
  expect(rows[0]!.candidate_entities_json).toContain('Topline')
})

test('cooldown wait is bounded — a single cooldown sleep never exceeds MAX_COOLDOWN_WAIT_MS', async () => {
  // A pathological cooldown window (1 hour) must be capped per single sleep
  // so the runner never parks in one un-cancellable block; the retry cap
  // (schedule length) still governs eventual rate_limit_paused.
  const oneRecord: ConversationRecord[] = [
    {
      conversation_id: 'capped-1',
      messages: [{ role: 'user', text: 'Long cooldown please, but bounded.' }],
    },
  ]
  const parser: SourceParser = async function* () {
    for (const r of oneRecord) yield r
  }

  const sleeps: number[] = []
  const pass1: Pass1LlmCall = async () => {
    const err = new ImportError(
      'substrate_error',
      null,
      'pass1 substrate error: all Anthropic credentials are in cooldown (429/402/401).',
    )
    err.retry_after_ms = 60 * 60_000 // 1 hour
    throw err
  }

  const runner = new ImportJobRunner({
    db,
    pass1,
    pass2: pass2Ok,
    pass1Prompt: 'p1',
    pass2Prompt: 'p2',
    parse: parser,
    rateLimitBackoffMs: [0, 100, 200],
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    pass1Concurrency: 1,
    chunkOptions: { min_user_content_chars: 0 },
  })

  const { job_id } = await runner.start({
    user_id: 'u1',
    project_slug: 't1',
    source: 'chatgpt-zip',
    payload: Buffer.from(''),
  })
  await runner.awaitJob(job_id)

  // The sliced sleeper breaks each wait into ≤500ms slices, so assert the
  // SUM of slices for any single retry never exceeds the cap.
  const totalSlept = sleeps.reduce((a, b) => a + b, 0)
  // Two retries (schedule length 3 → attempts at idx 1 and 2), each capped
  // at MAX_COOLDOWN_WAIT_MS → total ≤ 2 × cap, never the raw 1h × 2.
  expect(totalSlept).toBeLessThanOrEqual(2 * MAX_COOLDOWN_WAIT_MS)
  // Exhausted → resumable pause, NOT a silent empty finalize.
  const status = await runner.status(job_id)
  expect(status?.status).toBe('rate_limit_paused')
})
