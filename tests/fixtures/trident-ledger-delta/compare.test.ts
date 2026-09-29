import { describe, expect, test } from 'bun:test'
import { compareLedgerDelta, type LedgerDeltaResult } from './compare.ts'
import { decodeLedger, type DecodedLedger } from './decode.ts'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function decoded(input: string): DecodedLedger {
  const result = decodeLedger(input)
  if (!result.ok) throw new Error(`expected an accepted ledger, got: ${result.reason}`)
  return result.ledger
}

/** Joins task lines with LF (no trailing LF) and decodes through the real T1 decoder. */
function ledger(...lines: string[]): DecodedLedger {
  return decoded(lines.join('\n'))
}

const SENTINEL = 'SENTINEL-DO-NOT-ECHO'
const REASON = /^(task count differs|before has no unchecked task|task \d+: (label differs|first unchecked task not completed|checkbox changed))$/

// The two task lines the build E2E fixture planner emits and the host commits.
const E2E_T1 = '- [ ] T1 record the note'
const E2E_T2 = '- [ ] T2 record another note'
const E2E_T1_DONE = '- [x] T1 record the note'
const E2E_T2_DONE = '- [x] T2 record another note'

describe('compareLedgerDelta accepts exactly one first-unchecked completion', () => {
  test('two-task first completion with no checked prefix (E2E handoff, after without trailing LF)', () => {
    const before = decoded(`${E2E_T1}\n${E2E_T2}\n`)
    const after = decoded(`${E2E_T1_DONE}\n${E2E_T2}`)
    expect(compareLedgerDelta(before, after)).toEqual({
      ok: true,
      completedLabel: 'T1 record the note',
      after: { completed: 1, remaining: 1, firstUnchecked: E2E_T2 },
    })
  })

  test('three-task first completion', () => {
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b', '- [ ] c'), ledger('- [x] a', '- [ ] b', '- [ ] c'))).toEqual({
      ok: true,
      completedLabel: 'a',
      after: { completed: 1, remaining: 2, firstUnchecked: '- [ ] b' },
    })
  })

  test('a checked prefix: the first unchecked task after it is the one completed', () => {
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b', '- [ ] c'), ledger('- [x] a', '- [x] b', '- [ ] c'))).toEqual({
      ok: true,
      completedLabel: 'b',
      after: { completed: 2, remaining: 1, firstUnchecked: '- [ ] c' },
    })
  })

  test('final legitimate completion leaves a measured zero remaining and no first unchecked line', () => {
    const result = compareLedgerDelta(ledger('- [x] a', '- [ ] b'), ledger('- [x] a', '- [x] b'))
    expect(result).toEqual({ ok: true, completedLabel: 'b', after: { completed: 2, remaining: 0, firstUnchecked: null } })
    if (!result.ok) throw new Error('expected an accepted delta')
    expect(result.after.remaining).toBe(0)
    expect(result.after.firstUnchecked).toBeNull()
  })

  test('the E2E final handoff completes task two', () => {
    expect(compareLedgerDelta(ledger(E2E_T1_DONE, E2E_T2), ledger(E2E_T1_DONE, E2E_T2_DONE))).toEqual({
      ok: true,
      completedLabel: 'T2 record another note',
      after: { completed: 2, remaining: 0, firstUnchecked: null },
    })
  })

  test('a single-task ledger advances', () => {
    expect(compareLedgerDelta(ledger('- [ ] only'), ledger('- [x] only'))).toEqual({
      ok: true,
      completedLabel: 'only',
      after: { completed: 1, remaining: 0, firstUnchecked: null },
    })
  })

  test('an unchecked task after the completed one keeps later checked tasks as they were', () => {
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b', '- [x] c', '- [ ] d'), ledger('- [x] a', '- [x] b', '- [x] c', '- [ ] d'))).toEqual({
      ok: true,
      completedLabel: 'b',
      after: { completed: 3, remaining: 1, firstUnchecked: '- [ ] d' },
    })
  })

  test('labels with internal double spaces and punctuation come back byte-identical', () => {
    const label = 'T1:  Build   the Comparator, (exact)! v2'
    const next = 'naïve café — step  2'
    expect(compareLedgerDelta(ledger(`- [ ] ${label}`, `- [ ] ${next}`), ledger(`- [x] ${label}`, `- [ ] ${next}`))).toEqual({
      ok: true,
      completedLabel: label,
      after: { completed: 1, remaining: 1, firstUnchecked: `- [ ] ${next}` },
    })
  })

  test('a hand-built DecodedLedger literal is compared like a decoded one', () => {
    const before: DecodedLedger = { tasks: [{ label: 'x', completed: true }, { label: 'y', completed: false }, { label: 'z', completed: false }] }
    const after: DecodedLedger = { tasks: [{ label: 'x', completed: true }, { label: 'y', completed: true }, { label: 'z', completed: false }] }
    expect(compareLedgerDelta(before, after)).toEqual({
      ok: true,
      completedLabel: 'y',
      after: { completed: 2, remaining: 1, firstUnchecked: '- [ ] z' },
    })
  })
})

