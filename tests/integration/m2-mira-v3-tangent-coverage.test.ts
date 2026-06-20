/**
 * P2-v3 S4 — auto-generated tangent-coverage suite.
 *
 * One test per `PHASE_KNOWLEDGE[phase].expected_tangents` entry across
 * every non-null pack. Per `docs/plans/P2-v3-S4-fixture-harness-semantic-equivalence.md`
 * § 5, this is the breadth coverage layer — for every pack-declared
 * tangent, boot the engine at that phase, stub the router with the
 * brief-declared `expected_action`, fire the canonical
 * `user_text_example`, and assert:
 *
 *   - phase did NOT advance (both `answer` and `amend` keep state put)
 *   - router was consulted exactly once for this turn
 *   - agent response was posted as a sendButtonPrompt invocation
 *   - on `amend`, the marker key survived the S2-r2 whitelist
 *
 * Module-level sentinel asserts `totalTangentTests ≥ 50` so a regression
 * in `PHASE_KNOWLEDGE` (a pack getting emptied) fails the suite fast.
 *
 * SKIPS pick-only phases (`max_oauth_offered`). The engine's
 * `normalAdvance` short-circuits to "record + re-emit, router not
 * consulted" when `spec.allow_freeform === false`. Generating tests for
 * those phases would lie about what the router did. Out-of-scope per
 * brief § 2 — engine wiring is frozen.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ALL_PHASES, type OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'
import {
  PHASE_KNOWLEDGE,
  getKnowledgeForPhase,
} from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import { STATIC_PHASE_SPECS } from '@neutronai/onboarding/interview/phase-prompts.ts'
import { INTERACTION_MODE_BY_PHASE } from '@neutronai/onboarding/interview/interaction-mode.ts'
import {
  bootEngineAtPhase,
  stubRouter,
  type BoothedEngine,
} from './m2-walkthrough-test-helpers.ts'

// Phases the engine routes router-consult on freeform input. Excludes:
//   - pick-only phases (allow_freeform=false in STATIC_PHASE_SPECS)
//   - transit / terminal / external-driven phases (PHASE_KNOWLEDGE=null)
function isRouterableFreeformPhase(phase: OnboardingPhase): boolean {
  if (getKnowledgeForPhase(phase) === null) return false
  const spec = STATIC_PHASE_SPECS[phase]
  if (spec === undefined) return false
  return spec.allow_freeform === true
}

// Standard seed state per phase — just enough to satisfy the
// required-fields audit so the engine emits the active prompt without
// short-circuiting on missing upstream fields.
const SEED_STATE: Readonly<Record<string, Record<string, unknown>>> = {
  signup: {},
  ai_substrate_offered: { user_first_name: 'Alex' },
  import_upload_pending: { user_first_name: 'Alex', ai_substrate_used: 'chatgpt' },
  import_analysis_presented: {
    user_first_name: 'Alex',
    primary_projects: ['Ledgerline', 'Halo', 'Beacon'],
  },
  work_interview_gap_fill: { user_first_name: 'Alex' },
  personality_offered: { user_first_name: 'Alex' },
  agent_name_chosen: { user_first_name: 'Alex' },
  slug_chosen: { user_first_name: 'Alex', agent_name: 'Atlas', suggested_slug: 'alex' },
  projects_proposed: {
    user_first_name: 'Alex',
    primary_projects: ['Ledgerline', 'Halo', 'Beacon', 'CC', 'Caldera'],
  },
  persona_reviewed: {
    user_first_name: 'Alex',
    agent_name: 'Atlas',
    chosen_slug: 'alex',
  },
}

// Count routable tangents at module load. The sentinel fails the suite
// if PHASE_KNOWLEDGE regresses below the design § 5.5 floor.
let totalTangentTests = 0
for (const phase of ALL_PHASES) {
  if (!isRouterableFreeformPhase(phase)) continue
  const pack = PHASE_KNOWLEDGE[phase]
  if (pack === null) continue
  totalTangentTests += pack.expected_tangents.length
}

let harness: BoothedEngine | null = null

beforeEach(() => {
  harness = null
})

afterEach(() => {
  if (harness !== null) {
    harness.cleanup()
    harness = null
  }
})

describe('v3 tangent-coverage floor (sentinel)', () => {
  test(`total tangent tests ≥ 50 (got ${totalTangentTests})`, () => {
    expect(totalTangentTests).toBeGreaterThanOrEqual(50)
  })
})

for (const phase of ALL_PHASES) {
  if (!isRouterableFreeformPhase(phase)) continue
  const pack = getKnowledgeForPhase(phase)
  if (pack === null) continue

  // 2026-06-03 (onboarding-buttons-only-tweak-later): the router only runs
  // on phases still in 'freeform' mode (signup, work_interview_gap_fill).
  // Reclassified buttons-only/mixed phases skip — typed tangents now get
  // the canned nudge. The sentinel above still counts pack tangents (≥50),
  // so coverage of the knowledge packs is unchanged; only the now-dead
  // router-routing assertions are skipped. See ISSUES.md "onboarding
  // LLM-router retired for buttons-only/mixed phases".
  const tangentRunner = INTERACTION_MODE_BY_PHASE[phase] === 'freeform' ? test : test.skip
  describe(`v3 tangent coverage | ${phase}`, () => {
    for (let i = 0; i < pack.expected_tangents.length; i += 1) {
      const tangent = pack.expected_tangents[i]!
      tangentRunner(`tangent #${i}: ${tangent.summary.slice(0, 60)}`, async () => {
        // Use the S2-r2 whitelisted `auxiliary_facts` key on amend so
        // the merge survives the engine's whitelist guard. Plain
        // structural keys at the top level get rejected at the
        // engine's dispatchAmend boundary.
        const stubDelta =
          tangent.expected_action === 'amend'
            ? ({
                auxiliary_facts: {
                  tangent_marker: `${phase}:${i}`,
                },
              } as Record<string, unknown>)
            : null
        const { router, calls } = stubRouter([
          {
            action: tangent.expected_action,
            confidence: 0.92,
            choice_value: null,
            freeform_text: null,
            response: `STUB-TANGENT-${phase}-${i}`,
            state_delta: stubDelta as never,
            reasoning: tangent.summary.slice(0, 100),
          },
        ])
        harness = await bootEngineAtPhase(phase, {
          llmRouter: router,
          phase_state_patch: SEED_STATE[phase] ?? { user_first_name: 'Alex' },
        })
        const activeId = harness.active_prompt_id
        const out = await harness.engine.advance({
          project_slug: harness.project_slug,
          topic_id: harness.topic_id,
          user_id: harness.user_id,
          channel_kind: 'app-socket',
          freeform_text: tangent.user_text_example,
        })

        // Router consulted exactly once for this turn.
        expect(calls.length).toBe(1)
        expect(calls[0]?.input.phase).toBe(phase)
        expect(calls[0]?.input.user_text).toBe(tangent.user_text_example)

        const ps = (out.state?.phase_state ?? {}) as Record<string, unknown>
        const bodies = harness.sentPrompts.map((p) => p.prompt.body)
        // Agent response posted via sendButtonPrompt.
        expect(bodies.some((b) => b.includes(`STUB-TANGENT-${phase}-${i}`))).toBe(true)

        // Gate-collapse (#92, 2026-06-05): at import_analysis_presented a
        // bare `amend` now AUTO-ADVANCES (correction applied via the hybrid
        // amend+advance tail). Every OTHER phase, and the `answer` action,
        // keep the legacy stay-on-phase + keyboard-re-emit semantics.
        //
        // BUG 1 (onboarding-opening-fix, 2026-06-19): on `signup` an
        // amend/answer that carries a NAME signal also auto-advances —
        // signup's only job is to capture the name, so once a name is
        // present (here: extracted from "I'm Sam …") advancing IS the
        // correct outcome (`tryAdvanceSignupFromRouter`). The fixture
        // tangent declares this with the `advance signup` summary suffix.
        const amendAdvances =
          (phase === 'import_analysis_presented' && tangent.expected_action === 'amend') ||
          (phase === 'signup' && tangent.summary.includes('advance signup'))
        if (amendAdvances) {
          // Advanced OFF the current phase.
          expect(out.state?.phase).not.toBe(phase)
          // import_analysis_presented merges the corrected delta
          // (auxiliary_facts marker) on advance; the signup name-capture
          // advance routes the name rather than the auxiliary_facts marker,
          // so the marker assertion is scoped to the import gate.
          if (phase === 'import_analysis_presented') {
            const aux = ps['auxiliary_facts'] as Record<string, unknown> | undefined
            expect(aux?.['tangent_marker']).toBe(`${phase}:${i}`)
          }
        } else {
          // Phase stayed put (answer + non-import amend semantics).
          expect(out.state?.phase).toBe(phase)
          expect(ps['active_prompt_id']).toBe(activeId)
          // On amend, the whitelisted state_delta landed.
          if (tangent.expected_action === 'amend') {
            const aux = ps['auxiliary_facts'] as Record<string, unknown> | undefined
            expect(aux?.['tangent_marker']).toBe(`${phase}:${i}`)
          }
          // Keyboard re-emitted (router action=answer + amend MUST anchor
          // the active prompt so taps still resolve).
          const reemit = harness.sentPrompts.find(
            (p) => p.prompt.prompt_id === activeId,
          )
          expect(reemit).toBeDefined()
        }
      })
    }
  })
}
