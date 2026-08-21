/**
 * ISSUES #557 — chat observability at the adapter chokepoint.
 *
 * THE DEFECT THESE PIN: message receipt was never logged. When the newest user
 * message in `app_chat_messages` stopped advancing, the server could not tell
 * "the message never arrived" from "the message arrived and was collapsed by
 * the `client_msg_id` idempotency check in persistence/app-chat-store.ts" —
 * two problems with completely different fixes. The absence of a log line
 * carried no information, so the only two hypotheses were indistinguishable.
 *
 * Every assertion here is on the EMITTED LINE captured off the logger's real
 * console sink, not on a spy proving a function was called: a logger that runs
 * but whose output never reaches the journal is the same class of defect.
 *
 * PRIVACY: message bodies never appear in a log line. `BODY` below is a
 * nonsense marker precisely so the "no body in the journal" assertion is a
 * real search rather than a coincidence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { AppWsAdapter } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'

const CHANNEL_TOPIC = 'app:owner'
const BODY = 'qqzx-marker-body'

let tmp: string
let db: ProjectDb
let lines: string[]
let originalLog: typeof console.log
let originalWarn: typeof console.warn

/** Lines the `[app-ws]` subsystem emitted, in order. */
function appWsLines(): string[] {
  return lines.filter((l) => l.startsWith('[app-ws] '))
}

/** The single `[app-ws]` line for `event=<name>`; throws when it is absent or
 *  ambiguous, so a missing line fails loudly instead of matching `undefined`. */
function soleLine(event: string): string {
  const found = appWsLines().filter((l) => l.startsWith(`[app-ws] event=${event} `))
  if (found.length !== 1) {
    throw new Error(`expected exactly 1 '${event}' line, got ${found.length}: ${found.join(' | ')}`)
  }
  return found[0] as string
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-obs-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  lines = []
  originalLog = console.log
  originalWarn = console.warn
  // The logger's default sink routes info→console.log and warn→console.warn.
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
  console.warn = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
})

afterEach(() => {
  console.log = originalLog
  console.warn = originalWarn
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface SetupOpts {
  /** Durable log wired? Absent → the legacy in-memory-only echo path. */
  durable?: boolean
  /** Receiver behaviour — throw to exercise `turn_failed`. */
  receive?: () => Promise<void>
  /** Clock; an advancing one proves the turn duration is measured, not zeroed. */
  now?: () => number
}

function setup(opts: SetupOpts = {}) {
  const registry = new InMemoryAppWsSessionRegistry()
  registry.register(CHANNEL_TOPIC, () => {})
  let n = 0
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: opts.receive ?? (async () => {}) },
    generate_message_id: () => `msg-${++n}`,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.durable !== false ? { chat_log: new AppChatStore({ db }) } : {}),
  })
  return adapter
}

