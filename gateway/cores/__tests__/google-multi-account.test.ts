/**
 * MULTIPLE GOOGLE ACCOUNTS PER SERVICE — grant store + production composition.
 *
 * The gap this closes: a label named the SERVICE, so a second grant overwrote
 * the first and every read saw one account. An owner running three accounts saw
 * roughly a third of their calendar and mail.
 *
 * These tests run against the REAL composition — a real `SecretsStore`, a real
 * `OAuthTokenManager`, a real `CoreCredentialResolver`, and the clients
 * `mountOpenCores` actually hands the Cores — with only the network faked. A
 * test that built its own fan-out client would prove the fan-out works and
 * nothing about whether the box wires it.
 *
 * Covered:
 *   1. two grants for one service coexist and BOTH resolve;
 *   2. a read spans both and merges, every row tagged with its account;
 *   3. one bad grant degrades to partial results + a surfaced failure — never
 *      an empty success;
 *   4. a pre-existing single-label grant still works (the upgrade path);
 *   5. connecting a second account leaves the first intact.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import { OAUTH_SECRET_LABEL as CALENDAR_LABEL } from '@neutronai/calendar-core'
import { OAUTH_SECRET_LABEL as EMAIL_LABEL } from '@neutronai/email-managed-core'

import {
  OAuthTokenManager,
  accountKeyFromEmail,
  metaLabel,
  parseGrantLabel,
  refreshLabel,
  serviceAccountLabel,
} from '../oauth-token-manager.ts'
import { CoreCredentialResolver } from '../core-credential-resolver.ts'
import { mountOpenCores, GOOGLE_CLIENT_ID_ENV } from '../mount-open-cores.ts'
import { openMigratedDatabaseAt } from '../../../tests/support/migrated-db.ts'

const OWNER = asOwnerHandle('multi-account-test')

const WORK = 'owner@work.example.com'
const PERSONAL = 'owner@personal.example.com'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface Bench {
  db: ProjectDb
  owner_home: string
  secretsStore: SecretsStore
  projectCredentialStore: ProjectCredentialStore
  projectAccountSelectionStore: ProjectAccountSelectionStore
}

function makeBench(): Bench {
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-multi-account-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  const raw = openMigratedDatabaseAt(dbPath)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  const projectCredentialStore = new ProjectCredentialStore(db, { crypto: secretsStore })
  const projectAccountSelectionStore = new ProjectAccountSelectionStore(db)
  return { db, owner_home, secretsStore, projectCredentialStore, projectAccountSelectionStore }
}

/**
 * A Google token endpoint + userinfo that hands back whatever account the test
 * asked for. Used to drive REAL `exchangeAndPersist` calls, so the grants under
 * test are written by production code rather than hand-planted rows.
 */
