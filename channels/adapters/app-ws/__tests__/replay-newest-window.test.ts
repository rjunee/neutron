/**
 * The resume-path regression that shipped to the owner: a long chat rendered its
 * OLDEST messages and stopped ~630 short of the present.
 *
 * The adapter answers one `resume` with ONE bounded query, and the cursor the client
 * sends is its MAX applied seq — which that query advances. So which END of the
 * backlog the query takes is the whole behaviour: on a 1130-message topic
 * `ORDER BY seq ASC LIMIT 500` delivered seq 1..500, and the remaining 630 arrived
 * only across further app restarts, one screenful at a time. The window is now the
 * NEWEST `DEFAULT_REPLAY_LIMIT` rows, re-sorted ascending.
 *
 * AN EARLIER VERSION OF THIS HEADER SAID `resume` FIRES "exactly ONCE per socket
 * open (`SyncEngine`'s per-open guard)". Both halves were wrong: `SyncEngine` holds
 * no such guard (the only one is `resumedThisOpen` in `chat-core/web-session.ts`),
 * and `MobileChatSession.catchUp` re-resumes on an already-open socket every time
 * the app foregrounds or a push lands (`app/lib/chat-core/use-mobile-chat.ts`). The
 * error mattered: repeated forward resumes off an ASCENDING window eventually
 * covered a long transcript, so the newest window is the first shape that could
 * strand a middle range for good — which is why it now reports a full page as
 * `older_than` and takes a `before_seq` to fetch the range below it.
 *
 * These tests are at the ADAPTER level on purpose — three of the properties that
 * matter are not visible in the store: that a resume costs exactly ONE query (no
 * unbounded drain), that the message window and the edit window cover the same
 * messages (so a capped replay cannot deliver a deleted message without its
 * tombstone), and that repeating the request converges on the whole transcript.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../../tests/support/migrated-db.ts'
import type { AppChatMessageLog } from '@neutronai/persistence/index.ts'
import {
  AppChatEditStore,
  AppChatStore,
  DEFAULT_EDIT_REPLAY_LIMIT,
  DEFAULT_REPLAY_LIMIT,
  ProjectDb,
} from '@neutronai/persistence/index.ts'
import { AppWsAdapter } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type { AppWsOutbound } from '../envelope.ts'

const CHANNEL_TOPIC = 'app:sam'
/** The live report's exact shape: 1130 messages, ~630 of them missing. */
const BACKLOG = DEFAULT_REPLAY_LIMIT + 630
/** The oldest seq the newest-window replay of a `BACKLOG`-row topic reaches. */
const WINDOW_START = BACKLOG - DEFAULT_REPLAY_LIMIT + 1

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-replay-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const adapterOn = (chat_log?: AppChatMessageLog, withEditLog = false) =>
  new AppWsAdapter({
    registry: new InMemoryAppWsSessionRegistry(),
    receiver: { receive: async () => {} },
    now: () => 1000,
    generate_message_id: () => 'msg-x',
    ...(chat_log === undefined ? {} : { chat_log }),
    ...(withEditLog ? { edit_log: new AppChatEditStore({ db }) } : {}),
  })

/** Seed straight into SQL — 1130 `append` round-trips is a slow way to say "long". */
const seedRows = (count: number): void => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
  )
  for (let i = 1; i <= count; i++) stmt.run(CHANNEL_TOPIC, i, `m${i}`, `msg-${i}`, i)
}

/** Tombstone a seq range straight into the edit overlay — same rows
 *  `AppChatEditStore.record` writes for a delete, without 501 authorized
 *  round-trips. The message log stays immutable (migration 0087: an edit is an
 *  OVERLAY), so the delivered message still carries its original body and the
 *  client depends on the `edit_update` to strike it. */
