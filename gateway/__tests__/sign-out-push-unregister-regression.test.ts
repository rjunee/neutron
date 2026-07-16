/**
 * P5.6 — sign-out push unregister regression test.
 *
 * Round-2 Argus finding (BLOCKING): the Expo client's sign-out handler
 * historically cleared local auth state without revoking the
 * device-instance push binding. The device row in `device_push_tokens`
 * survived logout, so reminder pushes for the OLD instance/user kept
 * delivering until next login rebound the row. Real privacy / correctness
 * leak on a shared device or instance switch.
 *
 * The client fix wires `disablePushForUser({ base_url, token })` into
 * `handleSignOut` at `app/app/projects/index.tsx` BEFORE clearing auth.
 * This integration test pins down the contract the client now relies on:
 *
 *   1. POST /api/app/devices/register   → row persists in the store
 *   2. POST /api/app/devices/unregister → row is removed
 *   3. PushDispatcher.pushReminder      → attempted=0, no client call
 *
 * If any future change re-introduces a path where the device row outlives
 * sign-out, the dispatcher assertion fails the build.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { DevicePushTokenStore } from '../push/store.ts'
import {
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushSendResult,
  type ExpoPushTicket,
} from '../push/expo-push-client.ts'
import { createPushDispatcher } from '../push/dispatcher.ts'
import type { Reminder } from '@neutronai/reminders/store.ts'
import { createAppDevicesSurface } from '../http/app-devices-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  store: DevicePushTokenStore
  db: ProjectDb
  tmp: string
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-signout-push-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new DevicePushTokenStore(db)
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppDevicesSurface({ store, auth })
  const composed = composeHttpHandler({
    appDevices: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    store,
    db,
    tmp,
    close: async () => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit,
  bearerToken: string,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', `Bearer ${bearerToken}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

interface FakeClient extends ExpoPushClient {
  calls: ExpoPushMessage[][]
}

function fakeClient(tickets: ExpoPushTicket[]): FakeClient {
  const calls: ExpoPushMessage[][] = []
  return {
    calls,
    async send(messages) {
      calls.push(messages)
      const result: ExpoPushSendResult = {
        tickets,
        ok: tickets.every((t) => t.status === 'ok'),
      }
      return result
    },
  }
}

function makeReminder(): Reminder {
  return {
    id: 'r-after-signout',
    owner_slug: 'demo',
    topic_id: 'app-project:demo',
    fire_at: 1700000000,
    message: 'walk the dog',
    status: 'fired',
    recurrence: null,
    recurrence_spec: null,
    source: null,
    created_at: 1699999000,
    fired_at: 1700000005,
    cancelled_at: null,
  }
}

describe('sign-out flow — device push token regression (P5.6 round 2)', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('register → unregister leaves zero tokens for the project; pushReminder no-ops', async () => {
    // Step 1 — Expo client login flow: POST register.
    const regRes = await authedFetch(
      harness.base,
      '/api/app/devices/register',
      {
        method: 'POST',
        body: JSON.stringify({
          device_token: 'ExponentPushToken[signout-regression]',
          platform: 'ios',
        }),
      },
      'dev:sam',
    )
    expect(regRes.status).toBe(200)
    expect(harness.store.listByOwner('demo').length).toBe(1)

    // Step 2 — Expo client sign-out flow: POST unregister using the
    // SAME bearer token (the unregister has to happen while the token
    // is still valid, which the projects/index.tsx handler now does
    // BEFORE clearing local auth state).
    const unregRes = await authedFetch(
      harness.base,
      '/api/app/devices/unregister',
      {
        method: 'POST',
        body: JSON.stringify({
          device_token: 'ExponentPushToken[signout-regression]',
        }),
      },
      'dev:sam',
    )
    expect(unregRes.status).toBe(200)
    const unregJson = (await unregRes.json()) as { ok: boolean }
    expect(unregJson.ok).toBe(true)

    // Row gone — the privacy leak that prompted this regression is
    // closed: a stale row no longer survives sign-out.
    expect(harness.store.listByOwner('demo').length).toBe(0)
    expect(
      harness.store.getByDeviceToken('demo', 'ExponentPushToken[signout-regression]'),
    ).toBeNull()

    // Step 3 — Reminder dispatch for this instance must yield zero
    // attempts. If a future change re-introduces a path where the row
    // outlives sign-out, this assertion fails.
    const client = fakeClient([])
    const dispatcher = createPushDispatcher({ store: harness.store, client })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.attempted).toBe(0)
    expect(result.delivered).toBe(0)
    expect(result.errored).toBe(0)
    expect(result.ok).toBe(true)
    expect(client.calls.length).toBe(0)
  })

  it('after sign-out, a different user signing in on the same device gets clean state', async () => {
    // Sam signs in, registers, then signs out (= unregister).
    await authedFetch(
      harness.base,
      '/api/app/devices/register',
      {
        method: 'POST',
        body: JSON.stringify({ device_token: 'shared-device-tok', platform: 'ios' }),
      },
      'dev:sam',
    )
    await authedFetch(
      harness.base,
      '/api/app/devices/unregister',
      {
        method: 'POST',
        body: JSON.stringify({ device_token: 'shared-device-tok' }),
      },
      'dev:sam',
    )
    expect(harness.store.listByOwner('demo').length).toBe(0)

    // Alice signs in on the same device — a fresh register binds the
    // token to her user_id, not to Sam's stale row.
    const aliceReg = await authedFetch(
      harness.base,
      '/api/app/devices/register',
      {
        method: 'POST',
        body: JSON.stringify({ device_token: 'shared-device-tok', platform: 'ios' }),
      },
      'dev:alice',
    )
    expect(aliceReg.status).toBe(200)
    const rows = harness.store.listByOwner('demo')
    expect(rows.length).toBe(1)
    expect(rows[0]?.user_id).toBe('alice')
  })
})
