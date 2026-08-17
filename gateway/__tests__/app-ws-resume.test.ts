/**
 * A DELETE MUST REACH A DEVICE THAT WAS OFFLINE WHEN IT HAPPENED.
 *
 * The edit replay used to take the reconnecting client's resume cursor as a LOWER
 * BOUND, which quietly assumed that where an edit sits in the transcript says
 * something about when it happened. It does not. An edit row carries its MESSAGE's
 * seq, so deleting an old message is a NEW event filed at a LOW seq — below the
 * cursor of every device that had already read that message. Those are exactly the
 * devices the delete needed to reach.
 *
 * The consequence was not cosmetic: a device that was offline when the owner deleted
 * a message reconnected, replayed, and went on rendering the deleted content
 * indefinitely — until its local store happened to be wiped. This is the MIRROR of
 * the leak this subsystem was last fixed for (deleted content replaying INTO a
 * capped page), and it is privacy-relevant in the same way. A delete that fails to
 * propagate is a delete that did not happen.
 *
 * These tests run END TO END on purpose — the real gateway app-ws surface over
 * `Bun.serve`, a real SQLite message + edit log, and a real `SyncEngine` applying
 * what comes off the wire into a real Store. The assertion is on the CLIENT'S
 * RENDERED TRANSCRIPT, not on the shape of a query, because "the query returns the
 * row" and "the owner can no longer read the message" are different claims and only
 * the second one is the property.
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
import {
  AppChatEditStore,
  AppChatStore,
  DEFAULT_EDIT_REPLAY_LIMIT,
  ProjectDb,
} from '@neutronai/persistence/index.ts'
import {
  InMemoryStore,
  SyncEngine,
  normalizeEditUpdate,
  normalizeInbound,
} from '@neutronai/chat-core/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'

const CHANNEL_TOPIC = 'app:sam'

interface Harness {
  base: string
  adapter: AppWsAdapter
  close(): Promise<void>
}

let tmp: string
let db: ProjectDb

async function startGateway(): Promise<Harness> {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    chat_log: new AppChatStore({ db }),
    edit_log: new AppChatEditStore({ db }),
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppWsSurface({ adapter, registry, auth, project_slug: 'demo' })
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
    adapter,
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

/**
 * A device that is also a real CLIENT: every frame it receives is applied through
 * `SyncEngine` into its own Store, exactly as the sessions do. `transcript()` is
 * therefore what the owner would actually see on that device.
 */
async function openClient(
  base: string,
  deviceId: string,
  store: InMemoryStore,
): Promise<{
  ws: WebSocket
  events: AppWsOutbound[]
  transcript: () => Promise<Array<{ seq: number | null; body: string; deleted?: boolean | null }>>
  close: () => Promise<void>
}> {
  const engine = new SyncEngine(store)
  const url = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${url}/ws/app/chat?token=sam&device_id=${deviceId}`)
  const events: AppWsOutbound[] = []
  const applied: Array<Promise<unknown>> = []
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
  })
  ws.onmessage = (ev) => {
    const frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    events.push(frame)
    // Apply through the REAL engine, in arrival order, so the store ends up in the
    // state the shipped client would be in.
    const msg = normalizeInbound(frame)
    if (msg !== null) {
      applied.push(engine.applyInbound(CHANNEL_TOPIC, msg))
      return
    }
    const edit = normalizeEditUpdate(frame)
    if (edit !== null) applied.push(engine.applyEditUpdate(CHANNEL_TOPIC, edit))
  }
  await opened
  await waitFor(() => events.some((e) => e.type === 'session_ready'))
  return {
    ws,
    events,
    transcript: async () => {
      await Promise.all(applied)
      return (await store.list(CHANNEL_TOPIC)).map((m) => ({
        seq: m.seq,
        body: m.body,
        deleted: m.deleted ?? null,
      }))
    },
    close: async () => {
      ws.close()
      await new Promise((r) => setTimeout(r, 30))
    },
  }
}

/** Seed straight into SQL — 501 `append` round-trips is a slow way to say "long". */
const seedRows = (count: number): void => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
  )
  for (let i = 1; i <= count; i++) stmt.run(CHANNEL_TOPIC, i, `m${i}`, `msg-${i}`, i)
}

/** Seed edit-log rows for `m<from>`..`m<to>` straight into SQL, same reason.
 *  `deleted` picks tombstone vs body rewrite. */
const seedEditRows = (from: number, to: number, deleted: boolean): void => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_edits
       (topic_id, message_id, seq, rev, body, deleted, edited_at, editor_device_id)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'devX')`,
  )
  for (let i = from; i <= to; i++) {
    stmt.run(CHANNEL_TOPIC, `m${i}`, i, deleted ? '' : `edited-${i}`, deleted ? 1 : 0, 1000 + i)
  }
}