const tombstone = (fromSeq: number, toSeq: number): Set<string> => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_edits (topic_id, message_id, seq, rev, body, deleted, edited_at)
       VALUES (?, ?, ?, 1, '', 1, ?)`,
  )
  const ids = new Set<string>()
  for (let i = fromSeq; i <= toSeq; i++) {
    stmt.run(CHANNEL_TOPIC, `m${i}`, i, i)
    ids.add(`m${i}`)
  }
  return ids
}

/** The real store, with every `replayAfter` call announced — so a test can prove a
 *  resume costs exactly one query rather than draining the transcript. */
const countingLog = (
  store: AppChatMessageLog,
  onCall: (topic_id: string, after_seq: number) => void,
): AppChatMessageLog => ({
  append: (input) => store.append(input),
  maxSeq: (topic_id) => store.maxSeq(topic_id),
  markPromptChosen: (input) => store.markPromptChosen(input),
  replayAfter: (topic_id, after_seq, limit) => {
    onCall(topic_id, after_seq)
    return store.replayAfter(topic_id, after_seq, limit)
  },
})

/** The real store read with no practical row cap — the control the below-threshold
 *  test compares against, so "unchanged" is measured rather than restated. */
const unboundedLog = (store: AppChatMessageLog): AppChatMessageLog => ({
  append: (input) => store.append(input),
  maxSeq: (topic_id) => store.maxSeq(topic_id),
  markPromptChosen: (input) => store.markPromptChosen(input),
  replayAfter: (topic_id, after_seq) => store.replayAfter(topic_id, after_seq, 1_000_000),
})

/** Replayed message envelopes all carry `seq`; read it without narrowing the
 *  whole `AppWsOutbound` union, so an unrelated envelope kind added later to the
 *  union does not break these tests. */
const seqsOf = (envelopes: ReadonlyArray<AppWsOutbound>): number[] =>
  envelopes.map((e) => ('seq' in e && typeof e.seq === 'number' ? e.seq : 0))

const idsOf = (envelopes: ReadonlyArray<AppWsOutbound>): string[] =>
  envelopes.map((e) => ('message_id' in e && typeof e.message_id === 'string' ? e.message_id : ''))

describe('AppWsAdapter.replayAfter — the bounded window is the NEWEST messages', () => {
  it('delivers the newest 500 of an over-long topic, ascending, on a cold resume', async () => {
    seedRows(BACKLOG)
    const replay = (await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 0))
      .envelopes

    // Same COUNT as the buggy build; the other end of the transcript.
    expect(replay).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(seqsOf(replay)).toEqual(
      Array.from({ length: DEFAULT_REPLAY_LIMIT }, (_, i) => WINDOW_START + i),
    )
    // The assertion the owner actually cared about: the transcript reaches the
    // present. Under `ORDER BY seq ASC` this envelope was seq 500.
    expect(replay.at(-1)).toMatchObject({
      type: 'user_message',
      seq: BACKLOG,
      message_id: `m${BACKLOG}`,
      body: `msg-${BACKLOG}`,
    })
    expect(replay[0]).toMatchObject({ seq: WINDOW_START, body: `msg-${WINDOW_START}` })
  })

  it('omits the OLDEST messages, not the newest — the direction is the fix', async () => {
    // The mutation guard. Reverting `rowsAfter` to `ORDER BY seq ASC` inverts both
    // halves of this at once: seq 1 comes back and seq BACKLOG disappears.
    seedRows(BACKLOG)
    const seqs = new Set(
      seqsOf((await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 0)).envelopes),
    )

    expect(seqs.has(1)).toBe(false)
    expect(seqs.has(WINDOW_START - 1)).toBe(false)
    expect(seqs.has(WINDOW_START)).toBe(true)
    expect(seqs.has(BACKLOG)).toBe(true)
  })

  it('costs exactly ONE store query, however long the backlog is', async () => {
    // The resource guard. A page-by-page drain would make a cold resume
    // O(transcript) in rows, JSON bytes and adapter memory — per topic, multiplied
    // by every scope the mobile warmer opens at app foreground. This pins the
    // ceiling at one bounded read.
    seedRows(BACKLOG)
    const calls: Array<[string, number]> = []
    const store = new AppChatStore({ db })
    const replay = (
      await adapterOn(countingLog(store, (t, after) => calls.push([t, after]))).replayAfter(
        CHANNEL_TOPIC,
        0,
      )
    ).envelopes

    expect(calls).toEqual([[CHANNEL_TOPIC, 0]])
    expect(replay).toHaveLength(DEFAULT_REPLAY_LIMIT)
  })

  it('is byte-identical to an unbounded read when the topic fits in the window', async () => {
    // The below-threshold control: this change must be a no-op until the backlog
    // exceeds one window. Compared against a full-object read of every row through
    // an unbounded limit — not against a restated expectation — so it would catch a
    // reordering or a payload change, not just a different length.
    seedRows(12)
    const store = new AppChatStore({ db })
    const page = await adapterOn(store).replayAfter(CHANNEL_TOPIC, 0)
    const replay = page.envelopes
    const everything = (await adapterOn(unboundedLog(store)).replayAfter(CHANNEL_TOPIC, 0))
      .envelopes

    // …and it reports NO truncation, so a 12-message topic's wire trace gains no
    // `history_gap` and the client sends no backwards request. This is the half of
    // the control that pins the new signal to the over-long case only.
    expect(page.older_than).toBeNull()
    expect(replay).toEqual(everything)
    expect(seqsOf(replay)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(replay[0]).toMatchObject({ type: 'user_message', seq: 1, body: 'msg-1' })
    expect(replay.at(-1)).toMatchObject({ type: 'user_message', seq: 12, body: 'msg-12' })
  })

  it('gap-fills from a non-zero cursor exactly as before', async () => {
    // The contract this change is not trying to touch: a warm client whose gap is
    // smaller than the window gets precisely its gap, no more and no less.
    seedRows(BACKLOG)
    const page = await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 900)

    expect(seqsOf(page.envelopes)).toEqual(
      Array.from({ length: BACKLOG - 900 }, (_, i) => 901 + i),
    )
    // A gap smaller than the window is a COMPLETE answer, so it must not claim
    // there is older history to fetch — otherwise every ordinary reconnect would
    // start a pointless backwards walk.
    expect(page.older_than).toBeNull()
  })

  it('replays nothing, with no durable log wired', async () => {
    expect(await adapterOn(undefined).replayAfter(CHANNEL_TOPIC, 0)).toEqual({
      envelopes: [],
      older_than: null,
    })
  })
})

describe('AppWsAdapter — the edit window covers the message window', () => {
  it('delivers a tombstone for every deleted message inside a capped replay', async () => {
    // A bounded message window is only safe if edit state covers it. Deleting the
    // whole message window plus one message BELOW it is the adversarial case: the
    // edit budget can only cover the window if it is at least as wide as the message
    // budget. Measured, not assumed — narrowing DEFAULT_EDIT_REPLAY_LIMIT to 400
    // makes this list 100 message ids long, each one a deleted message delivered
    // with its original body and no tombstone. The same assertion covers an edit
    // replay reverted to oldest-first, which fails by the same mechanism.
    //
    // What it does NOT catch, so nobody reads it as covering more than it does: a
    // re-added drain in `replayAfter`. With a newest-first window a drain terminates
    // on its second (empty) page and delivers the same rows, so the cost regression
    // shows up in the query-count test above, not here.
    seedRows(BACKLOG)
    const deleted = tombstone(WINDOW_START - 1, BACKLOG)
    // Sized off the MESSAGE limit deliberately: keying the fixture to the edit limit
    // would make the fixture shrink along with a narrowed edit window and hide the
    // very regression this test is for.
    expect(deleted.size).toBe(DEFAULT_REPLAY_LIMIT + 1)

    const adapter = adapterOn(new AppChatStore({ db }), true)
    const messages = (await adapter.replayAfter(CHANNEL_TOPIC, 0)).envelopes
    const edits = await adapter.replayEditsAfter(CHANNEL_TOPIC)

    const tombstoned = new Set(edits.filter((e) => e.deleted).map((e) => e.message_id))
    const leaked = idsOf(messages).filter((id) => deleted.has(id) && !tombstoned.has(id))
    expect(leaked).toEqual([])

    // The newest message specifically — the one the reported repro read back with
    // its pre-delete body.
    expect(messages.at(-1)).toMatchObject({ message_id: `m${BACKLOG}` })
    expect(edits.at(-1)).toMatchObject({
      type: 'edit_update',
      message_id: `m${BACKLOG}`,
      seq: BACKLOG,
      deleted: true,
      body: '',
    })
  })

  it('covers the message window even when EVERY message in the topic is edited', async () => {
    // This replaces an assertion that read `expect(DEFAULT_EDIT_REPLAY_LIMIT)
    // .toBeGreaterThanOrEqual(DEFAULT_REPLAY_LIMIT)` — arithmetic over two
    // constants, which is true in a build where the replay is broken in every way
    // that does not happen to change a constant. The relation between the two limits
    // is not the property; "no message in the window arrives without its tombstone"
    // is, and it is observable.
    //
    // The adversarial fixture the constant-comparison could not express: every
    // message in the topic is deleted, so the edit log holds BACKLOG rows and the
    // window has to choose. It must choose the ones that align with the message page
    // it is paired with.
    seedRows(BACKLOG)
    const deleted = tombstone(1, BACKLOG)
    expect(deleted.size).toBe(BACKLOG)
    expect(BACKLOG).toBeGreaterThan(DEFAULT_EDIT_REPLAY_LIMIT) // the budget really does bind

    const adapter = adapterOn(new AppChatStore({ db }), true)
    const messages = (await adapter.replayAfter(CHANNEL_TOPIC, 0)).envelopes
    const edits = await adapter.replayEditsAfter(CHANNEL_TOPIC)

    const tombstoned = new Set(edits.filter((e) => e.deleted).map((e) => e.message_id))
    const leaked = idsOf(messages).filter((id) => !tombstoned.has(id))
    expect(leaked).toEqual([])
  })
})

