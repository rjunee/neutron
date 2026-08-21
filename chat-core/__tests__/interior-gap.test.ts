/**
 * An INTERIOR hole in the local transcript, and why "where does my history start"
 * was the wrong question.
 *
 * The backwards walk needs a local test for "is anything missing below me", because
 * the server only reports a gap for a page it just sent — so a client that ran out
 * of rounds on one open has nothing but its own store to restart from. That test was
 * `MIN(seq) > 1`, which is a test for a missing PREFIX. A device can hold seq 1 and
 * still be missing a range above it, and for that device the test answered "nothing
 * is missing" while the forward cursor sat past the hole. Nothing on the wire and
 * nothing in the store ever mentioned it again.
 *
 * These are the STORE/ENGINE-level properties. That the same fix converges through
 * the real session over repeated opens is asserted in `history-backfill.test.ts`.
 */
import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import type { ChatMessage, InboundChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function inbound(partial: Partial<InboundChatMessage> & { message_id: string }): InboundChatMessage {
  return {
    role: 'agent',
    seq: null,
    body: 'hi',
    client_msg_id: null,
    project_id: null,
    attachments: null,
    created_at: 0,
    ...partial,
  }
}

/** Apply a contiguous run of acked seqs, as a replay page would. */
const applyRange = async (engine: SyncEngine, from: number, to: number): Promise<void> => {
  for (let seq = from; seq <= to; seq++) {
    await engine.applyInbound(TOPIC, inbound({ message_id: `m${seq}`, seq }))
  }
}

const queuedRow = (client_msg_id: string): ChatMessage => ({
  topic_id: TOPIC,
  client_msg_id,
  message_id: '',
  seq: null,
  role: 'user',
  body: 'typed but undelivered',
  project_id: null,
  attachments: null,
  created_at: 1,
  status: 'queued',
})

describe('SyncEngine.backfillFrom — an interior hole is VISIBLE', () => {
  it('reports the hole floor for a store holding 1..100 AND 201..700', async () => {
    // THE REPRO. A device held 1..100, went away while the topic grew to 700, and
    // resumed onto a capped newest-window page — so it holds 1..100 and 201..700,
    // its oldest seq is 1 and its cursor is 700. The shipped test said nothing was
    // missing, and because a forward cursor never goes back, 101..200 was stranded
    // for good.
    //
    // MUTATION-PROVED: restore `backfillFrom` to read the store's MINIMUM seq and
    // this returns null — which IS the permanent hole, stated as an assertion.
    const engine = new SyncEngine(new InMemoryStore())
    await applyRange(engine, 1, 100)
    await applyRange(engine, 201, 700)

    expect(await engine.cursor(TOPIC)).toBe(700)
    expect(await engine.backfillFrom(TOPIC)).toBe(201)
  })

  it('stays silent on a contiguous store, so a healthy client asks for nothing', async () => {
    // The below-threshold control: this must not put a dead round trip on every
    // ordinary reconnect of a COMPLETE transcript, which is the common case.
    const engine = new SyncEngine(new InMemoryStore())
    await applyRange(engine, 1, 40)
    expect(await engine.backfillFrom(TOPIC)).toBeNull()
  })

  it('still reports a missing PREFIX — the case the old test got right', async () => {
    // Where the two tests agree, they must keep agreeing: a store with no hole and
    // no seq 1 behaves exactly as before.
    const engine = new SyncEngine(new InMemoryStore())
    await applyRange(engine, 500, 700)
    expect(await engine.backfillFrom(TOPIC)).toBe(500)
  })

  it('reports the NEWEST hole first, so repeated walks descend and terminate', async () => {
    // Three runs (1..10, 21..30, 41..50) and therefore two holes. The walk is driven
    // from 41; filling below it exposes the next hole on the following pass, and the
    // sequence of answers strictly descends to null. This is the convergence
    // argument, in the store, with no socket involved.
    const engine = new SyncEngine(new InMemoryStore())
    await applyRange(engine, 1, 10)
    await applyRange(engine, 21, 30)
    await applyRange(engine, 41, 50)

    expect(await engine.backfillFrom(TOPIC)).toBe(41)
    await applyRange(engine, 31, 40) // the page below 41 arrives
    expect(await engine.backfillFrom(TOPIC)).toBe(21)
    await applyRange(engine, 11, 20)
    expect(await engine.backfillFrom(TOPIC)).toBeNull() // contiguous 1..50
  })

  it('ignores un-acked optimistic rows, which carry no server seq', async () => {
    // A queued local send has seq null. Letting one become the backwards cursor
    // would drive the walk from 0 forever.
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await applyRange(engine, 5, 9)
    await store.upsert(queuedRow('pending-1'))

    expect(await engine.backfillFrom(TOPIC)).toBe(5)
  })

  it('is silent for a topic that holds nothing at all', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    expect(await engine.backfillFrom('app:never-opened')).toBeNull()
    expect(await new InMemoryStore().contiguousFloorSeq(TOPIC)).toBe(0)
  })

  it('is silent for a topic holding ONLY un-acked sends', async () => {
    const store = new InMemoryStore()
    await store.upsert(queuedRow('pending-1'))
    await store.upsert(queuedRow('pending-2'))
    expect(await store.contiguousFloorSeq(TOPIC)).toBe(0)
    expect(await new SyncEngine(store).backfillFrom(TOPIC)).toBeNull()
  })
})
