import { describe, expect, test } from 'bun:test'
import {
  PINGPONG_LIMIT,
  REPEAT_IDENTICAL_LIMIT,
  checkToolCall,
  newDetectorState,
} from './tool-loop-detection.ts'

describe('tool-loop-detection', () => {
  test('allows the first call', () => {
    const state = newDetectorState('t1')
    const r = checkToolCall(state, { name: 'shell', input: { cmd: 'ls' } })
    expect(r.decision).toBe('allow')
    expect(state.history.length).toBe(1)
  })

  test('blocks repeated identical call after REPEAT_IDENTICAL_LIMIT', () => {
    const state = newDetectorState('t1')
    for (let i = 0; i < REPEAT_IDENTICAL_LIMIT; i++) {
      const r = checkToolCall(state, { name: 'shell', input: { cmd: 'ls' } })
      expect(r.decision).toBe('allow')
    }
    const blocked = checkToolCall(state, { name: 'shell', input: { cmd: 'ls' } })
    expect(blocked.decision).toBe('block')
    if (blocked.decision === 'block') {
      expect(blocked.reason).toMatch(/repeated_identical_call/)
    }
  })

  test('canonical-JSON: order-independent input hashing', () => {
    const state = newDetectorState('t1')
    checkToolCall(state, { name: 'edit', input: { a: 1, b: 2 } })
    checkToolCall(state, { name: 'edit', input: { b: 2, a: 1 } })
    checkToolCall(state, { name: 'edit', input: { a: 1, b: 2 } })
    const r = checkToolCall(state, { name: 'edit', input: { b: 2, a: 1 } })
    expect(r.decision).toBe('block')
  })

  test('different inputs of the same tool do not trigger the repeat signal', () => {
    const state = newDetectorState('t1')
    for (let i = 0; i < 5; i++) {
      const r = checkToolCall(state, { name: 'shell', input: { cmd: `ls ${i}` } })
      expect(r.decision).toBe('allow')
    }
  })

  test('non-consecutive identical calls do NOT block (Codex r1 P2 fix)', () => {
    // Pattern: A, B, A, C, A — three A's but never consecutive. The repeat
    // signal must only fire on a consecutive tail of identical calls.
    const state = newDetectorState('t1')
    expect(checkToolCall(state, { name: 'A', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'B', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'A', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'C', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'A', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'D', input: {} }).decision).toBe('allow')
    expect(checkToolCall(state, { name: 'A', input: {} }).decision).toBe('allow')
  })

  test('three consecutive identical calls block on the fourth', () => {
    const state = newDetectorState('t1')
    for (let i = 0; i < 3; i++) {
      expect(checkToolCall(state, { name: 'shell', input: { cmd: 'ls' } }).decision).toBe('allow')
    }
    expect(checkToolCall(state, { name: 'shell', input: { cmd: 'ls' } }).decision).toBe('block')
  })

  test('blocks ping-pong A↔B for PINGPONG_LIMIT cycles', () => {
    const state = newDetectorState('t1')
    // Build up alternating A B A B ... — last call before threshold.
    for (let i = 0; i < 2 * PINGPONG_LIMIT - 1; i++) {
      const name = i % 2 === 0 ? 'A' : 'B'
      const r = checkToolCall(state, { name, input: { i } })
      expect(r.decision).toBe('allow')
    }
    // Next alternation completes 2*K alternation length and should block.
    const expectedNext = (2 * PINGPONG_LIMIT - 1) % 2 === 0 ? 'A' : 'B'
    const r = checkToolCall(state, { name: expectedNext, input: { final: true } })
    expect(r.decision).toBe('block')
    if (r.decision === 'block') expect(r.reason).toMatch(/pingpong/)
  })

  test('three-tool rotation does NOT trigger ping-pong (only A↔B is ping-pong)', () => {
    const state = newDetectorState('t1')
    for (let i = 0; i < 12; i++) {
      const name = ['A', 'B', 'C'][i % 3]!
      const r = checkToolCall(state, { name, input: { i } })
      expect(r.decision).toBe('allow')
    }
  })

  test('ring-buffer trims at 50 entries', () => {
    const state = newDetectorState('t1')
    for (let i = 0; i < 100; i++) {
      checkToolCall(state, { name: `tool_${i}`, input: { i } })
    }
    expect(state.history.length).toBe(50)
  })
})