describe('AppWsAdapter.replayAfter — the omitted OLDER range is reachable', () => {
  it('reports the page floor when it capped, and nothing when it did not', async () => {
    // The signal itself. `older_than` is the lowest seq the page delivered, which
    // is exactly the bound the next request needs — and it is null on a page that
    // was not full, so a complete answer never triggers a walk.
    seedRows(BACKLOG)
    const adapter = adapterOn(new AppChatStore({ db }))

    const first = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    expect(first.older_than).toBe(WINDOW_START)
    expect(seqsOf(first.envelopes)[0]).toBe(WINDOW_START)

    // Asking below that bound returns the page below it — the rows the first page
    // skipped, which under a forward-only cursor were unreachable for good.
    const second = await adapter.replayAfter(CHANNEL_TOPIC, 0, WINDOW_START)
    expect(seqsOf(second.envelopes).at(-1)).toBe(WINDOW_START - 1)
    expect(second.envelopes).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(second.older_than).toBe(WINDOW_START - DEFAULT_REPLAY_LIMIT)
  })

  it('converges on the COMPLETE transcript across repeated bounded pages', async () => {
    // THE ACCEPTANCE PROPERTY. A topic with more unreplayed rows than the limit is
    // delivered in full by repeating the request, and no page is ever bigger than
    // the limit — the two halves that were in tension before ("complete" versus
    // "bounded") now hold at the same time.
    //
    // MUTATION-PROVED: drop `before_seq` from `AppChatEventLogCore.rowsAfter` (or
    // hard-code `older_than: null` in `replayAfter`) and this test does not merely
    // fail — it either repeats the same newest page forever or stops after one,
    // which is precisely the permanent hole this exists to prevent.
    seedRows(BACKLOG)
    const adapter = adapterOn(new AppChatStore({ db }))

    const seen: number[] = []
    const pageSizes: number[] = []
    let before: number | undefined = undefined
    for (let round = 0; round < 20; round++) {
      const page = await adapter.replayAfter(CHANNEL_TOPIC, 0, before)
      const seqs = seqsOf(page.envelopes)
      pageSizes.push(seqs.length)
      seen.push(...seqs)
      if (page.older_than === null) break
      // Liveness: the bound must STRICTLY descend, or the walk is not a walk.
      if (before !== undefined) expect(page.older_than).toBeLessThan(before)
      before = page.older_than
    }

    // Complete: every seq exactly once.
    expect(new Set(seen).size).toBe(BACKLOG)
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: BACKLOG }, (_, i) => i + 1))
    // Bounded: no page exceeded the limit, and it took the arithmetic minimum
    // number of pages — three, not one per message.
    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(DEFAULT_REPLAY_LIMIT)
    expect(pageSizes.length).toBe(Math.ceil(BACKLOG / DEFAULT_REPLAY_LIMIT))
  })

  it('carries each backwards page its OWN tombstones', async () => {
    // The alignment argument applies to a backwards page too, and it is the half
    // that is easy to get wrong: bound the messages and not the edits and the
    // client receives an OLD page of messages against the NEWEST page of edit
    // state, so every deleted message in that page arrives with its original body.
    // MUTATION-PROVED: drop the `before_seq` argument in `replayEditsAfter` and the
    // leaked list below fills with the whole backwards page.
    seedRows(BACKLOG)
    const deleted = tombstone(1, BACKLOG)
    expect(deleted.size).toBe(BACKLOG)

    const adapter = adapterOn(new AppChatStore({ db }), true)
    const first = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    const second = await adapter.replayAfter(CHANNEL_TOPIC, 0, first.older_than ?? undefined)
    const edits = await adapter.replayEditsAfter(CHANNEL_TOPIC, first.older_than ?? undefined)

    const tombstoned = new Set(edits.filter((e) => e.deleted).map((e) => e.message_id))
    const leaked = idsOf(second.envelopes).filter((id) => !tombstoned.has(id))
    expect(leaked).toEqual([])
    expect(second.envelopes.length).toBe(DEFAULT_REPLAY_LIMIT)
  })
})

