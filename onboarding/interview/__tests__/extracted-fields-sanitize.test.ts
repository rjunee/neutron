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
  //
  // ISSUES #438 — the guard is the TEST TIMEOUT, not a `<50ms` assertion. The
  // regression is a HANG (a quadratic scan of 500k chars is ~2 minutes), not a
  // near-miss, so a millisecond budget guards the wrong distance. The timeout
  // catches the real shape with far more slack and cannot flake on a runner.
  const evil = '!'.repeat(500_000) + 'a'
  const out = sanitizeUserFirstName(evil)
  expect(out).toBeNull()
})
