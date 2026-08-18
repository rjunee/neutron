/**
 * ISSUES #500 — `/api/app/projects/<id>/accounts`, the per-project
 * connected-account selection surface.
 *
 * WHAT FAILS WITHOUT THIS. #486 made the project Settings tab read-only for
 * GLOBAL credentials, because a project surface must not author instance-wide
 * state. A per-project ACCOUNT selection is the opposite case — it can only ever
 * mean something inside one project — so it belongs on a project route. These
 * tests pin that it is genuinely project-scoped: the write lands under the
 * bearer's owner + the URL's project, and nothing it does is visible to another
 * project.
 *
 * Real store + real SQLite; the resolver is a hand-written stand-in whose
 * connected-account list is a fixed literal, so what the surface returns can
 * only come from the join it performs, never from a value it computed itself.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import { createProjectCredentialsSurface } from '../project-credentials-surface.ts'

const OWNER = asOwnerHandle('acme')
const ACCOUNTS_URL = 'http://x/api/app/projects/proj-a/accounts'
const OTHER_ACCOUNTS_URL = 'http://x/api/app/projects/proj-b/accounts'

/** Owner bearer accepted; anything else rejected — mirrors the real resolver. */
const auth = {
  resolve: async (token: string) =>
    token === 'good'
      ? { user_id: 'owner', project_slug: 'acme', project_id: 'proj-a' }
      : { code: 'unauthorized', message: 'bad token' },
} as unknown as Parameters<typeof createProjectCredentialsSurface>[0]['auth']

/** The two accounts "connected" for the whole of this file. Literal on purpose. */
const CONNECTED = [
  { account_id: 'aaaa1111', account_email: 'personal@example.com' },
  { account_id: 'bbbb2222', account_email: 'work@example.com' },
]

let tmp: string
let db: ProjectDb
let selection: ProjectAccountSelectionStore
let handler: (req: Request) => Promise<Response | null>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-accounts-surface-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  selection = new ProjectAccountSelectionStore(db)
  handler = createProjectCredentialsSurface({
    store: new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: tmp, db }) }),
    auth,
    accountSelection: selection,
    // Stands in for `CoreCredentialResolver.accountSelectionView` — same join,
    // fixed grant list, so the surface's output is traceable to the store.
    credentialResolver: {
      accountSelectionView: async (projectId: string) => {
        const disabled = selection.disabledAccountIds(OWNER, projectId, 'google_calendar')
        return [
          {
            service: 'google_calendar',
            accounts: CONNECTED.map((a) => ({
              account_id: a.account_id,
              label: a.account_email,
              account_email: a.account_email,
              enabled: !disabled.has(a.account_id),
            })),
          },
        ]
      },
    },
  }).handler
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function get(url: string, token = 'good'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } })
}

function put(url: string, body: unknown, token = 'good'): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET returns every connected account ENABLED for a project that never configured one', async () => {
  const res = await handler(get(ACCOUNTS_URL))
  expect(res?.status).toBe(200)
  const body = (await res!.json()) as {
    ok: boolean
    project_id: string
    services: Array<{
      service: string
      accounts: Array<{
        account_id: string
        label: string
        account_email: string | null
        enabled: boolean
      }>
    }>
  }
  expect(body.ok).toBe(true)
  expect(body.project_id).toBe('proj-a')
  expect(body.services[0]?.service).toBe('google_calendar')
  expect(body.services[0]?.accounts).toEqual([
    { account_id: 'aaaa1111', label: 'personal@example.com', account_email: 'personal@example.com', enabled: true },
    { account_id: 'bbbb2222', label: 'work@example.com', account_email: 'work@example.com', enabled: true },
  ])
})

test('PUT disables one account and returns the refreshed view', async () => {
  const res = await handler(
    put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: false }),
  )
  expect(res?.status).toBe(200)
  const body = (await res!.json()) as {
    services: Array<{ accounts: Array<{ account_id: string; enabled: boolean }> }>
  }
  expect(body.services[0]?.accounts.map((a) => [a.account_id, a.enabled])).toEqual([
    ['aaaa1111', false],
    ['bbbb2222', true],
  ])

  // The write landed under the bearer's owner + the URL's project.
  expect(selection.listForProject(OWNER, 'proj-a').map((r) => r.account_id)).toEqual(['aaaa1111'])
})

test('a disable in one project is invisible in another', async () => {
  await handler(
    put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: false }),
  )
  const res = await handler(get(OTHER_ACCOUNTS_URL))
  const body = (await res!.json()) as {
    project_id: string
    services: Array<{ accounts: Array<{ enabled: boolean }> }>
  }
  expect(body.project_id).toBe('proj-b')
  expect(body.services[0]?.accounts.map((a) => a.enabled)).toEqual([true, true])
})

test('disabling the LAST account is allowed and reports the empty selection honestly', async () => {
  for (const account_id of ['aaaa1111', 'bbbb2222']) {
    const res = await handler(put(ACCOUNTS_URL, { service: 'google_calendar', account_id, enabled: false }))
    expect(res?.status).toBe(200)
  }
  const res = await handler(get(ACCOUNTS_URL))
  const body = (await res!.json()) as { services: Array<{ accounts: Array<{ enabled: boolean }> }> }
  expect(body.services[0]?.accounts.map((a) => a.enabled)).toEqual([false, false])
})

test('PUT re-enables by DELETING the disable row (the default is the absence of state)', async () => {
  await handler(put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: false }))
  expect(selection.listForProject(OWNER, 'proj-a')).toHaveLength(1)
  await handler(put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: true }))
  expect(selection.listForProject(OWNER, 'proj-a')).toEqual([])
})

test('a bad bearer is 401 and writes nothing', async () => {
  const res = await handler(
    put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: false }, 'bad'),
  )
  expect(res?.status).toBe(401)
  expect(selection.listForProject(OWNER, 'proj-a')).toEqual([])
})

test('a non-boolean `enabled` is a 400, never a silent disable', async () => {
  const res = await handler(
    put(ACCOUNTS_URL, { service: 'google_calendar', account_id: 'aaaa1111', enabled: 'false' }),
  )
  expect(res?.status).toBe(400)
  expect((await res!.json()) as { code: string }).toMatchObject({ code: 'invalid_enabled' })
  expect(selection.listForProject(OWNER, 'proj-a')).toEqual([])
})

test('a missing account_id is a 400 from the store, not a 500', async () => {
  const res = await handler(put(ACCOUNTS_URL, { service: 'google_calendar', enabled: false }))
  expect(res?.status).toBe(400)
  expect((await res!.json()) as { code: string }).toMatchObject({ code: 'invalid_account_id' })
})

test('POST is 405 — the toggle is idempotent and PUT says so', async () => {
  const res = await handler(
    new Request(ACCOUNTS_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(res?.status).toBe(405)
})
