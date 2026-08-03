/**
 * Gmail fan-out — the merge rule and write routing.
 *
 * The production-composition guard (two accounts merged, tagged, and degrading
 * partially) lives in `gateway/cores/__tests__/google-multi-account.test.ts`.
 * This file pins what that guard cannot easily provoke: truncation across
 * accounts, which account a send lands on, and reading a message that lives in
 * a non-primary mailbox.
 */

import { expect, test } from 'bun:test'

import {
  MessageNotFoundError,
  OAuthMissingError,
  buildMultiAccountGmailClient,
  type GmailAccountDescriptor,
  type GmailClient,
  type GmailMessageMeta,
} from '../index.ts'

const WORK = 'owner@work.example.com'
const HOME = 'owner@home.example.com'

function meta(id: string, iso: string): GmailMessageMeta {
  return {
    id,
    thread_id: `t-${id}`,
    subject: id,
    from: 'sender@example.com',
    snippet: '',
    internal_date: iso,
    label_ids: ['INBOX'],
  }
}

function fakeAccountClient(rows: GmailMessageMeta[]): GmailClient {
  const notImplemented = (): never => {
    throw new Error('not used in this test')
  }
  return {
    async listMessages() {
      return { results: rows }
    },
    async search() {
      return { results: rows }
    },
    async getMessage(input) {
      const found = rows.find((r) => r.id === input.message_id)
      if (found === undefined) throw new MessageNotFoundError(input.message_id)
      return { ...found, to: [], cc: [], body_text: '' }
    },
    getThread: notImplemented,
    async createDraft() {
      return {
        draft_id: `draft-on-${rows[0]?.id ?? 'empty'}`,
        message_id: 'm',
        thread_id: 't',
        applied_labels: [],
      }
    },
    async sendMessage() {
      return {
        message_id: `sent-on-${rows[0]?.id ?? 'empty'}`,
        thread_id: 't',
        applied_labels: [],
      }
    },
    ensureProjectLabel: notImplemented,
    modifyThread: notImplemented,
  }
}

function build(
  accounts: Array<{ id: string; email: string | null; client: GmailClient }>,
): GmailClient {
  const byId = new Map(accounts.map((a) => [a.id, a.client]))
  return buildMultiAccountGmailClient({
    accounts: async (): Promise<GmailAccountDescriptor[]> =>
      accounts.map((a) => ({
        account_id: a.id,
        account_email: a.email,
        accessToken: async () => `token-${a.id}`,
      })),
    buildClient: (account) => byId.get(account.account_id) as GmailClient,
  })
}

test('truncation happens AFTER the merge — the newest messages overall survive, not the newest per account', async () => {
  const client = build([
    {
      id: 'work',
      email: WORK,
      client: fakeAccountClient([
        meta('w-old', '2026-08-01T09:00:00Z'),
        meta('w-older', '2026-07-30T09:00:00Z'),
      ]),
    },
    {
      id: 'home',
      email: HOME,
      client: fakeAccountClient([meta('h-newest', '2026-08-03T09:00:00Z')]),
    },
  ])
  const { results } = await client.listMessages({ label: 'INBOX', max_results: 2 })
  // Per-account truncation would have kept w-older; merge-then-truncate keeps
  // the two genuinely newest.
  expect(results.map((m) => m.id)).toEqual(['h-newest', 'w-old'])
  expect(results[0]?.account_email).toBe(HOME)
  expect(results[1]?.account_email).toBe(WORK)
})

test('a send goes FROM the primary account', async () => {
  const client = build([
    { id: 'work', email: WORK, client: fakeAccountClient([meta('w1', '2026-08-01T09:00:00Z')]) },
    { id: 'home', email: HOME, client: fakeAccountClient([meta('h1', '2026-08-02T09:00:00Z')]) },
  ])
  const sent = await client.sendMessage({
    to: ['someone@example.com'],
    subject: 'Hi',
    body: 'Body',
  })
  expect(sent.message_id).toBe('sent-on-w1')
})

test('a message in a NON-primary mailbox still opens', async () => {
  const client = build([
    { id: 'work', email: WORK, client: fakeAccountClient([meta('w1', '2026-08-01T09:00:00Z')]) },
    { id: 'home', email: HOME, client: fakeAccountClient([meta('h1', '2026-08-02T09:00:00Z')]) },
  ])
  const full = await client.getMessage({ message_id: 'h1' })
  expect(full.id).toBe('h1')
  expect(full.account_email).toBe(HOME)
  await expect(client.getMessage({ message_id: 'nope' })).rejects.toBeInstanceOf(
    MessageNotFoundError,
  )
})

test('no connected accounts raises OAuthMissingError — the same signal a null token gave', async () => {
  const client = buildMultiAccountGmailClient({ accounts: async () => [] })
  await expect(client.listMessages({ label: 'INBOX' })).rejects.toBeInstanceOf(
    OAuthMissingError,
  )
})

test('a page cursor is withheld once several accounts are connected, and passed through when one is', async () => {
  const withCursor = (id: string): GmailClient => ({
    ...fakeAccountClient([meta(id, '2026-08-01T09:00:00Z')]),
    async listMessages() {
      return { results: [meta(id, '2026-08-01T09:00:00Z')], next_page_token: `cursor-${id}` }
    },
  })
  const solo = build([{ id: 'work', email: WORK, client: withCursor('w1') }])
  expect((await solo.listMessages({ label: 'INBOX' })).next_page_token).toBe('cursor-w1')

  const pair = build([
    { id: 'work', email: WORK, client: withCursor('w1') },
    { id: 'home', email: HOME, client: withCursor('h1') },
  ])
  // Two per-account cursors cannot be merged into one meaningful cursor, so
  // none is returned rather than one that would silently page a single account.
  expect((await pair.listMessages({ label: 'INBOX' })).next_page_token).toBeUndefined()
})
