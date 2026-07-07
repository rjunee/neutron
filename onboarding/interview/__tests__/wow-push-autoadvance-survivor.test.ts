/**
 * K11b1 survivor (Codex BLOCKER A re-anchor) — wowPushEmitter
 * durability / idempotency contract, re-anchored onto the RETAINED
 * auto-advance seam.
 *
 * The original coverage lived in the deleted
 * `gateway/__tests__/wow-fired-push-integration.test.ts`, which drove
 * the engine via `engine.advance` + button choices (the conversational
 * drive K11b1 excised). The contract itself is still LIVE: the
 * retained `emitCurrentPhasePrompt` (§ 7.2 RETAIN — the LLM-less /
 * failure prompt-render path, engine.ts:575) auto-skips
 * `max_oauth_offered` when the Max credential is already attached
 * (`maybeAutoAdvancePastMaxOauthOffered`, engine-agent-name.ts:499) →
 * `advanceFromMaxOauthOffered` (engine.ts:5027) → `dispatchWowAndAdvance`
 * (engine.ts:1359), which is where the push-emitter contract lives.
 *
 * Ported assertions (spec § B.P5, verbatim from the deleted suite):
 *   1. Reaching wow_fired fires the push emitter EXACTLY ONCE.
 *   2. The emitter receives the (project_slug, user_id, topic_id)
 *      triple with topic_id forwarded RAW/verbatim (Argus r1 BLOCKER,
 *      2026-05-22 round 2 — the engine must never pre-strip
 *      `app-project:`; the web chat-bridge shape `web:<user_id>`
 *      carries no project_id at all).
 *   3. `wow_pushed_at` is stamped on the row BEFORE the emitter is
 *      awaited (Codex r1 P2 — mark-before-attempt durability).
 *   4. Crash-resume re-entry does NOT re-fire the push (the
 *      `wow_pushed_at === null` gate) even though the dispatcher runs
 *      again.
 *   5. An emitter that THROWS does not roll back the completion
 *      (best-effort) and the stamp survives.
 *   6. No emitter wired → back-compat: dispatcher runs, row completes,
 *      `wow_pushed_at` stays null.
 *
 * NO deleted drive methods are used: state is seeded directly at
 * `max_oauth_offered` (mirroring the deleted suite's seed) and the
 * engine is entered ONLY through the retained public
 * `emitCurrentPhasePrompt`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  InterviewEngine,
  type MaxOauthSecretsStore,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
  type WowPushEmitter,
  type WowPushEmitterInput,
} from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'

const OWNER = 'casey'
const USER = 'u-1'
const PROJECT_ID = 'demo'
const TOPIC = `app-project:${PROJECT_ID}`
const T0 = 1_700_000_000_000

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let savedEnvToken: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-push-survivor-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  // The auto-advance detection falls back to CLAUDE_CODE_OAUTH_TOKEN when
  // the secrets store misses. Clear it so every test's attach-detection is
  // driven EXCLUSIVELY by the injected fake secrets store (deterministic
  // on dev boxes where the env token is set).
  savedEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
})

afterEach(() => {
  if (savedEnvToken !== undefined) {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedEnvToken
  } else {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  }
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Fake secrets store that reports the Max refresh credential as attached. */
function makeAttachedSecrets(): {
  store: MaxOauthSecretsStore
  listCalls: Array<{ internal_handle: string; kind?: string }>
} {
  const listCalls: Array<{ internal_handle: string; kind?: string }> = []
  const store: MaxOauthSecretsStore = {
    put: async () => ({ id: 's-put' }),
    list: async (input) => {
      listCalls.push({
        internal_handle: input.internal_handle,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      })
      if (input.kind === 'max_oauth_refresh') {
        return [{ id: 's-1', label: 'max', kind: 'max_oauth_refresh' }]
      }
      return []
    },
  }
  return { store, listCalls }
}

