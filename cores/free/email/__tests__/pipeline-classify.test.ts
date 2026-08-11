/**
 * Email pipeline — the classification CASCADE.
 *
 * These assert the RESULT FIELDS (category / important / reason / source), not
 * that a code path ran: the escalation the owner sees is built out of exactly
 * those fields. Inverting the `has_unsubscribe` downgrade, dropping a
 * deterministic importance pattern, or letting the downgrade beat a protected
 * sender rule each turn one of these red.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'

import { PROMOTIONS_LABEL, bareAddress, classifyEmail } from '../src/pipeline/classify.ts'
import type { ClassifyDeps, ClassifyInput } from '../src/pipeline/classify.ts'
import type { SenderCacheRow, SenderRule } from '../src/pipeline/store.ts'

function rule(over: Partial<SenderRule> & Pick<SenderRule, 'pattern' | 'kind'>): SenderRule {
  return {
    id: 1,
    category: null,
    handling: null,
    protected: 0,
    created_at: 0,
    ...over,
  }
}

function message(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    sender: 'Someone <someone@sender.example.com>',
    subject: 'Hello',
    snippet: '',
    body_text: '',
    label_ids: ['INBOX'],
    ...over,
  }
}

function deps(over: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return {
    rules: [],
    cache_lookup: () => null,
    cache_store: () => undefined,
    llm: null,
    ...over,
  }
}

describe('bareAddress', () => {
  test('extracts the bare address from an RFC 5322 mailbox spec', () => {
    expect(bareAddress('"A Person" <person@sender.example.com>')).toBe(
      'person@sender.example.com',
    )
    expect(bareAddress('person@sender.example.com')).toBe('person@sender.example.com')
  })
})

describe('classifyEmail — deterministic importance patterns', () => {
  test('an authentication code is important', async () => {
    const c = await classifyEmail(
      message({ subject: 'Your verification code is 123456' }),
      deps(),
    )
    expect(c.important).toBe(true)
    expect(c.category).toBe('important')
    expect(c.reason).toBe('authentication code')
    expect(c.source).toBe('pattern')
  })

  test('a billing action is important', async () => {
    const c = await classifyEmail(
      message({ subject: 'Action required: payment failed' }),
      deps(),
    )
    expect(c.important).toBe(true)
    expect(c.reason).toBe('billing action')
  })

  test('a deadline is important', async () => {
    const c = await classifyEmail(
      message({ subject: 'Final notice', body_text: 'due by Friday' }),
      deps(),
    )
    expect(c.important).toBe(true)
    expect(c.reason).toBe('deadline')
  })

  test('a deterministic hit BEATS the mass-mailer downgrade', async () => {
    // A real payment failure often carries a marketing footer. Letting the
    // downgrade win here is how an owner misses a declined card.
    const c = await classifyEmail(
      message({
        subject: 'Your payment failed',
        body_text: 'Update your card.\nUnsubscribe from these emails.',
      }),
      deps(),
    )
    expect(c.important).toBe(true)
    expect(c.reason).toBe('billing action')
  })
})

describe('classifyEmail — the mass-mailer downgrade', () => {
  test('an unsubscribe footer downgrades to a not-important newsletter', async () => {
    const c = await classifyEmail(
      message({
        subject: 'This week at the shop',
        body_text: 'Lots of news.\nUnsubscribe here.',
      }),
      deps(),
    )
    expect(c.category).toBe('newsletter')
    expect(c.important).toBe(false)
    expect(c.reason).toBe('mass mailer')
  })

  test('the promotions label alone downgrades', async () => {
    const c = await classifyEmail(
      message({ subject: 'Sale', label_ids: ['INBOX', PROMOTIONS_LABEL] }),
      deps(),
    )
    expect(c.category).toBe('newsletter')
    expect(c.important).toBe(false)
  })

  test('an LLM verdict of important does NOT survive the downgrade', async () => {
    // The model is allowed to be wrong about bulk mail; the downgrade is what
    // keeps a marketing blast that calls itself urgent out of the owner's chat.
    const c = await classifyEmail(
      message({ subject: 'URGENT: last chance', body_text: 'Buy now. Unsubscribe.' }),
      deps({
        llm: async () => '{"category":"important","important":true,"reason":"urgent"}',
      }),
    )
    expect(c.important).toBe(false)
    expect(c.category).toBe('newsletter')
  })
})

describe('classifyEmail — sender rules', () => {
  test('a protected sender rule is important and immune to the downgrade', async () => {
    const c = await classifyEmail(
      message({
        sender: 'School Office <office@school.example.com>',
        subject: 'Newsletter',
        body_text: 'Click to unsubscribe.',
      }),
      deps({
        rules: [rule({ pattern: 'office@school.example.com', kind: 'sender', protected: 1 })],
      }),
    )
    expect(c.important).toBe(true)
    expect(c.protected).toBe(true)
    expect(c.source).toBe('rule')
    expect(c.reason).toBe('protected sender rule')
  })

  test('a domain rule matches against the EXTRACTED bare address', async () => {
    const c = await classifyEmail(
      message({ sender: '"Billing Team" <billing@vendor.example.com>', subject: 'Statement' }),
      deps({
        rules: [rule({ pattern: 'vendor.example.com', kind: 'domain', category: 'receipt' })],
      }),
    )
    expect(c.category).toBe('receipt')
    expect(c.important).toBe(false)
    expect(c.source).toBe('rule')
  })

  test('an exact address rule beats a domain rule on the same message', async () => {
    const c = await classifyEmail(
      message({ sender: 'billing@vendor.example.com', subject: 'Statement' }),
      deps({
        rules: [
          rule({ id: 1, pattern: 'vendor.example.com', kind: 'domain', category: 'receipt' }),
          rule({
            id: 2,
            pattern: 'billing@vendor.example.com',
            kind: 'sender',
            category: 'important',
          }),
        ],
      }),
    )
    expect(c.category).toBe('important')
    expect(c.important).toBe(true)
  })
})

describe('classifyEmail — cache and LLM', () => {
  test('a sender_cache hit short-circuits the model entirely', async () => {
    const cached: SenderCacheRow = {
      sender: 'notify@service.example.com',
      category: 'notification',
      updated_at: 0,
    }
    const c = await classifyEmail(
      message({ sender: 'notify@service.example.com', subject: 'Build finished' }),
      deps({
        cache_lookup: () => cached,
        llm: async () => {
          throw new Error('the LLM must not be called for a cached sender')
        },
      }),
    )
    expect(c.category).toBe('notification')
    expect(c.important).toBe(false)
    expect(c.source).toBe('cache')
  })

  test('an LLM verdict is returned and written back to the sender cache', async () => {
    const stored: Array<[string, string]> = []
    const c = await classifyEmail(
      message({ sender: 'person@sender.example.com', subject: 'Can you review this?' }),
      deps({
        cache_store: (sender, category) => stored.push([sender, category]),
        llm: async () =>
          'Sure!\n{"category":"important","important":true,"reason":"asks for a reply"}\n',
      }),
    )
    expect(c.category).toBe('important')
    expect(c.important).toBe(true)
    expect(c.reason).toBe('asks for a reply')
    expect(c.source).toBe('llm')
    expect(stored).toEqual([['person@sender.example.com', 'important']])
  })

  test('a null LLM (an LLM-less box) degrades to the default — no throw', async () => {
    const c = await classifyEmail(message({ subject: 'Just saying hi' }), deps({ llm: null }))
    expect(c.source).toBe('default')
    expect(c.category).toBe('other')
    expect(c.important).toBe(false)
  })

  test('a THROWING LLM degrades to the default — no throw', async () => {
    const c = await classifyEmail(
      message({ subject: 'Just saying hi' }),
      deps({
        llm: async () => {
          throw new Error('model unavailable')
        },
      }),
    )
    expect(c.source).toBe('default')
    expect(c.important).toBe(false)
  })

  test('unparseable LLM output degrades to the default — no throw', async () => {
    const c = await classifyEmail(
      message({ subject: 'Just saying hi' }),
      deps({ llm: async () => 'I am not JSON.' }),
    )
    expect(c.source).toBe('default')
  })
})
