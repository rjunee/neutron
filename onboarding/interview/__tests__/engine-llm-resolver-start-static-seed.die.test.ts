/**
 * DIE (co-deletes in K11b1) — `engine.start()`'s STATIC idempotency-seed
 * race defense (Codex P1, 2026-05-10).
 *
 * This pins behavior that is EXCLUSIVE to the interview engine's
 * conversational drive `engine.start()`: the first-emit seed path
 * (`engine.ts` ~1289-1300) anchors the idempotency_key on the
 * body-INDEPENDENT static `SIGNUP_FALLBACK_SPEC.body`, so two CONCURRENT
 * first `start()` calls — each getting a slightly different warm-session LLM
 * rephrase before either persists `active_prompt_id` — still hash to the
 * SAME idempotency_key and collapse onto ONE ButtonStore row / one delivered
 * body.
 *
 * The race is genuine, not two sequential calls: two engines share ONE
 * ButtonStore + state store, and a barrier holds BOTH resolvers open until
 * BOTH `start()` calls have passed the active-prompt reuse guard
 * (`engine.ts` ~1215-1254 — apid still null) and are committed to the
 * seed/emit path. Only then do the resolvers return DIVERGENT bodies and both
 * reach `buttonStore.emit`. A sequential pair would NOT exercise this: the
 * first `start()` persists `active_prompt_id`, so the second short-circuits
 * through `reuseActivePrompt` and never reaches the seed path — the mutant
 * where the seed depends on `effective_body` would pass. This concurrent
 * harness kills that mutant: divergent bodies MUST still dedupe to one row.
 *
 * There is NO retained equivalent: the RETAINED `emitPhasePrompt` path
 * deliberately uses a body-DEPENDENT seed (its own code comment: "the narrow
 * race the LLM-driven start() path needed to defend against … does NOT apply
 * here"), so a different body there yields a NEW row — the inverse of this
 * invariant. K11b1 deletes `engine.start()`; this file co-deletes with it.
 * It is split out (K11a6) from `engine-llm-resolver.test.ts` so that file can
 * re-anchor its retained resolver-wiring assertions onto `emitPhasePrompt`
 * with ZERO `engine.start(` calls, while this start-only race stays guarded
 * until start() is removed.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { PhaseSpecResolver } from '../phase-spec-resolver.ts'

describe('InterviewEngine.start — static idempotency seed (DIE, start-only)', () => {
  test('two CONCURRENT first start() calls with DIFFERENT LLM bodies collapse onto one row (Codex P1 race)', async () => {
    const BODY_A = 'LLM rephrase A — whats your name?'
    const BODY_B = 'LLM rephrase B — hey, your name?'

    // Barrier: hold BOTH resolvers open until both start() calls have entered
    // resolve() — i.e. both passed the active-prompt reuse guard (apid null)
    // and are committed to the seed/emit path. Releasing only then guarantees
    // neither call has persisted active_prompt_id yet, so the SECOND is NOT
    // short-circuited by reuseActivePrompt — the true concurrent-first-emit
    // race the static seed defends.
    let entered = 0
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    function makeResolver(body: string): PhaseSpecResolver {
      return {
        async resolve() {
          entered += 1
          if (entered === 2) releaseBarrier()
          await barrier
          return {
            phase: 'signup',
            body,
            options: [],
            allow_freeform: true,
            next_phase_on_default: 'agent_name_chosen',
          }
        },
      }
    }

    const tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-llm-race-'))
    try {
      const db = ProjectDb.open(join(tmp, 'project.db'))
      try {
        applyMigrations(db.raw())
        // ONE ButtonStore + state store shared by both engines, so the two
        // concurrent emits compete for the same (topic_id, idempotency_key)
        // bucket — the UNIQUE index is what must dedupe them.
        const buttonStore = new ButtonStore({ db })
        const stateStore = new InMemoryOnboardingStateStore()
        const transcript = new TranscriptWriter({
          path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
        })
        const sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }> = []
        const sender = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
          sentPrompts.push(input)
          return { message_id: `msg-${sentPrompts.length}`, was_new: true }
        }
        const mkEngine = (body: string): InterviewEngine =>
          new InterviewEngine({
            buttonStore,
            stateStore,
            transcript,
            sendButtonPrompt: sender,
            phaseSpecResolver: makeResolver(body),
          })
        const engineA = mkEngine(BODY_A)
        const engineB = mkEngine(BODY_B)
        const startInput = {
          project_slug: 't1',
          topic_id: 'web:user-1',
          user_id: 'u-1',
          signup_via: 'web' as const,
        }

        // Drive both first-starts concurrently.
        await Promise.all([engineA.start(startInput), engineB.start(startInput)])

        // Both resolvers were entered → both start() calls passed the
        // active-prompt guard and reached the seed path concurrently (the real
        // race, not a sequential reuse short-circuit).
        expect(entered).toBe(2)

        // Even though the resolvers returned DIFFERENT bodies, the static seed
        // hashed both to the same idempotency_key → exactly ONE row.
        const rows = db
          .prepare<{ c: number }, []>('SELECT COUNT(*) AS c FROM button_prompts')
          .get()
        expect(rows?.c).toBe(1)

        // Exactly one delivered body survives, and it is a REAL divergent LLM
        // body (proving the seed/emit path was reached, not the static
        // fallback or a reuse). If the seed depended on `effective_body` the
        // two divergent bodies would have produced TWO rows/bodies.
        const bodies = new Set(sentPrompts.map((p) => p.prompt.body))
        expect(bodies.size).toBe(1)
        const survivor = [...bodies][0]!
        expect([BODY_A, BODY_B]).toContain(survivor)
      } finally {
        db.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
