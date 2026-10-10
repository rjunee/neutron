import { describe, expect, test } from 'bun:test'
import { compareScopeUsage, ScopeUsageInputError } from './compare.ts'

type Loose = Record<string, unknown>

const scope = (task: unknown, gates: unknown, models: unknown): Loose => ({ task, gates, models })
const side = (declared: unknown, attempts: unknown): Loose => ({ scope: declared, attempts })
const attempt = (attemptId: unknown, inputTokens: unknown): Loose => ({ attemptId, inputTokens })
const pair = (before: unknown, after: unknown): Loose => ({ before, after })

const S = scope('build card 42', 'suite+typecheck', 'opus/high')
const known = (id: string, tokens: number): Loose => attempt(id, tokens)
const unknown = (id: string): Loose => attempt(id, null)
const MAX = Number.MAX_SAFE_INTEGER

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('matched scopes', () => {
  test('exact match with known counts reports a positive reduction', () => {
    expect(compareScopeUsage(pair(
      side(S, [known('a', 120), known('b', 80)]),
      side(scope('build card 42', 'suite+typecheck', 'opus/high'), [known('c', 90), known('d', 60)]),
    ))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 200, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 150, unknownAttempts: 0, complete: true },
      inputTokenReduction: 50,
    })
  })

  test('equal totals give a zero reduction', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 40)]), side(S, [known('b', 15), known('c', 25)]))))
      .toEqual({
        kind: 'matched',
        before: { knownInputTokens: 40, unknownAttempts: 0, complete: true },
        after: { knownInputTokens: 40, unknownAttempts: 0, complete: true },
        inputTokenReduction: 0,
      })
  })

  test('a larger after total gives a negative reduction', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 10)]), side(S, [known('b', 35)]))).inputTokenReduction).toBe(-25)
  })

  test('a measured zero on one side is known and the reduction is computed', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 30)]), side(S, [known('b', 0)])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 30, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      inputTokenReduction: 30,
    })
  })

  test('measured zeros on both sides are known and give a zero reduction', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 0), known('b', 0)]), side(S, [known('c', 0)])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      inputTokenReduction: 0,
    })
  })

  test('empty attempts on both sides are zero known, zero unknown and complete', () => {
    expect(compareScopeUsage(pair(side(S, []), side(S, [])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      inputTokenReduction: 0,
    })
  })

  test('empty attempts on one side only', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 12)]), side(S, [])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 12, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      inputTokenReduction: 12,
    })
  })

  test('an unknown after count leaves the reduction null', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 50)]), side(S, [known('b', 10), unknown('c')])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 50, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 10, unknownAttempts: 1, complete: false },
      inputTokenReduction: null,
    })
  })

  test('an unknown before count leaves the reduction null', () => {
    expect(compareScopeUsage(pair(side(S, [unknown('a')]), side(S, [known('b', 10)])))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 0, unknownAttempts: 1, complete: false },
      after: { knownInputTokens: 10, unknownAttempts: 0, complete: true },
      inputTokenReduction: null,
    })
  })

  test('both sides incomplete, mixed counts summed with nulls counted and not added', () => {
    expect(compareScopeUsage(pair(
      side(S, [known('a', 7), unknown('b'), known('c', 0), unknown('d'), known('e', 5)]),
      side(S, [unknown('f'), known('g', 3)]),
    ))).toEqual({
      kind: 'matched',
      before: { knownInputTokens: 12, unknownAttempts: 2, complete: false },
      after: { knownInputTokens: 3, unknownAttempts: 1, complete: false },
      inputTokenReduction: null,
    })
  })

  test('the same attemptId on opposite sides is accepted', () => {
    expect(compareScopeUsage(pair(side(S, [known('shared', 9)]), side(S, [known('shared', 4)]))).inputTokenReduction).toBe(5)
  })

  test('a numeric-looking scope string is a string and is compared exactly, not parsed', () => {
    expect(compareScopeUsage(pair(side(scope('7', '7', '7'), []), side(scope('7', '7', '7'), []))).kind).toBe('matched')
    expect(compareScopeUsage(pair(side(scope('7', '7', '7'), []), side(scope('07', '7', '7'), []))).kind).toBe('unmatched')
  })

  test('extreme safe totals give safe-integer reductions in both directions', () => {
    const down = compareScopeUsage(pair(side(S, [known('a', MAX)]), side(S, [known('b', 0)])))
    expect(down.inputTokenReduction).toBe(MAX)
    const up = compareScopeUsage(pair(side(S, [known('a', 0)]), side(S, [known('b', MAX)])))
    expect(up.inputTokenReduction).toBe(-MAX)
    expect(Number.isSafeInteger(down.inputTokenReduction)).toBe(true)
    expect(Number.isSafeInteger(up.inputTokenReduction)).toBe(true)
  })

  test('each call returns a fresh result that shares no object with the input', () => {
    const input = pair(side(S, [known('a', 1)]), side(S, [known('b', 1)]))
    const first = compareScopeUsage(input)
    const second = compareScopeUsage(input)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.before).not.toBe(second.before)
    const sides = input as { before: unknown; after: unknown }
    for (const summary of [first.before, first.after]) {
      expect(summary).not.toBe(sides.before as never)
      expect(summary).not.toBe(sides.after as never)
    }
  })

  test('result property order is kind, before, after, inputTokenReduction', () => {
    const result = compareScopeUsage(pair(side(S, []), side(S, [])))
    expect(Object.keys(result)).toEqual(['kind', 'before', 'after', 'inputTokenReduction'])
    expect(Object.keys(result.before)).toEqual(['knownInputTokens', 'unknownAttempts', 'complete'])
  })
})

