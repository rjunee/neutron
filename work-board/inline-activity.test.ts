import { describe, expect, test } from 'bun:test'

import {
  deriveInlineActive,
  INLINE_EVIDENCE_WINDOW_MS,
  type InlineActivityScanItem,
} from './inline-activity.ts'

const NOW = 1_755_000_000_000

function mk(overrides: Partial<InlineActivityScanItem> = {}): InlineActivityScanItem {
  return {
    status: 'upcoming',
    inline_active: false,
    linked_run_id: null,
    ...overrides,
  }
}

describe('deriveInlineActive', () => {
  test('(a) fresh evidence activates in-progress work without a flag write', () => {
    // Pins the flag-only mutant.
    expect(deriveInlineActive(mk({ status: 'in_progress' }), { now: NOW, last_real_activity_at: NOW - 1_000 })).toBe(true)
  })

  test('a flag hint lights only when corroborated by fresh evidence', () => {
    expect(deriveInlineActive(mk({ inline_active: true }), { now: NOW, last_real_activity_at: NOW - 1_000 })).toBe(true)
  })

  test('(b) absent evidence defeats a stale flag after a crash or restart', () => {
    expect(deriveInlineActive(mk({ status: 'in_progress', inline_active: true }), { now: NOW, last_real_activity_at: 0 })).toBe(false)
  })

  test('(b) evidence exactly at the window is stale; one millisecond fresher is active', () => {
    const item = mk({ status: 'in_progress', inline_active: true })
    expect(deriveInlineActive(item, { now: NOW, last_real_activity_at: NOW - INLINE_EVIDENCE_WINDOW_MS })).toBe(false)
    expect(deriveInlineActive(item, { now: NOW, last_real_activity_at: NOW - INLINE_EVIDENCE_WINDOW_MS + 1 })).toBe(true)
  })

  test('(c) LATCH-PROOF: advancing only now turns a formerly active card off', () => {
    // A derivation that can only turn on is a worse lie than the flag.
    const item = mk({ status: 'in_progress', inline_active: true })
    const lastReal = NOW - 1_000
    expect(deriveInlineActive(item, { now: NOW, last_real_activity_at: lastReal })).toBe(true)
    expect(deriveInlineActive(item, { now: lastReal + INLINE_EVIDENCE_WINDOW_MS, last_real_activity_at: lastReal })).toBe(false)
  })

  test('(c) fresh evidence alone does not make upcoming unflagged work active', () => {
    // Pins the unconditional-true mutant.
    expect(deriveInlineActive(mk(), { now: NOW, last_real_activity_at: NOW - 1_000 })).toBe(false)
  })

  test('R1: terminal cards never claim inline activity', () => {
    for (const status of ['done', 'failed']) {
      expect(deriveInlineActive(mk({ status, inline_active: true }), { now: NOW, last_real_activity_at: NOW - 1 })).toBe(false)
    }
  })

  test('R2: a run-bound card uses the fork lane instead of inline evidence', () => {
    expect(deriveInlineActive(mk({ status: 'in_progress', linked_run_id: 'run-1' }), { now: NOW, last_real_activity_at: NOW - 1 })).toBe(false)
  })

  test('respects a window_ms override with the same stale boundary', () => {
    const item = mk({ status: 'in_progress' })
    expect(deriveInlineActive(item, { now: NOW, last_real_activity_at: NOW - 5, window_ms: 10 })).toBe(true)
    expect(deriveInlineActive(item, { now: NOW, last_real_activity_at: NOW - 10, window_ms: 10 })).toBe(false)
  })
})
