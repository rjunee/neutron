/**
 * RB2 (b) — BEHAVIORAL coverage of the owner-corrections preamble derivation. The
 * inner workflow (`inner-workflow.mjs`) is not runnable under bun/node, so this
 * boundary logic is extracted into a pure helper and EXECUTED here across the full
 * boundary matrix (positive, null, undefined, empty, whitespace-only, non-string),
 * rather than only source-string-matched.
 */
import { describe, expect, test } from 'bun:test'

import { buildReflectionPreamble } from './reflection-preamble.ts'

describe('buildReflectionPreamble — owner-corrections preamble derivation', () => {
  test('a real block → the trimmed block + a blank-line separator', () => {
    const block = '<learned_corrections>\n- never force-push to main\n</learned_corrections>'
    const out = buildReflectionPreamble(block)
    expect(out).toBe(`${block}\n\n`)
    // The separator is present so it sits cleanly ABOVE the agent contract.
    expect(out.endsWith('\n\n')).toBe(true)
    expect(out).toContain('never force-push to main')
  })

  test('surrounding whitespace is trimmed before the separator is appended', () => {
    const out = buildReflectionPreamble('  \n<learned_corrections>\n- x\n</learned_corrections>\n  ')
    expect(out).toBe('<learned_corrections>\n- x\n</learned_corrections>\n\n')
  })

  test('null → clean no-op (empty string)', () => {
    expect(buildReflectionPreamble(null)).toBe('')
  })

  test('undefined → clean no-op (empty string)', () => {
    expect(buildReflectionPreamble(undefined)).toBe('')
  })

  test('empty string → clean no-op (empty string)', () => {
    expect(buildReflectionPreamble('')).toBe('')
  })

  test('whitespace-only string → clean no-op (empty string, no bare separator)', () => {
    expect(buildReflectionPreamble('   \n\t  ')).toBe('')
  })

  test('a non-string value is ignored → clean no-op', () => {
    expect(buildReflectionPreamble(42)).toBe('')
    expect(buildReflectionPreamble({ block: 'x' })).toBe('')
    expect(buildReflectionPreamble(['x'])).toBe('')
    expect(buildReflectionPreamble(true)).toBe('')
  })

  // The inner workflow composes each build/review agent prompt as exactly
  // `${reflectionPreamble}${contractBody}` (asserted by source in
  // inner-workflow.test.ts). These cases EXECUTE that composition contract over the
  // COMPLETE prompt output, so a populated context sits immediately above the
  // contract and an absent/whitespace one leaves the prompt byte-identical to pre-RB2.
  describe('composed above an agent contract (the prompt the workflow prepends onto)', () => {
    const CONTRACT = 'You are FORGE — Neutron\'s autonomous build sub-agent.\nCONTRACT\n1. do the thing'

    test('a populated context sits immediately ABOVE the contract, blank-line separated', () => {
      const block = '<learned_corrections>\n- never force-push to main\n</learned_corrections>'
      expect(buildReflectionPreamble(block) + CONTRACT).toBe(`${block}\n\n${CONTRACT}`)
    })

    test('an absent context → the composed prompt is byte-identical to the bare contract', () => {
      expect(buildReflectionPreamble(null) + CONTRACT).toBe(CONTRACT)
    })

    test('a whitespace-only context → the composed prompt is byte-identical (no bare separator)', () => {
      expect(buildReflectionPreamble('   \n\t ') + CONTRACT).toBe(CONTRACT)
    })
  })
})