function grantFetch(byCode: Record<string, { email: string; access: string }>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init?.body ?? ''))
      const code = body.get('code') ?? ''
      const grant = byCode[code]
      if (grant === undefined) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return new Response(
        JSON.stringify({
          access_token: grant.access,
          refresh_token: `refresh-for-${code}`,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
      const grant = Object.values(byCode).find((g) => auth.endsWith(g.access))
      return new Response(JSON.stringify({ email: grant?.email ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('unexpected', { status: 500 })
  }
}

async function connectTwoAccounts(
  bench: Bench,
  services: string[] = [CALENDAR_LABEL],
): Promise<OAuthTokenManager> {
  const tokens = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'test-client',
    client_secret: 'test-secret',
    fetch: grantFetch({
      'code-work': { email: WORK, access: 'tok-work' },
      'code-personal': { email: PERSONAL, access: 'tok-personal' },
    }),
  })
  await tokens.exchangeAndPersist({
    code: 'code-work',
    code_verifier: 'v',
    redirect_uri: 'https://example.test/cb',
    labels: services,
  })
  await tokens.exchangeAndPersist({
    code: 'code-personal',
    code_verifier: 'v',
    redirect_uri: 'https://example.test/cb',
    labels: services,
  })
  return tokens
}

// ── 1 + 5. two grants coexist; the second does not clobber the first ──────────

test('a second account is ADDED, not substituted — both grants resolve independently', async () => {
  const bench = makeBench()
  const tokens = await connectTwoAccounts(bench)

  const grants = await tokens.listGrants(CALENDAR_LABEL)
  expect(grants).toHaveLength(2)
  expect(grants.map((g) => g.email).sort()).toEqual([PERSONAL, WORK].sort())
  // Both labels are per-account, and each resolves to ITS OWN access token —
  // the whole point: the second grant did not overwrite the first.
  const byEmail = new Map(grants.map((g) => [g.email, g.label]))
  expect(await tokens.getAccessToken(byEmail.get(WORK) as string)).toBe('tok-work')
  expect(await tokens.getAccessToken(byEmail.get(PERSONAL) as string)).toBe('tok-personal')

  // And the labels really are service+account, not two unrelated names.
  for (const grant of grants) {
    expect(parseGrantLabel(grant.label).service).toBe(CALENDAR_LABEL)
    expect(grant.account_key).toBe(accountKeyFromEmail(grant.email as string))
  }
})

test('disconnecting one account leaves the other connected', async () => {
  const bench = makeBench()
  const tokens = await connectTwoAccounts(bench)
  const grants = await tokens.listGrants(CALENDAR_LABEL)
  const work = grants.find((g) => g.email === WORK)
  expect(work).toBeDefined()

  await tokens.disconnect((work as { label: string }).label)

  const remaining = await tokens.listGrants(CALENDAR_LABEL)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.email).toBe(PERSONAL)
  expect(await tokens.getAccessToken(remaining[0]?.label as string)).toBe('tok-personal')
})

// ── 4. the upgrade path ───────────────────────────────────────────────────────

test('UPGRADE PATH — a pre-existing un-keyed grant keeps working with no migration step', async () => {
  const bench = makeBench()
  // Exactly the rows an install written before per-account labels holds.
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR_LABEL,
    plaintext: 'legacy-access',
    expires_at: Date.now() + 3600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: refreshLabel(CALENDAR_LABEL),
    plaintext: 'legacy-refresh',
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR_LABEL),
    plaintext: JSON.stringify({
      scopes: [],
      email: WORK,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })

  const tokens = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'c',
    client_secret: 's',
    fetch: async () => new Response('{}', { status: 500 }),
  })

  const grants = await tokens.listGrants(CALENDAR_LABEL)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(CALENDAR_LABEL)
  expect(grants[0]?.account_key).toBeNull()
  expect(grants[0]?.email).toBe(WORK)
  // Still readable, with no rewrite of any row.
  expect(await tokens.getServiceAccessToken(CALENDAR_LABEL)).toBe('legacy-access')

  // And the resolver — the seam every Core reads through — sees it as an account.
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store: bench.projectCredentialStore,
    oauthTokens: tokens,
    accountSelection: bench.projectAccountSelectionStore,
  })
  const accounts = await resolver.accountsFor(CALENDAR_LABEL)
  expect(accounts).toHaveLength(1)
  expect(accounts[0]?.account_email).toBe(WORK)
  expect(await accounts[0]?.accessToken()).toBe('legacy-access')
})

test('UPGRADE PATH — an ANONYMOUS un-keyed grant (ISSUES #494) still resolves through the seam every Core reads', async () => {
  const bench = makeBench()
  // The rows an install written before the authorize URL asked for an identity
  // scope holds: a real, working grant whose `:meta` carries NO address,
  // because userinfo had no scope to answer with. This is the shape the owner
  // is sitting on right now, so it is the shape the read paths must tolerate
  // between deploying the fix and re-consenting.
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR_LABEL,
    plaintext: 'anonymous-access',
    expires_at: Date.now() + 3600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: refreshLabel(CALENDAR_LABEL),
    plaintext: 'anonymous-refresh',
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR_LABEL),
    plaintext: JSON.stringify({
      scopes: ['https://www.googleapis.com/auth/calendar'],
      email: null,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })

  const tokens = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'c',
    client_secret: 's',
    fetch: async () => new Response('{}', { status: 500 }),
  })

  const grants = await tokens.listGrants(CALENDAR_LABEL)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(CALENDAR_LABEL)
  expect(grants[0]?.account_key).toBeNull()
  expect(grants[0]?.email).toBeNull()
  expect(await tokens.getServiceAccessToken(CALENDAR_LABEL)).toBe('anonymous-access')

  // An unknown ADDRESS must not become an unresolvable ACCOUNT: the resolver
  // still hands the Core a working credential, tagged with the legacy id.
  const resolver = new CoreCredentialResolver({
    owner_slug: OWNER,
    store: bench.projectCredentialStore,
    oauthTokens: tokens,
    accountSelection: bench.projectAccountSelectionStore,
  })
  const accounts = await resolver.accountsFor(CALENDAR_LABEL)
  expect(accounts).toHaveLength(1)
  expect(accounts[0]?.account_email).toBeNull()
  expect(await accounts[0]?.accessToken()).toBe('anonymous-access')
  expect(await resolver.resolve(CALENDAR_LABEL)).toBe('anonymous-access')
})

