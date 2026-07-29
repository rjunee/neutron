import { describe, expect, test } from 'bun:test'

import {
  normalizeProvider,
  selectSubstrateFactory,
  type Provider,
} from './select-substrate.ts'
import { createClaudeCodeSubstrateAuto } from './claude-code/index.ts'
import { createGptResponsesApiSubstrate } from './openai-responses/index.ts'
import { createCodexCliSubstrate } from './codex-cli/index.ts'

describe('select-substrate', () => {
  test("select('anthropic') returns the Claude Code factory VERBATIM (default backend, unchanged)", () => {
    const sel = selectSubstrateFactory('anthropic')
    expect(sel.provider).toBe('anthropic')
    // Byte-identical guarantee: the anthropic path resolves the SAME factory
    // reference every production construction site hardcodes today.
    expect(sel.create).toBe(createClaudeCodeSubstrateAuto)
  })

  test("select('openai') returns the GPT Responses API factory verbatim", () => {
    const sel = selectSubstrateFactory('openai')
    expect(sel.provider).toBe('openai')
    expect(sel.create).toBe(createGptResponsesApiSubstrate)
  })

  test("select('openai-codex-cli') returns the Codex CLI factory verbatim", () => {
    const sel = selectSubstrateFactory('openai-codex-cli')
    expect(sel.provider).toBe('openai-codex-cli')
    expect(sel.create).toBe(createCodexCliSubstrate)
  })

  test('default-when-absent/empty/whitespace is anthropic (byte-identical Claude case)', () => {
    expect(normalizeProvider(undefined)).toBe('anthropic')
    expect(normalizeProvider(null)).toBe('anthropic')
    expect(normalizeProvider('')).toBe('anthropic')
    expect(normalizeProvider('   ')).toBe('anthropic')
    expect(normalizeProvider('anthropic')).toBe('anthropic')
  })

  test('UNKNOWN non-empty provider THROWS a loud actionable error (never coerced to anthropic)', () => {
    // Root-cause fix: a typo must fail loud, not silently route data to Claude.
    expect(() => normalizeProvider('openaii')).toThrow(/Unknown model provider 'openaii'/)
    expect(() => normalizeProvider('gemini')).toThrow(/Valid values:/)
    expect(() => normalizeProvider('gpt-9')).toThrow(/Refusing to coerce/)
    // The error names the valid providers.
    expect(() => normalizeProvider('nonsense')).toThrow(/'anthropic'.*'openai'.*'openai-codex-cli'/)
  })

  test('normalizeProvider preserves the two known alternates (and trims)', () => {
    expect(normalizeProvider('openai')).toBe('openai')
    expect(normalizeProvider('openai-codex-cli')).toBe('openai-codex-cli')
    expect(normalizeProvider('  openai  ')).toBe('openai')
  })

  test('every Provider variant maps to a discriminated factory', () => {
    const providers: Provider[] = ['anthropic', 'openai', 'openai-codex-cli']
    for (const p of providers) {
      const sel = selectSubstrateFactory(p)
      expect(sel.provider).toBe(p)
      expect(typeof sel.create).toBe('function')
    }
  })
})
