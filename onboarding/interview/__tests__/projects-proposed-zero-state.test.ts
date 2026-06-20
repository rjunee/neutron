/**
 * v0.1.80 (2026-05-22) — `projects_proposed` zero-state UX tests.
 *
 * Spec: Sam flagged the zero-projects branch shipped [A] "Good to go" /
 * [B] "Review each one" buttons that were nonsensical with N=0. This
 * test pins the current behavior:
 *
 *   - Zero projects → [A] "Share what I'm working on" (share_work) +
 *     [B] "Skip — set things up as we go" (skip_ahead).
 *   - Populated → single [A] "Good to go" (confirm); the legacy
 *     [B] "Review each one" button is gone as of 2026-05-28 (Sam
 *     walkthrough — clicking it did no per-project review, just
 *     advanced). Freeform tweaks like "drop n8n" still route through
 *     the LLM-router amend pipeline.
 *   - Share-freeform sub-state → no buttons, freeform-only "tell me
 *     what you're working on" body.
 */

import { test, expect, describe } from 'bun:test'
import {
  buildProjectsProposedPromptSpec,
  PROJECTS_PROPOSED_CONFIRM,
  PROJECTS_PROPOSED_REVIEW,
  PROJECTS_PROPOSED_SHARE_WORK,
  PROJECTS_PROPOSED_SKIP_AHEAD,
} from '../phase-prompts.ts'

import { splitFreeformProjectList } from '../engine.ts'

describe('buildProjectsProposedPromptSpec — zero-state buttons', () => {
  test('zero projects emits share_work + skip_ahead buttons', () => {
    const spec = buildProjectsProposedPromptSpec({ primary_projects: [] })
    expect(spec.phase).toBe('projects_proposed')
    expect(spec.options).toEqual([
      {
        label: 'A',
        body: "Share what I'm working on",
        value: PROJECTS_PROPOSED_SHARE_WORK,
      },
      {
        label: 'B',
        body: 'Skip — set things up as we go',
        value: PROJECTS_PROPOSED_SKIP_AHEAD,
      },
    ])
    expect(spec.allow_freeform).toBe(true)
    expect(spec.next_phase_on_default).toBe('persona_synthesizing')
    // Zero-state body still mentions the share-or-skip framing.
    expect(spec.body).toContain("I didn't pin down")
    // The legacy "Review each one" label MUST NOT leak into the
    // zero-state body / buttons.
    expect(spec.body).not.toContain('Review each one')
    for (const opt of spec.options) {
      expect(opt.body).not.toBe('Review each one')
      expect(opt.value).not.toBe(PROJECTS_PROPOSED_REVIEW)
      expect(opt.value).not.toBe(PROJECTS_PROPOSED_CONFIRM)
    }
  })

  test('populated emits single confirm button (Review-each-one button dropped 2026-05-28)', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: ['Topline', 'Northwind', 'Beacon'],
    })
    expect(spec.options).toEqual([
      { label: 'A', body: 'Good to go', value: PROJECTS_PROPOSED_CONFIRM },
    ])
    expect(spec.body).toContain('1. Topline')
    expect(spec.body).toContain('2. Northwind')
    expect(spec.body).toContain('3. Beacon')
    // Freeform path stays open for tweak replies like "drop n8n".
    expect(spec.allow_freeform).toBe(true)
    // Regression: no "Review each one" surface anywhere — body or buttons.
    expect(spec.body).not.toContain('Review each one')
    for (const opt of spec.options) {
      expect(opt.body).not.toBe('Review each one')
      expect(opt.value).not.toBe(PROJECTS_PROPOSED_REVIEW)
    }
  })

  test('awaiting_share_freeform morphs body to freeform-only prompt', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: [],
      awaiting_share_freeform: true,
    })
    expect(spec.options).toEqual([])
    expect(spec.allow_freeform).toBe(true)
    expect(spec.body).toContain("Tell me what you're working on")
  })

  test('rejection reason is stitched onto the zero-state body', () => {
    const spec = buildProjectsProposedPromptSpec({
      primary_projects: [],
      rejection_reason:
        "I couldn't pick out specific projects from that. Try listing one per line, or comma-separated.",
    })
    expect(spec.body.startsWith("I couldn't pick out")).toBe(true)
    // Body still ends with the zero-state framing.
    expect(spec.body).toContain("I didn't pin down")
    expect(spec.options).toHaveLength(2)
    expect(spec.options[0]?.value).toBe(PROJECTS_PROPOSED_SHARE_WORK)
  })
})

describe('splitFreeformProjectList — share-freeform fallback parser', () => {
  test('splits on newlines, strips numeric + bullet markers, dedupes', () => {
    expect(
      splitFreeformProjectList(`1. Topline
2. Northwind
- Beacon
* Studio Sessions
Studio Sessions`),
    ).toEqual(['Topline', 'Northwind', 'Beacon', 'Studio Sessions'])
  })

  test('caps at 10 entries', () => {
    const raw = Array.from({ length: 15 }, (_, i) => `Project ${i}`).join('\n')
    expect(splitFreeformProjectList(raw)).toHaveLength(10)
  })

  test('returns empty for blank or whitespace-only input', () => {
    expect(splitFreeformProjectList('')).toEqual([])
    expect(splitFreeformProjectList('   \n  \n')).toEqual([])
  })

  test('drops over-long entries (>120 chars)', () => {
    const tooLong = 'x'.repeat(150)
    expect(splitFreeformProjectList(`Topline\n${tooLong}\nNorthwind`)).toEqual([
      'Topline',
      'Northwind',
    ])
  })

  test('splits on comma + Capital / digit so the UX hint is honoured (Kieran r1 I2)', () => {
    // Hint promises "one per line, or comma-separated" — the parser
    // must honour both. Original splitter only split on `\n` and `;`,
    // collapsing a comma-separated reply into a single 22-char "project".
    expect(splitFreeformProjectList('Topline, Northwind, Beacon')).toEqual([
      'Topline',
      'Northwind',
      'Beacon',
    ])
    expect(splitFreeformProjectList('Project 1, Project 2')).toEqual([
      'Project 1',
      'Project 2',
    ])
  })

  test('keeps mid-name commas glued ("Topline, inc." stays one project)', () => {
    // The split is comma + whitespace + capital/digit, so the lowercase
    // "inc." after "Topline," does NOT trigger a split — the user gets one
    // entry, not two.
    expect(splitFreeformProjectList('Topline, inc.\nNorthwind')).toEqual([
      'Topline, inc.',
      'Northwind',
    ])
  })
})
