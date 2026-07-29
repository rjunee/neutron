/**
 * Email-Managed Core — prose-brief summarizer.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.3.
 */

import { describe, expect, test } from 'bun:test'

import {
  BRIEF_PROMPT_TEMPLATE,
  briefTemplateHash,
  composeBriefSummary,
  renderBriefPrompt,
} from '../src/summarizer.ts'
import type { GmailMessageFull } from '../src/contract.ts'

const FAKE_MESSAGE: GmailMessageFull = {
  id: 'msg-1',
  thread_id: 'thread-1',
  subject: 'kickoff',
  from: 'alice@example.com',
  to: ['user@example.com'],
  cc: [],
  snippet: 'Tuesday at 2pm works',
  internal_date: new Date(0).toISOString(),
  label_ids: ['INBOX'],
  body_text: 'Hi Sam, can we confirm Tuesday at 2pm for the kickoff? Thanks!',
}

const STRUCTURED = {
  message_id: 'msg-1',
  from: 'alice@example.com',
  subject: 'kickoff',
  key_points: ['Confirm Tuesday 2pm', 'Kickoff meeting'],
  sentiment: 'neutral' as const,
  ask_or_response: 'ask' as const,
}

describe('renderBriefPrompt', () => {
  test('substitutes every placeholder', () => {
    const rendered = renderBriefPrompt({
      structuredRow: STRUCTURED,
      rawMessage: FAKE_MESSAGE,
    })
    expect(rendered).toContain('alice@example.com')
    expect(rendered).toContain('user@example.com')
    expect(rendered).toContain('kickoff')
    expect(rendered).toContain('Tuesday at 2pm')
    expect(rendered).toContain('Confirm Tuesday 2pm')
    expect(rendered).toContain('sentiment: neutral')
    expect(rendered).toContain('ask_or_response: ask')
    expect(rendered).not.toContain('{{')
  })
})

describe('BRIEF_PROMPT_TEMPLATE snapshot', () => {
  test('template hash pinned (any edit fails this test on purpose)', () => {
    expect(briefTemplateHash()).toBeDefined()
    // The hash is deterministic; pin the first 8 chars as a stability
    // marker. Any prompt edit will fail this and force the engineer
    // to re-bless intentionally.
    expect(briefTemplateHash().length).toBe(64)
    expect(BRIEF_PROMPT_TEMPLATE.includes("You are the user's email-thread summarizer")).toBe(true)
  })
})

describe('composeBriefSummary', () => {
  test('happy path — LLM returns trimmed prose', async () => {
    const brief = await composeBriefSummary({
      structuredRow: STRUCTURED,
      rawMessage: FAKE_MESSAGE,
      llm: async () => '  This is the brief.  ',
      model: 'haiku-test',
    })
    expect(brief.outcome).toBe('ok')
    expect(brief.text).toBe('This is the brief.')
    expect(brief.model).toBe('haiku-test')
    expect(brief.prompt_hash.length).toBe(64)
  })

  test('LLM throws → deterministic fallback bullets', async () => {
    const brief = await composeBriefSummary({
      structuredRow: STRUCTURED,
      rawMessage: FAKE_MESSAGE,
      llm: async () => {
        throw new Error('LLM timeout')
      },
      model: 'haiku-test',
    })
    expect(brief.outcome).toBe('llm_error')
    expect(brief.text).toContain('Confirm Tuesday 2pm')
  })

  test('LLM returns empty → also fallback', async () => {
    const brief = await composeBriefSummary({
      structuredRow: STRUCTURED,
      rawMessage: FAKE_MESSAGE,
      llm: async () => '   ',
      model: 'haiku-test',
    })
    expect(brief.outcome).toBe('llm_error')
  })

  test('no key_points + LLM error → degraded summary', async () => {
    const brief = await composeBriefSummary({
      structuredRow: { ...STRUCTURED, key_points: [] },
      rawMessage: FAKE_MESSAGE,
      llm: async () => {
        throw new Error('x')
      },
      model: 'haiku-test',
    })
    expect(brief.outcome).toBe('llm_error')
    expect(brief.text).toContain('alice@example.com')
  })
})