/** Fake secrets store with NO Max credential (auto-advance must not fire). */
function makeDetachedSecrets(): MaxOauthSecretsStore {
  return {
    put: async () => ({ id: 's-put' }),
    list: async () => [],
  }
}

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
  wowPushEmitter?: WowPushEmitter | undefined
  secrets?: MaxOauthSecretsStore | undefined
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
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
  })
  return { engine, sent }
}

/**
 * Seed the row at `max_oauth_offered` (same seed shape as the deleted
 * suite) and enter the engine through the RETAINED
 * `emitCurrentPhasePrompt` seam. With the Max credential attached the
 * engine auto-advances max_oauth_offered → wow_fired → completed in
 * this single call.
 */
async function seedAndAutoAdvance(
  engine: InterviewEngine,
  opts: { user_id?: string; topic_id?: string } = {},
) {
  const user_id = opts.user_id ?? USER
  const topic_id = opts.topic_id ?? TOPIC
  await stateStore.upsert({
    user_id,
    project_slug: OWNER,
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id, topic_id },
  })
  return await engine.emitCurrentPhasePrompt({
    project_slug: OWNER,
    user_id,
    topic_id,
    observed_at: T0,
  })
}

describe('wow-push emitter via retained auto-advance seam (K11b1 survivor)', () => {
  test('auto-advance fires wowPushEmitter exactly once and forwards (project, user, topic_id) verbatim', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: secrets.store,
    })
    const result = await seedAndAutoAdvance(engine)
    // The seam walked max_oauth_offered → wow_fired → completed inside
    // emitCurrentPhasePrompt, so the call reports the terminal noop.
    expect(result.outcome).toBe('noop_terminal')
    // Attach-detection went through the injected secrets store.
    expect(secrets.listCalls.length).toBeGreaterThan(0)
    expect(secrets.listCalls[0]).toEqual({
      internal_handle: OWNER,
      kind: 'max_oauth_refresh',
    })
    // Dispatcher fired (sanity: the engine actually reached wow_fired)
    // AND the push emitter fired exactly once.
    expect(disp.calls).toHaveLength(1)
    expect(push.calls).toHaveLength(1)
    // Argus r1 BLOCKER fix (2026-05-22 round 2): the engine forwards
    // topic_id verbatim; the production emitter resolves project_id.
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

  // Argus r1 BLOCKER (2026-05-22 round 2) — regression pin, ported from
  // the deleted suite. The production web path drives the engine with
  // `topic_id = 'web:<user_id>'`. A prior implementation stripped
  // `app-project:` off the topic_id INSIDE the engine — a no-op for the
  // web shape — surfacing `project_id = 'web:u-XXX'` into the push
  // payload (tap deep-linked to a nonexistent route). The engine must
  // forward the RAW topic_id, never a derived project_id.
  test('REGRESSION: web:<user_id> topic — engine forwards raw topic_id, never the bare user_id', async () => {
    const WEB_USER = 'u-web-1'
    const WEB_TOPIC = `web:${WEB_USER}`
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine, { user_id: WEB_USER, topic_id: WEB_TOPIC })
    expect(push.calls).toHaveLength(1)
    expect(push.calls[0]).toEqual({
      project_slug: OWNER,
      user_id: WEB_USER,
      topic_id: WEB_TOPIC,
    })
    // Engine still advances to completed.
    const finalState = await stateStore.get(OWNER, WEB_USER)
    expect(finalState!.phase).toBe('completed')
  })

  test('engine advances to completed with wow_fired=true after a successful push', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(finalState!.wow_fired).toBe(true)
  })

  test('crash-resume re-entry does NOT re-fire the push (1-shot idempotency via the wow_pushed_at gate)', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine)
    expect(push.calls).toHaveLength(1)

    // Simulate a crash mid-flight after the push landed: rewind the row
    // to the pre-advance phase with the wow bookkeeping cleared BUT
    // `wow_pushed_at` preserved (upsert leaves it untouched when the
    // field is omitted) — the invariant under test is that the first
    // push attempt is durable across the restart.
    await stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        active_prompt_id: null,
        wow_report: null,
        wow_dispatch_error: null,
      },
      advanced_at: T0 + 2_000,
    })
    const rewound = await stateStore.get(OWNER, USER)
    expect(rewound!.phase).toBe('max_oauth_offered')
    expect(typeof rewound!.wow_pushed_at).toBe('number')

    // Second pass through the SAME retained seam — post-restart the
    // prompt-render path re-runs the auto-advance, which re-enters
    // dispatchWowAndAdvance. The dispatcher must fire AGAIN (recover
    // the wow actions) but the push emitter MUST NOT (wow_pushed_at
    // gate).
    const second = await engine.emitCurrentPhasePrompt({
      project_slug: OWNER,
      user_id: USER,
      topic_id: TOPIC,
      observed_at: T0 + 3_000,
    })
    expect(second.outcome).toBe('noop_terminal')
    expect(disp.calls).toHaveLength(2)
    expect(push.calls).toHaveLength(1)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
  })

  test('emitter throws → completion is NOT rolled back (best-effort) and the stamp survives', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const push = makePushRecorder({ throws: new Error('Expo 503') })
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine)
    // Emitter was called once + threw; dispatcher still fired; row
    // advanced to completed; wow_pushed_at still stamped (so a future
    // crash-resume doesn't re-attempt the doomed push).
    expect(push.calls).toHaveLength(1)
    expect(disp.calls).toHaveLength(1)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(typeof finalState!.wow_pushed_at).toBe('number')
  })

  // Codex r1 P2 — mark-BEFORE-attempt durability, ported verbatim. The
  // engine must stamp `wow_pushed_at` BEFORE awaiting the emitter so a
  // gateway crash AFTER Expo accepts the push but BEFORE a post-hoc
  // stamp commit can't re-fire on resume. We verify by inspecting the
  // persisted row from inside the emitter's await.
  test('wow_pushed_at is stamped BEFORE the emitter is awaited (crash-after-push durability)', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    let observedWowPushedAt: number | null = null
    const emitter: WowPushEmitter = async (input) => {
      const row = await stateStore.get(input.project_slug, input.user_id)
      observedWowPushedAt = row?.wow_pushed_at ?? null
    }
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: emitter,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine)
    // At the moment the emitter ran, wow_pushed_at MUST already be
    // stamped on the persisted row.
    expect(observedWowPushedAt).not.toBeNull()
    expect(typeof observedWowPushedAt).toBe('number')
  })

  test('engine works without wowPushEmitter wired (back-compat): completes, wow_pushed_at stays null', async () => {
    const secrets = makeAttachedSecrets()
    const disp = makeDispatchRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      secrets: secrets.store,
    })
    await seedAndAutoAdvance(engine)
    expect(disp.calls).toHaveLength(1)
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('completed')
    expect(finalState!.wow_pushed_at).toBeNull()
  })

  // Seam guard — when the Max credential is NOT attached the retained
  // path must NOT auto-advance (and therefore must not push): the
  // engine re-emits the max_oauth_offered prompt and stays put. This
  // pins that the survivor coverage above is exercising a REAL gate,
  // not an unconditional advance.
  test('gate: Max NOT attached → no auto-advance, no push, phase stays max_oauth_offered', async () => {
    const disp = makeDispatchRecorder()
    const push = makePushRecorder()
    const { engine } = buildEngine({
      wowDispatcher: disp.hook,
      wowPushEmitter: push.emitter,
      secrets: makeDetachedSecrets(),
    })
    const result = await seedAndAutoAdvance(engine)
    expect(disp.calls).toHaveLength(0)
    expect(push.calls).toHaveLength(0)
    expect(result.outcome).not.toBe('noop_terminal')
    const finalState = await stateStore.get(OWNER, USER)
    expect(finalState!.phase).toBe('max_oauth_offered')
    expect(finalState!.wow_pushed_at).toBeNull()
  })
})
