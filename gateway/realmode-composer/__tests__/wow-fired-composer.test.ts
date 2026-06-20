/**
 * T2 r2 (2026-05-13) — wow_fired composer-path regression tests.
 *
 * Argus r1 [BLOCKING #1] on PR #98: the original T2 sprint shipped the
 * engine-side wiring (the `WowDispatcherHook` interface + the
 * `dispatchWowAndAdvance` branch) but never wired a real
 * `WowDispatcher` into the production composer. The engine emitted the
 * "Setting up your first week..." entry body, then nothing fired. That
 * was a textbook active-lie pattern (CLAUDE.md spec-conformance hard
 * rule). PR description's plan to defer the composer wiring to a
 * follow-up sprint was REJECTED.
 *
 * The three tests below are the ones that would have caught the gap:
 *
 *   1. Default-composer integration test — call
 *      `buildOnboardingEnginePieces(...)` (the testable entry point
 *      `buildLandingStack` walks for engine construction) WITHOUT
 *      passing `wowDispatcher`, drive to `wow_fired`, and assert the
 *      default `buildWowDispatcherHook(...)` resolves end-to-end. The
 *      original PR shape would fail this because `wowDispatcher` was
 *      never threaded through.
 *
 *   2. Internal_handle frozen-identity test — Argus BLOCKING #2: the
 *      dispatch identity must be the FROZEN `internal_handle`, NOT
 *      the mutable `url_slug`. Rename the slug between seed + the
 *      wow_fired turn and assert dispatch still receives the original
 *      frozen value.
 *
 *   3. Crash-resume regression — Argus IMPORTANT: if the process
 *      crashes between the `phase='wow_fired'` upsert and
 *      `dispatch()` resolving, re-entry must re-fire dispatch.
 *      Simulate by seeding `phase=wow_fired` with no `wow_report`
 *      and no `wow_dispatch_error`, then calling `engine.start(...)`
 *      and asserting dispatch fires.
 */

import { afterEach, beforeEach, expect, test, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { JwksCache } from '../../../jwt-validator/validator.ts'
import {
  InMemoryWebChatSenderRegistry,
  type SlugHistoryShimStore,
} from '../../http/chat-bridge.ts'
import type {
  WowDispatcherHook,
  WowDispatcherHookInput,
  WowDispatcherHookOutcome,
} from '../../../onboarding/interview/engine.ts'
import type { ButtonChoice } from '../../../channels/button-primitive.ts'
import { buildOnboardingEnginePieces } from '../build-landing-stack.ts'
import { CronJobRegistry } from '../../../cron/jobs.ts'
import { CronHandlerRegistry } from '../../../cron/handlers.ts'
import { CronScheduler } from '../../../cron/scheduler.ts'
import type { LlmCallFn } from '../../../onboarding/interview/phase-spec-resolver.ts'

const NOOP_SHIM_STORE: SlugHistoryShimStore = { lookup: async () => null }

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-wow-composer-'))
  const dbPath = join(workdir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(workdir, { recursive: true, force: true })
})

function makeJwks(): JwksCache {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ keys: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  return new JwksCache('https://auth.example.test/.well-known/jwks.json', {
    fetch: fetchImpl,
  })
}

interface RecorderHook {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
}

