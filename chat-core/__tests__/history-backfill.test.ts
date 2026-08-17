/**
 * The CLIENT half of "a bounded replay is not a lost replay".
 *
 * A capped forward replay hands the client the newest page and advances its cursor
 * past everything below — so before the server said so, and before the client
 * asked, the middle of a long transcript was gone for good. The wire now carries
 * `history_gap` (the server admitting a page was full) and `resume.before_seq` (the
 * client asking for the page below), and these tests pin what the CLIENT does with
 * that pair: it walks, it stops walking, and it picks the walk up again on the next
 * catch-up.
 *
 * The server here is a SIMULATION, deliberately, and it is the same ten lines the
 * real surface runs: the newest `limit` rows of the requested range, followed by a
 * `history_gap` when that page came back full. That the REAL store and adapter
 * behave this way is asserted separately and against real SQL
 * (`channels/adapters/app-ws/__tests__/replay-newest-window.test.ts`) — this file
 * would otherwise be testing two of my own assumptions against each other.
 */
import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { MAX_HISTORY_BACKFILL_ROUNDS } from '../sync-engine.ts'
import { WebChatSession } from '../web-session.ts'
import type { SocketLike } from '../ws-client.ts'

const TOPIC = 'app:sam'
/** Small on purpose: the properties are about the WALK, not about big numbers. */
const PAGE = 10

class FakeSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  fireClose(): void {
    this.closed = true
    this.onclose?.()
  }
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  resumes(): Array<Record<string, unknown>> {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'resume')
  }
  backwards(): Array<Record<string, unknown>> {
    return this.resumes().filter((e) => e['before_seq'] !== undefined)
  }
}

/**
 * The surface's answer to one `resume`, as frames: the newest `PAGE` rows of the
 * requested half-open range, ascending, plus a `history_gap` when the page filled.
 * `total` stands for a transcript of seqs 1..total.
 */
