/**
 * channel-unwired-detector.test.ts — the channel-MCP-unwired signature (port
 * row #6). Asserts the live signature fires, and that the F3 doc-quote guard
 * (fenced / backtick / diff) keeps a quotation of the phrase from false-firing.
 */

import { describe, it, expect } from 'bun:test'
import {
  channelUnwiredSignaturePresent,
  CHANNEL_UNWIRED_BOTTOM_N,
} from '../channel-unwired-detector.ts'

describe('channelUnwiredSignaturePresent', () => {
  it('fires on the live unwired error frame', () => {
    const ring = [
      '⏺ reply("on it")',
      '⎿ Error: no MCP server configured with that name',
      '',
    ].join('\n')
    expect(channelUnwiredSignaturePresent(ring)).toBe(true)
  })

  it('survives Ink per-word cursor shredding (whitespace-stripped match)', () => {
    // The Ink TUI never emits the phrase contiguously; the normalized form
    // collapses the rendering. Extra interior whitespace must still match.
    const ring = 'no   MCP\tserver  configured   with that    name'
    expect(channelUnwiredSignaturePresent(ring)).toBe(true)
  })

  it('does NOT fire on a backtick-wrapped quotation of the phrase', () => {
    const ring = 'The wedge prints `no MCP server configured with that name` as its last frame.'
    expect(channelUnwiredSignaturePresent(ring)).toBe(false)
  })

  it('does NOT fire inside a fenced code block', () => {
    const ring = [
      '```',
      'no MCP server configured with that name',
      '```',
    ].join('\n')
    expect(channelUnwiredSignaturePresent(ring)).toBe(false)
  })

  it('does NOT fire on a diff-quoted line', () => {
    const ring = '- no MCP server configured with that name'
    expect(channelUnwiredSignaturePresent(ring)).toBe(false)
  })

  it('does NOT fire on a clean, healthy ring', () => {
    const ring = [
      '⏺ reply("done — pushed the branch")',
      '⎿ ok',
      '',
    ].join('\n')
    expect(channelUnwiredSignaturePresent(ring)).toBe(false)
  })

  it('only inspects the bottom-N window', () => {
    // Push the signature far above the bottom-N window with filler; it must NOT
    // fire (the error renders as a recent frame, not buried scrollback).
    const filler = Array.from({ length: CHANNEL_UNWIRED_BOTTOM_N + 5 }, (_, i) => `line ${i}`)
    const ring = ['no MCP server configured with that name', ...filler].join('\n')
    expect(channelUnwiredSignaturePresent(ring)).toBe(false)
  })
})