describe('compareLedgerDelta rejects every other transition', () => {
  test('a skipped task (the E2E wrong-order completion) is rejected at task 0', () => {
    expect(compareLedgerDelta(ledger(E2E_T1, E2E_T2), ledger(E2E_T1, E2E_T2_DONE))).toEqual({
      ok: false,
      reason: 'task 0: first unchecked task not completed',
    })
  })

  // Each row: name, before lines, after lines. Every row is also re-run with a
  // sentinel appended to every label, which must not change the verdict and must
  // never appear in the reason.
  test.each<[string, string[], string[]]>([
    ['no-op on a fresh ledger', ['- [ ] a', '- [ ] b'], ['- [ ] a', '- [ ] b']],
    ['no-op with a checked prefix', ['- [x] a', '- [ ] b'], ['- [x] a', '- [ ] b']],
    ['reversal of a checked task', ['- [x] a', '- [ ] b'], ['- [ ] a', '- [ ] b']],
    ['reversal while completing the next task', ['- [x] a', '- [ ] b'], ['- [ ] a', '- [x] b']],
    ['skipped E2E task', [E2E_T1, E2E_T2], [E2E_T1, E2E_T2_DONE]],
    ['skipped task with a checked prefix', ['- [x] a', '- [ ] b', '- [ ] c'], ['- [x] a', '- [ ] b', '- [x] c']],
    ['completing two from fresh', ['- [ ] a', '- [ ] b'], ['- [x] a', '- [x] b']],
    ['completing two after a checked prefix', ['- [x] a', '- [ ] b', '- [ ] c'], ['- [x] a', '- [x] b', '- [x] c']],
    ['relabeling the next task', ['- [ ] a', '- [ ] b'], ['- [x] a', '- [ ] c']],
    ['relabeling the completed task', ['- [ ] a', '- [ ] b'], ['- [x] z', '- [ ] b']],
    ['a case-only label change', ['- [ ] a', '- [ ] b'], ['- [x] A', '- [ ] b']],
    ['a whitespace-only label change', ['- [ ] a b', '- [ ] c'], ['- [x] a  b', '- [ ] c']],
    ['insertion of a task', ['- [ ] a', '- [ ] b'], ['- [x] a', '- [ ] b', '- [ ] c']],
    ['removal of a task', ['- [ ] a', '- [ ] b', '- [ ] c'], ['- [x] a', '- [ ] b']],
    ['removal whose totals match a legitimate step', ['- [x] a', '- [ ] b', '- [ ] c'], ['- [x] a', '- [x] b']],
    ['reordering with matching totals', ['- [ ] a', '- [ ] b'], ['- [x] b', '- [ ] a']],
    ['reordering of a checked prefix', ['- [x] a', '- [ ] b', '- [ ] c'], ['- [ ] b', '- [x] a', '- [ ] c']],
    ['a fully completed before with an identical after', ['- [x] a', '- [x] b'], ['- [x] a', '- [x] b']],
    ['a fully completed before with a reversed after', ['- [x] a', '- [x] b'], ['- [x] a', '- [ ] b']],
  ])('%s', (_name, beforeLines, afterLines) => {
    const plain: LedgerDeltaResult = compareLedgerDelta(ledger(...beforeLines), ledger(...afterLines))
    expect(plain.ok).toBe(false)
    if (plain.ok) return
    expect(plain.reason).toMatch(REASON)

    const mark = (line: string): string => `${line} ${SENTINEL}`
    const marked = compareLedgerDelta(ledger(...beforeLines.map(mark)), ledger(...afterLines.map(mark)))
    expect(marked).toEqual(plain)
    if (marked.ok) return
    expect(marked.reason).not.toContain(SENTINEL)
    expect(marked.reason).not.toContain('SENTINEL')
  })

  test('each rule reports its own reason and zero-based index, in rule order', () => {
    // rule 1: task count
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [x] a', '- [ ] b', '- [ ] c'))).toEqual({ ok: false, reason: 'task count differs' })
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b', '- [ ] c'), ledger('- [x] a', '- [x] b'))).toEqual({ ok: false, reason: 'task count differs' })
    // rule 2: positional labels, reported at the first differing index
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [x] a', '- [ ] c'))).toEqual({ ok: false, reason: 'task 1: label differs' })
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [x] b', '- [ ] a'))).toEqual({ ok: false, reason: 'task 0: label differs' })
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [x] A', '- [ ] b'))).toEqual({ ok: false, reason: 'task 0: label differs' })
    // rule 2 precedes rule 3: a relabel of a fully completed ledger is a label failure
    expect(compareLedgerDelta(ledger('- [x] a', '- [x] b'), ledger('- [x] a', '- [x] c'))).toEqual({ ok: false, reason: 'task 1: label differs' })
    // rule 3: fully completed before
    expect(compareLedgerDelta(ledger('- [x] a', '- [x] b'), ledger('- [x] a', '- [x] b'))).toEqual({ ok: false, reason: 'before has no unchecked task' })
    expect(compareLedgerDelta(ledger('- [x] a', '- [x] b'), ledger('- [x] a', '- [ ] b'))).toEqual({ ok: false, reason: 'before has no unchecked task' })
    // rule 4: no-op and skipped task
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [ ] a', '- [ ] b'))).toEqual({ ok: false, reason: 'task 0: first unchecked task not completed' })
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b', '- [ ] c'), ledger('- [x] a', '- [ ] b', '- [x] c'))).toEqual({ ok: false, reason: 'task 1: first unchecked task not completed' })
    // rule 4 is evaluated before rule 5: a reversal that leaves the target unchecked fails rule 4
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b'), ledger('- [ ] a', '- [ ] b'))).toEqual({ ok: false, reason: 'task 1: first unchecked task not completed' })
    // rule 5: completing two, and a reversal alongside a legitimate completion
    expect(compareLedgerDelta(ledger('- [ ] a', '- [ ] b'), ledger('- [x] a', '- [x] b'))).toEqual({ ok: false, reason: 'task 1: checkbox changed' })
    expect(compareLedgerDelta(ledger('- [x] a', '- [ ] b'), ledger('- [ ] a', '- [x] b'))).toEqual({ ok: false, reason: 'task 0: checkbox changed' })
  })

  test('a rejection carries no accepted fields', () => {
    const result = compareLedgerDelta(ledger(E2E_T1, E2E_T2), ledger(E2E_T1, E2E_T2_DONE))
    expect(result).not.toHaveProperty('completedLabel')
    expect(result).not.toHaveProperty('after')
  })

  test('compareLedgerDelta never throws for empty or mismatched ledgers', () => {
    const empty: DecodedLedger = { tasks: [] }
    expect(() => compareLedgerDelta(empty, empty)).not.toThrow()
    expect(compareLedgerDelta(empty, empty)).toEqual({ ok: false, reason: 'before has no unchecked task' })
    expect(compareLedgerDelta(empty, ledger('- [x] a'))).toEqual({ ok: false, reason: 'task count differs' })
    expect(compareLedgerDelta(ledger('- [ ] a'), empty)).toEqual({ ok: false, reason: 'task count differs' })
  })
})