function answerResume(total: number, frame: Record<string, unknown>): unknown[] {
  const after = typeof frame['after_seq'] === 'number' ? frame['after_seq'] : 0
  const before =
    typeof frame['before_seq'] === 'number' ? (frame['before_seq'] as number) : total + 1
  const inRange: number[] = []
  for (let seq = 1; seq <= total; seq++) if (seq > after && seq < before) inRange.push(seq)
  const page = inRange.slice(-PAGE)
  const frames: unknown[] = page.map((seq) => ({
    v: 1,
    type: 'agent_message',
    message_id: `m${seq}`,
    seq,
    body: `msg-${seq}`,
    ts: seq,
  }))
  if (page.length >= PAGE && page[0] !== undefined) {
    frames.push({ v: 1, type: 'history_gap', older_than: page[0], ts: 0 })
  }
  return frames
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function setup(): { session: WebChatSession; sockets: FakeSocket[]; store: InMemoryStore } {
  const sockets: FakeSocket[] = []
  const store = new InMemoryStore()
  const session = new WebChatSession({
    url: 'wss://test/ws/app/chat',
    topic_id: TOPIC,
    store,
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    now: (() => {
      let t = 0
      return () => ++t
    })(),
  })
  return { session, sockets, store }
}

/**
 * Answer every `resume` this socket has sent and not yet been answered for, then
 * let the client react — repeatedly, until it stops asking. Returns how many
 * requests were served, which is the walk length the client actually drove.
 */
async function pump(socket: FakeSocket, total: number): Promise<number> {
  let served = 0
  for (let guard = 0; guard < 50; guard++) {
    const pending = socket.resumes().slice(served)
    if (pending.length === 0) return served
    for (const frame of pending) {
      served += 1
      for (const out of answerResume(total, frame)) socket.deliver(out)
      await tick()
    }
  }
  throw new Error('the client never stopped requesting history')
}

const seqsIn = async (store: InMemoryStore): Promise<number[]> =>
  (await store.list(TOPIC)).map((m) => m.seq ?? 0).sort((a, b) => a - b)

describe('history backfill — a capped replay converges on the whole transcript', () => {
  it('walks backwards until the transcript is COMPLETE', async () => {
    // 25 messages against a 10-row page: the forward resume can only carry 16..25,
    // and every earlier message arrives because the client keeps asking.
    //
    // MUTATION-PROVED: delete the `history_gap` branch in
    // `WebChatSession.handleInbound` (or the `requestHistoryBackfill` call in
    // `resumeAndFlush`) and this ends at [16..25] — the exact permanent hole the
    // newest-window replay shipped with.
    const total = 25
    const { session, sockets, store } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()

    const served = await pump(sockets[0]!, total)

    expect(await seqsIn(store)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    // One forward resume plus exactly the backwards pages the arithmetic needs.
    expect(served).toBe(Math.ceil(total / PAGE))
    expect(sockets[0]!.backwards().map((f) => f['before_seq'])).toEqual([16, 6])
  })

  it('caps one catch-up at MAX_HISTORY_BACKFILL_ROUNDS pages, then converges on the NEXT one', async () => {
    // THE ACCEPTANCE PROPERTY, in the form that also protects the background
    // warmer: a single catch-up walks a bounded number of pages — the ceiling
    // `transcript-warmer.ts` sizes its fan-out against — and the remainder is NOT
    // stranded, because the next catch-up restarts the walk from the client's OWN
    // oldest applied seq.
    //
    // MUTATION-PROVED, both halves: raise the round budget to Infinity and the
    // first open drains everything, so the `missing` assertion below goes green
    // before the reconnect and the ceiling is gone. Delete
    // `SyncEngine.backfillFrom`'s use in `resumeAndFlush` and the reconnect stops
    // recovering the remainder, so the final assertion fails and history is
    // permanently short by exactly the rows one open could not reach.
    const total = (MAX_HISTORY_BACKFILL_ROUNDS + 1) * PAGE + 5
    const { session, sockets, store } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    await pump(sockets[0]!, total)

    // Bounded: the forward page plus the budget, and no more.
    expect(sockets[0]!.backwards().length).toBe(MAX_HISTORY_BACKFILL_ROUNDS)
    const afterFirstOpen = await seqsIn(store)
    expect(afterFirstOpen.length).toBe((MAX_HISTORY_BACKFILL_ROUNDS + 1) * PAGE)
    const missing = 5
    expect(afterFirstOpen[0]).toBe(missing + 1) // the oldest `missing` rows are still absent

    // A reconnect: the forward resume has nothing to fetch, so ONLY the client's
    // own oldest applied seq can restart the walk — and it does.
    sockets.at(-1)!.fireClose()
    session.setActive(false)
    session.setActive(true)
    const next = sockets.at(-1)!
    next.open()
    next.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    await pump(next, total)

    expect(next.backwards()[0]).toMatchObject({ after_seq: 0, before_seq: missing + 1 })
    expect(await seqsIn(store)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  })

  it('asks for nothing when the transcript fits in one page', async () => {
    // The below-threshold control: the wire trace of a short topic is unchanged —
    // one forward resume, no `history_gap` from the server, no backwards request
    // from the client.
    const total = PAGE - 4
    const { session, sockets, store } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    const served = await pump(sockets[0]!, total)

    expect(served).toBe(1)
    expect(sockets[0]!.backwards()).toEqual([])
    expect(await seqsIn(store)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  })

  it('ignores a gap that does not strictly descend, so a repeating server cannot spin it', async () => {
    // The liveness guard. A `history_gap` is a server-controlled input; a stuck or
    // buggy one that repeats the same `older_than` must cost one request, not a
    // request loop. (`pump` would throw on a loop, so the count is the assertion
    // and the absence of a throw is the second one.)
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()

    sockets[0]!.deliver({ v: 1, type: 'history_gap', older_than: 40, ts: 0 })
    await tick()
    sockets[0]!.deliver({ v: 1, type: 'history_gap', older_than: 40, ts: 0 })
    sockets[0]!.deliver({ v: 1, type: 'history_gap', older_than: 90, ts: 0 })
    await tick()

    expect(sockets[0]!.backwards().map((f) => f['before_seq'])).toEqual([40])
  })

  it('converges on a transcript with an INTERIOR hole, across repeated opens', async () => {
    // THE ACCEPTANCE PROPERTY for the hole a client cannot be told about. The two
    // mechanisms above are both server-driven: `history_gap` only ever describes a
    // page the server just sent, so neither can mention a range the client lost
    // BETWEEN opens. Only the client's own store can notice that, and the test it
    // used to apply ("is my oldest seq above 1") is blind to a hole that sits ABOVE
    // seq 1.
    //
    // The fixture builds exactly that store: the device holds an old prefix 1..5 from
    // an earlier, shorter version of the topic, and the topic has since grown to
    // `total`. The forward resume delivers the newest page, the round budget runs
    // out partway down, and the device is left holding 1..5 plus a recent run — an
    // interior hole, with seq 1 present and the forward cursor above the hole.
    //
    // MUTATION-PROVED: restore `backfillFrom` to read the store's MINIMUM seq and
    // the loop below never completes — it exits on the "made no progress" guard with
    // the hole still there, because from open 2 onwards the client asks for nothing
    // at all. That is the permanent stranding, reproduced.
    const total = 65
    const { session, sockets, store } = setup()
    // The old prefix, applied before the session ever opens.
    for (let seq = 1; seq <= 5; seq++) {
      await store.upsert({
        topic_id: TOPIC,
        client_msg_id: '',
        message_id: `m${seq}`,
        seq,
        role: 'agent',
        body: `msg-${seq}`,
        project_id: null,
        attachments: null,
        created_at: seq,
        status: 'acked',
      })
    }

    const complete = Array.from({ length: total }, (_, i) => i + 1)
    let opens = 0
    let holeSeenAboveSeqOne = false
    for (; opens < 10; opens++) {
      if (opens === 0) {
        session.start()
      } else {
        // A reconnect: close and re-open, which is what re-drives the forward resume
        // and therefore the walk's fresh round budget.
        sockets.at(-1)!.fireClose()
        session.setActive(false)
        session.setActive(true)
      }
      const socket = sockets.at(-1)!
      socket.open()
      socket.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
      await tick()
      const before = await seqsIn(store)
      await pump(socket, total)
      const after = await seqsIn(store)

      // The precondition that made the shipped test answer wrongly: seq 1 is held
      // AND the transcript is not contiguous. Recorded rather than assumed, so this
      // test cannot silently stop exercising the interior-hole case.
      if (after[0] === 1 && after.length < total) holeSeenAboveSeqOne = true
      if (after.length === total) break
      // Liveness: every open must recover at least one row, or the walk is stuck.
      expect(after.length).toBeGreaterThan(before.length)
    }

    expect(holeSeenAboveSeqOne).toBe(true)
    expect(await seqsIn(store)).toEqual(complete)
    // Convergent AND bounded: a handful of opens, not one per message.
    expect(opens).toBeLessThanOrEqual(3)
  })

  it('never asks below seq 1, which is where the transcript starts', async () => {
    // Seqs are assigned from 1, so `before_seq: 1` could only ever return nothing.
    // Asking anyway would put one dead round trip on every catch-up of a COMPLETE
    // transcript — the common case.
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    sockets[0]!.deliver({ v: 1, type: 'history_gap', older_than: 1, ts: 0 })
    await tick()

    expect(sockets[0]!.backwards()).toEqual([])
  })

  it('does not buy a page it already holds when the server calls its page full', async () => {
    // `history_gap` means the SERVER's page came back full. That is not the same claim
    // as "rows remain below it" for THIS device: one already holding the range below
    // the page used to answer the frame by re-downloading it, every open.
    //
    // MUTATION-PROVED: drop the `if (this.historyComplete) return` guard in
    // `WebChatSession.requestHistoryBackfill` and the last assertion fails — a
    // backwards resume goes out for seqs the store is holding.
    const { session, sockets, store } = setup()
    for (const seq of Array.from({ length: PAGE }, (_, i) => i + 1)) {
      await store.upsert({
        topic_id: TOPIC,
        client_msg_id: `h${seq}`,
        message_id: `h${seq}`,
        seq,
        role: 'agent',
        body: `msg-${seq}`,
        project_id: null,
        attachments: null,
        created_at: seq,
        status: 'acked',
      })
    }
    // The precondition, measured: whole down to seq 1.
    expect(await store.contiguousFloorSeq(TOPIC)).toBe(1)

    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    // A FULL page above the cursor, then the truthful-for-the-server gap.
    await pump(sockets[0]!, PAGE * 2)

    expect(await seqsIn(store)).toEqual(Array.from({ length: PAGE * 2 }, (_, i) => i + 1))
    expect(sockets[0]!.backwards()).toEqual([])
  })

  it('STILL walks when the page it was just sent is what opened the hole', async () => {
    // The trap in the guard above, and the reason it is not a bare "was I whole?"
    // test. A device that WAS contiguous can acquire an interior hole from the very
    // page it is reacting to: holding an old prefix of a topic that has since grown
    // by more than one page, its forward resume returns the NEWEST page, which does
    // not join on. `historyWholeAtResume` is true — it was true, before the page —
    // so a guard without the cursor term would refuse the walk and defer the hole to
    // the next open.
    //
    // MUTATION-PROVED: drop the `historyGap <= this.resumeCursor + 1` term from
    // `WebChatSession`'s gap handler, so the guard is `historyWholeAtResume` alone,
    // and the store is left holding the prefix plus the newest page with the middle
    // missing.
    const { session, sockets, store } = setup()
    const total = PAGE * 5
    for (const seq of [1, 2, 3]) {
      await store.upsert({
        topic_id: TOPIC,
        // The SERVER's ids, because this device really did receive these rows from
        // this topic — seeding a private id would make the re-delivery a second row
        // and the assertion would fail on duplicates rather than on the property.
        client_msg_id: '',
        message_id: `m${seq}`,
        seq,
        role: 'agent',
        body: `msg-${seq}`,
        project_id: null,
        attachments: null,
        created_at: seq,
        status: 'acked',
      })
    }
    // Contiguous down to 1 at resume time — the precondition the guard keys on.
    expect(await store.contiguousFloorSeq(TOPIC)).toBe(1)

    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    await pump(sockets[0]!, total)

    // It DID walk, on THIS open, and the walk reached below the forward page's floor
    // rather than stopping at it. (The round budget still bounds one open, so the
    // oldest slice is left for the next one — that is the pre-existing convergence
    // contract, not this guard.)
    expect(sockets[0]!.backwards().length).toBeGreaterThan(0)
    const afterFirst = await seqsIn(store)
    expect(afterFirst.length).toBeGreaterThan(3 + PAGE)
    expect(afterFirst).toContain(total - PAGE * 3)

    // And it converges: a second open closes the remainder, which is only possible
    // because the store-side contiguity test sees the hole.
    sockets.at(-1)!.fireClose()
    session.setActive(false)
    session.setActive(true)
    const next = sockets.at(-1)!
    next.open()
    next.deliver({ v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 })
    await tick()
    await pump(next, total)
    expect(await seqsIn(store)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  })
})
