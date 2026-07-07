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
import { AUTO_SKIP_PHASES } from '../engine-internals.ts'

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
  // K11a6-rem2 (Codex REQUEST_CHANGES, 2026-07-06): the original ported
  // block re-derived a LEGAL_TRANSITIONS proxy (vacuous — it passes even
  // if AUTO_SKIP_PHASES changes entirely) AND wrongly claimed
  // persona_synthesizing was auto-skipped. Production explicitly documents
  // the opposite (engine-internals.ts:1460-1466: auto-skipping
  // persona_synthesizing would fire the walker BEFORE synthesizePersona
  // and never invoke compose()). The retained exported set
  // (engine-internals.ts:1468-1471) is `identity_oauth` +
  // `instance_provisioned` only. Pin the REAL exported set by EXACT
  // membership so any add/remove regresses noisily.

  test('AUTO_SKIP_PHASES has exactly identity_oauth + instance_provisioned', () => {
    expect(new Set(AUTO_SKIP_PHASES)).toEqual(
      new Set<OnboardingPhase>(['identity_oauth', 'instance_provisioned']),
    )
    // Explicit non-membership anchors for the two phases most likely to be
    // mistaken for auto-skip: persona_synthesizing (back-stage transit but
    // MUST run synthesizePersona inline) + agent_name_chosen (v2
    // user-visible "what should I be called?" per § 3.10).
    expect(AUTO_SKIP_PHASES.has('persona_synthesizing')).toBe(false)
    expect(AUTO_SKIP_PHASES.has('agent_name_chosen')).toBe(false)
  })

  test('every auto-skip phase has a non-failure outgoing edge so the walker has a target', () => {
    // Cross-invariant against the retained LEGAL_TRANSITIONS table: a
    // phase the engine auto-skips must have somewhere legal to skip TO.
    for (const phase of AUTO_SKIP_PHASES) {
      const legal = LEGAL_TRANSITIONS[phase]
      const nonFailureTargets = legal.filter((t) => t !== 'failed')
      expect({ phase, hasNonFailureTarget: nonFailureTargets.length > 0 }).toEqual({
        phase,
        hasNonFailureTarget: true,
      })
    }
  })
})
