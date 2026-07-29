import { describe, expect, test } from 'bun:test'
import {
  TELEGRAM_MESSAGE_MAX_UTF16,
  countUtf16,
  truncateForTelegram,
} from './adapters/telegram/utf16-truncation.ts'

describe('truncateForTelegram', () => {
  test('returns input unchanged when under the budget', () => {
    const text = 'hello world'
    expect(truncateForTelegram(text)).toBe(text)
  })

  test('truncates ASCII to budget with ellipsis appended', () => {
    const text = 'a'.repeat(TELEGRAM_MESSAGE_MAX_UTF16 + 100)
    const truncated = truncateForTelegram(text)
    expect(truncated.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_UTF16)
    expect(truncated.endsWith('…')).toBe(true)
  })

  test('respects per-call max_utf16 override', () => {
    const text = 'a'.repeat(50)
    expect(truncateForTelegram(text, { max_utf16: 10 })).toHaveLength(10)
  })

  test('preserves surrogate pairs (non-BMP emoji)', () => {
    // 🌌 = U+1F30C, 2 UTF-16 code units. Pad with 'a' so the budget hit lands
    // exactly inside the surrogate pair.
    const emoji = '\u{1F30C}'
    expect(emoji.length).toBe(2)
    const head = 'a'.repeat(8) // 8 chars
    const text = head + emoji // 10 chars total
    // Set max so the cut would land mid-pair if we naively sliced (10 - 1 = 9)
    const truncated = truncateForTelegram(text, { max_utf16: 9, append_ellipsis: false })
    // If we backed off correctly the head is 8 chars (no broken pair); without
    // backoff the slice would include the high surrogate alone (length 9) which
    // is invalid UTF-16. Either way, the surrogate must NOT be split.
    expect(truncated).toBe(head)
    expect(truncated.length).toBe(8)
  })

  test('append_ellipsis: false returns no suffix', () => {
    const text = 'a'.repeat(TELEGRAM_MESSAGE_MAX_UTF16 + 50)
    const truncated = truncateForTelegram(text, { append_ellipsis: false })
    expect(truncated.length).toBe(TELEGRAM_MESSAGE_MAX_UTF16)
    expect(truncated.endsWith('…')).toBe(false)
  })
})

describe('truncateForTelegram — markdown_v2 (Argus BLOCKING #1)', () => {
  test('rewinds before a trailing `[` so the link is fully excised', () => {
    const head = '.'.repeat(5000) // each `.` is one UTF-16 code unit
    const text = head + '[L](docs:/p/x.md)'
    const out = truncateForTelegram(text, { markdown_v2: true })
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_UTF16)
    expect(out).not.toContain('[')
    expect(out).not.toContain('](')
    expect(out.endsWith('…')).toBe(true)
  })

  test('rewinds out of mid-link cut (link straddles the budget)', () => {
    // Construct a link wide enough that its `[` falls before the
    // budget but its closing `)` sits after.
    const head = '.'.repeat(4080)
    const text = head + '[' + 'L'.repeat(40) + '](docs:/p/x.md)'
    const out = truncateForTelegram(text, { markdown_v2: true })
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_UTF16)
    expect(out).not.toContain('[')
    expect(out).not.toContain('](')
  })

  test('rewinds away from a trailing lone backslash', () => {
    // Craft text whose budget-position char is a `\` opening an
    // escape that doesn't fit. The plain cut would leave a dangling
    // `\` immediately before the ellipsis; the entity-aware cut
    // must back off by one.
    const budgetMinusOne = TELEGRAM_MESSAGE_MAX_UTF16 - 1
    const text = '.'.repeat(budgetMinusOne - 1) + '\\.x'.repeat(50)
    const out = truncateForTelegram(text, { markdown_v2: true })
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_UTF16)
    expect(out.endsWith('\\…')).toBe(false)
    // No dangling backslash at the truncation boundary.
    const stripped = out.replace(/…$/, '')
    expect(stripped.endsWith('\\')).toBe(false)
  })

  test('returns input unchanged when under the budget regardless of markdown_v2 flag', () => {
    const text = 'hello [L](docs:/p/x.md) world'
    expect(truncateForTelegram(text, { markdown_v2: true })).toBe(text)
  })
})

describe('countUtf16', () => {
  test('counts BMP code points as 1', () => {
    expect(countUtf16('hello')).toBe(5)
    expect(countUtf16('Привет')).toBe(6) // Cyrillic chars are BMP
  })
  test('counts non-BMP characters as surrogate pairs (2)', () => {
    expect(countUtf16('🌌')).toBe(2)
  })
})
