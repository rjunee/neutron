import { describe, expect, test } from 'bun:test'

import {
  normalizeProvider,
  selectSubstrateFactory,
  type Provider,
} from './select-substrate.ts'
import { createClaudeCodeSubstrateAuto } from './claude-code/index.ts'
import { createGptResponsesApiSubstrate } from './gpt-5-5-api/index.ts'
import { createCodexCliSubstrate } from './gpt-5-5-codex-cli/index.ts'

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

  test('default-when-absent is anthropic', () => {
    expect(normalizeProvider(undefined)).toBe('anthropic')
    expect(normalizeProvider(null)).toBe('anthropic')
    expect(normalizeProvider('')).toBe('anthropic')
  })

  test('unknown provider degrades to anthropic (never strands on a half-wired backend)', () => {
    expect(normalizeProvider('gemini')).toBe('anthropic')
    expect(normalizeProvider('gpt-9')).toBe('anthropic')
    // And the factory for a normalized-anthropic is still the CC factory verbatim.
    expect(selectSubstrateFactory(normalizeProvider('nonsense')).create).toBe(
      createClaudeCodeSubstrateAuto,
    )
  })

  test('normalizeProvider preserves the two known alternates', () => {
    expect(normalizeProvider('openai')).toBe('openai')
    expect(normalizeProvider('openai-codex-cli')).toBe('openai-codex-cli')
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
