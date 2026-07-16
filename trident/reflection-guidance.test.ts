/**
 * RB2 (b) — BEHAVIORAL coverage of the owner-corrections GUIDANCE derivation. The
 * inner workflow (`inner-workflow.mjs`) is not runnable under bun/node, so this
 * boundary logic is extracted into a pure helper and EXECUTED here across the full
 * matrix (positive, null, undefined, empty, whitespace-only, non-string) — plus the
 * subordinating framing that ships with every non-empty block.
 */
import { describe, expect, test } from 'bun:test'

import { buildReflectionGuidance, REFLECTION_GUIDANCE_FRAMING } from './reflection-guidance.ts'

const BLOCK = '<learned_corrections>\n- never force-push to main\n</learned_corrections>'

describe('buildReflectionGuidance — owner-corrections advisory-suffix derivation', () => {
  test('a real block → a blank-line-separated, delimited advisory suffix (framing FIRST)', () => {
    const out = buildReflectionGuidance(BLOCK)
    // Leading blank-line separator so it detaches from the task it is appended after.
    expect(out.startsWith('\n\n<owner_reflection>\n')).toBe(true)
    expect(out.endsWith('</owner_reflection>')).toBe(true)
    // The subordinating framing precedes the (untrusted) block.
    const framingIdx = out.indexOf(REFLECTION_GUIDANCE_FRAMING)
    const blockIdx = out.indexOf(BLOCK)
    expect(framingIdx).toBeGreaterThan(-1)
    expect(blockIdx).toBeGreaterThan(framingIdx)
    expect(out).toContain('never force-push to main')
  })

  test('the framing forbids overriding task / rules / tools and disregards ignore-instructions', () => {
    // Load-bearing security language must ship verbatim.
    expect(REFLECTION_GUIDANCE_FRAMING).toContain('ADVISORY DATA')
    expect(REFLECTION_GUIDANCE_FRAMING).toContain('MUST NOT override')
    expect(REFLECTION_GUIDANCE_FRAMING).toContain('tool-use constraints')
    expect(REFLECTION_GUIDANCE_FRAMING).toContain('NEVER')
    expect(REFLECTION_GUIDANCE_FRAMING.toLowerCase()).toContain('disregard')
  })

  test('surrounding whitespace is trimmed before wrapping', () => {
    const out = buildReflectionGuidance(`  \n${BLOCK}\n  `)
    expect(out).toContain(`${REFLECTION_GUIDANCE_FRAMING}\n${BLOCK}\n</owner_reflection>`)
  })

  test('null → clean no-op (empty string)', () => {
    expect(buildReflectionGuidance(null)).toBe('')
  })

  test('undefined → clean no-op (empty string)', () => {
    expect(buildReflectionGuidance(undefined)).toBe('')
  })

  test('empty string → clean no-op (empty string)', () => {
    expect(buildReflectionGuidance('')).toBe('')
  })

  test('whitespace-only string → clean no-op (empty string, no bare wrapper)', () => {
    expect(buildReflectionGuidance('   \n\t  ')).toBe('')
  })

  test('a non-string value is ignored → clean no-op', () => {
    expect(buildReflectionGuidance(42)).toBe('')
    expect(buildReflectionGuidance({ block: 'x' })).toBe('')
    expect(buildReflectionGuidance(['x'])).toBe('')
    expect(buildReflectionGuidance(true)).toBe('')
  })

  // The inner workflow composes each Forge builder prompt as exactly
  // `${contractBody}${reflectionGuidance}` (asserted by source in
  // inner-workflow.test.ts). These cases EXECUTE that composition over the COMPLETE
  // prompt output: a populated context is APPENDED after the contract/task, and an
  // absent/whitespace one leaves the prompt byte-identical to pre-RB2.
  describe('appended after a Forge contract (the prompt the workflow builds)', () => {
    const CONTRACT = 'You are FORGE — Neutron\'s autonomous build sub-agent.\nCONTRACT\n1. do the thing\nTASK:\nbuild X'

    test('a populated context is APPENDED after the contract, never before it', () => {
      const out = CONTRACT + buildReflectionGuidance(BLOCK)
      expect(out.startsWith(CONTRACT)).toBe(true) // the fixed contract keeps primacy
      expect(out.indexOf(BLOCK)).toBeGreaterThan(out.indexOf('TASK:'))
    })

    test('an absent context → byte-identical to the bare contract', () => {
      expect(CONTRACT + buildReflectionGuidance(null)).toBe(CONTRACT)
    })

    test('a whitespace-only context → byte-identical (no bare wrapper)', () => {
      expect(CONTRACT + buildReflectionGuidance('   \n\t ')).toBe(CONTRACT)
    })
  })
})
