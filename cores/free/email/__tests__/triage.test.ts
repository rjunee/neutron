/**
 * Email-Managed Core — Haiku-driven triage agent.
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.4.
 */

import { describe, expect, test } from 'bun:test'

import {
  TRIAGE_PROMPT_TEMPLATE,
  TRIAGE_TOP_K,
  composeTriage,
  renderTriagePrompt,
  triagePromptTemplateHash,
} from '../src/triage.ts'
import type { GmailMessageMeta } from '../src/contract.ts'

function msg(
  id: string,
  opts: { important?: boolean; unread?: boolean; ts?: number; subject?: string } = {},
): GmailMessageMeta {
  const labels: string[] = ['INBOX']
  if (opts.important) labels.push('IMPORTANT')
  if (opts.unread) labels.push('UNREAD')
  return {
    id,
    thread_id: `thread-${id}`,
    subject: opts.subject ?? `subject-${id}`,
    from: `${id}@example.com`,
    snippet: `snippet-${id}`,
    internal_date: new Date(opts.ts ?? 1_000_000).toISOString(),
    label_ids: labels,
  }
}

describe('renderTriagePrompt', () => {
  test('substitutes inbox bullets + count', () => {
    const out = renderTriagePrompt({ inbox: [msg('a'), msg('b')] })
    expect(out).toContain('a@example.com')
    expect(out).toContain('b@example.com')
    expect(out).not.toContain('{{')
    expect(out).toContain('user has 2 unread/recent messages')
  })

  test('empty inbox bullets', () => {
    const out = renderTriagePrompt({ inbox: [] })
    expect(out).toContain('(inbox is empty)')
  })
})

describe('TRIAGE_PROMPT_TEMPLATE snapshot', () => {
  test('template hash deterministic', () => {
    expect(triagePromptTemplateHash().length).toBe(64)
    expect(TRIAGE_PROMPT_TEMPLATE.includes('Return JSON only')).toBe(true)
  })
})

describe('composeTriage', () => {
  test('empty inbox → empty items', async () => {
    const t = await composeTriage({
      inbox: [],
      userTz: 'America/Los_Angeles',
      llm: async () => '[]',
      model: 'haiku',
    })
    expect(t.items).toHaveLength(0)
    expect(t.outcome).toBe('ok')
  })

  test('LLM returns valid JSON top-5 → hydrated items', async () => {
    const inbox = [
      msg('m1', { important: true, unread: true }),
      msg('m2', { unread: true }),
      msg('m3'),
    ]
    const llm = async (): Promise<string> =>
      JSON.stringify([
        { message_id: 'm2', rank: 1, reason: 'unread ping' },
        { message_id: 'm1', rank: 2, reason: 'important' },
      ])
    const t = await composeTriage({
      inbox,
      userTz: 'America/Los_Angeles',
      llm,
      model: 'haiku',
    })
    expect(t.outcome).toBe('ok')
    expect(t.items).toHaveLength(2)
    expect(t.items[0]?.message_id).toBe('m2')
    expect(t.items[0]?.rank).toBe(1)
  })

  test('LLM throws → deterministic fallback (is:important+unread > unread > important > newest)', async () => {
    const inbox = [
      msg('cold', { ts: 5000 }),
      msg('hot', { important: true, unread: true, ts: 1000 }),
      msg('unread', { unread: true, ts: 4000 }),
    ]
    const t = await composeTriage({
      inbox,
      userTz: 'America/Los_Angeles',
      llm: async () => {
        throw new Error('haiku timeout')
      },
      model: 'haiku',
    })
    expect(t.outcome).toBe('llm_error')
    expect(t.items[0]?.message_id).toBe('hot')
    expect(t.items[1]?.message_id).toBe('unread')
    expect(t.items[2]?.message_id).toBe('cold')
  })

  test('LLM malformed JSON → fallback', async () => {
    const inbox = [msg('a')]
    const t = await composeTriage({
      inbox,
      userTz: 'UTC',
      llm: async () => 'not json',
      model: 'haiku',
    })
    expect(t.outcome).toBe('llm_error')
  })

  test('LLM returns ids not in inbox → all dropped, fallback', async () => {
    const inbox = [msg('real')]
    const t = await composeTriage({
      inbox,
      userTz: 'UTC',
      llm: async () => JSON.stringify([{ message_id: 'hallucinated', rank: 1, reason: '' }]),
      model: 'haiku',
    })
    expect(t.outcome).toBe('llm_error')
    expect(t.items[0]?.message_id).toBe('real')
  })

  test('LLM returns >5 items → capped at TRIAGE_TOP_K', async () => {
    const inbox = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e'), msg('f'), msg('g')]
    const llm = async (): Promise<string> =>
      JSON.stringify(
        inbox.map((m, i) => ({ message_id: m.id, rank: i + 1, reason: 'r' })),
      )
    const t = await composeTriage({
      inbox,
      userTz: 'UTC',
      llm,
      model: 'haiku',
    })
    expect(t.outcome).toBe('ok')
    expect(t.items).toHaveLength(TRIAGE_TOP_K)
  })

  test('LLM response wrapped in code fences → still parses', async () => {
    const inbox = [msg('a', { unread: true })]
    const t = await composeTriage({
      inbox,
      userTz: 'UTC',
      llm: async () => '```json\n[{"message_id":"a","rank":1,"reason":"r"}]\n```',
      model: 'haiku',
    })
    expect(t.outcome).toBe('ok')
    expect(t.items[0]?.message_id).toBe('a')
  })
})