test('UPGRADE PATH — adding a SECOND account alongside a legacy grant yields two accounts, legacy still readable', async () => {
  const bench = makeBench()
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR_LABEL,
    plaintext: 'legacy-access',
    expires_at: Date.now() + 3600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR_LABEL),
    plaintext: JSON.stringify({
      scopes: [],
      email: WORK,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })

  const tokens = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'c',
    client_secret: 's',
    fetch: grantFetch({ 'code-personal': { email: PERSONAL, access: 'tok-personal' } }),
  })
  await tokens.exchangeAndPersist({
    code: 'code-personal',
    code_verifier: 'v',
    redirect_uri: 'https://example.test/cb',
    labels: [CALENDAR_LABEL],
  })

  const grants = await tokens.listGrants(CALENDAR_LABEL)
  expect(grants).toHaveLength(2)
  expect(grants.map((g) => g.email).sort()).toEqual([PERSONAL, WORK].sort())
  const legacy = grants.find((g) => g.account_key === null)
  expect(legacy?.label).toBe(CALENDAR_LABEL)
  expect(await tokens.getAccessToken(CALENDAR_LABEL)).toBe('legacy-access')
})

test('UPGRADE PATH — re-granting the SAME address retires the legacy row instead of showing the account twice', async () => {
  const bench = makeBench()
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: CALENDAR_LABEL,
    plaintext: 'legacy-access',
    expires_at: Date.now() + 3600_000,
  })
  await bench.secretsStore.put({
    owner_handle: OWNER,
    kind: 'oauth_token',
    label: metaLabel(CALENDAR_LABEL),
    plaintext: JSON.stringify({
      scopes: [],
      email: WORK,
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: null,
    }),
  })

  const tokens = new OAuthTokenManager({
    secretsStore: bench.secretsStore,
    owner_handle: OWNER,
    client_id: 'c',
    client_secret: 's',
    fetch: grantFetch({ 'code-work': { email: WORK, access: 'tok-work-fresh' } }),
  })
  await tokens.exchangeAndPersist({
    code: 'code-work',
    code_verifier: 'v',
    redirect_uri: 'https://example.test/cb',
    labels: [CALENDAR_LABEL],
  })

  const grants = await tokens.listGrants(CALENDAR_LABEL)
  expect(grants).toHaveLength(1)
  expect(grants[0]?.label).toBe(serviceAccountLabel(CALENDAR_LABEL, accountKeyFromEmail(WORK)))
  expect(await tokens.getAccessToken(grants[0]?.label as string)).toBe('tok-work-fresh')
})

// ── 2 + 3. the production composition reads across accounts ───────────────────

interface FakeGoogleNet {
  fetch: typeof globalThis.fetch
  /** Bearer tokens the calendar endpoint was actually called with. */
  calendarTokens: string[]
  gmailTokens: string[]
}

/**
 * Fakes the network the REAL Google clients talk to, keyed on the bearer token
 * so each account returns its own data. `deadTokens` refuse both the API call
 * and the refresh exchange — the shape of a revoked grant.
 */
