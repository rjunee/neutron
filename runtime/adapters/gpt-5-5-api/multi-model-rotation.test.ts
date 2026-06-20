import { describe, expect, test } from 'bun:test'

import {
  currentModel,
  newRotationState,
  rotate,
} from './multi-model-rotation.ts'

describe('gpt-5-5-api multi-model rotation', () => {
  test('currentModel returns the first preference initially', () => {
    const s = newRotationState(['gpt-5-5-pro', 'gpt-5-5'])
    const d = currentModel(s)
    expect(d.decision).toBe('use')
    if (d.decision === 'use') expect(d.model).toBe('gpt-5-5-pro')
  })

  test('rotate advances to the next model and reports decision=rotate', () => {
    const s = newRotationState(['gpt-5-5-pro', 'gpt-5-5'])
    const d = rotate(s)
    expect(d.decision).toBe('rotate')
    if (d.decision === 'rotate') {
      expect(d.model).toBe('gpt-5-5')
      expect(d.attempt_idx).toBe(1)
    }
  })

  test('rotate past the last entry returns exhausted', () => {
    const s = newRotationState(['only'])
    expect(rotate(s).decision).toBe('exhausted')
  })

  test('rotate carries delay_ms from retry_after_ms when supplied', () => {
    const s = newRotationState(['a', 'b'])
    const d = rotate(s, 1234)
    expect(d.decision).toBe('rotate')
    if (d.decision === 'rotate') expect(d.delay_ms).toBe(1234)
  })

  test('empty preference list reports exhausted on first currentModel', () => {
    const s = newRotationState([])
    expect(currentModel(s).decision).toBe('exhausted')
  })
})
