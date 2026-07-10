/**
 * @neutronai/onboarding/profile-pic — async generation pipeline.
 *
 * Per docs/plans/P2-onboarding.md § 2.7 (Locked 2026-04-29). The user-
 * facing flow:
 *
 *   1. Onboarding emits a "your portraits are being painted (~30 sec)…"
 *      button-prompt with [A] Wait / [B] Pick from generic gallery /
 *      [C] Upload my own. The interview engine never blocks on
 *      profile-pic — it proceeds to the next phase while this pipeline
 *      runs in the background.
 *
 *   2. `start({ archetype, prompt })` returns a job_id immediately and
 *      runs Gemini Imagen up to `failureBudget` (default 3) times in
 *      the background. Each successful candidate lands at
 *      `<owner_home>/persona/profile-pic-candidates/<id>.png` and the
 *      `profile_pic_candidates` row is recorded.
 *
 *   3. `status(job_id)` is polled by the UI / engine. Terminal states:
 *        - 'ready'         — at least one Gemini candidate landed; user
 *                            picks via `pick(...)`
 *        - 'fallback'      — 3 failures; the 12-PNG gallery served the
 *                            archetype-keyed default; user picks via
 *                            `pickFallback(...)`
 *        - 'user_uploaded' — user tapped [C] and supplied bytes;
 *                            canonical copy already in place
 *        - 'failed'        — the gallery itself was unreachable (only
 *                            possible if disk is borked)
 *
 *   4. `pick(job_id, candidate_id)` copies the chosen candidate to the
 *      canonical path `<owner_home>/persona/profile-pic.png`.
 *
 * The DB rows are persistence for observability + resume-on-reconnect;
 * the canonical disk path is the source-of-truth that downstream
 * consumers (Telegram bot avatar, app UI) read. Tests inject the
 * `GeminiImagenClient` + a deterministic uuid + clock to assert the
 * full lifecycle without network or wall-clock dependencies.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  FallbackGallery,
  FALLBACK_DEFAULT_SLUG,
  normalizeArchetype,
  type FallbackArchetypeSlug,
} from './fallback-gallery.ts'
import {
  GeminiImagenClient,
  GeminiImagenError,
  type GeminiImageCandidate,
} from './gemini-imagegen.ts'
import { ProfilePicPendingStore } from './pending-call-store.ts'

export type ProfilePicJobStatus =
  | 'queued'
  | 'generating'
  | 'ready'
  | 'fallback'
  | 'user_uploaded'
  | 'failed'

export interface ProfilePicJob {
  id: string
  project_slug: string
  status: ProfilePicJobStatus
  archetype_hint: string | null
  started_at: number
  completed_at: number | null
  fallback_used: boolean
  failure_count: number
  candidates: Array<{
    id: string
    path: string
    source: 'gemini' | 'fallback' | 'upload'
    picked_at: number | null
  }>
}

export type ProfilePicErrorCode =
  | 'job_not_found'
  | 'invalid_status'
  | 'candidate_not_found'
  | 'gallery_missing'
  | 'persistence_failed'

export class ProfilePicError extends Error {
  override readonly name = 'ProfilePicError'
  constructor(
    readonly code: ProfilePicErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ProfilePicPipelineDeps {
  db: ProjectDb
  /** Per-instance home dir; the pipeline writes to <home>/persona/. */
  owner_home: string
  /** The Gemini client. Wire `null` to short-circuit straight to fallback. */
  gemini: GeminiImagenClient | null
  /** Fallback gallery. Default-constructed if absent (uses bundled data dir). */
  fallback?: FallbackGallery
  /** Failure budget per § 2.7 — 3 by default. */
  failure_budget?: number
  /**
   * Durable pending-call store. Defaults to a fresh `ProfilePicPendingStore`
   * over the same DB. Production wires the default; tests inject a shared
   * instance so they can assert rows directly. Pass `null` to disable
   * durable tracking entirely (kept for backward-compat with tests that
   * predate the pending-call store).
   */
  pending_store?: ProfilePicPendingStore | null
  /** Test seam: deterministic UUIDs + clock. */
  uuid?: () => string
  now?: () => number
}

export interface StartProfilePicInput {
  project_slug: string
  /** Free-form archetype hint — normalized into one of the 12 fallback slugs. */
  archetype_hint?: string
  /** The composed Gemini prompt. Production derives this from SOUL.md + archetype blend. */
  prompt: string
  /** Number of candidates per Gemini call. Defaults to 3 (§ 2.7 candidate count). */
  candidates_per_call?: number
  /**
   * Engine-layer user id. Threaded into the durable pending-call store
   * so the engine's phase-enter lookup can scope to a single (project_slug,
   * user_id) tuple. Optional — the pipeline itself never reads it.
   */
  user_id?: string
}

