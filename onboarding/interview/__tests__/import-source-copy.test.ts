/**
 * Unit tests — `detectImportSourceMention`, the deterministic (no-LLM)
 * source-token detector moved to the zero-import leaf
 * `../import-source-copy.ts` (K11a3). Split out of
 * `source-switch-late-upload-race.test.ts`, which keeps the
 * integration/engine-driven half of the ISSUES #98 race coverage.
 */

import { describe, expect, test } from 'bun:test'

import { detectImportSourceMention } from '../import-source-copy.ts'

describe('detectImportSourceMention — deterministic source-token detector', () => {
  test.each<[string, 'chatgpt' | 'claude']>([
    ['can I do claude instead?', 'claude'],
    ['switch to claude', 'claude'],
    ['actually let me use anthropic', 'claude'],
    ['can I do chatgpt instead?', 'chatgpt'],
    ['use chat gpt', 'chatgpt'],
    ['openai please', 'chatgpt'],
    ['my gpt export', 'chatgpt'],
    // Argus r2: a leading negation is overridden ONLY by a CLAUSE BOUNDARY
    // (comma / but / actually) followed by a keep/switch verb — a clear
    // "keep the current one" clause. The user IS affirming the source.
    ['no, keep chatgpt', 'chatgpt'],
    ['no, keep claude', 'claude'],
    ['no, switch to claude', 'claude'],
    ['not chatgpt, actually keep claude', 'claude'],
    // Argus r3 + Codex: scan ALL occurrences of a source, not just the first.
    // The first `claude` is negated ("dont have the claude export yet") but the
    // second is affirmed ("switch to claude") → the source is mentioned. A
    // first-match-only detector returned null here and auto-honored a late
    // chatgpt upload, re-opening the #98 dead-end.
    [
      'I dont have the claude export yet, but switch to claude',
      'claude',
    ],
  ])('%p → %p', (text, expected) => {
    expect(detectImportSourceMention(text)).toBe(expected)
  })

  test.each([
    'is it done?',
    'how long does this take',
    'go back',
    'wrong one',
    'hmm',
    'ok',
    // ambiguous — names BOTH sources
    'claude or chatgpt, which is better?',
    // Argus r1b IMPORTANT: a NEGATED source mention is not a switch target —
    // "I don't have a GPT export" must NOT record a chatgpt switch-intent.
    "I don't have a GPT export",
    'no claude export here',
    "haven't got a chatgpt export",
    // Argus r2 BLOCKER: a negation + a DIRECT-OBJECT verb is a DECLINE of the
    // named source, not an affirmation — these must stay negated → null so the
    // decline never records a bogus switch-intent that refuses the user's own
    // legitimate upload of the staged source (the #98 dead-end).
    'I dont want claude',
    "I don't want claude",
    'dont use claude',
    'dont use gpt',
    'never use chatgpt',
    'I dont want chatgpt',
    // A bare affirm verb with NO clause boundary stays a continuation of the
    // negation — "don't keep claude" declines claude.
    'dont keep claude',
  ])('%p → null (no unambiguous switch target)', (text) => {
    expect(detectImportSourceMention(text)).toBeNull()
  })
})