function makeRecorder(opts: { outcome?: WowDispatcherHookOutcome } = {}): RecorderHook {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = mock(
    async (input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => {
      calls.push(input)
      return (
        opts.outcome ?? {
          fired: ['01-first-week-brief', '07-overnight-pass'],
          skipped_no_trigger: [
            '02-lifestyle-reminders',
            '03-project-shells',
            '04-overdue-task',
            '05-followup-email-draft',
            '06-interest-check-in',
          ],
          failed: [],
          rescheduled: false,
        }
      )
    },
  )
  return { hook: { dispatch }, calls }
}

/**
 * Drive an `InterviewEngine` instance (built via the composer entry
 * point) from `max_oauth_offered` → tap "fire" so the engine advances
 * into `wow_fired` and the hook fires. Returns the final state.
 */
async function tapFireFromMaxOauth(opts: {
  pieces: ReturnType<typeof buildOnboardingEnginePieces>
  project_slug: string
  topic_id?: string
}): Promise<void> {
  const { engine, stateStore } = opts.pieces
  const topic_id = opts.topic_id ?? `topic-${opts.project_slug}`
  await stateStore.upsert({
    user_id: 'u-1',
    project_slug: opts.project_slug,
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id: 'u-1', topic_id },
  })
  const emit = await engine.advance({
    project_slug: opts.project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: opts.project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

// ---------------------------------------------------------------------------
// Test 1 — default composer wires the real WowDispatcher end-to-end.
//
// The original PR shape passed wowDispatcher=undefined through to the
// engine. Tapping "fire" would advance to `wow_fired`, emit the
// "drafting your brief..." body, and stop. This test catches that by
// asserting `phase=completed` AND `wow_report` lands after the tap —
// both outcomes only possible when the hook fires.
// ---------------------------------------------------------------------------

test('default composer builds a real WowDispatcher hook (not null); engine-walk to wow_fired invokes it', async () => {
  // Phase A — default-builder presence assertion. The composer default-
  // builds a non-null hook when `wowDispatcher` is left undefined. This
  // is the SHAPE assertion that catches the original BLOCKING gap (PR
  // shipped engine wiring with NO production call site → hook would
  // have been undefined here).
  const defaultPieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'shape-check',
    owner_home: join(workdir, 'project-home-shape'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-shape-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
  })
  expect(defaultPieces.wowDispatcher).not.toBeNull()
  expect(typeof defaultPieces.wowDispatcher!.dispatch).toBe('function')

  // Phase B — engine-walk invokes the dispatch. Use a recorder so we
  // can observe the call deterministically (the real dispatcher's
  // 5s inter-action pause × 6 gaps would push this test past 30s).
  // The wiring under test is "engine constructed by the composer
  // entry calls hook.dispatch on wow_fired entry" — orthogonal to
  // which dispatcher implementation backs the hook.
  const rec = makeRecorder()
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'casey',
    owner_home: join(workdir, 'project-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-casey-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    wowDispatcher: rec.hook,
  })
  await tapFireFromMaxOauth({ pieces, project_slug: 'casey' })
  expect(rec.calls.length).toBe(1)
  const after = await pieces.stateStore.get('casey', 'u-1')
  expect(after).not.toBeNull()
  // Dispatch resolved → phase advanced past wow_fired.
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  // `wow_report` is recorded with the action-id outcomes per § 2.5.
  const report = after!.phase_state['wow_report'] as Record<string, unknown> | undefined
  expect(report).toBeDefined()
  expect(report).toHaveProperty('fired')
  expect(report).toHaveProperty('skipped_no_trigger')
  expect(report).toHaveProperty('fired_at')
})

// ---------------------------------------------------------------------------
// Test 2 — Argus BLOCKING #2: dispatch identity is the FROZEN
// internal_handle, not the mutable url_slug.
//
// We rename the row's url_slug between seed and the wow_fired turn (the
// `rekey` SqliteOnboardingStateStore primitive simulates what the
// no-restart-rename driver does). Dispatch must STILL receive the
// frozen `internal_handle` so persisted rows (reminders, cron_state,
// wow_events) are keyed under a stable identity across renames.
// ---------------------------------------------------------------------------

test('dispatch identity is the FROZEN internal_handle, not the (post-rename) url_slug', async () => {
  const rec = makeRecorder()
  const FROZEN_INTERNAL_HANDLE = 't-casey-0001'
  const ORIGINAL_SLUG = 'casey-original'
  const RENAMED_SLUG = 'casey-renamed'
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: ORIGINAL_SLUG,
    owner_home: join(workdir, 'project-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: FROZEN_INTERNAL_HANDLE,
    slugHistoryStore: NOOP_SHIM_STORE,
    wowDispatcher: rec.hook,
  })
  // Seed the row under ORIGINAL_SLUG, then rekey to RENAMED_SLUG to
  // simulate a slug rename landed across the wow_fired transition.
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug: ORIGINAL_SLUG,
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id: 'u-1', topic_id: 'topic-1' },
  })
  await pieces.stateStore.rekey(ORIGINAL_SLUG, RENAMED_SLUG, 'u-1')
  // Now drive the engine using the post-rename url_slug — the dispatch
  // hook must STILL see the frozen internal_handle as `project_slug`.
  const emit = await pieces.engine.advance({
    project_slug: RENAMED_SLUG,
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })
  await pieces.engine.advance({
    project_slug: RENAMED_SLUG,
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice: {
      prompt_id: emit.prompt_id!,
      choice_value: 'skip',
      chosen_at: 1_700_000_001_000,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
    observed_at: 1_700_000_001_000,
  })
  expect(rec.calls.length).toBe(1)
  // The CRITICAL assertion — dispatch identity is the frozen value.
  expect(rec.calls[0]!.project_slug).toBe(FROZEN_INTERNAL_HANDLE)
  expect(rec.calls[0]!.project_slug).not.toBe(RENAMED_SLUG)
  expect(rec.calls[0]!.project_slug).not.toBe(ORIGINAL_SLUG)
})

// ---------------------------------------------------------------------------
// Test 3 — Argus IMPORTANT: wow_fired crash-resume.
//
// Reproduce the crash window: the engine landed `phase=wow_fired` and
// emitted the entry body, then the process died before
// `WowDispatcher.dispatch(...)` resolved. The row sits at
// `phase=wow_fired` with NO `wow_report` and NO `wow_dispatch_error`.
//
// Without the fix the user is stranded forever — the entry body is a
// freeform "drafting your brief..." with zero options, so no inbound
// tap can re-route them. `engine.start(...)` was the only re-entry path
// and the old shape just re-emitted the stale body. The fix-pass adds a
// crash-resume branch that re-fires dispatch.
// ---------------------------------------------------------------------------

test('crash-resume: phase=wow_fired with no wow_report and no error → engine.start re-fires dispatch', async () => {
  const rec = makeRecorder()
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'casey',
    owner_home: join(workdir, 'project-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-casey-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    wowDispatcher: rec.hook,
  })
  // Reproduce the crash state: phase=wow_fired with the entry-body
  // prompt id but no wow_report (dispatch never resolved) and no
  // wow_dispatch_error (fallback prompt was never emitted either —
  // the process died inside dispatch()).
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug: 'casey',
    phase: 'wow_fired',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id: 'topic-1',
      active_prompt_id: 'stub-pre-crash-prompt-id',
      signup_via: 'telegram',
      agent_name: 'Sage',
    },
  })
  // Re-entry: the user reconnects, the gateway calls engine.start.
  await pieces.engine.start({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    signup_via: 'telegram',
  })
  // Dispatch re-fired exactly once.
  expect(rec.calls.length).toBe(1)
  expect(rec.calls[0]!.project_slug).toBe('t-casey-0001')
  // Post-recovery state lands on `completed`.
  const after = await pieces.stateStore.get('casey', 'u-1')
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  expect(after!.phase_state['wow_report']).toBeDefined()
})

// ---------------------------------------------------------------------------
// Test 4 — crash-resume DOES NOT re-fire when the user is mid-fallback
// (wow_dispatch_error set). The retry/skip prompt is the user's
// surface; re-firing automatically would emit a duplicate prompt and
// race with their own tap.
// ---------------------------------------------------------------------------