/** A device that already holds seqs 1..`count` of the seeded transcript, so a
 *  resume from its own cursor is the resume of a CAUGHT-UP device rather than a
 *  cold open. Bodies match {@link seedRows} so a tombstone is observable as the
 *  body changing to ''. */
async function storeHolding(count: number): Promise<InMemoryStore> {
  const store = new InMemoryStore()
  for (let i = 1; i <= count; i++) {
    await store.upsert({
      topic_id: CHANNEL_TOPIC,
      client_msg_id: `m${i}`,
      message_id: `m${i}`,
      seq: i,
      role: 'user',
      body: `msg-${i}`,
      project_id: null,
      attachments: null,
      created_at: i,
      status: 'sent',
    })
  }
  return store
}

const gapsIn = (events: AppWsOutbound[]) =>
  events.filter((e): e is Extract<AppWsOutbound, { type: 'history_gap' }> => e.type === 'history_gap')

const editsIn = (events: AppWsOutbound[], messageId: string) =>
  events
    .filter((e): e is Extract<AppWsOutbound, { type: 'edit_update' }> => e.type === 'edit_update')
    .filter((e) => e.message_id === messageId)

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gw-resume-edits-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws resume — a delete below the cursor reaches an offline device', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('strikes a message deleted while the device was offline', async () => {
    // THE REPRO, end to end. devA reads seqs 1..3 and goes offline. The owner then
    // deletes seq 1 from another device. devA reconnects at `after_seq: 3` — above
    // the tombstone — and must still be told.
    //
    // MUTATION-PROVED: drop the `aggregatesAtOrBelow` sweep from
    // `AppWsAdapter.replayEditsAfter` so the edit replay is the page above the cursor
    // only, and the final two assertions fail: no `edit_update` arrives and devA still
    // renders 'delete me'.
    const store = new InMemoryStore()
    const a = await openClient(h.base, 'devA', store)

    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'delete me', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'second', client_msg_id: 'c2' }))
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'third', client_msg_id: 'c3' }))
    await waitFor(
      () => a.events.filter((e) => e.type === 'user_message').length >= 3,
    )
    const first = a.events.find(
      (e): e is Extract<AppWsOutbound, { type: 'user_message' }> => e.type === 'user_message',
    )
    if (first === undefined) throw new Error('expected the first echo')
    const doomedId = first.message_id

    // devA has seen everything: its cursor is the max seq it holds.
    const before = await a.transcript()
    expect(before.map((m) => m.body)).toEqual(['delete me', 'second', 'third'])
    const cursor = Math.max(...before.map((m) => m.seq ?? 0))
    expect(cursor).toBe(3)

    // devA goes OFFLINE, and only then is the message deleted — from another device,
    // so nothing is fanned to devA's dead socket.
    await a.close()
    const b = await openClient(h.base, 'devB', new InMemoryStore())
    b.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: doomedId, action: 'delete' }))
    await waitFor(() => editsIn(b.events, doomedId).some((e) => e.deleted))
    await b.close()

    // devA reconnects with the SAME store and resumes from its own cursor.
    const again = await openClient(h.base, 'devA', store)
    again.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: cursor }))
    await waitFor(() => editsIn(again.events, doomedId).some((e) => e.deleted))

    // The tombstone reached the device...
    const tomb = editsIn(again.events, doomedId).at(-1)
    expect(tomb).toMatchObject({ deleted: true, body: '' })
    // ...and the content is GONE from what the owner would see on it. This is the
    // assertion that matters; the frame above is only how it got here.
    const after = await again.transcript()
    expect(after.map((m) => m.body)).not.toContain('delete me')
    expect(after.find((m) => m.seq === 1)).toMatchObject({ body: '', deleted: true })
    // The messages it was not told about are untouched.
    expect(after.filter((m) => m.deleted !== true).map((m) => m.body)).toEqual([
      'second',
      'third',
    ])

    await again.close()
  })

  it('also strikes it on a BACKWARDS page, where the bound must be kept', async () => {
    // The other half: a backwards resume (`before_seq` set) must still carry the
    // edit state of the page it is fetching. Dropping the lower bound must not be
    // read as dropping both bounds — an old page of messages against the newest page
    // of edit state is the combination that delivers a deleted message with its
    // original body.
    const store = new InMemoryStore()
    const a = await openClient(h.base, 'devA', store)
    for (const [i, body] of ['one', 'two', 'three', 'four'].entries()) {
      a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body, client_msg_id: `c${i}` }))
    }
    await waitFor(() => a.events.filter((e) => e.type === 'user_message').length >= 4)
    const echoes = a.events.filter(
      (e): e is Extract<AppWsOutbound, { type: 'user_message' }> => e.type === 'user_message',
    )
    const oldest = echoes[0]
    if (oldest === undefined) throw new Error('expected echoes')
    await a.close()

    const b = await openClient(h.base, 'devB', new InMemoryStore())
    b.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: oldest.message_id, action: 'delete' }))
    await waitFor(() => editsIn(b.events, oldest.message_id).some((e) => e.deleted))
    await b.close()

    // A fresh device walks BACKWARDS into the range holding the deleted message.
    const c = await openClient(h.base, 'devC', new InMemoryStore())
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0, before_seq: 3 }))
    await waitFor(() => editsIn(c.events, oldest.message_id).some((e) => e.deleted))

    const seen = await c.transcript()
    expect(seen.map((m) => m.body)).not.toContain('one')
    expect(seen.find((m) => m.seq === 1)).toMatchObject({ body: '', deleted: true })

    await c.close()
  })
})

