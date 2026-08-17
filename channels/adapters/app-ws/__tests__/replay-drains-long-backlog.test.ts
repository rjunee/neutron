/**
 * The resume-path regression that shipped to the owner: a long chat rendered its
 * OLDEST messages and stopped ~630 short of the present.
 *
 * `resume` fires exactly ONCE per socket open (`SyncEngine`'s per-open guard, sent
 * from `chat-core/web-session.ts` and `app/lib/chat-core/mobile-session.ts`
 * `resumeAndFlush`), and the adapter answered it with ONE bounded page —
 * `DEFAULT_REPLAY_LIMIT = 500` rows. On a 1130-message topic that is 500 envelopes
 * and silence. The client's cursor is `MAX(applied seq)`, so the remaining 630 only
 * arrived across two further app restarts, one screenful at a time.
 *
 * `AppWsAdapter.replayAfter` now drains page-by-page, the way the receipt and
 * reaction replays beside it already did. These tests are at the ADAPTER level on
 * purpose: the store-level suite can only prove a page is a prefix, and the defect
 * lived in the caller that never asked for the second page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import type { AppChatMessageLog, AppChatRow } from '@neutronai/persistence/index.ts'
import { AppChatStore, DEFAULT_REPLAY_LIMIT, ProjectDb } from '@neutronai/persistence/index.ts'
import { AppWsAdapter } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type { AppWsOutbound } from '../envelope.ts'

const CHANNEL_TOPIC = 'app:sam'
/** The live report's exact shape: 1130 messages, ~630 of them missing. */
const BACKLOG = DEFAULT_REPLAY_LIMIT + 630

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-drain-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const adapterOn = (chat_log?: AppChatMessageLog) =>
  new AppWsAdapter({
    registry: new InMemoryAppWsSessionRegistry(),
    receiver: { receive: async () => {} },
    now: () => 1000,
    generate_message_id: () => 'msg-x',
    ...(chat_log === undefined ? {} : { chat_log }),
  })

/** Seed straight into SQL — 1130 `append` round-trips is a slow way to say "long". */
const seedRows = (count: number): void => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
  )
  for (let i = 1; i <= count; i++) stmt.run(CHANNEL_TOPIC, i, `m${i}`, `msg-${i}`, i)
}

/** The real store, with every `replayAfter` call announced — so a test can prove
 *  the drain really paged instead of making one big query. */
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

/** Replayed message envelopes all carry `seq`; read it without narrowing the
 *  whole `AppWsOutbound` union, so an unrelated envelope kind added later to the
 *  union does not break these tests. */
const seqsOf = (envelopes: ReadonlyArray<AppWsOutbound>): number[] =>
  envelopes.map((e) => ('seq' in e && typeof e.seq === 'number' ? e.seq : 0))

describe('AppWsAdapter.replayAfter — drains the WHOLE backlog on one resume', () => {
  it('replays all 1130 messages of an over-long topic, ascending, on a cold resume', async () => {
    seedRows(BACKLOG)
    const replay = await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 0)

    // Before the drain this was exactly DEFAULT_REPLAY_LIMIT and stopped at seq 500.
    expect(replay).toHaveLength(BACKLOG)
    expect(seqsOf(replay)).toEqual(Array.from({ length: BACKLOG }, (_, i) => i + 1))
    // The two assertions the owner actually cared about: the newest message is
    // present, and the transcript reaches it without a hole.
    expect(replay.at(-1)).toMatchObject({
      type: 'user_message',
      seq: BACKLOG,
      message_id: `m${BACKLOG}`,
      body: `msg-${BACKLOG}`,
    })
    // Payload integrity across a page boundary, not just at the ends: the rows
    // either side of the 500/501 seam carry their own bodies.
    expect(replay[499]).toMatchObject({ seq: 500, body: 'msg-500' })
    expect(replay[500]).toMatchObject({ seq: 501, body: 'msg-501' })
    expect(new Set(seqsOf(replay)).size).toBe(BACKLOG)
  })

  it('resumes mid-transcript without re-sending what the client already has', async () => {
    seedRows(BACKLOG)
    const replay = await adapterOn(new AppChatStore({ db })).replayAfter(CHANNEL_TOPIC, 900)

    expect(seqsOf(replay)).toEqual(Array.from({ length: BACKLOG - 900 }, (_, i) => 901 + i))
  })

  it('is unchanged for a topic that fits in one page — still exactly one query', async () => {
    // The control. Below the limit the drain must be a no-op on behaviour, and it
    // must not cost an extra round trip beyond the one that proves exhaustion.
    seedRows(12)
    const calls: Array<[string, number]> = []
    const store = new AppChatStore({ db })
    const replay = await adapterOn(
      countingLog(store, (t, after) => calls.push([t, after])),
    ).replayAfter(CHANNEL_TOPIC, 0)

    expect(seqsOf(replay)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    // Page 1 returns 12 rows, page 2 returns none and ends the drain.
    expect(calls).toEqual([
      [CHANNEL_TOPIC, 0],
      [CHANNEL_TOPIC, 12],
    ])
  })

  it('pages with a real advancing cursor rather than one unbounded query', async () => {
    // Guards the mechanism, not just the result: if someone "simplified" the drain
    // into a single call with a huge limit, the cursor sequence below goes away.
    seedRows(BACKLOG)
    const cursors: number[] = []
    const store = new AppChatStore({ db })
    const replay = await adapterOn(
      countingLog(store, (_t, after) => cursors.push(after)),
    ).replayAfter(CHANNEL_TOPIC, 0)

    expect(replay).toHaveLength(BACKLOG)
    // 0 → 500 → 1000 → 1130, then one empty page to prove exhaustion.
    expect(cursors).toEqual([0, 500, 1000, BACKLOG])
  })

  it('stops instead of spinning when a log hands back a non-advancing page', async () => {
    // Liveness. A malformed log that keeps returning the same page would otherwise
    // loop forever and hang the socket's resume — the same class of guard the
    // receipt/reaction drains carry. Bounded by the test timeout if it regresses.
    const stuck: AppChatRow = {
      topic_id: CHANNEL_TOPIC,
      seq: 1,
      message_id: 'm1',
      role: 'user',
      body: 'stuck',
      client_msg_id: null,
      project_id: null,
      attachments: null,
      meta: null,
      transcript: null,
      created_at: 1,
    }
    const replay = await adapterOn({
      append: async () => {
        throw new Error('unused in this test')
      },
      maxSeq: async () => 1,
      markPromptChosen: async () => null,
      // Always the same seq: never advances past the cursor it was given.
      replayAfter: async () => [stuck],
    }).replayAfter(CHANNEL_TOPIC, 1)

    expect(seqsOf(replay)).toEqual([1])
  })

  it('replays nothing, with no durable log wired', async () => {
    expect(await adapterOn(undefined).replayAfter(CHANNEL_TOPIC, 0)).toEqual([])
  })
})
