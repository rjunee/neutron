import { describe, test, expect } from 'bun:test'
import { constantTimeEqual } from '../constant-time-equal.ts'

describe('constantTimeEqual — pinned semantics (P3-10 consolidation)', () => {
  test('equal strings compare true; any difference compares false', () => {
    expect(constantTimeEqual('hunter2', 'hunter2')).toBe(true)
    expect(constantTimeEqual('hunter2', 'hunter3')).toBe(false)
  })

  test('unequal lengths return false (the mandatory length pre-check, never throws)', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
    expect(constantTimeEqual('x', '')).toBe(false)
  })

  test('empty vs empty is equal (callers add their own non-empty guards)', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  test('Buffer inputs compare as-is without re-encoding', () => {
    const a = Buffer.from([1, 2, 3])
    const b = Buffer.from([1, 2, 3])
    const c = Buffer.from([1, 2, 4])
    expect(constantTimeEqual(a, b)).toBe(true)
    expect(constantTimeEqual(a, c)).toBe(false)
  })

  test('encoding override is honoured (hex vs default utf8 differ)', () => {
    // 'ab' as hex decodes to one byte 0xab; as utf8 it is two bytes — different lengths.
    expect(constantTimeEqual('ab', 'ab', 'hex')).toBe(true)
    expect(constantTimeEqual('deadbeef', 'deadbeef', 'hex')).toBe(true)
    expect(constantTimeEqual('deadbeef', 'deadbe00', 'hex')).toBe(false)
  })
})
