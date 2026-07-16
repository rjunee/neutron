/**
 * @neutronai/gateway/upload — POST /api/import/<job_id>/resume handler.
 *
 * 2026-05-25 (import-pipeline-resilience sprint, Part G).
 *
 * Mirrors the upload-side resume semantics (Phase 2 chunked upload's
 * `HEAD /api/upload/<source>/<id>` → Upload-Offset) at the *analysis*
 * layer. When a prior import job ended in a resumable terminal state
 * (`cancelled`, `rate_limit_paused`, `failed`) AND the source ZIP is
 * still on disk at `<owner_home>/imports/<source>.zip`, this endpoint
 * dispatches a fresh `ImportJobRunner.start(...)`. The runner's
 * per-chunk hash dedup (`import_pass1_chunks`, keyed by
 * `(project_slug, source, chunk_hash)` — NOT job_id) means every
 * already-analysed chunk is reused at $0; only the chunks the prior
 * run never reached get a fresh LLM call.
 *
 * After dispatch, the handler stitches the NEW job_id onto
 * `onboarding_state.phase_state.import_job_id` and flips the phase
 * back to `import_running` so the engine's existing 5-second cron tick
 * re-enters `pollImportRunningTick` and advances on completion (or
 * applies the dynamic hard-timeout backstop on hang).
 *
 * Auth: HTTP-layer; this handler trusts the per-instance gateway's
 * upstream guards (Caddy → systemd port) the same way
 * `import-upload-handler.ts` does. The `auth` parameter is the seam
 * for future tightening without re-shaping the handler.
 *
 * Error responses:
 *   - 401: auth denied (when the optional auth check returns false)
 *   - 404: no such job for this instance
 *   - 409: job not resumable (e.g. status='completed'),
 *          or source ZIP missing on disk (`error: 'source_zip_missing'`),
 *          or payload resolver returned null
 *   - 405: non-POST method on the route
 *   - 500: unexpected throw (caller logs the body)
 *
 * Returns `null` for any path NOT matching `POST /api/import/<id>/resume`
 * so the composition's HTTP chain falls through to the next handler.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { OnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import type { ImportSource } from '@neutronai/onboarding/history-import/types.ts'

/** Statuses a job is allowed to resume from. */
export const RESUMABLE_STATUSES: ReadonlyArray<string> = Object.freeze([
  'cancelled',
  'rate_limit_paused',
  'failed',
])

export interface ImportResumeHandlerInput {
  /** Per-project SQLite handle for the `import_jobs` row lookup. */
  db: ProjectDb
  /** Instance slug — narrow the SELECT so cross-instance id collisions can't leak. */
  project_slug: string
  /** Absolute path to the instance's home directory (parent of `imports/`). */
  owner_home: string
  /** The same `ImportJobRunnerHook` the engine deps carries. */
  runner: ImportJobRunnerHook
  /**
   * The same `ImportPayloadResolver` the engine deps carries. Resolves
   * the export buffer for the zip sources (`chatgpt-zip` / `claude-zip`).
   * The resume endpoint cannot proceed if the resolver returns null.
   */
  payloadResolver: ImportPayloadResolver
  /** Per-instance onboarding-state store. */
  stateStore: OnboardingStateStore
  /**
   * Optional auth predicate. Returns true → allowed; false → 401. When
   * omitted the handler trusts upstream gateway gating (matches the
   * existing import-upload handler's behaviour).
   */
  auth?: (req: Request) => Promise<boolean> | boolean
  /** Test seam: `existsSync` shim. Defaults to `node:fs.existsSync`. */
  fs?: { existsSync: (p: string) => boolean }
  /** Test seam: clock for the engine state-store upsert. */
  now?: () => number
}

interface ImportJobLookupRow {
  job_id: string
  project_slug: string
  source: string
  status: string
}

const ROUTE_RE = /^\/api\/import\/([A-Za-z0-9_-]+)\/resume\/?$/

const ZIP_SOURCES: ReadonlyArray<ImportSource> = ['chatgpt-zip', 'claude-zip']

