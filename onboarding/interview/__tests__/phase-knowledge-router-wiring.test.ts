/**
 * Unit tests — `PHASE_KNOWLEDGE` × router system-prompt wiring.
 *
 * Split out of `phase-knowledge.test.ts` (K11a2 — refactor unit) because
 * this block is the one part of that suite that exercises `llm-router.ts`
 * internals directly (`buildSystemPrompt`) rather than just the
 * `PhaseKnowledgePack` content/validation contract owned by
 * `phase-spec-resolver.ts`.
 *
 * dies with K11b1 (router internals) — when `llm-router.ts` is deleted
 * (K11b1, per docs/plans/2026-07-05-k11-execution-plan.md), this whole
 * file dies with it. Isolated here so that deletion is a clean one-file
 * removal instead of a surgical edit inside `phase-knowledge.test.ts`.
 *
 * Asserts:
 *   - the router system prompt embeds each pack's why_we_ask + at least
 *     one expected_tangent.user_text_example (proves the pack is wired
 *     into the router prompt, not just present in the map)
 */

import { describe, expect, test } from 'bun:test'
import { getKnowledgeForPhase, PHASE_KNOWLEDGE } from '../phase-spec-resolver.ts'
import type { PhaseKnowledgePack } from '../phase-spec-resolver.ts'
import type { OnboardingPhase } from '../phase.ts'
import { buildSystemPrompt } from '../llm-router.ts'

const S2_PHASES: ReadonlyArray<OnboardingPhase> = [
  'signup',
  'ai_substrate_offered',
  'import_upload_pending',
  'personality_offered',
]

const S3_PHASES: ReadonlyArray<OnboardingPhase> = [
  'import_analysis_presented',
  'work_interview_gap_fill',
  'agent_name_chosen',
  'slug_chosen',
  'projects_proposed',
  'persona_reviewed',
  'max_oauth_offered',
]

const POPULATED_PHASES: ReadonlyArray<OnboardingPhase> = [
  ...S2_PHASES,
  ...S3_PHASES,
]

const FOREVER_NULL_PHASES: ReadonlyArray<OnboardingPhase> = [
  'identity_oauth',
  'instance_provisioned',
  'import_running',
  'persona_synthesizing',
  'wow_fired',
  'completed',
  'failed',
]

describe('PHASE_KNOWLEDGE × router prompt wiring (design § 6 S3 coverage report)', () => {
  // Build a minimal RouterInput shape just rich enough to exercise the
  // system-prompt builder. The router's `buildSystemPrompt` is exported
  // from llm-router.ts; it consumes the knowledge pack and emits a
  // string that the LLM sees verbatim. If the wiring drops a pack on
  // the floor (e.g. the engine forgot to thread it through), the
  // assertion below catches it.
  function fakeRouterInput(
    phase: OnboardingPhase,
    pack: PhaseKnowledgePack,
  ): Parameters<typeof buildSystemPrompt>[0] {
    return {
      phase,
      active_prompt: {
        body: 'placeholder prompt body',
        options: [],
        allow_freeform: true,
        pick_only: false,
      },
      user_text: 'placeholder',
      knowledge: pack,
      captured: {},
      recent_turns: [],
    }
  }

  test('every populated pack is referenced by the router system prompt', () => {
    for (const phase of POPULATED_PHASES) {
      const pack = PHASE_KNOWLEDGE[phase]!
      const sys = buildSystemPrompt(fakeRouterInput(phase, pack))
      // why_we_ask should appear verbatim (or at least its first
      // meaningful chunk) so the LLM has the rationale grounding.
      // We assert a 40-char head to tolerate any minor reformatting
      // the prompt builder might do.
      const whyHead = pack.why_we_ask.slice(0, 40)
      expect(sys).toContain(whyHead)
      // At least one expected_tangent.user_text_example should appear
      // (few-shot anchor). We pick the first.
      const tangentHead = pack.expected_tangents[0]!.user_text_example.slice(0, 30)
      expect(sys).toContain(tangentHead)
    }
  })

  test('every still-null phase has no wired prompt (resolver returns null)', () => {
    for (const phase of FOREVER_NULL_PHASES) {
      expect(getKnowledgeForPhase(phase)).toBeNull()
    }
  })
})
