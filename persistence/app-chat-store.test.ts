import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatStore, DEFAULT_REPLAY_LIMIT } from './app-chat-store.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'
let tmp: string
let db: ProjectDb
let store: AppChatStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-store-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new AppChatStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppChatStore — monotonic per-topic seq', () => {
  it('assigns 1,2,3… per topic on append', async () => {
    const a = await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    const b = await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'b', created_at: 2 })
    const c = await store.append({ topic_id: TOPIC, message_id: 'm3', role: 'user', body: 'c', created_at: 3 })
    expect([a.row.seq, b.row.seq, c.row.seq]).toEqual([1, 2, 3])
    expect(a.was_new && b.was_new && c.was_new).toBe(true)
    expect(await store.maxSeq(TOPIC)).toBe(3)
  })

  it('keeps seq independent across topics', async () => {
    await store.append({ topic_id: 'app:sam', message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    const other = await store.append({ topic_id: 'app:kim', message_id: 'm2', role: 'user', body: 'b', created_at: 1 })
    expect(other.row.seq).toBe(1)
    expect(await store.maxSeq('app:sam')).toBe(1)
    expect(await store.maxSeq('app:kim')).toBe(1)
  })
})

describe('AppChatStore — client_msg_id idempotency', () => {
  it('collapses a re-sent client_msg_id to the existing row without advancing seq', async () => {
    const first = await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'hi', client_msg_id: 'c1', created_at: 1,
    })
    expect(first.was_new).toBe(true)
    expect(first.row.seq).toBe(1)
    // Re-send (offline-queue flush / HTTP-fallback racing the WS echo).
    const again = await store.append({
      topic_id: TOPIC, message_id: 'm1-dup', role: 'user', body: 'hi', client_msg_id: 'c1', created_at: 2,
    })
    expect(again.was_new).toBe(false)
    expect(again.row.seq).toBe(1) // same row, no new seq
    expect(again.row.message_id).toBe('m1') // canonical id preserved
    expect(await store.maxSeq(TOPIC)).toBe(1)
  })
})

describe('AppChatStore — resume replay (WHERE seq > N ORDER BY seq)', () => {
  it('replays only the tail after the cursor, ascending', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append({ topic_id: TOPIC, message_id: `m${i}`, role: 'user', body: `msg-${i}`, created_at: i })
    }
    const replay = await store.replayAfter(TOPIC, 2)
    expect(replay.map((r) => r.seq)).toEqual([3, 4, 5])
    expect(replay.map((r) => r.body)).toEqual(['msg-3', 'msg-4', 'msg-5'])
  })

  // A cold cursor on a topic SMALLER than the replay window: the window covers
  // everything, so this returns the whole transcript. It does not — and cannot —
  // say anything about a topic longer than the window; that is the bounded-window
  // suite at the bottom of this file.
  it('after_seq=0 replays a whole transcript that fits inside the window', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'b', created_at: 2 })
    const replay = await store.replayAfter(TOPIC, 0)
    expect(replay.map((r) => r.seq)).toEqual([1, 2])
  })

  it('clamps a negative / fractional cursor and honours the limit', async () => {
    for (let i = 1; i <= 4; i++) {
      await store.append({ topic_id: TOPIC, message_id: `m${i}`, role: 'user', body: `${i}`, created_at: i })
    }
    expect((await store.replayAfter(TOPIC, -10)).map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect((await store.replayAfter(TOPIC, 2.9)).map((r) => r.seq)).toEqual([3, 4]) // trunc, not round
    // The window is the NEWEST `limit` rows past the cursor, ascending — this
    // assertion read [1, 2] while it was the oldest, which is the defect.
    expect((await store.replayAfter(TOPIC, 0, 2)).map((r) => r.seq)).toEqual([3, 4])
    expect((await store.replayAfter(TOPIC, 0, Number.NaN)).map((r) => r.seq)).toEqual([1, 2, 3, 4]) // falls back to default
  })

  it('round-trips project_id + attachments through a replay', async () => {
    await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'pic',
      project_id: 'proj-9', attachments: ['/api/app/upload/abc', '/api/app/upload/def'], created_at: 1,
    })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.project_id).toBe('proj-9')
    expect(row?.attachments).toEqual(['/api/app/upload/abc', '/api/app/upload/def'])
  })
})

