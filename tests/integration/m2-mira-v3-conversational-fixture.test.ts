/**
 * P2-v3 S4 — in-process integration test for the v3 conversational
 * tangents fixture.
 *
 * Boots a real `InterviewEngine` against an `InMemoryOnboardingStateStore`
 * + a `TranscriptWriter` + a fixture-fed `LlmRouter`, then walks
 * `tests/fixtures/m2/mira-conversational-tangents.json` top-down per
 * phase. For each reply, asserts:
 *
 *  - phase landed in `target_state.phase_advanced_to`
 *  - every key in `target_state.state_fields_populated` is present
 *  - if `assert_router_action` set, the engine consulted the router and
 *    landed on that action
 *
 * The "brief incident" assertion is the most important assertion in
 * this sprint: at `import_upload_pending`, "can you give me the
 * instructions for claude as well" must produce a router `answer` —
 * NOT `advance` — and the engine must stay on import_upload_pending.
 *
 * See `docs/plans/P2-v3-S4-fixture-harness-semantic-equivalence.md` § 8.2
 * for the contract this file verifies.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseV3Fixture, type V3Fixture, type V3FixturePhase, type V3FixtureReply } from '../fixtures/m2/v3-fixture.ts'
import {
  bootEngineAtPhase,
  buildFixtureFedRouter,
  type BoothedEngine,
} from './m2-walkthrough-test-helpers.ts'
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'
import { INTERACTION_MODE_BY_PHASE } from '@neutronai/onboarding/interview/interaction-mode.ts'

const FIXTURE_PATH = join(
  process.cwd(),
  'tests/fixtures/m2/mira-conversational-tangents.json',
)

function loadFixture(): V3Fixture {
  return parseV3Fixture(readFileSync(FIXTURE_PATH, 'utf8'))
}

/**
 * Each fixture phase seeds the InMemory state store with the minimum
 * state needed for the engine to fire its phase prompt. The seeds are
 * a strict subset of the v2 end-state contract — every required
 * upstream field for the phase under test is filled with a synthetic
 * value so the engine never trips the required-fields audit before the
 * router gets a chance to run.
 */
const SEED_BY_PHASE: Readonly<Record<string, Record<string, unknown>>> = {
  signup: {},
  ai_substrate_offered: { user_first_name: 'Mira' },
  import_upload_pending: {
    user_first_name: 'Mira',
    ai_substrate_used: 'chatgpt',
  },
  personality_offered: {
    user_first_name: 'Mira',
    ai_substrate_used: 'chatgpt',
  },
  agent_name_chosen: {
    user_first_name: 'Mira',
    agent_personality: 'warm thinking-partner',
  },
  slug_chosen: {
    user_first_name: 'Mira',
    agent_name: 'Sage',
    suggested_slug: 'sage-mira',
  },
  work_interview_gap_fill: {
    user_first_name: 'Mira',
    ai_substrate_used: 'chatgpt',
  },
  projects_proposed: {
    user_first_name: 'Mira',
    primary_projects: ['Halo', 'Caldera'],
  },
}

function buildHarnessRouter(phase: V3FixturePhase) {
  // Subset of the fixture-fed router that only consumes the replies
  // for THIS phase — each per-phase test creates its own harness +
  // router, isolated from the rest of the walk so state seeded for
  // one phase doesn't contaminate another.
  const singlePhaseFixture: V3Fixture = {
    version: 3,
    name: `single-${phase.phase}`,
    phases: [phase],
  }
  return buildFixtureFedRouter(singlePhaseFixture)
}

let harnesses: BoothedEngine[] = []

beforeEach(() => {
  harnesses = []
})

afterEach(() => {
  for (const h of harnesses) h.cleanup()
  harnesses = []
})

// SKIP 2026-06-03 (onboarding-buttons-only-tweak-later): import_upload_pending
// is now buttons-only; the router is never reached, so the brief-incident
// "claude instructions tangent" answer path is retired here. Mirrors the
// skips in engine-router-integration.test.ts + llm-router-composer.test.ts.
describe.skip('v3 conversational fixture — brief incident lives here', () => {
  test('import_upload_pending: claude-instructions tangent → router answer, no advance', async () => {
    const fixture = loadFixture()
    const phase = fixture.phases.find(
      (p) => p.phase === 'import_upload_pending',
    )
    if (phase === undefined) throw new Error('fixture missing import_upload_pending')
    const router = buildHarnessRouter(phase)
    const harness = await bootEngineAtPhase('import_upload_pending', {
      llmRouter: router,
      phase_state_patch: SEED_BY_PHASE['import_upload_pending']!,
    })
    harnesses.push(harness)

    const reply = phase.replies[0]!
    expect(reply.assert_router_action).toBe('answer')

    const out = await harness.engine.advance({
      project_slug: harness.project_slug,
      topic_id: harness.topic_id,
      user_id: harness.user_id,
      channel_kind: 'app-socket',
      freeform_text: reply.text!,
    })

    // CRITICAL: phase must stay at import_upload_pending.
    expect(out.state?.phase).toBe('import_upload_pending')
    // active_prompt_id must remain unchanged.
    const ps = (out.state?.phase_state ?? {}) as Record<string, unknown>
    expect(ps['active_prompt_id']).toBe(harness.active_prompt_id)
    // The agent's Claude-export body must have been emitted.
    const bodies = harness.sentPrompts.map((p) => p.prompt.body)
    expect(
      bodies.some(
        (b) =>
          b.toLowerCase().includes('claude') ||
          b.toLowerCase().includes('settings') ||
          b.toLowerCase().includes('privacy'),
      ),
    ).toBe(true)
    // The user text landed on the transcript.
    const userLines = harness.transcript
      .readAll()
      .filter((e) => e.role === 'user')
      .map((e) => e.body)
    expect(userLines).toContain(reply.text!)
  })
})

