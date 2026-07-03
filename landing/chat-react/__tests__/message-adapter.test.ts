import { describe, expect, it } from 'bun:test'

import type { RenderMessage } from '../controller.ts'
import { absolutize, normalizeBody, toThreadMessage } from '../message-adapter.ts'

function msg(over: Partial<RenderMessage> = {}): RenderMessage {
  return {
    id: 'm1',
    messageId: 'm1',
    role: 'user',
    text: 'hello',
    status: 'acked',
    streaming: false,
    attachments: null,
    createdAt: 1,
    timestampMs: null,
    delivery: null,
    reactions: [],
    edited: false,
    deleted: false,
    options: null,
    promptId: null,
    allowFreeform: null,
    kind: null,
    uploadAffordance: null,
    chosenValue: null,
    ...over,
  }
}

describe('absolutize', () => {
  it('passes through absolute https/data/blob URLs', () => {
    expect(absolutize('https://x/y.png', 'https://o')).toBe('https://x/y.png')
    expect(absolutize('data:image/png;base64,AAAA', 'https://o')).toBe('data:image/png;base64,AAAA')
    expect(absolutize('blob:abc', 'https://o')).toBe('blob:abc')
  })
  it('absolutizes a gateway-relative URL against the origin', () => {
    expect(absolutize('/api/app/upload/9.png', 'https://o.test')).toBe('https://o.test/api/app/upload/9.png')
  })
})

describe('toThreadMessage', () => {
  it('maps a user message to a user ThreadMessageLike with a text part', () => {
    const t = toThreadMessage(msg({ role: 'user', text: 'hi' }))
    expect(t.role).toBe('user')
    expect(t.content).toEqual([{ type: 'text', text: 'hi' }])
    // user messages never carry a status (assistant-only field).
    expect('status' in t).toBe(false)
  })

  it('maps an agent message to an assistant role with a complete status', () => {
    const t = toThreadMessage(msg({ role: 'agent', text: 'yo', streaming: false }))
    expect(t.role).toBe('assistant')
    expect(t.status).toEqual({ type: 'complete', reason: 'stop' })
  })

  it('marks a streaming agent bubble as running', () => {
    const t = toThreadMessage(msg({ role: 'agent', text: 'partial', streaming: true }))
    expect(t.status).toEqual({ type: 'running' })
  })

  it('renders image attachments as absolutized image parts', () => {
    const t = toThreadMessage(
      msg({ role: 'user', text: '', attachments: ['/api/app/upload/1.png'] }),
      'https://o.test',
    )
    expect(t.content).toEqual([{ type: 'image', image: 'https://o.test/api/app/upload/1.png' }])
  })

  it('renders non-image attachments as a text link', () => {
    const t = toThreadMessage(msg({ role: 'user', text: 'see', attachments: ['https://x/doc.pdf'] }))
    expect(t.content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'text', text: '📎 https://x/doc.pdf' },
    ])
  })

  it('seeds an empty text part for an empty streaming bubble', () => {
    const t = toThreadMessage(msg({ role: 'agent', text: '', streaming: true }))
    expect(t.content).toEqual([{ type: 'text', text: '' }])
  })

  it('renders a deleted message as a tombstone placeholder, ignoring body + attachments (Track B Phase 4)', () => {
    const t = toThreadMessage(
      msg({ role: 'user', text: '', deleted: true, attachments: ['https://x/doc.pdf'] }),
    )
    expect(t.content).toEqual([{ type: 'text', text: '🚫 This message was deleted' }])
  })

  // Chat-bubble height fix: a stray trailing/leading newline renders as an extra
  // empty line under `white-space: pre-line`/`pre-wrap`, making a one-line bubble
  // ~2x tall. toThreadMessage must trim the ends so the bubble hugs its text.
  it('strips a trailing newline from a one-line user body', () => {
    const t = toThreadMessage(msg({ role: 'user', text: 'Ryan\n' }))
    expect(t.content).toEqual([{ type: 'text', text: 'Ryan' }])
  })

  it('strips a leading newline from an agent body', () => {
    const t = toThreadMessage(msg({ role: 'agent', text: '\nyo' }))
    expect(t.content).toEqual([{ type: 'text', text: 'yo' }])
  })

  it('drops a whitespace-only body to no text part (renders no bubble line)', () => {
    const t = toThreadMessage(msg({ role: 'user', text: '\n \n' }))
    // whitespace-only trims to '' → no text part is pushed (empty content fallback)
    expect(t.content).toEqual([{ type: 'text', text: '' }])
  })
})

describe('normalizeBody', () => {
  it('strips leading newlines and all trailing whitespace', () => {
    expect(normalizeBody('Ryan\n')).toBe('Ryan')
    expect(normalizeBody('\n\nRyan')).toBe('Ryan')
    expect(normalizeBody('Ryan  \n')).toBe('Ryan')
  })

  it('preserves LEADING horizontal whitespace (Markdown indented code block)', () => {
    // A response opening with a 4-space indent is a Markdown code block — must
    // survive normalization (Codex P2). Only newlines/trailing space are stray.
    expect(normalizeBody('    npm test')).toBe('    npm test')
    expect(normalizeBody('\n    npm test\n')).toBe('    npm test')
  })

  it('preserves intentional INTERNAL blank lines (real multi-line message)', () => {
    expect(normalizeBody('line1\n\nline2\n')).toBe('line1\n\nline2')
    expect(normalizeBody('a\nb\nc')).toBe('a\nb\nc')
  })
})
