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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEmailPipelineStore } from '../src/pipeline/store.ts'

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
      important: 0,
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

describe('sender_rules.handling is honoured, not just stored', () => {
  test('handling:escalate on a newsletter-shaped sender still escalates', async () => {
    // The owner asked to be told about this sender. `category` says what the
    // mail IS; `handling` says what to DO about it, and the second was being
    // persisted and then ignored — so this rule filed the message as a
    // newsletter and archived it, silently overruling the owner.
    const verdict = await classifyEmail(
      message({
        sender: 'The Shop <news@list.example.com>',
        subject: 'This week at the shop',
        body_text: 'Lots of news. Unsubscribe at any time.',
      }),
      {
        rules: [rule({ pattern: 'list.example.com', kind: 'domain', category: 'newsletter', handling: 'escalate' })],
        cache_lookup: () => null,
        cache_store: () => undefined,
        llm: null,
      },
    )
    expect(verdict.important).toBe(true)
    expect(verdict.source).toBe('rule')
    expect(verdict.reason).toContain('handling=escalate')
  })

  test('handling:archive keeps an otherwise-important sender quiet', async () => {
    const verdict = await classifyEmail(
      message({
        sender: 'Vendor Billing <billing@vendor.example.com>',
        subject: 'Action required: payment failed',
        body_text: 'Your card was declined.',
      }),
      {
        rules: [rule({ pattern: 'vendor.example.com', kind: 'domain', handling: 'archive' })],
        cache_lookup: () => null,
        cache_store: () => undefined,
        llm: null,
      },
    )
    expect(verdict.important).toBe(false)
  })
})

describe('the model verdict is validated, and the cache keeps BOTH facts', () => {
  test('category and importance can disagree, and the cache remembers that', async () => {
    // `{category:'receipt', important:true}` is a legitimate verdict — a receipt
    // the owner needs to look at. Caching only the category and re-deriving
    // importance as (category === 'important') meant it escalated ONCE and was
    // archived on every later message from that sender.
    const stored: Array<{ sender: string; category: string; important: boolean }> = []
    const first = await classifyEmail(
      message({ sender: 'Billing <pay@vendor.example.com>', subject: 'Your receipt' }),
      {
        rules: [],
        cache_lookup: () => null,
        cache_store: (sender, category, important) => {
          stored.push({ sender, category, important })
        },
        llm: async () => '{"category":"receipt","important":true,"reason":"payment needs review"}',
      },
    )
    expect(first.important).toBe(true)
    expect(stored[0]).toEqual({
      sender: 'pay@vendor.example.com',
      category: 'receipt',
      important: true,
    })

    // The NEXT message from that sender reads the cache — and must still be important.
    const second = await classifyEmail(
      message({ sender: 'Billing <pay@vendor.example.com>', subject: 'Your receipt' }),
      {
        rules: [],
        cache_lookup: () => ({
          sender: 'pay@vendor.example.com',
          category: 'receipt',
          important: 1,
          updated_at: 0,
        }),
        cache_store: () => undefined,
        llm: null,
      },
    )
    expect(second.source).toBe('cache')
    expect(second.important).toBe(true)
  })

  test('a category outside the offered set is REFUSED, not cached', async () => {
    // Model output is untrusted input. Accepting any string wrote it into
    // sender_cache permanently — one malformed or injected answer and that
    // sender carries an arbitrary category forever.
    const stored: string[] = []
    const c = await classifyEmail(
      message({ sender: 'someone@other.example.com', subject: 'hello' }),
      {
        rules: [],
        cache_lookup: () => null,
        cache_store: (_s, category) => {
          stored.push(category)
        },
        llm: async () => '{"category":"attacker-controlled","important":true,"reason":"x"}',
      },
    )
    expect(c.source).toBe('default')
    expect(c.important).toBe(false)
    expect(stored).toEqual([])
  })

  test('a non-boolean `important` is REFUSED', async () => {
    const c = await classifyEmail(
      message({ sender: 'someone@other.example.com', subject: 'hello' }),
      {
        rules: [],
        cache_lookup: () => null,
        cache_store: () => undefined,
        llm: async () => '{"category":"important","important":"yes","reason":"x"}',
      },
    )
    expect(c.source).toBe('default')
    expect(c.important).toBe(false)
  })
})

describe('a sender rule the owner mistyped', () => {
  test('an unrecognised handling is IGNORED, not read as archive', async () => {
    // The inversion this pins: `handling` used to be free text and the
    // classifier read it as "escalate, or else archive". So `esclate` did not
    // fail — it guaranteed silent archival of the one sender the owner had
    // singled out to be told about, "payment failed" included.
    const c = await classifyEmail(
      {
        sender: 'billing@vendor.example.com',
        subject: 'Action required: payment failed',
        snippet: 'declined',
        body_text: 'Your payment method was declined.',
        label_ids: ['INBOX'],
      },
      {
        rules: [
          {
            id: 1,
            pattern: 'billing@vendor.example.com',
            kind: 'sender',
            category: null,
            // Deliberately not a legal value — this is the typo.
            handling: 'esclate' as unknown as null,
            protected: 0,
            created_at: 0,
          },
        ],
        cache_lookup: () => null,
        cache_store: () => undefined,
        llm: null,
      },
    )
    // Falls through to the heuristics, which know what "payment failed" is.
    expect(c.important).toBe(true)
  })

  test('the store REFUSES to persist an illegal handling', () => {
    const home = mkdtempSync(join(tmpdir(), 'email-rule-handling-'))
    const store = openEmailPipelineStore({ owner_home: home })
    try {
      expect(() =>
        store.addSenderRule({
          pattern: 'billing@vendor.example.com',
          kind: 'sender',
          handling: 'esclate' as unknown as null,
        }),
      ).toThrow(/escalate, archive/)
      expect(store.listSenderRules()).toEqual([])
      // NULL stays legal — "no action specified" is a real state, not a third
      // behaviour, and it falls through to the cascade.
      store.addSenderRule({ pattern: 'news@vendor.example.com', kind: 'sender' })
      expect(store.listSenderRules()).toHaveLength(1)
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
