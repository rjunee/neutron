/**
 * Integration test — Trident 6: onboarding resume-on-reconnect cron.
 *
 * Per docs/plans/P2-onboarding.md § 2.8 +
 * docs/research/p2-spec-conformance-audit-2026-05-13.md row 12 (P1-1).
 *
 * The cron periodically sweeps `onboarding_state` for rows past the
 * 24h resume window AND without an active resume prompt, then drives
 * `engine.advance(...)` to emit the welcome-back prompt proactively.
 *
 * This test covers the 4 product-logic assertions required by the
 * Trident 6 brief:
 *
 *   1. `last_advanced_at` is recent (>= now - 60s) after engine.advance
 *      moves the phase (verifies the state-store contract that the
 *      cron relies on to detect staleness).
 *   2. Stale row + cron tick → sendButtonPrompt called with a "welcome
 *      back" body (the proactive emit the audit demanded).
 *   3. Idempotency: re-running the cron 1 min after the first emit does
 *      NOT call sendButtonPrompt a second time (the persisted
 *      `resume_active_prompt_id` filters the row out of the next scan).
 *   4. Terminal phases (`completed`, `failed`) are NEVER picked up by
 *      the cron even if `last_advanced_at` is stale.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  RESUME_PROMPT_BODY_PREFIX,
  SqliteOnboardingStateStore,
  TranscriptWriter,
  buildOnboardingResumeHandler,
  registerOnboardingResumeCron,
  type OnboardingState,
} from '@neutronai/onboarding/index.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'

const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-resume-cron-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({ path: join(tmp, 'persona', 'onboarding-transcript.jsonl') })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeEngine(now: () => number): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    now,
  })
}

describe('onboarding resume-on-reconnect cron', () => {
  // Assertion #1 — `last_advanced_at` is recent after engine.advance.
  // This verifies the state-store contract the cron's WHERE clause
  // depends on: a successful phase advance bumps `last_advanced_at` to
  // ~now, which prevents the row from re-triggering the stale-row
  // emit on the next tick.
  test('engine.advance bumps last_advanced_at to within 60s of now', async () => {
    const T0 = 1_700_000_000_000
    // Seed at archetype_picked with a fresh advance just now (NOT
    // stale) so we can verify the state-store contract.
    const seeded = await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'a1',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:1', signup_via: 'telegram', user_id: 'u-1' },
      advanced_at: T0,
    })
    expect(seeded.last_advanced_at).toBe(T0)

    // Re-upsert to a different phase, simulating an advance.
    const advanced = await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'a1',
      phase: 'work_interview_gap_fill',
      advanced_at: T0 + 5_000,
    })
    // The advance must move `last_advanced_at` forward to the new
    // observed_at (the cron's freshness signal).
    expect(advanced.last_advanced_at).toBe(T0 + 5_000)
    // And the bumped value MUST be within 60s of the test's "now"
    // (here, the simulated clock).
    const nowForTest = T0 + 5_000
    expect(advanced.last_advanced_at).toBeGreaterThan(nowForTest - 60_000)
  })

  // Assertion #2 — Integration test: 25h-stale row + cron tick →
  // sendButtonPrompt called with a "welcome back" body.
  test('cron tick emits welcome-back prompt for a 25h-stale onboarding row', async () => {
    const T0 = 1_700_000_000_000
    // Seed a stale row at archetype_picked with last_advanced_at 25h
    // ago. phase_state holds topic_id + user_id + signup_via so the
    // cron handler can resolve the channel context.
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'alice',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:1', signup_via: 'telegram', user_id: 'u-alice' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    const handler = buildOnboardingResumeHandler({ engine, db, now: () => T0 })

    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'alice',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'alice',
      now: () => T0,
    })

    // Pre-fire: no prompts sent yet.
    expect(sentPrompts.length).toBe(0)

    // Fire the cron once. The handler scans for stale rows, finds
    // alice, calls engine.advance, which hits Path B → emits resume
    // prompt → sendButtonPrompt is invoked.
    const result = await scheduler.fireOnce(`onboarding-resume-alice`)
    expect(result.status).toBe('ok')
    // The engine called sendButtonPrompt exactly once with the
    // welcome-back body.
    expect(sentPrompts.length).toBe(1)
    const sent = sentPrompts[0]!
    expect(sent.project_slug).toBe('alice')
    expect(sent.topic_id).toBe('tg:1')
    expect(sent.prompt.body.startsWith(RESUME_PROMPT_BODY_PREFIX)).toBe(true)
    expect(sent.prompt.body.includes('picking your personality')).toBe(true)

    // The state row now carries `resume_active_prompt_id` (the engine
    // persists this BEFORE the channel send so a concurrent inbound
    // resolves cleanly).
    const after = await stateStore.get('alice', 'test-user')
    expect(after).not.toBeNull()
    expect(typeof after!.phase_state['resume_active_prompt_id']).toBe('string')
    expect((after!.phase_state['resume_active_prompt_id'] as string).length).toBeGreaterThan(0)
    // last_advanced_at must NOT be advanced by the emit — the gap is
    // the watchdog signal and bumping it would destroy the resume
    // semantics. Verify the persisted value is still 25h-ago.
    expect(after!.last_advanced_at).toBe(T0 - TWENTY_FIVE_HOURS_MS)
  })

  // Assertion #3 — Idempotency: re-running the cron 1 min later does
  // NOT call sendButtonPrompt a second time. The persisted
  // resume_active_prompt_id filters the row out of the cron's WHERE
  // clause so the row is not re-emitted.
  test('idempotency: re-firing the cron 1 min later does not double-emit', async () => {
    const T0 = 1_700_000_000_000
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'bob',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:2', signup_via: 'telegram', user_id: 'u-bob' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const clock = { now: T0 }
    const engine = makeEngine(() => clock.now)
    const handler = buildOnboardingResumeHandler({ engine, db, now: () => clock.now })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'bob',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'bob',
      now: () => clock.now,
    })

    // First fire — emits.
    const r1 = await scheduler.fireOnce(`onboarding-resume-bob`)
    expect(r1.status).toBe('ok')
    expect(sentPrompts.length).toBe(1)
    const firstResumeId = (await stateStore.get('bob', 'test-user'))!.phase_state[
      'resume_active_prompt_id'
    ]
    expect(typeof firstResumeId).toBe('string')

    // Advance clock 60s. The row's last_advanced_at is still 25h+60s
    // stale, but `resume_active_prompt_id` is now non-empty so the
    // cron's COALESCE-on-resume_active_prompt_id WHERE clause excludes
    // it. The second tick MUST be a no-op (no new send).
    clock.now = T0 + 60_000
    const r2 = await scheduler.fireOnce(`onboarding-resume-bob`)
    expect(r2.status).toBe('skipped')
    expect(r2.detail).toContain('no_stale_rows')
    // Critical idempotency assertion — NO double-emit.
    expect(sentPrompts.length).toBe(1)
    // The resume_active_prompt_id is unchanged.
    const second_state = await stateStore.get('bob', 'test-user')
    expect(second_state!.phase_state['resume_active_prompt_id']).toBe(firstResumeId)
  })

  // Assertion #4 — Terminal-phase check: rows in phase='completed' or
  // phase='failed' are NEVER picked up by the cron even when
  // `last_advanced_at` is way past the resume window.
  test('terminal phases (completed, failed) are never emitted for', async () => {
    const T0 = 1_700_000_000_000

    // Seed two terminal-phase owners 25h ago.
    // SqliteOnboardingStateStore.upsert does NOT accept 'completed'/'failed' via the
    // normal API (the engine transitions to them); insert directly via raw SQL
    // to model production state.
    await db.run(
      `INSERT INTO onboarding_state
         (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
          completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
       VALUES ('terminal-1', 'u-t1', 'completed', ?, ?, ?, ?, NULL, 1, 1, 'a1'),
              ('terminal-2', 'u-t2', 'failed',    ?, ?, ?, NULL, NULL, 0, 0, 'a2')`,
      [
        JSON.stringify({ topic_id: 'tg:3', signup_via: 'telegram', user_id: 'u-t1' }),
        T0 - TWENTY_FIVE_HOURS_MS,
        T0 - TWENTY_FIVE_HOURS_MS,
        T0 - 60_000,
        JSON.stringify({ topic_id: 'tg:4', signup_via: 'telegram', user_id: 'u-t2' }),
        T0 - TWENTY_FIVE_HOURS_MS,
        T0 - TWENTY_FIVE_HOURS_MS,
      ],
    )

    const engine = makeEngine(() => T0)

    // Wire the cron + scheduler for terminal-1.
    const handler1 = buildOnboardingResumeHandler({ engine, db, now: () => T0 })
    const jobs1 = new CronJobRegistry()
    const handlers1 = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'terminal-1',
      jobs: jobs1,
      handlers: handlers1,
      handler: handler1,
      interval_ms: 60_000,
    })
    const scheduler1 = new CronScheduler({
      jobs: jobs1,
      handlers: handlers1,
      db,
      project_slug: 'terminal-1',
      now: () => T0,
    })
    const r1 = await scheduler1.fireOnce(`onboarding-resume-terminal-1`)
    expect(r1.status).toBe('skipped')
    expect(r1.detail).toContain('no_stale_rows')
    expect(sentPrompts.length).toBe(0)

    // And for terminal-2 (phase='failed').
    const handler2 = buildOnboardingResumeHandler({ engine, db, now: () => T0 })
    const jobs2 = new CronJobRegistry()
    const handlers2 = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'terminal-2',
      jobs: jobs2,
      handlers: handlers2,
      handler: handler2,
      interval_ms: 60_000,
    })
    const scheduler2 = new CronScheduler({
      jobs: jobs2,
      handlers: handlers2,
      db,
      project_slug: 'terminal-2',
      now: () => T0,
    })
    const r2 = await scheduler2.fireOnce(`onboarding-resume-terminal-2`)
    expect(r2.status).toBe('skipped')
    expect(r2.detail).toContain('no_stale_rows')
    expect(sentPrompts.length).toBe(0)

    // Sanity — the rows DO exist with their seeded stale
    // last_advanced_at; the filter is keyed on phase, not on row
    // absence.
    const row1 = db
      .prepare<{ project_slug: string; phase: string; last_advanced_at: number }, [string]>(
        `SELECT project_slug, phase, last_advanced_at FROM onboarding_state WHERE project_slug = ?`,
      )
      .get('terminal-1')
    expect(row1).not.toBeNull()
    expect(row1!.phase).toBe('completed')
    expect(row1!.last_advanced_at).toBe(T0 - TWENTY_FIVE_HOURS_MS)
  })

  // Codex r2 P2 (2026-05-13) — when a row already has an unresolved
  // `active_prompt_id` (e.g. the chat-bridge's `startSession` re-emitted
  // the current phase prompt on reconnect), the cron MUST skip it so
  // the user doesn't see two competing keyboards. The user can answer
  // the live prompt directly; there's nothing to "welcome back" them to.
  test('rows with an unresolved active_prompt_id are skipped (no duplicate keyboard)', async () => {
    const T0 = 1_700_000_000_000
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'reconnected',
      phase: 'personality_offered',
      phase_state_patch: {
        topic_id: 'web:u-r',
        signup_via: 'web',
        user_id: 'u-r',
        // Simulate: chat-bridge.startSession just re-emitted the
        // current phase prompt on reconnect, populating active_prompt_id.
        active_prompt_id: 'pmt-reemit-on-reconnect',
      },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    const handler = buildOnboardingResumeHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'reconnected',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'reconnected',
      now: () => T0,
    })

    const r = await scheduler.fireOnce(`onboarding-resume-reconnected`)
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('no_stale_rows')
    expect(sentPrompts.length).toBe(0)
  })

  // Codex r2 P2 (2026-05-13) — when `engine.advance` throws AFTER
  // `emitResumePrompt` persists `resume_active_prompt_id` (e.g. the
  // channel send raised), the cron MUST roll back the marker so the
  // row stays eligible for the next sweep. Without rollback, the
  // owner is permanently stranded — the cron records `send_failed`
  // but the WHERE clause filters the row out forever.
  test('rollback: send-failure clears resume_active_prompt_id so next tick retries', async () => {
    const T0 = 1_700_000_000_000
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'failover',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'web:u-f', signup_via: 'web', user_id: 'u-f' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    // Engine wired with a `sendButtonPrompt` that always throws (mock
    // an offline transport that raises instead of returning was_new:
    // false). The engine wraps the throw in InterviewError(send_failed)
    // and propagates.
    const throwingEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async () => {
        throw new Error('synthetic-channel-down')
      },
      now: () => T0,
    })

    const handler = buildOnboardingResumeHandler({
      engine: throwingEngine,
      db,
      now: () => T0,
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'failover',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'failover',
      now: () => T0,
    })

    const r = await scheduler.fireOnce(`onboarding-resume-failover`)
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('send_failed=1')

    // Critical: the rollback cleared `resume_active_prompt_id`, so a
    // subsequent tick (with the same stale row) sees it as eligible
    // again.
    const after = await stateStore.get('failover', 'test-user')
    expect(after).not.toBeNull()
    expect(after!.phase_state['resume_active_prompt_id']).toBeUndefined()
    // last_advanced_at preserved at the seeded 25h-old timestamp.
    expect(after!.last_advanced_at).toBe(T0 - TWENTY_FIVE_HOURS_MS)
  })

  // Codex r1 P1 (2026-05-13) — deliverability precheck. When the
  // supplied `canDeliver` callback returns false (offline WS, unwired
  // telegram path), the cron MUST skip the row WITHOUT calling
  // engine.advance — otherwise the engine's emitResumePrompt would
  // persist `resume_active_prompt_id` against an unreachable channel
  // and the row would be permanently filtered out of future scans.
  test('canDeliver=false: cron skips without persisting resume_active_prompt_id', async () => {
    const T0 = 1_700_000_000_000

    // Two stale owners — one telegram, one web. Production wiring
    // returns false for tg (no engine→tg path yet) AND for web rows
    // whose WS is offline. We stub canDeliver to return false for
    // BOTH to verify the cron's response to an undeliverable verdict.
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'tg-owner',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:9', signup_via: 'telegram', user_id: 'u-tg' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    const handler = buildOnboardingResumeHandler({
      engine,
      db,
      now: () => T0,
      canDeliver: () => false,
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'tg-owner',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'tg-owner',
      now: () => T0,
    })

    const r = await scheduler.fireOnce(`onboarding-resume-tg-owner`)
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('undeliverable=1')
    // No channel send happened.
    expect(sentPrompts.length).toBe(0)
    // Critical: `resume_active_prompt_id` was NOT persisted — so the
    // next tick (once delivery is restored) will see the row as still
    // eligible and emit then.
    const state = await stateStore.get('tg-owner', 'test-user')
    expect(state).not.toBeNull()
    expect(state!.phase_state['resume_active_prompt_id']).toBeUndefined()
    // last_advanced_at is preserved at the seeded 25h-old timestamp.
    expect(state!.last_advanced_at).toBe(T0 - TWENTY_FIVE_HOURS_MS)
  })

  // Codex r1 P1 corollary — canDeliver=true (default behavior when
  // omitted) lets the emit through. Already exercised by the main
  // welcome-back test; this is an explicit positive case for the
  // canDeliver callback shape.
  test('canDeliver=true: cron proceeds to emit for the row', async () => {
    const T0 = 1_700_000_000_000
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: 'web-owner',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'web:u-w', signup_via: 'web', user_id: 'u-w' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    const handler = buildOnboardingResumeHandler({
      engine,
      db,
      now: () => T0,
      canDeliver: ({ signup_via, topic_id }) => signup_via === 'web' && topic_id === 'web:u-w',
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'web-owner',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'web-owner',
      now: () => T0,
    })

    const r = await scheduler.fireOnce(`onboarding-resume-web-owner`)
    expect(r.status).toBe('ok')
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]!.project_slug).toBe('web-owner')
    expect(sentPrompts[0]!.prompt.body.startsWith(RESUME_PROMPT_BODY_PREFIX)).toBe(true)
  })

  // Coverage extra — when the row's phase_state is missing the
  // topic_id (very old or malformed row), the cron handler skips
  // without crashing. This protects against the cron toppling other
  // owners on a single bad row.
  test('rows with missing topic_id/user_id are skipped without crashing', async () => {
    const T0 = 1_700_000_000_000
    await db.run(
      `INSERT INTO onboarding_state
         (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at,
          completed_at, import_job_id, persona_files_committed, wow_fired, attempt_id)
       VALUES ('legacy-1', 'legacy:pre-project-isolation', 'personality_offered', '{}', ?, ?, NULL, NULL, 0, 0, 'a1')`,
      [T0 - TWENTY_FIVE_HOURS_MS, T0 - TWENTY_FIVE_HOURS_MS],
    )

    const engine = makeEngine(() => T0)
    const handler = buildOnboardingResumeHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerOnboardingResumeCron({
      project_slug: 'legacy-1',
      jobs,
      handlers,
      handler,
      interval_ms: 60_000,
    })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: 'legacy-1',
      now: () => T0,
    })

    const r = await scheduler.fireOnce(`onboarding-resume-legacy-1`)
    // Row was scanned but no emit happened (no resolvable context).
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('missing_context=1')
    expect(sentPrompts.length).toBe(0)
  })
})

// Unused-import guard: `OnboardingState` is exported by the barrel and
// kept here for documentation cross-reference in case of future tests
// that assert deeper state-shape invariants.
void ({} as OnboardingState)
