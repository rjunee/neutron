/**
 * `gateway/http/project-credentials-surface.ts` — the credential scope
 * boundary (ISSUES #486).
 *
 * A credential written while standing inside ONE project used to be able to
 * change EVERY project: the POST body carried a `scope` field and the DELETE a
 * `?scope=` param, both honoured on the per-project route. Two writers for one
 * fact.
 *
 * These run against the REAL `ProjectCredentialStore` on a real migrated
 * database, so every assertion is about what actually landed in the store —
 * not about which parameters the handler happened to parse. The load-bearing
 * ones read the store back AFTER a rejected request: a 400 that still wrote is
 * the failure mode a status-code-only test would miss.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'

import { createProjectCredentialsSurface } from '../project-credentials-surface.ts'
import { openMigratedDbAt } from '../../../tests/support/migrated-db.ts'

const OWNER = asOwnerHandle('acme')
const PROJECT_URL = 'http://x/api/app/projects/proj-a/credentials'
const GLOBAL_URL = 'http://x/api/app/credentials'

/** Owner bearer accepted; anything else rejected — mirrors the real resolver. */
const auth = {
  resolve: async (token: string) =>
    token === 'good'
      ? { user_id: 'owner', project_slug: 'acme', project_id: 'proj-a' }
      : { code: 'unauthorized', message: 'bad token' },
} as unknown as Parameters<typeof createProjectCredentialsSurface>[0]['auth']

let tmp: string
let db: ProjectDb
let store: ProjectCredentialStore
let handler: (req: Request) => Promise<Response | null>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-cred-surface-'))
  db = openMigratedDbAt(join(tmp, 'project.db'))
  store = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: tmp, db }) })
  handler = createProjectCredentialsSurface({
    store,
    auth,
    accountSelection: new ProjectAccountSelectionStore(db),
    // This file is about the #486 credential-scope boundary; the #500 account
    // view is exercised in `project-account-selection.test.ts`. An empty view
    // keeps this surface constructible without pulling a whole resolver in.
    credentialResolver: { accountSelectionView: async () => [] },
  }).handler
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del(url: string): Request {
  return new Request(url, { method: 'DELETE', headers: { authorization: 'Bearer good' } })
}

function get(url: string): Request {
  return new Request(url, { headers: { authorization: 'Bearer good' } })
}

