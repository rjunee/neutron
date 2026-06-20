/**
 * Regression — Argus r3 IMPORTANT (2026-06-03,
 * onboarding-buttons-only-tweak-later).
 *
 * `import_upload_pending` is classified `'buttons-only'` (a real "Skip the
 * import" button exists). The phase body USED to instruct the user to type
 * "skip" — but a typed "skip" hits `emitButtonsOnlyNudge` ("Tap one of the
 * buttons above"), NOT the skip handler the button invokes. Copy and code
 * contradicted each other.
 *
 * Fix option A (chosen): drop the "type skip" copy; the button is the sole
 * skip affordance, so copy and code stay in sync with less code to maintain.
 *
 * These tests pin every body the phase can render (static fallback +
 * single-source dynamic chatgpt / claude) to:
 *   (a) NOT instruct typing "skip", and
 *   (b) reference the "Skip the import" button instead, and
 *   (c) still carry the `value:'skip'` button option (the affordance lives).
 */

import { describe, expect, test } from 'bun:test'

import {
  STATIC_PHASE_SPECS,
  buildImportUploadPendingPromptSpec,
} from '../phase-prompts.ts'

/** Matches an instruction to TYPE skip (the removed copy), not the button
 *  label "Skip the import". */
const TYPE_SKIP_RE = /type\s+["“]?skip["”]?/i

function assertNoTypeSkipButHasButton(body: string, options: ReadonlyArray<{ value: string }>): void {
  // (a) no "type skip" instruction anywhere in the body
  expect(TYPE_SKIP_RE.test(body)).toBe(false)
  // (b) the body points at the button instead
  expect(body).toContain('Skip the import')
  // (c) the skip button option survives
  expect(options.some((o) => o.value === 'skip')).toBe(true)
}

describe('import_upload_pending skip copy references the button, not typed "skip"', () => {
  test('static fallback spec', () => {
    const spec = STATIC_PHASE_SPECS['import_upload_pending']
    expect(spec).toBeDefined()
    assertNoTypeSkipButHasButton(spec!.body, spec!.options)
  })

  test('single-source dynamic body (chatgpt)', () => {
    const spec = buildImportUploadPendingPromptSpec({ ai_substrate_used: 'chatgpt' })
    assertNoTypeSkipButHasButton(spec.body, spec.options)
  })

  test('single-source dynamic body (claude)', () => {
    const spec = buildImportUploadPendingPromptSpec({ ai_substrate_used: 'claude' })
    assertNoTypeSkipButHasButton(spec.body, spec.options)
  })
})