describe('app-ws resume — a page-shaped answer starves the oldest tombstone', () => {
  /**
   * THE SECOND SHAPE OF THE SAME BUG, and the reason the edit replay below the
   * cursor is a complete sweep rather than a better-ordered page.
   *
   * Removing the cursor's LOWER bound fixed the three-message repro above and left the
   * mechanism intact. An edit row carries its MESSAGE's seq, so the replay window is
   * ordered by message position; the window keeps the NEWEST `DEFAULT_EDIT_REPLAY_LIMIT`
   * rows; and a tombstone on an OLD message is the oldest row in that ordering by
   * construction. Give the topic `limit` newer edits and the tombstone is evicted —
   * on that resume, and identically on every resume after it, because nothing about
   * the ordering ever changes. Capped becomes never, and the owner's delete stays
   * undone on a device that is otherwise perfectly caught up.
   *
   * No ordering fixes this, which is the point: the row that must survive is the one
   * that sorts last. So the range the client ALREADY HOLDS is answered completely.
   */
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  const BACKLOG = 700
  const NEWER_EDITS_FROM = 201

  it('CONTROL — a newest-limit page over the same range really does drop seq 1', async () => {
    // The probe has to be able to fail for the reason under test, so measure the
    // starvation directly before asserting it is gone. This is the page-shaped query
    // the replay used to be, run against the fixture, on the real store.
    seedRows(BACKLOG)
    seedEditRows(1, 1, true)
    seedEditRows(NEWER_EDITS_FROM, BACKLOG, false)
    const edits = new AppChatEditStore({ db })
    const rows = await edits.aggregatesAfter(CHANNEL_TOPIC, 0, DEFAULT_EDIT_REPLAY_LIMIT)
    // The budget genuinely binds: 501 rows exist, 500 come back.
    expect(BACKLOG - NEWER_EDITS_FROM + 2).toBeGreaterThan(DEFAULT_EDIT_REPLAY_LIMIT)
    expect(rows.length).toBe(DEFAULT_EDIT_REPLAY_LIMIT)
    // And the one it drops is the tombstone.
    expect(rows.map((r) => r.seq)).not.toContain(1)
    // The sweep the fix adds returns it, from the same store, same fixture.
    const swept = await edits.aggregatesAtOrBelow(CHANNEL_TOPIC, BACKLOG)
    expect(swept.map((r) => r.seq)).toContain(1)
    expect(swept.find((r) => r.seq === 1)).toMatchObject({ deleted: true, body: '' })
  })

  it('strikes the oldest message on a caught-up device with 500 newer edits above it', async () => {
    // MUTATION-PROVED: delete the `aggregatesAtOrBelow` call in
    // `AppWsAdapter.replayEditsAfter` (leaving the page half, which is what shipped)
    // and the last two assertions fail — no tombstone frame arrives for m1 and the
    // device keeps rendering 'msg-1'.
    seedRows(BACKLOG)
    seedEditRows(1, 1, true)
    seedEditRows(NEWER_EDITS_FROM, BACKLOG, false)

    // A device that holds the WHOLE transcript, contiguously — so nothing about
    // history backfill is involved and the only question is edit state.
    const store = await storeHolding(BACKLOG)
    const c = await openClient(h.base, 'devA', store)
    expect(await store.lastSeenSeq(CHANNEL_TOPIC)).toBe(BACKLOG)
    expect(await store.contiguousFloorSeq(CHANNEL_TOPIC)).toBe(1)

    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: BACKLOG }))
    await waitFor(() => editsIn(c.events, 'm1').some((e) => e.deleted), 8000)

    expect(editsIn(c.events, 'm1').at(-1)).toMatchObject({ deleted: true, body: '' })
    const seen = await c.transcript()
    expect(seen.find((m) => m.seq === 1)).toMatchObject({ body: '', deleted: true })
    expect(seen.map((m) => m.body)).not.toContain('msg-1')

    await c.close()
  })

  it('is stable across repeated resumes — the delete does not come back', async () => {
    // The property is "cannot remain readable", which is a claim about every resume,
    // not the lucky one. A device that already applied the tombstone must still hold
    // it after the message replay runs again over the same range.
    seedRows(BACKLOG)
    seedEditRows(1, 1, true)
    seedEditRows(NEWER_EDITS_FROM, BACKLOG, false)

    const store = await storeHolding(BACKLOG)
    const c = await openClient(h.base, 'devA', store)
    for (const _round of [1, 2, 3]) {
      c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: BACKLOG }))
      await new Promise((r) => setTimeout(r, 120))
      const seen = await c.transcript()
      expect(seen.find((m) => m.seq === 1)).toMatchObject({ body: '', deleted: true })
    }
    await c.close()
  })
})

