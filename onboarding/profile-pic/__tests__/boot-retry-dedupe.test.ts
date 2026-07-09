/**
 * ISSUE #43 — profile-pic boot-retry has no in-flight dedupe.
 *
 * Codex P2 carry-over from PR #299 r2. Scenario:
 *
 *   1. Gateway crashes mid-Gemini-call. `profile_pic_pending` row left
 *      at status='pending'.
 *   2. Gateway boots. `resumeProfilePicOnBoot` fires an auto-retry —
 *      `pipeline.start(...)` writes a NEW `status='pending'` row while
 *      its Gemini call runs in the background (~15-30 s).
 *   3. User enters the profile-pic phase ≤30 s after boot. The engine
 *      hook calls `pendingStore.latestForUser(...)`, gets the fresh
 *      pending row.
 *
 * Pre-fix behavior: hook fell through to `pipeline.start(...)`, which
 * has no in-flight dedupe — a second Gemini call fires, double-billing
 * + racing the first on candidate-row writes.
 *
 * Post-fix behavior (this test asserts):
 *   - Fresh pending (started_at within the 60 s freshness window) →
 *     hook returns `kind: 'pending'` and does NOT call pipeline.start.
 *   - Stale pending (started_at past the freshness window) → hook
 *     falls through to pipeline.start (presumed-dead path; brief calls
 *     out that pipeline-layer dedupe is out of scope).
 *
 * The fix is in `onboarding/profile-pic/storage.ts`
 * `buildProfilePicEngineHook` — see the ISSUE #43 branch in
 * `ensureCandidates`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  GeminiImagenClient,
  type GeminiImageCandidate,
  type GeminiImagenFn,
} from '../gemini-imagegen.ts'
import { ProfilePicPipeline } from '../pipeline.ts'
import { ProfilePicPendingStore } from '../pending-call-store.ts'
import { DEFAULT_PENDING_FRESH_WINDOW_MS } from '../restart-resume.ts'
import { buildProfilePicEngineHook } from '../storage.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pp-boot-retry-dedupe-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

describe('ISSUE #43 — fresh-pending dedupe in engine-hook', () => {
  test('fresh pending row (30 s old) → hook returns kind=pending and does NOT fire pipeline.start', async () => {
    const fixedNow = 2_000_000_000
    const thirtySecondsAgo = fixedNow - 30_000

    // Seed a 'pending' row simulating the boot-resume auto-retry. The
    // boot hook fired pipeline.start ~30 s ago; the Gemini call is
    // still in flight upstream.
    const seedStore = new ProfilePicPendingStore({ db, now: () => thirtySecondsAgo })
    await seedStore.recordPending({
      project_slug: 't-43-fresh',
      user_id: 'u-43-fresh',
      prompt: 'in-flight gemini call',
      archetype_hint: 'krishna',
    })

    // Spy on pipeline.start so we can assert it isn't called.
    let geminiCalls = 0
    const geminiFn: GeminiImagenFn = async () => {
      geminiCalls += 1
      return {
        candidates: [dummyCandidate(`dup-${geminiCalls}`, 0xa1)],
        dollars_billed: 0.02,
      }
    }
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: new GeminiImagenClient({ generate: geminiFn }),
    })
    let pipelineStartCalls = 0
    const realStart = pipeline.start.bind(pipeline)
    pipeline.start = async (input) => {
      pipelineStartCalls += 1
      return realStart(input)
    }

    const store = pipeline.pendingCallStore()!
    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: join(tmp, 'home'),
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'fresh-pending test prompt',
      pendingStore: store,
      now: () => fixedNow,
    })

    const outcome = await hook.ensureCandidates({
      project_slug: 't-43-fresh',
      topic_id: 'topic-43-fresh',
      user_id: 'u-43-fresh',
      agent_name: 'Nova',
      archetype_hint: 'krishna',
    })

    expect(outcome.kind).toBe('pending')
    expect(pipelineStartCalls).toBe(0)
    expect(geminiCalls).toBe(0)

    // The store row stayed 'pending' — the hook did NOT mark it
    // completed/failed/expired (it doesn't own those transitions).
    const after = await store.latestForUser('t-43-fresh', 'u-43-fresh')
    expect(after).not.toBeNull()
    expect(after!.status).toBe('pending')
  })

  test('stale pending row (90 s old, past fresh window) → hook DOES fire a fresh pipeline.start', async () => {
    const fixedNow = 2_000_000_000
    const ninetySecondsAgo = fixedNow - 90_000

    // Seed a stale 'pending' row. The original call is presumed dead
    // (>60 s without completion). The boot hook would have transitioned
    // this row to 'expired' on the next gateway restart, but no boot
    // scan has run here — so the row is still 'pending' yet aged out
    // of the freshness window.
    const seedStore = new ProfilePicPendingStore({ db, now: () => ninetySecondsAgo })
    await seedStore.recordPending({
      project_slug: 't-43-stale',
      user_id: 'u-43-stale',
      prompt: 'presumed-dead call',
      archetype_hint: 'odin',
    })

    let geminiCalls = 0
    const geminiFn: GeminiImagenFn = async () => {
      geminiCalls += 1
      return {
        candidates: [dummyCandidate(`stale-${geminiCalls}`, 0xb2)],
        dollars_billed: 0.02,
      }
    }
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: new GeminiImagenClient({ generate: geminiFn }),
    })
    let pipelineStartCalls = 0
    const realStart = pipeline.start.bind(pipeline)
    pipeline.start = async (input) => {
      pipelineStartCalls += 1
      return realStart(input)
    }

    const store = pipeline.pendingCallStore()!
    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: join(tmp, 'home'),
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'stale-pending test prompt',
      pendingStore: store,
      now: () => fixedNow,
      wait_for_candidates: true,
    })

    const outcome = await hook.ensureCandidates({
      project_slug: 't-43-stale',
      topic_id: 'topic-43-stale',
      user_id: 'u-43-stale',
      agent_name: 'Nova',
      archetype_hint: 'odin',
    })

    expect(pipelineStartCalls).toBe(1)
    expect(geminiCalls).toBe(1)
    expect(outcome.kind).toBe('ready')
  })

  test('default fresh window matches the boot-resume constant (60 s)', () => {
    expect(DEFAULT_PENDING_FRESH_WINDOW_MS).toBe(60_000)
  })

  test('fresh-pending hook outcome carries empty job_id (Wait poll re-enters pendingStore path)', async () => {
    // The boot-resume auto-retry fired in a different process, so this
    // gateway has no live `pipeline.awaitJob` handle to attach. The
    // empty job_id is intentional: the engine's `prior_job_id.length
    // > 0` check at the top of ensureCandidates skips the prior-job
    // branch on the Wait poll, which re-consults pendingStore.
    const fixedNow = 2_000_000_000
    const seedStore = new ProfilePicPendingStore({ db, now: () => fixedNow - 5_000 })
    await seedStore.recordPending({
      project_slug: 't-43-jid',
      user_id: 'u-43-jid',
      prompt: 'fresh',
    })

    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: new GeminiImagenClient({
        generate: async () => ({
          candidates: [dummyCandidate('x', 0xc0)],
          dollars_billed: 0,
        }),
      }),
    })
    const store = pipeline.pendingCallStore()!
    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: join(tmp, 'home'),
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'p',
      pendingStore: store,
      now: () => fixedNow,
    })

    const outcome = await hook.ensureCandidates({
      project_slug: 't-43-jid',
      topic_id: 'topic-43-jid',
      user_id: 'u-43-jid',
      agent_name: null,
      archetype_hint: null,
    })

    expect(outcome.kind).toBe('pending')
    if (outcome.kind === 'pending') {
      expect(outcome.job_id).toBe('')
    }
  })

  test('fresh_window_ms override shortens the dedupe window for tests', async () => {
    // Tunable seam: a test that wants to assert "1 s window expires
    // immediately" can shorten the window to ~0 so the same row that
    // would be 'fresh' under the 60 s default falls through.
    const fixedNow = 2_000_000_000
    const seedStore = new ProfilePicPendingStore({ db, now: () => fixedNow - 5_000 })
    await seedStore.recordPending({
      project_slug: 't-43-tunable',
      user_id: 'u-43-tunable',
      prompt: 'short window',
    })

    let pipelineStartCalls = 0
    const pipeline = new ProfilePicPipeline({
      db,
      owner_home: join(tmp, 'home'),
      gemini: new GeminiImagenClient({
        generate: async () => ({
          candidates: [dummyCandidate('y', 0xd0)],
          dollars_billed: 0,
        }),
      }),
    })
    const realStart = pipeline.start.bind(pipeline)
    pipeline.start = async (i) => {
      pipelineStartCalls += 1
      return realStart(i)
    }
    const store = pipeline.pendingCallStore()!
    const hook = buildProfilePicEngineHook({
      pipeline,
      internal_handle: null,
      owner_home: join(tmp, 'home'),
      getBotToken: () => null,
      imageUrlBuilder: ({ candidate_id }) => `/profile-pic/candidate/${candidate_id}.png`,
      buildPromptForCandidates: () => 'p',
      pendingStore: store,
      now: () => fixedNow,
      fresh_window_ms: 1_000, // 1 s window — row is 5 s old, falls through
      wait_for_candidates: true,
    })

    const outcome = await hook.ensureCandidates({
      project_slug: 't-43-tunable',
      topic_id: 'topic-43-tunable',
      user_id: 'u-43-tunable',
      agent_name: null,
      archetype_hint: null,
    })

    expect(outcome.kind).toBe('ready')
    expect(pipelineStartCalls).toBe(1)
  })
})