describe('AppChatStore — W3a structured agent meta', () => {
  it('round-trips the opaque meta blob through a replay', async () => {
    const meta = {
      prompt_id: '00000000-0000-4000-8000-000000000abc',
      kind: 'buttons',
      options: [{ label: 'Yes', body: 'Yes', value: 'yes' }],
      citations: [{ title: 'Docs', url: 'https://example.test/d' }],
    }
    await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'agent', body: 'pick', meta, created_at: 1,
    })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.meta).toEqual(meta)
  })

  it('persists NULL meta for a message that carries none', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'agent', body: 'plain', created_at: 1 })
    // An empty-object meta collapses to NULL (matches the PRESENT predicate).
    await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'also plain', meta: {}, created_at: 2 })
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows.map((r) => r.meta)).toEqual([null, null])
  })

  it('degrades a corrupt / non-object meta_json to null on replay (never throws)', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'bad-json', role: 'agent', body: 'a', created_at: 1 })
    await store.append({ topic_id: TOPIC, message_id: 'array', role: 'agent', body: 'b', created_at: 2 })
    await store.append({ topic_id: TOPIC, message_id: 'scalar', role: 'agent', body: 'c', created_at: 3 })
    // Corrupt the durable column out-of-band to simulate a bad / older write.
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('{not json', 'bad-json')
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('[1,2,3]', 'array')
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('"just a string"', 'scalar')
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows.map((r) => r.meta)).toEqual([null, null, null])
  })
})

/**
 * ISSUES #419 — the durable half of button spent-ness.
 *
 * #415 made a second tap inert; the clients still DREW the button as live,
 * because nothing anywhere the client could see said the prompt was answered.
 * This is where the answer is written: onto the agent message that carried the
 * prompt, so it rides the ordinary replay path to every device and every future
 * cold open. Reply rows carry a ten-year TTL, so nothing else ever retires them.
 */
