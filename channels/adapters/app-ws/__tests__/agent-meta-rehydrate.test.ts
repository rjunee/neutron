/**
 * W3a — `appChatRowToEnvelope` re-hydration + defensive re-validation.
 *
 * The persisted `meta` blob is trusted at WRITE time but a corrupt / partial /
 * older row must degrade to a plain (or partially-stripped) agent bubble —
 * never emit a malformed wire field the client can't render, and never throw.
 * These tests feed hand-built `AppChatRow`s (the seam a durable row enters the
 * adapter through) straight into the exported reconstructor and assert the
 * REPLAYED WIRE SHAPE, not a call count.
 */

import { describe, expect, it } from 'bun:test'
import type { AppChatRow } from '@neutronai/persistence/index.ts'
import { appChatRowToEnvelope } from '../adapter.ts'
import type { AppWsOutboundAgentMessage } from '../envelope.ts'

function agentRow(meta: Record<string, unknown> | null): AppChatRow {
  return {
    topic_id: 'app:sam',
    seq: 1,
    message_id: 'm1',
    role: 'agent',
    body: 'hello',
    client_msg_id: null,
    project_id: 'proj-1',
    attachments: null,
    meta,
    created_at: 1000,
  }
}

function replay(meta: Record<string, unknown> | null): AppWsOutboundAgentMessage {
  return appChatRowToEnvelope(agentRow(meta)) as AppWsOutboundAgentMessage
}

describe('W3a — appChatRowToEnvelope re-hydrates valid structured meta', () => {
  it('applies every structured field', () => {
    const env = replay({
      prompt_id: 'p1',
      kind: 'buttons',
      allow_freeform: false,
      deep_link: 'neutron://x',
      options: [{ label: 'Yes', body: 'Yes', value: 'yes' }],
      citations: [{ title: 'Docs', url: 'https://example.test/d' }],
      image_urls: ['https://cdn/x.png'],
      doc_refs: [{ label: 'Plan', url: 'neutron://docs/p', project_id: 'proj-1', path: 'docs/p.md' }],
      upload_affordance: { source: 'chatgpt' },
    })
    expect(env.prompt_id).toBe('p1')
    expect(env.kind).toBe('buttons')
    expect(env.allow_freeform).toBe(false)
    expect(env.deep_link).toBe('neutron://x')
    expect(env.options).toEqual([{ label: 'Yes', body: 'Yes', value: 'yes' }])
    expect(env.citations).toEqual([{ title: 'Docs', url: 'https://example.test/d' }])
    expect(env.image_urls).toEqual(['https://cdn/x.png'])
    expect(env.doc_refs?.[0]?.path).toBe('docs/p.md')
    expect(env.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  it('carries a valid option decoration through untouched', () => {
    const env = replay({
      options: [
        { label: 'Del', body: 'Del', value: 'del', decoration: { style: 'destructive', icon_custom_emoji_id: 'e1' } },
      ],
    })
    expect(env.options?.[0]?.decoration).toEqual({ style: 'destructive', icon_custom_emoji_id: 'e1' })
  })
})

describe('W3a — appChatRowToEnvelope defensively sanitizes corrupt meta', () => {
  it('drops an invalid option decoration but keeps the option', () => {
    const env = replay({
      options: [
        // style not a wire value + non-string emoji id → decoration stripped.
        { label: 'A', body: 'A', value: 'a', decoration: { style: 'not-a-style', icon_custom_emoji_id: 123 } },
      ],
    })
    expect(env.options).toEqual([{ label: 'A', body: 'A', value: 'a' }])
    expect(env.options?.[0]?.decoration).toBeUndefined()
  })

  it('keeps a partially-valid decoration (valid member only)', () => {
    const env = replay({
      options: [{ label: 'A', body: 'A', value: 'a', decoration: { style: 'primary', icon_custom_emoji_id: 7 } }],
    })
    expect(env.options?.[0]?.decoration).toEqual({ style: 'primary' })
  })

  it('filters mixed valid/invalid array entries per field', () => {
    const env = replay({
      options: [
        { label: 'ok', body: 'ok', value: 'ok' },
        { label: 'missing-value', body: 'x' }, // no value → dropped
        'not-an-object',
      ],
      citations: [{ title: 'good', url: 'https://ok' }, { title: 'no-url' }, 42],
      image_urls: ['https://ok', 7, '', null],
      doc_refs: [
        { label: 'ok', url: 'u', project_id: null, path: 'p' },
        { label: 'no-path', url: 'u', project_id: null }, // no path → dropped
      ],
    })
    expect(env.options).toEqual([{ label: 'ok', body: 'ok', value: 'ok' }])
    expect(env.citations).toEqual([{ title: 'good', url: 'https://ok' }])
    expect(env.image_urls).toEqual(['https://ok'])
    expect(env.doc_refs).toEqual([{ label: 'ok', url: 'u', project_id: null, path: 'p' }])
  })

  it('drops invalid scalars (wrong type / unknown enum)', () => {
    const env = replay({
      prompt_id: 123, // not a string
      kind: 'bogus', // not a wire kind
      allow_freeform: 'yes', // not a boolean
      deep_link: '', // empty
      upload_affordance: { source: 'notion' }, // not a valid source
    })
    expect(env.prompt_id).toBeUndefined()
    expect(env.kind).toBeUndefined()
    expect(env.allow_freeform).toBeUndefined()
    expect(env.deep_link).toBeUndefined()
    expect(env.upload_affordance).toBeUndefined()
  })

  it('an all-invalid meta yields a plain agent bubble', () => {
    const env = replay({ options: 'nope', citations: 5, doc_refs: {}, image_urls: 'no' })
    expect(env.type).toBe('agent_message')
    expect(env.body).toBe('hello')
    expect(env.options).toBeUndefined()
    expect(env.citations).toBeUndefined()
    expect(env.doc_refs).toBeUndefined()
    expect(env.image_urls).toBeUndefined()
  })

  it('a null meta yields a plain agent bubble (still carries project_id/seq)', () => {
    const env = replay(null)
    expect(env.type).toBe('agent_message')
    expect(env.project_id).toBe('proj-1')
    expect(env.seq).toBe(1)
    expect(env.options).toBeUndefined()
  })
})
