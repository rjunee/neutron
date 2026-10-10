import { describe, expect, test } from 'bun:test'
import { checkChildOverlap } from './check.ts'

const rec = (childId: unknown, acceptedAt: unknown, finishedAt: unknown, inputTokens: unknown): Record<string, unknown> =>
  ({ childId, acceptedAt, finishedAt, inputTokens })

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('checkChildOverlap decides strict interval overlap', () => {
  test('partially overlapping intervals overlap for the intersection length', () => {
    expect(checkChildOverlap([rec('a', 10, 50, 7), rec('b', 30, 90, 5)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 12, unknownChildren: 0, complete: true })
  })

  test('record order does not change the decision', () => {
    expect(checkChildOverlap([rec('b', 30, 90, 5), rec('a', 10, 50, 7)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 12, unknownChildren: 0, complete: true })
  })

  test('a later-accepted child that finishes first is nested and overlaps for its whole length', () => {
    expect(checkChildOverlap([rec('outer', 0, 100, 1000), rec('inner', 40, 60, 3)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 1003, unknownChildren: 0, complete: true })
    expect(checkChildOverlap([rec('inner', 40, 60, 3), rec('outer', 0, 100, 1000)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 1003, unknownChildren: 0, complete: true })
  })

  test('identical intervals overlap for their full length', () => {
    expect(checkChildOverlap([rec('a', 5, 8, 0), rec('b', 5, 8, 0)]))
      .toEqual({ overlap: true, overlapDuration: 3, knownInputTokens: 0, unknownChildren: 0, complete: true })
  })

  test('a one-unit intersection is the smallest strict overlap', () => {
    expect(checkChildOverlap([rec('a', 0, 11, 1), rec('b', 10, 20, 1)]))
      .toEqual({ overlap: true, overlapDuration: 1, knownInputTokens: 2, unknownChildren: 0, complete: true })
  })

  test('touching intervals do not overlap', () => {
    expect(checkChildOverlap([rec('a', 0, 10, 4), rec('b', 10, 20, 6)]))
      .toEqual({ overlap: false, overlapDuration: 0, knownInputTokens: 10, unknownChildren: 0, complete: true })
  })

  test('touching intervals do not overlap in either record order', () => {
    expect(checkChildOverlap([rec('b', 10, 20, 6), rec('a', 0, 10, 4)]))
      .toEqual({ overlap: false, overlapDuration: 0, knownInputTokens: 10, unknownChildren: 0, complete: true })
  })

  test('serial intervals with a gap do not overlap', () => {
    expect(checkChildOverlap([rec('a', 0, 10, 4), rec('b', 25, 40, 6)]))
      .toEqual({ overlap: false, overlapDuration: 0, knownInputTokens: 10, unknownChildren: 0, complete: true })
    expect(checkChildOverlap([rec('b', 25, 40, 6), rec('a', 0, 10, 4)]))
      .toEqual({ overlap: false, overlapDuration: 0, knownInputTokens: 10, unknownChildren: 0, complete: true })
  })

  test('the largest safe timestamps are accepted', () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(checkChildOverlap([rec('a', 0, max, 1), rec('b', max - 1, max, 1)]))
      .toEqual({ overlap: true, overlapDuration: 1, knownInputTokens: 2, unknownChildren: 0, complete: true })
  })
})

describe('checkChildOverlap reports input-token coverage without vetoing intervals', () => {
  test('one unknown count leaves overlap intact and coverage incomplete', () => {
    expect(checkChildOverlap([rec('a', 10, 50, 7), rec('b', 30, 90, null)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 7, unknownChildren: 1, complete: false })
  })

  test('both unknown counts are never inferred as zero-measured', () => {
    expect(checkChildOverlap([rec('a', 10, 50, null), rec('b', 30, 90, null)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 0, unknownChildren: 2, complete: false })
  })

  test('an unknown count on non-overlapping intervals is still reported', () => {
    expect(checkChildOverlap([rec('a', 0, 10, null), rec('b', 10, 20, 9)]))
      .toEqual({ overlap: false, overlapDuration: 0, knownInputTokens: 9, unknownChildren: 1, complete: false })
  })

  test('a measured zero is known and keeps coverage complete', () => {
    expect(checkChildOverlap([rec('a', 10, 50, 0), rec('b', 30, 90, 5)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 5, unknownChildren: 0, complete: true })
  })

  test('measured zero next to an unknown count stays distinct from it', () => {
    expect(checkChildOverlap([rec('a', 10, 50, 0), rec('b', 30, 90, null)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 0, unknownChildren: 1, complete: false })
  })

  test('the maximum safe total is accepted', () => {
    expect(checkChildOverlap([rec('a', 10, 50, Number.MAX_SAFE_INTEGER), rec('b', 30, 90, 0)]))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: Number.MAX_SAFE_INTEGER, unknownChildren: 0, complete: true })
  })

  test('an unsafe summed total is rejected', () => {
    expect(() => checkChildOverlap([rec('a', 10, 50, Number.MAX_SAFE_INTEGER), rec('b', 30, 90, 1)])).toThrow(RangeError)
    expect(() => checkChildOverlap([rec('a', 10, 50, Number.MAX_SAFE_INTEGER), rec('b', 30, 90, 1)])).toThrow(/^record 1: /)
  })
})

describe('checkChildOverlap rejects invalid input', () => {
  test.each([
    ['an object', { childId: 'a', acceptedAt: 0, finishedAt: 1, inputTokens: 1 }],
    ['a string', '[]'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 2],
    ['an empty array', []],
    ['one record', [rec('a', 0, 10, 1)]],
    ['three records', [rec('a', 0, 10, 1), rec('b', 5, 15, 1), rec('c', 6, 16, 1)]],
  ] as const)('not an array of exactly two records: %s', (_label, input) => {
    expect(() => checkChildOverlap(input)).toThrow(TypeError)
  })

  const invalidRecords: ReadonlyArray<readonly [string, unknown]> = [
    ['element null', null],
    ['element array', ['b', 0, 10, 1]],
    ['element string', 'b'],
    ['element number', 7],
    ['missing childId', { acceptedAt: 0, finishedAt: 10, inputTokens: 1 }],
    ['missing acceptedAt', { childId: 'b', finishedAt: 10, inputTokens: 1 }],
    ['missing finishedAt', { childId: 'b', acceptedAt: 0, inputTokens: 1 }],
    ['missing inputTokens', { childId: 'b', acceptedAt: 0, finishedAt: 10 }],
    ['extra key', { ...rec('b', 0, 10, 1), cost: 1 }],
    ['multiple extra keys', { ...rec('b', 0, 10, 1), totalTokens: 99, cacheTokens: 3 }],
    ['childId empty', rec('', 0, 10, 1)],
    ['childId leading whitespace', rec(' b', 0, 10, 1)],
    ['childId trailing whitespace', rec('b ', 0, 10, 1)],
    ['childId whitespace only', rec('   ', 0, 10, 1)],
    ['childId number', rec(7, 0, 10, 1)],
    ['childId null', rec(null, 0, 10, 1)],
    ['childId undefined', rec(undefined, 0, 10, 1)],
    ['acceptedAt negative', rec('b', -1, 10, 1)],
    ['acceptedAt fractional', rec('b', 0.5, 10, 1)],
    ['acceptedAt NaN', rec('b', Number.NaN, 10, 1)],
    ['acceptedAt Infinity', rec('b', Number.POSITIVE_INFINITY, 10, 1)],
    ['acceptedAt unsafe', rec('b', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 3, 1)],
    ['acceptedAt numeric string', rec('b', '0', 10, 1)],
    ['acceptedAt boolean', rec('b', false, 10, 1)],
    ['acceptedAt null', rec('b', null, 10, 1)],
    ['acceptedAt undefined', rec('b', undefined, 10, 1)],
    ['finishedAt negative', rec('b', 0, -10, 1)],
    ['finishedAt fractional', rec('b', 0, 10.5, 1)],
    ['finishedAt NaN', rec('b', 0, Number.NaN, 1)],
    ['finishedAt Infinity', rec('b', 0, Number.POSITIVE_INFINITY, 1)],
    ['finishedAt unsafe', rec('b', 0, Number.MAX_SAFE_INTEGER + 1, 1)],
    ['finishedAt numeric string', rec('b', 0, '10', 1)],
    ['finishedAt boolean', rec('b', 0, true, 1)],
    ['finishedAt null', rec('b', 0, null, 1)],
    ['reversed interval', rec('b', 10, 0, 1)],
    ['empty interval', rec('b', 10, 10, 1)],
    ['empty interval at zero', rec('b', 0, 0, 1)],
    ['inputTokens negative', rec('b', 0, 10, -1)],
    ['inputTokens fractional', rec('b', 0, 10, 1.5)],
    ['inputTokens NaN', rec('b', 0, 10, Number.NaN)],
    ['inputTokens Infinity', rec('b', 0, 10, Number.POSITIVE_INFINITY)],
    ['inputTokens negative Infinity', rec('b', 0, 10, Number.NEGATIVE_INFINITY)],
    ['inputTokens unsafe', rec('b', 0, 10, Number.MAX_SAFE_INTEGER + 1)],
    ['inputTokens numeric string', rec('b', 0, 10, '7')],
    ['inputTokens boolean', rec('b', 0, 10, true)],
    ['inputTokens undefined', rec('b', 0, 10, undefined)],
    ['inputTokens object', rec('b', 0, 10, { input: 7 })],
  ]
  test.each(invalidRecords)('malformed second record: %s', (_label, record) => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), record])).toThrow(TypeError)
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), record])).toThrow(/^record 1: /)
  })
  test.each(invalidRecords)('malformed first record: %s', (_label, record) => {
    expect(() => checkChildOverlap([record, rec('z', 0, 10, 1)])).toThrow(TypeError)
    expect(() => checkChildOverlap([record, rec('z', 0, 10, 1)])).toThrow(/^record 0: /)
  })

  test('reversed and empty intervals name the ordering rule', () => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), rec('b', 10, 0, 1)])).toThrow(/strictly less than finishedAt/)
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), rec('b', 5, 5, 1)])).toThrow(/strictly less than finishedAt/)
  })

  test('a present key with an undefined value is malformed, not missing', () => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), rec('b', 0, 10, undefined)])).toThrow(/inputTokens must be null or a nonnegative safe integer/)
  })

  test('an extra key is rejected even when every required key is valid', () => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), { ...rec('b', 5, 15, 1), note: 'x' }])).toThrow(/exactly the fields/)
  })

  test('inherited keys do not satisfy required fields', () => {
    const inherited = Object.create(rec('b', 5, 15, 1)) as Record<string, unknown>
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), inherited])).toThrow(/missing required field childId/)
  })

  test('duplicate identity by exact string equality is rejected', () => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), rec('a', 5, 15, 2)])).toThrow(TypeError)
    expect(() => checkChildOverlap([rec('a', 0, 10, null), rec('a', 5, 15, null)])).toThrow('record 1: childId duplicates record 0')
  })

  test('identities differing only by case are distinct', () => {
    expect(checkChildOverlap([rec('a', 0, 10, 1), rec('A', 5, 15, 2)]))
      .toEqual({ overlap: true, overlapDuration: 5, knownInputTokens: 3, unknownChildren: 0, complete: true })
  })

  test('an identity padded to look like a duplicate is refused for whitespace, not accepted as distinct', () => {
    expect(() => checkChildOverlap([rec('a', 0, 10, 1), rec('a ', 5, 15, 2)])).toThrow(/whitespace/)
  })

  test('diagnostics name the index and rule, never record values', () => {
    const sentinel = 'SENTINEL-DO-NOT-ECHO'
    const cases: unknown[][] = [
      [rec(sentinel, 0, 10, 1), rec(sentinel, 5, 15, 1)],
      [rec(`${sentinel} `, 0, 10, 1), rec('b', 5, 15, 1)],
      [rec('a', sentinel, 10, 1), rec('b', 5, 15, 1)],
      [rec('a', 0, sentinel, 1), rec('b', 5, 15, 1)],
      [rec('a', 0, 10, sentinel), rec('b', 5, 15, 1)],
      [rec('a', 0, 10, 1), { ...rec('b', 5, 15, 1), [sentinel]: sentinel }],
      [rec('a', 0, 10, Number.MAX_SAFE_INTEGER), rec(sentinel, 5, 15, 1)],
    ]
    for (const input of cases) {
      let message = ''
      try { checkChildOverlap(input) } catch (error) { message = (error as Error).message }
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain(sentinel)
      expect(message).toMatch(/^record \d+: /)
    }
  })
})

