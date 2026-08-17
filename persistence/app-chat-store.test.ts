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

  it('after_seq=0 replays the whole transcript', async () => {
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
    // One page is the OLDEST `limit` past the cursor — a PREFIX, so the last
    // row's seq is a valid cursor for the rest (see the drain-convergence suite).
    expect((await store.replayAfter(TOPIC, 0, 2)).map((r) => r.seq)).toEqual([1, 2])
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
 * store) and it fires exactly ONCE per socket open, so a replay capped at
 * `DEFAULT_REPLAY_LIMIT` handed the device 500 messages and stopped. Reported live
 * on a 1130-message topic: it showed old messages and ended ~630 short.
 *
 * The property that makes the fix possible is asserted here: ONE PAGE IS A PREFIX.
 * The page is the OLDEST `limit` rows past the cursor, so the last row's `seq` is
 * a valid cursor for the remainder and repeated calls CONVERGE on the whole
 * backlog, in order, losing nothing. `AppWsAdapter.replayAfter` does exactly that
 * loop, which is what makes one socket open enough.
 *
 * This is deliberately NOT fixed by returning the newest page instead. That reads
 * better in a single call and is worse: the cursor would jump to the topic max and
 * every earlier message would become permanently unreachable, because a resume
 * cursor only moves forward. The convergence test below is the one that tells the
 * two apart — a newest-page window makes it collect 500 of 1130 and stop.
 */
describe('AppChatStore — one replay page is a PREFIX, so paging converges', () => {
  const seed = async (count: number): Promise<void> => {
    for (let i = 1; i <= count; i++) {
      await store.append({
        topic_id: TOPIC, message_id: `m${i}`, role: i % 2 === 0 ? 'agent' : 'user',
        body: `msg-${i}`, created_at: i,
      })
    }
  }

  /** The drain a paging caller performs: page, advance to the last row's seq,
   *  repeat until a page comes back empty. Mirrors `AppWsAdapter.replayAfter`. */
  const drain = async (from = 0, limit?: number): Promise<number[]> => {
    const seqs: number[] = []
    let cursor = from
    for (let guard = 0; guard < 100; guard++) {
      const page = await store.replayAfter(TOPIC, cursor, limit)
      if (page.length === 0) return seqs
      for (const r of page) seqs.push(r.seq)
      const last = page[page.length - 1]!
      if (last.seq <= cursor) return seqs
      cursor = last.seq
    }
    throw new Error('drain did not terminate')
  }

  it('a page is the OLDEST rows past the cursor, and the page advances the cursor', async () => {
    await seed(DEFAULT_REPLAY_LIMIT + 630) // 1130, the live report's exact shape
    const first = await store.replayAfter(TOPIC, 0)

    expect(first).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(first.map((r) => r.seq)).toEqual(
      Array.from({ length: DEFAULT_REPLAY_LIMIT }, (_, i) => i + 1),
    )
    // Load-bearing: the omitted remainder is reachable FROM this page's last row.
    // Under a newest-page window this cursor would be 1130 and seq 1..630 would be
    // unreachable for the life of the store.
    const second = await store.replayAfter(TOPIC, first[first.length - 1]!.seq)
    expect(second[0]!.seq).toBe(DEFAULT_REPLAY_LIMIT + 1)
  })

  it('draining converges on the WHOLE 1130-message backlog, in order, exactly once', async () => {
    const total = DEFAULT_REPLAY_LIMIT + 630
    await seed(total)

    const seqs = await drain()

    // Complete: nothing dropped. A newest-page window collects 500 and stops here.
    expect(seqs).toHaveLength(total)
    expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    // And no duplicates from the page boundaries (length + set size together).
    expect(new Set(seqs).size).toBe(total)
    // Three pages of 500, 500, 130 — the drain is doing real paging, not one call.
    expect(Math.ceil(total / DEFAULT_REPLAY_LIMIT)).toBe(3)
  })

  it('converges from a non-zero cursor too, without re-sending what the client has', async () => {
    await seed(DEFAULT_REPLAY_LIMIT + 630)
    const seqs = await drain(700)
    expect(seqs[0]).toBe(701)
    expect(seqs[seqs.length - 1]).toBe(DEFAULT_REPLAY_LIMIT + 630)
    expect(seqs).toEqual(Array.from({ length: 430 }, (_, i) => 701 + i))
  })

  it('converges on a tiny limit, where almost every call is a page boundary', async () => {
    await seed(11)
    // limit 2 → six pages, the last one short. Exercises the boundary repeatedly.
    expect(await drain(0, 2)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('a topic inside the limit replays COMPLETE rows, every field, in one page', async () => {
    // The control: at or below the threshold one page is the whole transcript, so
    // this pins full row payloads — every row, not just the first — and would go
    // red on any corruption of a later row, not only of the head.
    await seed(DEFAULT_REPLAY_LIMIT)
    const replay = await store.replayAfter(TOPIC, 0)

    expect(replay).toHaveLength(DEFAULT_REPLAY_LIMIT)
    expect(replay).toEqual(
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

  // CONTROL — the ordinary gap-fill contract this change must NOT touch.
  it('still gap-fills forward from a non-zero cursor', async () => {
    await seed(12)
    expect((await store.replayAfter(TOPIC, 9)).map((r) => r.seq)).toEqual([10, 11, 12])
    expect((await store.replayAfter(TOPIC, 0)).map((r) => r.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
    // Cursor at the head: nothing to replay, so a drain terminates immediately.
    expect(await store.replayAfter(TOPIC, 12)).toEqual([])
    // Cursor past the head: still nothing, and no wrap-around.
    expect(await store.replayAfter(TOPIC, 99)).toEqual([])
  })

  it('caps from a non-zero cursor to the oldest page past it, not the newest', async () => {
    await seed(12)
    expect((await store.replayAfter(TOPIC, 4, 3)).map((r) => r.seq)).toEqual([5, 6, 7])
  })

  it('leaves other topics untouched', async () => {
    await seed(DEFAULT_REPLAY_LIMIT + 3)
    await store.append({ topic_id: 'app:kim', message_id: 'k1', role: 'user', body: 'k', created_at: 1 })
    expect((await store.replayAfter('app:kim', 0)).map((r) => r.seq)).toEqual([1])
  })
})
