/**
 * ISSUE #45 — completed-after-Wait race fires duplicate Gemini call.
 *
 * PR #302 closed the in-flight dedupe (a 'pending' row inside the 60 s
 * freshness window short-circuits a fresh `pipeline.start`). The
 * residual hole this sprint closes: when the boot-resume auto-retry's
 * `markCompleted` lands BEFORE the user taps Wait, the next
 * `ensureCandidates` observed `latest.status === 'completed'` and
 * (lacking any reference to the live job) fell through to a brand-new
 * `pipeline.start`. A second Gemini call fired; the bytes on disk from
 * the boot retry were orphaned.
 *
 * Mechanism: migration 0047 adds a nullable `job_id` column to
 * `profile_pic_pending`. The pipeline stamps it at recordPending time
 * (inside `pipeline.run(job_id, …)`), so every row written under the
 * new schema references its originating `profile_pic_jobs.id`. The
 * engine hook reads that reference on phase-enter and surfaces the
 * stored job's candidates instead of re-running Gemini.
 *
 * The two regression cases below model the exact race + the legacy
 * fall-through path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  GeminiImagenClient,
  type GeminiImagenFn,
} from '../gemini-imagegen.ts'
import { ProfilePicPipeline } from '../pipeline.ts'
import { ProfilePicPendingStore } from '../pending-call-store.ts'
import { buildProfilePicEngineHook } from '../storage.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-issue45-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────────────
// Test fixture — seed a completed pending row + the matching jobs row +
// candidates. Mirrors the on-disk state the boot-resume auto-retry
// would leave behind when its Gemini call landed before the user
// re-entered the phase.
// ────────────────────────────────────────────────────────────────────

interface SeedOptions {
  owner_slug: string
  user_id: string
  /**
   * Stamp this `job_id` on the pending row. Pass `null` to model the
   * legacy / pre-migration-0047 case where the pending row predates the
   * column.
   */
  pending_row_job_id: string | null
  /**
   * The actual `profile_pic_jobs.id` to insert (with status='ready'
   * and one candidate). When `pending_row_job_id !== null` and matches
   * this value, the engine hook's ISSUE #45 branch is exercised; when
   * they differ (e.g. legacy null case), the legacy fall-through path
   * fires `pipeline.start` fresh.
   */
  jobs_row_id: string
  candidate_id: string
}

function seedCompletedState(opts: SeedOptions): void {
  const now = 1_700_000_000
  // 1. profile_pic_jobs row in 'ready' status — what `pipeline.status(...)`
  //    will surface to the engine hook.
  db.raw().run(
    `INSERT INTO profile_pic_jobs
       (id, project_slug, status, archetype_hint, started_at, completed_at,
        fallback_used, failure_count)
     VALUES (?, ?, 'ready', NULL, ?, ?, 0, 0)`,
    [opts.jobs_row_id, opts.owner_slug, now - 30_000, now - 5_000],
  )
  // 2. The corresponding candidate row.
  db.raw().run(
    `INSERT INTO profile_pic_candidates
       (id, job_id, path, source, created_at, picked_at)
     VALUES (?, ?, ?, 'gemini', ?, NULL)`,
    [
      opts.candidate_id,
      opts.jobs_row_id,
      `/tmp/fake-candidate-path/${opts.candidate_id}.png`,
      now - 5_000,
    ],
  )
  // 3. The pending row in 'completed' state. The `job_id` column is the
  //    point of this test — set or NULL per the case under test.
  db.raw().run(
    `INSERT INTO profile_pic_pending
       (request_id, project_slug, user_id, prompt, archetype_hint,
        started_at, completed_at, result_path, status,
        auto_retry_attempted, job_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'completed', 1, ?)`,
    [
      `req-${opts.jobs_row_id}`,
      opts.owner_slug,
      opts.user_id,
      'boot-retry prompt',
      now - 30_000,
      now - 5_000,
      `/tmp/fake-candidate-path/${opts.candidate_id}.png`,
      opts.pending_row_job_id,
    ],
  )
}

interface SpyingPipelineHandles {
  pipeline: ProfilePicPipeline
  startCalls: number
  geminiCalls: number
}

