/**
 * M2 chat-upload UX — production-composer reachability gate.
 *
 * What this test guards (CLAUDE.md anti-pattern: a feature ships with
 * unit coverage but the production composer either never wires the
 * dependency OR wires it the wrong way, so the route 404s in prod):
 * the chat-composer's drag/drop/picker flow funnels every image into
 * `POST /api/app/upload` and rides the canonical handoff on a
 * `POST /api/app/chat/send` user_message envelope with
 * `attachments: [<returned url>]`. If a future refactor unmounts
 * either surface OR swaps which compose-key the upload surface lives
 * under, this test fails BEFORE the regression lands in production.
 *
 * Strategy: compose the same two HTTP surfaces the gateway boots in
 * production (`createAppUploadSurface` + `createAppWsSurface`),
 * upload a tiny real PNG, then POST a user_message envelope with the
 * returned URL on `attachments[]`. Assert (a) the upload returns
 * 200 + a non-empty `url`, (b) the subsequent user_message lands in
 * the AppWs adapter's IncomingEvent stream with the URL on
 * `adapter_metadata.attachments` — that's the field the engine reads
 * for the canonical handoff.
 *
 * Mirrors:
 *   - gateway/__tests__/app-upload-surface.test.ts (single-surface)
 *   - gateway/__tests__/app-ws-surface.test.ts (single-surface)
 *   - gateway/__tests__/comments-production-composer.test.ts (the
 *     "compose-and-hit" guard pattern this file follows)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import type { IncomingEvent } from '@neutronai/channels/types.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { createAppUploadSurface } from '../http/app-upload-surface.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const TINY_PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d49444154789c63000100000005000100' +
  '0d0a2db40000000049454e44ae426082'

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function makeMultipart(bytes: Uint8Array, name: string, type: string): FormData {
  const form = new FormData()
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  form.append('file', new Blob([buf], { type }), name)
  return form
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  owner_home: string
  receivedEvents: IncomingEvent[]
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

async function startHarness(): Promise<Harness> {
  const owner_home = mkdtempSync(join(tmpdir(), 'neutron-m2-chat-upload-prod-'))
  const db = ProjectDb.open(join(owner_home, 'owner.db'))
  applyMigrations(db.raw())
  const receivedEvents: IncomingEvent[] = []
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: {
      receive: async (e) => {
        receivedEvents.push(e)
      },
    },
  })
  // Match the production wiring shape: both surfaces share the same
  // auth resolver + project_slug. The `bypass: true` flag is the
  // composer-test convention (matches every other production-composer
  // test in this directory).
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const wsSurface = createAppWsSurface({ adapter, registry, auth, project_slug: 'demo' })
  const uploadSurface = createAppUploadSurface({ auth, project_slug: 'demo', owner_home })

  // Boot the production graph with both surfaces threaded through —
  // this is the contract `gateway/index.ts:boot` honors. If a future
  // CompositionInput field rename / removal drops `app_ws_surface` /
  // `app_upload_surface` from the typed shape, this construction
  // breaks at compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: 'demo',
    ...noOpInputBase,
    app_ws_surface: {
      handler: wsSurface.handler,
      websocket: wsSurface.websocket,
    },
    app_upload_surface: { handler: uploadSurface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` from `composition.app_ws_surface`
  // + `composition.app_upload_surface`, so the boot-wiring mapping IS
  // the only path exercised here. A deletion of the
  // `composeInput.appWs = …` OR `composeInput.appUpload = …` lines in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks this test (closing condition for ISSUE #32).
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    owner_home,
    receivedEvents,
    graph,
    db,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      db.close()
      try {
        rmSync(owner_home, { recursive: true, force: true })
      } catch {
        /* ignore — test cleanup */
      }
    },
  }
}

describe('M2 chat-upload UX — production composer reachability', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startHarness()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('uploads a chat-attached image and threads the URL into the user_message envelope', async () => {
    // 1. Upload the image through /api/app/upload (same surface the
    //    chat composer's onFilesPicked → upload-modal flow targets).
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'attach.png', 'image/png')
    const uploadRes = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    expect(uploadRes.status).toBe(200)
    const uploadJson = (await uploadRes.json()) as {
      ok: boolean
      url: string
      content_type: string
      size_bytes: number
    }
    expect(uploadJson.ok).toBe(true)
    expect(typeof uploadJson.url).toBe('string')
    expect(uploadJson.url.length).toBeGreaterThan(0)
    expect(uploadJson.url.startsWith('/api/app/upload/')).toBe(true)
    expect(uploadJson.content_type).toBe('image/png')

    // 2. POST a user_message envelope on /api/app/chat/send with the
    //    upload's returned URL on `attachments[]` — the same shape the
    //    Expo client builds in chat-state's send() after the upload
    //    modal reports phase=complete.
    const sendRes = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev:sam',
      },
      body: JSON.stringify({
        body: '',
        attachments: [uploadJson.url],
        client_msg_id: 'cmid-m2-attach-1',
      }),
    })
    expect(sendRes.status).toBe(200)
    const sendJson = (await sendRes.json()) as {
      ok: boolean
      message_id: string
      echo: { attachments?: ReadonlyArray<string> }
    }
    expect(sendJson.ok).toBe(true)
    // The echo carries the attachments back so the optimistic bubble
    // reconciles client-side.
    expect(sendJson.echo.attachments).toEqual([uploadJson.url])

    // 3. The AppWsAdapter forwards the inbound onto the receiver — the
    //    URL must surface on `adapter_metadata.attachments` so the
    //    engine / topic handler sees the canonical handoff.
    expect(harness.receivedEvents.length).toBeGreaterThan(0)
    const last = harness.receivedEvents[harness.receivedEvents.length - 1]
    expect(last?.adapter_metadata?.['attachments']).toEqual([uploadJson.url])
  })

  it('still works when the body is non-empty alongside the attachment', async () => {
    const bytes = fromHex(TINY_PNG_HEX)
    const form = makeMultipart(bytes, 'attach.png', 'image/png')
    const uploadRes = await fetch(`${harness.base}/api/app/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:sam' },
      body: form,
    })
    const uploadJson = (await uploadRes.json()) as { url: string }
    const sendRes = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer dev:sam',
      },
      body: JSON.stringify({
        body: 'look at this',
        attachments: [uploadJson.url],
        client_msg_id: 'cmid-m2-attach-2',
      }),
    })
    expect(sendRes.status).toBe(200)
    const sendJson = (await sendRes.json()) as { ok: boolean; echo: { body: string } }
    expect(sendJson.ok).toBe(true)
    expect(sendJson.echo.body).toBe('look at this')
  })
})
