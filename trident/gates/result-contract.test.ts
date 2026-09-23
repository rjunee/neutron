import { describe, expect, test } from 'bun:test'
import { BRANCH_BRIEF_MAX_BYTES, clampPlanBranchBrief, validateTrailer } from './result-contract.ts'

const finding = { severity: 'major', title: 'broken', evidence: 'x.ts:1', file: 'x.ts', symbol: 'x', rule: 'correctness', line: 1 }
const plan = { strategy: 'single', rationale: 'One builder can complete the accepted plan.',
  implementationPlan: 'plan', topTask: 'task', executionSpec: 'spec', complexity: 'mechanical', remainingTasks: 0 } as const

describe('validateTrailer', () => {
  test('accepts each result vocabulary', () => {
    expect(validateTrailer('verdict', { verdict: 'APPROVE', findings: [finding] }).ok).toBe(true)
    expect(validateTrailer('forge', { worktreePath: '/work', branch: 'change', commitSha: 'abc', prNumber: null, diffFile: '/tmp/diff', testsPassed: true, mutationClaim: null }).ok).toBe(true)
    expect(validateTrailer('plan', plan).ok).toBe(true)
  })

  test('rejects malformed input with a typed reason instead of throwing', () => {
    expect(validateTrailer('verdict', null)).toEqual({ ok: false, reason: 'not-object', path: '$' })
    expect(validateTrailer('verdict', { findings: [] })).toEqual({ ok: false, reason: 'missing-field', path: '$.verdict' })
    expect(validateTrailer('verdict', { verdict: 'YES', findings: [] })).toEqual({ ok: false, reason: 'invalid-enum', path: '$.verdict' })
    expect(validateTrailer('plan', { ...plan, extra: true })).toEqual({ ok: false, reason: 'unexpected-field', path: '$.extra' })
  })

  test('validates nested findings and mutation claims', () => {
    const badFinding = validateTrailer('verdict', { verdict: 'REQUEST_CHANGES', findings: [{ ...finding, line: '1' }] })
    expect(badFinding).toEqual({ ok: false, reason: 'wrong-type', path: '$.findings[0].line' })
    const badClaim = validateTrailer('forge', { worktreePath: '/work', branch: 'change', commitSha: 'abc', prNumber: null, diffFile: '/tmp/diff', testsPassed: true, mutationClaim: {} })
    expect(badClaim).toEqual({ ok: false, reason: 'missing-field', path: '$.mutationClaim.file' })
  })

  test('G030 byte-caps a multi-byte branch brief without splitting its code point', () => {
    const brief = `${'a'.repeat(BRANCH_BRIEF_MAX_BYTES - 3)}😀`
    expect(brief.length).toBeLessThanOrEqual(BRANCH_BRIEF_MAX_BYTES)
    expect(Buffer.byteLength(brief, 'utf8')).toBeGreaterThan(BRANCH_BRIEF_MAX_BYTES)

    const capped = clampPlanBranchBrief({ branchBrief: brief }) as { branchBrief: string }
    const marker = `\n[branch-state brief truncated at ${BRANCH_BRIEF_MAX_BYTES} bytes]`
    expect(Buffer.byteLength(capped.branchBrief, 'utf8')).toBe(BRANCH_BRIEF_MAX_BYTES)
    expect(capped.branchBrief).toBe(`${'a'.repeat(BRANCH_BRIEF_MAX_BYTES - Buffer.byteLength(marker, 'utf8'))}${marker}`)
    expect(capped.branchBrief).not.toMatch(/[\uD800-\uDFFF]/)
  })
})
