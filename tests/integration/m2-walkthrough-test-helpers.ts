/**
 * Shared test helpers for the M2 walkthrough integration suite.
 *
 * Extracted in P2-v3 S4 (2026-05-18) per
 * `docs/plans/P2-v3-S4-fixture-harness-semantic-equivalence.md` § 10.2.
 * Both the engine-router-integration unit-integration tests and the new
 * v3 fixture / tangent-coverage tests boot a real `InterviewEngine` with
 * an `InMemoryOnboardingStateStore` + a stub `LlmRouter` + a stub
 * `PlatformAdapter` that flips `getOnboardingConversational` on. The
 * helpers in this module are the smallest reusable surface; per-test
 * behavioural setup (beforeEach state, custom send-prompt logging, etc.)
 * stays in the test files.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type {
  LlmRouter,
  RouterDecision,
  RouterInput,
} from '@neutronai/onboarding/interview/llm-router.ts'
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'
import type { PlatformInstanceInfo } from '@neutronai/runtime/platform-adapter.ts'

// ISSUES #223 — the Open subset of this harness (`stubRouter`,
// `stubPlatform`, `RouterCall`, `DEFAULT_HELPER_OWNER_INFO`) was
// relocated into the kept Open tree so the Sprint-C carve ships it. This
// Managed harness imports them for its own `bootEngineAtPhase` use and
// re-exports them so the `tests/integration/` suites that import from
// here keep their surface unchanged.
import {
  DEFAULT_HELPER_OWNER_INFO,
  stubPlatform,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

export {
  DEFAULT_HELPER_OWNER_INFO,
  stubPlatform,
  stubRouter,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'
export type { RouterCall } from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

// ---------------------------------------------------------------------------
// bootEngineAtPhase — self-contained harness used by the new v3 tests.
// Returns a `BoothedEngine` with the engine + stores + sent-prompt log +
// a `cleanup()` function the test should call to drop the temp dir.
//
// The existing engine-router-integration.test.ts file owns its own
// beforeEach setup with module-level state; it imports `stubRouter` +
// `stubPlatform` from this module but does NOT use `bootEngineAtPhase`.
// New v3 tests get the self-contained shape so each test owns its
// state without module-level beforeEach choreography.
// ---------------------------------------------------------------------------

export interface SentPromptRecord {
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}

export interface BoothedEngine {
  engine: InterviewEngine
  stateStore: InMemoryOnboardingStateStore
  transcript: TranscriptWriter
  buttonStore: ButtonStore
  sentPrompts: SentPromptRecord[]
  /** The project_slug used to seed state + drive advances. */
  project_slug: string
  /** The topic_id used to seed state + drive advances. */
  topic_id: string
  /** The user_id used to seed state + drive advances. */
  user_id: string
  /** The `active_prompt_id` the engine emitted after the phase was
   *  reached. Tests assert that follow-up router-driven re-emits land on
   *  the same `prompt_id`. */
  active_prompt_id: string
  /** Drop the temp dir + close the DB. Always idempotent. */
  cleanup(): void
}

export interface BootEngineAtPhaseOptions {
  llmRouter?: LlmRouter
  /** When `'all'` (default), every phase routes through the router.
   *  When an array, only those phases route. Set to `'none'` to disable
   *  conversational mode entirely. */
  conversational?: 'all' | 'none' | ReadonlyArray<OnboardingPhase>
  /** Extra phase_state to seed alongside the standard topic / user / signup_via. */
  phase_state_patch?: Record<string, unknown>
  /** Instance info to use for the synthesised PlatformAdapter. Defaults
   *  to a minimal instance pointing at /tmp/x. */
  owner_info?: PlatformInstanceInfo
  project_slug?: string
  topic_id?: string
  user_id?: string
}

const NOW_MS = Date.now()

/** Boot a fresh `InterviewEngine` instance seeded at `phase`, with the
 *  conversational flag flipped on for the given phases. Returns the
 *  full harness — the caller must invoke `harness.cleanup()` to drop
 *  the temp directory the SQLite db lives in. */
