import { describe, expect, test } from 'bun:test'
import { BUILT_HEAD_READ_ATTEMPTS, createBuiltHeadGate, type BuiltHeadDependencies } from './built-head.ts'

const H = 'c'.repeat(40)

function fixture(replies: Array<unknown>): { deps: BuiltHeadDependencies; labels: string[]; logs: string[]; prompts: string[] } {
  const labels: string[] = []
  const logs: string[] = []
  const prompts: string[] = []
  const deps: BuiltHeadDependencies = {
    forgeBranch: 'trident/built-head',
    repoPath: '/repo',
    shSingleQuote: (value) => `'${value}'`,
    seatAttempt: async (label, operation) => {
      labels.push(label)
      return operation()
    },
    agent: async (prompt) => {
      prompts.push(prompt)
      return replies.shift() ?? null
    },
    withModel: (options) => options,
    normalizeOid: (value) => /^[0-9a-f]{40}$/.test(String(value)) ? String(value) : '',
    log: (message) => logs.push(message),
    branchHeadSchema: { type: 'object' },
  }
  return { deps, labels, logs, prompts }
}

describe('readBuiltHead', () => {
  test('returns a normalized full head on the first readable reply', async () => {
    const f = fixture([{ head: H.toUpperCase() }])
    expect(await createBuiltHeadGate(f.deps)('r1')).toBe(H)
    expect(f.labels).toEqual(['head-probe-round-built-r1'])
    expect(f.prompts[0]).toContain("refs/heads/trident/built-head^{commit}")
  })

  test('preserves the confirmed absent outcome without retrying', async () => {
    const f = fixture([{ head: ' absent ' }])
    expect(await createBuiltHeadGate(f.deps)('r2')).toBe('absent')
    expect(f.labels).toHaveLength(1)
  })

  test('spends the complete bounded retry budget before returning unreadable', async () => {
    const f = fixture(Array.from({ length: BUILT_HEAD_READ_ATTEMPTS }, () => ({ head: '' })))
    expect(await createBuiltHeadGate(f.deps)('r3')).toBe('')
    expect(f.labels).toHaveLength(BUILT_HEAD_READ_ATTEMPTS)
    expect(f.logs).toHaveLength(BUILT_HEAD_READ_ATTEMPTS)
  })

  test('a dead seat is logged distinctly and a later readable reply wins', async () => {
    const f = fixture([null, { head: H }])
    expect(await createBuiltHeadGate(f.deps)('r4')).toBe(H)
    expect(f.logs[0]).toContain('seat died')
  })
})
