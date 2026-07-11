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
})