function buildSpyingPipeline(): SpyingPipelineHandles {
  const handles: SpyingPipelineHandles = {
    pipeline: null as unknown as ProfilePicPipeline,
    startCalls: 0,
    geminiCalls: 0,
  }
  const fn: GeminiImagenFn = async () => {
    handles.geminiCalls += 1
    return {
      candidates: [
        {
          candidate_id: `unexpected-fresh-${handles.geminiCalls}`,
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          width: 1,
          height: 1,
        },
      ],
      dollars_billed: 0,
    }
  }
  const pipeline = new ProfilePicPipeline({
    db,
    owner_home: join(tmp, 'home'),
    gemini: new GeminiImagenClient({ generate: fn }),
  })
  // Wrap `start` to count calls — the regression is "start MUST NOT
  // fire when a completed row with job_id is on disk."
  const realStart = pipeline.start.bind(pipeline)
  pipeline.start = async (input) => {
    handles.startCalls += 1
    return realStart(input)
  }
  handles.pipeline = pipeline
  return handles
}

// ────────────────────────────────────────────────────────────────────
// CASE 1 — Regression. Completed pending row WITH job_id → engine hook
// surfaces the stored job's candidates and does NOT call pipeline.start.
// ────────────────────────────────────────────────────────────────────

describe('ISSUE #45 — completed pending row with job_id short-circuits', () => {
  test('engine hook surfaces stored candidates without firing pipeline.start', async () => {
    seedCompletedState({
      owner_slug: 't-race',
      user_id: 'u-race',
      pending_row_job_id: 'job-123',
      jobs_row_id: 'job-123',
      candidate_id: 'cand-existing-1',
    })

    const handles = buildSpyingPipeline()
    const hook = buildProfilePicEngineHook({
      pipeline: handles.pipeline,
      owner_handle: null,
      owner_home: '/tmp/dummy',
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) =>
        `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'should not reach Gemini',
      pendingStore: handles.pipeline.pendingCallStore(),
      setBotAvatar: async () => ({ ok: true }),
    })

    const outcome = await hook.ensureCandidates({
      owner_slug: 't-race',
      topic_id: 'topic-race',
      user_id: 'u-race',
      agent_name: null,
      archetype_hint: null,
    })

    // The brief's two acceptance gates: kind='ready' surfaces the
    // seeded candidate AND pipeline.start was NOT called.
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.job_id).toBe('job-123')
      expect(outcome.candidates).toHaveLength(1)
      expect(outcome.candidates[0]?.candidate_id).toBe('cand-existing-1')
      expect(outcome.candidates[0]?.image_url).toBe(
        '/profile-pic/candidate/cand-existing-1.png',
      )
      expect(outcome.from_fallback).toBe(false)
    }
    expect(handles.startCalls).toBe(0)
    expect(handles.geminiCalls).toBe(0)
  })

  test('does not over-trim — surfaces up to 4 stored candidates', async () => {
    // Defensive: the boot-retry might have landed multiple candidates.
    // The engine hook caps at 4 (A-D picker labels). Seed 3 and confirm
    // all 3 surface.
    const now = 1_700_000_000
    db.raw().run(
      `INSERT INTO profile_pic_jobs
         (id, project_slug, status, archetype_hint, started_at, completed_at,
          fallback_used, failure_count)
       VALUES ('job-multi', 't-multi', 'ready', NULL, ?, ?, 0, 0)`,
      [now - 30_000, now - 5_000],
    )
    for (const id of ['cand-a', 'cand-b', 'cand-c']) {
      db.raw().run(
        `INSERT INTO profile_pic_candidates
           (id, job_id, path, source, created_at, picked_at)
         VALUES (?, 'job-multi', ?, 'gemini', ?, NULL)`,
        [id, `/tmp/fake/${id}.png`, now - 5_000],
      )
    }
    db.raw().run(
      `INSERT INTO profile_pic_pending
         (request_id, project_slug, user_id, prompt, archetype_hint,
          started_at, completed_at, result_path, status,
          auto_retry_attempted, job_id)
       VALUES ('req-multi', 't-multi', 'u-multi', 'p', NULL, ?, ?, ?,
               'completed', 1, 'job-multi')`,
      [now - 30_000, now - 5_000, '/tmp/fake/cand-a.png'],
    )

    const handles = buildSpyingPipeline()
    const hook = buildProfilePicEngineHook({
      pipeline: handles.pipeline,
      owner_handle: null,
      owner_home: '/tmp/dummy',
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) =>
        `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'unused',
      pendingStore: handles.pipeline.pendingCallStore(),
      setBotAvatar: async () => ({ ok: true }),
    })

    const outcome = await hook.ensureCandidates({
      owner_slug: 't-multi',
      topic_id: 'topic-multi',
      user_id: 'u-multi',
      agent_name: null,
      archetype_hint: null,
    })

    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.candidates).toHaveLength(3)
    }
    expect(handles.startCalls).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// CASE 2 — Legacy fall-through. Completed pending row WITHOUT job_id
// (pre-migration-0047 row) → engine hook falls through to pipeline.start
// so the user is not stranded on an unrecoverable row.
// ────────────────────────────────────────────────────────────────────

describe('ISSUE #45 — completed pending row without job_id falls through (legacy)', () => {
  test('pipeline.start IS called when job_id is NULL', async () => {
    seedCompletedState({
      owner_slug: 't-legacy',
      user_id: 'u-legacy',
      pending_row_job_id: null, // legacy row; no job reference
      jobs_row_id: 'job-orphan',
      candidate_id: 'cand-orphan',
    })

    const handles = buildSpyingPipeline()
    const hook = buildProfilePicEngineHook({
      pipeline: handles.pipeline,
      owner_handle: null,
      owner_home: '/tmp/dummy',
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) =>
        `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'fresh start prompt',
      pendingStore: handles.pipeline.pendingCallStore(),
      setBotAvatar: async () => ({ ok: true }),
      wait_for_candidates: true,
    })

    const outcome = await hook.ensureCandidates({
      owner_slug: 't-legacy',
      topic_id: 'topic-legacy',
      user_id: 'u-legacy',
      agent_name: null,
      archetype_hint: null,
    })

    // Legacy behavior preserved: pipeline.start fired exactly once and
    // produced a fresh ready outcome. The orphaned candidate (cand-orphan)
    // is NOT surfaced because the row had no job reference.
    expect(handles.startCalls).toBe(1)
    expect(handles.geminiCalls).toBe(1)
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      // The fresh job is a NEW job id (not 'job-orphan').
      expect(outcome.job_id).not.toBe('job-orphan')
      // The candidate comes from the fresh Gemini call, not the
      // orphaned one.
      expect(outcome.candidates[0]?.candidate_id).toMatch(
        /^unexpected-fresh-/,
      )
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// CASE 3 — Sanity: the pipeline itself stamps job_id on every
// recordPending call. The boot-retry path inherits this for free since
// it transitively flows through `pipeline.run(job_id, …)`.
// ────────────────────────────────────────────────────────────────────

describe('ISSUE #45 — pipeline.run stamps job_id on pending rows', () => {
  test('a fresh pipeline.start produces a pending row carrying the job_id', async () => {
    const handles = buildSpyingPipeline()
    const store = handles.pipeline.pendingCallStore()!
    const { job_id } = await handles.pipeline.start({
      owner_slug: 't-stamp',
      user_id: 'u-stamp',
      prompt: 'a portrait under desert dusk',
    })
    await handles.pipeline.awaitJob(job_id)

    const latest = await store.latestForUser('t-stamp', 'u-stamp')
    expect(latest).not.toBeNull()
    expect(latest!.status).toBe('completed')
    expect(latest!.job_id).toBe(job_id)
  })

  test('legacy recordPending without job_id stores NULL', async () => {
    // The recordPending signature accepts job_id as optional + nullable
    // so direct test callers (and any pre-migration code that survives)
    // can omit it; the column stores NULL and the engine hook routes
    // such rows through the legacy fall-through branch.
    const store = new ProfilePicPendingStore({ db })
    const { request_id } = await store.recordPending({
      owner_slug: 't-no-stamp',
      user_id: 'u-no-stamp',
      prompt: 'no job reference',
    })
    const row = await store.get(request_id)
    expect(row).not.toBeNull()
    expect(row!.job_id).toBeNull()
  })
})
