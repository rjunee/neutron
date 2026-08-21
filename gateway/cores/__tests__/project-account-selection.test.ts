/**
 * ISSUES #500 — per-project connected-account SELECTION, proved at the seam.
 *
 * WHAT FAILS WITHOUT THIS. Every project read every connected account, so a
 * question asked inside a work project swept a personal calendar and mailbox,
 * and each newly connected account made every query in every project noisier.
 * The fix filters `CoreCredentialResolver.accountsFor` — the primitive every
 * Core reads through — against a per-project DISABLE list.
 *
 * The four behaviours that must hold, each of which would silently break a live
 * instance if it did not:
 *
 *   1. an UNCONFIGURED project sees ALL accounts (unset means enabled — anything
 *      else breaks every existing project the moment this ships);
 *   2. disabling ONE leaves the others resolving (a narrowing, not an outage);
 *   3. disabling ALL yields an EMPTY list and NOT an error (a legitimate "this
 *      project doesn't use Gmail");
 *   4. a NEWLY connected account appears in a project that ALREADY has a
 *      selection ("connect once, works everywhere" survives narrowing).
 *
 * Every expectation is written LITERALLY — the emails, ids and counts are typed
 * out rather than derived from the fake's own data, so a fake that agreed with
 * itself by construction could not make these pass.
 *
 * Real `ProjectAccountSelectionStore` over real SQLite (the migration is what is
 * under test as much as the filter); the OAuth manager is faked because a live
 * Google grant is not obtainable in a test, and the fake's ONLY job is to name
 * which accounts are connected.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import {
  AccountSelectionValidationError,
  ProjectAccountSelectionStore,
} from '@neutronai/project-credentials/account-selection-store.ts'
import type { OAuthTokenManager } from '../oauth-token-manager.ts'
import { CoreCredentialResolver, humaniseAccount } from '../core-credential-resolver.ts'
import { runWithActiveProject } from '../active-project-context.ts'

const OWNER = asOwnerHandle('account-selection-test')
const WORK_PROJECT = 'proj-work'
const OTHER_PROJECT = 'proj-other'
const CALENDAR = 'google_calendar'

/** Literal account fixtures — the values every expectation below is typed against. */
const PERSONAL = { key: 'aaaa1111', email: 'personal@example.com' }
const WORK = { key: 'bbbb2222', email: 'work@example.com' }
const THIRD = { key: 'cccc3333', email: 'third@example.com' }

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface Bench {
  store: ProjectCredentialStore
  selection: ProjectAccountSelectionStore
}

function makeBench(): Bench {
  const owner_home = mkdtempSync(join(tmpdir(), 'acct-selection-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  return {
    store: new ProjectCredentialStore(db, { crypto: secretsStore }),
    selection: new ProjectAccountSelectionStore(db),
  }
}

/**
 * A fake OAuth manager over a MUTABLE grant list, so a test can connect an
 * account mid-run the way the owner does. The token it hands back is
 * `token:<account_key>` — a value the resolver never constructs itself, so an
 * assertion on it proves the right ACCOUNT's accessor fired.
 */
function fakeOAuth(
  accounts: Array<{ key: string; email: string }>,
  connectedServices: readonly string[] = ['google_calendar', 'gmail_compose', 'google_workspace'],
): OAuthTokenManager {
  return {
    listGrants: async (service: string) =>
      (connectedServices.includes(service) ? accounts : []).map((a) => ({
        label: `${service}#${a.key}`,
        service,
        account_key: a.key,
        email: a.email,
      })),
    getAccessToken: async (label: string): Promise<string | null> => {
      const key = label.slice(label.indexOf('#') + 1)
      return `token:${key}`
    },
  } as unknown as OAuthTokenManager
}

function makeResolver(
  bench: Bench,
  accounts: Array<{ key: string; email: string }>,
  connectedServices?: readonly string[],
): CoreCredentialResolver {
  return new CoreCredentialResolver({
    owner_slug: OWNER,
    store: bench.store,
    oauthTokens:
      connectedServices === undefined
        ? fakeOAuth(accounts)
        : fakeOAuth(accounts, connectedServices),
    accountSelection: bench.selection,
  })
}

// ── 1. Unset means enabled ───────────────────────────────────────────────────

test('a project with NO selection configured reads EVERY connected account', async () => {
  const bench = makeBench()
  const resolver = makeResolver(bench, [PERSONAL, WORK, THIRD])

  const accounts = await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })

  expect(accounts.map((a) => a.account_id)).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
  expect(accounts.map((a) => a.account_email)).toEqual([
    'personal@example.com',
    'work@example.com',
    'third@example.com',
  ])
})

