/**
 * keystrokes.test.ts — F2: structured keystroke byte encodings. Verifies each
 * named key maps to the exact terminal bytes a real keypress emits, digit keys
 * pass through, multi-key sequences concatenate, and an unknown key throws.
 */

import { describe, expect, test } from 'bun:test'
import { encodeKey, encodeKeys, type Key } from '../keystrokes.ts'

describe('encodeKey', () => {
  test('enter is carriage return', () => {
    expect(encodeKey('enter')).toBe('\r')
    expect(encodeKey('enter')).toBe('\x0d')
  })

  test('escape is 0x1b', () => {
    expect(encodeKey('escape')).toBe('\x1b')
  })

  test('ctrl-c is 0x03', () => {
    expect(encodeKey('ctrl-c')).toBe('\x03')
  })

  test('tab is 0x09', () => {
    expect(encodeKey('tab')).toBe('\t')
  })

  test('arrow keys are the xterm CSI sequences', () => {
    expect(encodeKey('up')).toBe('\x1b[A')
    expect(encodeKey('down')).toBe('\x1b[B')
    expect(encodeKey('right')).toBe('\x1b[C')
    expect(encodeKey('left')).toBe('\x1b[D')
  })

  test('digit keys pass through as their literal character', () => {
    expect(encodeKey('0')).toBe('0')
    expect(encodeKey('1')).toBe('1')
    expect(encodeKey('3')).toBe('3')
    expect(encodeKey('9')).toBe('9')
  })

  test('an unknown key throws', () => {
    expect(() => encodeKey('bogus' as Key)).toThrow(/unknown key/)
  })
})

describe('encodeKeys', () => {
  test('empty sequence encodes to empty string', () => {
    expect(encodeKeys([])).toBe('')
  })

  test('navigate-down-then-select picks the second picker option', () => {
    // Arrow-driven Ink picker: Down moves the cursor, Enter selects.
    expect(encodeKeys(['down', 'enter'])).toBe('\x1b[B\r')
  })

  test('numbered-option auto-stop: digit then enter', () => {
    // /rate-limit-options "Stop and wait" = option 3 → "3" + Enter.
    expect(encodeKeys(['3', 'enter'])).toBe('3\r')
  })

  test('double-escape recovery sequence', () => {
    expect(encodeKeys(['escape', 'escape'])).toBe('\x1b\x1b')
  })
})