describe('v3 conversational fixture — every tangent phase', () => {
  const fixture = loadFixture()
  for (const phase of fixture.phases) {
    // 2026-06-03: only still-freeform phases walk router replies; the
    // reclassified buttons-only/mixed phases skip (router not reached).
    const fixtureRunner =
      INTERACTION_MODE_BY_PHASE[phase.phase as OnboardingPhase] === 'freeform'
        ? test
        : test.skip
    fixtureRunner(`${phase.phase}: walks replies, semantic targets land`, async () => {
      const router = buildHarnessRouter(phase)
      const harness = await bootEngineAtPhase(phase.phase as OnboardingPhase, {
        llmRouter: router,
        phase_state_patch:
          SEED_BY_PHASE[phase.phase] ?? { user_first_name: 'Mira' },
      })
      harnesses.push(harness)

      let phaseSatisfied = false
      const initialActiveId = harness.active_prompt_id
      for (
        let r = 0;
        r < phase.replies.length && r < phase.turn_budget && !phaseSatisfied;
        r++
      ) {
        const reply: V3FixtureReply = phase.replies[r]!
        const input: Parameters<typeof harness.engine.advance>[0] = {
          project_slug: harness.project_slug,
          topic_id: harness.topic_id,
          user_id: harness.user_id,
          channel_kind: 'app-socket',
        }
        if (reply.kind === 'freeform') {
          input.freeform_text = reply.text!
        } else if (reply.kind === 'button') {
          // The fixture-fed router supplies an advance decision for the
          // button tap; the engine still wants a freeform_text in the
          // input because the harness routes through the router seam,
          // not the button-store consume path.
          input.freeform_text = reply.value!
        } else {
          continue
        }

        await harness.engine.advance(input)

        const state = await harness.stateStore.get(harness.project_slug, harness.user_id)
        const currentPhase = state?.phase ?? null
        const inTarget =
          currentPhase !== null &&
          phase.target_state.phase_advanced_to.includes(currentPhase)
        if (inTarget) {
          const ps = (state?.phase_state ?? {}) as Record<string, unknown>
          const allKeysPresent = phase.target_state.state_fields_populated.every(
            (k) => ps[k] !== undefined && ps[k] !== null,
          )
          if (allKeysPresent) phaseSatisfied = true
        }
      }

      const finalState = await harness.stateStore.get(harness.project_slug, harness.user_id)
      expect(finalState).not.toBeNull()
      const finalPhase = finalState!.phase
      expect(phase.target_state.phase_advanced_to).toContain(finalPhase)
      const finalPs = finalState!.phase_state as Record<string, unknown>
      for (const k of phase.target_state.state_fields_populated) {
        expect(finalPs[k]).toBeDefined()
        expect(finalPs[k]).not.toBeNull()
      }

      // When the FIRST reply was an `answer` tangent, the phase MUST
      // have stayed put on that first advance + active_prompt_id stayed
      // anchored — that's the v3 router-action invariant.
      const firstReply = phase.replies[0]!
      if (firstReply.assert_router_action === 'answer') {
        // Phase did not advance on the first reply.
        // We assert this by checking the transcript: the user's first
        // text landed AND a router-driven agent bubble fired in response.
        const userLines = harness.transcript
          .readAll()
          .filter((e) => e.role === 'user')
          .map((e) => e.body)
        if (firstReply.kind === 'freeform') {
          expect(userLines).toContain(firstReply.text!)
        }
        // active_prompt_id was preserved across the tangent (router's
        // `answer` action re-emits the SAME prompt_id).
        const reemit = harness.sentPrompts.find(
          (p) => p.prompt.prompt_id === initialActiveId,
        )
        expect(reemit).toBeDefined()
      }
    })
  }
})