export async function bootEngineAtPhase(
  phase: OnboardingPhase,
  opts: BootEngineAtPhaseOptions = {},
): Promise<BoothedEngine> {
  const project_slug = opts.project_slug ?? 't1'
  const topic_id = opts.topic_id ?? 'topic-1'
  const user_id = opts.user_id ?? 'u-1'
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-v3-helper-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: SentPromptRecord[] = []

  const platform =
    opts.conversational === 'none'
      ? undefined
      : stubPlatform(
          opts.conversational ?? 'all',
          opts.owner_info ?? {
            ...DEFAULT_HELPER_OWNER_INFO,
            url_slug: project_slug,
          },
        )

  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  }
  if (opts.llmRouter !== undefined) deps.llmRouter = opts.llmRouter
  if (platform !== undefined) deps.platform = platform
  const engine = new InterviewEngine(deps)

  await stateStore.upsert({
    project_slug,
    user_id,
    phase,
    phase_state_patch: {
      topic_id,
      user_id,
      signup_via: 'web',
      ...(opts.phase_state_patch ?? {}),
    },
    advanced_at: NOW_MS,
  })
  await engine.advance({
    project_slug,
    topic_id,
    user_id,
    channel_kind: 'app-socket',
    observed_at: NOW_MS,
  })
  const seeded = await stateStore.get(project_slug, user_id)
  const ap = (seeded?.phase_state as Record<string, unknown> | undefined)?.[
    'active_prompt_id'
  ]
  const active_prompt_id =
    typeof ap === 'string' && ap.length > 0 ? ap : ''
  // Drop the emit-side prompts so the caller's assertions only see
  // router-driven sends (mirrors the existing
  // `engine-router-integration.test.ts:startAndReachPhase` semantics).
  sentPrompts.length = 0

  return {
    engine,
    stateStore,
    transcript,
    buttonStore,
    sentPrompts,
    project_slug,
    topic_id,
    user_id,
    active_prompt_id,
    cleanup() {
      try {
        db.close()
      } catch {
        // best-effort
      }
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

/** Resolve the engine state for `project_slug` from the harness's store
 *  and return the phase + a shallow Record-typed phase_state. */
export async function stateAfter(
  harness: BoothedEngine,
): Promise<{ phase: OnboardingPhase; phase_state: Record<string, unknown> }> {
  const s = await harness.stateStore.get(harness.project_slug, harness.user_id)
  if (s === null) {
    throw new Error(`stateAfter: no state for project_slug=${harness.project_slug}`)
  }
  return {
    phase: s.phase,
    phase_state: s.phase_state as Record<string, unknown>,
  }
}

/** Return the most recent agent bubble body (last `sendButtonPrompt`
 *  invocation's `prompt.body`). Empty string when none has been sent. */
export function lastAgentBubble(harness: BoothedEngine): string {
  const last = harness.sentPrompts[harness.sentPrompts.length - 1]
  return last?.prompt.body ?? ''
}

// ---------------------------------------------------------------------------
// buildFixtureFedRouter — wraps a `V3Fixture` into a `LlmRouter` that
// yields each reply's `router_stub_response` in walk order. Used by the
// v3 conversational-fixture in-process test (boots the real engine
// against an InMemoryOnboardingStateStore and a fixture-driven router).
// ---------------------------------------------------------------------------

import type { V3Fixture, RouterDecisionFixture } from '../fixtures/m2/v3-fixture.ts'

/** Pre-build the queue of router decisions from a v3 fixture's `replies`,
 *  in walk order. Replies whose `router_stub_response` is absent contribute
 *  no entry to the queue (so a button-tap reply with no router stub does
 *  not block when the engine never consults the router for that turn).
 *
 *  Throws on underflow — a queue underflow at runtime means the fixture
 *  declared fewer router stubs than the engine asked for, which is a
 *  fixture bug we want to surface loudly.
 */
export function buildFixtureFedRouter(fixture: V3Fixture): LlmRouter {
  const queue: RouterDecisionFixture[] = []
  for (const phase of fixture.phases) {
    for (const reply of phase.replies) {
      if (reply.router_stub_response !== undefined) {
        queue.push(reply.router_stub_response)
      }
    }
  }
  return {
    async route(input: RouterInput): Promise<RouterDecision> {
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(
          `buildFixtureFedRouter: queue empty (phase=${input.phase}, user_text=${JSON.stringify(input.user_text).slice(0, 80)})`,
        )
      }
      return {
        action: next.action,
        confidence: next.confidence ?? 1.0,
        choice_value: next.choice_value ?? null,
        freeform_text: next.freeform_text ?? null,
        response: next.response ?? null,
        state_delta:
          (next.state_delta as RouterDecision['state_delta']) ?? null,
        reasoning: 'fixture-stub',
      }
    },
  }
}
