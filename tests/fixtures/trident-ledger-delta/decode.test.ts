import { describe, expect, test } from 'bun:test'
import { decodeLedger, summarizeLedger, type DecodedLedger, type LedgerDecodeResult } from './decode.ts'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function decoded(input: unknown): DecodedLedger {
  const result = decodeLedger(input)
  if (!result.ok) throw new Error(`expected an accepted ledger, got: ${result.reason}`)
  return result.ledger
}

const SENTINEL = 'SENTINEL-DO-NOT-ECHO'
const MIXED = '- [x] T1 first\n- [ ] T2 second\n- [ ] T3 third'

// The two task lines the build E2E fixture planner emits and the host commits.
const E2E_T1 = '- [ ] T1 record the note'
const E2E_T2 = '- [ ] T2 record another note'

describe('decodeLedger accepts the strict grammar', () => {
  test('a mixed ledger decodes in order with exact labels and completion flags', () => {
    expect(decodeLedger(MIXED)).toEqual({
      ok: true,
      ledger: {
        tasks: [
          { label: 'T1 first', completed: true },
          { label: 'T2 second', completed: false },
          { label: 'T3 third', completed: false },
        ],
      },
    })
  })

  test('one trailing LF decodes identically to none', () => {
    expect(decodeLedger(`${MIXED}\n`)).toEqual(decodeLedger(MIXED))
  })

  test('a mixed ledger summarizes to one completed, two remaining and the first unchecked line', () => {
    expect(summarizeLedger(decoded(MIXED))).toEqual({ completed: 1, remaining: 2, firstUnchecked: '- [ ] T2 second' })
    expect(summarizeLedger(decoded(`${MIXED}\n`))).toEqual({ completed: 1, remaining: 2, firstUnchecked: '- [ ] T2 second' })
  })

  test('a fully completed ledger has a measured zero remaining and no first unchecked line', () => {
    const summary = summarizeLedger(decoded('- [x] a\n- [x] b\n- [x] c\n'))
    expect(summary.remaining).toBe(0)
    expect(summary).toEqual({ completed: 3, remaining: 0, firstUnchecked: null })
  })

  test('a fully unchecked ledger reports zero completed and its first line', () => {
    expect(summarizeLedger(decoded('- [ ] a\n- [ ] b'))).toEqual({ completed: 0, remaining: 2, firstUnchecked: '- [ ] a' })
  })

  test('an unchecked task after a checked one in the middle is the first unchecked', () => {
    expect(summarizeLedger(decoded('- [x] a\n- [x] b\n- [ ] c\n- [x] d\n- [ ] e'))).toEqual({ completed: 3, remaining: 2, firstUnchecked: '- [ ] c' })
  })

  test('a single-task ledger is accepted', () => {
    expect(decodeLedger('- [ ] only')).toEqual({ ok: true, ledger: { tasks: [{ label: 'only', completed: false }] } })
    expect(summarizeLedger(decoded('- [x] only\n'))).toEqual({ completed: 1, remaining: 0, firstUnchecked: null })
  })

  test('labels are retained byte-identical: internal double spaces, punctuation, colon, trailing digit, case', () => {
    const label = 'T1:  Build   the Decoder, (strict)! v2'
    expect(decoded(`- [ ] ${label}`).tasks[0]!.label).toBe(label)
    const unicode = 'naïve café — step 3'
    expect(decoded(`- [x] ${unicode}`).tasks[0]).toEqual({ label: unicode, completed: true })
  })

  test('labels differing only by case or internal whitespace are distinct, not duplicates', () => {
    expect(decoded('- [ ] Task\n- [ ] task\n- [ ] ta  sk\n- [ ] ta sk').tasks.map((task) => task.label))
      .toEqual(['Task', 'task', 'ta  sk', 'ta sk'])
  })

  test('the E2E fixture ledger decodes with and without one trailing LF', () => {
    for (const input of [`${E2E_T1}\n${E2E_T2}\n`, `${E2E_T1}\n${E2E_T2}`]) {
      expect(decoded(input).tasks).toEqual([
        { label: 'T1 record the note', completed: false },
        { label: 'T2 record another note', completed: false },
      ])
      expect(summarizeLedger(decoded(input))).toEqual({ completed: 0, remaining: 2, firstUnchecked: E2E_T1 })
    }
  })

  test('the E2E handoff ledger (task one ticked) summarizes to task two remaining', () => {
    for (const input of [`- [x] T1 record the note\n${E2E_T2}\n`, `- [x] T1 record the note\n${E2E_T2}`]) {
      expect(summarizeLedger(decoded(input))).toEqual({ completed: 1, remaining: 1, firstUnchecked: E2E_T2 })
    }
  })
})