describe('AppChatStore — markPromptChosen (ISSUES #419)', () => {
  const PROMPT = '00000000-0000-4000-8000-0000000004a1'

  async function appendPrompt(message_id: string, prompt_id: string, created_at: number): Promise<void> {
    await store.append({
      topic_id: TOPIC,
      message_id,
      role: 'agent',
      body: 'That one took too long.',
      meta: {
        prompt_id,
        options: [{ label: 'Retry', body: 'Retry', value: '__retry_turn__' }],
      },
      created_at,
    })
  }

  it('stamps the answer onto the message that carries the prompt', async () => {
    await appendPrompt('m1', PROMPT, 1)
    const result = await store.markPromptChosen({
      topic_id: TOPIC,
      prompt_id: PROMPT,
      chosen_value: '__retry_turn__',
    })
    expect(result).toMatchObject({ message_id: 'm1', seq: 1, chosen_value: '__retry_turn__', was_new: true })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.meta?.['chosen_value']).toBe('__retry_turn__')
    // Everything else on the blob is left alone.
    expect(row?.meta?.['prompt_id']).toBe(PROMPT)
    expect(row?.meta?.['options']).toEqual([{ label: 'Retry', body: 'Retry', value: '__retry_turn__' }])
  })

  it('is FIRST-WRITE-WINS: a re-tap reports the recorded answer, not the offered one', async () => {
    await appendPrompt('m1', PROMPT, 1)
    await store.markPromptChosen({ topic_id: TOPIC, prompt_id: PROMPT, chosen_value: 'yes' })
    const again = await store.markPromptChosen({ topic_id: TOPIC, prompt_id: PROMPT, chosen_value: 'no' })
    expect(again).toMatchObject({ message_id: 'm1', chosen_value: 'yes', was_new: false })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.meta?.['chosen_value']).toBe('yes')
  })

  it('matches the prompt id STRUCTURALLY, not as a substring of the meta blob', async () => {
    // The prompt id lives inside an opaque JSON blob that also holds citation
    // titles, doc-ref URLs and option values. A `LIKE '%id%'` lookup would
    // happily stamp THIS message — whose own prompt is a different one — and
    // spend the wrong row while leaving the real one live.
    await store.append({
      topic_id: TOPIC,
      message_id: 'decoy',
      role: 'agent',
      body: 'here is a link',
      meta: {
        prompt_id: 'a-different-prompt',
        doc_refs: [
          { label: 'Trace', url: `neutron://docs/${PROMPT}`, project_id: 'p', path: `${PROMPT}.md` },
        ],
      },
      created_at: 1,
    })
    const miss = await store.markPromptChosen({
      topic_id: TOPIC,
      prompt_id: PROMPT,
      chosen_value: '__retry_turn__',
    })
    expect(miss).toBeNull()
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.meta?.['chosen_value']).toBeUndefined()
  })

  it('is scoped to the topic and returns null when no message carries the prompt', async () => {
    await appendPrompt('m1', PROMPT, 1)
    // Same prompt id, a different owner's topic — must not reach across.
    expect(
      await store.markPromptChosen({ topic_id: 'app:kim', prompt_id: PROMPT, chosen_value: 'yes' }),
    ).toBeNull()
    // An id nothing ever emitted (a failed emit that shipped buttonless, or a
    // client-minted id): nothing to stamp, and no row is invented.
    expect(
      await store.markPromptChosen({ topic_id: TOPIC, prompt_id: 'never-emitted', chosen_value: 'yes' }),
    ).toBeNull()
    expect((await store.replayAfter(TOPIC, 0))[0]?.meta?.['chosen_value']).toBeUndefined()
  })

  it('refuses an empty prompt id or an empty value rather than writing a blank answer', async () => {
    await appendPrompt('m1', PROMPT, 1)
    expect(await store.markPromptChosen({ topic_id: TOPIC, prompt_id: '', chosen_value: 'yes' })).toBeNull()
    expect(await store.markPromptChosen({ topic_id: TOPIC, prompt_id: PROMPT, chosen_value: '' })).toBeNull()
    expect((await store.replayAfter(TOPIC, 0))[0]?.meta?.['chosen_value']).toBeUndefined()
  })
})

describe('AppChatStore — the voice-note transcript is DURABLE', () => {
  // Persisting it is what makes a spoken word survive the device. The client-side
  // half of this fix indexed the transcript locally on whichever phone did the
  // upload; `replayAfter` is how every OTHER device rebuilds its history, so a
  // transcript that is not in this table is a transcript that does not exist for a
  // new install.

  it('round-trips through append AND replay, not just the in-memory return', async () => {
    // Both halves asserted deliberately: `append` returns a row it CONSTRUCTED, so
    // checking only that would pass even if the column were never written. The
    // replay read is the one that proves it reached SQLite.
    const appended = await store.append({
      topic_id: TOPIC,
      message_id: 'm-voice',
      role: 'user',
      body: '',
      attachments: ['/api/app/upload/owner/abc.m4a'],
      transcript: 'renegotiate the warehouse lease',
      created_at: 1,
    })
    expect(appended.row.transcript).toBe('renegotiate the warehouse lease')

    const replayed = await store.replayAfter(TOPIC, 0)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]!.transcript).toBe('renegotiate the warehouse lease')
  })

  it('stores null for a message with no audio', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'typed', created_at: 1 })
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows[0]!.transcript).toBeNull()
  })

  it('normalises a whitespace-only transcript to null', async () => {
    // The ASR returns an empty result for silence. Stored as '' it would be
    // indistinguishable downstream from "transcribed to nothing"; null says it
    // plainly.
    await store.append({
      topic_id: TOPIC,
      message_id: 'm2',
      role: 'user',
      body: '',
      transcript: '   \n  ',
      created_at: 1,
    })
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows[0]!.transcript).toBeNull()
  })

  it('trims the stored value', async () => {
    await store.append({
      topic_id: TOPIC,
      message_id: 'm3',
      role: 'user',
      body: '',
      transcript: '  hello there  ',
      created_at: 1,
    })
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows[0]!.transcript).toBe('hello there')
  })

  it('survives the idempotent re-send collapse without losing the words', async () => {
    // A re-sent user message (offline flush, double-tap, HTTP racing the WS echo)
    // collapses onto the existing row. The collapse returns the STORED row, so this
    // asserts the transcript is not dropped on the way back out.
    const first = await store.append({
      topic_id: TOPIC,
      message_id: 'm4',
      role: 'user',
      body: '',
      client_msg_id: 'c4',
      transcript: 'the words',
      created_at: 1,
    })
    const second = await store.append({
      topic_id: TOPIC,
      message_id: 'm4-again',
      role: 'user',
      body: '',
      client_msg_id: 'c4',
      transcript: 'the words',
      created_at: 2,
    })
    expect(second.was_new).toBe(false)
    expect(second.row.seq).toBe(first.row.seq)
    expect(second.row.transcript).toBe('the words')
  })
})

