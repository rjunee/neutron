/**
 * @neutronai/gateway/wow-push-emitter — engine integration tests
 * (2026-05-22 push-deeplink-wow sprint).
 *
 * Drives the real InterviewEngine through the
 * `max_oauth_offered → wow_fired → completed` transition with both
 * the `wowDispatcher` (recorder) AND the `wowPushEmitter` (recorder)
 * wired so the spec § B.P5 contract is asserted end-to-end:
 *
 *   1. Reaching wow_fired fires the push emitter exactly once.
 *   2. The emitter receives the (project_slug, user_id, topic_id)
 *      triple — Argus r1 BLOCKER fix (round 2): the engine now
 *      forwards topic_id verbatim and the production emitter
 *      (`gateway/wow-push-emitter.ts`) resolves project_id itself
 *      via the canonical projects store. The previous behaviour
 *      stripped `app-project:` off the topic_id inside the engine,
 *      which broke for the chat-bridge production path
 *      (`topic_id = 'web:<user_id>'` → wrong project_id surfaced).
 *   3. `onboarding_state.wow_pushed_at` is set to the observed time
 *      on the row when the dispatcher resolves.
 *   4. Crash-resume of `wow_fired` (no wow_report yet → engine.start
 *      re-enters dispatchWowAndAdvance) does NOT re-fire the push.
 *   5. Engine still advances to `completed` after a successful
 *      dispatch.
 *
 * Mirrors the test seam established in
 * `onboarding/interview/__tests__/wow-fired.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ButtonStore } from '../../channels/button-store.ts'
import {
  InterviewEngine,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
  type WowPushEmitter,
  type WowPushEmitterInput,
} from '../../onboarding/interview/engine.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { TranscriptWriter } from '../../onboarding/interview/transcript.ts'
import type { ButtonChoice, ButtonPrompt } from '../../channels/button-primitive.ts'

const OWNER = 'casey'
const USER = 'u-1'
const PROJECT_ID = 'demo'
const TOPIC = `app-project:${PROJECT_ID}`

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-fired-push-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface DispatchRecorder {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
}

function makeDispatchRecorder(): DispatchRecorder {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = async (
    input: WowDispatcherHookInput,
  ): Promise<WowDispatcherHookOutcome> => {
    calls.push(input)
    return {
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
  }
  return { hook: { dispatch }, calls }
}

interface PushRecorder {
  emitter: WowPushEmitter
  calls: WowPushEmitterInput[]
}

function makePushRecorder(opts: { throws?: unknown } = {}): PushRecorder {
  const calls: WowPushEmitterInput[] = []
  const emitter: WowPushEmitter = async (input) => {
    calls.push(input)
    if (opts.throws !== undefined) throw opts.throws
  }
  return { emitter, calls }
}

interface SentPrompt {
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}

function buildEngine(opts: {
  wowDispatcher: WowDispatcherHook
  wowPushEmitter?: WowPushEmitter
}): { engine: InterviewEngine; sent: SentPrompt[] } {
  const sent: SentPrompt[] = []
  const sendButtonPrompt = async (input: SentPrompt) => {
    sent.push(input)
    return { message_id: `msg-${sent.length}`, was_new: true }
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
    wowDispatcher: opts.wowDispatcher,
    ...(opts.wowPushEmitter !== undefined
      ? { wowPushEmitter: opts.wowPushEmitter }
      : {}),
  })
  return { engine, sent }
}

async function driveToFire(engine: InterviewEngine): Promise<void> {
  // Seed the row at max_oauth_offered so the next advance emits the
  // "Fire it / skip" prompt that gates entry into wow_fired.
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id: USER, topic_id: TOPIC },
  })
  const emit = await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })
  expect(emit.prompt_id).toBeDefined()
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: USER,
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

describe('wow_fired push integration', () => {
  test('engine fires wowPushEmitter exactly once and forwards (project, user, topic_id) verbatim', async () => {
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
    })
    await driveToFire(engine)
    // The dispatcher must have fired (sanity check that the engine
    // actually reached wow_fired in our seed shape) AND the push
    // emitter must have fired exactly once.
    expect(disp.calls).toHaveLength(1)
    expect(push.calls).toHaveLength(1)
    // Argus r1 BLOCKER fix (round 2): the engine forwards topic_id
    // verbatim. The production emitter is responsible for the
    // project_id derivation (see wow-push-emitter.test.ts for the
    // resolution rules).
    expect(push.calls[0]).toEqual({
      project_slug: OWNER,
      user_id: USER,
      topic_id: TOPIC,
    })
    // wow_pushed_at must be stamped on the persisted row.
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState).not.toBeNull()
    expect(typeof finalState!.wow_pushed_at).toBe('number')
    expect(finalState!.wow_pushed_at).toBeGreaterThan(0)
  })

  // Argus r1 BLOCKER (2026-05-22 round 2) — regression. In production
  // the chat-bridge path (`gateway/http/chat-bridge.ts:822, 973`) drives
  // engine.start + engine.advance with `topic_id = webTopicId(user_id) =
  // 'web:<user_id>'`. The prior emitter implementation stripped
  // `app-project:` off the topic_id INSIDE the engine, which left the
  // string unchanged for the web shape, and surfaced `project_id =
  // 'web:u-XXX'` into the push payload. Tap deep-linked to a
  // nonexistent route. This test pins the engine's contract: it must
  // forward the RAW topic_id (NOT pre-strip), so the production
  // emitter can resolve project_id correctly via the projects-store.
  test('REGRESSION: chat-bridge path (web:<user_id>) — engine forwards raw topic_id, never the bare user_id', async () => {
    const WEB_USER = 'u-web-1'
    const WEB_TOPIC = `web:${WEB_USER}`
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
    })
    // Seed onboarding state under the web user with the WEB topic_id
    // — matches the production chat-bridge path verbatim.
    await stateStore.upsert({
      user_id: WEB_USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: { user_id: WEB_USER, topic_id: WEB_TOPIC },
    })
    const emit = await engine.advance({
      project_slug: OWNER,
      topic_id: WEB_TOPIC,
      user_id: WEB_USER,
      channel_kind: 'app-socket',
      observed_at: 1_700_000_000_000,
    })
    expect(emit.prompt_id).toBeDefined()
    const choice: ButtonChoice = {
      prompt_id: emit.prompt_id!,
      choice_value: 'skip',
      chosen_at: 1_700_000_001_000,
      speaker_user_id: WEB_USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: WEB_TOPIC,
      user_id: WEB_USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: 1_700_000_001_000,
    })
    expect(push.calls).toHaveLength(1)
    // Critical assertion: the emitter receives the RAW web:<user_id>
    // topic_id. The previous implementation passed `project_id:
    // 'web:u-web-1'` here (stripping `app-project:` off a non-matching
    // string is a no-op). Forwarding the topic_id verbatim lets the
    // production emitter delegate to the projects-store.
    expect(push.calls[0]).toEqual({
      project_slug: OWNER,
      user_id: WEB_USER,
      topic_id: WEB_TOPIC,
    })
    // Engine still advances to completed.
    const finalState = await stateStore.get(OWNER, WEB_USER)
    expect(finalState!.phase).toBe('completed')
  })

  test('engine still advances to completed after push fires successfully', async () => {
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
    })
    await driveToFire(engine)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(finalState!.wow_fired).toBe(true)
  })

  test('crash-resume of wow_fired does NOT re-fire the push (1-shot idempotency)', async () => {
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
    })
    await driveToFire(engine)
    expect(push.calls).toHaveLength(1)

    // Simulate a crash mid-dispatch: rewind the row to wow_fired with
    // NO wow_report (the existing crash-resume watermark) BUT keep
    // wow_pushed_at set (which is the invariant we're testing — the
    // first push attempt is durable across the crash).
    const before = await stateStore.get(OWNER, USER)
    await stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'wow_fired',
      phase_state_patch: {
        active_prompt_id: null,
        wow_report: null,
        wow_dispatch_error: null,
      },
      wow_pushed_at: before!.wow_pushed_at,
      advanced_at: 1_700_000_002_000,
    })
    // Re-enter via start() — this hits the wow_fired crash-resume
    // branch (no report, no error) which calls dispatchWowAndAdvance
    // again. The dispatcher must fire AGAIN (recover from the
    // crash) but the push emitter MUST NOT.
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })
    expect(disp.calls).toHaveLength(2)
    // The push emitter should NOT have been called a second time.
    expect(push.calls).toHaveLength(1)
  })

  test('emitter throws → engine still completes (failure is logged, dispatcher still runs)', async () => {
    const disp = makeDispatchRecorder()
    const push = makePushRecorder({ throws: new Error('Expo 503') })
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
    })
    await driveToFire(engine)
    // Emitter was called once + threw; dispatcher still fired; row
    // advanced to completed; wow_pushed_at still stamped (so a future
    // crash-resume doesn't re-attempt the doomed push).
    expect(push.calls).toHaveLength(1)
    expect(disp.calls).toHaveLength(1)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(typeof finalState!.wow_pushed_at).toBe('number')
  })

  // Codex r1 P2 — mark-BEFORE-attempt durability. The engine must
  // stamp `wow_pushed_at` BEFORE awaiting the emitter so a gateway
  // crash AFTER Expo accepts the push but BEFORE the stamp commit
  // can't re-fire on resume. We verify by inspecting the row from
  // inside the emitter's await — if the stamp landed first, the row
  // already carries `wow_pushed_at != null` at observation time.
  test('wow_pushed_at is stamped BEFORE the emitter is awaited (crash-after-push durability)', async () => {
    const disp = makeDispatchRecorder()
    let observedWowPushedAt: number | null = null
    const emitter: WowPushEmitter = async (input) => {
      const row = await stateStore.get(input.project_slug, input.user_id)
      observedWowPushedAt = row?.wow_pushed_at ?? null
    }
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: emitter,
    })
    await driveToFire(engine)
    // At the moment the emitter ran, wow_pushed_at MUST already be
    // stamped on the persisted row — otherwise a crash after the
    // emitter dispatched the push but before our commit would leave
    // the row at null and re-fire on resume.
    expect(observedWowPushedAt).not.toBeNull()
    expect(typeof observedWowPushedAt).toBe('number')
  })

  test('engine works without wowPushEmitter wired (back-compat with pre-sprint composer)', async () => {
    const disp = makeDispatchRecorder()
    const { engine } = buildEngine({ wowDispatcher: disp.hook })
    await driveToFire(engine)
    // No emitter wired → dispatcher still runs, engine still advances.
    expect(disp.calls).toHaveLength(1)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(finalState!.wow_pushed_at).toBeNull()
  })
})
