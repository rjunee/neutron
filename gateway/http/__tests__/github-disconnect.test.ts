import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { deleteGitHubToken, readGitHubToken, storeGitHubToken, githubProcessEnv } from '@neutronai/github/credential.ts'
import type { connectGitHub } from '@neutronai/github/connect.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { createGitHubConnectSurface } from '../github-connect-surface.ts'

let dir: string
let db: ProjectDb
let secrets: SecretsStore
const owner = asOwnerHandle('owner')
const other = asOwnerHandle('other')
const grant = { user_code: 'CODE', verification_uri: 'https://example.test/device', expires_in_seconds: 900 }
const auth = { resolve: async (token: string) => token === 'invalid'
  ? { code: 'invalid_signature', message: 'invalid bearer' }
  : { project_slug: token, user_id: 'actor' } } as never
function request(method: string, token = 'owner') {
  return new Request('https://example.test/api/app/github-auth?owner_handle=other', {
    method, headers: { authorization: `Bearer ${token}` },
  })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 10))
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-disconnect-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  db = ProjectDb.open(path)
  secrets = new SecretsStore({ db, data_dir: dir })
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('disconnect physically removes a legacy row, preserves other coordinates, then reconnects', async () => {
  await storeGitHubToken(secrets, owner, 'old-token')
  const inFlight = githubProcessEnv(await readGitHubToken(secrets, owner))
  await storeGitHubToken(secrets, other, 'other-token')
  await secrets.put({ owner_handle: owner, kind: 'oauth_token', label: 'unrelated', plaintext: 'keep' })
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', connect: async (input) => {
    await input.present(grant)
    await storeGitHubToken(input.store, input.owner_handle, 'new-token')
    return { connected: true }
  } })
  const response = await surface.handler(request('DELETE'))
  expect(await response!.json()).toEqual({ ok: true, status: 'not_connected', removed: true, cancelled: false })
  expect(await secrets.list({ owner_handle: owner })).toHaveLength(1)
  expect(await readGitHubToken(secrets, owner)).toBeNull()
  expect(await readGitHubToken(secrets, other)).toBe('other-token')
  expect(await secrets.get({ owner_handle: owner, kind: 'oauth_token', label: 'unrelated' })).toBe('keep')
  expect(inFlight.GH_TOKEN).toBe('old-token')
  expect(await (await surface.handler(request('GET')))!.json()).toMatchObject({ status: 'not_connected' })
  expect(await (await surface.handler(request('DELETE')))!.json()).toMatchObject({ removed: false })
  await surface.handler(request('POST'))
  await tick()
  expect(await readGitHubToken(secrets, owner)).toBe('new-token')
})

test('expired and corrupt credentials can be removed without decrypting them', async () => {
  await secrets.put({ owner_handle: owner, kind: 'oauth_token', label: 'github', plaintext: 'expired', expires_at: 1 })
  expect(await deleteGitHubToken(secrets, owner)).toBe(true)
  await storeGitHubToken(secrets, owner, 'broken')
  await db.run("UPDATE secrets SET ciphertext = 'broken' WHERE label = 'github'", [])
  await expect(readGitHubToken(secrets, owner)).rejects.toThrow()
  expect(await deleteGitHubToken(secrets, owner)).toBe(true)
  expect(await secrets.list({ owner_handle: owner })).toEqual([])
})

test('authentication failures cannot delete and a valid other owner cannot target this row', async () => {
  await storeGitHubToken(secrets, owner, 'keep')
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: null })
  expect((await surface.handler(request('DELETE', 'invalid')))!.status).toBe(401)
  expect((await surface.handler(new Request('https://example.test/api/app/github-auth', { method: 'DELETE' })))!.status).toBe(401)
  expect(await (await surface.handler(request('DELETE', 'other')))!.json()).toMatchObject({ removed: false })
  expect(await readGitHubToken(secrets, owner)).toBe('keep')
})

