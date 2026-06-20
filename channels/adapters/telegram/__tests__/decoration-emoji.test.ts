/**
 * Unit tests for the Bot API 9.6 emoji + style polish (P2 S5).
 *
 * Asserts:
 *   - Each known action_kind maps to its emoji + style.
 *   - destructive sets style='destructive'; every other kind leaves style undefined.
 *   - Missing metadata / unknown action_kind falls through cleanly.
 *   - Idempotent: a label that already starts with the emoji is not double-prefixed.
 */

import { describe, expect, test } from 'bun:test'
import {
  decorateButtonForTelegram,
  KNOWN_ACTION_KINDS,
  type ButtonActionKind,
} from '../decoration-emoji.ts'
import type { ButtonOption } from '../../../button-primitive.ts'

function opt(extra: Partial<ButtonOption>): ButtonOption {
  return {
    label: 'A',
    body: 'a',
    value: 'a',
    ...extra,
  }
}

describe('decorateButtonForTelegram', () => {
  const expectedEmoji: Record<ButtonActionKind, string> = {
    confirm: '✅',
    destructive: '⚠️',
    skip: '↩️',
    edit: '📝',
    send: '📤',
    cancel: '✖️',
    continue: '➡️',
    back: '⬅️',
  }

  test('every known action_kind maps to its expected emoji', () => {
    for (const kind of KNOWN_ACTION_KINDS) {
      const decorated = decorateButtonForTelegram(opt({ metadata: { action_kind: kind } }))
      expect(decorated.label.startsWith(expectedEmoji[kind])).toBe(true)
    }
  })

  test('destructive maps to style=destructive', () => {
    const decorated = decorateButtonForTelegram(opt({ metadata: { action_kind: 'destructive' } }))
    expect(decorated.style).toBe('destructive')
  })

  test('non-destructive kinds leave style undefined', () => {
    for (const kind of KNOWN_ACTION_KINDS) {
      if (kind === 'destructive') continue
      const decorated = decorateButtonForTelegram(opt({ metadata: { action_kind: kind } }))
      expect(decorated.style).toBeUndefined()
    }
  })

  test('missing metadata falls through cleanly', () => {
    const decorated = decorateButtonForTelegram(opt({}))
    expect(decorated.label).toBe('A')
    expect(decorated.style).toBeUndefined()
  })

  test('unknown action_kind falls through cleanly', () => {
    const decorated = decorateButtonForTelegram(
      opt({ label: 'Maybe', metadata: { action_kind: 'frobnicate' } }),
    )
    expect(decorated.label).toBe('Maybe')
    expect(decorated.style).toBeUndefined()
  })

  test('non-string action_kind falls through cleanly', () => {
    // The typed contract uses string for action_kind; this test
    // exercises the runtime defense-in-depth check by injecting a
    // non-string value (production callers can't reach this path
    // through the typed primitive but a corrupted persisted prompt
    // could).
    const broken = opt({
      label: 'X',
      metadata: { action_kind: 42 as unknown as string },
    })
    const decorated = decorateButtonForTelegram(broken)
    expect(decorated.label).toBe('X')
  })

  test('idempotent — already-prefixed label is not re-prefixed', () => {
    const decorated = decorateButtonForTelegram(
      opt({ label: '✅ Confirm', metadata: { action_kind: 'confirm' } }),
    )
    expect(decorated.label).toBe('✅ Confirm')
  })
})
