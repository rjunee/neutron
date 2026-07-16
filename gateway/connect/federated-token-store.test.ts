import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import {
  FederatedConnectError,
  FederatedTokenStore,
  type FetchLike,
} from './federated-token-store.ts'

const NOW = 1_700_000_000_000
const NOW_SEC = Math.floor(NOW / 1000)
const HANDLE = asOwnerHandle('tnt_handle_1')

let dir: string
let db: ProjectDb
let secrets: SecretsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-fts-'))
  db = ProjectDb.open(join(dir, 'owner.db'))
  applyMigrations(db.raw())
  secrets = new SecretsStore({ data_dir: dir, db, now: () => NOW })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function redeemBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: 'u-alice',
    refresh_token: 'rid.rsecret',
    refresh_expires_at: NOW_SEC + 86_400,
    connect_token: 'jwt-initial',
    connect_expires_at: NOW_SEC + 3_600,
    user_instance_slug: 'alice',
    ...over,
  }
}

function fetchReturning(map: Record<string, () => Response>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetch: FetchLike = async (input) => {
    calls.push(input)
    for (const [needle, make] of Object.entries(map)) {
      if (input.includes(needle)) return make()
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('FederatedTokenStore', () => {
  test('connectViaRedeem persists the credential → status connected', async () => {
    const { fetch } = fetchReturning({ '/redeem': () => jsonResponse(redeemBody()) })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => NOW,
    })
    const status = await store.connectViaRedeem('code.value')
    expect(status.connected).toBe(true)
    expect(status.user_instance_slug).toBe('alice')
    expect((await store.status()).connected).toBe(true)
  })

  test('connectViaRedeem throws FederatedConnectError on non-2xx', async () => {
    const { fetch } = fetchReturning({ '/redeem': () => jsonResponse({ error: 'x' }, 400) })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => NOW,
    })
    await expect(store.connectViaRedeem('bad')).rejects.toBeInstanceOf(FederatedConnectError)
  })

  test('returns the cached JWT without refreshing when not near expiry', async () => {
    const { fetch, calls } = fetchReturning({ '/redeem': () => jsonResponse(redeemBody()) })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => NOW,
    })
    await store.connectViaRedeem('code')
    const before = calls.length
    const token = await store.getValidFederatedToken()
    expect(token).toBe('jwt-initial')
    expect(calls.length).toBe(before) // no /token exchange
  })

  test('exchanges the refresh token when the cached JWT is near expiry', async () => {
    const { fetch, calls } = fetchReturning({
      '/redeem': () => jsonResponse(redeemBody()),
      '/token': () =>
        jsonResponse({
          connect_token: 'jwt-refreshed',
          expires_at: NOW_SEC + 7_200,
          user_instance_slug: 'alice',
        }),
    })
    // Clock at 50s before expiry (< 120s margin) → must refresh.
    let nowMs = NOW
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => nowMs,
    })
    await store.connectViaRedeem('code')
    nowMs = (NOW_SEC + 3_600 - 50) * 1_000
    const token = await store.getValidFederatedToken()
    expect(token).toBe('jwt-refreshed')
    expect(calls.some((c) => c.includes('/token'))).toBe(true)
  })

  test('a 401 on exchange clears the credential', async () => {
    let nowMs = NOW
    const { fetch } = fetchReturning({
      '/redeem': () => jsonResponse(redeemBody()),
      '/token': () => jsonResponse({ error: 'refresh_invalid' }, 401),
    })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => nowMs,
    })
    await store.connectViaRedeem('code')
    nowMs = (NOW_SEC + 3_600 - 50) * 1_000
    expect(await store.getValidFederatedToken()).toBeNull()
    expect((await store.status()).connected).toBe(false)
  })

  test('returns null (but stays connected) when the user has no workspace yet', async () => {
    let nowMs = NOW
    const { fetch } = fetchReturning({
      '/redeem': () => jsonResponse(redeemBody({ connect_token: null, connect_expires_at: null })),
      '/token': () => jsonResponse({ connect_token: null, expires_at: null }),
    })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => nowMs,
    })
    await store.connectViaRedeem('code')
    nowMs = NOW + 1_000
    expect(await store.getValidFederatedToken()).toBeNull()
    expect((await store.status()).connected).toBe(true)
  })

  test('disconnect drops the credential', async () => {
    const { fetch } = fetchReturning({ '/redeem': () => jsonResponse(redeemBody()) })
    const store = new FederatedTokenStore({
      secrets,
      owner_handle: HANDLE,
      auth_base_url: 'https://auth.neutron.example',
      fetch,
      now: () => NOW,
    })
    await store.connectViaRedeem('code')
    await store.disconnect()
    expect((await store.status()).connected).toBe(false)
    expect(await store.getValidFederatedToken()).toBeNull()
  })
})