describe('decodeLedger rejects everything outside the grammar', () => {
  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { tasks: [] }],
    ['an array of lines', ['- [ ] a']],
    ['a Buffer', Buffer.from('- [ ] a')],
    ['a String object', new String('- [ ] a')],
  ])('non-string input: %s', (_name, input) => {
    expect(decodeLedger(input)).toEqual({ ok: false, reason: 'input is not a string' })
  })

  test.each<[string, string]>([
    ['the empty string', ''],
    ['only a LF', '\n'],
    ['a leading LF', `\n- [ ] ${SENTINEL}`],
    ['two trailing LFs', `- [ ] ${SENTINEL}\n\n`],
    ['an intervening blank line', `- [ ] a\n\n- [ ] ${SENTINEL}`],
    ['a whitespace-only line', `- [ ] ${SENTINEL}\n   \n- [ ] b`],
    ['a whitespace-only input', '  '],
    ['CRLF line endings', `- [ ] a\r\n- [ ] ${SENTINEL}\r\n`],
    ['a trailing CR on the last line', `- [ ] ${SENTINEL}\r`],
    ['uppercase X', `- [X] ${SENTINEL}`],
    ['uppercase X after a valid line', `- [x] a\n- [X] ${SENTINEL}`],
    ['no space after the hyphen', `-[ ] ${SENTINEL}`],
    ['two spaces after the hyphen', `-  [ ] ${SENTINEL}`],
    ['an asterisk bullet', `* [ ] ${SENTINEL}`],
    ['a plus bullet', `+ [ ] ${SENTINEL}`],
    ['missing space after the bracket', `- [ ]${SENTINEL}`],
    ['missing space after a checked bracket', `- [x]${SENTINEL}`],
    ['an empty checkbox', `- [] ${SENTINEL}`],
    ['two spaces inside the checkbox', `- [  ] ${SENTINEL}`],
    ['another mark inside the checkbox', `- [v] ${SENTINEL}`],
    ['an indented line', `  - [ ] ${SENTINEL}`],
    ['a tab-indented line', `\t- [ ] ${SENTINEL}`],
    ['plain prose', SENTINEL],
    ['a bare checkbox with no label', '- [ ]'],
    ['an empty label', '- [ ] '],
    ['an empty label on a checked line', '- [x] '],
    ['a leading space in the label', `- [ ]  ${SENTINEL}`],
    ['a trailing space in the label', `- [ ] ${SENTINEL} `],
    ['a whitespace-only label', '- [ ]    '],
    ['a tab in the label', `- [ ] ${SENTINEL}\there`],
    ['a trailing tab in the label', `- [ ] ${SENTINEL}\t`],
    ['a NUL in the label', `- [ ] ${SENTINEL}\u0000`],
    ['an escape character in the label', `- [ ] \u001b[31m${SENTINEL}`],
    ['a DEL in the label', `- [ ] ${SENTINEL}\u007f`],
    ['a vertical tab in the label', `- [ ] ${SENTINEL}\u000bx`],
    ['a duplicate label', `- [ ] ${SENTINEL}\n- [ ] ${SENTINEL}`],
    ['a duplicate label across checkbox states', `- [x] ${SENTINEL}\n- [ ] ${SENTINEL}`],
    ['a non-adjacent duplicate label', `- [ ] ${SENTINEL}\n- [ ] b\n- [x] ${SENTINEL}\n`],
  ])('%s', (_name, input) => {
    const result: LedgerDecodeResult = decodeLedger(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.length).toBeGreaterThan(0)
    expect(result.reason).not.toContain(SENTINEL)
    expect(result.reason).not.toContain('SENTINEL')
    expect(result.reason).toMatch(/^(input is (not a string|empty)|line \d+: [a-z ]+)$/)
  })

  test('rejection reasons name the zero-based line index of the first violation', () => {
    expect(decodeLedger('- [ ] a\n- [ ] b\n- [X] c')).toEqual({ ok: false, reason: 'line 2: malformed task line' })
    expect(decodeLedger('- [ ] a\n- [ ] b\n- [x] a')).toEqual({ ok: false, reason: 'line 2: duplicate label' })
    expect(decodeLedger('- [ ] a\n\n- [ ] b')).toEqual({ ok: false, reason: 'line 1: blank line' })
    expect(decodeLedger('- [ ] a\n- [ ] ')).toEqual({ ok: false, reason: 'line 1: empty label' })
    expect(decodeLedger('- [ ] a\t')).toEqual({ ok: false, reason: 'line 0: label contains a control character' })
    expect(decodeLedger('- [ ] a ')).toEqual({ ok: false, reason: 'line 0: label has leading or trailing whitespace' })
    expect(decodeLedger('')).toEqual({ ok: false, reason: 'input is empty' })
  })

  test('a single invalid line anywhere rejects the whole ledger (no partial decode)', () => {
    const result = decodeLedger('- [x] a\n- [ ] b\n- [ ] c\n- [X] d')
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('ledger')
  })

  test('decodeLedger never throws on hostile inputs', () => {
    const hostile: unknown[] = [Symbol('x'), () => '- [ ] a', 10n, Object.create(null), new Proxy({}, {})]
    for (const input of hostile) expect(() => decodeLedger(input)).not.toThrow()
    for (const input of hostile) expect(decodeLedger(input).ok).toBe(false)
  })
})

