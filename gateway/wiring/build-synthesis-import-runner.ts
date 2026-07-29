/**
 * @neutronai/gateway/wiring — synthesis → engine bridge (Step 2b,
 * 2026-06-17). Authoritative design:
 * `docs/plans/onboarding-single-session-architecture-2026-06-17.md`.
 *
 * This is the CUT-OVER. Step 2 (#88) built `onboarding/synthesis/*` + the
 * `buildSynthesisSession` composer seam but left the live interview engine
 * driving the OLD per-chunk `buildImportJobRunnerHook` path (one heavy LLM
 * call per 150K-token chunk, `/clear`'d between chunks). This bridge adapts
 * the `SynthesisRunner` to the `ImportJobRunnerHook` the engine already
 * consumes, so the engine's `import_running` phase machine (start → poll →
 * `import_analysis_presented`) now drives the ONE accumulating synthesis
 * session instead of the per-chunk runner.
 *
 * The engine talks to imports ONLY through `ImportJobRunnerHook`
 * (`onboarding/interview/engine-internals.ts`): `start → {job_id}`,
 * `status(job_id) → ImportJob`, terminal `completed` carries an
 * `ImportResult`. We keep that contract byte-for-byte so NONE of the engine's
 * polling / cron-tick / analysis-presentation / project-materialization
 * machinery changes — only the work behind the hook does:
 *
 *   start → deterministic pre-pass (raw transcripts to disk) → ONE
 *   accumulating synthesis session (NO `/clear`, NO per-chunk spawn) →
 *   per-project seed files written under `<owner_home>/Projects/<slug>/` →
 *   `SynthesisResult` mapped to the `ImportResult` the engine reads.
 *
 * Job STATE is persisted to the `import_jobs` table (exactly like the
 * per-chunk runner) so `status()` is DB-backed — the import-running cron, the
 * progress envelope, and any other surface that polls a `job_id` all see a
 * consistent row. The synthesized `ImportResult` itself is held in-process
 * (the synthesis session is a single accumulating run, not a chunk-resumable
 * pipeline, so there is no partial cache to persist for resume).
 *
 * Substrate discipline: the synthesis session dispatches through the injected
 * accumulating `Substrate` (the CC-spawn warm REPL — NEVER api.anthropic.com).
 * There is NO `reset_context_per_turn` on this path; the model ACCUMULATES.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  ChunkerInput,
  ConversationRecord,
  ImportErrorCode,
  ImportJob,
  ImportJobStatus,
  ImportResult,
  ImportSource,
  SourceParser,
} from '@neutronai/onboarding/history-import/types.ts'
import { buildDefaultSourceParser } from '@neutronai/onboarding/history-import/default-source-parser.ts'
import {
  loadImportResult,
  persistImportResult,
} from '@neutronai/onboarding/history-import/import-result-store.ts'
import type {
  ImportJobRunnerHook,
} from '@neutronai/onboarding/interview/engine-internals.ts'
import type {
  ConversationSignal,
  ProjectSeed,
  SynthesisResult,
} from '@neutronai/onboarding/synthesis/index.ts'
import { slugifyProjectId } from '@neutronai/onboarding/wow-moment/project-identity.ts'
import type { SynthesisRunner } from './build-synthesis-session.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('synthesis-import-runner')

export interface BuildSynthesisImportJobRunnerInput {
  /** Per-instance DB — job state persists to `import_jobs` (DB-backed status). */
  db: ProjectDb
  /** The composer-built synthesis runner (parse → pre-pass → session → seeds). */
  synthesis: SynthesisRunner
  /**
   * Source → `ConversationRecord` stream. Optional: defaults to the zip
   * parser (`chatgpt-zip` / `claude-zip` — the live onboarding import path).
   */
  parse?: SourceParser
  /** Test seam: clock. Defaults to `Date.now`. */
  now?: () => number
  /** Test seam: job-id generator. Defaults to a random hex id. */
  uuid?: () => string
  /** Failure sink. Default `console.warn`; the runner never throws out of `start`. */
  logFailure?: (stage: string, err: unknown) => void
  /**
   * Hook fired once per completed synthesis with the `SynthesisResult` +
   * per-project seed-write outcomes. Tests assert the seam fired; production
   * leaves it unset (the seed files on disk ARE the observable effect).
   */
  onSynthesisComplete?: (info: {
    job_id: string
    source: ImportSource
    result: SynthesisResult
    seeds_written: number
  }) => void
}

