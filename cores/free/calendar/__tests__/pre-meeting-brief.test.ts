/**
 * Calendar Core S1 — pre-meeting-brief composer tests.
 *
 * Snapshot the locked prompt template, exercise the deterministic
 * `llm_error` fallback, and verify prompt-hash + model metadata land
 * on every emission.
 */

import { describe, expect, test } from 'bun:test'

import {
  PRE_MEETING_BRIEF_PROMPT_TEMPLATE,
  composePreMeetingBrief,
  renderBriefPrompt,
} from '../src/pre-meeting-brief.ts'

const BRIEF_ROW = {
  event_id: 'evt-1',
  title: 'Northwind A/B kickoff',
  start: '2026-05-21T17:00:00Z',
  end: '2026-05-21T17:30:00Z',
  duration_minutes: 30,
  attendees: ['user@example.com', 'casey@example.com'],
  agenda: ['Recap Q1', 'Pricing reset', 'Test plan'],
  prior_context: [],
}

describe('pre-meeting-brief prompt template', () => {
  test('locked template contains the three required prompt sections', () => {
    expect(PRE_MEETING_BRIEF_PROMPT_TEMPLATE).toContain('{{lead_minutes}}')
    expect(PRE_MEETING_BRIEF_PROMPT_TEMPLATE).toContain('{{title}}')
    expect(PRE_MEETING_BRIEF_PROMPT_TEMPLATE).toContain('{{attendee_bullets}}')
    expect(PRE_MEETING_BRIEF_PROMPT_TEMPLATE).toContain(
      '{{prior_context_bullets_or_none}}',
    )
  })

  test('renderBriefPrompt substitutes every placeholder', () => {
    const out = renderBriefPrompt({
      briefRow: BRIEF_ROW,
      priorContext: ['Closed PR #123 with Casey last week'],
      userTz: 'America/Los_Angeles',
      leadMinutes: 10,
    })
    expect(out).not.toContain('{{')
    expect(out).toContain('Northwind A/B kickoff')
    expect(out).toContain('user@example.com')
    expect(out).toContain('casey@example.com')
    expect(out).toContain('Closed PR #123 with Casey last week')
    expect(out).toContain('Pricing reset')
  })

  test('renderBriefPrompt falls back to "no agenda items" when agenda is empty', () => {
    const out = renderBriefPrompt({
      briefRow: { ...BRIEF_ROW, agenda: [] },
      priorContext: [],
      userTz: 'America/Los_Angeles',
    })
    expect(out).toContain('no agenda items')
  })
})

describe('composePreMeetingBrief', () => {
  test('returns LLM text + prompt_hash on success', async () => {
    const brief = await composePreMeetingBrief({
      briefRow: BRIEF_ROW,
      priorContext: [],
      userTz: 'America/Los_Angeles',
      modelId: 'claude-haiku-test',
      llm: async (prompt) => {
        expect(prompt).toContain('Northwind A/B kickoff')
        return 'This is the brief. It is short.'
      },
    })
    expect(brief.outcome).toBe('ok')
    expect(brief.text).toBe('This is the brief. It is short.')
    expect(brief.model).toBe('claude-haiku-test')
    expect(brief.prompt_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('LLM throw triggers deterministic fallback with outcome=llm_error', async () => {
    const brief = await composePreMeetingBrief({
      briefRow: BRIEF_ROW,
      priorContext: ['Some prior bullet'],
      userTz: 'America/Los_Angeles',
      modelId: 'claude-haiku-test',
      llm: async () => {
        throw new Error('429')
      },
    })
    expect(brief.outcome).toBe('llm_error')
    expect(brief.text).toContain('Northwind A/B kickoff')
    expect(brief.text).toContain('30 min')
    expect(brief.text).toContain('Recap Q1')
    expect(brief.model).toBe('claude-haiku-test')
  })

  test('same input produces the same prompt_hash (deterministic)', async () => {
    const stub = async (): Promise<string> => 'x'
    const a = await composePreMeetingBrief({
      briefRow: BRIEF_ROW,
      priorContext: [],
      userTz: 'America/Los_Angeles',
      modelId: 'm',
      llm: stub,
    })
    const b = await composePreMeetingBrief({
      briefRow: BRIEF_ROW,
      priorContext: [],
      userTz: 'America/Los_Angeles',
      modelId: 'm',
      llm: stub,
    })
    expect(a.prompt_hash).toBe(b.prompt_hash)
  })
})