/**
 * Build a handler `(req: Request) => Promise<Response | null>` that
 * owns `POST /api/import/<job_id>/resume`. Returns `null` for non-owned
 * paths so the composition chain can fall through.
 */
export function buildImportResumeHandler(
  input: ImportResumeHandlerInput,
): (req: Request) => Promise<Response | null> {
  const fs = input.fs ?? { existsSync }
  const nowFn = input.now ?? ((): number => Date.now())
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    const match = ROUTE_RE.exec(url.pathname)
    if (match === null) return null
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405)
    }
    const job_id = match[1] as string

    if (input.auth !== undefined) {
      const ok = await input.auth(req)
      if (!ok) return jsonResponse({ error: 'unauthorized' }, 401)
    }

    let row: ImportJobLookupRow | null = null
    try {
      row = input.db
        .get<ImportJobLookupRow, [string, string]>(
          `SELECT job_id, project_slug, source, status
             FROM import_jobs
            WHERE job_id = ? AND project_slug = ?
            LIMIT 1`,
          [job_id, input.project_slug],
        )
    } catch (err) {
      return jsonResponse(
        {
          error: 'lookup_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }
    if (row === null) {
      return jsonResponse({ error: 'job_not_found' }, 404)
    }
    if (!RESUMABLE_STATUSES.includes(row.status)) {
      return jsonResponse(
        { error: 'not_resumable', status: row.status },
        409,
      )
    }
    const source = row.source as ImportSource
    // Defensive boundary (K11c Codex r1): `row.source` is an unvalidated DB
    // string. `ImportSource` is narrowed to the two zip sources, but the
    // `import_jobs.source` CHECK constraint (migration 0040, immutable
    // history) still permits the legacy `-oauth` strings. A stale/legacy
    // non-zip row must be refused cleanly here — never resolved or
    // dispatched to `runner.start`. (`unsupported_source` is the HTTP JSON
    // error string, not the `ImportErrorCode` enum.)
    if (!ZIP_SOURCES.includes(source)) {
      return jsonResponse({ error: 'unsupported_source', source }, 409)
    }
    // Only ZIP-backed sources have an on-disk artefact to verify here.
    if (ZIP_SOURCES.includes(source)) {
      const zipPath = zipPathForSource(input.owner_home, source)
      if (!fs.existsSync(zipPath)) {
        return jsonResponse(
          { error: 'source_zip_missing', source, path: zipPath },
          409,
        )
      }
    }

    // 2026-05-27 — resolve user_id by project_slug ONLY (not by joining on
    // phase_state.import_job_id = j.job_id as the pre-fix LEFT JOIN did).
    // The old JOIN missed Sam's row when the stale `import_job_id`
    // pointer on `onboarding_state` had drifted away from the cancelled
    // job's id (e.g. a prior advance nulled it, or a phantom row already
    // existed for this instance). On a miss the user_id flowed through as
    // empty string and `stateStore.upsert` then INSERTED a new
    // `(project_slug, '')` row instead of UPDATING the user's primary row
    // — that's the phantom row Sam observed on prod 2026-05-27. Neutron
    // is single-user-per-instance under P2 onboarding; the deterministic
    // `ORDER BY last_advanced_at DESC LIMIT 1` tiebreaker keeps the
    // multi-user case safe. The `user_id != ''` filter also prevents
    // resolving the wrong row if a pre-existing phantom row is sitting
    // in the table from before this fix landed.
    let osRow: { user_id: string } | null = null
    try {
      osRow = input.db
        .get<{ user_id: string }, [string]>(
          `SELECT user_id FROM onboarding_state
            WHERE project_slug = ? AND user_id != ''
            ORDER BY last_advanced_at DESC
            LIMIT 1`,
          [input.project_slug],
        )
    } catch (err) {
      return jsonResponse(
        {
          error: 'lookup_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }
    const user_id = osRow?.user_id ?? ''
    if (user_id === '') {
      // No onboarding_state row exists for this instance. Refuse to
      // proceed rather than create a phantom `(project_slug, '')` row in
      // `stateStore.upsert` below. The caller can investigate why the
      // job exists without an owning state row.
      return jsonResponse(
        { error: 'no_onboarding_state', project_slug: input.project_slug },
        409,
      )
    }

    let payload
    try {
      payload = await input.payloadResolver.resolve({
        owner_slug: input.project_slug,
        user_id,
        source,
      })
    } catch (err) {
      return jsonResponse(
        {
          error: 'payload_resolve_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }
    if (payload === null) {
      return jsonResponse({ error: 'payload_unavailable', source }, 409)
    }

    let new_job_id: string
    try {
      const r = await input.runner.start({
        owner_slug: input.project_slug,
        user_id,
        source,
        payload,
      })
      new_job_id = r.job_id
    } catch (err) {
      return jsonResponse(
        {
          error: 'runner_start_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }

    // Flip onboarding_state back to `import_running` and stitch in the
    // new job_id so the engine's cron resumes polling against the new
    // runner instance. The state-store's upsert is idempotent.
    //
    // `import_source` is restitched to the resumed job's source (Codex
    // 2026-05-27 P2 follow-up). The pre-fix LEFT JOIN guaranteed the row
    // we updated had `phase_state.import_job_id = j.job_id` and therefore
    // (in practice) the right `import_source`. The new instance-only
    // lookup intentionally supports rows where the pointer has drifted
    // off the cancelled job, so `import_source` on that row can be stale
    // or null. Subsequent ticks of `pollImportRunningAndAdvance` read
    // `import_source` off phase_state for the progress envelope AND for
    // `attemptAutoResumeFromPaused`'s payload-resolver call when the
    // resumed job hits `rate_limit_paused`; a stale source would surface
    // wrong UI progress and break the auto-resume helper. Restamping
    // both fields keeps phase_state aligned with the new job.
    try {
      await input.stateStore.upsert({
        owner_slug: input.project_slug,
        user_id,
        phase: 'import_running',
        phase_state_patch: {
          import_job_id: new_job_id,
          import_source: source,
          import_failed: false,
          import_partial: false,
          import_failure_reason: null,
          active_prompt_id: null,
        },
        advanced_at: nowFn(),
      })
    } catch (err) {
      return jsonResponse(
        {
          error: 'state_upsert_failed',
          message: err instanceof Error ? err.message : String(err),
        },
        500,
      )
    }

    // Best-effort: how many chunks were already analysed for this
    // (instance, source) pair. The new runner.start will reuse all of
    // them at $0 via per-chunk hash dedup.
    let chunks_already_done = 0
    try {
      const cnt = input.db
        .get<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM import_pass1_chunks
            WHERE project_slug = ? AND source = ? AND analyzed = 1`,
          [input.project_slug, row.source],
        )
      if (cnt !== null && typeof cnt.n === 'number') {
        chunks_already_done = cnt.n
      }
    } catch {
      // best-effort; the runner doesn't depend on this count
    }
    return jsonResponse(
      {
        ok: true,
        prior_job_id: job_id,
        job_id: new_job_id,
        source,
        chunks_already_done,
      },
      200,
    )
  }
}

/**
 * Resolve the on-disk ZIP path for a *-zip source. Mirrors the
 * convention `import-upload-handler.ts` uses when the upload lands
 * (`<owner_home>/imports/<source>.zip`). NOT used for OAuth sources.
 */
export function zipPathForSource(
  owner_home: string,
  source: ImportSource,
): string {
  if (source === 'chatgpt-zip') return join(owner_home, 'imports', 'chatgpt.zip')
  if (source === 'claude-zip') return join(owner_home, 'imports', 'claude.zip')
  // Defensive — OAuth sources don't have a ZIP path; caller MUST not
  // invoke for those. Returning a path that won't exist preserves the
  // 'source_zip_missing' branch's behaviour without crashing.
  return join(owner_home, 'imports', `${source}.zip`)
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
