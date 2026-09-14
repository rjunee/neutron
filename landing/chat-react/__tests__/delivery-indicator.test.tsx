import { describe, expect, it } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '@neutronai/chat-core'
import { deliveryFor } from '../controller.ts'
import { DeliveryIndicator } from '../DeliveryIndicator.tsx'

describe('delivery evidence reaches the web indicator', () => {
  it.each([
    ['sent', 'pending', '🕓', 'Message pending acknowledgement'],
    ['failed', 'failed', '⚠️', 'Message failed to send — retry'],
    ['acked', 'delivered', '✓✓', 'Message delivered'],
  ] as const)('%s renders as %s', (status, expected, glyph, label) => {
    const message: ChatMessage = {
      topic_id: 'test', client_msg_id: 'message-1', message_id: null,
      seq: null, role: 'user', body: 'delivery evidence', project_id: null,
      attachments: null, created_at: 1, status,
    }
    const state = deliveryFor(message, 'device-1')!
    expect(state).toBe(expected)
    const html = renderToStaticMarkup(<DeliveryIndicator state={state} onRetry={() => {}} />)
    expect(html).toContain(glyph)
    expect(html).toContain(label)
    expect(html.includes('<button')).toBe(status === 'failed')
    expect(html.includes('Failed — retry')).toBe(status === 'failed')
  })
})
