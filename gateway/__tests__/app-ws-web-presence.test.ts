/**
 * Web presence over the REAL app-ws surface (Bun.serve, real sockets).
 *
 * The unit tests either side of this one prove the tracker expires and the
 * decoder refuses garbage. What only a real socket can prove is the part that
 * decides whether the owner's phone stays quiet:
 *
 *   * the `platform` gate — a NATIVE client's foreground must NOT register as
 *     web presence. Getting this wrong is the whole feature inverted: a phone
 *     that is merely holding its socket open would suppress its own
 *     notifications, which is exactly the inference the notify comment in
 *     `gateway/http/deliver.ts` refuses to make;
 *   * the CLOSE hook — a closed tab must stop counting immediately rather than
 *     waiting out the TTL;
 *   * that presence is a CONTROL frame — it must not draw a `malformed_envelope`
 *     error, must not reach the receiver, and must not run an agent turn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
  type AppWsOutbound,
} from '@neutronai/channels/index.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import { createWebPresenceTracker, type WebPresenceTracker } from '../push/web-presence.ts'

const OWNER = 'sam'

interface Harness {
  base: string
  presence: WebPresenceTracker
  received: string[]
  close(): Promise<void>
}

let tmp: string
let db: ProjectDb

async function startGateway(): Promise<Harness> {
  const registry = new InMemoryAppWsSessionRegistry()
  const received: string[] = []
  const adapter = new AppWsAdapter({
    registry,
    receiver: {
      receive: async (event) => {
        received.push(event.body.text)
      },
    },
    chat_log: new AppChatStore({ db }),
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const presence = createWebPresenceTracker()
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    web_presence: presence,
  })
  const composed = composeHttpHandler({
    appWs: { handler: surface.handler, websocket: surface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    presence,
    received,
    close: async () => {
      await server.stop(true)
    },
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function openClient(
  base: string,
  platform: 'web' | 'native' | null,
  device_id?: string,
): Promise<{ ws: WebSocket; events: AppWsOutbound[]; close: () => Promise<void> }> {
  const suffix =
    (platform === null ? '' : `&platform=${platform}`) +
    (device_id === undefined ? '' : `&device_id=${device_id}`)
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/app/chat?token=${OWNER}${suffix}`)
  const events: AppWsOutbound[] = []
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('ws error'))
  })
  ws.onmessage = (ev): void => {
    events.push(JSON.parse(String(ev.data)) as AppWsOutbound)
  }
  return {
    ws,
    events,
    close: async () => {
      const closed = new Promise<void>((resolve) => {
        ws.onclose = () => resolve()
      })
      ws.close()
      await closed
    },
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ne-web-presence-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws surface — web presence', () => {
  it('records a WEB client that declares itself foregrounded', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, 'web')
    expect(h.presence.isForeground(OWNER)).toBe(false) // control: nothing declared yet

    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.isForeground(OWNER))
    expect(h.presence.isForeground(OWNER)).toBe(true)

    await client.close()
    await h.close()
  })

  it('IGNORES a NATIVE client declaring itself foregrounded', async () => {
    const h = await startGateway()
    const native = await openClient(h.base, 'native')
    native.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))

    // A control on the same harness, so "nothing recorded" cannot be an artefact
    // of the frame never arriving: an identical frame from a WEB socket DOES
    // register. Only then is the native socket's silence meaningful.
    const web = await openClient(h.base, 'web')
    web.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.size() > 0)

    expect(h.presence.size()).toBe(1)
    await web.close()
    await waitFor(() => h.presence.size() === 0)
    // With the web socket gone, the native declaration left nothing behind.
    expect(h.presence.isForeground(OWNER)).toBe(false)

    await native.close()
    await h.close()
  })

  it('a client with NO declared platform is not treated as web', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, null)
    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    // Same control as above: prove the socket is live and the server is reading
    // its frames by driving a `ping` and waiting for the `pong`.
    client.ws.send(JSON.stringify({ v: 1, type: 'ping' }))
    await waitFor(() => client.events.some((e) => (e as { type?: string }).type === 'pong'))
    expect(h.presence.isForeground(OWNER)).toBe(false)

    await client.close()
    await h.close()
  })

  it('a background declaration clears it', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, 'web')
    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.isForeground(OWNER))

    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'background' }))
    await waitFor(() => !h.presence.isForeground(OWNER))
    expect(h.presence.isForeground(OWNER)).toBe(false)

    await client.close()
    await h.close()
  })

  it('closing the tab clears it immediately, without waiting out the TTL', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, 'web')
    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.isForeground(OWNER))

    await client.close()
    await waitFor(() => !h.presence.isForeground(OWNER))
    expect(h.presence.size()).toBe(0)

    await h.close()
  })

  it('two tabs are two connections — closing one leaves the other present', async () => {
    const h = await startGateway()
    const a = await openClient(h.base, 'web')
    const b = await openClient(h.base, 'web')
    a.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    b.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.size() === 2)

    await a.close()
    await waitFor(() => h.presence.size() === 1)
    expect(h.presence.isForeground(OWNER)).toBe(true)

    await b.close()
    await waitFor(() => h.presence.size() === 0)
    await h.close()
  })

  it('two tabs SHARING a client-supplied device id are still two screens', async () => {
    // The reason presence is keyed on a per-socket `conn_id` rather than on
    // `device_id`. The upgrade accepts a client-supplied `device_id` and treats it
    // as stable across reconnects, so two clients can legitimately present the
    // same one — and if that were the presence key, the first tab to close would
    // evict the second tab's record and the owner's phone would start buzzing at
    // him while he reads. Same value on both sockets here, on purpose.
    const h = await startGateway()
    const a = await openClient(h.base, 'web', 'shared-device')
    const b = await openClient(h.base, 'web', 'shared-device')
    a.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    b.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    await waitFor(() => h.presence.size() === 2)
    expect(h.presence.size()).toBe(2)

    await a.close()
    await waitFor(() => h.presence.size() === 1)
    expect(h.presence.isForeground(OWNER)).toBe(true)

    await b.close()
    await waitFor(() => h.presence.size() === 0)
    await h.close()
  })

  it('is a CONTROL frame: no error reply, no receiver dispatch, no agent turn', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, 'web')
    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'foreground' }))
    client.ws.send(JSON.stringify({ v: 1, type: 'ping' }))
    // The pong proves the server processed everything queued ahead of it, so an
    // absent error below is a real absence rather than a race.
    await waitFor(() => client.events.some((e) => (e as { type?: string }).type === 'pong'))

    expect(client.events.filter((e) => (e as { type?: string }).type === 'error')).toEqual([])
    expect(h.received).toEqual([])

    await client.close()
    await h.close()
  })

  it('a MALFORMED presence frame is still rejected loudly', async () => {
    const h = await startGateway()
    const client = await openClient(h.base, 'web')
    // `state: 'visible'` is the plausible typo. It must NOT be read as present,
    // and it must not be swallowed either.
    client.ws.send(JSON.stringify({ v: 1, type: 'presence', state: 'visible' }))
    await waitFor(() => client.events.some((e) => (e as { type?: string }).type === 'error'))
    expect(h.presence.isForeground(OWNER)).toBe(false)

    await client.close()
    await h.close()
  })
})