describe('AppChatEditStore — an edit is scoped to ITS OWN topic', () => {
  /** A message in a DIFFERENT topic, with a seq far above this topic's range —
   *  the shape that made an alien row sort newest in a descending window. */
  const seedForeignMessage = (topic_id: string, message_id: string, seq: number): void => {
    db.raw()
      .prepare(
        `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, created_at)
           VALUES (?, ?, ?, 'user', ?, ?)`,
      )
      .run(topic_id, seq, message_id, 'foreign', seq)
  }

  it('refuses an edit naming another topic’s message', async () => {
    // The lookup that resolves a message's seq + role used to be
    // `WHERE message_id = ?` with no topic, so this call SUCCEEDED and wrote a row
    // under THIS topic carrying the other topic's seq.
    seedRows(4)
    seedForeignMessage('app:kim', 'k1', 5_000)
    const edits = new AppChatEditStore({ db })

    await expect(
      edits.record({
        topic_id: CHANNEL_TOPIC,
        message_id: 'k1',
        editor_device_id: 'dev-1',
        action: 'delete',
        body: '',
        at: 10,
      }),
    ).rejects.toThrow(/message not found/)

    // …and nothing was written, so the delete cannot be MISFILED here either. The
    // owner's delete belongs to the other topic and must not silently land in this
    // one, where it would tombstone nothing the owner can see.
    expect(await edits.aggregatesAfter(CHANNEL_TOPIC, 0)).toEqual([])
  })

  it('does not let a cross-topic edit evict a tombstone, so deleted content stays deleted', async () => {
    // THE PRIVACY PROPERTY. The edit replay is a capped DESCENDING window, so an
    // alien row carrying another topic's (much higher) seq sorts NEWEST and pushes
    // a real tombstone out of the page. The message log is an immutable overlay
    // (migration 0087), so the evicted message is then delivered with its ORIGINAL
    // BODY and no tombstone: deleted content replays to the client.
    //
    // MUTATION-PROVED: revert `AppChatEventLogCore.lookupMessage` to
    // `WHERE message_id = ?` and `leaked` becomes one message id — the oldest
    // tombstone in the window, resurrected, exactly as the descending window
    // predicts.
    seedRows(BACKLOG)
    const deleted = tombstone(WINDOW_START, BACKLOG)
    expect(deleted.size).toBe(DEFAULT_EDIT_REPLAY_LIMIT) // the window is exactly full
    seedForeignMessage('app:kim', 'k1', 5_000)

    const editStore = new AppChatEditStore({ db })
    // Swallowed on purpose: the fix makes this throw, and the point of the test is
    // what the REPLAY looks like either way. Asserting only the throw would pass
    // against a build that wrote the row and lost the tombstone silently.
    await editStore
      .record({
        topic_id: CHANNEL_TOPIC,
        message_id: 'k1',
        editor_device_id: 'dev-1',
        action: 'delete',
        body: '',
        at: 10,
      })
      .catch(() => {})

    const adapter = adapterOn(new AppChatStore({ db }), true)
    const messages = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    const edits = await adapter.replayEditsAfter(CHANNEL_TOPIC)

    const tombstoned = new Set(edits.filter((e) => e.deleted).map((e) => e.message_id))
    const leaked = idsOf(messages.envelopes).filter((id) => deleted.has(id) && !tombstoned.has(id))
    expect(leaked).toEqual([])
    // And no foreign message id rides along in this topic's edit replay.
    expect(edits.map((e) => e.message_id)).not.toContain('k1')
  })
})