describe('decode and summary are pure', () => {
  test('a deep-frozen decoded ledger still summarizes and is not modified', () => {
    const ledger = deepFreeze(decoded(MIXED))
    const before = JSON.stringify(ledger)
    expect(summarizeLedger(ledger)).toEqual({ completed: 1, remaining: 2, firstUnchecked: '- [ ] T2 second' })
    expect(JSON.stringify(ledger)).toBe(before)
  })

  test('a caller-built ledger object is summarized without being modified', () => {
    const ledger: DecodedLedger = { tasks: [{ label: 'b', completed: false }, { label: 'a', completed: true }] }
    const before = JSON.stringify(ledger)
    expect(summarizeLedger(ledger)).toEqual({ completed: 1, remaining: 1, firstUnchecked: '- [ ] b' })
    expect(JSON.stringify(ledger)).toBe(before)
    expect(ledger.tasks[0]!.label).toBe('b')
  })

  test('each call returns fresh result objects', () => {
    const first = decodeLedger(MIXED)
    const second = decodeLedger(MIXED)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    if (!first.ok || !second.ok) throw new Error('expected accepted ledgers')
    expect(first.ledger).not.toBe(second.ledger)
    expect(first.ledger.tasks).not.toBe(second.ledger.tasks)
    expect(first.ledger.tasks[0]).not.toBe(second.ledger.tasks[0])
    const ledger = first.ledger
    const summaryA = summarizeLedger(ledger)
    const summaryB = summarizeLedger(ledger)
    expect(summaryA).toEqual(summaryB)
    expect(summaryA).not.toBe(summaryB)
  })

  test('the input string is unchanged and decoding it twice is stable', () => {
    const input = `${E2E_T1}\n${E2E_T2}\n`
    const copy = `${input}`
    expect(decodeLedger(input)).toEqual(decodeLedger(input))
    expect(input).toBe(copy)
  })
})