describe('app-ws resume — the truncation signal reaches the wire', () => {
  // The `history_gap` frame is emitted by the SURFACE, and that block was entirely
  // unpinned: `history_gap` appeared nowhere in any gateway test, so the frame could
  // be deleted with the whole suite green. The adapter's `older_than` was pinned and
  // the client's reaction to the frame was pinned; the seam between them — the only
  // place the two meet in production — was not. Deleting it would have made the
  // backwards walk unreachable over a real socket while every existing test agreed
  // the fix was fine.
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('follows a FULL page with history_gap naming the page floor', async () => {
    // MUTATION-PROVED: delete the `if (page.older_than !== null)` block in
    // `gateway/http/app-ws-surface.ts` and this test times out with no gap frame.
    const total = 501 // one row past the 500-message page
    seedRows(total)
    const c = await openClient(h.base, 'devC', new InMemoryStore())
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))

    await waitFor(() => gapsIn(c.events).length > 0)
    // The floor of the page just sent, which is exactly the bound the next request
    // needs — and the client is expected to answer it with `before_seq: 2`.
    expect(gapsIn(c.events)[0]?.older_than).toBe(2)

    // ORDERING IS LOAD-BEARING: the gap must arrive AFTER every frame of the page it
    // describes, or a client that reacts by requesting the next page interleaves two
    // pages' messages.
    const gapIndex = c.events.findIndex((e) => e.type === 'history_gap')
    const lastMessageIndex = c.events.reduce(
      (acc, e, i) => (e.type === 'user_message' ? i : acc),
      -1,
    )
    expect(lastMessageIndex).toBeGreaterThan(-1)
    expect(gapIndex).toBeGreaterThan(lastMessageIndex)

    await c.close()
  })

  it('answers a backwards resume, so the walk is reachable end to end', async () => {
    // The pair the fix consists of: the client's `before_seq` decodes on the server
    // and returns the page BELOW the bound. Under a decoder that dropped
    // `before_seq` this returns the same newest page instead, forever.
    seedRows(501)
    const c = await openClient(h.base, 'devC', new InMemoryStore())
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0, before_seq: 2 }))

    await waitFor(() => c.events.some((e) => e.type === 'user_message'))
    await new Promise((r) => setTimeout(r, 60))
    const seqs = c.events
      .filter((e): e is Extract<AppWsOutbound, { type: 'user_message' }> => e.type === 'user_message')
      .map((e) => e.seq)
    // Strictly below the bound — the row the capped forward page skipped.
    expect(seqs).toEqual([1])
    // A page that did not fill claims no further history.
    expect(gapsIn(c.events)).toEqual([])

    await c.close()
  })

  it('says nothing about truncation when the transcript fits in one page', async () => {
    // The below-threshold control: a short topic's wire trace gains no gap frame, so
    // an ordinary reconnect never starts a pointless backwards walk.
    seedRows(12)
    const c = await openClient(h.base, 'devC', new InMemoryStore())
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))

    await waitFor(() => c.events.filter((e) => e.type === 'user_message').length >= 12)
    await new Promise((r) => setTimeout(r, 60))
    expect(gapsIn(c.events)).toEqual([])

    await c.close()
  })
})
