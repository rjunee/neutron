/**
 * K11a6-rem2 survivor — phase transition-table structural invariants.
 *
 * SPLIT off `v2-phase-walk.test.ts` (2026-07-06). The two `describe`
 * blocks below assert pure structural invariants on the RETAINED tables
 * `LEGAL_TRANSITIONS` / `isLegalTransition` (onboarding/interview/phase.ts),
 * which K11b1 does NOT touch and which stay live-consumed by
 * `engine-import-routing.ts`. They import the tables DIRECTLY and make
 * ZERO engine calls, so they survive the K11b1 deletion of
 * `engine.start` / `advance`.
 *
 * The companion phase-WALK block (`P2 v2 — engine.advance walks every
 * spec'd phase`) stays in `v2-phase-walk.test.ts` and co-deletes in K11b1
 * because it drives the dying `engine.start` / `advance`. Only 2 of these
 * table rows were cross-covered by `m2-ux-surface-fixes.test.ts`; this
 * survivor re-anchors the full table invariants.
 *
 * Ported byte-intact from v2-phase-walk.test.ts describe blocks
 * "P2 v2 — LEGAL_TRANSITIONS table" and "P2 v2 — AUTO_SKIP_PHASES set".
 */

import { describe, expect, test } from 'bun:test'
import { isLegalTransition, LEGAL_TRANSITIONS } from '../phase.ts'
import type { OnboardingPhase } from '../phase.ts'

describe('P2 v2 — LEGAL_TRANSITIONS table', () => {
  test('every legal target is itself a known phase', () => {
    const allPhases = new Set(Object.keys(LEGAL_TRANSITIONS))
    for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
      for (const to of targets) {
        expect({ from, target: to, known: allPhases.has(to) }).toEqual({
          from,
          target: to,
          known: true,
        })
      }
    }
  })

  test('terminal phases have no outgoing edges', () => {
    expect(LEGAL_TRANSITIONS['completed']).toEqual([])
    expect(LEGAL_TRANSITIONS['failed']).toEqual([])
  })

  test('isLegalTransition matches the table', () => {
    expect(isLegalTransition('signup', 'instance_provisioned')).toBe(true)
    expect(isLegalTransition('signup', 'identity_oauth')).toBe(true)
    expect(isLegalTransition('signup', 'agent_name_chosen')).toBe(false)
    expect(isLegalTransition('signup', 'wow_fired')).toBe(false)
  })

  test('v2 chain matches § 2.8 — every spec phase is reachable forward', () => {
    // Walk the v2 happy-path chain by edge — assert each (from, to)
    // pair is legal. Catches a future refactor that drops an edge.
    const noImportChain: Array<[string, string]> = [
      ['signup', 'instance_provisioned'],
      ['instance_provisioned', 'ai_substrate_offered'],
      ['ai_substrate_offered', 'work_interview_gap_fill'],
      ['work_interview_gap_fill', 'personality_offered'],
      ['personality_offered', 'agent_name_chosen'],
      ['agent_name_chosen', 'slug_chosen'],
      ['slug_chosen', 'projects_proposed'],
      ['projects_proposed', 'persona_synthesizing'],
      ['persona_synthesizing', 'persona_reviewed'],
      ['persona_reviewed', 'max_oauth_offered'],
      ['max_oauth_offered', 'wow_fired'],
      ['wow_fired', 'completed'],
    ]
    for (const [from, to] of noImportChain) {
      expect({ from, to, legal: isLegalTransition(from as OnboardingPhase, to as OnboardingPhase) }).toEqual({
        from,
        to,
        legal: true,
      })
    }
    // Import branch fork: ai_substrate_offered → import_upload_pending
    // → import_running → import_analysis_presented → personality_offered.
    const importChain: Array<[string, string]> = [
      ['ai_substrate_offered', 'import_upload_pending'],
      ['import_upload_pending', 'import_running'],
      ['import_running', 'import_analysis_presented'],
      ['import_analysis_presented', 'personality_offered'],
      ['import_analysis_presented', 'work_interview_gap_fill'],
    ]
    for (const [from, to] of importChain) {
      expect({ from, to, legal: isLegalTransition(from as OnboardingPhase, to as OnboardingPhase) }).toEqual({
        from,
        to,
        legal: true,
      })
    }
  })

  test('persona_reviewed has v2 redo edges back to earlier phases', () => {
    // § 2.12 — redo from persona_reviewed jumps back to personality_offered,
    // agent_name_chosen, or slug_chosen so the user can re-do an earlier
    // step. The forward edges (max_oauth_offered / wow_fired) also stand.
    const legal = LEGAL_TRANSITIONS['persona_reviewed']
    expect(legal).toContain('max_oauth_offered')
    expect(legal).toContain('personality_offered')
    expect(legal).toContain('agent_name_chosen')
    expect(legal).toContain('slug_chosen')
  })
})

describe('P2 v2 — AUTO_SKIP_PHASES set', () => {
  test('contains identity_oauth + instance_provisioned + persona_synthesizing only', () => {
    // The exported set is unobservable from outside the engine module
    // (it's a `const` not exported), so we audit by walking each phase
    // through the legal-transition table — auto-skip phases must have
    // at least one non-failure outgoing edge so the walker has a target.
    const expectedAutoSkip = [
      'identity_oauth',
      'instance_provisioned',
      'persona_synthesizing',
    ] as const
    for (const phase of expectedAutoSkip) {
      const legal = LEGAL_TRANSITIONS[phase]
      const nonFailureTargets = legal.filter((t) => t !== 'failed')
      expect({ phase, hasNonFailureTarget: nonFailureTargets.length > 0 }).toEqual({
        phase,
        hasNonFailureTarget: true,
      })
    }
    // agent_name_chosen is NOT auto-skip in v2 — it's user-visible per
    // § 3.10. Verify by asserting STATIC_PHASE_SPECS has a body that
    // captures the agent name (i.e. it's reachable / emitted).
    // Done via the spec-coverage test in m2-ux-surface-fixes.test.ts;
    // this row is the negative anchor.
  })
})
