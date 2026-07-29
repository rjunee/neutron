import { describe, expect, test } from 'bun:test'

import {
  OPENAI_BEST_MODEL,
  OPENAI_FALLBACK_MODEL,
  getOpenAiModelPreference,
} from './models-openai.ts'

describe('models-openai registry', () => {
  test('best model defaults to gpt-5.6', () => {
    // Guards against an env override leaking into CI; the default is gpt-5.6.
    expect(OPENAI_BEST_MODEL).toBe(process.env['NEUTRON_OPENAI_BEST_MODEL'] ?? 'gpt-5.6')
  })

  test('default preference is best-then-fallback', () => {
    expect(getOpenAiModelPreference()).toEqual([OPENAI_BEST_MODEL, OPENAI_FALLBACK_MODEL])
  })

  test('getOpenAiModelPreference returns a FRESH array (no shared mutable default)', () => {
    const a = getOpenAiModelPreference()
    const b = getOpenAiModelPreference()
    expect(a).not.toBe(b)
    a.push('mutated')
    expect(getOpenAiModelPreference()).toEqual([OPENAI_BEST_MODEL, OPENAI_FALLBACK_MODEL])
  })

  // OPERATOR-CORRECTABLE overrides (audit round 10) — resolved dynamically from env.
  const P = (e: Record<string, string>): string[] =>
    getOpenAiModelPreference(e as unknown as NodeJS.ProcessEnv)

  test('empty env → the requested gpt-5.6 / gpt-5.5 defaults (unchanged)', () => {
    expect(P({})).toEqual(['gpt-5.6', 'gpt-5.5'])
  })

  test('NEUTRON_OPENAI_MODEL overrides ONLY the primary (fallback stays gpt-5.5)', () => {
    expect(P({ NEUTRON_OPENAI_MODEL: 'gpt-5.6-ga' })).toEqual(['gpt-5.6-ga', 'gpt-5.5'])
  })

  test('NEUTRON_OPENAI_FALLBACK_MODEL overrides only the fallback', () => {
    expect(P({ NEUTRON_OPENAI_FALLBACK_MODEL: 'gpt-5.5-ga' })).toEqual(['gpt-5.6', 'gpt-5.5-ga'])
  })

  test('NEUTRON_OPENAI_MODEL_PREFERENCE (comma list) REPLACES the whole preference, trims + drops blanks', () => {
    expect(P({ NEUTRON_OPENAI_MODEL_PREFERENCE: 'a, b ,, c ' })).toEqual(['a', 'b', 'c'])
    // The full-list override wins over the single-primary override.
    expect(
      P({ NEUTRON_OPENAI_MODEL: 'ignored', NEUTRON_OPENAI_MODEL_PREFERENCE: 'x,y' }),
    ).toEqual(['x', 'y'])
  })

  test('a blank/whitespace comma-list falls back to the default (not an empty preference)', () => {
    expect(P({ NEUTRON_OPENAI_MODEL_PREFERENCE: '  ' })).toEqual(['gpt-5.6', 'gpt-5.5'])
  })
})