describe('unmatched scopes', () => {
  const B = side(S, [known('a', 100)])
  const complete = (task: string, gates: string, models: string): Loose => side(scope(task, gates, models), [known('b', 40)])

  test.each([
    ['task', complete('build card 43', 'suite+typecheck', 'opus/high')],
    ['gates', complete('build card 42', 'suite', 'opus/high')],
    ['models', complete('build card 42', 'suite+typecheck', 'opus/low')],
    ['all three', complete('other', 'other', 'other')],
  ])('a %s difference is unmatched and the reduction is null even when both sides are complete', (_label, after) => {
    expect(compareScopeUsage(pair(B, after))).toEqual({
      kind: 'unmatched',
      before: { knownInputTokens: 100, unknownAttempts: 0, complete: true },
      after: { knownInputTokens: 40, unknownAttempts: 0, complete: true },
      inputTokenReduction: null,
    })
  })

  test.each([
    ['case', scope('Build card 42', 'suite+typecheck', 'opus/high')],
    ['internal whitespace', scope('build  card 42', 'suite+typecheck', 'opus/high')],
    ['gate case', scope('build card 42', 'Suite+typecheck', 'opus/high')],
    ['model internal whitespace', scope('build card 42', 'suite+typecheck', 'opus /high')],
    ['trailing punctuation', scope('build card 42.', 'suite+typecheck', 'opus/high')],
  ])('a %s difference is not normalized away', (_label, declared) => {
    expect(compareScopeUsage(pair(side(S, []), side(declared, []))).kind).toBe('unmatched')
  })

  test('summaries are still computed independently for unmatched incomplete sides', () => {
    expect(compareScopeUsage(pair(side(S, [unknown('a'), known('b', 3)]), side(scope('x', 'y', 'z'), [known('c', 0)])))).toEqual({
      kind: 'unmatched',
      before: { knownInputTokens: 3, unknownAttempts: 1, complete: false },
      after: { knownInputTokens: 0, unknownAttempts: 0, complete: true },
      inputTokenReduction: null,
    })
  })
})