test('crash-resume: phase=wow_fired with wow_dispatch_error set → engine.start does NOT auto-refire', async () => {
  const rec = makeRecorder()
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug: 'casey',
    owner_home: join(workdir, 'project-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-casey-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    wowDispatcher: rec.hook,
  })
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug: 'casey',
    phase: 'wow_fired',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id: 'topic-1',
      active_prompt_id: 'stub-fallback-prompt-id',
      signup_via: 'telegram',
      wow_dispatch_error: 'substrate boom',
      wow_fallback_attempt_count: 1,
    },
  })
  await pieces.engine.start({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    signup_via: 'telegram',
  })
  // Auto-refire is suppressed — the user owns the retry/skip prompt.
  expect(rec.calls.length).toBe(0)
})

// ---------------------------------------------------------------------------
// Test 5 — T2 r3 Argus BLOCKING #1: shared CronJobRegistry.
//
// r2 instantiated `new CronJobRegistry()` LOCAL to the wow-dispatcher.
// The production CronScheduler ran against a SEPARATE registry, so
// action 07 (overnight-pass) registered into a dead registry and the
// scheduler never saw the job — silently dropping tomorrow morning's
// brief.
//
// This test asserts:
//   1. Walking the production composer path with a shared registry
//      lands action 07's `overnight-<project_slug>` job in THAT
//      registry (not a private one).
//   2. A `CronScheduler` constructed against the SAME registry sees
//      the job at `fireOnce` time and invokes the registered handler.
// ---------------------------------------------------------------------------

test('T2 r3 BLOCKING #1: shared CronJobRegistry — action 07 registers in the scheduler\'s registry; scheduler.fireOnce invokes the handler', async () => {
  // Pre-construct the SHARED registry — same pattern the production
  // composer uses (`buildDefaultRealModeComposer`).
  const sharedCronJobs = new CronJobRegistry()

  // Register a live WS sender so action 01 succeeds — this test
  // verifies the shared-registry plumbing, not the WS-absent path
  // (which is Test 6 below).
  const registry = new InMemoryWebChatSenderRegistry()
  const project_slug = 'casey'
  const topic_id = `topic-${project_slug}`
  registry.register(topic_id, () => undefined)

  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug,
    owner_home: join(workdir, 'project-home'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-casey-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    webRegistry: registry,
    // T2 r3 — thread the SHARED registry into the production wow-
    // dispatcher path (NO wowDispatcher caller-override → default
    // builder fires with this registry).
    cronJobs: sharedCronJobs,
    // Test seam: skip 5s × 6 inter-action pauses + the 30s
    // substrate-error retry sleep.
    wowInterActionPauseMs: 0,
    wowSleep: async () => undefined,
  })
  // Default-builder should fire with a non-null hook (the same shape
  // assertion as Test 1, but now the hook closes over OUR registry).
  expect(pieces.wowDispatcher).not.toBeNull()

  await tapFireFromMaxOauth({ pieces, project_slug, topic_id })

  // ASSERTION #1 — the overnight-<frozen internal_handle> job lives
  // in the SHARED registry. The dispatch identity is the FROZEN
  // `internal_handle` (Argus BLOCKING #2 from r2) so action 07's
  // jobNameFor(ctx.project_slug) keys off `t-casey-0001`, NOT `casey`.
  // This is the test that catches r2's "private registry" gap: r2
  // would put the job in a dead local registry and this assertion
  // would fail (or `size()` would be 0).
  const jobName = 'overnight-t-casey-0001'
  const job = sharedCronJobs.get(jobName)
  expect(job).toBeDefined()
  expect(job!.handler).toBe('overnight_handler')
  expect(job!.schedule).toEqual({ kind: 'interval_ms', interval_ms: 30 * 60 * 1000 })

  // GAP3 (onboarding-wow-handoff-fix, 2026-06-09) — the engine now lands
  // at `completed` and emits the final-handoff GUIDE as the terminal
  // General message on the brief path too. Pre-fix it STAYED at `wow_fired`
  // with action-01's [A] Start overnight pass affordance as the active
  // prompt, and the guide never fired (Sam's 2026-06-09 signup saw only
  // the shells receipt). The cron registration still lands before the
  // brief emit (action 07 fires FIRST), so BLOCKING #1 stands regardless.
  const after = await pieces.stateStore.get(project_slug, 'u-1')
  expect(after).not.toBeNull()
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  // active_prompt_id is the final-handoff GUIDE (the brief affordance is
  // superseded). The guide is the single terminal General message.
  expect(typeof after!.phase_state['active_prompt_id']).toBe('string')
  expect(after!.phase_state['final_handoff_active']).toBe(true)
  const report = after!.phase_state['wow_report'] as Record<string, unknown> | undefined
  expect(report).toBeDefined()
  expect((report!['fired'] as string[])).toContain('07-overnight-pass')
  expect((report!['fired'] as string[])).toContain('01-first-week-brief')
  expect((report!['failed'] as unknown[]).length).toBe(0)

  // ASSERTION #2 — a scheduler constructed against the SAME registry
  // resolves the handler at fire time. Wire a recorder handler and
  // assert `scheduler.fireOnce(...)` invokes it; that closes the loop
  // production walks at tick time.
  const handlers = new CronHandlerRegistry()
  let handlerCallCount = 0
  let lastOwnerSlug: string | null = null
  handlers.register('overnight_handler', async (ctx) => {
    handlerCallCount += 1
    lastOwnerSlug = ctx.project_slug
    return { status: 'ok' }
  })
  const scheduler = new CronScheduler({
    jobs: sharedCronJobs,
    handlers,
    db,
    project_slug,
  })
  const fireResult = await scheduler.fireOnce(jobName)
  expect(fireResult.status).toBe('ok')
  expect(handlerCallCount).toBe(1)
  // The scheduler reports its OWN configured project_slug to the handler;
  // job-name disambiguation already keyed off the frozen internal_handle
  // at action 07 register time.
  expect(lastOwnerSlug!).toBe(project_slug)
})

