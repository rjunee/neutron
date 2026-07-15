/**
 * @neutronai/gateway/wiring — build-synthesis-import-runner tests
 * (Step 2b cut-over, 2026-06-17).
 *
 * Verifies the bridge that makes the interview engine's `ImportJobRunnerHook`
 * drive the ONE accumulating synthesis session instead of the retired
 * per-chunk runner:
 *   - `start` → `status` polling reaches `completed` carrying an `ImportResult`
 *     mapped from the synthesis user-model (proposed_projects + key_people) so
 *     the engine's `import_analysis_presented` body is grounded in the import.
 *   - The synthesis session is what runs (the injected `SynthesisRunner`'s
 *     `synthesizeImport` fired) — NOT a per-chunk Pass-1/Pass-2 pipeline.
 *   - The live flow writes per-project seed files (STATUS.md on disk).
 *   - No `/clear` is ever dispatched on the live import path.
 *   - The LLM-less box (null substrate → null synthesis) fails the job
 *     gracefully so the engine routes to gap-fill.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Substrate, AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type {
  ConversationRecord,
  ImportJob,
  ImportSource,
} from '@neutronai/onboarding/history-import/types.ts'
import {
  MemoryRawTranscriptStore,
  type ProjectSeed,
  type SynthesisResult,
  type WriteProjectSeedOutcome,
} from '@neutronai/onboarding/synthesis/index.ts'
import { buildSynthesisSession, type SynthesisRunner } from '../build-synthesis-session.ts'
import {
  buildSynthesisImportJobRunner,
  synthesisResultToImportResult,
} from '../build-synthesis-import-runner.ts'

const tmpDirs: string[] = []
const openDbs: ProjectDb[] = []
function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synth-import-runner-'))
  tmpDirs.push(dir)
  return dir
}
function freshDb(): ProjectDb {
  const dbPath = join(freshTmp(), 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  openDbs.push(db)
  return db
}
afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

/** Drive the background job to a terminal state. */
async function pollToTerminal(
  runner: ReturnType<typeof buildSynthesisImportJobRunner>,
  job_id: string,
): Promise<ImportJob> {
  for (let i = 0; i < 200; i += 1) {
    const job = await runner.status(job_id)
    if (job !== null && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
      return job
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('synthesis import job never reached a terminal state')
}

const SYNTH_RESULT: SynthesisResult = {
  source: 'import',
  user_model: {
    summary: 'You run Topline Hospitality with Priya.',
    projects: [
      {
        slug: 'topline',
        name: 'Topline Hospitality',
        status: 'active',
        overview: 'Hospitality sales pipeline; Q3 invoice work with Priya.',
        open_threads: ['Q3 invoice to Priya'],
        conversation_ids: ['c-topline-1'],
      },
    ],
    people: ['Priya Shah'],
    open_threads: ['Q3 invoice to Priya'],
    tasks: ['Reply to Priya about the Q3 invoice'],
    style: { tone: 'terse' },
  },
  project_seeds: [
    {
      slug: 'topline',
      name: 'Topline Hospitality',
      status: 'active',
      overview: 'Hospitality sales pipeline; Q3 invoice work with Priya.',
      open_threads: ['Q3 invoice to Priya'],
      conversation_ids: ['c-topline-1'],
    },
  ],
  batches_read: 2,
  read_passes_attempted: 2,
  read_passes_succeeded: 2,
  factory_constructions: 1,
}

async function* fakeRecords(): AsyncIterable<ConversationRecord> {
  yield {
    conversation_id: 'c-topline-1',
    title: 'Topline pipeline',
    created_at: Date.parse('2026-05-01T00:00:00Z'),
    messages: [{ role: 'user', text: 'Topline Hospitality Q3 invoice to Priya is overdue.' }],
  }
}

describe('buildSynthesisImportJobRunner — synthesis → engine bridge', () => {
  test('engine hook drives the synthesis session (synthesizeImport fired) and maps the user-model to ImportResult', async () => {
    const synthCalls: number[] = []
    const seedsWritten: ProjectSeed[] = []
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        synthCalls.push(1)
        return SYNTH_RESULT
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        seedsWritten.push(seed)
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    let parseCalls = 0
    const runner = buildSynthesisImportJobRunner({
      db: freshDb(),
      synthesis: fakeSynthesis,
      parse: (_source: ImportSource) => {
        parseCalls += 1
        return fakeRecords()
      },
    })

    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip-bytes'),
    })
    const job = await pollToTerminal(runner, job_id)

    // The SYNTHESIS session ran — NOT a per-chunk Pass-1/Pass-2 pipeline.
    expect(synthCalls.length).toBe(1)
    expect(parseCalls).toBe(1)
    expect(job.status).toBe('completed')
    // The engine reads `result.proposed_projects[].name` into primary_projects
    // and surfaces the analysis body off it — grounded in the imported history.
    expect(job.result?.proposed_projects.map((p) => p.name)).toEqual(['Topline Hospitality'])
    expect(job.result?.facts.key_people).toContain('Priya Shah')
    expect(job.result?.voice_signals.tone).toBe('terse')

    // Seeds written with the slug ALIGNED to the canonical project-id
    // slugifier (so the synthesized repo lines up with the materializer).
    expect(seedsWritten.map((s) => s.slug)).toEqual(['topline-hospitality'])
  })

  test('progress: onProgress writes advancing pass1_chunks to the import_jobs row (not stranded at 0/0)', async () => {
    const db = freshDb()
    // The runner passes the synthesis runner a real `onProgress` that persists
    // advancing read-pass counts to the import_jobs row SYNCHRONOUSLY (so
    // `sendImportProgress` emits a moving pct + known=true instead of the
    // dogfood `pct=0.00 known=false`). Drive ticks from the fake and assert each
    // one reached the DB row immediately (only one row in this test DB).
    const readProgress = (): {
      done: number
      total: number
      known: number
      status: string
    } => {
      const row = db
        .raw()
        .query<{ done: number; total: number; known: number; status: string }, []>(
          `SELECT pass1_chunks_done AS done, pass1_chunks_total AS total,
                  chunks_total_known AS known, status
             FROM import_jobs LIMIT 1`,
        )
        .get()
      if (row === null) throw new Error('no import_jobs row')
      return row
    }
    const seen: Array<{ done: number; total: number; known: number }> = []
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(
        _records: AsyncIterable<ConversationRecord>,
        onProgress?: (done: number, total: number) => void,
      ): Promise<SynthesisResult> {
        expect(onProgress).toBeDefined()
        onProgress?.(0, 3)
        seen.push((({ done, total, known }) => ({ done, total, known }))(readProgress()))
        onProgress?.(2, 3)
        seen.push((({ done, total, known }) => ({ done, total, known }))(readProgress()))
        return { ...SYNTH_RESULT, batches_read: 3 }
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    const runner = buildSynthesisImportJobRunner({
      db,
      synthesis: fakeSynthesis,
      parse: () => fakeRecords(),
    })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)

    // Each progress tick advanced the row immediately (known flipped to 1, done
    // moved 0 → 2), proving the bar is no longer stuck at known=false / 0.
    expect(seen[0]).toEqual({ done: 0, total: 3, known: 1 })
    expect(seen[1]).toEqual({ done: 2, total: 3, known: 1 })
    // Completion finalizes the row at the full batch count.
    expect(job.status).toBe('completed')
    const final = readProgress()
    expect(final.done).toBe(3)
    expect(final.total).toBe(3)
    expect(final.known).toBe(1)
  })

  test('LIVE flow writes per-project seed files (STATUS.md on disk) through a real synthesis session', async () => {
    const ownerHome = freshTmp()
    const dispatched: string[] = []
    const substrate: Substrate = {
      start(spec: AgentSpec): SessionHandle {
        dispatched.push(spec.prompt)
        let body = '{}'
        if (spec.prompt.includes('read pass')) {
          const ids = [...spec.prompt.matchAll(/id=(\S+)/g)].map((m) => m[1])
          body = JSON.stringify({
            projects: [
              {
                slug: 'topline',
                name: 'Topline Hospitality',
                status: 'active',
                overview: 'Hospitality sales pipeline.',
                open_threads: ['Q3 invoice to Priya'],
              },
            ],
            people: ['Priya Shah'],
            routing: ids.map((id) => ({ conversation_id: id, project_slugs: ['topline'] })),
          })
        } else if (spec.prompt.includes('accumulated model')) {
          body = JSON.stringify({ summary: 'You run Topline Hospitality.', style: { tone: 'terse' } })
        }
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          yield { kind: 'token', text: body }
          yield {
            kind: 'completion',
            usage: { input_tokens: 5, output_tokens: 5 },
            substrate_instance_id: 'cc-synthesis-fake',
          }
        })()
        return {
          events,
          respondToTool: async () => undefined,
          cancel: async () => undefined,
          tool_resolution: 'internal',
        }
      },
    }
    const synthesis = buildSynthesisSession({ substrate, owner_home: ownerHome, timeout_ms: 5000 })
    const runner = buildSynthesisImportJobRunner({ db: freshDb(), synthesis, parse: () => fakeRecords() })

    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)
    expect(job.status).toBe('completed')

    // The project repo is pre-populated from the synthesis seed material under
    // the canonical-slug folder (Topline Hospitality → topline-hospitality).
    const statusPath = join(ownerHome, 'Projects', 'topline-hospitality', 'STATUS.md')
    expect(existsSync(statusPath)).toBe(true)
    expect(readFileSync(statusPath, 'utf8')).toContain('Topline Hospitality')

    // No `/clear` was EVER dispatched on the live import path — the substrate
    // accumulates; `reset_context_per_turn` is retired.
    for (const p of dispatched) expect(p).not.toContain('/clear')
  })

  test('LLM-less box (null substrate → null synthesis) fails the job gracefully', async () => {
    const ownerHome = freshTmp()
    const synthesis = buildSynthesisSession({ substrate: null, owner_home: ownerHome })
    const runner = buildSynthesisImportJobRunner({ db: freshDb(), synthesis, parse: () => fakeRecords() })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)
    // Failed (not silently completed-empty) so the engine routes to gap-fill.
    expect(job.status).toBe('failed')
    expect(job.error_code).toBe('substrate_error')
  })

  test('honest failure: every read pass failed (attempted>0, succeeded=0, no projects) → failed, NOT empty completed', async () => {
    // The production "empty wow" signature: synthesis returned, but read every
    // pass timed out so it has no projects + a derived summary. The runner must
    // NOT mark this `completed` (which would present a blank "here's what I see:")
    // — it surfaces `failed` so the engine routes to the graceful retry/skip UX.
    const emptyResult: SynthesisResult = {
      source: 'import',
      user_model: {
        summary: 'Welcome to Neutron.',
        projects: [],
        people: [],
        open_threads: [],
        tasks: [],
        style: {},
      },
      project_seeds: [],
      batches_read: 3,
      read_passes_attempted: 3,
      read_passes_succeeded: 0,
      factory_constructions: 1,
    }
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return emptyResult
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: [], transcripts_written: 0 }
      },
    }
    const runner = buildSynthesisImportJobRunner({
      db: freshDb(),
      synthesis: fakeSynthesis,
      parse: () => fakeRecords(),
    })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)
    expect(job.status).toBe('failed')
    expect(job.error_code).toBe('pass1_all_failed')
    // No empty ImportResult is surfaced for a failed job.
    expect(job.result).toBeUndefined()
  })

  test('honestly-empty export (attempted=0) still COMPLETES (not a failure)', async () => {
    // A genuinely empty history (no conversations to read) is not a failure —
    // attempted===0 → the engine handles an empty import gracefully downstream.
    const emptyExport: SynthesisResult = {
      source: 'import',
      user_model: {
        summary: 'Welcome to Neutron.',
        projects: [],
        people: [],
        open_threads: [],
        tasks: [],
        style: {},
      },
      project_seeds: [],
      batches_read: 0,
      read_passes_attempted: 0,
      read_passes_succeeded: 0,
      factory_constructions: 1,
    }
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return emptyExport
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: [], transcripts_written: 0 }
      },
    }
    const runner = buildSynthesisImportJobRunner({
      db: freshDb(),
      synthesis: fakeSynthesis,
      parse: () => fakeRecords(),
    })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)
    expect(job.status).toBe('completed')
  })

  test('P6 durability: completed result is persisted to import_results in the SAME write as status=completed', async () => {
    const db = freshDb()
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return SYNTH_RESULT
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    const runner = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    const job = await pollToTerminal(runner, job_id)
    expect(job.status).toBe('completed')

    // The durable `import_results` row landed atomically with the completed flip:
    // whenever status='completed', a result row exists (assert row CONTENT, not a
    // call count). Pre-P6 this row was never written (result held only in RAM).
    const row = db
      .raw()
      .query<
        { status: string; projects_json: string; facts_json: string; voice_signals_json: string },
        [string]
      >(
        `SELECT j.status AS status, r.projects_json AS projects_json,
                r.facts_json AS facts_json, r.voice_signals_json AS voice_signals_json
           FROM import_jobs j JOIN import_results r ON r.job_id = j.job_id
          WHERE j.job_id = ?`,
      )
      .get(job_id)
    expect(row).not.toBeNull()
    expect(row?.status).toBe('completed')
    const projects = JSON.parse(row?.projects_json ?? '[]') as Array<{ name: string }>
    expect(projects.map((p) => p.name)).toEqual(['Topline Hospitality'])
    const facts = JSON.parse(row?.facts_json ?? '{}') as { key_people?: string[] }
    expect(facts.key_people).toContain('Priya Shah')
    const voice = JSON.parse(row?.voice_signals_json ?? '{}') as { tone?: string }
    expect(voice.tone).toBe('terse')
  })

  test('P6 durability: a restart (fresh runner, cold in-process cache) recovers the completed result from the durable row', async () => {
    const db = freshDb()
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return SYNTH_RESULT
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    // Process 1: run the import to completion.
    const runner1 = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })
    const { job_id } = await runner1.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })
    expect((await pollToTerminal(runner1, job_id)).status).toBe('completed')

    // Process 2 (the "restart"): a BRAND-NEW runner over the SAME db has an EMPTY
    // in-process `results` Map + no live `runJob` promise — exactly the state a
    // process restart leaves. Pre-P6 `status()` read only the RAM Map, so
    // `job.result` came back undefined and the paid synthesis was silently lost.
    const runner2 = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })

    const resumed = await runner2.status(job_id)
    expect(resumed?.status).toBe('completed')
    // Assert the RESUMED result content — the read-on-miss reconstructed the full
    // ImportResult from `import_results`, not just that a call happened.
    expect(resumed?.result?.proposed_projects.map((p) => p.name)).toEqual(['Topline Hospitality'])
    expect(resumed?.result?.facts.key_people).toContain('Priya Shah')
    expect(resumed?.result?.voice_signals.tone).toBe('terse')

    // synthesizeOnDemand also recovers from the durable row post-restart.
    const onDemand = await runner2.synthesizeOnDemand(job_id)
    expect(onDemand?.proposed_projects.map((p) => p.name)).toEqual(['Topline Hospitality'])
  })

  test('P6 durability: a failure on the completion write ROLLS BACK the persisted result (one transaction, not two independent writes)', async () => {
    const real = freshDb()
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return SYNTH_RESULT
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    // Inject a failure on the `status='completed'` UPDATE — the SECOND write in the
    // completion transaction, AFTER `persistImportResult` has already inserted the
    // `import_results` row into the SAME tx. If the two writes were independent, the
    // persisted row would survive; because they share ONE transaction, the failed
    // completion flip must roll the persisted result back too. (A revert of the
    // shared-transaction wrapping makes this test go red: the import_results row
    // would survive the failed flip.)
    let intercepted = false
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (userCb: (tx: unknown) => Promise<unknown>) =>
            (target as ProjectDb).transaction(async (tx) => {
              const wrappedTx = new Proxy(tx as unknown as Record<string, unknown>, {
                get(t, p) {
                  // The completion flip is a `runSync`; persistImportResult's INSERT
                  // is an async `run` (must pass through). Throw only on the flip.
                  if (p === 'runSync') {
                    return (sql: string, params?: unknown[]) => {
                      if (typeof sql === 'string' && sql.includes("status = 'completed'")) {
                        intercepted = true
                        throw new Error('injected: completion write failed')
                      }
                      return (t['runSync'] as (s: string, pp?: unknown[]) => unknown)(sql, params)
                    }
                  }
                  const v = t[p as string]
                  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
                },
              })
              return userCb(wrappedTx)
            })
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    }) as unknown as ProjectDb

    const runner = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })

    // Wait for the fire-and-forget runJob to reach + fail the completion transaction,
    // then let the ROLLBACK + rejection unwind.
    for (let i = 0; i < 400 && !intercepted; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(intercepted).toBe(true)
    await new Promise((r) => setTimeout(r, 30))

    // The persisted `import_results` row was rolled back WITH the failed flip.
    const resultRow = real
      .raw()
      .query<{ job_id: string }, [string]>(`SELECT job_id FROM import_results WHERE job_id = ?`)
      .get(job_id)
    expect(resultRow).toBeNull()
    // And the job never reached 'completed' (the flip was rolled back).
    const jobRow = real
      .raw()
      .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
      .get(job_id)
    expect(jobRow?.status).not.toBe('completed')
  })

  test('P6 cancel race: a cancel landing during seed writes is NOT resurrected to completed (nor left with a persisted result)', async () => {
    const db = freshDb()
    // `writeSeed` runs in the synchronous seed loop AFTER the top-of-runJob cancel
    // pre-check but BEFORE the completion transaction — the exact window a late
    // cancel lands in. Simulate the cancel winning by flipping the in-flight row to
    // 'cancelled' here (this is the row state `runner.cancel()` produces).
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        return SYNTH_RESULT
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        db.raw().run(
          `UPDATE import_jobs SET status = 'cancelled', completed_at = 1 WHERE status = 'pass1-running'`,
        )
        return { project_slug: seed.slug, reason: 'created', docs_written: ['STATUS.md'], transcripts_written: 1 }
      },
    }
    const runner = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })

    // Wait until the row is terminal (the simulated cancel), then let the completion
    // transaction run + lose the guarded race + roll back.
    await pollToTerminal(runner, job_id)
    await new Promise((r) => setTimeout(r, 60))

    // The completion did NOT clobber the cancel.
    const status = db
      .raw()
      .query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`)
      .get(job_id)?.status
    expect(status).toBe('cancelled')
    // And no result was persisted (the persist rolled back with the lost flip).
    const resultRow = db
      .raw()
      .query<{ job_id: string }, [string]>(`SELECT job_id FROM import_results WHERE job_id = ?`)
      .get(job_id)
    expect(resultRow).toBeNull()
  })

  test('P6 cancel race: a cancel is NOT overwritten by a subsequent synthesis FAILURE (finishFailed guard)', async () => {
    const db = freshDb()
    let rejectSynthesis: (err: Error) => void = () => {}
    const gate = new Promise<SynthesisResult>((_, reject) => {
      rejectSynthesis = reject
    })
    const fakeSynthesis: SynthesisRunner = {
      rawStore: new MemoryRawTranscriptStore(),
      async synthesizeImport(): Promise<SynthesisResult> {
        // Block until the test rejects — the window a cancel lands in.
        return gate
      },
      async synthesizeInterviewOnly(): Promise<SynthesisResult | null> {
        return null
      },
      writeSeed(seed: ProjectSeed): WriteProjectSeedOutcome {
        return { project_slug: seed.slug, reason: 'created', docs_written: [], transcripts_written: 0 }
      },
    }
    const runner = buildSynthesisImportJobRunner({ db, synthesis: fakeSynthesis, parse: () => fakeRecords() })
    const { job_id } = await runner.start({
      project_slug: 'owner',
      user_id: 'u-owner',
      source: 'claude-zip',
      payload: Buffer.from('zip'),
    })

    // Wait until runJob is parked in synthesizeImport (status flipped to pass1-running).
    const statusOf = (): string | undefined =>
      db.raw().query<{ status: string }, [string]>(`SELECT status FROM import_jobs WHERE job_id = ?`).get(job_id)?.status
    for (let i = 0; i < 200 && statusOf() !== 'pass1-running'; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(statusOf()).toBe('pass1-running')

    // Cancel wins the race → status='cancelled'.
    await runner.cancel(job_id)
    expect(statusOf()).toBe('cancelled')

    // Now synthesis REJECTS → the catch calls finishFailed. The guard must leave the
    // terminal 'cancelled' intact (pre-guard this overwrote it with 'failed').
    rejectSynthesis(new Error('synthesis boom'))
    await new Promise((r) => setTimeout(r, 60))

    expect(statusOf()).toBe('cancelled')
  })

  test('synthesisResultToImportResult maps projects, tasks, people, and voice', () => {
    const mapped = synthesisResultToImportResult(SYNTH_RESULT)
    expect(mapped.proposed_projects).toEqual([
      {
        name: 'Topline Hospitality',
        rationale: 'Hospitality sales pipeline; Q3 invoice work with Priya.',
        suggested_topics: ['Q3 invoice to Priya'],
      },
    ])
    expect(mapped.proposed_tasks).toEqual([{ title: 'Reply to Priya about the Q3 invoice' }])
    expect(mapped.entities).toEqual([{ name: 'Priya Shah', kind: 'person', mention_count: 1 }])
    expect(mapped.facts.key_people).toEqual(['Priya Shah'])
  })
})

// ── Regression guard: raw-transcript materialization on a fresh instance ──────
//
// 2026-06-18 (import-transcript ENOENT root-cause fix). LIVE forensic: a real
// import of `synthetic-medium-chatgpt.zip` failed with
//   substrate_error: ENOENT ... raw-transcripts/synthetic-conv-0001.md
// and ZERO files in `<owner_home>/imports/raw-transcripts/`. Root cause: the
// `DiskRawTranscriptStore` mkdir'd ONLY in its constructor (landing-stack BOOT),
// so on a fresh / throwaway instance the `<owner_home>/imports/` subtree was
// absent at WRITE time and the very first `put` (conv in iteration order) threw
// ENOENT — the pre-pass died before a single transcript landed, so synthesis
// failed before pass 1. These tests exercise the FULL synthesis import over the
// REAL fixture zips through the default zip parser, with `<owner_home>/imports/`
// REMOVED after the store is constructed (the fresh-instance condition), and
// assert (a) every parsed conversation's transcript is written, (b) those files
// open without ENOENT, and (c) the job reaches `completed` with a non-empty
// user-model — the exact path that regressed.
const FIXTURES = join(import.meta.dir, '..', '..', '..', 'onboarding', 'history-import', '__fixtures__')

/** Accumulating substrate that answers read-pass + consolidation turns from the
 *  prompt alone (no real LLM), routing every conversation it is shown into one
 *  project so the synthesis yields a non-empty user-model. */
function fakeAccumulatingSubstrate(dispatched: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      dispatched.push(spec.prompt)
      let body = '{}'
      if (spec.prompt.includes('read pass')) {
        const ids = [...spec.prompt.matchAll(/id=(\S+)/g)].map((m) => m[1])
        body = JSON.stringify({
          projects: [
            {
              slug: 'imported',
              name: 'Imported Work',
              status: 'active',
              overview: 'Recurring effort surfaced from the imported history.',
              open_threads: ['Follow up on the import'],
            },
          ],
          people: ['Priya Shah'],
          routing: ids.map((id) => ({ conversation_id: id, project_slugs: ['imported'] })),
        })
      } else if (spec.prompt.includes('accumulated model')) {
        body = JSON.stringify({ summary: 'You run Imported Work.', style: { tone: 'terse' } })
      }
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: body }
        yield {
          kind: 'completion',
          usage: { input_tokens: 5, output_tokens: 5 },
          substrate_instance_id: 'cc-synthesis-fake',
        }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
}

describe('buildSynthesisImportJobRunner — raw transcripts materialize on a fresh instance', () => {
  for (const fx of [
    { source: 'chatgpt-zip' as ImportSource, file: 'synthetic-medium-chatgpt.zip', conversations: 50 },
    { source: 'claude-zip' as ImportSource, file: 'synthetic-claude-export.zip', conversations: 8 },
  ]) {
    test(`${fx.source}: transcripts written + import COMPLETES even when <owner_home>/imports was absent at write time`, async () => {
      const ownerHome = freshTmp()
      const rawDir = join(ownerHome, 'imports', 'raw-transcripts')
      const dispatched: string[] = []
      const substrate = fakeAccumulatingSubstrate(dispatched)
      // Construct the synthesis (this mkdir's rawDir at "boot")...
      const synthesis = buildSynthesisSession({ substrate, owner_home: ownerHome, timeout_ms: 5000 })
      // ...then SIMULATE the fresh-instance condition: the imports subtree is
      // gone by the time the import actually writes (the live-forensic state).
      rmSync(join(ownerHome, 'imports'), { recursive: true, force: true })
      expect(existsSync(rawDir)).toBe(false)

      // No `parse` override → the DEFAULT zip parser dispatches the real source,
      // exactly as production does. The payload is the REAL fixture buffer.
      const runner = buildSynthesisImportJobRunner({ db: freshDb(), synthesis })
      const payload = readFileSync(join(FIXTURES, fx.file))
      const { job_id } = await runner.start({
        project_slug: 'owner',
        user_id: 'u-owner',
        source: fx.source,
        payload,
      })
      const job = await pollToTerminal(runner, job_id)

      // (a) every parsed conversation's transcript was materialized — no ENOENT.
      const files = readdirSync(rawDir).filter((f) => f.endsWith('.md'))
      expect(files.length).toBe(fx.conversations)

      // (b) the files open without ENOENT (readable, non-empty content).
      const firstFile = files[0]
      expect(firstFile).toBeDefined()
      const sample = readFileSync(join(rawDir, firstFile as string), 'utf8')
      expect(sample.length).toBeGreaterThan(0)

      // (c) the import reached `completed` (NOT failed/substrate_error) with a
      // non-empty user-model — the regressed end state now holds.
      expect(job.status).toBe('completed')
      expect(job.error_code).toBeUndefined()
      expect((job.result?.proposed_projects.length ?? 0)).toBeGreaterThan(0)
    })
  }
})
