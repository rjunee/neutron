/**
 * Open import-analysis render-gap regression (2026-06-29).
 *
 * THE BUG (Ryan, dogfooding a real self-host install): a ChatGPT/Claude history
 * import COMPLETED successfully — the engine reached `import_analysis_presented`
 * having read 175 conversations and proposed 8 projects — but the rich analysis
 * "wow moment" ("Based on N conversations, here are your projects: …") NEVER
 * rendered in the React web chat. Only small onboarding replies showed up.
 *
 * ROOT CAUSE: the Open app-ws button-prompt router (`open/composer.ts`) keyed on
 * `phase === 'import_analysis_presented'` and `return`ed BEFORE emitting — to
 * suppress the redundant accept button — but that dropped the ENTIRE prompt,
 * body included. The import-completion watcher then advanced the phase emitting
 * only a `projects_changed` data frame (sidebar, not chat). So nothing ever
 * delivered the analysis text to the owner's chat.
 *
 * THE FIX: `resolveOpenImportPromptEmission` still strips the dangling
 * accept/resume button (a tap would dangle in Open mode, and the watcher
 * auto-advances) but DELIVERS the analysis BODY as a plain agent_message. These
 * tests pin that contract: the success-analysis prompt is emitted (not dropped),
 * its body survives, and its options are stripped; failure/other prompts pass
 * through untouched.
 */

import { describe, expect, test } from 'bun:test'

import type { ButtonPrompt } from '../../channels/button-primitive.ts'
import {
  resolveImportRunningStatusDelivery,
  resolveOpenImportPromptEmission,
} from '../composer.ts'

const analysisPrompt: ButtonPrompt = {
  prompt_id: 'p-analysis',
  body: 'Based on 175 conversations from your ChatGPT export, here are your 8 projects:\n• Neutron\n• Vajra',
  options: [{ label: 'A', body: 'Looks good', value: 'accept' }],
  allow_freeform: true,
  kind: 'buttons',
}

describe('resolveOpenImportPromptEmission (Open import-analysis render gap)', () => {
  test('successful import_analysis_presented: delivers the body, strips the dangling button', () => {
    const out = resolveOpenImportPromptEmission(analysisPrompt, 'import_analysis_presented', false)
    // The rich analysis body MUST survive (this is the wow moment the owner sees).
    expect(out.body).toBe(analysisPrompt.body)
    expect(out.body).toContain('175 conversations')
    expect(out.body).toContain('8 projects')
    // The redundant accept/resume button is stripped (a tap dangles in Open).
    expect(out.options).toEqual([])
    // Freeform reply stays allowed so the user can confirm ("looks good").
    expect(out.allow_freeform).toBe(true)
    // prompt_id preserved (the caller still acks against it).
    expect(out.prompt_id).toBe('p-analysis')
  })

  test('FAILED import analysis is emitted UNCHANGED (the user needs its retry buttons)', () => {
    const failPrompt: ButtonPrompt = {
      prompt_id: 'p-fail',
      body: "I couldn't read that export — want to try again?",
      options: [
        { label: 'A', body: 'Retry', value: 'retry' },
        { label: 'B', body: 'Skip', value: 'skip' },
      ],
      allow_freeform: true,
    }
    const out = resolveOpenImportPromptEmission(failPrompt, 'import_analysis_presented', true)
    expect(out).toBe(failPrompt)
    expect(out.options).toHaveLength(2)
  })

  test('non-analysis prompts (rate-limit / resume / other phases) pass through untouched', () => {
    const other: ButtonPrompt = {
      prompt_id: 'p-other',
      body: 'Claude rate limit — auto-resuming shortly.',
      options: [{ label: 'A', body: 'OK', value: 'ok' }],
      allow_freeform: false,
    }
    expect(resolveOpenImportPromptEmission(other, 'import_running', false)).toBe(other)
    expect(resolveOpenImportPromptEmission(other, null, false)).toBe(other)
  })
})

describe('resolveImportRunningStatusDelivery (import_running status-bubble ordering, M1 2026-06-30)', () => {
  test('the FIRST plain status bubble is persisted DURABLY (chronological seq, not tail-pinned)', () => {
    expect(
      resolveImportRunningStatusDelivery({
        phase: 'import_running',
        sub_step: 'status',
        attempt_count: 1,
        option_count: 0,
      }),
    ).toBe('durable')
  })

  test('the cron RE-EMITS (attempt_count > 1) are SUPPRESSED — no stacked duplicate bubbles', () => {
    for (const attempt_count of [2, 3, 17]) {
      expect(
        resolveImportRunningStatusDelivery({
          phase: 'import_running',
          sub_step: 'status',
          attempt_count,
          option_count: 0,
        }),
      ).toBe('suppress')
    }
  })

  test('a missing/garbage attempt_count is treated as the first (durable, not dropped)', () => {
    for (const attempt_count of [undefined, null, NaN, 'x']) {
      expect(
        resolveImportRunningStatusDelivery({
          phase: 'import_running',
          sub_step: 'status',
          attempt_count,
          option_count: 0,
        }),
      ).toBe('durable')
    }
  })

  test('a status bubble that carries a button is left ephemeral (only buttonless progress is persisted)', () => {
    expect(
      resolveImportRunningStatusDelivery({
        phase: 'import_running',
        sub_step: 'status',
        attempt_count: 1,
        option_count: 2,
      }),
    ).toBe('ephemeral')
  })

  test('non-status sub_steps (rate_limit_paused / failure) and other phases stay ephemeral', () => {
    expect(
      resolveImportRunningStatusDelivery({
        phase: 'import_running',
        sub_step: 'rate_limit_paused',
        attempt_count: 1,
        option_count: 0,
      }),
    ).toBe('ephemeral')
    expect(
      resolveImportRunningStatusDelivery({
        phase: 'import_analysis_presented',
        sub_step: 'status',
        attempt_count: 1,
        option_count: 0,
      }),
    ).toBe('ephemeral')
    expect(
      resolveImportRunningStatusDelivery({
        phase: null,
        sub_step: undefined,
        attempt_count: 1,
        option_count: 0,
      }),
    ).toBe('ephemeral')
  })
})
