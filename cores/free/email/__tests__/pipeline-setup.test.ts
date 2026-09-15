import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSeededInMemoryGmailClient } from '../src/backend.ts'
import { classifyEmail } from '../src/pipeline/classify.ts'
import { applyClassificationSetup, surveyClassificationSetup } from '../src/pipeline/setup.ts'
import { openEmailPipelineStore } from '../src/pipeline/store.ts'

function mailbox(from: string, subject: string) {
  const client = buildSeededInMemoryGmailClient()
  client.seed({ from, subject, snippet: subject, body_text: subject })
  return client
}

describe('classification setup', () => {
  test('two different inbox samples produce different proposed classes', async () => {
    const orders = await surveyClassificationSetup(mailbox('Orders <sales@shop.example.com>', 'Order receipt'))
    const people = await surveyClassificationSetup(mailbox('Friend <friend@social.example.com>', 'Lunch tomorrow?'))

    expect(orders.proposals.map((proposal) => proposal.id)).toEqual(['shop.example.com:transaction'])
    expect(people.proposals.map((proposal) => proposal.id)).toEqual(['social.example.com:conversation'])
    expect(orders.proposals.map((proposal) => proposal.category)).toEqual(['shop-transaction'])
    expect(people.proposals.map((proposal) => proposal.category)).toEqual(['social-conversation'])
    expect(orders.proposals).not.toEqual(people.proposals)
  })

  test('a fresh instance reaches classification from setup alone and honors ignore', async () => {
    const home = mkdtempSync(join(tmpdir(), 'email-classification-setup-'))
    const store = openEmailPipelineStore({ owner_home: home, now: () => 1_000 })
    try {
      expect(store.listSenderRules()).toEqual([])
      const survey = await surveyClassificationSetup(
        mailbox('Orders <sales@shop.example.com>', 'Order receipt'),
      )
      applyClassificationSetup(store, survey, [
        { proposal_id: survey.proposals[0]!.id, action: 'ignore' },
      ])

      const rules = store.listSenderRules()
      expect(rules).toHaveLength(1)
      expect(rules[0]).toMatchObject({
        pattern: 'sales@shop.example.com',
        category: 'shop-transaction',
        handling: 'archive',
      })
      const verdict = await classifyEmail(
        {
          sender: 'Orders <sales@shop.example.com>',
          subject: 'Payment failed',
          snippet: '',
          body_text: '',
          label_ids: ['INBOX'],
        },
        {
          rules,
          cache_lookup: () => null,
          cache_store: () => undefined,
          llm: null,
        },
      )
      expect(verdict.source).toBe('rule')
      expect(verdict.important).toBe(false)
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an incomplete interview writes no rules', async () => {
    const home = mkdtempSync(join(tmpdir(), 'email-classification-setup-'))
    const store = openEmailPipelineStore({ owner_home: home })
    try {
      const client = buildSeededInMemoryGmailClient()
      client.seed({ from: 'One <one@first.example.com>', subject: 'Hello' })
      client.seed({ from: 'Two <two@second.example.com>', subject: 'Status update' })
      const survey = await surveyClassificationSetup(client)
      expect(() => applyClassificationSetup(store, survey, [
        { proposal_id: survey.proposals[0]!.id, action: 'brief' },
      ])).toThrow(/answer for every proposal/)
      expect(store.listSenderRules()).toEqual([])
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an unreadable or invalid survey is refused instead of treated as an empty inbox', async () => {
    const unreadable = {
      listMessages: async () => ({
        results: [],
        accounts: [{ account_id: 'mailbox-a', account_email: null, ok: false, error: 'grant expired' }],
      }),
    }
    await expect(surveyClassificationSetup(unreadable)).rejects.toThrow(/complete sample/)
    await expect(surveyClassificationSetup(mailbox('A <a@one.example.com>', 'Hello'), 0))
      .rejects.toThrow(/integer from 1/)
  })

  test('unknown and duplicate interview answers are refused before any write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'email-classification-setup-'))
    const store = openEmailPipelineStore({ owner_home: home })
    try {
      const survey = await surveyClassificationSetup(mailbox('A <a@one.example.com>', 'Hello'))
      expect(() => applyClassificationSetup(store, survey, [
        { proposal_id: 'not-observed', action: 'brief' },
      ])).toThrow(/unknown classification proposal/)
      expect(() => applyClassificationSetup(store, survey, [
        { proposal_id: survey.proposals[0]!.id, action: 'brief' },
        { proposal_id: survey.proposals[0]!.id, action: 'ignore' },
      ])).toThrow(/duplicate classification answer/)
      expect(store.listSenderRules()).toEqual([])
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a persistence failure rolls the whole interview back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'email-classification-setup-'))
    const store = openEmailPipelineStore({ owner_home: home })
    try {
      const client = buildSeededInMemoryGmailClient()
      client.seed({ from: 'A <a@one.example.com>', subject: 'Hello' })
      client.seed({ from: 'B <b@one.example.com>', subject: 'Hello again' })
      const survey = await surveyClassificationSetup(client)
      store.db.exec(`
        CREATE TRIGGER refuse_second_setup_rule
        BEFORE INSERT ON sender_rules WHEN NEW.pattern = 'b@one.example.com'
        BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END
      `)
      expect(() => applyClassificationSetup(store, survey, [
        { proposal_id: survey.proposals[0]!.id, action: 'brief' },
      ])).toThrow(/fixture refusal/)
      expect(store.listSenderRules()).toEqual([])
    } finally {
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
