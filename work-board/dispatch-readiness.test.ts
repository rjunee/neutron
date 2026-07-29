import { describe, expect, test } from 'bun:test'
import { assessDispatchReadiness, MIN_DETAIL_WORDS } from './dispatch-readiness.ts'

describe('assessDispatchReadiness — the ask-before-acting gate predicate', () => {
  test('a design_doc_ref makes even a terse title ready', () => {
    const r = assessDispatchReadiness({ title: 'auth', design_doc_ref: 'https://docs/auth' })
    expect(r.ready).toBe(true)
    expect(r.reason).toBeUndefined()
  })

  test('a detailed title (>= MIN_DETAIL_WORDS) is ready without a design doc', () => {
    const words = Array.from({ length: MIN_DETAIL_WORDS }, (_, i) => `word${i}`).join(' ')
    const r = assessDispatchReadiness({ title: words, design_doc_ref: null })
    expect(r.ready).toBe(true)
  })

  test('a terse stub title with no design doc is NOT ready + carries clarifying guidance', () => {
    const r = assessDispatchReadiness({ title: 'fix login', design_doc_ref: null })
    expect(r.ready).toBe(false)
    expect(r.reason).toBeDefined()
    expect(r.reason!.toLowerCase()).toContain('underspecified')
    expect(r.reason!.toLowerCase()).toContain('ask the owner')
  })

  test('an empty/whitespace design_doc_ref does not count as specified', () => {
    expect(assessDispatchReadiness({ title: 'x', design_doc_ref: '   ' }).ready).toBe(false)
  })

  test('exactly MIN_DETAIL_WORDS is the boundary (one fewer is not ready)', () => {
    const ready = Array.from({ length: MIN_DETAIL_WORDS }, () => 'w').join(' ')
    const notReady = Array.from({ length: MIN_DETAIL_WORDS - 1 }, () => 'w').join(' ')
    expect(assessDispatchReadiness({ title: ready, design_doc_ref: null }).ready).toBe(true)
    expect(assessDispatchReadiness({ title: notReady, design_doc_ref: null }).ready).toBe(false)
  })
})
