/**
 * Cringe-check tests — deliberately-cringey fixture flags ≥ 3.
 */

import { describe, expect, test } from 'bun:test'
import { buildCringeChecker, deterministicCringe, CRINGE_PATTERNS } from '../cringe-check.ts'

describe('deterministicCringe', () => {
  test('flags em-dashes', () => {
    const r = deterministicCringe('This — is — definitely — em-dashy.')
    expect(r.flags).toBeGreaterThanOrEqual(3)
    expect(r.reasons.some((x) => x.includes('em-dash'))).toBe(true)
  })

  test('flags corporate filler', () => {
    const r = deterministicCringe('I love unlocking value with synergistic partners')
    expect(r.flags).toBeGreaterThan(0)
    expect(r.reasons.some((x) => /synergistic|unlock value/.test(x))).toBe(true)
  })

  test('canonical cringey fixture from § 6a flags ≥ 3', () => {
    const fixture = "I just LOVE collaborating with synergistic partners to unlock value"
    const r = deterministicCringe(fixture)
    expect(r.flags).toBeGreaterThanOrEqual(3)
  })

  test('clean text returns 0 flags', () => {
    const r = deterministicCringe('Direct, sparse, structured. No padding.')
    expect(r.flags).toBe(0)
  })
})

describe('buildCringeChecker', () => {
  test('threshold defaults to 3', () => {
    const checker = buildCringeChecker()
    expect(checker.threshold).toBe(3)
  })

  test('augments with optional LLM check', async () => {
    let llmCalled = false
    const checker = buildCringeChecker({
      llmCheck: async () => {
        llmCalled = true
        return { flags: 5, reasons: ['llm detected promotional language'] }
      },
    })
    const r = await checker.check({ file: 'soul', content: 'plain content' })
    expect(llmCalled).toBe(true)
    expect(r.flags).toBe(5)
    expect(r.reasons).toContain('llm detected promotional language')
  })

  test('CRINGE_PATTERNS list is non-empty', () => {
    expect(CRINGE_PATTERNS.length).toBeGreaterThan(10)
  })
})