test('the no-project frame (General topic / cron) is never narrowed', async () => {
  const bench = makeBench()
  // Narrow the WORK project hard — every account off.
  for (const key of ['aaaa1111', 'bbbb2222']) {
    await bench.selection.setEnabled(OWNER, {
      project_id: WORK_PROJECT,
      service: CALENDAR,
      account_id: key,
      enabled: false,
    })
  }
  const resolver = makeResolver(bench, [PERSONAL, WORK])

  // No ambient frame bound → '' → no selection applies.
  const unbound = await resolver.accountsFor(CALENDAR)
  expect(unbound.map((a) => a.account_id)).toEqual(['aaaa1111', 'bbbb2222'])

  // And explicitly inside the narrowed project, it DOES apply — proving the
  // line above is about the absent frame, not about the filter being inert.
  const inProject = await runWithActiveProject(WORK_PROJECT, () =>
    resolver.accountsFor(CALENDAR),
  )
  expect(inProject).toEqual([])
})

// ── 2. Disabling one leaves the others resolving ─────────────────────────────

test('disabling ONE account leaves the others resolving — for this project only', async () => {
  const bench = makeBench()
  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111', // personal@example.com
    enabled: false,
  })
  const resolver = makeResolver(bench, [PERSONAL, WORK, THIRD])

  const narrowed = await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })
  expect(narrowed.map((a) => a.account_email)).toEqual([
    'work@example.com',
    'third@example.com',
  ])
  // The survivors still resolve a TOKEN, not just a row — a filter that returned
  // structurally-correct-but-dead accounts would pass a shape-only assertion.
  expect(await narrowed[0]!.accessToken()).toBe('token:bbbb2222')

  // `resolve` narrows to the primary, which is now the FIRST ENABLED account —
  // the disabled one must not remain the primary a write path picks.
  expect(await resolver.resolve(CALENDAR, { projectId: WORK_PROJECT })).toBe('token:bbbb2222')

  // Another project is untouched: this is a per-project selection, not a
  // disconnect. Written literally rather than "not equal to the narrowed set".
  const other = await resolver.accountsFor(CALENDAR, { projectId: OTHER_PROJECT })
  expect(other.map((a) => a.account_email)).toEqual([
    'personal@example.com',
    'work@example.com',
    'third@example.com',
  ])
})

test('re-enabling restores the account (the toggle is reversible, not a tombstone)', async () => {
  const bench = makeBench()
  const resolver = makeResolver(bench, [PERSONAL, WORK])

  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  })
  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_id),
  ).toEqual(['bbbb2222'])

  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: true,
  })
  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_id),
  ).toEqual(['aaaa1111', 'bbbb2222'])
})

test('the selection is per SERVICE — turning an account off for Calendar leaves Gmail alone', async () => {
  const bench = makeBench()
  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  })
  const resolver = makeResolver(bench, [PERSONAL, WORK])

  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_id),
  ).toEqual(['bbbb2222'])
  expect(
    (await resolver.accountsFor('gmail_compose', { projectId: WORK_PROJECT })).map(
      (a) => a.account_id,
    ),
  ).toEqual(['aaaa1111', 'bbbb2222'])
})

// ── 3. Disabling all is empty, not an error ──────────────────────────────────

test('disabling EVERY account for a service is empty and NOT an error', async () => {
  const bench = makeBench()
  for (const key of ['aaaa1111', 'bbbb2222']) {
    await bench.selection.setEnabled(OWNER, {
      project_id: WORK_PROJECT,
      service: CALENDAR,
      account_id: key,
      enabled: false,
    })
  }
  const resolver = makeResolver(bench, [PERSONAL, WORK])

  expect(await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).toEqual([])
  // `resolve` degrades to "uncredentialed" — the graceful empty state a Core
  // already renders — rather than throwing.
  expect(await resolver.resolve(CALENDAR, { projectId: WORK_PROJECT })).toBeNull()
  // The lazy fan-out accessor a Core is built with degrades the same way.
  const lazy = resolver.accountsResolverFor(CALENDAR)
  expect(await runWithActiveProject(WORK_PROJECT, () => lazy())).toEqual([])
  // And the VIEW says so out loud, so the surface can show "off" rather than blank.
  const view = await resolver.accountSelectionView(WORK_PROJECT)
  const calendar = view.find((s) => s.service === CALENDAR)
  expect(calendar?.accounts.map((a) => a.enabled)).toEqual([false, false])
})

// ── 4. A newly connected account joins a project that already narrowed ───────

test('a NEWLY connected account is visible in a project that ALREADY has a selection', async () => {
  const bench = makeBench()
  // The work project narrowed to work@ only, back when two accounts existed.
  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  })
  const connected = [PERSONAL, WORK]
  const resolver = makeResolver(bench, connected)
  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_email),
  ).toEqual(['work@example.com'])

  // The owner connects a THIRD account. Nothing about the project is touched.
  connected.push(THIRD)

  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_email),
  ).toEqual(['work@example.com', 'third@example.com'])
})

// ── The Settings read model ──────────────────────────────────────────────────

