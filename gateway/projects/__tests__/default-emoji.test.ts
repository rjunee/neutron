/**
 * Unit tests for the deterministic default-emoji picker (rail-redesign).
 */

import { describe, test, expect } from 'bun:test'
import {
  defaultProjectEmoji,
  resolveProjectEmoji,
  normaliseEmojiInput,
  GENERAL_EMOJI,
} from '../default-emoji.ts'

describe('defaultProjectEmoji', () => {
  test('picks a themed glyph for a keyword in the name (case-insensitive)', () => {
    expect(defaultProjectEmoji('Marathon training plan')).toBe('🏃')
    expect(defaultProjectEmoji('Read more BOOKS')).toBe('📚')
    expect(defaultProjectEmoji('side coding project')).toBe('💻')
    expect(defaultProjectEmoji('Family Budget')).toBe('💰')
  })

  test('is deterministic — same name → same glyph', () => {
    const a = defaultProjectEmoji('My Weird Untagged Thing')
    const b = defaultProjectEmoji('My Weird Untagged Thing')
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  test('distinct un-keyworded names map across the palette (not all identical)', () => {
    const names = ['alpha zzz', 'qwerty vvv', 'zzxxcc', 'plumbus', 'grackle', 'wibble']
    const glyphs = new Set(names.map(defaultProjectEmoji))
    // Not a guarantee of all-distinct, but the hash should spread more than one.
    expect(glyphs.size).toBeGreaterThan(1)
  })

  test('empty / whitespace name falls back to a generic glyph', () => {
    expect(defaultProjectEmoji('')).toBe('📁')
    expect(defaultProjectEmoji('   ')).toBe('📁')
  })
})

describe('resolveProjectEmoji', () => {
  test('prefers a stored non-empty emoji', () => {
    expect(resolveProjectEmoji('🎯', 'Read books')).toBe('🎯')
  })

  test('falls back to the deterministic default when stored is null/empty', () => {
    expect(resolveProjectEmoji(null, 'Read books')).toBe('📚')
    expect(resolveProjectEmoji('', 'Read books')).toBe('📚')
    expect(resolveProjectEmoji('   ', 'Read books')).toBe('📚')
    expect(resolveProjectEmoji(undefined, 'Read books')).toBe('📚')
  })

  test('GENERAL_EMOJI is a stable non-empty glyph', () => {
    expect(GENERAL_EMOJI.length).toBeGreaterThan(0)
  })
})

describe('normaliseEmojiInput', () => {
  test('accepts a single emoji and trims it', () => {
    expect(normaliseEmojiInput('🎨')).toBe('🎨')
    expect(normaliseEmojiInput('  🚀 ')).toBe('🚀')
  })

  test('accepts multi-codepoint emoji (ZWJ / skin tone) within bounds', () => {
    expect(normaliseEmojiInput('🏋️')).toBe('🏋️')
    expect(normaliseEmojiInput('👍🏽')).toBe('👍🏽')
  })

  test('rejects plain ASCII text', () => {
    expect(normaliseEmojiInput('hello')).toBeNull()
    expect(normaliseEmojiInput('x')).toBeNull()
    expect(normaliseEmojiInput('123')).toBeNull()
  })

  test('rejects empty and over-long input', () => {
    expect(normaliseEmojiInput('')).toBeNull()
    expect(normaliseEmojiInput('   ')).toBeNull()
    expect(normaliseEmojiInput('🎨'.repeat(20))).toBeNull()
  })

  test('rejects non-string input', () => {
    expect(normaliseEmojiInput(42)).toBeNull()
    expect(normaliseEmojiInput(null)).toBeNull()
    expect(normaliseEmojiInput(undefined)).toBeNull()
  })
})
