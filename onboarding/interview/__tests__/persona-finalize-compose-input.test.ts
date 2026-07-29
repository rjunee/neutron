/**
 * K11a6-rem2 survivor — `buildComposeInput` → `PersonaComposer.compose`
 * field-mapping + derive-branch pin (2026-07-06).
 *
 * WHAT THIS PINS (the retained, LIVE, otherwise-uncovered prod path):
 *
 *   Prod composes the owner persona at Path-1 finalize, NOT the
 *   (dead-in-prod, K11b1-deleted) engine phase-walk:
 *     gateway/wiring/build-onboarding-finalize.ts:453
 *       → buildComposeInput(owner_slug, state)        [engine-internals.ts:1806, LIVE post-K11b1]
 *       → PersonaComposer.compose(...)                  [onboarding/persona-gen/compose.ts]
 *
 *   The finalize survivor `build-onboarding-finalize.test.ts` injects a
 *   FAKE composer that never inspects its input, so the
 *   `phase_state` → `ComposeInput` field-mapping is unpinned by any
 *   survivor. And every persona-gen survivor passes an explicit
 *   `archetype_blend`, so the `deriveArchetypeBlend` free-text branch
 *   (compose.ts:329-337) — which fires exactly when `buildComposeInput`
 *   emits `signals.agent_personality` with NO `archetype_blend`
 *   (engine-internals.ts:1836-1871, which never sets archetype_blend) —
 *   is never exercised on the wired-together path.
 *
 * This survivor re-anchors the three K11b1-dying pins ADDITIVELY:
 *   - `persona-synthesizing.test.ts` test 2 ("compose receives captured
 *     signals") — the phase_state → ComposeInput.signals/user_facts map.
 *   - `persona-v2-flow.test.ts` — the only test importing `buildComposeInput`.
 *   - `personality-offered-single-handler.test.ts` §7.1 — the compose
 *     blend-from-`agent_personality` derive-branch.
 * Those three drive the dying `engine.advance` and co-delete in K11b1;
 * this survivor drives the REAL retained caller (`buildComposeInput` +
 * `PersonaComposer.compose`) instead — no engine, no phase-walk.
 *
 * (The `composeFromFreeText` algorithm itself is separately covered by
 * `onboarding/archetypes/__tests__/compose-from-free-text.test.ts`; this
 * closes the integration-wiring gap between it and `buildComposeInput`.)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildComposeInput } from '../engine-internals.ts'
import type { OnboardingState } from '../state-store.ts'
import { PersonaComposer } from '../../persona-gen/compose.ts'
import { buildCringeChecker } from '../../persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '../../archetypes/library.ts'

const PROJECT_SLUG = 'acme'
const USER_ID = 'google:test-owner'

// A free-text personality with NO curated-archetype mention. This lands
// the `composeFromFreeText` free-text branch (slugs === ['free-text']),
// which threads the phrase verbatim into SOUL.md's voice section — the
// observable proof that `deriveArchetypeBlend` ran off
// `signals.agent_personality` (there is no explicit `archetype_blend`).
const PERSONALITY = 'a warm thinking-partner who always explains the why'
const TIMEZONE = 'America/New_York'

/**
 * The captured interview signals as they land on `phase_state` at Path-1
 * finalize time — the exact shape `buildComposeInput` reads.
 */
const CAPTURED_PHASE_STATE: Record<string, unknown> = {
  user_id: USER_ID,
  topic_id: `web:${USER_ID}`,
  signup_via: 'web',
  user_first_name: 'Mira',
  agent_name: 'Sage',
  agent_personality: PERSONALITY,
  primary_projects: [
    'Caldera (fragrance brand)',
    'Hera concept (perfume #1)',
    'Wholesale-distribution playbook',
  ],
  non_work_interests: [{ name: 'yoga' }, { name: 'rare-book hunting' }],
  work_themes: ['fragrance product development'],
  companies: ['Caldera (founder + creative director)'],
  inner_circle: ['Jordan (husband)', 'Lily (daughter)'],
  rituals_captured: ['weekly review on Sunday'],
  work_pattern: 'solo deep work in the morning, calls in the afternoon',
  time_style: 'async-low',
  timezone: TIMEZONE,
}

function makeState(phase_state: Record<string, unknown>): OnboardingState {
  const now = Date.now()
  return {
    owner_slug: PROJECT_SLUG,
    user_id: USER_ID,
    phase: 'persona_synthesizing',
    phase_state,
    started_at: now,
    last_advanced_at: now,
    completed_at: null,
    import_job_id: null,
    persona_files_committed: false,
    wow_fired: false,
    wow_pushed_at: null,
    onboarding_handoff_emitted_at: null,
    attempt_id: 'test-attempt',
  }
}