test('the Settings view shows humanised labels and this project’s enable state', async () => {
  const bench = makeBench()
  await bench.selection.setEnabled(OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  })
  // Only Calendar + Gmail are connected — Drive has no grant at all.
  const resolver = makeResolver(bench, [PERSONAL, WORK], ['google_calendar', 'gmail_compose'])

  const view = await resolver.accountSelectionView(WORK_PROJECT)
  // Every SELECTABLE service is listed regardless of what is connected, so the
  // response shape does not fluctuate with connection state and the surface can
  // say "nothing connected" for a service instead of silently omitting it.
  expect(view.map((s) => s.service)).toEqual([
    'google_calendar',
    'gmail_compose',
    'google_workspace',
  ])
  expect(view.find((s) => s.service === 'google_workspace')?.accounts).toEqual([])
  const calendar = view.find((s) => s.service === CALENDAR)
  expect(calendar?.accounts).toEqual([
    {
      account_id: 'aaaa1111',
      label: 'personal@example.com',
      account_email: 'personal@example.com',
      enabled: false,
    },
    {
      account_id: 'bbbb2222',
      label: 'work@example.com',
      account_email: 'work@example.com',
      enabled: true,
    },
  ])
  // Gmail was never narrowed → both on, which is the "unset means enabled"
  // contract expressed in the surface the owner actually looks at.
  expect(view.find((s) => s.service === 'gmail_compose')?.accounts.map((a) => a.enabled)).toEqual([
    true,
    true,
  ])
})

test('an account with no address gets plain English, never the hex key', () => {
  // A hex account key must never reach the owner's screen.
  expect(humaniseAccount({ account_id: 'default', account_email: null })).toBe('Connected account')
  expect(humaniseAccount({ account_id: 'manual', account_email: null })).toBe('Pasted token')
  expect(humaniseAccount({ account_id: 'aaaa1111', account_email: null })).toBe('Connected account')
  expect(humaniseAccount({ account_id: 'aaaa1111', account_email: 'someone@example.com' })).toBe(
    'someone@example.com',
  )
})

// ── Store-level invariants ───────────────────────────────────────────────────

test('the store refuses to record a disable against the no-project sentinel', async () => {
  const bench = makeBench()
  // The STORE must reject it, with a typed validation error the HTTP surface
  // maps to a 400. Merely "something threw" is not the contract: the SQL CHECK
  // in 0115 also refuses the row, but a raw SQLite constraint error escapes the
  // surface's error mapping as a 500 — so this asserts the layer, not just the
  // outcome. (Found by mutation: deleting the store guard left the DB catching
  // it and a weaker assertion still passing.)
  let caught: unknown = null
  try {
    await bench.selection.setEnabled(OWNER, {
      project_id: '',
      service: CALENDAR,
      account_id: 'aaaa1111',
      enabled: false,
    })
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(AccountSelectionValidationError)
  expect((caught as AccountSelectionValidationError).code).toBe('invalid_project_id')
})

test('the store refuses a blank service or account id the same way', async () => {
  const bench = makeBench()
  for (const [field, input] of [
    ['invalid_service', { project_id: WORK_PROJECT, service: '  ', account_id: 'aaaa1111' }],
    ['invalid_account_id', { project_id: WORK_PROJECT, service: CALENDAR, account_id: '' }],
  ] as const) {
    let caught: unknown = null
    try {
      await bench.selection.setEnabled(OWNER, { ...input, enabled: false })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AccountSelectionValidationError)
    expect((caught as AccountSelectionValidationError).code).toBe(field)
  }
})

test('toggling twice in the same direction is idempotent, not a double-write', async () => {
  const bench = makeBench()
  const off = {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  }
  await bench.selection.setEnabled(OWNER, off)
  await bench.selection.setEnabled(OWNER, off)
  expect(bench.selection.listForProject(OWNER, WORK_PROJECT).map((r) => r.account_id)).toEqual([
    'aaaa1111',
  ])

  const on = { ...off, enabled: true }
  await bench.selection.setEnabled(OWNER, on)
  await bench.selection.setEnabled(OWNER, on)
  expect(bench.selection.listForProject(OWNER, WORK_PROJECT)).toEqual([])
})

test('a selection cannot cross the owner boundary', async () => {
  const bench = makeBench()
  const OTHER_OWNER = asOwnerHandle('someone-else')
  await bench.selection.setEnabled(OTHER_OWNER, {
    project_id: WORK_PROJECT,
    service: CALENDAR,
    account_id: 'aaaa1111',
    enabled: false,
  })
  const resolver = makeResolver(bench, [PERSONAL, WORK])

  // Same project id, different owner → this owner is unaffected.
  expect(
    (await resolver.accountsFor(CALENDAR, { projectId: WORK_PROJECT })).map((a) => a.account_id),
  ).toEqual(['aaaa1111', 'bbbb2222'])
})
