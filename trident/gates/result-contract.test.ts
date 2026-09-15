import { describe, expect, test } from 'bun:test'
import { validateTrailer } from './result-contract.ts'

const finding = { severity: 'major', title: 'broken', evidence: 'x.ts:1', file: 'x.ts', symbol: 'x', rule: 'correctness', line: 1 }

describe('validateTrailer', () => {
  test('accepts each result vocabulary', () => {
    expect(validateTrailer('verdict', { verdict: 'APPROVE', findings: [finding] }).ok).toBe(true)
    expect(validateTrailer('forge', { worktreePath: '/work', branch: 'change', commitSha: 'abc', prNumber: null, diffFile: '/tmp/diff', testsPassed: true, mutationClaim: null }).ok).toBe(true)
    expect(validateTrailer('plan', { implementationPlan: 'plan', topTask: 'task', executionSpec: 'spec', complexity: 'mechanical', remainingTasks: 0 }).ok).toBe(true)
  })

  test('rejects malformed input with a typed reason instead of throwing', () => {
    expect(validateTrailer('verdict', null)).toEqual({ ok: false, reason: 'not-object', path: '$' })
    expect(validateTrailer('verdict', { findings: [] })).toEqual({ ok: false, reason: 'missing-field', path: '$.verdict' })
    expect(validateTrailer('verdict', { verdict: 'YES', findings: [] })).toEqual({ ok: false, reason: 'invalid-enum', path: '$.verdict' })
    expect(validateTrailer('plan', { implementationPlan: 'p', topTask: 't', executionSpec: 's', complexity: 'mechanical', remainingTasks: 0, extra: true })).toEqual({ ok: false, reason: 'unexpected-field', path: '$.extra' })
  })

  test('validates nested findings and mutation claims', () => {
    const badFinding = validateTrailer('verdict', { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, line: '1' }] })
    expect(badFinding).toEqual({ ok: false, reason: 'wrong-type', path: '$.findings[0].line' })
    const badClaim = validateTrailer('forge', { worktreePath: '/work', branch: 'change', commitSha: 'abc', prNumber: null, diffFile: '/tmp/diff', testsPassed: true, mutationClaim: {} })
    expect(badClaim).toEqual({ ok: false, reason: 'missing-field', path: '$.mutationClaim.file' })
  })
})
