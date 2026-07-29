import { describe, expect, test } from 'bun:test'

import { resolveOpenAiAuth } from './auth.ts'

describe('openai-responses auth', () => {
  test('explicit api_key wins over env', () => {
    const out = resolveOpenAiAuth({ api_key: 'sk-explicit', env: { OPENAI_API_KEY: 'sk-env' } })
    expect(out.headers['authorization']).toBe('Bearer sk-explicit')
  })

  test('env OPENAI_API_KEY is used when no explicit key', () => {
    const out = resolveOpenAiAuth({ env: { OPENAI_API_KEY: 'sk-env' } })
    expect(out.headers['authorization']).toBe('Bearer sk-env')
  })

  test('throws with subscription-OAuth-not-supported note when neither resolves', () => {
    expect(() => resolveOpenAiAuth({ env: {} })).toThrow(/Subscription OAuth is NOT supported/)
  })
})