/**
 * A long chat opened on its OLDEST messages and stopped short of the present. The
 * client's only history request is `resume {after_seq: lastSeenSeq}` (0 on a cold
 * store), it fires exactly ONCE per socket open, and the cursor it sends is the
 * client's MAX applied seq — which the answer itself advances. So a replay capped
 * at `DEFAULT_REPLAY_LIMIT` is not a page of a sequence, it is the ONLY answer that
 * open will get, and `ORDER BY seq ASC LIMIT 500` made that answer the oldest 500.
 * Reported live on a 1130-message topic: it showed old messages and ended ~630
 * short of the present.
 *
 * The window is now the NEWEST `limit` rows past the cursor, re-sorted ascending.
 * Two properties are asserted here and they are the whole change:
 *
 *  - ABOVE the limit, the window ends at the topic's newest row and the rows it
 *    omits are the OLDEST ones. Reverting the SQL to `ORDER BY seq ASC` inverts
 *    every one of these assertions.
 *  - AT OR BELOW the limit, the result is unchanged, field for field, from an
 *    unbounded read of the same range — so nothing about ordinary gap-fill moves.
 *
 * WHAT IS STILL LOST, asserted rather than glossed: above the limit the omitted
 * older rows are NOT reachable by a later call, because a resume cursor only moves
 * forward. This converts "missing the newest 630" into "missing a middle 630". It
 * is the right trade for an owner who needs recent messages and it is not a
 * complete history sync; the test named for it pins the loss so nobody later reads
 * the suite as proving completeness.
 */
