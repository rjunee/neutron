/**
 * Calendar fan-out — the merge rule, write routing, and the line the OWNER sees
 * when an account could not be read.
 *
 * The production-composition guard lives in
 * `gateway/cores/__tests__/google-multi-account.test.ts`; this file pins the
 * rules that guard cannot easily provoke — truncation across accounts, which
 * account a write lands on, and the degraded-account text `/cal show` renders.
 */

import { expect, test } from 'bun:test'

import {
  EventNotFoundError,
  OAuthMissingError,
  buildMultiAccountGoogleCalendarClient,
  executeCalCommand,
  parseCalCommand,
  type CalendarAccountDescriptor,
  type CalendarClient,
  type CalendarEventRow,
} from '../index.ts'

const WORK = 'owner@work.example.com'
const HOME = 'owner@home.example.com'

function row(id: string, start: string): CalendarEventRow {
  return { id, calendar_id: 'primary', title: id, start, end: start, status: 'confirmed' }
}

/** A per-account stand-in for the Google client. */
function fakeAccountClient(rows: CalendarEventRow[], opts: { fail?: string } = {}): CalendarClient {
  const client: CalendarClient = {
    async list() {
      if (opts.fail !== undefined) throw new Error(opts.fail)
      return rows
    },
    async create(input) {
      return row(`created-on-${rows[0]?.id ?? 'empty'}`, input.start)
    },
    async update(input) {
      const found = rows.find((r) => r.id === input.event_id)
      if (found === undefined) throw new EventNotFoundError(input.event_id)
      return found
    },
    async cancel(input) {
      if (!rows.some((r) => r.id === input.event_id)) {
        throw new EventNotFoundError(input.event_id)
      }
    },
    async get(input) {
      const found = rows.find((r) => r.id === input.event_id)
      if (found === undefined) throw new EventNotFoundError(input.event_id)
      return found
    },
    async freebusy() {
      return []
    },
    async findTime() {
      return []
    },
    async invite(input) {
      const found = rows.find((r) => r.id === input.event_id)
      if (found === undefined) throw new EventNotFoundError(input.event_id)
      return found
    },
  }
  return client
}

function build(
  accounts: Array<{ id: string; email: string | null; client: CalendarClient }>,
): CalendarClient {
  const byId = new Map(accounts.map((a) => [a.id, a.client]))
  return buildMultiAccountGoogleCalendarClient({
    accounts: async (): Promise<CalendarAccountDescriptor[]> =>
      accounts.map((a) => ({
        account_id: a.id,
        account_email: a.email,
        accessToken: async () => `token-${a.id}`,
      })),
    buildClient: (account) => byId.get(account.account_id) as CalendarClient,
  })
}

test('truncation happens AFTER the merge — the earliest events overall survive, not the earliest per account', async () => {
  const client = build([
    {
      id: 'work',
      email: WORK,
      client: fakeAccountClient([
        row('w-late', '2026-08-03T18:00:00Z'),
        row('w-mid', '2026-08-03T12:00:00Z'),
      ]),
    },
    {
      id: 'home',
      email: HOME,
      client: fakeAccountClient([row('h-early', '2026-08-03T07:00:00Z')]),
    },
  ])
  const events = await client.list({
    range_start: '2026-08-03T00:00:00Z',
    range_end: '2026-08-04T00:00:00Z',
    limit: 2,
  })
  // Per-account truncation would have kept w-late; merge-then-truncate keeps
  // the two genuinely earliest.
  expect(events.map((e) => e.id)).toEqual(['h-early', 'w-mid'])
})

test('a create lands on the PRIMARY account and says so', async () => {
  const client = build([
    { id: 'work', email: WORK, client: fakeAccountClient([row('w1', '2026-08-03T09:00:00Z')]) },
    { id: 'home', email: HOME, client: fakeAccountClient([row('h1', '2026-08-03T10:00:00Z')]) },
  ])
  const created = await client.create({
    title: 'New',
    start: '2026-08-04T09:00:00Z',
    end: '2026-08-04T10:00:00Z',
  })
  expect(created.id).toBe('created-on-w1')
  expect(created.account_email).toBe(WORK)
})

test('an event id belonging to a NON-primary account still resolves', async () => {
  const client = build([
    { id: 'work', email: WORK, client: fakeAccountClient([row('w1', '2026-08-03T09:00:00Z')]) },
    { id: 'home', email: HOME, client: fakeAccountClient([row('h1', '2026-08-03T10:00:00Z')]) },
  ])
  const got = await client.get({ event_id: 'h1' })
  expect(got.id).toBe('h1')
  expect(got.account_email).toBe(HOME)
  // A genuinely unknown id still raises the same typed error as before.
  await expect(client.get({ event_id: 'nope' })).rejects.toBeInstanceOf(EventNotFoundError)
})

test('no connected accounts raises OAuthMissingError — the same signal a null token gave', async () => {
  const client = buildMultiAccountGoogleCalendarClient({ accounts: async () => [] })
  await expect(
    client.list({ range_start: '2026-08-03T00:00:00Z', range_end: '2026-08-04T00:00:00Z' }),
  ).rejects.toBeInstanceOf(OAuthMissingError)
})

test('/cal show NAMES the account it could not read, and labels lines by account', async () => {
  const client = build([
    {
      id: 'work',
      email: WORK,
      client: fakeAccountClient([], { fail: 'token revoked' }),
    },
    {
      id: 'home',
      email: HOME,
      client: fakeAccountClient([row('h1', '2026-08-03T10:00:00Z')]),
    },
  ])
  const now = new Date('2026-08-03T06:00:00Z')
  const cmd = parseCalCommand('/cal show today', now)
  const res = await executeCalCommand(cmd, { client, now })
  // The healthy account's event is present …
  expect(res.text).toContain('h1')
  // … tagged with which account it came from …
  expect(res.text).toContain(HOME)
  // … and the owner is TOLD their other calendar is missing, rather than being
  // shown a plausible-looking short day.
  expect(res.text).toContain('Could not read')
  expect(res.text).toContain(WORK)
})
