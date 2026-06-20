/**
 * Profile-pic process-restart resume — durable Gemini-call recovery.
 *
 * Per SPEC.md Phases→Steps (was SPEC.md § Phases→Steps cross-cutting brief Part D.
 *
 * Verifies the four lifecycle paths the brief calls out:
 *
 *   1. Pending-row survives a simulated restart (close DB + reopen).
 *   2. Expired path — row aged into the retry window AND
 *      auto_retry_attempted=0 → boot hook flips to 'expired' + fires
 *      ONE auto-retry call against the pipeline.
 *   3. Failed path — row whose auto_retry_attempted=1 → boot hook flips
 *      to 'failed'; engine surfaces "previous attempt failed, retry?"
 *   4. Happy path — call completes in the same process → row at
 *      'completed' with result_path populated.
 *
 * Plus a couple of guard-rails the brief implies but doesn't enumerate:
 *
 *   - Engine hook surfaces 'expired' as kind='failed' with the
 *     "previous attempt timed out, retry?" reason string.
 *   - Engine hook surfaces 'failed' as kind='failed' with the
 *     "previous attempt failed, retry?" reason string.
 *   - Fresh pending rows (< 60 s old) are kept untouched on boot.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  GeminiImagenClient,
  GeminiImagenError,
  type GeminiImageCandidate,
  type GeminiImagenFn,
  type GeminiImagenOutput,
} from '../gemini-imagegen.ts'
import { ProfilePicPipeline } from '../pipeline.ts'
import { ProfilePicPendingStore } from '../pending-call-store.ts'
import {
  resumeProfilePicOnBoot,
  DEFAULT_PENDING_FRESH_WINDOW_MS,
  DEFAULT_PENDING_HARD_FAIL_WINDOW_MS,
} from '../restart-resume.ts'
import { buildProfilePicEngineHook } from '../storage.ts'
import type { ProfilePicEngineHook } from '../../interview/engine.ts'

let tmp: string
let dbPath: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-resume-'))
  dbPath = join(tmp, 'project.db')
  db = ProjectDb.open(dbPath)
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function dummyPng(byte: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, byte])
}

function dummyCandidate(id: string, byte: number): GeminiImageCandidate {
  return {
    candidate_id: id,
    bytes: dummyPng(byte),
    width: 1,
    height: 1,
  }
}

function buildClient(fn: GeminiImagenFn): GeminiImagenClient {
  return new GeminiImagenClient({ generate: fn })
}

// ────────────────────────────────────────────────────────────────────
// Part D test 1 — pending row survives a simulated restart.
// ────────────────────────────────────────────────────────────────────

describe('pending row survives process restart', () => {
  test('row written before crash is visible on reopen', async () => {
    // Insert a row manually (simulates the pipeline beginning a call).
    const store1 = new ProfilePicPendingStore({ db, now: () => 1_000_000 })
    const { request_id } = await store1.recordPending({
      project_slug: 't1',
      user_id: 'u1',
      prompt: 'wise raven-keeper',
    })

    // Close the DB handle as if the gateway process died.
    db.close()

    // Reopen the SAME file from a fresh handle — the row must still
    // be there. This is the "process restart" the brief calls for.
    db = ProjectDb.open(dbPath)
    const store2 = new ProfilePicPendingStore({ db, now: () => 1_500_000 })
    const row = await store2.get(request_id)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('pending')
    expect(row!.project_slug).toBe('t1')
    expect(row!.user_id).toBe('u1')
    expect(row!.prompt).toBe('wise raven-keeper')
    expect(row!.started_at).toBe(1_000_000)
    expect(row!.completed_at).toBeNull()
    expect(row!.result_path).toBeNull()
    expect(row!.auto_retry_attempted).toBe(false)

    // listPending() should still surface it.
    const pending = await store2.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.request_id).toBe(request_id)
  })
})

// ────────────────────────────────────────────────────────────────────
// Part D test 2 — expired path: 6-min-old row → expired + auto-retry.
// ────────────────────────────────────────────────────────────────────

describe('resume-on-boot expired path', () => {
  test('aged pending row transitions to expired AND fires one auto-retry', async () => {
    // Stash a stale pending row directly (simulating a row written 6 min
    // before the current "boot time"). 6 min > 5 min hard window AND
    // auto_retry_attempted=0 — so the hook applies the "first-time stale,
    // expire + retry" branch. We pump the fresh + hard windows up to
    // 7 min so 6 min falls into the retry zone (auto_retry not yet
    // attempted) per the brief's stated test outcome.
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000

    const seedStore = new ProfilePicPendingStore({ db, now: () => sixMinAgo })
    const { request_id } = await seedStore.recordPending({
      project_slug: 't1',
      user_id: 'u1',
      prompt: 'stalwart guardian',
    })

    // Close + reopen — simulates the boot crossing a real restart.
    db.close()
    db = ProjectDb.open(dbPath)

    const home = join(tmp, 'home')
    let generateCalls = 0
    const fn: GeminiImagenFn = async () => {
      generateCalls += 1
      const out: GeminiImagenOutput = {
        candidates: [dummyCandidate(`retry-${generateCalls}`, 0xb1)],
        dollars_billed: 0.02,
      }
      return out
    }
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      now: () => bootTime,
    })
    const store = pipeline.pendingCallStore()!

    // Tune the fresh + hard windows so 6 min is "stale but inside the
    // retry zone": fresh=60s, hard=7min (default 5min would route
    // straight to 'failed' here).
    const result = await resumeProfilePicOnBoot({
      store,
      pipeline,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })

    expect(result.expired).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.kept_pending).toBe(0)
    expect(result.auto_retries_fired).toBe(1)
    expect(result.auto_retry_job_ids).toHaveLength(1)

    // The auto-retry pipeline.start fires fire-and-forget; await it so
    // the in-process pending row write lands before we inspect.
    for (const jid of result.auto_retry_job_ids) {
      await pipeline.awaitJob(jid)
    }

    const after = await store.get(request_id)
    expect(after).not.toBeNull()
    expect(after!.status).toBe('expired')
    expect(after!.auto_retry_attempted).toBe(true)

    // Auto-retry started a new pipeline run; the new run's pending row
    // is observable (status is whatever the in-process call landed at).
    const allRows = db
      .raw()
      .query<{ request_id: string; status: string; project_slug: string }, []>(
        `SELECT request_id, status, project_slug FROM profile_pic_pending ORDER BY started_at ASC`,
      )
      .all()
    expect(allRows).toHaveLength(2)
    expect(allRows[0]!.request_id).toBe(request_id)
    expect(allRows[0]!.status).toBe('expired')
    // Second row corresponds to the auto-retry call.
    expect(allRows[1]!.status).toBe('completed')
    expect(allRows[1]!.project_slug).toBe('t1')

    // The pipeline.start did one Gemini call.
    expect(generateCalls).toBe(1)
  })

  test('expired row WITHOUT pipeline dep transitions cleanly + reports 0 retries fired', async () => {
    // Without a pipeline dep the boot hook should still expire the row;
    // the engine will fire a retry via the picker when the user re-enters
    // the phase. This is the test+ guardrail the brief implies — the
    // pipeline injection is optional.
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000

    const seedStore = new ProfilePicPendingStore({ db, now: () => sixMinAgo })
    const { request_id } = await seedStore.recordPending({
      project_slug: 't2',
      user_id: 'u2',
      prompt: 'silent watcher',
    })

    const observerStore = new ProfilePicPendingStore({ db, now: () => bootTime })
    const result = await resumeProfilePicOnBoot({
      store: observerStore,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })

    expect(result.expired).toBe(1)
    expect(result.auto_retries_fired).toBe(0)
    const row = await observerStore.get(request_id)
    expect(row!.status).toBe('expired')
    expect(row!.auto_retry_attempted).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// Part D test 3 — failed path: row > 5 min old AND auto-retry already
// fired → status='failed'; engine surfaces "previous attempt failed,
// retry?"
// ────────────────────────────────────────────────────────────────────

describe('resume-on-boot failed path', () => {
  test('row with auto_retry_attempted=1 transitions to failed (not re-expired)', async () => {
    // Insert a pending row that has already been auto-retried once.
    // Boot hook should mark it 'failed' (we don't auto-retry the same
    // call twice — the user has to re-trigger from the picker).
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000

    await db.run(
      `INSERT INTO profile_pic_pending
         (request_id, project_slug, user_id, prompt, started_at, status, auto_retry_attempted)
       VALUES ('req-already-retried', 't3', 'u3', 'lost portrait', ?, 'pending', 1)`,
      [sixMinAgo],
    )

    const home = join(tmp, 'home')
    let generateCalls = 0
    const fn: GeminiImagenFn = async () => {
      generateCalls += 1
      const out: GeminiImagenOutput = {
        candidates: [dummyCandidate(`should-not-fire-${generateCalls}`, 0xc0)],
        dollars_billed: 0,
      }
      return out
    }
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      now: () => bootTime,
    })
    const store = pipeline.pendingCallStore()!

    const result = await resumeProfilePicOnBoot({
      store,
      pipeline,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })

    expect(result.failed).toBe(1)
    expect(result.expired).toBe(0)
    expect(result.auto_retries_fired).toBe(0)
    expect(generateCalls).toBe(0) // no auto-retry fires when retry was already attempted

    const row = await store.get('req-already-retried')
    expect(row!.status).toBe('failed')
    expect(row!.auto_retry_attempted).toBe(true) // unchanged

    // Engine hook surfaces "previous attempt failed, retry?" as the reason.
    const hook = buildEngineHookOver(pipeline, store)
    const outcome = await hook.ensureCandidates({
      project_slug: 't3',
      topic_id: 'topic-1',
      user_id: 'u3',
      agent_name: null,
      archetype_hint: null,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.reason : '').toBe(
      'previous attempt failed, retry?',
    )
  })

  test('row older than the hard-fail window → failed (regardless of auto_retry flag)', async () => {
    // Default windows: fresh=60s, hard=5min. A 10-min-old row crosses
    // the absolute ceiling — must transition to 'failed' even with
    // auto_retry_attempted=0.
    const tenMinAgo = 1_000_000_000
    const bootTime = tenMinAgo + 10 * 60_000

    const seedStore = new ProfilePicPendingStore({ db, now: () => tenMinAgo })
    const { request_id } = await seedStore.recordPending({
      project_slug: 't4',
      user_id: 'u4',
      prompt: 'distant memory',
    })

    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: null,
      now: () => bootTime,
    })
    const store = pipeline.pendingCallStore()!

    const result = await resumeProfilePicOnBoot({
      store,
      now: () => bootTime,
      // Defaults: fresh=60s, hard=5min — 10 min old → failed.
    })

    expect(result.failed).toBe(1)
    expect(result.expired).toBe(0)

    const row = await store.get(request_id)
    expect(row!.status).toBe('failed')
  })
})

// ────────────────────────────────────────────────────────────────────
// Part D test 4 — happy path: call completes in the same process.
// ────────────────────────────────────────────────────────────────────

describe('happy-path: same-process completion', () => {
  test('pipeline.run writes completed row with result_path populated', async () => {
    const fn: GeminiImagenFn = async () => ({
      candidates: [dummyCandidate('happy-cand', 0xa1)],
      dollars_billed: 0.02,
    })
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const store = pipeline.pendingCallStore()!

    const { job_id } = await pipeline.start({
      project_slug: 'project-happy',
      user_id: 'user-happy',
      archetype_hint: 'krishna',
      prompt: 'A radiant flute-keeper.',
    })
    await pipeline.awaitJob(job_id)

    const status = await pipeline.status(job_id)
    expect(status!.status).toBe('ready')

    // Pending store must have one row, status='completed', result_path
    // pointing at the first candidate's PNG on disk.
    const latest = await store.latestForUser('project-happy', 'user-happy')
    expect(latest).not.toBeNull()
    expect(latest!.status).toBe('completed')
    expect(latest!.result_path).not.toBeNull()
    expect(existsSync(latest!.result_path!)).toBe(true)
    expect(latest!.completed_at).not.toBeNull()
  })

  test('Gemini-error path marks pending row failed (in-process)', async () => {
    let calls = 0
    const fn: GeminiImagenFn = async () => {
      calls += 1
      throw new GeminiImagenError('rate_limited', 'too many requests')
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
      failure_budget: 2,
    })
    const store = pipeline.pendingCallStore()!

    const { job_id } = await pipeline.start({
      project_slug: 'project-fail',
      user_id: 'user-fail',
      prompt: 'will not land',
    })
    await pipeline.awaitJob(job_id)

    // Each retry inside the failure budget writes its own pending row.
    expect(calls).toBe(2)
    const allRows = db
      .raw()
      .query<{ status: string }, []>(
        `SELECT status FROM profile_pic_pending WHERE project_slug = 'project-fail'`,
      )
      .all()
    expect(allRows).toHaveLength(2)
    for (const r of allRows) {
      expect(r.status).toBe('failed')
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// Guard rails — engine outcome reason strings + fresh-window behavior.
// ────────────────────────────────────────────────────────────────────

describe('engine hook reads the durable store on phase-enter', () => {
  test('expired row surfaces "previous attempt timed out, retry?"', async () => {
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000

    const seedStore = new ProfilePicPendingStore({ db, now: () => sixMinAgo })
    await seedStore.recordPending({
      project_slug: 't-eng',
      user_id: 'u-eng',
      prompt: 'first attempt',
    })

    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: null,
      now: () => bootTime,
    })
    const store = pipeline.pendingCallStore()!

    await resumeProfilePicOnBoot({
      store,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })

    const hook = buildEngineHookOver(pipeline, store)
    const outcome = await hook.ensureCandidates({
      project_slug: 't-eng',
      topic_id: 'topic-eng',
      user_id: 'u-eng',
      agent_name: null,
      archetype_hint: null,
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.reason : '').toBe(
      'previous attempt timed out, retry?',
    )
  })

  test('completed row WITH job_id (ISSUE #45) surfaces existing candidates — does NOT re-run Gemini', async () => {
    // ISSUE #45 — the boot-resume auto-retry may complete BEFORE the user
    // taps Wait. When the user re-enters the phase, the engine hook must
    // surface the completed job's candidates rather than firing a fresh
    // pipeline.start (which would burn a second Gemini call AND orphan
    // the bytes the retry already produced).
    //
    // The dedicated `completed-after-wait-race.test.ts` file holds the
    // primary regression coverage; this guards the same property from
    // the existing "engine reads durable store" describe block so it
    // doesn't silently drift back to the old (wrong) behavior.
    let calls = 0
    const fn: GeminiImagenFn = async () => {
      calls += 1
      return {
        candidates: [dummyCandidate(`call-${calls}`, 0xa1)],
        dollars_billed: 0,
      }
    }
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const store = pipeline.pendingCallStore()!

    // Land a completed row. With migration 0047 the pending row carries
    // the originating job_id.
    const { job_id } = await pipeline.start({
      project_slug: 't-comp',
      user_id: 'u-comp',
      prompt: 'first attempt',
    })
    await pipeline.awaitJob(job_id)
    expect(calls).toBe(1)
    const completedRow = await store.latestForUser('t-comp', 'u-comp')
    expect(completedRow!.status).toBe('completed')
    expect(completedRow!.job_id).toBe(job_id)

    // Phase-enter — engine hook short-circuits to the stored job's
    // candidates and does NOT fire pipeline.start again.
    const hook = buildEngineHookOver(pipeline, store, { wait_for_candidates: true })
    const outcome = await hook.ensureCandidates({
      project_slug: 't-comp',
      topic_id: 'topic-comp',
      user_id: 'u-comp',
      agent_name: null,
      archetype_hint: null,
    })
    expect(outcome.kind).toBe('ready')
    if (outcome.kind === 'ready') {
      expect(outcome.job_id).toBe(job_id) // SAME job — not a fresh one
    }
    expect(calls).toBe(1) // no duplicate Gemini call
  })
})

// ────────────────────────────────────────────────────────────────────
// Argus r1 BLOCKER 2 — engine hook reads from the durable pending store.
// ────────────────────────────────────────────────────────────────────

describe('Argus r1 BLOCKER 2 — phase-enter handler queries pendingStore', () => {
  test('ensureCandidates(without prior_job_id) calls pendingStore.latestForUser', async () => {
    // Spy: a sentinel pendingStore whose latestForUser records calls
    // and returns null (no prior row) so the hook falls through to
    // pipeline.start. We then assert the spy was actually invoked.
    const home = join(tmp, 'home')
    let calls = 0
    const fn: GeminiImagenFn = async () => {
      calls += 1
      return {
        candidates: [dummyCandidate(`hook-${calls}`, 0xa1)],
        dollars_billed: 0,
      }
    }
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const realStore = pipeline.pendingCallStore()!

    const spy: Array<{ project_slug: string; user_id: string | null }> = []
    const spyingStore = {
      ...realStore,
      latestForUser: async (
        project_slug: string,
        user_id: string | null,
      ): Promise<null> => {
        spy.push({ project_slug, user_id })
        return null
      },
    } as unknown as ProfilePicPendingStore

    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: '/tmp/dummy',
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'spy test prompt',
      pendingStore: spyingStore,
      setBotAvatar: async () => ({ ok: true }),
      wait_for_candidates: true,
    })

    await hook.ensureCandidates({
      project_slug: 't-spy',
      topic_id: 'topic-spy',
      user_id: 'u-spy',
      agent_name: null,
      archetype_hint: null,
    })

    expect(spy).toHaveLength(1)
    expect(spy[0]?.project_slug).toBe('t-spy')
    expect(spy[0]?.user_id).toBe('u-spy')
    expect(calls).toBe(1) // pipeline.start fired exactly once (no short-circuit on null)
  })

  test('ensureCandidates with a prior_job_id does NOT consult pendingStore', async () => {
    // Sanity: the polling re-check path (prior_job_id present) does
    // not need the pending store — it just peeks the pipeline status.
    const home = join(tmp, 'home')
    const fn: GeminiImagenFn = async () => ({
      candidates: [dummyCandidate('prior', 0xb1)],
      dollars_billed: 0,
    })
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(fn),
    })
    const realStore = pipeline.pendingCallStore()!
    const { job_id } = await pipeline.start({
      project_slug: 't-prior',
      user_id: 'u-prior',
      prompt: 'prior',
    })
    await pipeline.awaitJob(job_id)

    let spyCalls = 0
    const spyingStore = {
      ...realStore,
      latestForUser: async (): Promise<null> => {
        spyCalls += 1
        return null
      },
    } as unknown as ProfilePicPendingStore

    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: '/tmp/dummy',
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'spy test prompt',
      pendingStore: spyingStore,
      setBotAvatar: async () => ({ ok: true }),
      wait_for_candidates: true,
    })

    await hook.ensureCandidates({
      project_slug: 't-prior',
      topic_id: 'topic-prior',
      user_id: 'u-prior',
      agent_name: null,
      archetype_hint: null,
      prior_job_id: job_id,
    })

    expect(spyCalls).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Argus r1 BLOCKER 3 — auto-retry uses persisted archetype_hint.
// ────────────────────────────────────────────────────────────────────

describe('Argus r1 BLOCKER 3 — auto-retry preserves archetype_hint', () => {
  test('persisted archetype_hint flows into the boot-hook auto-retry call', async () => {
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000
    const ARCHETYPE = 'krishna'

    // Seed a stale pending row WITH archetype_hint set.
    const seedStore = new ProfilePicPendingStore({ db, now: () => sixMinAgo })
    const { request_id } = await seedStore.recordPending({
      project_slug: 't-arch',
      user_id: 'u-arch',
      prompt: 'a flute-keeper in soft dusk light',
      archetype_hint: ARCHETYPE,
    })

    // Sanity: the stored row carries the hint.
    const seeded = await seedStore.get(request_id)
    expect(seeded?.archetype_hint).toBe(ARCHETYPE)

    // Capture every pipeline.start input the boot hook fires so we can
    // assert archetype_hint propagates intact (not collapsed to the
    // FALLBACK_DEFAULT_SLUG via missing-hint fallback).
    const started: Array<{
      project_slug: string
      archetype_hint?: string
      prompt: string
      user_id?: string
    }> = []
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(async () => ({
        candidates: [dummyCandidate('retry-cand', 0xb1)],
        dollars_billed: 0,
      })),
      now: () => bootTime,
    })
    const realStart = pipeline.start.bind(pipeline)
    pipeline.start = async (input) => {
      const captured: typeof started[number] = {
        project_slug: input.project_slug,
        prompt: input.prompt,
      }
      if (input.archetype_hint !== undefined) captured.archetype_hint = input.archetype_hint
      if (input.user_id !== undefined) captured.user_id = input.user_id
      started.push(captured)
      return realStart(input)
    }

    const store = pipeline.pendingCallStore()!
    const result = await resumeProfilePicOnBoot({
      store,
      pipeline,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })
    for (const jid of result.auto_retry_job_ids) await pipeline.awaitJob(jid)

    expect(result.expired).toBe(1)
    expect(result.auto_retries_fired).toBe(1)
    expect(started).toHaveLength(1)
    expect(started[0]?.archetype_hint).toBe(ARCHETYPE)
    expect(started[0]?.project_slug).toBe('t-arch')
    expect(started[0]?.user_id).toBe('u-arch')
    expect(started[0]?.prompt).toBe('a flute-keeper in soft dusk light')

    // The freshly-written pending row from the auto-retry must ALSO
    // carry the archetype_hint forward (otherwise a SECOND restart
    // would lose it).
    const rows = db
      .raw()
      .query<{ request_id: string; archetype_hint: string | null }, []>(
        `SELECT request_id, archetype_hint FROM profile_pic_pending
            ORDER BY started_at ASC`,
      )
      .all()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.request_id).toBe(request_id)
    expect(rows[0]?.archetype_hint).toBe(ARCHETYPE)
    expect(rows[1]?.archetype_hint).toBe(ARCHETYPE)
  })

  test('null archetype_hint stays null through the auto-retry path', async () => {
    // Row without an archetype_hint should NOT manufacture one — the
    // fix is "preserve what was stored", not "always pass something".
    const sixMinAgo = 1_000_000_000
    const bootTime = sixMinAgo + 6 * 60_000

    const seedStore = new ProfilePicPendingStore({ db, now: () => sixMinAgo })
    await seedStore.recordPending({
      project_slug: 't-arch-null',
      user_id: 'u-arch-null',
      prompt: 'no archetype recorded',
      // archetype_hint omitted intentionally.
    })

    const captured: Array<{ archetype_hint?: string }> = []
    const home = join(tmp, 'home')
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: home,
      gemini: buildClient(async () => ({
        candidates: [dummyCandidate('cand', 0xa0)],
        dollars_billed: 0,
      })),
      now: () => bootTime,
    })
    const realStart = pipeline.start.bind(pipeline)
    pipeline.start = async (input) => {
      const c: { archetype_hint?: string } = {}
      if (input.archetype_hint !== undefined) c.archetype_hint = input.archetype_hint
      captured.push(c)
      return realStart(input)
    }

    const store = pipeline.pendingCallStore()!
    const result = await resumeProfilePicOnBoot({
      store,
      pipeline,
      now: () => bootTime,
      fresh_window_ms: 60_000,
      hard_fail_window_ms: 7 * 60_000,
    })
    for (const jid of result.auto_retry_job_ids) await pipeline.awaitJob(jid)

    expect(captured).toHaveLength(1)
    expect(captured[0]?.archetype_hint).toBeUndefined()
  })
})

describe('fresh-window behavior', () => {
  test('pending row younger than 60 s is kept untouched', async () => {
    const now = 1_000_000_000
    const justNow = now - 10_000 // 10 s ago

    const seedStore = new ProfilePicPendingStore({ db, now: () => justNow })
    const { request_id } = await seedStore.recordPending({
      project_slug: 't-fresh',
      user_id: 'u-fresh',
      prompt: 'still running upstream',
    })

    const observerStore = new ProfilePicPendingStore({ db, now: () => now })
    const result = await resumeProfilePicOnBoot({
      store: observerStore,
      now: () => now,
    })

    expect(result.kept_pending).toBe(1)
    expect(result.expired).toBe(0)
    expect(result.failed).toBe(0)

    const row = await observerStore.get(request_id)
    expect(row!.status).toBe('pending')
    expect(row!.auto_retry_attempted).toBe(false)
  })

  test('default windows match the brief (60 s fresh, 5 min hard fail)', () => {
    expect(DEFAULT_PENDING_FRESH_WINDOW_MS).toBe(60_000)
    expect(DEFAULT_PENDING_HARD_FAIL_WINDOW_MS).toBe(5 * 60_000)
  })
})

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function buildEngineHookOver(
  pipeline: ProfilePicPipeline,
  store: ProfilePicPendingStore,
  opts: { wait_for_candidates?: boolean } = {},
): ProfilePicEngineHook {
  return buildProfilePicEngineHook({
    pipeline,
    internal_handle: null,
    owner_home: '/tmp/dummy',
    getBotToken: () => null,
    imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
    buildPromptForCandidates: () => 'test prompt',
    pendingStore: store,
    setBotAvatar: async () => ({ ok: true }),
    ...(opts.wait_for_candidates === true ? { wait_for_candidates: true } : {}),
  })
}