describe('AppChatStore — the replay window is the NEWEST rows past the cursor', () => {
  const TOTAL = DEFAULT_REPLAY_LIMIT + 630 // 1130, the live report's exact shape
  /** First seq a cold newest-window replay of a TOTAL-row topic reaches. */
  const WINDOW_START = TOTAL - DEFAULT_REPLAY_LIMIT + 1

  const seed = async (count: number): Promise<void> => {
    for (let i = 1; i <= count; i++) {
      await store.append({
        topic_id: TOPIC, message_id: `m${i}`, role: i % 2 === 0 ? 'agent' : 'user',
        body: `msg-${i}`, created_at: i,
      })
    }
  }

  it('a cold cursor on an over-long topic returns the newest limit rows, ascending', async () => {
    await seed(TOTAL)
    const replay = await store.replayAfter(TOPIC, 0)

    expect(replay).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(replay.map((r) => r.seq)).toEqual(
      Array.from({ length: DEFAULT_REPLAY_LIMIT }, (_, i) => WINDOW_START + i),
    )
    // Ascending on the wire even though the SQL selects descending: clients apply
    // in seq order and a descending replay would reorder the transcript.
    expect(replay[0]!.seq).toBe(WINDOW_START)
    expect(replay[replay.length - 1]!.seq).toBe(TOTAL)
    expect(replay[replay.length - 1]!.body).toBe(`msg-${TOTAL}`)
  })

  it('omits the OLDEST rows, which is the assertion that inverts on a revert', async () => {
    await seed(TOTAL)
    const seqs = new Set((await store.replayAfter(TOPIC, 0)).map((r) => r.seq))

    // Under `ORDER BY seq ASC` these four flip in pairs, all at once.
    expect(seqs.has(1)).toBe(false)
    expect(seqs.has(WINDOW_START - 1)).toBe(false)
    expect(seqs.has(WINDOW_START)).toBe(true)
    expect(seqs.has(TOTAL)).toBe(true)
  })

  it('the omitted rows are NOT recoverable by a later resume — the trade, pinned', async () => {
    await seed(TOTAL)
    const first = await store.replayAfter(TOPIC, 0)
    // A resume cursor only ever moves forward: the client's next cursor is the MAX
    // seq it applied, which is this window's last row. Asking again from there is
    // empty, so seq 1..WINDOW_START-1 stay missing for the life of that store.
    const next = await store.replayAfter(TOPIC, first[first.length - 1]!.seq)

    expect(next).toEqual([])
  })

  it('a topic at exactly the limit is byte-identical to an unbounded read', async () => {
    // The control at the threshold: full rows, every field, both paths. Would go red
    // on a payload or ordering change anywhere in the window, not just at the head.
    await seed(DEFAULT_REPLAY_LIMIT)
    const windowed = await store.replayAfter(TOPIC, 0)
    const unbounded = await store.replayAfter(TOPIC, 0, 1_000_000)

    expect(windowed).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(windowed).toEqual(unbounded)
    expect(windowed).toEqual(
      Array.from({ length: DEFAULT_REPLAY_LIMIT }, (_, i) => ({
        topic_id: TOPIC,
        seq: i + 1,
        message_id: `m${i + 1}`,
        role: (i + 1) % 2 === 0 ? 'agent' : 'user',
        body: `msg-${i + 1}`,
        client_msg_id: null,
        project_id: null,
        attachments: null,
        meta: null,
        transcript: null,
        created_at: i + 1,
      })),
    )
  })

  it('a topic BELOW the limit is byte-identical to an unbounded read', async () => {
    // The below-threshold control the fix has to satisfy to be a no-op for every
    // ordinary chat: nothing about a short topic's replay changes at all.
    await seed(12)
    const windowed = await store.replayAfter(TOPIC, 0)
    const unbounded = await store.replayAfter(TOPIC, 0, 1_000_000)

    expect(windowed).toEqual(unbounded)
    expect(windowed.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('a gap SMALLER than the window is delivered whole, from a warm cursor', async () => {
    // The contract this change is not trying to move: a reconnecting client whose
    // gap fits gets exactly its gap. Compared against an unbounded read of the same
    // range so "unchanged" is measured, not restated.
    await seed(TOTAL)
    const windowed = await store.replayAfter(TOPIC, 900)
    const unbounded = await store.replayAfter(TOPIC, 900, 1_000_000)

    expect(windowed).toEqual(unbounded)
    expect(windowed.map((r) => r.seq)).toEqual(
      Array.from({ length: TOTAL - 900 }, (_, i) => 901 + i),
    )
  })

  it('a gap LARGER than the window is trimmed at its old end, not its new one', async () => {
    // A warm client that has been away long enough to exceed the window still lands
    // on the present. `limit 3` from cursor 4 on a 12-row topic: newest three of
    // 5..12, not the oldest three.
    await seed(12)
    expect((await store.replayAfter(TOPIC, 4, 3)).map((r) => r.seq)).toEqual([10, 11, 12])
  })

  it('a cursor at or past the head replays nothing, with no wrap-around', async () => {
    await seed(12)
    expect(await store.replayAfter(TOPIC, 12)).toEqual([])
    expect(await store.replayAfter(TOPIC, 99)).toEqual([])
  })

  it('leaves other topics untouched', async () => {
    await seed(DEFAULT_REPLAY_LIMIT + 3)
    await store.append({ topic_id: 'app:kim', message_id: 'k1', role: 'user', body: 'k', created_at: 1 })
    expect((await store.replayAfter('app:kim', 0)).map((r) => r.seq)).toEqual([1])
  })
})
