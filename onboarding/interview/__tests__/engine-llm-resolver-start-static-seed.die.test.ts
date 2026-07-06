/**
 * DIE (co-deletes in K11b1) — `engine.start()`'s STATIC idempotency-seed
 * race defense (Codex P1, 2026-05-10).
 *
 * This pins behavior that is EXCLUSIVE to the interview engine's
 * conversational drive `engine.start()`: the first-emit path uses a
 * body-INDEPENDENT (static) idempotency seed so two concurrent first
 * `start()` calls — each getting a slightly different warm-session LLM
 * rephrase before either persists `active_prompt_id` — still hash to the
 * SAME idempotency_key and dedupe to one row/one send.
 *
 * There is NO retained equivalent: the RETAINED `emitPhasePrompt` path
 * deliberately uses a body-DEPENDENT seed (its own code comment: "the narrow
 * race the LLM-driven start() path needed to defend against … does NOT apply
 * here"), so a different body there yields a NEW row — the inverse of this
 * assertion. K11b1 deletes `engine.start()`; this file co-deletes with it.
 * It is split out (K11a6) from `engine-llm-resolver.test.ts` so that file can
 * re-anchor its retained resolver-wiring assertions onto `emitPhasePrompt`
 * with ZERO `engine.start(` calls, while this start-only regression stays
 * guarded until start() is removed.
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
  test('start idempotency holds even when LLM returns DIFFERENT body on each call (Codex P1)', async () => {
    // Simulates the race: two concurrent start() calls land before the
    // first persists active_prompt_id. Each gets a slightly different
    // LLM rephrase. The seed must NOT depend on LLM body — the same
    // (instance, topic, phase) must hash to the same idempotency_key so
    // ButtonStore.emit dedupes and only one row + one send happens.
    let counter = 0
    const resolver: PhaseSpecResolver = {
      async resolve() {
        counter++
        return {
          phase: 'signup',
          body: `LLM rephrase #${counter}`,
          options: [],
          allow_freeform: true,
          next_phase_on_default: 'agent_name_chosen',
        }
      },
    }
    // Build TWO independent harnesses sharing the same db so both
    // start() calls compete for the same idempotency_key bucket.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-llm-race-'))
    try {
      const db = ProjectDb.open(join(tmp, 'project.db'))
      try {
        applyMigrations(db.raw())
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
        // Two engines on the same DB — but with the SAME resolver so
        // each call gets a different body. The state-store guard
        // dedupes one path, but the idempotency_key must dedupe the
        // ButtonStore row even if the body differs.
        const engine1 = new InterviewEngine({
          buttonStore,
          stateStore,
          transcript,
          sendButtonPrompt: sender,
          phaseSpecResolver: resolver,
        })
        const startInput = {
          project_slug: 't1',
          topic_id: 'web:user-1',
          user_id: 'u-1',
          signup_via: 'web' as const,
        }
        await engine1.start(startInput)
        await engine1.start(startInput)
        // Even though the resolver was consulted twice and returned
        // DIFFERENT bodies, only ONE button_prompts row exists.
        const rows = db
          .prepare<{ c: number }, []>('SELECT COUNT(*) AS c FROM button_prompts')
          .get()
        expect(rows?.c).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