let tmp: string
let composer: PersonaComposer

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-finalize-compose-'))
  // Wire the composer the same way Path-1 finalize does
  // (`buildDefaultPersonaComposer`): curated ArchetypeLibrary + the real
  // `buildCringeChecker`. The prose personality lands the free-text
  // branch regardless of library, but wiring it keeps the survivor
  // byte-faithful to the finalize composer.
  const archetypes = new ArchetypeLibrary({
    dataDir: join(import.meta.dir, '..', '..', 'archetypes', 'data'),
    cacheDir: join(tmp, 'arch-cache'),
  })
  composer = new PersonaComposer({
    cringeChecker: buildCringeChecker(),
    ownerHomeFor: (_slug: string): string => join(tmp, 'persona'),
    archetypes,
  })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('K11a6-rem2 — buildComposeInput → PersonaComposer.compose (Path-1 finalize path)', () => {
  test('(a) phase_state → ComposeInput.signals / user_facts field-mapping is correct', () => {
    const ci = buildComposeInput(PROJECT_SLUG, makeState(CAPTURED_PHASE_STATE))

    expect(ci.owner_slug).toBe(PROJECT_SLUG)

    // signals: display_name = agent_name; agent voice-subject fields.
    expect(ci.signals.display_name).toBe('Sage')
    expect(ci.signals.agent_name).toBe('Sage')
    expect(ci.signals.agent_personality).toBe(PERSONALITY)
    expect(ci.signals.primary_projects).toEqual([
      'Caldera (fragrance brand)',
      'Hera concept (perfume #1)',
      'Wholesale-distribution playbook',
    ])
    expect(ci.signals.non_work_interests).toEqual(['yoga', 'rare-book hunting'])
    expect(ci.signals.rituals).toEqual(['weekly review on Sunday'])
    expect(ci.signals.work_pattern).toContain('deep work in the morning')
    expect(ci.signals.time_style).toBe('async-low')
    expect(ci.signals.inner_circle).toEqual(['Jordan (husband)', 'Lily (daughter)'])

    // user_facts: display_name anchors on the USER (user_first_name),
    // NOT the agent name; timezone + preferences[time_style] carried.
    expect(ci.user_facts.display_name).toBe('Mira')
    expect(ci.user_facts.timezone).toBe(TIMEZONE)
    expect(ci.user_facts.primary_projects).toEqual([
      'Caldera (fragrance brand)',
      'Hera concept (perfume #1)',
      'Wholesale-distribution playbook',
    ])
    expect(ci.user_facts.companies).toEqual(['Caldera (founder + creative director)'])
    expect(ci.user_facts.preferences).toEqual([{ key: 'time_style', value: 'async-low' }])

    // CRITICAL: buildComposeInput leaves archetype_blend UNSET so the
    // composer must derive it from signals.agent_personality. This is the
    // precondition that makes the deriveArchetypeBlend branch fire.
    expect(ci.archetype_blend).toBeUndefined()
  })

  test('(b) the agent_personality → deriveArchetypeBlend free-text branch fires and shapes SOUL.md voice', async () => {
    const ci = buildComposeInput(PROJECT_SLUG, makeState(CAPTURED_PHASE_STATE))
    // Precondition for the branch: no pre-computed blend.
    expect(ci.archetype_blend).toBeUndefined()

    const draft = await composer.compose(ci)

    // The agent voice-subject line proves signals.agent_name/user_first_name
    // mapped through.
    expect(draft.soul_md).toContain('# SOUL.md')
    expect(draft.soul_md).toContain('You are Sage')
    expect(draft.soul_md).toContain('You work with Mira')

    // The free-text personality phrase is threaded VERBATIM into SOUL.md's
    // Archetypal Blend voice fragment — this only happens when
    // deriveArchetypeBlend runs composeFromFreeText off
    // signals.agent_personality (had buildComposeInput dropped the field,
    // the composer would fall back to the "balanced" blend and this phrase
    // would be absent).
    expect(draft.soul_md).toContain(PERSONALITY)
    // The primary projects also surface in SOUL principles.
    expect(draft.soul_md).toContain('Caldera (fragrance brand)')
  })

  test('(c) USER.md reflects primary_projects + timezone from phase_state', async () => {
    const ci = buildComposeInput(PROJECT_SLUG, makeState(CAPTURED_PHASE_STATE))
    const draft = await composer.compose(ci)

    expect(draft.user_md).toContain('# USER.md')
    // Timezone carried into USER.md Identity (the agent knows it without
    // ever asking — Item 5, 2026-06-19).
    expect(draft.user_md).toContain(`- **Timezone:** ${TIMEZONE}`)
    // Key Projects section from primary_projects.
    expect(draft.user_md).toContain('## Key Projects')
    expect(draft.user_md).toContain('Caldera (fragrance brand)')
    expect(draft.user_md).toContain('Hera concept (perfume #1)')
    // Companies + Outside Interests round out the map.
    expect(draft.user_md).toContain('## Companies')
    expect(draft.user_md).toContain('Caldera (founder + creative director)')
    expect(draft.user_md).toContain('## Outside Interests')
    expect(draft.user_md).toContain('yoga')
  })

  test('field-mapping is the ONLY blend source — dropping agent_personality lands the balanced fallback (guards the derive precondition)', async () => {
    // Complementary negative anchor: when agent_personality is absent from
    // phase_state, buildComposeInput emits no signals.agent_personality, so
    // deriveArchetypeBlend takes the "balanced" branch and the specific
    // prose phrase never appears. This is exactly what a broken
    // buildComposeInput field-mapping would produce — pinning that the
    // (b) assertion is load-bearing, not incidental.
    const withoutPersonality = { ...CAPTURED_PHASE_STATE }
    delete withoutPersonality['agent_personality']
    const ci = buildComposeInput(PROJECT_SLUG, makeState(withoutPersonality))
    expect(ci.signals.agent_personality).toBeUndefined()
    const draft = await composer.compose(ci)
    // Balanced fallback still produces a valid draft, but NOT the phrase.
    expect(draft.soul_md.length).toBeGreaterThan(0)
    expect(draft.soul_md).not.toContain(PERSONALITY)
  })
})
