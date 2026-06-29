/**
 * @neutronai/channels/app-ws — attachments wire-shape tests (P5.1).
 *
 * Covers:
 *   - `decodeAppWsInbound` accepts a well-formed attachments array
 *     and propagates it onto the typed envelope.
 *   - `sanitizeAttachments` enforces the per-message + per-URL caps
 *     and the URL allow-list.
 *   - `AppWsAdapter.dispatchInbound` carries attachments onto
 *     `IncomingEvent.adapter_metadata.attachments` so the eventual
 *     agent loop can read them.
 *   - `emitUserMessageEcho` carries attachments back on the canonical
 *     echo envelope so the optimistic client bubble reconciles.
 */

import { describe, expect, it } from 'bun:test'

import type { IncomingEvent } from '../../../types.ts'
import { AppWsAdapter } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import {
  decodeAppWsInbound,
  payloadIsEmpty,
  sanitizeAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_URL_LEN,
  type AppWsOutbound,
} from '../envelope.ts'

const FROZEN_NOW = 1_700_000_000_000

function setupAdapter() {
  const registry = new InMemoryAppWsSessionRegistry()
  const events: IncomingEvent[] = []
  let counter = 0
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (e) => { events.push(e) } },
    now: () => FROZEN_NOW,
    generate_message_id: () => `msg-${++counter}`,
  })
  return { adapter, registry, events }
}

describe('decodeAppWsInbound — attachments', () => {
  it('accepts a well-formed attachments array', () => {
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hello',
      attachments: ['https://cdn.example/img.png'],
    })
    expect(inbound).not.toBeNull()
    expect(inbound?.attachments).toEqual(['https://cdn.example/img.png'])
  })

  it('drops attachments over the per-message cap', () => {
    const big = new Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill('https://cdn/x.png')
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hello',
      attachments: big,
    })
    expect(inbound).not.toBeNull()
    expect(inbound?.attachments).toBeUndefined()
  })

  it('drops attachments with URLs over the per-entry cap', () => {
    const huge = 'https://cdn/' + 'a'.repeat(MAX_ATTACHMENT_URL_LEN + 1)
    const inbound = decodeAppWsInbound({
      v: 1,
      type: 'user_message',
      body: 'hello',
      attachments: [huge],
    })
    expect(inbound?.attachments).toBeUndefined()
  })
})

describe('payloadIsEmpty — whitespace parity with the agent worker', () => {
  it('treats a whitespace-only body with no attachments as empty', () => {
    // Pre-fix this returned false (raw length > 0) → the envelope was forwarded,
    // the worker trimmed it to '' and silently dropped it: a dead-end bubble.
    expect(payloadIsEmpty('   ', null)).toBe(true)
    expect(payloadIsEmpty('\n\t ', undefined)).toBe(true)
    expect(payloadIsEmpty('', null)).toBe(true)
  })

  it('keeps a whitespace body non-empty when a valid attachment rode along', () => {
    expect(payloadIsEmpty('  ', ['https://cdn/x.png'])).toBe(false)
  })

  it('treats real text as non-empty', () => {
    expect(payloadIsEmpty('  hi  ', null)).toBe(false)
  })

  it('decodeAppWsInbound rejects a whitespace-only user_message (no dead-end)', () => {
    const inbound = decodeAppWsInbound({ v: 1, type: 'user_message', body: '   ' })
    expect(inbound).toBeNull()
  })
})

describe('sanitizeAttachments — URL allow-list', () => {
  it('rejects javascript: / mailto: / data: schemes', () => {
    expect(sanitizeAttachments(['javascript:alert(1)'])).toBeNull()
    expect(sanitizeAttachments(['mailto:foo@bar'])).toBeNull()
    expect(sanitizeAttachments(['data:text/html,xss'])).toBeNull()
  })
  it('accepts http / https / root-relative URLs', () => {
    expect(sanitizeAttachments(['http://x/y.png'])).toEqual(['http://x/y.png'])
    expect(sanitizeAttachments(['/api/app/upload/x'])).toEqual(['/api/app/upload/x'])
  })
})

describe('AppWsAdapter.dispatchInbound — attachments routing', () => {
  it('attaches attachments to IncomingEvent.adapter_metadata', async () => {
    const { adapter, events } = setupAdapter()
    await adapter.dispatchInbound({
      user_id: 'sam',
      channel_topic_id: 'app:sam',
      body: 'hi',
      project_id: 'proj-1',
      attachments: ['https://cdn/a.png', '/api/app/upload/b'],
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.adapter_metadata).toMatchObject({
      project_id: 'proj-1',
      attachments: ['https://cdn/a.png', '/api/app/upload/b'],
    })
  })

  it('omits adapter_metadata when neither project_id nor attachments are set', async () => {
    const { adapter, events } = setupAdapter()
    await adapter.dispatchInbound({
      user_id: 'sam',
      channel_topic_id: 'app:sam',
      body: 'plain',
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.adapter_metadata).toBeUndefined()
  })
})

describe('AppWsAdapter.emitUserMessageEcho — attachments echo', () => {
  it('includes attachments on the echo envelope', () => {
    const { adapter, registry } = setupAdapter()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    adapter.emitUserMessageEcho({
      channel_topic_id: 'app:sam',
      user_id: 'sam',
      body: 'with image',
      attachments: ['https://cdn/a.png'],
    })
    expect(captured).toHaveLength(1)
    const env = captured[0]!
    expect(env.type).toBe('user_message')
    if (env.type === 'user_message') {
      expect(env.attachments).toEqual(['https://cdn/a.png'])
    }
  })

  it('omits the attachments field when none were sent', () => {
    const { adapter, registry } = setupAdapter()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    adapter.emitUserMessageEcho({
      channel_topic_id: 'app:sam',
      user_id: 'sam',
      body: 'plain',
    })
    expect(captured).toHaveLength(1)
    const env = captured[0]!
    if (env.type === 'user_message') {
      expect(env.attachments).toBeUndefined()
    }
  })
})