test('storage lookup and deletion failures reject instead of claiming absence', async () => {
  const failure = new Error('storage unavailable')
  await expect(deleteGitHubToken({ list: async () => { throw failure }, delete: async () => {} }, owner)).rejects.toThrow('storage unavailable')
  await storeGitHubToken(secrets, owner, 'keep')
  secrets.delete = async () => { throw failure }
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: null })
  await expect(surface.handler(request('DELETE'))).rejects.toThrow('storage unavailable')
  expect(await readGitHubToken(secrets, owner)).toBe('keep')
})

test('cancelled flow cannot store or clear the replacement flow; the replacement can finish', async () => {
  const releases = [deferred(), deferred()]
  let starts = 0
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', connect: async (input) => {
    const index = starts++
    await input.present({ ...grant, user_code: `CODE-${index}` })
    await releases[index]!.promise
    await storeGitHubToken(input.store, input.owner_handle, `token-${index}`)
    return { connected: true }
  } })
  await surface.handler(request('POST'))
  expect(await (await surface.handler(request('DELETE')))!.json()).toMatchObject({ cancelled: true })
  expect(await (await surface.handler(request('GET')))!.json()).toMatchObject({ status: 'not_connected' })
  await surface.handler(request('POST'))
  releases[0]!.resolve()
  await tick()
  expect(await readGitHubToken(secrets, owner)).toBeNull()
  expect(await (await surface.handler(request('GET')))!.json()).toMatchObject({ user_code: 'CODE-1' })
  releases[1]!.resolve()
  await tick()
  expect(await readGitHubToken(secrets, owner)).toBe('token-1')
})

test('DELETE waits for a store write already running, then removes its row', async () => {
  const writing = deferred()
  const release = deferred()
  const put = secrets.put.bind(secrets)
  secrets.put = async (input) => { writing.resolve(); await release.promise; return put(input) }
  const connect: typeof connectGitHub = async (input) => {
    await input.present(grant)
    await storeGitHubToken(input.store, input.owner_handle, 'late-token')
    return { connected: true }
  }
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', connect })
  await surface.handler(request('POST'))
  await writing.promise
  let done = false
  const deletion = surface.handler(request('DELETE')).then((r) => { done = true; return r })
  await tick()
  expect(done).toBe(false)
  release.resolve()
  expect(await (await deletion)!.json()).toMatchObject({ removed: true })
  expect(await readGitHubToken(secrets, owner)).toBeNull()
})

test('concurrent starts share a single flow even before the code arrives', async () => {
  const release = deferred()
  let starts = 0
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', connect: async ({ present }) => {
    starts++
    await release.promise
    await present(grant)
    await new Promise(() => {})
    return { connected: true }
  } })
  const first = surface.handler(request('POST'))
  const second = surface.handler(request('POST'))
  await tick()
  release.resolve()
  const responses = await Promise.all([first, second])
  for (const response of responses) {
    expect(await response!.json()).toMatchObject({ status: 'awaiting_owner', user_code: grant.user_code })
  }
  expect(starts).toBe(1)
})

test('an expired pending flow cannot later store its token', async () => {
  let now = 0
  const release = deferred()
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', now: () => now, connect: async (input) => {
    await input.present(grant)
    await release.promise
    await storeGitHubToken(input.store, input.owner_handle, 'expired-flow')
    return { connected: true }
  } })
  await surface.handler(request('POST'))
  now = 900_001
  expect(await (await surface.handler(request('GET')))!.json()).toMatchObject({ status: 'not_connected' })
  release.resolve()
  await tick()
  expect(await readGitHubToken(secrets, owner)).toBeNull()
})

test('disconnect cancels a start before the upstream code request returns', async () => {
  const release = deferred()
  const surface = createGitHubConnectSurface({ secrets, auth, client_id: 'client', connect: async (input) => {
    await release.promise
    await input.present(grant)
    await storeGitHubToken(input.store, input.owner_handle, 'cancelled')
    return { connected: true }
  } })
  const start = surface.handler(request('POST'))
  await tick()
  expect(await (await surface.handler(request('DELETE')))!.json()).toMatchObject({ cancelled: true })
  expect((await start)!.status).toBe(409)
  release.resolve()
  await tick()
  expect(await (await surface.handler(request('GET')))!.json()).toMatchObject({ status: 'not_connected' })
  expect(await readGitHubToken(secrets, owner)).toBeNull()
})
