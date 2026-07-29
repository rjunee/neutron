/**
 * 2026-05-28 — `projects_proposed` populated-branch single-CTA tests.
 *
 * Sprint: drop the dead-end "Review each one" button (Sam's
 * 2026-05-28 walkthrough: "click 'review each one' and it didnt do
 * any kind of review, it just moved on immediately"). The populated
 * branch now ships a single "Good to go" CTA + freeform for tweaks
 * like "drop n8n" / "rename Side Project to Apollo".
 *
 * The zero-state suite (`projects-proposed-zero-state.test.ts`)
 * already covers the populated branch's single-CTA assertion. This
 * file pins additional regression coverage:
 *
 *   1. Static spec (resume / unwired-resolver fallback) is single CTA.
 *   2. PROJECTS_PROPOSED_REVIEW constant still exists for defensive
 *      back-compat — the engine handler accepts stale `value: 'review'`
 *      submissions and treats them as confirm-equivalent.
 *   3. Rejection stitching still works on the populated branch.
 */

import { test, expect, describe } from 'bun:test'
import {
  buildProjectsProposedPromptSpec,
  PROJECTS_PROPOSED_CONFIRM,
  PROJECTS_PROPOSED_REVIEW,
  STATIC_PHASE_SPECS,
} from '../phase-prompts.ts'

describe('STATIC_PHASE_SPECS.projects_proposed — single-CTA fallback', () => {
  test('static spec has exactly one Good-to-go option', () => {
    const spec = STATIC_PHASE_SPECS['projects_proposed']
    expect(spec).toBeDefined()
    expect(spec!.options).toEqual([
      { label: 'A', body: 'Good to go', value: PROJECTS_PROPOSED_CONFIRM },
    ])
    expect(spec!.allow_freeform).toBe(true)
    expect(spec!.next_phase_on_default).toBe('persona_synthesizing')
  })

  test('static spec body does NOT mention "Review each one"', () => {
    const spec = STATIC_PHASE_SPECS['projects_proposed']
    expect(spec!.body).not.toContain('Review each one')
    for (const opt of spec!.options) {
      expect(opt.body).not.toBe('Review each one')
      expect(opt.value).not.toBe(PROJECTS_PROPOSED_REVIEW)
    }
  })
})

describe('buildProjectsProposedPromptSpec — populated branch single CTA', () => {
  test('three projects → single Good-to-go option + freeform open', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: ['Topline', 'Northwind', 'Acme'],
    })
    expect(spec.options).toEqual([
      { label: 'A', body: 'Good to go', value: PROJECTS_PROPOSED_CONFIRM },
    ])
    expect(spec.allow_freeform).toBe(true)
    // List is rendered numerically.
    expect(spec.body).toContain('1. Topline')
    expect(spec.body).toContain('2. Northwind')
    expect(spec.body).toContain('3. Acme')
    // Tweak-or-confirm framing survives.
    expect(spec.body).toContain('good to go')
  })

  test('single project still emits single-CTA + freeform', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: ['Topline'],
    })
    expect(spec.options).toHaveLength(1)
    expect(spec.options[0]?.value).toBe(PROJECTS_PROPOSED_CONFIRM)
    expect(spec.allow_freeform).toBe(true)
  })

  test('rejection_reason is stitched in front of the populated body', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: ['Topline', 'Northwind'],
      rejection_reason: "Couldn't parse 'drop the photography one'.",
    })
    expect(spec.body.startsWith("Couldn't parse 'drop the photography one'.")).toBe(true)
    expect(spec.body).toContain('1. Topline')
    expect(spec.options).toHaveLength(1)
    expect(spec.options[0]?.value).toBe(PROJECTS_PROPOSED_CONFIRM)
  })
})

describe('PROJECTS_PROPOSED_REVIEW constant — defensive back-compat', () => {
  test("export still exists so the engine handler can route stale 'review' clicks", () => {
    // The brief (Sam 2026-05-28) explicitly: "Defensive cleanup: do
    // NOT delete PROJECTS_PROPOSED_REVIEW from the codebase. The engine
    // handler still routes a stale `review` value to confirm-equivalent
    // for any old in-flight prompt the user might re-submit. Just no
    // longer offers the option in fresh emits."
    expect(PROJECTS_PROPOSED_REVIEW).toBe('review')
  })
})