function fakeGoogleNet(input: {
  calendar: Record<string, Array<{ id: string; summary: string; start: string }>>
  gmail?: Record<string, Array<{ id: string; subject: string; date: number }>>
  deadTokens?: string[]
}): FakeGoogleNet {
  const dead = new Set(input.deadTokens ?? [])
  const calendarTokens: string[] = []
  const gmailTokens: string[] = []
  const fetch = (async (
    req: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    const bearer = String(headers.Authorization ?? headers.authorization ?? '').replace(
      /^Bearer\s+/,
      '',
    )

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      // A dead grant's refresh is refused, which is what makes the account fail
      // rather than merely return nothing.
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }
    // Match on the full origin + path prefix, not a substring: a bare
    // `includes` would also match a host that merely CONTAINS the name.
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/')) {
      calendarTokens.push(bearer)
      if (dead.has(bearer)) {
        return new Response('revoked', { status: 401 })
      }
      const items = (input.calendar[bearer] ?? []).map((e) => ({
        id: e.id,
        summary: e.summary,
        status: 'confirmed',
        start: { dateTime: e.start },
        end: { dateTime: e.start },
      }))
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('https://gmail.googleapis.com/')) {
      gmailTokens.push(bearer)
      if (dead.has(bearer)) {
        return new Response('revoked', { status: 401 })
      }
      const box = input.gmail?.[bearer] ?? []
      const single = /\/messages\/([^?]+)/.exec(url)
      if (single !== null) {
        const id = decodeURIComponent(single[1] ?? '')
        const msg = box.find((m) => m.id === id)
        if (msg === undefined) return new Response('{}', { status: 404 })
        return new Response(
          JSON.stringify({
            id: msg.id,
            threadId: `t-${msg.id}`,
            snippet: '',
            internalDate: String(msg.date),
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'Subject', value: msg.subject },
                { name: 'From', value: 'sender@example.com' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ messages: box.map((m) => ({ id: m.id, threadId: `t-${m.id}` })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('unexpected ' + url, { status: 500 })
  }) as typeof globalThis.fetch
  return { fetch, calendarTokens, gmailTokens }
}

function installFakeNet(net: FakeGoogleNet): void {
  const real = globalThis.fetch
  globalThis.fetch = net.fetch
  cleanups.push(() => {
    globalThis.fetch = real
  })
}

async function mount(bench: Bench) {
  const mounted = await mountOpenCores({
    projectDb: bench.db,
    owner_home: bench.owner_home,
    project_slug: OWNER,
    secretsStore: bench.secretsStore,
    projectCredentialStore: bench.projectCredentialStore,
    projectAccountSelectionStore: bench.projectAccountSelectionStore,
    env: { [GOOGLE_CLIENT_ID_ENV]: 'test-client-id' },
    substrate: null,
  })
  cleanups.push(() => mounted.cleanup())
  return mounted
}

test('PRODUCTION COMPOSITION — a calendar read spans BOTH accounts, merged in time order and tagged by account', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [CALENDAR_LABEL])
  installFakeNet(
    fakeGoogleNet({
      calendar: {
        'tok-work': [{ id: 'w1', summary: 'Standup', start: '2026-08-03T09:00:00Z' }],
        'tok-personal': [
          { id: 'p1', summary: 'School pickup', start: '2026-08-03T15:00:00Z' },
          { id: 'p2', summary: 'Dentist', start: '2026-08-03T08:00:00Z' },
        ],
      },
    }),
  )

  const mounted = await mount(bench)
  const events = await mounted.calendarClient.list({
    range_start: '2026-08-03T00:00:00Z',
    range_end: '2026-08-04T00:00:00Z',
  })

  // All three, from both accounts — not one account's worth.
  expect(events.map((e) => e.id)).toEqual(['p2', 'w1', 'p1'])
  // Every row says which account it came from. Without this a merged agenda is
  // unreadable: the owner cannot tell a work meeting from a personal one.
  const byId = new Map(events.map((e) => [e.id, e]))
  expect(byId.get('w1')?.account_email).toBe(WORK)
  expect(byId.get('p1')?.account_email).toBe(PERSONAL)
  expect(byId.get('p2')?.account_email).toBe(PERSONAL)
  for (const event of events) expect(event.account_id).toBeTruthy()
}, 120_000)

test('PRODUCTION COMPOSITION — an event present in BOTH accounts appears once', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [CALENDAR_LABEL])
  // Google gives every attendee's copy of an invitation the same event id, so
  // an owner invited on two of their own accounts must not see it twice.
  const shared = { id: 'shared-1', summary: 'Board call', start: '2026-08-03T10:00:00Z' }
  installFakeNet(
    fakeGoogleNet({ calendar: { 'tok-work': [shared], 'tok-personal': [shared] } }),
  )

  const mounted = await mount(bench)
  const events = await mounted.calendarClient.list({
    range_start: '2026-08-03T00:00:00Z',
    range_end: '2026-08-04T00:00:00Z',
  })
  expect(events).toHaveLength(1)
  expect(events[0]?.id).toBe('shared-1')
}, 120_000)