describe('validation', () => {
  const okSide = side(S, [known('a', 1)])
  const withBefore = (before: unknown): Loose => pair(before, okSide)
  const withScope = (declared: unknown): Loose => pair(side(declared, []), okSide)
  const withAttempts = (attempts: unknown): Loose => pair(side(S, attempts), okSide)
  const withAttempt = (record: unknown): Loose => withAttempts([record])

  test('the typed error is a TypeError subclass', () => {
    expect(() => compareScopeUsage(null)).toThrow(TypeError)
    expect(() => compareScopeUsage(null)).toThrow(ScopeUsageInputError)
    try {
      compareScopeUsage(null)
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeUsageInputError)
      expect((error as Error).name).toBe('ScopeUsageInputError')
    }
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['array', [okSide, okSide]],
    ['string', 'input'],
    ['number', 7],
    ['missing after', { before: okSide }],
    ['missing before', { after: okSide }],
    ['extra key', { before: okSide, after: okSide, extra: 1 }],
    ['own __proto__ key from JSON', JSON.parse(`{"before":${JSON.stringify(okSide)},"__proto__":${JSON.stringify(okSide)}}`)],
    ['empty object', {}],
  ])('input rejected: %s', (_label, input) => {
    expect(() => compareScopeUsage(input)).toThrow(ScopeUsageInputError)
  })

  test.each([
    ['null', null],
    ['array', [S, []]],
    ['string', 'side'],
    ['missing scope', { attempts: [] }],
    ['missing attempts', { scope: S }],
    ['extra key', { scope: S, attempts: [], note: 'x' }],
  ])('side rejected: %s', (_label, value) => {
    expect(() => compareScopeUsage(withBefore(value))).toThrow(ScopeUsageInputError)
    expect(() => compareScopeUsage(pair(okSide, value))).toThrow(ScopeUsageInputError)
  })

  test.each([
    ['null', null],
    ['array', ['a', 'b', 'c']],
    ['string', 'scope'],
    ['missing task', { gates: 'g', models: 'm' }],
    ['missing gates', { task: 't', models: 'm' }],
    ['missing models', { task: 't', gates: 'g' }],
    ['extra key', { task: 't', gates: 'g', models: 'm', effort: 'high' }],
  ])('scope rejected: %s', (_label, declared) => {
    expect(() => compareScopeUsage(withScope(declared))).toThrow(ScopeUsageInputError)
  })

  const badStrings: ReadonlyArray<[string, unknown]> = [
    ['empty string', ''],
    ['leading whitespace', ' t'],
    ['trailing whitespace', 't '],
    ['trailing newline', 't\n'],
    ['whitespace only', '   '],
    ['number', 7],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['object', { value: 't' }],
  ]
  for (const field of ['task', 'gates', 'models'] as const) {
    test.each(badStrings)(`scope.${field} rejected: %s`, (_label, value) => {
      const declared = { task: 't', gates: 'g', models: 'm', [field]: value }
      expect(() => compareScopeUsage(withScope(declared))).toThrow(ScopeUsageInputError)
      expect(() => compareScopeUsage(pair(okSide, side(declared, [])))).toThrow(ScopeUsageInputError)
    })
  }

  test.each([
    ['object', {}],
    ['string', 'attempts'],
    ['null', null],
    ['number', 3],
  ])('attempts rejected when not an array: %s', (_label, attempts) => {
    expect(() => compareScopeUsage(withAttempts(attempts))).toThrow(ScopeUsageInputError)
  })

  test.each([
    ['null', null],
    ['array', ['a', 1]],
    ['string', 'a'],
    ['number', 1],
    ['missing attemptId', { inputTokens: 1 }],
    ['missing inputTokens (undefined is not null)', { attemptId: 'a' }],
    ['explicit undefined inputTokens', { attemptId: 'a', inputTokens: undefined }],
    ['extra key', { attemptId: 'a', inputTokens: 1, outcome: 'completed' }],
    ['empty attemptId', attempt('', 1)],
    ['padded attemptId', attempt(' a', 1)],
    ['trailing-padded attemptId', attempt('a ', 1)],
    ['whitespace-only attemptId', attempt('  ', 1)],
    ['numeric attemptId', attempt(1, 1)],
    ['null attemptId', attempt(null, 1)],
    ['negative inputTokens', attempt('a', -1)],
    ['fractional inputTokens', attempt('a', 1.5)],
    ['NaN inputTokens', attempt('a', Number.NaN)],
    ['+Infinity inputTokens', attempt('a', Number.POSITIVE_INFINITY)],
    ['-Infinity inputTokens', attempt('a', Number.NEGATIVE_INFINITY)],
    ['numeric string inputTokens', attempt('a', '7')],
    ['empty string inputTokens', attempt('a', '')],
    ['true inputTokens', attempt('a', true)],
    ['false inputTokens', attempt('a', false)],
    ['unsafe inputTokens', attempt('a', MAX + 1)],
    ['object inputTokens', attempt('a', { value: 1 })],
    ['bigint inputTokens', attempt('a', 1n)],
  ])('attempt rejected: %s', (_label, record) => {
    expect(() => compareScopeUsage(withAttempt(record))).toThrow(ScopeUsageInputError)
    expect(() => compareScopeUsage(pair(okSide, side(S, [record])))).toThrow(ScopeUsageInputError)
  })

  test('duplicate attemptId within before is rejected', () => {
    expect(() => compareScopeUsage(pair(side(S, [known('a', 1), known('b', 2), known('a', 3)]), okSide)))
      .toThrow(ScopeUsageInputError)
  })

  test('duplicate attemptId within after is rejected, including a null duplicate', () => {
    expect(() => compareScopeUsage(pair(okSide, side(S, [unknown('x'), unknown('x')])))).toThrow(ScopeUsageInputError)
  })

  test('duplicates are exact: ids differing only in case are distinct', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', 1), known('A', 2)]), okSide)).before.knownInputTokens).toBe(3)
  })

  test('summed overflow is rejected on before and on after', () => {
    expect(() => compareScopeUsage(pair(side(S, [known('a', MAX), known('b', 1)]), okSide))).toThrow(ScopeUsageInputError)
    expect(() => compareScopeUsage(pair(okSide, side(S, [known('a', MAX), known('b', 1)])))).toThrow(ScopeUsageInputError)
  })

  test('a maximum safe total with a measured zero is accepted', () => {
    expect(compareScopeUsage(pair(side(S, [known('a', MAX), known('b', 0)]), okSide)).before)
      .toEqual({ knownInputTokens: MAX, unknownAttempts: 0, complete: true })
  })

  test('an invalid after side is rejected even when the scopes are unmatched', () => {
    expect(() => compareScopeUsage(pair(okSide, side(scope('x', 'y', 'z'), [known('a', -1)])))).toThrow(ScopeUsageInputError)
    expect(() => compareScopeUsage(pair(side(scope('x', 'y', 'z'), []), side(S, [unknown('a'), unknown('a')])))).toThrow(ScopeUsageInputError)
  })

  test('diagnostics name a structural path and rule, never input values', () => {
    const sentinel = 'SENTINEL-DO-NOT-ECHO'
    const tagged = scope(sentinel, sentinel, sentinel)
    const cases: unknown[] = [
      { before: side(tagged, []), after: side(tagged, []), [sentinel]: sentinel },
      pair(side(tagged, [attempt(sentinel, 1), attempt(sentinel, 2)]), side(tagged, [])),
      pair(side(tagged, [attempt(sentinel, `${sentinel}7`)]), side(tagged, [])),
      pair(side({ ...tagged, [sentinel]: sentinel }, []), side(tagged, [])),
      pair(side(tagged, []), side(scope(` ${sentinel}`, sentinel, sentinel), [])),
      pair(side(tagged, [attempt(sentinel, MAX), attempt(`${sentinel}2`, 1)]), side(tagged, [])),
      pair(side(tagged, [{ attemptId: sentinel, inputTokens: 1, [sentinel]: sentinel }]), side(tagged, [])),
      pair(side(tagged, sentinel), side(tagged, [])),
    ]
    for (const input of cases) {
      let message = ''
      try {
        compareScopeUsage(input)
      } catch (error) {
        expect(error).toBeInstanceOf(ScopeUsageInputError)
        message = (error as Error).message
      }
      expect(message.length).toBeGreaterThan(0)
      expect(message).toMatch(/^(input|before|after)(\.|\[|:)/)
      expect(message).not.toContain(sentinel)
    }
  })

  test('diagnostic paths point at the offending location', () => {
    const messageOf = (input: unknown): string => {
      try {
        compareScopeUsage(input)
      } catch (error) {
        return (error as Error).message
      }
      return ''
    }
    expect(messageOf(pair(okSide, side(scope('t', ' g', 'm'), [])))).toStartWith('after.scope.gates:')
    expect(messageOf(pair(side(S, [known('a', 1), known('b', -2)]), okSide))).toStartWith('before.attempts[1].inputTokens:')
    expect(messageOf(pair(okSide, side(S, [known('a', 1), known('a', 2)])))).toBe('after.attempts[1].attemptId: duplicates after.attempts[0]')
    expect(messageOf(pair(side(S, [known('a', MAX), known('b', 1)]), okSide))).toBe('before.attempts[1]: summed inputTokens exceed the safe integer range')
  })
})

