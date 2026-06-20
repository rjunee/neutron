/**
 * 2026-06-18 (owner-dogfood) — the import-FAILURE card: copy + retry-the-scan
 * button. The owner's live `claude-zip` import landed `pass1_all_failed`; the
 * failure card it rendered had (a) an em dash (house-rule violation) and (b) a
 * resume button whose copy ("Resume analysis" / "Picking back up where we left
 * off.") read as a vague conversational continue rather than "retry the scan."
 *
 * These tests pin the fixes:
 *   - FIX 3: the failure body contains NO em dash (two sentences instead).
 *   - FIX 2: the retry button is labelled as a retry-the-scan affordance and
 *     carries the `resume_import` routing value (the engine's
 *     `consumeImportAnalysisPresentedChoice` re-runs the import via
 *     `attemptAutoResumeFromPaused` — it does NOT restart onboarding), AND the
 *     card still allows a freeform skip/continue escape hatch.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildImportAnalysisPresentedPromptSpec,
  IMPORT_RESUME_CHOICE_VALUE,
  IMPORT_RESUME_CHOICE_LABEL,
} from '../phase-prompts.ts'

const EM_DASH = '—'

describe('import-failure card — copy + retry-the-scan button', () => {
  test('FIX 3: the failure body has NO em dash', () => {
    const spec = buildImportAnalysisPresentedPromptSpec({
      user_first_name: 'Ryan',
      import_source: 'claude-zip',
      import_result: null,
      import_failed: true,
      import_partial: false,
      import_months_span: null,
      can_resume_import: true,
    })
    expect(spec.body).not.toContain(EM_DASH)
    // Restructured to two sentences rather than an em-dash aside.
    expect(spec.body).toContain('No big deal')
  })

  test('FIX 2: the retry button is labelled retry-the-scan and routes to re-run (resume_import)', () => {
    const spec = buildImportAnalysisPresentedPromptSpec({
      user_first_name: 'Ryan',
      import_source: 'claude-zip',
      import_result: null,
      import_failed: true,
      import_partial: false,
      import_months_span: null,
      can_resume_import: true,
    })
    const retry = spec.options.find((o) => o.value === IMPORT_RESUME_CHOICE_VALUE)
    expect(retry).toBeDefined()
    // The label reads as retrying the SCAN, not a vague "resume / pick back up".
    expect(IMPORT_RESUME_CHOICE_LABEL.toLowerCase()).toContain('scan')
    expect(retry!.label).toBe(IMPORT_RESUME_CHOICE_LABEL)
    expect(retry!.label.toLowerCase()).not.toContain('resume analysis')
    expect(retry!.body).not.toContain(EM_DASH)
    expect(retry!.body.toLowerCase()).toContain('scan')
    // The routing value is UNCHANGED — the engine re-runs the import job on this
    // value (attemptAutoResumeFromPaused), so the relabel is copy-only.
    expect(retry!.value).toBe('resume_import')
  })

  test('FIX 2: the failure card still allows a freeform skip/continue escape hatch', () => {
    const spec = buildImportAnalysisPresentedPromptSpec({
      user_first_name: 'Ryan',
      import_source: 'claude-zip',
      import_result: null,
      import_failed: true,
      import_partial: false,
      import_months_span: null,
      can_resume_import: true,
    })
    // Typing continues conversationally (work_interview_gap_fill), so the user is
    // never trapped behind the retry button.
    expect(spec.allow_freeform).toBe(true)
    expect(spec.next_phase_on_default).toBe('work_interview_gap_fill')
  })

  test('no retry button when the prior job is not resumable (ZIP gone / not a resumable status)', () => {
    const spec = buildImportAnalysisPresentedPromptSpec({
      user_first_name: 'Ryan',
      import_source: 'claude-zip',
      import_result: null,
      import_failed: true,
      import_partial: false,
      import_months_span: null,
      can_resume_import: false,
    })
    expect(spec.options.find((o) => o.value === IMPORT_RESUME_CHOICE_VALUE)).toBeUndefined()
    // Still conversational — no dead end.
    expect(spec.allow_freeform).toBe(true)
  })
})