describe('the project route cannot write instance-wide state', () => {
  test('a project POST asking for scope=global is refused AND writes nothing', async () => {
    const res = await handler(post(PROJECT_URL, { service: 'openai', token: 'sk-credential-123456', scope: 'global' }))
    expect(res?.status).toBe(400)
    expect(((await res?.json()) as { code: string }).code).toBe('scope_not_allowed')
    // The store is the witness: no global default appeared, and no project row
    // was quietly written under the URL project instead.
    expect(store.listGlobal(OWNER)).toHaveLength(0)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(0)
  })

  test('a project POST with no scope writes THIS project only', async () => {
    const res = await handler(post(PROJECT_URL, { service: 'openai', token: 'sk-credential-123456' }))
    expect(res?.status).toBe(201)
    const rows = store.listForProject(OWNER, 'proj-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toBe('project')
    expect(rows[0]!.project_id).toBe('proj-a')
    expect(store.listGlobal(OWNER)).toHaveLength(0)
  })

  test("a project POST that says scope=project still writes the project's row", async () => {
    const res = await handler(post(PROJECT_URL, { service: 'openai', token: 'sk-credential-123456', scope: 'project' }))
    expect(res?.status).toBe(201)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(1)
    expect(store.listGlobal(OWNER)).toHaveLength(0)
  })

  test('?scope=global on a project DELETE is refused AND the global default survives', async () => {
    await store.set(OWNER, { service: 'openai', plaintext: 'sk-global', scope: 'global' })
    const res = await handler(del(`${PROJECT_URL}/openai?scope=global`))
    expect(res?.status).toBe(400)
    expect(((await res?.json()) as { code: string }).code).toBe('scope_not_allowed')
    expect(store.listGlobal(OWNER)).toHaveLength(1)
  })

  test('a project DELETE removes only the project row, leaving the inherited default', async () => {
    await store.set(OWNER, { service: 'openai', plaintext: 'sk-global', scope: 'global' })
    await store.set(OWNER, {
      service: 'openai',
      plaintext: 'sk-project',
      scope: 'project',
      project_id: 'proj-a',
    })
    const res = await handler(del(`${PROJECT_URL}/openai`))
    expect(res?.status).toBe(200)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(0)
    expect(store.listGlobal(OWNER)).toHaveLength(1)
  })

  test('the project GET still SHOWS the inherited defaults — reading them is the useful part', async () => {
    await store.set(OWNER, { service: 'openai', plaintext: 'sk-global', scope: 'global' })
    await store.set(OWNER, {
      service: 'apify',
      plaintext: 'sk-project',
      scope: 'project',
      project_id: 'proj-a',
    })
    const res = await handler(get(PROJECT_URL))
    const body = (await res?.json()) as { project: unknown[]; global: unknown[] }
    expect(body.project).toHaveLength(1)
    expect(body.global).toHaveLength(1)
  })
})

describe('the global route is the one writer of instance-wide state', () => {
  test('named values are write-only on both POST and GET, while the store can resolve them', async () => {
    const secret = 'positive-secret-value-12345'
    const created = await handler(post(GLOBAL_URL, { service: 'custom_build', token: secret }))
    const createdText = await created!.text()
    expect(created?.status).toBe(201)
    expect(createdText).toContain('custom_build')
    expect(createdText).not.toContain(secret)

    const listedText = await (await handler(get(GLOBAL_URL)))!.text()
    expect(listedText).toContain('custom_build')
    expect(listedText).not.toContain(secret)
    expect(store.resolve(OWNER, undefined, 'custom_build')?.plaintext).toBe(secret)
  })

  test('the named-key field enforces the scrubber floor in both directions', async () => {
    const tooShort = await handler(
      post(GLOBAL_URL, { service: 'custom_build', token: 'x'.repeat(15) }),
    )
    expect(tooShort?.status).toBe(400)
    expect(store.listGlobal(OWNER)).toEqual([])

    const accepted = await handler(
      post(GLOBAL_URL, { service: 'custom_build', token: 'x'.repeat(16) }),
    )
    expect(accepted?.status).toBe(201)
    expect(store.resolve(OWNER, undefined, 'custom_build')?.plaintext).toBe('x'.repeat(16))
  })

  test('a global POST writes the global default and no project row', async () => {
    const res = await handler(post(GLOBAL_URL, { service: 'openai', token: 'sk-credential-123456', label: 'shared' }))
    expect(res?.status).toBe(201)
    const rows = store.listGlobal(OWNER)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toBe('global')
    expect(rows[0]!.project_id).toBe('')
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(0)
  })

  test('a global POST asking for scope=project is refused AND writes nothing', async () => {
    const res = await handler(post(GLOBAL_URL, { service: 'openai', token: 'sk-credential-123456', scope: 'project' }))
    expect(res?.status).toBe(400)
    expect(((await res?.json()) as { code: string }).code).toBe('scope_not_allowed')
    expect(store.listGlobal(OWNER)).toHaveLength(0)
    expect(store.listForProject(OWNER, 'proj-a')).toHaveLength(0)
  })

  test('a global DELETE removes the default', async () => {
    await store.set(OWNER, { service: 'openai', plaintext: 'sk-global', scope: 'global' })
    const res = await handler(del(`${GLOBAL_URL}/openai`))
    expect(res?.status).toBe(200)
    expect(store.listGlobal(OWNER)).toHaveLength(0)
  })

  test('a global DELETE for an unknown service is a 404, not a silent success', async () => {
    const res = await handler(del(`${GLOBAL_URL}/nope`))
    expect(res?.status).toBe(404)
  })

  test('the global GET lists the defaults and carries no project id', async () => {
    await store.set(OWNER, { service: 'openai', plaintext: 'sk-global', scope: 'global' })
    const res = await handler(get(GLOBAL_URL))
    const body = (await res?.json()) as { global: unknown[]; project_id?: string }
    expect(body.global).toHaveLength(1)
    expect(body.project_id).toBeUndefined()
  })

  test('nothing on either family is reachable without the owner bearer', async () => {
    const anon = await handler(new Request(GLOBAL_URL))
    expect(anon?.status).toBe(401)
    const anonProject = await handler(new Request(PROJECT_URL))
    expect(anonProject?.status).toBe(401)
  })

  test('an unrelated path falls through so the composer chain continues', async () => {
    expect(await handler(get('http://x/api/app/projects/proj-a/tabs'))).toBeNull()
    expect(await handler(get('http://x/api/app/credentialsomething'))).toBeNull()
  })
})