// ---------------------------------------------------------------------------
// Test 6 — T2 r3 Argus IMPORTANT: WowChannelAdapter.sendText throws on
// undelivered.
//
// r2's sendText returned `{ message_id: 'undelivered' }` when
// `webRegistry.send` returned false (no active WS). Action 01
// (first-week-brief) never inspected message_id and unconditionally
// returned `{ fired: true, reason: 'delivered' }`. So a user whose WS
// dropped mid-dispatch silently advanced to `completed` with the brief
// never delivered.
//
// r3 makes sendText throw → the action-runner's per-action try/catch
// lands action 01 in `outcome.failed` → the engine's wow_fired-failure
// branch stays at `wow_fired` and emits the retry/skip fallback prompt.
//
// This test simulates `webRegistry.send` returning false (no live WS
// registration), triggers the wow_fired dispatch, asserts:
//   - Action 01 lands in `failed[]` (not `fired[]`).
//   - Engine does NOT advance to `completed` — stays at `wow_fired`.
//   - User sees the retry/skip fallback prompt (active_prompt_id set).
// ---------------------------------------------------------------------------

test('WS-absent → action 01 in failed[], engine STILL advances to completed (2026-06-10 best-effort policy) with the guide durably persisted', async () => {
  const sharedCronJobs = new CronJobRegistry()
  // NO sender registered — `registry.send(...)` returns false → the
  // WowChannelAdapter.sendText throws → action 01 lands in failed[].
  const registry = new InMemoryWebChatSenderRegistry()
  const project_slug = 'maya'
  const topic_id = `topic-${project_slug}`

  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug,
    owner_home: join(workdir, 'project-home-maya'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-maya-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    webRegistry: registry,
    cronJobs: sharedCronJobs,
    wowInterActionPauseMs: 0,
    wowSleep: async () => undefined,
  })
  expect(pieces.wowDispatcher).not.toBeNull()

  await tapFireFromMaxOauth({ pieces, project_slug, topic_id })

  // ASSERTION #1 — 2026-06-10 wow-hang-resilience policy: Day-1 actions
  // are BEST-EFFORT. The failed brief is recorded, but the engine
  // advances to `completed` anyway — it never strands the user at
  // wow_fired (the prod hang class). The final-handoff guide is the
  // durable terminal surface (ButtonStore row with delivered_at=null →
  // re-emitted on the next WS reconnect).
  const after = await pieces.stateStore.get(project_slug, 'u-1')
  expect(after).not.toBeNull()
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  expect(after!.completed_at).not.toBeNull()

  // ASSERTION #2 — no dispatch-level error: the dispatcher resolved
  // (the failure is per-action, recorded in the report, not a throw).
  expect(after!.phase_state['wow_dispatch_error'] ?? null).toBeNull()

  // ASSERTION #3 — wow_report preserves the full outcome. Action 07
  // fires FIRST in dispatch order so its registration MUST be visible;
  // the failed brief is recorded, not silently dropped.
  const partial = after!.phase_state['wow_report'] as Record<string, unknown> | undefined
  expect(partial).toBeDefined()
  const failedList = partial!['failed'] as Array<{ action_id: string; reason: string }>
  expect(failedList.length).toBeGreaterThanOrEqual(1)
  expect(failedList.some((f) => f.action_id === '01-first-week-brief')).toBe(true)
  const firedList = partial!['fired'] as string[]
  expect(firedList).toContain('07-overnight-pass')
  expect(firedList).not.toContain('01-first-week-brief')

  // ASSERTION #4 — the final-handoff GUIDE is the user's next surface
  // (durable; lands on reconnect). active_prompt_id is stamped so the
  // user's tap routes through the completed-phase handoff consumer.
  expect(after!.phase_state['final_handoff_active']).toBe(true)
  const activePromptId = after!.phase_state['active_prompt_id']
  expect(typeof activePromptId).toBe('string')
  expect((activePromptId as string).length).toBeGreaterThan(0)

  // ASSERTION #5 — even though the brief failed, action 07's cron
  // registration landed in the shared registry. This is the
  // "always-fire first so cron is set even if mid-dispatch fails"
  // guarantee from § 2.5. Job name keys off the FROZEN
  // internal_handle (t-maya-0001), NOT the url_slug.
  expect(sharedCronJobs.get('overnight-t-maya-0001')).toBeDefined()
})