describe('compareLedgerDelta is pure', () => {
  test('deep-frozen inputs compare successfully and are unchanged', () => {
    const before = deepFreeze(ledger('- [x] a', '- [ ] b', '- [ ] c'))
    const after = deepFreeze(ledger('- [x] a', '- [x] b', '- [ ] c'))
    const beforeJson = JSON.stringify(before)
    const afterJson = JSON.stringify(after)
    expect(compareLedgerDelta(before, after)).toEqual({ ok: true, completedLabel: 'b', after: { completed: 2, remaining: 1, firstUnchecked: '- [ ] c' } })
    expect(JSON.stringify(before)).toBe(beforeJson)
    expect(JSON.stringify(after)).toBe(afterJson)
  })

  test('caller-built inputs keep their order and contents after an accepted and a rejected call', () => {
    const before: DecodedLedger = { tasks: [{ label: 'b', completed: false }, { label: 'a', completed: false }] }
    const after: DecodedLedger = { tasks: [{ label: 'b', completed: false }, { label: 'a', completed: true }] }
    const beforeJson = JSON.stringify(before)
    const afterJson = JSON.stringify(after)
    expect(compareLedgerDelta(before, after).ok).toBe(false)
    expect(compareLedgerDelta(before, before).ok).toBe(false)
    expect(JSON.stringify(before)).toBe(beforeJson)
    expect(JSON.stringify(after)).toBe(afterJson)
    expect(before.tasks[0]!.label).toBe('b')
  })

  test('two calls return equal but distinct results with fresh after summaries', () => {
    const before = ledger(E2E_T1, E2E_T2)
    const after = ledger(E2E_T1_DONE, E2E_T2)
    const first = compareLedgerDelta(before, after)
    const second = compareLedgerDelta(before, after)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    if (!first.ok || !second.ok) throw new Error('expected accepted deltas')
    expect(first.after).not.toBe(second.after)
    const rejectedA = compareLedgerDelta(before, before)
    const rejectedB = compareLedgerDelta(before, before)
    expect(rejectedA).toEqual(rejectedB)
    expect(rejectedA).not.toBe(rejectedB)
  })
})