export interface StartProfilePicResult {
  job_id: string
}

const DEFAULT_FAILURE_BUDGET = 3
const DEFAULT_CANDIDATES_PER_CALL = 3

interface ProfilePicJobRow {
  id: string
  project_slug: string
  status: string
  archetype_hint: string | null
  started_at: number
  completed_at: number | null
  fallback_used: number
  failure_count: number
}

interface ProfilePicCandidateRow {
  id: string
  job_id: string
  path: string
  source: string
  created_at: number
  picked_at: number | null
}

export class ProfilePicPipeline {
  private readonly db: ProjectDb
  private readonly ownerHome: string
  private readonly gemini: GeminiImagenClient | null
  private readonly fallback: FallbackGallery
  private readonly failureBudget: number
  private readonly uuid: () => string
  private readonly now: () => number
  private readonly pendingStore: ProfilePicPendingStore | null
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(deps: ProfilePicPipelineDeps) {
    this.db = deps.db
    this.ownerHome = deps.owner_home
    this.gemini = deps.gemini
    this.fallback = deps.fallback ?? new FallbackGallery()
    this.failureBudget = deps.failure_budget ?? DEFAULT_FAILURE_BUDGET
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? ((): number => Date.now())
    // Default: build a pending-call store over the same DB so durable
    // resume Just Works without composer changes. Tests / legacy callers
    // can opt out with `pending_store: null`.
    if (deps.pending_store === null) {
      this.pendingStore = null
    } else if (deps.pending_store !== undefined) {
      this.pendingStore = deps.pending_store
    } else {
      const storeDeps: ConstructorParameters<typeof ProfilePicPendingStore>[0] = {
        db: this.db,
        now: this.now,
        uuid: this.uuid,
      }
      this.pendingStore = new ProfilePicPendingStore(storeDeps)
    }
  }

  /** Read-only handle to the durable pending-call store (production wires
   *  the engine hook through this). */
  pendingCallStore(): ProfilePicPendingStore | null {
    return this.pendingStore
  }

  /**
   * Kick off async generation. Returns the `job_id` immediately; the
   * actual generation runs in the background. Tests can `await
   * pipeline.awaitJob(job_id)` for deterministic synchronization.
   */
  async start(input: StartProfilePicInput): Promise<StartProfilePicResult> {
    const job_id = this.uuid()
    const started_at = this.now()
    await this.db.run(
      `INSERT INTO profile_pic_jobs
         (id, project_slug, status, archetype_hint, started_at, completed_at,
          fallback_used, failure_count)
       VALUES (?, ?, 'queued', ?, ?, NULL, 0, 0)`,
      [job_id, input.project_slug, input.archetype_hint ?? null, started_at],
    )
    const promise = this.run(job_id, input).finally(() => {
      this.inflight.delete(job_id)
    })
    this.inflight.set(job_id, promise)
    promise.catch(() => undefined)
    return { job_id }
  }

  /** Test seam — block until the named job completes. */
  async awaitJob(job_id: string): Promise<void> {
    const p = this.inflight.get(job_id)
    if (p === undefined) return
    await p
  }

  /** Polled by the UI. Returns null if no such job. */
  async status(job_id: string): Promise<ProfilePicJob | null> {
    const row = this.db
      .get<ProfilePicJobRow, [string]>(
        `SELECT id, project_slug, status, archetype_hint, started_at, completed_at,
                fallback_used, failure_count
           FROM profile_pic_jobs WHERE id = ?`,
        [job_id],
      )
    if (row === null) return null
    const candidateRows = this.db
      .all<ProfilePicCandidateRow, [string]>(
        `SELECT id, job_id, path, source, created_at, picked_at
           FROM profile_pic_candidates
          WHERE job_id = ?
          ORDER BY created_at ASC`,
        [job_id],
      )
    return {
      id: row.id,
      project_slug: row.project_slug,
      status: row.status as ProfilePicJobStatus,
      archetype_hint: row.archetype_hint,
      started_at: row.started_at,
      completed_at: row.completed_at,
      fallback_used: row.fallback_used === 1,
      failure_count: row.failure_count,
      candidates: candidateRows.map((c) => ({
        id: c.id,
        path: c.path,
        source: c.source as 'gemini' | 'fallback' | 'upload',
        picked_at: c.picked_at,
      })),
    }
  }