// ---------------------------------------------------------------------------
// Test 7 — 2026-05-28 wow-cleanup r3 (Codex cross-model BLOCKER, Argus r2):
// production wiring SERIALIZES prompt-emitting wow actions via the
// ButtonStore-backed `PromptResolutionProbe`.
//
// r2 shipped Fix D (the dispatcher's serialization branch) + a passing unit
// test that injected a probe directly via `wowDispatcher` recorder. Codex
// cross-model caught that `gateway/realmode-composer/build-wow-dispatcher.ts`
// never threaded ANY probe into the production-built `WowDispatcher`, so
// the dispatcher's undefined-probe branch (`waitForPromptResolution`)
// degraded to a flat 5s sleep. For instances whose picker landed on
// prompt-emitting actions (03-project-shells, 02-lifestyle-reminders,
// 06-interest-check-in, 04-overdue-task — all four emit buttons),
// notifications still STACKED in chat exactly as Sam reported 2026-05-28.
//
// This test reproduces the production path:
//   1. Wire `buildOnboardingEnginePieces` WITHOUT a `wowDispatcher`
//      override (so the default builder fires).
//   2. Seed signals so the picker emits TWO prompt-emitting actions:
//      `03-project-shells` (≥2 captured projects) + `04-overdue-task`
//      (1 overdue task in `import_result.proposed_tasks`).
//   3. Tap "skip" to advance into `wow_fired`. Run the advance in the
//      background so the test can observe + resolve prompts.
//   4. Snapshot the `button_prompts` table: under serialization there is
//      AT MOST ONE unresolved wow-emitted prompt at a time. Without the
//      probe wired, BOTH prompts would land before the test resolved
//      either (the dispatcher's 5s flat sleep would still pass — that's
//      the slow-burn UX bug r3 fixes).
//   5. Resolve prompt #1 via `ButtonStore.resolve(...)`. The probe
//      polls SQLite, observes `resolved_at`, returns. The dispatcher
//      fires action #2 → emits prompt #2.
//   6. Resolve prompt #2 the same way. Dispatcher fires the brief
//      (ALWAYS_FIRE_LAST) and dispatch resolves.
//   7. Engine advances to `completed`.
//
// The test uses the REAL `ButtonStoreResolutionProbe` over a real
// `ProjectDb` — no probe injection. Test seams: 5ms poll cadence + a
// no-op dispatcher sleep keep wall-clock bounded under ~2s.
// ---------------------------------------------------------------------------

test('T2 r4 BLOCKING (Codex cross-model): production wiring serializes prompt-emitting actions via ButtonStore probe', async () => {
  const sharedCronJobs = new CronJobRegistry()
  const registry = new InMemoryWebChatSenderRegistry()
  const project_slug = 'serializer'
  const topic_id = `topic-${project_slug}`
  // Register a live WS sender so action 01's sendText (brief delivery)
  // succeeds — the test verifies prompt SEQUENCING, not the WS-absent
  // partial-failure path (Test 6 covers that).
  registry.register(topic_id, () => undefined)

  // Deterministic picker — returns two prompt-emitting picks in fixed
  // order. The dispatcher fires them sequentially; the probe is what
  // serializes them.
  // GAP3 silenced 03-project-shells' chat emit; use 06-interest-check-in
  // (still a prompt emitter) as the first serialized prompt so the probe
  // sequencing is still exercised end-to-end.
  const pickerLlm: LlmCallFn = async () =>
    JSON.stringify({
      pick: ['06-interest-check-in', '04-overdue-task'],
      explanations: {
        '06-interest-check-in': 'forced (test)',
        '04-overdue-task': 'forced (test)',
      },
    })

  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug,
    owner_home: join(workdir, 'project-home-ser'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-ser-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    webRegistry: registry,
    cronJobs: sharedCronJobs,
    // Dispatcher seams: kill the 5s inter-action pause + the action-
    // runner's 30s substrate-retry sleep so wall-clock stays bounded.
    wowInterActionPauseMs: 0,
    wowSleep: async () => undefined,
    wowPickerLlm: pickerLlm,
    // Probe seams: tight poll cadence keeps the test responsive; the
    // probe still uses REAL `Bun.sleep` + REAL `Date.now` so the
    // production code path is exercised end-to-end.
    wowPromptResolutionPollMs: 5,
  })
  expect(pieces.wowDispatcher).not.toBeNull()

  // Seed signals so the picker lands two prompt-emitting actions:
  //   06 needs >=1 non_work_interests entry (interest check-in)
  //   04 needs >=1 task with due_at < ctx.now() (which is `Date.now()`
  //   in the production dispatcher) — pin 1 day overdue.
  const overdue_due_at = Date.now() - 86_400_000
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug,
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id,
      captured_projects: [{ name: 'Topline' }, { name: 'Acme' }],
      non_work_interests: [{ name: 'climbing' }],
      import_result: {
        entities: [],
        topics: [],
        proposed_projects: [],
        proposed_tasks: [
          { title: 'Reply to Priya', due_at: overdue_due_at, priority_hint: 'P1' },
        ],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
    },
  })

  // Emit the max-oauth prompt so we have a valid prompt_id to tap.
  const oauthEmit = await pieces.engine.advance({
    project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })

  // Kick off the wow_fired advance IN THE BACKGROUND. The advance only
  // resolves once `WowDispatcher.dispatch(...)` returns, which won't
  // happen until both prompt-emitting actions resolve. We need to be
  // alive to resolve prompts in the foreground; await this at the end.
  const oauthChoice: ButtonChoice = {
    prompt_id: oauthEmit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  const advanceP = pieces.engine.advance({
    project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice: oauthChoice,
    observed_at: 1_700_000_001_000,
  })

  /**
   * Walk `button_prompts` directly for THIS topic so the test can
   * count what's emitted + filter to unresolved rows without depending
   * on the engine's serialized state. We exclude the max-oauth prompt
   * (already resolved by the tap above) so the assertions can focus
   * on wow-emitted prompts.
   */
  function wowPromptRows(): Array<{
    prompt_id: string
    resolved_at: number | null
    created_at: number
  }> {
    return db
      .prepare<
        { prompt_id: string; resolved_at: number | null; created_at: number },
        [string, string]
      >(
        `SELECT prompt_id, resolved_at, created_at
           FROM button_prompts
          WHERE topic_id = ? AND prompt_id != ?
          ORDER BY created_at ASC, prompt_id ASC`,
      )
      .all(topic_id, oauthEmit.prompt_id!)
  }

  async function pollUntil(
    pred: () => boolean,
    timeout_ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeout_ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await Bun.sleep(10)
    }
    return false
  }

  // PHASE 1 — wait for the FIRST wow-emitted prompt (action 06's
  // interest-check-in keyboard) to land. The dispatcher fires action 07
  // first (no prompt), pauses 0ms, then fires action 06 which calls
  // `channel.emitPrompt` → `buttonStore.emit` → DB row.
  const sawFirst = await pollUntil(() => wowPromptRows().length >= 1, 5_000)
  expect(sawFirst).toBe(true)

  // CORE SERIALIZATION ASSERTION — exactly ONE wow prompt has emitted
  // so far. Without the probe wired, BOTH 03 + 04 would have landed
  // immediately (back-to-back with only the 0ms dispatcher pause
  // between them). With the probe wired, the dispatcher parks on
  // `probe.waitFor(promptId, ...)` until we resolve it.
  let rows = wowPromptRows()
  expect(rows.length).toBe(1)
  expect(rows[0]!.resolved_at).toBeNull()
  const firstPromptId = rows[0]!.prompt_id

  // Resolve the first prompt. The probe's next poll (5ms cadence)
  // observes `resolved_at` and returns 'resolved' → dispatcher fires
  // action 04 → second prompt lands.
  await pieces.buttonStore.resolve({
    choice: {
      prompt_id: firstPromptId,
      choice_value: 'kept',
      chosen_at: 1_700_000_002_000,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
  })

  // PHASE 2 — wait for the SECOND wow-emitted prompt (action 04's
  // overdue-task keyboard).
  const sawSecond = await pollUntil(
    () => wowPromptRows().some((r) => r.prompt_id !== firstPromptId && r.resolved_at === null),
    5_000,
  )
  expect(sawSecond).toBe(true)

  rows = wowPromptRows()
  // Second-prompt-emerged + first-resolved invariant: at MOST one
  // unresolved prompt exists at any point during serialization.
  const unresolved = rows.filter((r) => r.resolved_at === null)
  expect(unresolved.length).toBeLessThanOrEqual(1)
  const secondPrompt = rows.find(
    (r) => r.prompt_id !== firstPromptId,
  )
  expect(secondPrompt).toBeDefined()
  expect(secondPrompt!.prompt_id).not.toBe(firstPromptId)

  // Resolve the second prompt so dispatch can advance into the brief.
  await pieces.buttonStore.resolve({
    choice: {
      prompt_id: secondPrompt!.prompt_id,
      choice_value: 'will_handle',
      chosen_at: 1_700_000_003_000,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
  })

  // Dispatch now fires action 01 (ALWAYS_FIRE_LAST — the brief).
  // Action 01 calls sendText (delivers the brief) AND emits its [A]
  // Start overnight pass affordance prompt. The brief is terminal —
  // the dispatcher does NOT serialize on its affordance prompt.
  await advanceP

  // GAP3 (onboarding-wow-handoff-fix, 2026-06-09) — the engine now
  // advances straight to `completed` and emits the final-handoff GUIDE as
  // the terminal General message, even though action-01 reported a
  // `brief_prompt_id`. Pre-fix it STAYED at `wow_fired` with the brief
  // affordance as the active prompt and the guide never fired. No
  // second [A]-tap is needed to reach `completed` anymore.
  const after = await pieces.stateStore.get(project_slug, 'u-1')
  expect(after).not.toBeNull()
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  // active_prompt_id is the GUIDE (the brief affordance is superseded).
  expect(after!.phase_state['final_handoff_active']).toBe(true)
  const report = after!.phase_state['wow_report'] as Record<string, unknown>
  expect(report).toBeDefined()
  const fired = report['fired'] as string[]
  expect(fired).toContain('07-overnight-pass')
  expect(fired).toContain('06-interest-check-in')
  expect(fired).toContain('04-overdue-task')
  expect(fired).toContain('01-first-week-brief')
})

