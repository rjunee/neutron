import { expect, test } from 'bun:test'

import { sanitizeUserFirstName } from '../extracted-fields.ts'

// The trailing-punctuation strip was moved off `/[.,;:!?]+$/u` (a
// `js/polynomial-redos` HIGH) onto a linear backward scan. These cases pin
// the unchanged behaviour plus a pathological-input guard.

test('sanitizeUserFirstName strips trailing punctuation (regex parity)', () => {
  expect(sanitizeUserFirstName('Sam.')).toBe('Sam')
  expect(sanitizeUserFirstName('Sam,')).toBe('Sam')
  expect(sanitizeUserFirstName('Sam!!!')).toBe('Sam')
  expect(sanitizeUserFirstName('Jo?')).toBe('Jo')
})

test('sanitizeUserFirstName takes the first token and rejects non-names', () => {
  expect(sanitizeUserFirstName('  Alex   Smith ')).toBe('Alex')
  expect(sanitizeUserFirstName('!!!')).toBeNull() // strips to empty
  expect(sanitizeUserFirstName('yeah')).toBeNull() // stop-word
  expect(sanitizeUserFirstName('')).toBeNull()
})

test('sanitizeUserFirstName completes in <50ms on adversarial punctuation input', () => {
  // `'!'.repeat(n) + 'a'` is the pathological case for the old
  // `/[.,;:!?]+$/u`: the `+` matches every `!`, `$` fails on the trailing
  // `a`, and the match restarts at every offset — O(n²). The linear scan
  // strips no trailing run (last char is `a`); the over-length input is then
  // rejected as a name.
  const evil = '!'.repeat(500_000) + 'a'
  const t0 = performance.now()
  const out = sanitizeUserFirstName(evil)
  const elapsed = performance.now() - t0
  expect(out).toBeNull()
  expect(elapsed).toBeLessThan(50)
})