describe('immutability', () => {
  test('deep-frozen matched and unmatched inputs are compared and left unchanged', () => {
    for (const input of [
      pair(side(S, [known('a', 5), unknown('b'), known('c', 0)]), side(S, [known('d', 2)])),
      pair(side(S, [known('a', 5)]), side(scope('x', 'y', 'z'), [unknown('d')])),
    ]) {
      const snapshot = JSON.stringify(input)
      const frozen = deepFreeze(input)
      expect(() => compareScopeUsage(frozen)).not.toThrow()
      expect(JSON.stringify(frozen)).toBe(snapshot)
    }
  })

  test('deep-frozen invalid input is left unchanged on the error path', () => {
    for (const input of [
      pair(side(S, [known('a', 5), known('a', 6)]), side(S, [])),
      pair(side(S, [known('a', MAX), known('b', 1)]), side(S, [])),
      pair(side(S, []), side(scope(' x', 'y', 'z'), [])),
    ]) {
      const snapshot = JSON.stringify(input)
      const frozen = deepFreeze(input)
      expect(() => compareScopeUsage(frozen)).toThrow(ScopeUsageInputError)
      expect(JSON.stringify(frozen)).toBe(snapshot)
    }
  })

  test('an unfrozen input is not reordered or modified', () => {
    const input = pair(side(S, [known('z', 3), unknown('y'), known('x', 1)]), side(S, [known('w', 2)]))
    const snapshot = JSON.stringify(input)
    compareScopeUsage(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