interface ImportJobRow {
  job_id: string
  project_slug: string
  source: string
  status: string
  dollars_spent: number
  pass1_chunks_done: number
  pass1_chunks_total: number
  chunks_total_known: number
  started_at: number
  completed_at: number | null
  error_code: string | null
  error_message: string | null
}

/**
 * Adapt a `SynthesisRunner` to the engine's `ImportJobRunnerHook`. The
 * returned hook runs the synthesis pipeline in the background on `start`,
 * persists progress to `import_jobs`, and surfaces the mapped `ImportResult`
 * via `status` on completion.
 */
export function buildSynthesisImportJobRunner(
  input: BuildSynthesisImportJobRunnerInput,
): ImportJobRunnerHook {
  const db = input.db
  const now = input.now ?? Date.now
  const uuid = input.uuid ?? defaultUuid
  const logFailure = input.logFailure ?? defaultLogFailure
  const parse: SourceParser = input.parse ?? buildDefaultSourceParser()
  // In-process result cache + cancellation. The `results` Map is the PRIMARY
  // read on the no-restart happy path (byte-identical to the pre-P6 behavior).
  // P6 (durability P0): the completed `ImportResult` is ALSO persisted to the
  // `import_results` table in the SAME write that flips `status='completed'`
  // (see `runJob`), so a process restart — which discards this Map along with
  // the fire-and-forget `runJob` promise — no longer silently loses a PAID
  // synthesis: `status()` / `synthesizeOnDemand` read-on-miss from the row.
  const results = new Map<string, ImportResult>()
  const cancelled = new Set<string>()

  // TERMINAL-WINNER guard (Codex): no runner write may resurrect a row a concurrent
  // `cancel()` (or a prior terminal write) already settled. Every status write below
  // is guarded to non-terminal rows, so a cancel that lands mid-run is authoritative
  // — the in-flight synthesis then no-ops its progress/failed/completed writes.
  const NON_TERMINAL_GUARD = `status NOT IN ('completed', 'failed', 'cancelled')`
  const setStatus = async (job_id: string, status: ImportJobStatus): Promise<void> => {
    await db.run(
      `UPDATE import_jobs SET status = ? WHERE job_id = ? AND ${NON_TERMINAL_GUARD}`,
      [status, job_id],
    )
  }

  const finishFailed = async (
    job_id: string,
    code: ImportErrorCode,
    message: string,
  ): Promise<void> => {
    await db.run(
      `UPDATE import_jobs
         SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
       WHERE job_id = ?
         AND ${NON_TERMINAL_GUARD}`,
      [code, message, now(), job_id],
    )
  }

  const runJob = async (
    job_id: string,
    project_slug: string,
    source: ImportSource,
    payload: ChunkerInput,
  ): Promise<void> => {
    await setStatus(job_id, 'pass1-running')
    // Per-read-pass progress sink (2026-06-18). Drives a MOVING bar: each read
    // pass updates `pass1_chunks_done/total` + flips `chunks_total_known` so
    // `sendImportProgress` emits an advancing pct instead of stranding at
    // `pct=0.00 known=false` for the whole run (the dogfood symptom). Synchronous
    // write via `runSync` (bun:sqlite is sync) so the sync `onProgress` callback
    // can persist without an unawaited race; never throws out of synthesis
    // (best-effort).
    const onProgress = (done: number, total: number): void => {
      try {
        db.runSync(
          `UPDATE import_jobs
             SET pass1_chunks_done = ?, pass1_chunks_total = ?, chunks_total_known = 1
           WHERE job_id = ?`,
          [done, total, job_id],
        )
      } catch (err) {
        logFailure(`progress:${job_id}`, err)
      }
    }
    let result: SynthesisResult | null
    try {
      const records: AsyncIterable<ConversationRecord> = parse(source, payload)
      result = await input.synthesis.synthesizeImport(records, onProgress)
    } catch (err) {
      logFailure(`synthesize_import:${job_id}`, err)
      await finishFailed(job_id, 'substrate_error', err instanceof Error ? err.message : String(err))
      return
    }
    if (result === null) {
      // LLM-less box: the synthesis session could not run (no substrate). The
      // engine's failed → import_analysis_presented(failed) → gap_fill path
      // collects projects conversationally instead.
      await finishFailed(job_id, 'substrate_error', 'synthesis unavailable (no LLM substrate wired)')
      return
    }
    if (cancelled.has(job_id)) return

    // HONEST-FAILURE gate (2026-06-18 synthesis-completes fix): if there WERE
    // conversations to read but EVERY read pass failed (timeout/empty, even
    // after the single retry) AND no project surfaced, the synthesis produced
    // nothing usable — the production "empty wow" signature (dollars_spent=0,
    // blank "here's what I see:"). Mark the job `failed` instead of silently
    // `completed` with an empty model, so the engine routes to its graceful
    // failed -> import_analysis_presented(failed) path (a "couldn't finish the
    // read — retry or skip" affordance) rather than presenting a blank summary.
    // An HONESTLY-empty export (no conversations → attempted === 0) still
    // completes normally; the engine handles a genuinely empty history.
    if (
      result.read_passes_attempted > 0 &&
      result.read_passes_succeeded === 0 &&
      result.user_model.projects.length === 0
    ) {
      logFailure(
        `synthesize_import:${job_id}`,
        new Error(
          `synthesis read failed on every pass (attempted=${result.read_passes_attempted}, succeeded=0); surfacing honest failure instead of an empty summary`,
        ),
      )
      await finishFailed(
        job_id,
        'pass1_all_failed',
        'I could not finish reading your history (every read pass timed out). You can retry the import or skip it.',
      )
      return
    }

    // Populate each detected project's repo from the seed material, aligning
    // the seed folder slug to the canonical project-id slugifier the
    // wow-moment materializer uses (so the synthesized STATUS/history/
    // transcripts land in the SAME `Projects/<slug>/` the materializer later
    // targets, and the materializer defers to them by create-if-missing).
    let seeds_written = 0
    const signalsById = buildSignalsById(result)
    for (const seed of result.project_seeds) {
      const aligned: ProjectSeed = { ...seed, slug: slugifyProjectId(seed.name) }
      try {
        const outcome = input.synthesis.writeSeed(aligned, signalsById)
        if (outcome.reason === 'created') seeds_written += 1
      } catch (err) {
        // Failure-isolated: one project's seed failure never blocks the import.
        logFailure(`write_seed:${aligned.slug}`, err)
      }
    }

    const importResult = synthesisResultToImportResult(result)
    const batches = result.batches_read
    // P6 (durability P0) — persist the `ImportResult` to `import_results` in the
    // SAME transaction that flips `status='completed'`, so the two commit
    // atomically: a restart never sees a `completed` job whose durable result is
    // missing (nor a persisted result on a not-yet-completed job). `tx.run` is
    // re-entry-detected inside the BEGIN/COMMIT so both writes share the one
    // mutex-held transaction. `partial=false` (the synthesis session is a single
    // accumulating run; a completed job is always a full result).
    //
    // CANCEL RACE (Codex): the pre-check at the top of this function (`cancelled.
    // has(job_id)`) closes only cancels that land BEFORE synthesis returns. A
    // `cancel()` arriving during the (synchronous) seed writes or right before this
    // block has already flipped the row to `status='cancelled'`. So GUARD the flip
    // on a non-terminal status and check the affected-row count: if the completion
    // lost the race (0 rows), throw to roll the just-persisted result back with it —
    // a cancelled/failed job must never resurrect to `completed`, nor keep a
    // persisted result. The terminal status the winner wrote stays authoritative.
    let completionWon = true
    try {
      await db.transaction(async (tx) => {
        await persistImportResult(tx, {
          job_id,
          owner_slug: project_slug,
          source,
          result: importResult,
          partial: false,
          now: now(),
        })
        // `runSync` (not `run`) so we get the affected-row count; it writes on the
        // transaction's connection inside the open BEGIN, so it commits/rolls back
        // atomically with the `persistImportResult` above.
        const res = tx.runSync(
          `UPDATE import_jobs
             SET status = 'completed', pass1_chunks_done = ?, pass1_chunks_total = ?,
                 chunks_total_known = 1, completed_at = ?
           WHERE job_id = ?
             AND status NOT IN ('completed', 'failed', 'cancelled')`,
          [batches, batches, now(), job_id],
        )
        if (res.changes === 0) {
          // A concurrent cancel/fail already made the row terminal. Roll the
          // persisted result back with this failed flip (same tx).
          completionWon = false
          throw new Error(`import completion lost the race for ${job_id} (already terminal)`)
        }
      })
    } catch (err) {
      if (!completionWon) {
        // Benign: the row is already terminal (cancelled/failed) and the persisted
        // result was rolled back. Do NOT warm the cache or fire completion.
        return
      }
      throw err
    }
    // Populate the in-process cache only AFTER the durable commit — never cache a
    // result the transaction rolled back. This runs synchronously in `runJob`'s
    // continuation (no `await` between commit and here), so no `status()` poll
    // can observe the committed `completed` row before the Map is warm.
    results.set(job_id, importResult)
    input.onSynthesisComplete?.({ job_id, source, result, seeds_written })
  }

  return {
    async start(inp): Promise<{ job_id: string }> {
      const job_id = uuid()
      await db.run(
        `INSERT INTO import_jobs
           (job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
            pass1_chunks_total, chunks_total_known, started_at, completed_at,
            error_code, error_message)
         VALUES (?, ?, ?, 'queued', 0, 0, 0, 0, ?, NULL, NULL, NULL)`,
        [job_id, inp.owner_slug, inp.source, now()],
      )
      // Fire-and-forget: the engine polls `status` on its own clock (initial
      // poll + the 5s import-running cron tick). Any escape is swallowed so a
      // background failure surfaces as a `failed` job, never an unhandled
      // rejection.
      fireAndForget('build-synthesis-import-runner.runJob', runJob(job_id, inp.owner_slug, inp.source, inp.payload), (err) => {
        logFailure(`run_job:${job_id}`, err)
        // Mark the job failed (async) via a NESTED fireAndForget so onError stays
        // synchronous-safe AND the persist failure is itself counted/logged.
        fireAndForget(
          'build-synthesis-import-runner.finishFailed',
          finishFailed(job_id, 'substrate_error', err instanceof Error ? err.message : String(err)),
          (e) => logFailure(`run_job_fail_persist:${job_id}`, e),
        )
      })
      return { job_id }
    },

    async status(job_id): Promise<ImportJob | null> {
      const row = db
        .get<ImportJobRow, [string]>(
          `SELECT job_id, project_slug, source, status, dollars_spent, pass1_chunks_done,
                  pass1_chunks_total, chunks_total_known, started_at, completed_at,
                  error_code, error_message
             FROM import_jobs WHERE job_id = ?`,
          [job_id],
        )
      if (row === null) return null
      const job: ImportJob = {
        job_id: row.job_id,
        owner_slug: row.project_slug,
        source: row.source as ImportSource,
        status: row.status as ImportJobStatus,
        dollars_spent: row.dollars_spent,
        pass1_chunks_done: row.pass1_chunks_done,
        pass1_chunks_total: row.pass1_chunks_total,
        chunks_total_known: row.chunks_total_known === 1,
        started_at: row.started_at,
      }
      if (row.completed_at !== null) job.completed_at = row.completed_at
      if (row.error_code !== null) {
        job.error_code = row.error_code as Exclude<ImportJob['error_code'], undefined>
      }
      if (row.error_message !== null) job.error_message = row.error_message
      if (row.status === 'completed') {
        // Happy path: the in-process Map holds the result. P6 read-on-miss: after
        // a restart the Map is empty, so fall back to the durable `import_results`
        // row persisted atomically with the `completed` flip.
        const result = results.get(job_id) ?? loadImportResult(db, job_id)?.result
        if (result !== undefined) job.result = result
      }
      return job
    },

    async cancel(job_id): Promise<void> {
      cancelled.add(job_id)
      // SINGLE guarded write — no read/check/write TOCTOU (Codex): a separate
      // status read then unconditional UPDATE could let a completion commit
      // `completed` in the gap and then get overwritten to `cancelled`, orphaning
      // its persisted result. The guard makes cancellation atomic against a
      // concurrent completion/failure: if the row is already terminal, 0 rows change
      // and the terminal winner stands. `cancelled.add` still short-circuits an
      // in-flight runJob at its pre-checks. A missing job → 0 rows (harmless no-op).
      await db.run(
        `UPDATE import_jobs SET status = 'cancelled', completed_at = ?
           WHERE job_id = ? AND ${NON_TERMINAL_GUARD}`,
        [now(), job_id],
      )
    },

    async synthesizeOnDemand(job_id): Promise<ImportResult | null> {
      // The synthesis session is a single accumulating run, not a chunk-
      // resumable pipeline: there is no partial Pass-1 cache to aggregate.
      // Surface the completed result if we have one, else null (the engine
      // routes gracefully to gap-fill). P6 read-on-miss: fall back to the
      // durable `import_results` row so a post-restart on-demand request still
      // recovers a result that completed before the crash.
      return results.get(job_id) ?? loadImportResult(db, job_id)?.result ?? null
    },
  }
}