describe('checkChildOverlap never mutates its input', () => {
  test('a frozen valid input is read only and unchanged', () => {
    const input = deepFreeze([rec('b', 30, 90, null), rec('a', 10, 50, 7)])
    const before = JSON.stringify(input)
    expect(checkChildOverlap(input))
      .toEqual({ overlap: true, overlapDuration: 20, knownInputTokens: 7, unknownChildren: 1, complete: false })
    expect(JSON.stringify(input)).toBe(before)
    expect(input[0]!['childId']).toBe('b')
    expect(input[1]!['childId']).toBe('a')
  })

  test('an unfrozen valid input keeps its order, identity and values', () => {
    const second = rec('a', 10, 50, 0)
    const first = rec('b', 30, 90, 5)
    const input = [first, second]
    const before = JSON.stringify(input)
    checkChildOverlap(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(input[0]).toBe(first)
    expect(input[1]).toBe(second)
    expect(input).toHaveLength(2)
  })

  test('a frozen invalid input is left untouched on the error path', () => {
    const input = deepFreeze([rec('a', 0, 10, 1), { ...rec('b', 20, 5, -1), nested: { deep: [1, 2] } }])
    const before = JSON.stringify(input)
    expect(() => checkChildOverlap(input)).toThrow(TypeError)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('a frozen overflowing input is left untouched on the RangeError path', () => {
    const input = deepFreeze([rec('a', 0, 10, Number.MAX_SAFE_INTEGER), rec('b', 5, 15, 2)])
    const before = JSON.stringify(input)
    expect(() => checkChildOverlap(input)).toThrow(RangeError)
    expect(JSON.stringify(input)).toBe(before)
  })

  test('a fresh result object is returned per call', () => {
    const input = [rec('a', 10, 50, 7), rec('b', 30, 90, 5)]
    const first = checkChildOverlap(input)
    const second = checkChildOverlap(input)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})