test('PRODUCTION COMPOSITION — one broken account degrades to PARTIAL results plus a named failure, never an empty success', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [CALENDAR_LABEL])
  installFakeNet(
    fakeGoogleNet({
      calendar: {
        'tok-personal': [{ id: 'p1', summary: 'Dentist', start: '2026-08-03T08:00:00Z' }],
      },
      // The work grant is revoked: the API 401s and the refresh is refused.
      deadTokens: ['tok-work'],
    }),
  )

  const mounted = await mount(bench)
  const across = mounted.calendarClient.listAcrossAccounts
  expect(across).toBeDefined()
  const out = await (across as NonNullable<typeof across>).call(mounted.calendarClient, {
    range_start: '2026-08-03T00:00:00Z',
    range_end: '2026-08-04T00:00:00Z',
  })

  // The healthy account still answers — a broken grant must not blank the day.
  expect(out.events.map((e) => e.id)).toEqual(['p1'])
  // And the failure is REPORTED, not swallowed into a shorter list.
  const failed = out.accounts.filter((a) => !a.ok)
  expect(failed).toHaveLength(1)
  expect(failed[0]?.account_email).toBe(WORK)
  expect(failed[0]?.error ?? '').not.toBe('')
  expect(out.accounts.filter((a) => a.ok).map((a) => a.account_email)).toEqual([PERSONAL])
}, 120_000)

test('PRODUCTION COMPOSITION — when EVERY account fails the read throws rather than reporting an empty calendar', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [CALENDAR_LABEL])
  installFakeNet(
    fakeGoogleNet({ calendar: {}, deadTokens: ['tok-work', 'tok-personal'] }),
  )

  const mounted = await mount(bench)
  // An empty array here would be indistinguishable from a genuinely clear day.
  await expect(
    mounted.calendarClient.list({
      range_start: '2026-08-03T00:00:00Z',
      range_end: '2026-08-04T00:00:00Z',
    }),
  ).rejects.toThrow()
}, 120_000)

test('PRODUCTION COMPOSITION — an inbox read spans BOTH accounts, newest first and tagged by account', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [EMAIL_LABEL])
  installFakeNet(
    fakeGoogleNet({
      calendar: {},
      gmail: {
        'tok-work': [{ id: 'm-work', subject: 'Contract', date: 1_700_000_100_000 }],
        'tok-personal': [{ id: 'm-home', subject: 'Soccer', date: 1_700_000_200_000 }],
      },
    }),
  )

  const mounted = await mount(bench)
  const { results } = await mounted.gmailClient.listMessages({ label: 'INBOX' })
  expect(results.map((m) => m.id)).toEqual(['m-home', 'm-work'])
  const byId = new Map(results.map((m) => [m.id, m]))
  expect(byId.get('m-work')?.account_email).toBe(WORK)
  expect(byId.get('m-home')?.account_email).toBe(PERSONAL)
}, 120_000)

test('PRODUCTION COMPOSITION — one broken mailbox degrades to partial mail plus a named failure', async () => {
  const bench = makeBench()
  await connectTwoAccounts(bench, [EMAIL_LABEL])
  installFakeNet(
    fakeGoogleNet({
      calendar: {},
      gmail: {
        'tok-personal': [{ id: 'm-home', subject: 'Soccer', date: 1_700_000_200_000 }],
      },
      deadTokens: ['tok-work'],
    }),
  )

  const mounted = await mount(bench)
  const across = mounted.gmailClient.listMessagesAcrossAccounts
  expect(across).toBeDefined()
  const out = await (across as NonNullable<typeof across>).call(mounted.gmailClient, {
    label: 'INBOX',
  })
  expect(out.results.map((m) => m.id)).toEqual(['m-home'])
  const failed = out.accounts.filter((a) => !a.ok)
  expect(failed).toHaveLength(1)
  expect(failed[0]?.account_email).toBe(WORK)
}, 120_000)