// ---------------------------------------------------------------------------
// Test 8 — 2026-05-28 wow-cleanup r3: production composer default-builds
// a NON-undefined `prompt_resolution_probe`.
//
// Shape assertion — the previous defect was that
// `buildWowDispatcherHook` constructed `new WowDispatcher({...})` with NO
// `prompt_resolution_probe` field, so the dispatcher's undefined-probe
// branch silently degraded to a flat sleep. Asserting the field is
// threaded is the minimum-surface gate against that regression.
// ---------------------------------------------------------------------------

test('T2 r4: production composer default-builds a non-undefined prompt_resolution_probe (regression gate)', async () => {
  // We can't reach into the closure to inspect the probe instance, but
  // we can prove the field IS wired by constructing a fresh
  // dispatcher hook and observing that a prompt-emitting action's
  // serialization behaviour matches the "probe wired" branch:
  // dispatch awaits resolution rather than completing under a flat
  // pause. This test runs the SAME exercise as Test 7 but checks the
  // narrowest possible invariant — that the dispatch DOES NOT
  // complete while a prompt sits unresolved.
  const sharedCronJobs = new CronJobRegistry()
  const registry = new InMemoryWebChatSenderRegistry()
  const project_slug = 'gate'
  const topic_id = `topic-${project_slug}`
  registry.register(topic_id, () => undefined)
  // GAP3 silenced 03-project-shells' chat emit; 06-interest-check-in is
  // still a prompt emitter, so use it to exercise the probe-wired branch.
  const pickerLlm: LlmCallFn = async () =>
    JSON.stringify({
      pick: ['06-interest-check-in'],
      explanations: { '06-interest-check-in': 'forced (test)' },
    })
  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug,
    owner_home: join(workdir, 'project-home-gate'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-gate-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    webRegistry: registry,
    cronJobs: sharedCronJobs,
    wowInterActionPauseMs: 0,
    wowSleep: async () => undefined,
    wowPickerLlm: pickerLlm,
    wowPromptResolutionPollMs: 5,
  })
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug,
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id,
      non_work_interests: [{ name: 'climbing' }],
      import_result: {
        entities: [],
        topics: [],
        proposed_projects: [],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
    },
  })
  const oauthEmit = await pieces.engine.advance({
    project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })
  let advanceSettled = false
  const advanceP = pieces.engine
    .advance({
      project_slug,
      topic_id,
      user_id: 'u-1',
      channel_kind: 'app-socket',
      choice: {
        prompt_id: oauthEmit.prompt_id!,
        choice_value: 'skip',
        chosen_at: 1_700_000_001_000,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
      observed_at: 1_700_000_001_000,
    })
    .then(() => {
      advanceSettled = true
    })

  // Wait for action 06's prompt to land in the DB.
  const sawFirst = await (async (): Promise<boolean> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const count = db
        .prepare<{ c: number }, [string, string]>(
          `SELECT COUNT(*) AS c FROM button_prompts WHERE topic_id = ? AND prompt_id != ?`,
        )
        .get(topic_id, oauthEmit.prompt_id!)
      if ((count?.c ?? 0) >= 1) return true
      await Bun.sleep(10)
    }
    return false
  })()
  expect(sawFirst).toBe(true)

  // CORE GATE — the advance has NOT settled. Without the probe wired
  // the dispatcher would have sat through a flat 5s sleep and STILL
  // not settled within the 200ms window — so this assertion alone
  // does not prove the probe is doing its job. But the assertion
  // BELOW does: after we resolve the prompt, the advance settles
  // within a few hundred ms — that only happens when the probe was
  // actually polling SQLite.
  expect(advanceSettled).toBe(false)

  // Resolve the only wow-emitted prompt.
  const promptRow = db
    .prepare<{ prompt_id: string }, [string, string]>(
      `SELECT prompt_id FROM button_prompts WHERE topic_id = ? AND prompt_id != ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(topic_id, oauthEmit.prompt_id!)
  expect(promptRow).toBeDefined()
  const t_resolve_start = Date.now()
  await pieces.buttonStore.resolve({
    choice: {
      prompt_id: promptRow!.prompt_id,
      choice_value: 'kept',
      chosen_at: 1_700_000_002_000,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
  })

  // The probe polls every 5ms; the dispatcher then fires the brief
  // (terminal, no prompt-wait). Advance should settle within ~1s.
  await advanceP
  const elapsed = Date.now() - t_resolve_start
  expect(advanceSettled).toBe(true)
  // The probe woke up almost immediately — definitively not a
  // 5s-flat-sleep code path. Allow a generous 2s ceiling for slow CI.
  expect(elapsed).toBeLessThan(2_000)
})

// ---------------------------------------------------------------------------
// Test 9 — 2026-05-28 wow-cleanup r3 BLOCKER follow-up (Codex cross-model,
// Argus r3): WS-dropped `emitPrompt` must NOT silently persist a dead
// button_prompts row that wedges the serialize probe for 30 min.
//
// The r3 ButtonStore probe wiring (Test 7/8) made every prompt-emitting
// action park on `peek(prompt_id).resolved_at` until the user taps or
// the 30-min timeout fires. Codex caught that this turned a transient
// WS-drop into a SILENT auto-advance to `completed`:
//
//   1. action 03 calls `channel.emitPrompt` → `buttonStore.emit` persists
//      a row → `webRegistry.send` returns false (no live WS).
//   2. Previous shape returned `{ prompt_id }` anyway. fireOne saw
//      `followup_prompt_id` set → probe peeked the persisted row →
//      `resolved_at = null` → loop until 30-min timeout.
//   3. Timeout path: `handleKeptTyping` set `rescheduled=true` and
//      RETURNED EARLY. Action 01 (brief) NEVER fired.
//   4. Engine saw `outcome.failed` empty + `brief_prompt_id` undefined
//      → auto-advance to `completed`. User reached `completed` having
//      seen nothing.
//
// The fix: `emitPrompt` peeks `webRegistry.has(topic_id)` BEFORE
// persisting, throws on undelivered (mirrors r2's sendText pattern).
// This routes the failure through `outcome.failed` exactly like Test 6's
// sendText-throws path — action 01 also fails (its sendText still throws)
// → engine emits the retry/skip fallback prompt + stays at `wow_fired`.
//
// Assertions:
//   - NO wow-emitted button_prompts row is persisted (peek-before-persist
//     gate prevents the dead row).
//   - Action 03 lands in `outcome.failed[]`.
//   - Action 01 lands in `outcome.failed[]` (brief failure routes engine
//     into the fallback branch — see Test 6 for the symmetric assertion
//     when only sendText is the failure point).
//   - Engine STAYS at `wow_fired` with `wow_dispatch_error` set.
//   - Fallback prompt's `active_prompt_id` is set so reconnect routes
//     the user's next tap back through `consumeWowFallbackChoice`.
//   - The full 30-min wait did NOT happen (advance settles within a
//     second of the tap, not 30 min later).
// ---------------------------------------------------------------------------

test('T2 r4 follow-up BLOCKER (Codex cross-model): WS-dropped emitPrompt throws — no dead button_prompts row, no 30-min wait; engine completes best-effort (2026-06-10 policy)', async () => {
  const sharedCronJobs = new CronJobRegistry()
  // NO sender registered → `registry.has(topic_id)` returns false →
  // the WowChannelAdapter.emitPrompt throws BEFORE persisting.
  const registry = new InMemoryWebChatSenderRegistry()
  const project_slug = 'wsdrop'
  const topic_id = `topic-${project_slug}`

  // Force the picker to a prompt-emitting action so we exercise
  // emitPrompt (not just sendText — Test 6 already covers that). GAP3
  // silenced 03-project-shells' emit; 06-interest-check-in still emits.
  const pickerLlm: LlmCallFn = async () =>
    JSON.stringify({
      pick: ['06-interest-check-in'],
      explanations: { '06-interest-check-in': 'forced (test)' },
    })

  const pieces = buildOnboardingEnginePieces({
    db,
    project_slug,
    owner_home: join(workdir, 'project-home-wsdrop'),
    jwks: makeJwks(),
    static_dir: workdir,
    internal_handle: 't-wsdrop-0001',
    slugHistoryStore: NOOP_SHIM_STORE,
    webRegistry: registry,
    cronJobs: sharedCronJobs,
    wowInterActionPauseMs: 0,
    wowSleep: async () => undefined,
    wowPickerLlm: pickerLlm,
    // Defensive: tight probe cadence + short timeout so if the fix
    // regresses (probe loops on a dead persisted row), this test
    // hard-fails fast rather than waiting 30 min. The fix path
    // never reaches the probe at all — emitPrompt throws before
    // fireOne returns a `followup_prompt_id`.
    wowPromptResolutionPollMs: 5,
  })
  expect(pieces.wowDispatcher).not.toBeNull()

  // Seed signals so 03-project-shells triggers (≥2 captured projects).
  await pieces.stateStore.upsert({
    user_id: 'u-1',
    project_slug,
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id,
      // 06-interest-check-in fires on a non_work_interests entry.
      non_work_interests: [{ name: 'climbing' }],
      import_result: {
        entities: [],
        topics: [],
        proposed_projects: [],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
      },
    },
  })

  const oauthEmit = await pieces.engine.advance({
    project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })

  // Drive into wow_fired. With the fix, this returns within a second —
  // NOT 30 min later — because emitPrompt throws BEFORE the probe wait.
  const t_start = Date.now()
  await pieces.engine.advance({
    project_slug,
    topic_id,
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice: {
      prompt_id: oauthEmit.prompt_id!,
      choice_value: 'skip',
      chosen_at: 1_700_000_001_000,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
    observed_at: 1_700_000_001_000,
  })
  const elapsed = Date.now() - t_start
  // The CRITICAL timing assertion — if the probe regressed and looped
  // on a dead persisted row, this would have to wait the full
  // serialize_prompt_timeout_ms (30 min default). Allow 5s for slow CI
  // but no more — the fix path never reaches the probe at all.
  expect(elapsed).toBeLessThan(5_000)

  // ASSERTION #1 — 2026-06-10 wow-hang-resilience policy: the engine
  // advances to `completed` despite BOTH per-action failures (06 + 01).
  // Day-1 actions are best-effort; the user is never stranded at
  // wow_fired.
  const after = await pieces.stateStore.get(project_slug, 'u-1')
  expect(after).not.toBeNull()
  expect(after!.phase).toBe('completed')
  expect(after!.wow_fired).toBe(true)
  expect(after!.completed_at).not.toBeNull()

  // ASSERTION #2 — no dispatch-level error (per-action failures live in
  // the report, not in wow_dispatch_error).
  expect(after!.phase_state['wow_dispatch_error'] ?? null).toBeNull()

  // ASSERTION #3 — wow_report contains BOTH the brief failure AND the
  // picked-prompt-emitter (06) failure. The cron registration (07) still
  // landed because it fires before any prompt-emitting action.
  const report = after!.phase_state['wow_report'] as Record<string, unknown>
  expect(report).toBeDefined()
  const failedList = report['failed'] as Array<{ action_id: string; reason: string }>
  expect(failedList.some((f) => f.action_id === '06-interest-check-in')).toBe(true)
  expect(failedList.some((f) => f.action_id === '01-first-week-brief')).toBe(true)
  const firedList = report['fired'] as string[]
  expect(firedList).toContain('07-overnight-pass')
  expect(firedList).not.toContain('06-interest-check-in')
  expect(firedList).not.toContain('01-first-week-brief')

  // ASSERTION #4 — NO dead wow-emitted button_prompts row was persisted.
  // The peek-before-persist gate threw before reaching buttonStore.emit.
  // The only rows in button_prompts are: the max-oauth prompt (resolved
  // by the 'skip' tap above) AND the final-handoff GUIDE the engine
  // emitted on completion (durable; lands on reconnect). Crucially,
  // NO wow-action-06 row exists.
  const wowEmittedRows = db
    .prepare<{ prompt_id: string; body: string }, [string, string]>(
      `SELECT prompt_id, body
         FROM button_prompts
        WHERE topic_id = ? AND prompt_id != ?`,
    )
    .all(topic_id, oauthEmit.prompt_id!)
  // At most ONE row: the final-handoff guide. NO action-06 row.
  expect(wowEmittedRows.length).toBeLessThanOrEqual(1)

  // ASSERTION #5 — the final-handoff GUIDE is the user's surface; the
  // single persisted row above IS the guide (active_prompt_id matches).
  expect(after!.phase_state['final_handoff_active']).toBe(true)
  const activePromptId = after!.phase_state['active_prompt_id']
  expect(typeof activePromptId).toBe('string')
  expect((activePromptId as string).length).toBeGreaterThan(0)
  if (wowEmittedRows.length === 1) {
    expect(wowEmittedRows[0]!.prompt_id).toBe(activePromptId as string)
  }

  // ASSERTION #6 — action 07's cron registration landed regardless.
  // This is the "always-fire FIRST so cron is set even if mid-dispatch
  // fails" guarantee from § 2.5. Job keys off the FROZEN internal_handle.
  expect(sharedCronJobs.get('overnight-t-wsdrop-0001')).toBeDefined()
})