describe('message_received — the line that makes an inbound message visible', () => {
  it('logs topic, seq, client_msg_id and was_new=true for a fresh message', async () => {
    const adapter = setup()
    await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'owner',
      body: BODY,
      client_msg_id: 'c-1',
      transport: 'ws',
    })
    expect(soleLine('message_received')).toBe(
      '[app-ws] event=message_received topic=app:owner transport=ws seq=1 client_msg_id=c-1 was_new=true',
    )
  })

  /**
   * THE TEST THAT WOULD HAVE ANSWERED THE QUESTION. A repeated
   * `client_msg_id` writes NOTHING (`{was_new:false}`) — before this line the
   * event left no trace at all, which is exactly why "his message never
   * arrived" could not be ruled out.
   */
  it('logs a DEDUPED re-send with was_new=false and the SAME seq', async () => {
    const adapter = setup()
    const input = {
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'owner',
      body: BODY,
      client_msg_id: 'c-dup',
      transport: 'ws' as const,
    }
    await adapter.ingestUserMessage(input)
    const first = appWsLines().length
    await adapter.ingestUserMessage(input)

    const received = appWsLines().filter((l) => l.startsWith('[app-ws] event=message_received '))
    expect(received.length).toBe(2)
    expect(received[0]).toContain(' was_new=true')
    // The collapsed write still logs — same topic, same seq, was_new=false.
    expect(received[1]).toBe(
      '[app-ws] event=message_received topic=app:owner transport=ws seq=1 client_msg_id=c-dup was_new=false',
    )
    expect(appWsLines().length).toBeGreaterThan(first)
  })

  it('logs on the no-durable-log path too, with seq=- rather than a silent gap', async () => {
    const adapter = setup({ durable: false })
    await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'owner',
      body: BODY,
      client_msg_id: 'c-1',
      transport: 'http',
    })
    expect(soleLine('message_received')).toBe(
      '[app-ws] event=message_received topic=app:owner transport=http seq=- client_msg_id=c-1 was_new=true',
    )
  })

  it('renders an absent client_msg_id as `-` so the key is always greppable', async () => {
    const adapter = setup()
    await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'owner',
      body: BODY,
    })
    expect(soleLine('message_received')).toContain(' client_msg_id=- ')
  })

  it('never puts the message body in the journal', async () => {
    const adapter = setup()
    await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'owner',
      body: BODY,
      client_msg_id: 'c-1',
      transport: 'ws',
    })
    await adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: CHANNEL_TOPIC,
      body: BODY,
      session_id: 'dev-1',
    })
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(BODY)
  })
})

describe('turn lifecycle — dispatched → completed / failed, with a duration', () => {
  it('logs turn_dispatched then turn_completed carrying the SAME turn id', async () => {
    const adapter = setup()
    await adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: CHANNEL_TOPIC,
      body: BODY,
      event_id: 'app-ws:turn-1',
      session_id: 'dev-1',
    })
    expect(soleLine('turn_dispatched')).toBe(
      '[app-ws] event=turn_dispatched topic=app:owner session=dev-1 turn=app-ws:turn-1',
    )
    expect(soleLine('turn_completed')).toMatch(
      /^\[app-ws\] event=turn_completed topic=app:owner session=dev-1 turn=app-ws:turn-1 ms=\d+$/,
    )
  })

  /**
   * A SLOW turn must read as slow rather than as a dead one — that distinction
   * is the whole point of stamping a duration. The clock advances 1_500ms
   * across the receiver, so a hard-coded / never-measured `ms` cannot pass.
   */
  it('measures the real elapsed time of the turn', async () => {
    let t = 10_000
    const adapter = setup({
      now: () => t,
      receive: async () => { t += 1_500 },
    })
    await adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: CHANNEL_TOPIC,
      body: BODY,
      event_id: 'app-ws:slow',
      session_id: 'dev-1',
    })
    expect(soleLine('turn_completed')).toContain(' ms=1500')
  })

  it('logs turn_failed with a duration and the error, and still rethrows', async () => {
    let t = 10_000
    const adapter = setup({
      now: () => t,
      receive: async () => { t += 40; throw new Error('receiver exploded') },
    })
    await expect(
      adapter.dispatchInbound({
        user_id: 'owner',
        channel_topic_id: CHANNEL_TOPIC,
        body: BODY,
        event_id: 'app-ws:boom',
        session_id: 'dev-1',
      }),
    ).rejects.toThrow('receiver exploded')
    expect(soleLine('turn_failed')).toBe(
      '[app-ws] event=turn_failed topic=app:owner session=dev-1 turn=app-ws:boom ms=40 error="receiver exploded"',
    )
    // A failed turn must NOT also claim completion.
    expect(appWsLines().some((l) => l.startsWith('[app-ws] event=turn_completed '))).toBe(false)
  })

  it('renders an absent session id as `-` rather than omitting the key', async () => {
    const adapter = setup()
    await adapter.dispatchInbound({
      user_id: 'owner',
      channel_topic_id: CHANNEL_TOPIC,
      body: BODY,
      event_id: 'app-ws:turn-2',
    })
    expect(soleLine('turn_dispatched')).toContain(' session=- ')
  })
})
