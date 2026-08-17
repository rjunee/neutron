/**
 * The resume-path regression that shipped to the owner: a long chat rendered its
 * OLDEST messages and stopped ~630 short of the present.
 *
 * `resume` fires exactly ONCE per socket open (`SyncEngine`'s per-open guard, sent
 * from `chat-core/web-session.ts` and `app/lib/chat-core/mobile-session.ts`
 * `resumeAndFlush`), the adapter answers it with ONE bounded query, and the cursor
 * the client sends is its MAX applied seq — which that query advances. So which END
 * of the backlog the query takes is the whole behaviour: on a 1130-message topic
 * `ORDER BY seq ASC LIMIT 500` delivered seq 1..500, and the remaining 630 arrived
 * only across two further app restarts, one screenful at a time.
 *
 * The window is now the NEWEST `DEFAULT_REPLAY_LIMIT` rows, re-sorted ascending.
 * These tests are at the ADAPTER level on purpose — two of the properties that
 * matter are not visible in the store: that a resume costs exactly ONE query (no
 * unbounded drain), and that the message window and the edit window cover the same
 * messages, so a capped replay cannot deliver a deleted message without its
 * tombstone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
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
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
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
    const replay = await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 0)

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
      seqsOf(await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 0)),
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
    const replay = await adapterOn(
      countingLog(store, (t, after) => calls.push([t, after])),
    ).replayAfter(CHANNEL_TOPIC, 0)

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
    const replay = await adapterOn(store).replayAfter(CHANNEL_TOPIC, 0)
    const everything = await adapterOn(unboundedLog(store)).replayAfter(CHANNEL_TOPIC, 0)

    expect(replay).toEqual(everything)
    expect(seqsOf(replay)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(replay[0]).toMatchObject({ type: 'user_message', seq: 1, body: 'msg-1' })
    expect(replay.at(-1)).toMatchObject({ type: 'user_message', seq: 12, body: 'msg-12' })
  })

  it('gap-fills from a non-zero cursor exactly as before', async () => {
    // The contract this change is not trying to touch: a warm client whose gap is
    // smaller than the window gets precisely its gap, no more and no less.
    seedRows(BACKLOG)
    const replay = await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 900)

    expect(seqsOf(replay)).toEqual(Array.from({ length: BACKLOG - 900 }, (_, i) => 901 + i))
  })

  it('replays nothing, with no durable log wired', async () => {
    expect(await adapterOn(undefined).replayAfter(CHANNEL_TOPIC, 0)).toEqual([])
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
    const messages = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    const edits = await adapter.replayEditsAfter(CHANNEL_TOPIC, 0)

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

  it('keeps the two windows the same size, which is what makes the coverage total', async () => {
    // The counting argument in one assertion: at most DEFAULT_REPLAY_LIMIT messages
    // sit at or above the message window's lowest seq, so an edit window at least
    // that wide holds every edit row for them. Shrinking the edit limit below the
    // message limit silently reintroduces the leak above.
    expect(DEFAULT_EDIT_REPLAY_LIMIT).toBeGreaterThanOrEqual(DEFAULT_REPLAY_LIMIT)
  })
})