  /**
   * User picked a generated (or fallback) candidate. Copies the chosen
   * candidate's bytes to `<owner_home>/persona/profile-pic.png` and
   * marks the row picked. Idempotent — picking the same candidate
   * twice succeeds.
   */
  async pick(
    job_id: string,
    candidate_id: string,
  ): Promise<{ canonical_path: string }> {
    const job = await this.status(job_id)
    if (job === null) {
      throw new ProfilePicError('job_not_found', `no profile_pic_jobs row for id=${job_id}`)
    }
    const candidate = job.candidates.find((c) => c.id === candidate_id)
    if (candidate === undefined) {
      throw new ProfilePicError(
        'candidate_not_found',
        `no candidate id=${candidate_id} on job=${job_id}`,
      )
    }
    const personaDir = join(this.ownerHome, 'persona')
    mkdirSync(personaDir, { recursive: true })
    const canonical = join(personaDir, 'profile-pic.png')
    copyFileSync(candidate.path, canonical)
    if (candidate.picked_at === null) {
      await this.db.run(
        `UPDATE profile_pic_candidates SET picked_at = ? WHERE id = ? AND picked_at IS NULL`,
        [this.now(), candidate_id],
      )
    }
    return { canonical_path: canonical }
  }

  /**
   * User tapped [C] Upload my own — caller passes the raw bytes (e.g.
   * Telegram photo download) and the pipeline writes them to the
   * canonical path. Marks the job `user_uploaded`.
   */
  async acceptUpload(
    job_id: string,
    bytes: Buffer,
  ): Promise<{ canonical_path: string }> {
    const job = await this.status(job_id)
    if (job === null) {
      throw new ProfilePicError('job_not_found', `no profile_pic_jobs row for id=${job_id}`)
    }
    const personaDir = join(this.ownerHome, 'persona')
    const candidatesDir = join(personaDir, 'profile-pic-candidates')
    mkdirSync(candidatesDir, { recursive: true })
    const candidate_id = this.uuid()
    const candidatePath = join(candidatesDir, `${candidate_id}.png`)
    writeFileSync(candidatePath, bytes)
    const canonical = join(personaDir, 'profile-pic.png')
    writeFileSync(canonical, bytes)
    const ts = this.now()
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO profile_pic_candidates (id, job_id, path, source, created_at, picked_at)
         VALUES (?, ?, ?, 'upload', ?, ?)`,
        [candidate_id, job_id, candidatePath, ts, ts],
      )
      await tx.run(
        `UPDATE profile_pic_jobs SET status = 'user_uploaded', completed_at = ? WHERE id = ?`,
        [ts, job_id],
      )
    })
    return { canonical_path: canonical }
  }

  /**
   * User tapped [B] Pick from generic gallery — short-circuits Gemini
   * entirely, lands a fallback candidate keyed by `archetype_hint`.
   */
  async pickFallback(job_id: string): Promise<{ candidate_id: string; path: string }> {
    const job = await this.status(job_id)
    if (job === null) {
      throw new ProfilePicError('job_not_found', `no profile_pic_jobs row for id=${job_id}`)
    }
    const portrait = this.fallback.pick(job.archetype_hint ?? FALLBACK_DEFAULT_SLUG)
    const personaDir = join(this.ownerHome, 'persona')
    const candidatesDir = join(personaDir, 'profile-pic-candidates')
    mkdirSync(candidatesDir, { recursive: true })
    const candidate_id = this.uuid()
    const candidatePath = join(candidatesDir, `${candidate_id}.png`)
    writeFileSync(candidatePath, portrait.bytes)
    const ts = this.now()
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO profile_pic_candidates (id, job_id, path, source, created_at, picked_at)
         VALUES (?, ?, ?, 'fallback', ?, NULL)`,
        [candidate_id, job_id, candidatePath, ts],
      )
      await tx.run(
        `UPDATE profile_pic_jobs SET status = 'fallback', completed_at = ?, fallback_used = 1 WHERE id = ?`,
        [ts, job_id],
      )
    })
    return { candidate_id, path: candidatePath }
  }

  /**
   * Background worker. Runs until success, fallback, or budget exhausted.
   *
   * Codex review fix (r1 P1): the user can short-circuit Gemini at any
   * time by tapping `[B] Pick from generic gallery` (`pickFallback`) or
   * `[C] Upload my own` (`acceptUpload`). Both paths flip the row to a
   * terminal user-chosen status (`'fallback'` or `'user_uploaded'`).
   * The worker now checks for those states between Gemini calls and
   * before flipping the row to `'ready'` so the user's choice is never
   * overwritten. The candidate-write itself is also guarded — we
   * persist Gemini bytes-on-disk regardless (they may be useful for
   * debugging / regen) but only land the row + flip status if the user
   * has not already terminated the job.
   */
  private async run(job_id: string, input: StartProfilePicInput): Promise<void> {
    if (await this.isUserTerminated(job_id)) return
    await this.setStatusIfNotTerminated(job_id, 'generating')
    if (this.gemini === null) {
      if (await this.isUserTerminated(job_id)) return
      await this.applyFallback(job_id, input.archetype_hint)
      return
    }
    const personaDir = join(this.ownerHome, 'persona')
    const candidatesDir = join(personaDir, 'profile-pic-candidates')
    mkdirSync(candidatesDir, { recursive: true })

    const requestCount = input.candidates_per_call ?? DEFAULT_CANDIDATES_PER_CALL
    let landed = 0
    let failures = 0
    while (failures < this.failureBudget) {
      if (await this.isUserTerminated(job_id)) return
      // Durable resume: record an in-flight row BEFORE the Gemini call.
      // If the process restarts between this insert and the matching
      // `markCompleted`/`markFailed`, the resume-on-boot hook observes
      // a stale 'pending' row + applies the time-window heuristics.
      let pending_request_id: string | null = null
      if (this.pendingStore !== null) {
        // ISSUE #45 — stamp the originating job_id on the pending row.
        // The boot-resume auto-retry path (fireAutoRetry → pipeline.start
        // → this.run) flows through here too, so the row written for the
        // retry's Gemini call carries the new job's id. When the retry
        // completes BEFORE the user taps Wait, the engine hook reads the
        // 'completed' row's job_id and surfaces those candidates instead
        // of firing a duplicate `pipeline.start`.
        const recorded = await this.pendingStore.recordPending({
          project_slug: input.project_slug,
          user_id: input.user_id ?? null,
          prompt: input.prompt,
          archetype_hint: input.archetype_hint ?? null,
          job_id,
        })
        pending_request_id = recorded.request_id
      }
      let result: GeminiImageCandidate[] | null = null
      try {
        const out = await this.gemini.generate({
          prompt: input.prompt,
          count: requestCount,
        })
        result = out.candidates
      } catch (err) {
        if (err instanceof GeminiImagenError) {
          if (pending_request_id !== null && this.pendingStore !== null) {
            await this.pendingStore.markFailed(pending_request_id)
          }
          failures += 1
          await this.bumpFailure(job_id)
          continue
        }
        if (pending_request_id !== null && this.pendingStore !== null) {
          await this.pendingStore.markFailed(pending_request_id)
        }
        throw err
      }
      // We accept partial-success calls. Per the user-pick-race fix
      // above, before persisting candidate rows we re-check whether
      // the user already terminated the job — if so, the bytes-on-disk
      // are harmless (they live in the candidates dir) but we DO NOT
      // create new candidate rows or flip status away from the user's
      // chosen terminal state.
      if (await this.isUserTerminated(job_id)) {
        if (pending_request_id !== null && this.pendingStore !== null) {
          // Mark as failed so the stale 'pending' row doesn't trip the
          // resume-on-boot scan. The user already picked a fallback
          // / uploaded their own — this call is moot.
          await this.pendingStore.markFailed(pending_request_id)
        }
        return
      }
      let firstCandidatePath: string | null = null
      for (const cand of result) {
        const candidate_id = cand.candidate_id || this.uuid()
        const path = join(candidatesDir, `${candidate_id}.png`)
        writeFileSync(path, cand.bytes)
        const ts = this.now()
        await this.db.run(
          `INSERT INTO profile_pic_candidates (id, job_id, path, source, created_at, picked_at)
           VALUES (?, ?, ?, 'gemini', ?, NULL)`,
          [candidate_id, job_id, path, ts],
        )
        if (firstCandidatePath === null) firstCandidatePath = path
        landed += 1
      }
      if (landed >= 1) {
        if (pending_request_id !== null && this.pendingStore !== null && firstCandidatePath !== null) {
          await this.pendingStore.markCompleted(pending_request_id, firstCandidatePath)
        }
        await this.setStatusAndCompleteIfNotTerminated(job_id, 'ready')
        return
      }
      // Gemini returned but with zero bytes that made it to disk —
      // counts as a failure. Mark the pending row so we don't strand it.
      if (pending_request_id !== null && this.pendingStore !== null) {
        await this.pendingStore.markFailed(pending_request_id)
      }
      failures += 1
      await this.bumpFailure(job_id)
    }
    // Budget exhausted with no successful generation — fall back, but
    // only if the user hasn't already terminated the job.
    if (await this.isUserTerminated(job_id)) return
    await this.applyFallback(job_id, input.archetype_hint)
  }

  /**
   * True iff the job is in a user-chosen terminal state
   * (`'fallback'` from `pickFallback`, `'user_uploaded'` from
   * `acceptUpload`, or `'failed'` from a disk-level gallery miss).
   * The worker uses this as a "stop, don't touch the row" gate.
   */
  private async isUserTerminated(job_id: string): Promise<boolean> {
    const row = this.db
      .get<{ status: string }, [string]>(
        `SELECT status FROM profile_pic_jobs WHERE id = ?`,
        [job_id],
      )
    if (row === null) return true
    return (
      row.status === 'fallback' ||
      row.status === 'user_uploaded' ||
      row.status === 'failed'
    )
  }

  private async applyFallback(
    job_id: string,
    archetype_hint: string | undefined,
  ): Promise<void> {
    let portrait
    try {
      portrait = this.fallback.pick(archetype_hint ?? FALLBACK_DEFAULT_SLUG)
    } catch (err) {
      // Disk-level gallery missing — surface as 'failed' so the UI can
      // route to upload-only flow.
      await this.setStatusAndComplete(job_id, 'failed')
      throw new ProfilePicError(
        'gallery_missing',
        `fallback gallery unreachable for job=${job_id}`,
        err,
      )
    }
    const personaDir = join(this.ownerHome, 'persona')
    const candidatesDir = join(personaDir, 'profile-pic-candidates')
    mkdirSync(candidatesDir, { recursive: true })
    const candidate_id = this.uuid()
    const path = join(candidatesDir, `${candidate_id}.png`)
    writeFileSync(path, portrait.bytes)
    const ts = this.now()
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO profile_pic_candidates (id, job_id, path, source, created_at, picked_at)
         VALUES (?, ?, ?, 'fallback', ?, NULL)`,
        [candidate_id, job_id, path, ts],
      )
      await tx.run(
        `UPDATE profile_pic_jobs SET status = 'fallback', completed_at = ?, fallback_used = 1 WHERE id = ?`,
        [ts, job_id],
      )
    })
  }

  /**
   * Update `status` only when the job has not been moved to a user-chosen
   * terminal state (`'fallback'` from `pickFallback`, `'user_uploaded'` from
   * `acceptUpload`, `'failed'` from a disk-level gallery miss) or already
   * completed (`'ready'`). The worker uses this to flip 'pending' → 'generating'
   * without overwriting a tap that landed before the worker resumed.
   */
  private async setStatusIfNotTerminated(
    job_id: string,
    status: ProfilePicJobStatus,
  ): Promise<void> {
    await this.db.run(
      `UPDATE profile_pic_jobs SET status = ?
         WHERE id = ?
           AND status NOT IN ('fallback', 'user_uploaded', 'failed', 'ready')`,
      [status, job_id],
    )
  }

  private async setStatusAndComplete(
    job_id: string,
    status: ProfilePicJobStatus,
  ): Promise<void> {
    const ts = this.now()
    await this.db.run(
      `UPDATE profile_pic_jobs SET status = ?, completed_at = ? WHERE id = ?`,
      [status, ts, job_id],
    )
  }

  /** Like setStatusAndComplete but skips the write if user has terminated. */
  private async setStatusAndCompleteIfNotTerminated(
    job_id: string,
    status: ProfilePicJobStatus,
  ): Promise<void> {
    const ts = this.now()
    await this.db.run(
      `UPDATE profile_pic_jobs SET status = ?, completed_at = ?
         WHERE id = ?
           AND status NOT IN ('fallback', 'user_uploaded', 'failed')`,
      [status, ts, job_id],
    )
  }

  private async bumpFailure(job_id: string): Promise<void> {
    await this.db.run(
      `UPDATE profile_pic_jobs SET failure_count = failure_count + 1 WHERE id = ?`,
      [job_id],
    )
  }
}

/** Small helper used in tests + by external pipeline composition. */
export function archetypeHintToFallbackSlug(hint: string | undefined): FallbackArchetypeSlug {
  return normalizeArchetype(hint)
}