/**
 * Map the synthesis user-model + project seeds to the `ImportResult` the
 * engine's `advanceFromImportRunningOnComplete` consumes. The engine seeds
 * `primary_projects` from `proposed_projects[].name` and surfaces the
 * analysis body off these fields, so the informed grounding (real project
 * names + people drawn from the history) flows through unchanged.
 */
export function synthesisResultToImportResult(r: SynthesisResult): ImportResult {
  const m = r.user_model
  const proposed_projects = m.projects
    .filter((p) => p.name.trim().length > 0)
    .map((p) => ({
      name: p.name,
      rationale: p.overview.trim().length > 0 ? p.overview.trim() : p.status.trim(),
      suggested_topics: p.open_threads.slice(0, 8),
    }))
  const proposed_tasks = m.tasks
    .filter((t) => t.trim().length > 0)
    .map((t) => ({ title: t }))
  const entities = m.people
    .filter((name) => name.trim().length > 0)
    .map((name) => ({ name, kind: 'person' as const, mention_count: 1 }))
  return {
    entities,
    topics: [],
    proposed_projects,
    proposed_tasks,
    proposed_reminders: [],
    voice_signals: m.style,
    facts: {
      ...(m.people.length > 0 ? { key_people: m.people.slice(0, 20) } : {}),
    },
  }
}

/** Title the routed transcripts in each project's history doc when possible. */
function buildSignalsById(
  _result: SynthesisResult,
): ReadonlyMap<string, ConversationSignal> | undefined {
  // The `SynthesisResult` does not carry the pre-pass conversation signals
  // (they stay on the synthesis runner's side), so titles fall back to
  // "(untitled)" in the history doc. Threading the signals through is a
  // documented follow-up; the routed raw transcripts themselves are already
  // written regardless.
  return undefined
}

function defaultUuid(): string {
  // Non-crypto, collision-resistant enough for in-process job ids.
  let s = ''
  for (let i = 0; i < 4; i += 1) {
    s += Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .slice(1)
  }
  return `synth-${s}`
}

function defaultLogFailure(stage: string, err: unknown): void {
  moduleLog.warn('stage_failed', { stage, error: err instanceof Error ? err.message : String(err) })
}
