import { describe, expect, test } from 'bun:test'
import { summarizeUsageCoverage } from './summarize.ts'

const rec = (attemptId: string, outcome: string, tokens: unknown): Record<string, unknown> => ({ attemptId, outcome, tokens })

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('summarizeUsageCoverage folds the selected metric', () => {
  test('sums successful and failed attempts together; failed spend is not dropped', () => {
    expect(summarizeUsageCoverage([rec('a', 'completed', 7), rec('b', 'failed', 5)]))
      .toEqual({ knownTokens: 12, unknownAttempts: 0, complete: true })
  })

  test('a measured zero is known, stays zero and keeps coverage complete', () => {
    expect(summarizeUsageCoverage([rec('zero', 'completed', 0)]))
      .toEqual({ knownTokens: 0, unknownAttempts: 0, complete: true })
  })

  test('a measured zero on a failed attempt is also known', () => {
    expect(summarizeUsageCoverage([rec('zero', 'failed', 0)]))
      .toEqual({ knownTokens: 0, unknownAttempts: 0, complete: true })
  })

  test('null is one unknown attempt, never inferred as zero', () => {
    expect(summarizeUsageCoverage([rec('unknown', 'completed', null)]))
      .toEqual({ knownTokens: 0, unknownAttempts: 1, complete: false })
  })

  test('mixed known and unknown counts', () => {
    expect(summarizeUsageCoverage([
      rec('a', 'completed', 7), rec('b', 'completed', null), rec('c', 'failed', 0), rec('d', 'failed', null), rec('e', 'failed', 23),
    ])).toEqual({ knownTokens: 30, unknownAttempts: 2, complete: false })
  })

  test('the empty array is complete with nothing known', () => {
    expect(summarizeUsageCoverage([])).toEqual({ knownTokens: 0, unknownAttempts: 0, complete: true })
  })

  test('extra record properties are ignored', () => {
    expect(summarizeUsageCoverage([{ ...rec('a', 'completed', 4), cost: 99, cacheTokens: 1000, note: 'x' }]))
      .toEqual({ knownTokens: 4, unknownAttempts: 0, complete: true })
  })

  test('the maximum safe total is accepted', () => {
    expect(summarizeUsageCoverage([rec('a', 'completed', Number.MAX_SAFE_INTEGER), rec('b', 'failed', 0)]))
      .toEqual({ knownTokens: Number.MAX_SAFE_INTEGER, unknownAttempts: 0, complete: true })
  })
})

describe('summarizeUsageCoverage rejects invalid input', () => {
  test.each([
    ['an object', { attemptId: 'a', outcome: 'completed', tokens: 1 }],
    ['a string', '[]'],
    ['null', null],
    ['undefined', undefined],
  ] as const)('non-array input: %s', (_label, input) => {
    expect(() => summarizeUsageCoverage(input)).toThrow(TypeError)
  })

  const invalidRecords: ReadonlyArray<readonly [string, unknown]> = [
    ['element null', null],
    ['element array', ['a', 'completed', 1]],
    ['element string', 'a'],
    ['element number', 7],
    ['missing attemptId', { outcome: 'completed', tokens: 1 }],
    ['missing outcome', { attemptId: 'a', tokens: 1 }],
    ['missing tokens', { attemptId: 'a', outcome: 'completed' }],
    ['attemptId empty', rec('', 'completed', 1)],
    ['attemptId leading whitespace', rec(' a', 'completed', 1)],
    ['attemptId trailing whitespace', rec('a ', 'completed', 1)],
    ['attemptId whitespace only', rec('   ', 'completed', 1)],
    ['attemptId non-string', { attemptId: 7, outcome: 'completed', tokens: 1 }],
    ['outcome blocked', rec('a', 'blocked', 1)],
    ['outcome wrong case', rec('a', 'COMPLETED', 1)],
    ['outcome null', { attemptId: 'a', outcome: null, tokens: 1 }],
    ['tokens negative', rec('a', 'completed', -1)],
    ['tokens fractional', rec('a', 'completed', 1.5)],
    ['tokens NaN', rec('a', 'completed', Number.NaN)],
    ['tokens Infinity', rec('a', 'completed', Number.POSITIVE_INFINITY)],
    ['tokens string', rec('a', 'completed', '7')],
    ['tokens boolean', rec('a', 'completed', true)],
    ['tokens undefined', rec('a', 'completed', undefined)],
    ['tokens unsafe', rec('a', 'completed', Number.MAX_SAFE_INTEGER + 1)],
  ]
  test.each(invalidRecords)('malformed record: %s', (_label, record) => {
    expect(() => summarizeUsageCoverage([rec('valid', 'completed', 1), record])).toThrow(TypeError)
  })

  test('duplicate identity by exact string equality is rejected', () => {
    expect(() => summarizeUsageCoverage([rec('a', 'completed', 1), rec('a', 'failed', 2)])).toThrow(TypeError)
    expect(() => summarizeUsageCoverage([rec('a', 'completed', null), rec('a', 'completed', null)])).toThrow(/duplicates record 0/)
  })

  test('identities differing only by whitespace are distinct strings but the padded one is rejected for whitespace', () => {
    expect(summarizeUsageCoverage([rec('a', 'completed', 1), rec('A', 'completed', 2)]))
      .toEqual({ knownTokens: 3, unknownAttempts: 0, complete: true })
    expect(() => summarizeUsageCoverage([rec('a', 'completed', 1), rec('a ', 'completed', 2)])).toThrow(/whitespace/)
  })

  test('an unsafe summed total is rejected', () => {
    expect(() => summarizeUsageCoverage([rec('a', 'completed', Number.MAX_SAFE_INTEGER), rec('b', 'failed', 1)])).toThrow(RangeError)
  })

  test('diagnostics name the index and rule, never record values', () => {
    const sentinel = 'SENTINEL-DO-NOT-ECHO'
    const cases: unknown[][] = [
      [rec(sentinel, 'completed', 1), rec(sentinel, 'completed', 1)],
      [rec(sentinel, sentinel, 1)],
      [rec(sentinel, 'completed', sentinel)],
      [rec(`${sentinel} `, 'completed', 1)],
    ]
    for (const input of cases) {
      let message = ''
      try { summarizeUsageCoverage(input) } catch (error) { message = (error as Error).message }
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain(sentinel)
      expect(message).toMatch(/^record \d+: /)
    }
  })
})

describe('summarizeUsageCoverage never mutates its input', () => {
  test('a frozen valid input is read only and unchanged', () => {
    const input = deepFreeze([rec('b', 'failed', 5), rec('a', 'completed', null), { ...rec('c', 'completed', 0), extra: [1, 2] }])
    const before = JSON.stringify(input)
    expect(summarizeUsageCoverage(input)).toEqual({ knownTokens: 5, unknownAttempts: 1, complete: false })
    expect(JSON.stringify(input)).toBe(before)
    expect(input[0]!['attemptId']).toBe('b')
  })

  test('a frozen invalid input is left untouched on the error path', () => {
    const input = deepFreeze([rec('a', 'completed', 1), rec('a', 'completed', -1)])
    const before = JSON.stringify(input)
    expect(() => summarizeUsageCoverage(input)).toThrow(TypeError)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('a fresh summary object is returned per call', () => {
    const input = [rec('a', 'completed', 1)]
    const first = summarizeUsageCoverage(input)
    const second = summarizeUsageCoverage(input)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})
