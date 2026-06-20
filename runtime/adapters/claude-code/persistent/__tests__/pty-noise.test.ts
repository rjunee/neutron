/**
 * Ported from Nova `gateway/tests/pty-spawn.test.ts` (stripPtyNoise block).
 * The DCS/CR strip discipline is lifted verbatim (`pty-noise.ts`); these cases
 * port 1:1. The Nova libc-FFI real-PTY block is dropped — Neutron's backend is
 * Bun-native (`bun-terminal-host.ts`), exercised by the live round-trip proof.
 */

import { describe, expect, test } from 'bun:test'
import { newDcsStripState, stripPtyNoise } from '../pty-noise.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function feed(state: ReturnType<typeof newDcsStripState>, raw: string): string {
  return dec.decode(stripPtyNoise(enc.encode(raw), state))
}

describe('stripPtyNoise', () => {
  test('strips CR characters', () => {
    const s = newDcsStripState()
    expect(feed(s, 'hello\r\nworld\r\n')).toBe('hello\nworld\n')
  })

  test('strips DCS introducer + ST wrapper, preserves payload', () => {
    const s = newDcsStripState()
    const wrapped = '\x1bP1000p%begin 0 1 0\nhello\n%end 0 1 0\n\x1b\\'
    expect(feed(s, wrapped)).toBe('%begin 0 1 0\nhello\n%end 0 1 0\n')
  })

  test('DCS strip handles introducer split across chunks', () => {
    const s = newDcsStripState()
    expect(feed(s, '\x1b')).toBe('')
    expect(feed(s, 'P1000pbody\x1b\\')).toBe('body')
  })

  test('lone ESC followed by non-P emits the ESC + payload', () => {
    const s = newDcsStripState()
    expect(feed(s, '\x1b')).toBe('')
    expect(feed(s, 'X')).toBe('\x1bX')
  })

  test('lone ESC followed by another lone ESC keeps buffering', () => {
    const s = newDcsStripState()
    expect(feed(s, '\x1b')).toBe('')
    expect(feed(s, '\x1b')).toBe('\x1b')
    expect(feed(s, 'P1000pX\x1b\\')).toBe('X')
  })

  test('DCS strip handles ST split across chunks', () => {
    const s = newDcsStripState()
    expect(feed(s, '\x1bP1000pbody')).toBe('body')
    expect(feed(s, '\x1b')).toBe('')
    expect(feed(s, '\\after')).toBe('after')
  })

  test('payload that happens to contain ESC inside DCS — drops the ESC, keeps rest', () => {
    const s = newDcsStripState()
    expect(feed(s, '\x1bP1000pX\x1bYZ\x1b\\')).toBe('XYZ')
  })

  test('idle state passes plain text through unchanged', () => {
    const s = newDcsStripState()
    expect(feed(s, 'hello world')).toBe('hello world')
  })

  test('empty chunk returns empty', () => {
    const s = newDcsStripState()
    expect(feed(s, '')).toBe('')
  })
})
