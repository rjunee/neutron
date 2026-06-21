import { describe, expect, it } from 'bun:test'

import type { RenderMessage } from '../controller.ts'
import { absolutize, toThreadMessage } from '../message-adapter.ts'

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
    delivery: null,
    reactions: [],
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
})
