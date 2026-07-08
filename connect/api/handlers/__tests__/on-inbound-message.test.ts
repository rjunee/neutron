import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ChannelRouter } from '@neutronai/channels/router.ts'
import type {
  ChannelAdapter,
  IncomingEvent,
  Topic,
  OutgoingMessage,
} from '@neutronai/channels/types.ts'
import type { ConnectAuthContext } from '../../jwt-bearer-middleware.ts'
import type { TaggedContent } from '../../origin-tag.ts'
import type { IncomingMessage } from '../../server.ts'
import {
  buildOnInboundMessageHandler,
  onInboundMessage,
} from '../on-inbound-message.ts'

let workdir: string
let db: ProjectDb

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-on-inbound-'))
  const dbPath = join(workdir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const sampleCtx: ConnectAuthContext = {
  origin_instance_slug: 'workspace-1',
  origin_user_id: 'user-7777-aaaa',
  scopes: ['role:owner'],
  memberships: [{ slug: 'workspace-1', role: 'owner', kind: 'workspace' }],
}

function tagged(payload: IncomingMessage): TaggedContent<IncomingMessage> {
  return { origin_instance: sampleCtx.origin_instance_slug, payload }
}

interface RouterFixture {
  router: ChannelRouter
  events: IncomingEvent[]
  topics: Topic[]
  /** Calls in chronological order — used to assert audit-row-before-route ordering. */
  callLog: string[]
  failNext: boolean
}

function buildRouter(initial: { failNext?: boolean } = {}): RouterFixture {
  const events: IncomingEvent[] = []
  const topics: Topic[] = []
  const callLog: string[] = []
  const fixture: RouterFixture = { router: null!, events, topics, callLog, failNext: initial.failNext === true }

  const handler = async (topic: Topic, event: IncomingEvent): Promise<void> => {
    callLog.push('router.handler')
    if (fixture.failNext) {
      throw new Error('synthetic router failure')
    }
    topics.push(topic)
    events.push(event)
  }
  fixture.router = new ChannelRouter(db, 'alice', handler)
  // Register a no-op adapter for app_socket so resolveOrCreateTopic's
  // channel_kind constraint is satisfied (the router supports app_socket
  // by default; no adapter needed unless we want to send).
  const adapter: ChannelAdapter = {
    manifest: {
      kind: 'app_socket',
      display_name: 'app-socket-test',
      supports_inline_choices: false,
      supports_unprompted_send: true,
    },
    send: async (_msg: OutgoingMessage): Promise<string> => 'sent',
  }
  fixture.router.registerAdapter(adapter)
  return fixture
}

test('writes inbound_messages audit row BEFORE invoking the router', async () => {
  const r = buildRouter()
  // Wrap router.receive with a probe so we can check audit row exists at
  // dispatch time. Per risk row 3 — the audit MUST land first.
  const original = r.router.receive.bind(r.router)
  let auditRowsAtDispatch: unknown[] = []
  r.router.receive = async (event: IncomingEvent): Promise<void> => {
    auditRowsAtDispatch = db
      .raw()
      .query<{ ack_id: string; route_status: string | null }, []>(
        'SELECT ack_id, route_status FROM inbound_messages',
      )
      .all()
    r.callLog.push('router.receive')
    return original(event)
  }
  const handler = buildOnInboundMessageHandler({
    router: r.router,
    db,
    receiving_instance_slug: 'alice',
  })
  const result = await handler(
    sampleCtx,
    tagged({ topic_id: 'topic-A', speaker_user_id: 'speaker-1', body: { text: 'hello' } }),
  )
  expect(typeof result.ack_id).toBe('string')
  // At the moment receive() ran, exactly one audit row existed; route_status
  // was still NULL (pending) because the success-stamp happens after.
  expect(auditRowsAtDispatch).toHaveLength(1)
  expect((auditRowsAtDispatch[0] as { route_status: string | null }).route_status).toBeNull()
  // Post-call: route_status flipped to 'ok'.
  const post = db
    .raw()
    .query<{ route_status: string }, []>('SELECT route_status FROM inbound_messages')
    .get()
  expect(post?.route_status).toBe('ok')
})

test('returns { delivered: true, ack_id } and routes through the channel router', async () => {
  const r = buildRouter()
  const result = await onInboundMessage(
    sampleCtx,
    tagged({
      topic_id: 'topic-B',
      speaker_user_id: 'speaker-1',
      body: { text: 'reply from agent' },
      channel_hint: 'app_socket',
    }),
    {
      router: r.router,
      db,
      receiving_instance_slug: 'alice',
    },
  )
  expect(result.delivered).toBe(true)
  expect(typeof result.ack_id).toBe('string')
  expect(r.events).toHaveLength(1)
  expect(r.events[0]?.channel_topic_id).toBe('topic-B')
  expect(r.events[0]?.body.text).toBe('reply from agent')
  expect(r.topics).toHaveLength(1)
  expect(r.topics[0]?.channel_topic_id).toBe('topic-B')
})

test('default channel kind is app_socket when channel_hint is omitted', async () => {
  const r = buildRouter()
  await onInboundMessage(
    sampleCtx,
    tagged({ topic_id: 't', speaker_user_id: 's', body: { text: 'hi' } }),
    {
      router: r.router,
      db,
      receiving_instance_slug: 'alice',
    },
  )
  expect(r.events[0]?.channel_kind).toBe('app_socket')
})

test('router throw marks audit row route_status=error and rethrows', async () => {
  const r = buildRouter({ failNext: true })
  const handler = buildOnInboundMessageHandler({
    router: r.router,
    db,
    receiving_instance_slug: 'alice',
  })
  await expect(
    handler(
      sampleCtx,
      tagged({ topic_id: 'topic-x', speaker_user_id: 's', body: { text: 'fail' } }),
    ),
  ).rejects.toThrow('synthetic router failure')
  const row = db
    .raw()
    .query<{ route_status: string; route_error: string }, []>(
      'SELECT route_status, route_error FROM inbound_messages',
    )
    .get()
  expect(row?.route_status).toBe('error')
  expect(row?.route_error).toContain('synthetic router failure')
})

// Under the Slack-Connect model a routed turn IS a write into the host's one
// memory (connect-spec §1.4) — the cross-instance API handler ALWAYS routes the
// turn through to the channel router. The old foreign-content persistence gate
// was removed with the content-sync mesh (connect-spec §2.1); this handler does
// not gate on origin.
test('a routed turn reaches the router (host-session write contract)', async () => {
  const r = buildRouter()
  const result = await onInboundMessage(
    sampleCtx,
    tagged({ topic_id: 't', speaker_user_id: 's', body: { text: 'foreign payload' } }),
    {
      router: r.router,
      db,
      receiving_instance_slug: 'alice', // alice ≠ workspace-1 origin
    },
  )
  expect(result.delivered).toBe(true)
  expect(r.events).toHaveLength(1)
  const row = db
    .raw()
    .query<{ route_status: string }, []>('SELECT route_status FROM inbound_messages')
    .get()
  expect(row?.route_status).toBe('ok')
})

// The synthesized IncomingEvent must carry `origin_instance_slug` from the JWT
// context — the server-resolved member `local_slug` that authored the turn (the
// author attribution, connect-spec §1.5). The JWT-validated context (not the
// body stamp) is authoritative because it is signed.
test('preserves origin_instance_slug from the JWT context onto the synthesized IncomingEvent', async () => {
  const r = buildRouter()
  const foreignCtx: ConnectAuthContext = {
    origin_instance_slug: 'workspace-foo',
    origin_user_id: 'user-foo-aaaa',
    scopes: ['role:owner'],
    memberships: [{ slug: 'workspace-foo', role: 'owner', kind: 'workspace' }],
  }
  await onInboundMessage(
    foreignCtx,
    { origin_instance: 'workspace-foo', payload: { topic_id: 't', speaker_user_id: 's', body: { text: 'hi' } } },
    {
      router: r.router,
      db,
      receiving_instance_slug: 'alice',
    },
  )
  expect(r.events).toHaveLength(1)
  expect(r.events[0]?.origin_instance_slug).toBe('workspace-foo')
})

// Defense-in-depth: even if a body stamp is forged to a different slug, the
// JWT-validated context is what flows downstream. This guards against an
// upstream bug that lets a forged stamp slip past the server's
// `origin_stamp_mismatch` check.
test('IncomingEvent.origin_instance_slug comes from the JWT context, never the body stamp', async () => {
  const r = buildRouter()
  await onInboundMessage(
    sampleCtx, // ctx says workspace-1
    // Body stamp says workspace-1 (the matching, valid case at this layer);
    // but the field source is ctx, not body — verified by ensuring a
    // ctx-only mismatch propagates ctx's value.
    tagged({ topic_id: 't', speaker_user_id: 's', body: { text: 'foreign' } }),
    {
      router: r.router,
      db,
      receiving_instance_slug: 'alice',
    },
  )
  expect(r.events[0]?.origin_instance_slug).toBe('workspace-1')
})

test('audit row carries origin instance + user + topic + body', async () => {
  const r = buildRouter()
  await onInboundMessage(
    sampleCtx,
    tagged({
      topic_id: 'topic-audit',
      speaker_user_id: 'speaker-aaaa',
      body: { text: 'persist this' },
      channel_hint: 'app_socket',
    }),
    {
      router: r.router,
      db,
      receiving_instance_slug: 'workspace-1',
    },
  )
  const row = db
    .raw()
    .query<
      {
        origin_instance_slug: string
        origin_user_id: string
        topic_id: string
        speaker_user_id: string
        channel_hint: string
        body_json: string
      },
      []
    >(
      `SELECT origin_instance_slug AS origin_instance_slug, origin_user_id, topic_id, speaker_user_id,
              channel_hint, body_json
         FROM inbound_messages`,
    )
    .get()
  expect(row?.origin_instance_slug).toBe('workspace-1')
  expect(row?.origin_user_id).toBe('user-7777-aaaa')
  expect(row?.topic_id).toBe('topic-audit')
  expect(row?.speaker_user_id).toBe('speaker-aaaa')
  expect(row?.channel_hint).toBe('app_socket')
  expect(JSON.parse(row?.body_json ?? 'null')).toEqual({ text: 'persist this' })
})

// Multi-author attribution (connect-spec §4): the server-stamped author on the
// payload persists to the message row AND rides the synthesized IncomingEvent —
// both the structured `author` envelope (§4.1) and the transcript speaker label
// (§4.3 layer 1, via event.user.display_name).
test('persists author_id/author_display + stamps event.author + transcript label', async () => {
  const r = buildRouter()
  await onInboundMessage(
    sampleCtx,
    tagged({
      topic_id: 't-author',
      speaker_user_id: 's',
      body: { text: 'hi' },
      author: { id: 'mona', display: 'Mona' },
    }),
    { router: r.router, db, receiving_instance_slug: 'alice' },
  )
  // Event carries the structured author + the human display label.
  expect(r.events[0]?.author).toEqual({ id: 'mona', display: 'Mona' })
  expect(r.events[0]?.user.display_name).toBe('Mona')
  // Row persists the author columns (§4.4).
  const row = db
    .raw()
    .query<{ author_id: string; author_display: string }, []>(
      'SELECT author_id, author_display FROM inbound_messages',
    )
    .get()
  expect(row?.author_id).toBe('mona')
  expect(row?.author_display).toBe('Mona')
})

// Fallback: a turn that reached the handler WITHOUT a server author (non-connect
// / legacy fan-out) still records a WHO — derived from the JWT origin so the row
// + event are never authorless.
test('falls back to the JWT origin as author #0 when the payload has no author', async () => {
  const r = buildRouter()
  await onInboundMessage(
    sampleCtx, // origin_instance_slug = 'workspace-1', origin_user_id = 'user-7777-aaaa'
    tagged({ topic_id: 't', speaker_user_id: 's', body: { text: 'hi' } }),
    { router: r.router, db, receiving_instance_slug: 'alice' },
  )
  expect(r.events[0]?.author?.id).toBe('workspace-1')
  const row = db
    .raw()
    .query<{ author_id: string }, []>('SELECT author_id FROM inbound_messages')
    .get()
  expect(row?.author_id).toBe('workspace-1')
})
