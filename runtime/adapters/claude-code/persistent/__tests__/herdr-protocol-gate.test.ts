/**
 * herdr-protocol-gate.test.ts — the client refuses a server whose protocol is not
 * the one it was measured against.
 *
 * WHY THIS IS A GUARD AND NOT A WARNING. herdr's socket server does NO version
 * check of its own — only its CLI guards — and the protocol moved 20 → 22 in 19
 * days. So a server that has moved on accepts our requests and answers them with
 * whatever semantics it now has, underneath a REPL supervisor that has no way to
 * notice. There is no degraded mode worth having here: the failure has to be loud
 * and at connect time.
 *
 * "What input would a wrong implementation get right?" — A client with NO check at
 * all connects perfectly against a matching server. So the matching case proves
 * nothing on its own, and the MISMATCH case is the criterion. Both are asserted,
 * and the mismatch is asserted in both directions (a higher AND a lower protocol),
 * because a check written as `>=` would pass one and fail the other.
 *
 * These tests drive the real framing too: the fake transport speaks
 * newline-delimited JSON, so a client that mis-framed a request would never get a
 * pong at all.
 */

import { describe, expect, it } from 'bun:test'
import { connectHerdr, HerdrClient, HERDR_SOCKET_ENV } from '../herdr-client.ts'

/** Feed text to the client as BYTES. `onBytes` takes bytes on purpose — the encode
 *  is explicit here so no test can accidentally hand it a pre-decoded string, which
 *  is the shape that hid the split-character defect. */
const feed = (c: HerdrClient, text: string): void => void c.onBytes(Buffer.from(text, 'utf8'))
import {
  HERDR_MAX_FRAME_BYTES,
  HERDR_POLL_INTERVAL_MS,
  HERDR_PROTOCOL_VERSION,
  HERDR_RPC_TIMEOUT_MS,
} from '../herdr-protocol.ts'

/**
 * A transport that speaks the real wire format. `reply` decides what comes back
 * for each parsed request, so a test can script a pong at any protocol.
 */
function fakeTransport(
  reply: (req: { id: string; method: string }) => unknown,
  /** Bytes the socket ACCEPTS for a given frame. Defaults to all of them — but it is
   *  a FUNCTION, not a hardcoded `d.length`, because a transport that silently takes
   *  fewer bytes than offered is a real failure mode and a fake that can only ever
   *  return the full count makes it structurally unreachable in tests. */
  accepts: (d: string) => number = (d) => Buffer.byteLength(d, 'utf8'),
): { connect: (path: string, client: HerdrClient) => Promise<{ write(d: string): number; end(): void }>; wrote: string[] } {
  const wrote: string[] = []
  return {
    wrote,
    connect: async (_path, client) => ({
      write(d: string) {
        wrote.push(d)
        const taken = accepts(d)
        if (taken < Buffer.byteLength(d, 'utf8')) return taken
        for (const line of d.split('\n')) {
          if (line.trim() === '') continue
          const req = JSON.parse(line) as { id: string; method: string }
          const out = reply(req)
          if (out !== undefined) {
            // Answer on a later turn of the event loop, as a socket would.
            queueMicrotask(() => feed(client, `${JSON.stringify(out)}\n`))
          }
        }
        return Buffer.byteLength(d, 'utf8')
      },
      end() {},
    }),
  }
}

const pongAt = (protocol: number) => (req: { id: string; method: string }) =>
  req.method === 'ping'
    ? { id: req.id, result: { type: 'pong', version: '0.8.2', protocol } }
    : { id: req.id, result: { type: 'ok' } }

describe('herdr protocol gate', () => {
  it('connects when the server reports the protocol this client was measured against', async () => {
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION))
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    expect(client.serverProtocol).toBe(HERDR_PROTOCOL_VERSION)
    expect(client.serverVersion).toBe('0.8.2')
    // The ping really went over the wire, correctly framed.
    expect(t.wrote.join('')).toContain('"method":"ping"')
    expect(t.wrote.every((w) => w.endsWith('\n'))).toBe(true)
    client.close()
  })

  it('REFUSES a HIGHER protocol, naming both numbers', async () => {
    const ahead = HERDR_PROTOCOL_VERSION + 2
    const t = fakeTransport(pongAt(ahead))
    const err = await connectHerdr({ socketPath: '/fake', connect: t.connect }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    // The actionable fact is the DELTA, so both numbers have to appear.
    expect(err!.message).toContain(String(ahead))
    expect(err!.message).toContain(String(HERDR_PROTOCOL_VERSION))
    expect(err!.message).toContain('protocol mismatch')
  })

  it('REFUSES a LOWER protocol too — this is equality, not a floor', async () => {
    // A gate written as `server >= expected` would let this through. An older
    // server is just as unverified as a newer one: the semantics we measured are
    // the ones at OUR number.
    const behind = HERDR_PROTOCOL_VERSION - 1
    const t = fakeTransport(pongAt(behind))
    const err = await connectHerdr({ socketPath: '/fake', connect: t.connect }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('protocol mismatch')
    expect(err!.message).toContain(String(behind))
  })

  it('does NOT degrade or warn — the connection is closed, not handed back', async () => {
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION + 1))
    let handed: unknown
    try {
      handed = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    } catch {
      handed = undefined
    }
    // Nothing usable escapes the gate. A "warn and continue" implementation would
    // return a live client here, and every test above would still pass.
    expect(handed).toBeUndefined()
  })

  it('refuses a pong with no protocol field rather than assuming a match', async () => {
    const t = fakeTransport((req) =>
      req.method === 'ping' ? { id: req.id, result: { type: 'pong', version: '0.8.2' } } : undefined,
    )
    const err = await connectHerdr({ socketPath: '/fake', connect: t.connect }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('ping returned no version/protocol')
  })

  it('refuses when there is no socket path at all, naming the env var', async () => {
    const saved = process.env[HERDR_SOCKET_ENV]
    delete process.env[HERDR_SOCKET_ENV]
    try {
      const err = await connectHerdr({}).then(
        () => undefined,
        (e: unknown) => e as Error,
      )
      expect(err).toBeDefined()
      expect(err!.message).toContain(HERDR_SOCKET_ENV)
    } finally {
      if (saved !== undefined) process.env[HERDR_SOCKET_ENV] = saved
    }
  })

  it('the version this client pins is the one measured on the live server', () => {
    // Pinned as a VALUE, not just as "some number": the whole point of the gate is
    // that this constant and the measurement that produced it move together.
    expect(HERDR_PROTOCOL_VERSION).toBe(20)
  })
})

describe('herdr client framing', () => {
  it('an error reply whose id matches nothing fails the pending request instead of hanging', async () => {
    // MEASURED: an unparseable request comes back with `id: ""`, so the server
    // cannot say which request failed. A client that dropped such a reply would
    // wait forever — and "forever" is exactly what a protocol bump produces.
    const t = fakeTransport((req) =>
      req.method === 'ping'
        ? { id: req.id, result: { type: 'pong', version: '0.8.2', protocol: HERDR_PROTOCOL_VERSION } }
        : { id: '', error: { code: 'invalid_request', message: 'unknown variant' } },
    )
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    const err = await client.call('pane.read', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('invalid_request')
    client.close()
  })

  it('a ZERO-byte write is a terminal transport failure, not a hang', async () => {
    // THE DEFECT. `call()` discarded the byte count, so a socket that accepted
    // nothing left a pending promise whose request never reached the server — a
    // HANG, not an error. It is the one "the channel is not working" shape
    // `transport-lost` did not cover: the socket is open, nothing threw, nothing
    // closed; the bytes simply did not all go.
    let firstDone = false
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION), (d) => {
      // Let the handshake through, then accept nothing.
      if (!firstDone) {
        firstDone = true
        return Buffer.byteLength(d, 'utf8')
      }
      return 0
    })
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    const err = await client.call('pane.read', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('short write')
    expect(err!.message).toContain('accepted 0 of')
    // And the CONNECTION is terminal, which is what reaches the host as
    // `'transport-lost'` rather than as a silent stall.
    expect(client.isClosed()).toBe(true)
  })

  it('a PARTIAL write is terminal too, and fails every other in-flight request', async () => {
    let n = 0
    const t = fakeTransport(
      (req) =>
        req.method === 'ping'
          ? { id: req.id, result: { type: 'pong', version: '0.8.2', protocol: HERDR_PROTOCOL_VERSION } }
          : undefined, // later calls are never answered — the point is they must not hang
      (d) => {
        n += 1
        if (n === 1) return Buffer.byteLength(d, 'utf8') // the ping
        if (n === 2) return Buffer.byteLength(d, 'utf8') // a call left in flight
        return 3 // half a frame
      },
    )
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    const inFlight = client.call('pane.get', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    const short = await client.call('pane.read', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(short!.message).toContain('short write')
    expect(short!.message).toContain('accepted 3 of')
    // The other request cannot be answered either — the transport is gone.
    expect(await inFlight).toBeDefined()
    expect(client.isClosed()).toBe(true)
  })

  it('a short write of a NON-ASCII frame is still caught — bytes, not string units', async () => {
    // The check must compare BYTES. `String.length` is smaller than the byte count
    // for any non-ASCII frame, so comparing against it is too LAX: accept more bytes
    // than there are code units and a genuine short write reads as complete. This
    // case sits in exactly that gap — accepted > frame.length, accepted < byteLength.
    let armed = false
    let gap = { units: 0, bytes: 0, accepted: 0 }
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION), (d) => {
      const bytes = Buffer.byteLength(d, 'utf8')
      if (!armed) return bytes // the handshake
      const accepted = d.length + 1 // > UTF-16 units, still < bytes
      gap = { units: d.length, bytes, accepted }
      return accepted
    })
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    armed = true
    const err = await client
      .call('pane.send_text', { pane_id: 'x', text: '→→→ ünïcødé ✓✓✓ 日本語テキスト' })
      .then(() => undefined, (e: unknown) => e as Error)
    // The frame really does sit in the gap, or the test proves nothing.
    expect(gap.accepted).toBeGreaterThan(gap.units)
    expect(gap.accepted).toBeLessThan(gap.bytes)
    expect(err).toBeDefined()
    expect(err!.message).toContain('short write')
    expect(client.isClosed()).toBe(true)
  })

  it('CONTROL — a full write is not mistaken for a short one, including non-ASCII', async () => {
    // The comparison is against BYTE length. A frame carrying non-ASCII has more
    // bytes than `String.length` UTF-16 units, so comparing to `.length` would read
    // a perfectly good write as short and kill a healthy connection.
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION))
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect })
    const r = await client.call('pane.send_text', { pane_id: 'x', text: '→ ünïcødé ✓' })
    expect(r).toEqual({ type: 'ok' })
    expect(client.isClosed()).toBe(false)
    // The frame really did contain more bytes than string units.
    const frame = t.wrote[t.wrote.length - 1]!
    expect(Buffer.byteLength(frame, 'utf8')).toBeGreaterThan(frame.length)
    client.close()
  })

  it('a MALFORMED frame is terminal — later calls are refused, not sent', async () => {
    // THE DEFECT. The parse-failure branch said the stream position was
    // untrustworthy, rejected the pending calls, and left `closed === false` — so
    // the NEXT rpc went out over the very stream it had just declared unusable.
    // Same shape as the short write: the code knows the channel is broken and keeps
    // using it. Both halves are asserted, because rejecting the pending call alone
    // was already true before the fix.
    const client = new HerdrClient()
    const sent: string[] = []
    client.attach({
      write: (d) => {
        sent.push(d)
        return Buffer.byteLength(d, 'utf8')
      },
      end: () => {},
    })
    const pendingCall = client.call('pane.read', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    const sentBefore = sent.length

    feed(client, '{bad-json}\n')

    // Half one: the in-flight call fails rather than hanging.
    const err = await pendingCall
    expect(err).toBeDefined()
    expect(err!.message).toContain('unparseable frame')
    // Half two — the one that was missing: the connection is now CLOSED, so a later
    // call is refused instead of being written onto an unusable stream.
    expect(client.isClosed()).toBe(true)
    const later = await client.call('pane.get', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(later).toBeDefined()
    expect(later!.message).toContain('closed connection')
    expect(sent.length).toBe(sentBefore) // nothing more went over the wire
  })

  it('CONTROL — a WELL-FORMED frame leaves the connection usable', async () => {
    // Otherwise a client that closed on every inbound frame would pass the above.
    const client = new HerdrClient()
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const first = client.call('ping', {})
    feed(client, '{"id":"n1","result":{"type":"pong"}}\n')
    expect(await first).toEqual({ type: 'pong' })
    expect(client.isClosed()).toBe(false)
    const second = client.call('pane.get', {})
    feed(client, '{"id":"n2","result":{"type":"ok"}}\n')
    expect(await second).toEqual({ type: 'ok' })
    client.close()
  })

  // ── Teardown is an ACTION, not a flag ────────────────────────────────────────
  // `isClosed()` is the SYMPTOM of teardown. Asserting it cannot distinguish a
  // teardown from a relabelling — which is exactly how two routes shipped that
  // marked the client closed and left the socket open. So these observe `end`.

  /** A client with an OBSERVABLE `end`, so "the socket was ended" is assertable. */
  function observable(accepts: (d: string) => number = (d) => Buffer.byteLength(d, 'utf8')) {
    const client = new HerdrClient()
    let ends = 0
    client.attach({
      write: (d) => accepts(d),
      end: () => {
        ends += 1
      },
    })
    return { client, ends: () => ends }
  }

  it('a MALFORMED frame ends the socket exactly once', async () => {
    const { client, ends } = observable()
    const a = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    const b = client.call('pane.get', {}).then(() => undefined, (e: unknown) => e as Error)
    feed(client, '{bad-json}\n')
    expect(await a).toBeDefined()
    expect(await b).toBeDefined() // EVERY pending request, not just one
    expect(client.isClosed()).toBe(true)
    expect(ends()).toBe(1)
    // Idempotent: a later close, or a peer close, does not end it twice.
    client.close()
    client.onClose()
    expect(ends()).toBe(1)
  })

  it('a SHORT write ends the socket once, and settles OTHER in-flight requests', async () => {
    // The first call must go out INTACT so there is a genuine in-flight request to
    // strand; only then does the socket start accepting nothing.
    let armed = false
    const { client, ends } = observable((d) => (armed ? 0 : Buffer.byteLength(d, 'utf8')))
    const other = client.call('pane.get', {}).then(() => undefined, (e: unknown) => e as Error)
    armed = true
    const short = await client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    expect(short).toBeDefined()
    expect(short!.message).toContain('short write')
    // The earlier, unanswered request settles too — it used to hang.
    expect(await other).toBeDefined()
    expect(client.isClosed()).toBe(true)
    expect(ends()).toBe(1)
  })

  it('a THROWN write ends the socket once, and settles OTHER in-flight requests', async () => {
    // THE THIRD ROUTE, previously unhandled: it rejected only the new request, left
    // the client open, and left earlier requests hanging forever.
    let armed = false
    const { client, ends } = observable((d) => {
      if (armed) throw new Error('ENOTCONN')
      return Buffer.byteLength(d, 'utf8')
    })
    const a = client.call('pane.get', {}).then(() => undefined, (e: unknown) => e as Error)
    armed = true
    const b = await client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    expect(b).toBeDefined()
    expect(b!.message).toContain('write threw')
    expect(b!.message).toContain('ENOTCONN')
    // A, issued BEFORE the throw and never answered, must settle — it used to hang.
    expect(await a).toBeDefined()
    expect(client.isClosed()).toBe(true)
    expect(ends()).toBe(1)
  })

  it('CONTROL — a healthy exchange ends the socket ZERO times', async () => {
    // Otherwise a teardown that fired on every frame, or on every call, would pass
    // all three cases above.
    const { client, ends } = observable()
    const p = client.call('ping', {})
    feed(client, '{"id":"n1","result":{"type":"pong"}}\n')
    expect(await p).toEqual({ type: 'pong' })
    expect(ends()).toBe(0)
    expect(client.isClosed()).toBe(false)
    client.close()
    expect(ends()).toBe(1)
  })

  // ── The route where NOTHING goes wrong ───────────────────────────────────────
  // Zero writes, partial writes, thrown writes, malformed replies and closed sockets
  // all produce something to react to. A socket that accepts the whole frame and
  // never answers produces nothing at all — no error, no close, no event — and left
  // an unbounded pending promise. A channel can be unusable without anything about it
  // being false, so liveness needs a clock, not a predicate.

  it('an UNANSWERED rpc tears the transport down instead of hanging forever', async () => {
    const client = new HerdrClient(30)
    let ends = 0
    // Accepts every byte; never calls onBytes or onClose. Nothing is "wrong".
    client.attach({
      write: (d) => Buffer.byteLength(d, 'utf8'),
      end: () => {
        ends += 1
      },
    })
    const err = await client.call('pane.read', { pane_id: 'x' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('went unanswered')
    expect(err!.message).toContain('30ms')
    // Through the SAME teardown as every other route: socket ended, flag flipped.
    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
  })

  it('THE HANDSHAKE cannot wedge — a server that never answers ping fails connect', async () => {
    // The worse of the two: `connectHerdr`'s ping is mandatory, so an unbounded wait
    // there means the gateway never finishes starting and there is nothing to read.
    const t = fakeTransport(() => undefined) // accepts the write, never replies
    const err = await connectHerdr({ socketPath: '/fake', connect: t.connect, rpcTimeoutMs: 30 }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain('went unanswered')
    expect(err!.message).toContain("'ping'")
  })

  it('a REPLY cancels the clock — a healthy connection is never torn down', async () => {
    // The other direction: the timeout must not fire on a connection that answered.
    // With a 30ms bound and a 120ms wait, a clock that was not cleared would fire.
    const t = fakeTransport(pongAt(HERDR_PROTOCOL_VERSION))
    const client = await connectHerdr({ socketPath: '/fake', connect: t.connect, rpcTimeoutMs: 30 })
    expect(await client.call('pane.get', { pane_id: 'x' })).toEqual({ type: 'ok' })
    await Bun.sleep(120)
    expect(client.isClosed()).toBe(false)
    // And it still works afterwards.
    expect(await client.call('pane.read', { pane_id: 'x' })).toEqual({ type: 'ok' })
    client.close()
  })

  it('the default bound is pinned, and sits well above the poll cadence', () => {
    expect(HERDR_RPC_TIMEOUT_MS).toBe(10_000)
    // Far above any call this client makes, far below forever.
    expect(HERDR_RPC_TIMEOUT_MS).toBeGreaterThan(HERDR_POLL_INTERVAL_MS * 4)
  })

  // ── WELL-FORMED IS NOT VALID ─────────────────────────────────────────────────
  // The teardown was built for "the parser threw". Everything `JSON.parse` ACCEPTS and
  // the protocol forbids sat outside that category: `null` threw out of `onBytes` on
  // the first property read, and `[]`/`{}` parsed, answered nothing, and were silently
  // ignored — worse than the throw, because nothing notices.

  for (const [label, frame] of [
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an EMPTY OBJECT — parses, is an object, answers nothing', '{}'],
    ['a bare number', '42'],
    ['a bare string', '"hello"'],
    ['a bare boolean', 'true'],
    ['an object with an id but no outcome', '{"id":"n1"}'],
    ['an object with an outcome but no id', '{"result":{"type":"ok"}}'],
    ['an object with a non-string event', '{"event":7,"data":{}}'],
    // `data` IS PART OF THE ENVELOPE, and each of these four is a DIFFERENT way to
    // not be an object — listed individually because they take four different
    // branches (`in`/`undefined`, `typeof null === 'object'`, `Array.isArray`, a
    // primitive `typeof`), so a partial check passes for some and fails for others.
    // Each was previously coerced to `{}`: the frame validated, handlers ran with an
    // empty object, and `pane_exited`'s `pane_id` comparison failed — the exit
    // SILENTLY DROPPED. The `pane_exited` name is deliberate: this is the event whose
    // loss actually costs something.
    ['an event whose data is ABSENT', '{"event":"pane_exited"}'],
    ['an event whose data is null', '{"event":"pane_exited","data":null}'],
    ['an event whose data is an array', '{"event":"pane_exited","data":[]}'],
    ['an event whose data is a bare string', '{"event":"pane_exited","data":"w1:p1"}'],
    ['an event whose data is a bare number', '{"event":"pane_exited","data":0}'],
    // THE REPLY OUTCOME, the same requirement on the other envelope. Presence of the
    // key was the whole check, so a WRONG-TYPED outcome slipped through and then lost
    // its identity in the dispatcher: `asObject('refused')` is `undefined`, the error
    // branch was skipped, and the call RESOLVED with `{}`. A `pane.close` the server
    // refused, reported to `kill()` as acknowledged.
    ['a reply whose error is a bare string', '{"id":"n1","error":"refused"}'],
    ['a reply whose error is null', '{"id":"n1","error":null}'],
    ['a reply whose error is an array', '{"id":"n1","error":[]}'],
    ['a reply whose error is a bare number', '{"id":"n1","error":7}'],
    ['a reply whose result is a bare string', '{"id":"n1","result":"ok"}'],
    ['a reply whose result is null', '{"id":"n1","result":null}'],
    ['a reply whose result is an array', '{"id":"n1","result":[]}'],
    ['a reply whose result is a bare boolean', '{"id":"n1","result":true}'],
    // BOTH outcomes. Not harmlessly redundant: it means we cannot tell whether the
    // call succeeded, which is the single thing the caller asked.
    ['a reply carrying BOTH result and error', '{"id":"n1","result":{},"error":{"code":"x"}}'],
  ] as [string, string][]) {
    it(`a frame of ${label} tears the transport down, and never throws`, async () => {
      // The RPC clock is set far out ON PURPOSE. With a short one, a client that
      // simply IGNORED the bad frame would still be torn down — by the timeout,
      // seconds later — and this test would pass without the validation existing.
      // (It did: mutation M53 survived until this bound was raised.) A long clock
      // plus a SYNCHRONOUS assertion means only the envelope check can satisfy it.
      const client = new HerdrClient(60_000)
      let ends = 0
      client.attach({
        write: (d) => Buffer.byteLength(d, 'utf8'),
        end: () => {
          ends += 1
        },
      })
      const pending = client.call('pane.read', {}).then(
        () => undefined,
        (e: unknown) => e as Error,
      )
      // Must not throw out of onBytes — that is how `null` bypassed teardown.
      expect(() => feed(client, `${frame}\n`)).not.toThrow()
      // IMMEDIATELY, on the same tick as the frame: no timer has had a chance to run.
      expect(client.isClosed()).toBe(true)
      expect(ends).toBe(1)
      const err = await pending
      expect(err).toBeDefined()
      expect(err!.message).toMatch(/no known envelope|unparseable/)
    })
  }

  it('a CLOSED client accepts nothing — a post-close frame never reaches a handler', async () => {
    // THE FOURTH VARIANT of one rule: once a terminal state is settled, no later path
    // may rewrite it — here enforced at the TRANSPORT EDGE rather than in the host's
    // bookkeeping. `onBytes` buffered and dispatched unconditionally, so bytes arriving
    // after `close()` still parsed and still invoked subscription handlers. The event
    // that matters is exactly this one: the host's `pane_exited` handler calls
    // `settleExit`, so a post-close frame could RE-OPEN the question the close settled.
    const client = new HerdrClient(60_000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const seen: Record<string, unknown>[] = []
    const sub = client.subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
      seen.push(d)
    })
    feed(client, '{"id":"n1","result":{"type":"ok"}}\n')
    await sub

    // CONTROL FIRST, on the same client and the same bytes: while OPEN the frame is
    // delivered. Without this, the assertion below passes for a frame that was simply
    // malformed, or a handler that was never wired.
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:live"}}\n')
    expect(seen).toEqual([{ pane_id: 'w1:live' }])

    client.close()
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:ghost"}}\n')
    // Unchanged — the identical frame shape that WAS delivered a moment ago is now
    // refused, so the difference is the close and nothing else.
    expect(seen).toEqual([{ pane_id: 'w1:live' }])
  })

  it('a CLOSED client accumulates nothing — the buffer teardown released stays released', async () => {
    // Teardown's other job. It empties `this.bytes` because that buffer may hold up to
    // `maxFrameBytes`; with no guard, chunks arriving afterwards simply started
    // accumulating again — the released buffer grew back, bounded by nothing and read
    // by no one.
    const client = new HerdrClient(60_000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })

    // CONTROL: while OPEN, an unterminated chunk really does accumulate — otherwise
    // "zero after close" is satisfied by a buffer that never fills at all.
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:p1"}')
    expect(client.bufferedBytes()).toBeGreaterThan(0)

    client.close()
    expect(client.bufferedBytes()).toBe(0) // teardown released it
    for (let i = 0; i < 50; i++) feed(client, 'x'.repeat(1000))
    // Fifty thousand bytes offered, none retained.
    expect(client.bufferedBytes()).toBe(0)
  })

  it('a re-entrant call from a rejection handler is refused, not half-served', async () => {
    // WHAT THIS DOES *NOT* PIN, stated because the distinction cost a mutation to
    // find: it does not pin the ORDER of `closed = true` against `failAll`. I wrote it
    // believing it did, and the faithful mutation — MOVING that line below `failAll`
    // rather than deleting it — SURVIVES. The reason is that `failAll` only calls
    // `p.reject()`, and a rejection handler runs as a microtask, so it cannot execute
    // inside `failAll`; every caller observes the flag after `teardown` has returned,
    // under either ordering. The ordering is unobservable through the promise API and
    // therefore not a criterion. Asserting it here would have been a test that passes
    // for both implementations.
    //
    // What it DOES pin, which is real: caller code re-entering the client from a
    // rejection handler is refused rather than handed a half-torn-down connection.
    const client = new HerdrClient(60_000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    let observedClosed: boolean | undefined
    let reentrantRejected: string | undefined
    const pending = client.call('pane.read', {}).catch(async () => {
      // Inside the rejection handler `failAll` is running RIGHT NOW.
      observedClosed = client.isClosed()
      await client.call('pane.get', {}).catch((e: unknown) => {
        reentrantRejected = (e as Error).message
      })
    })
    client.close()
    await pending
    expect(observedClosed).toBe(true)
    expect(reentrantRejected).toContain('closed connection')
  })

  it('a REFUSED subscribe leaves no handler behind', async () => {
    // Registering before the ack is deliberate — an event can arrive between the
    // request and its acknowledgement, and the host subscribes to `pane_exited`
    // precisely so an exit DURING STARTUP is still seen. But a rejected subscribe
    // returns no unsubscribe function, so the caller cannot remove the handler and
    // believes it was never subscribed: a handler nobody can reach that the dispatcher
    // still calls.
    const client = new HerdrClient(60_000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const seen: Record<string, unknown>[] = []
    const sub = client
      .subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
        seen.push(d)
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      )
    // The server REFUSES the subscription.
    feed(client, '{"id":"n1","error":{"code":"invalid_request","message":"no"}}\n')
    expect(await sub).toBeDefined()
    expect(client.isClosed()).toBe(false) // a refused subscribe is not a transport failure
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:p1"}}\n')
    expect(seen).toEqual([])
  })

  it('CONTROL — an ACCEPTED subscribe does receive events', async () => {
    // Without this, "leaves no handler behind" is satisfied by never registering one.
    const client = new HerdrClient(60_000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const seen: Record<string, unknown>[] = []
    const sub = client.subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
      seen.push(d)
    })
    feed(client, '{"id":"n1","result":{"type":"ok"}}\n')
    await sub
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:p1"}}\n')
    expect(seen).toEqual([{ pane_id: 'w1:p1' }])
  })

  it('FRAGMENTED input is linear, not quadratic — the cap bounds bytes, not work', async () => {
    // A LIMIT ON HOW MUCH YOU KEEP IS NOT A LIMIT ON HOW MUCH YOU DO. Every chunk used
    // to copy the whole accumulation through `Buffer.concat`, so cost was quadratic in
    // the NUMBER of deliveries while the byte cap — which only bounds retention —
    // looked like it covered the hostile case. Against the 8 MiB cap, one-byte
    // deliveries force on the order of 35 TB of cumulative copying before teardown.
    //
    // The existing 64-byte boundary case cannot see this: it feeds one chunk, so the
    // quadratic term never appears. What distinguishes the implementations is the
    // number of DELIVERIES, not the number of bytes.
    const client = new HerdrClient(60_000, 4 << 20) // 4 MiB cap, above the 1.6 MB fed
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })

    // 200k deliveries of 8 bytes = 1.6 MB. Quadratic cost is deliveries × total ÷ 2 ≈
    // 160 GB of copying; linear is 1.6 MB. THE LOAD WAS CHOSEN BY MEASUREMENT, not by
    // guess: on this host the queue takes 44 ms and the `Buffer.concat`-per-chunk
    // version takes 21,433 ms — a 487× separation. The 5 s bound therefore sits ~113×
    // above the passing implementation and ~4× below the failing one, so it
    // discriminates with margin at both ends rather than by luck on one machine. My
    // first attempt used a 4 s bound over 200k ONE-byte chunks, and the quadratic
    // mutant finished inside it (M94 survived) — the load, not just the bound, is what
    // makes this test able to see the defect.
    const eight = Buffer.alloc(8, 0x78)
    const started = Date.now()
    for (let i = 0; i < 200_000; i++) client.onBytes(eight)
    const elapsed = Date.now() - started

    // Still buffered, still under the cap, still open: the work was done, not skipped.
    // Without this the "fast" result is satisfied by an implementation that drops
    // input on the floor.
    expect(client.bufferedBytes()).toBe(1_600_000)
    expect(client.isClosed()).toBe(false)
    // WALL-CLOCK-BOUND-OK: the defect IS elapsed time, so no deterministic assertion
    // can replace it — quadratic and linear buffering produce byte-identical state and
    // differ only in the work done to get there, which nothing in the public surface
    // counts. MEASURED MARGIN on the reference host at 200k x 8 bytes: queue 44 ms,
    // concat-per-chunk 21,433 ms (487x). The 5,000 ms bound sits ~113x above the
    // passing implementation and ~4x below the failing one, so it tolerates a heavily
    // loaded runner without ever admitting the quadratic version.
    expect(elapsed).toBeLessThan(5000)

    // AND THE BYTES SURVIVE REASSEMBLY — on a FRESH client, because terminating the
    // 200k of junk above would (correctly) tear that one down as an unparseable frame.
    // Speed is worthless if the queue loses or reorders what it defers, so a frame
    // delivered one byte at a time must still arrive whole.
    const reassembly = new HerdrClient(60_000)
    reassembly.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const seen: Record<string, unknown>[] = []
    const sub = reassembly.subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
      seen.push(d)
    })
    feed(reassembly, '{"id":"n1","result":{"type":"ok"}}\n')
    await sub
    const frame = '{"event":"pane_exited","data":{"pane_id":"w1:p1"}}\n'
    for (const ch of frame) reassembly.onBytes(Buffer.from(ch, 'utf8'))
    expect(seen).toEqual([{ pane_id: 'w1:p1' }])
    expect(reassembly.bufferedBytes()).toBe(0)
    expect(reassembly.isClosed()).toBe(false)
  })

  it('retention tracks CURRENT NEED, not the size of the largest delivery', async () => {
    // THIRD QUANTITY, and the reason the shape changed rather than gaining a third
    // guard. `subarray` views pinned their parent; then a queue of fragments bounded
    // payload bytes while holding one Buffer object per fragment. Both were fixed by
    // measuring something new. A single buffer removes the quantity instead: there is
    // one allocation, so there is no fragment to retain and nothing to count.
    //
    // What remains assertable is that the one allocation does not stay at its
    // high-water mark. A 2 MB frame followed by a 1-byte remainder must not leave 2 MB
    // pinned for the life of the connection — bounded is not the same as small.
    const client = new HerdrClient(60_000, 8 << 20)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const ok = client.call('pane.get', {})
    const big = `{"id":"n1","result":{"x":"${'z'.repeat(2_000_000)}"}}\n`
    client.onBytes(Buffer.from(`${big}a`))
    expect(Object.keys(await ok)).toEqual(['x']) // the frame really was processed

    expect(client.bufferedBytes()).toBe(1) // one byte outstanding, logically
    // The allocation is proportional to what is still needed, not to the 2 MB that
    // passed through. A view would report ~2,000,030 here; a high-water buffer would
    // report ≥ 2,000,000.
    expect(client.retainedBytes()).toBeLessThan(64 * 1024)

    // ...and once fully drained it is released outright.
    client.onBytes(Buffer.from('\n'))
    expect(client.bufferedBytes()).toBe(0)
    expect(client.retainedBytes()).toBe(0)
  })

  it('the buffer GROWS when it must — retention shrinking is not the same as dropping data', async () => {
    // Without this, "retained is small" is satisfied by a buffer that never keeps
    // anything, which would lose every partial frame.
    const client = new HerdrClient(60_000, 8 << 20)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const half = 'q'.repeat(200_000)
    client.onBytes(Buffer.from(half))
    expect(client.bufferedBytes()).toBe(200_000)
    // It is HOLDING those bytes: capacity must be at least what it is storing.
    expect(client.retainedBytes()).toBeGreaterThanOrEqual(200_000)
    expect(client.isClosed()).toBe(false)
  })

  it('shrinking never discards capacity a partial frame still needs', async () => {
    // The shrink must be RIGHT-SIZING, not truncation. This is the case that separates
    // them: a 2 MB frame is consumed (so the buffer is large and mostly idle) while a
    // sizeable partial frame is still outstanding. Shrinking to a fixed small capacity
    // here would silently drop the remainder — and the earlier tests cannot see it,
    // because their leftovers are one byte and fit in any capacity.
    const client = new HerdrClient(60_000, 8 << 20)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const first = client.call('pane.get', {})
    const big = `{"id":"n1","result":{"x":"${'z'.repeat(2_000_000)}"}}\n`
    const partial = `{"id":"n2","result":{"y":"${'w'.repeat(300_000)}`
    client.onBytes(Buffer.from(big + partial))
    expect(Object.keys(await first)).toEqual(['x'])

    // The remainder is intact — every byte of it.
    expect(client.bufferedBytes()).toBe(Buffer.byteLength(partial, 'utf8'))
    const second = client.call('pane.read', {})
    client.onBytes(Buffer.from(`"}}\n`))
    const got = (await second) as { y: string }
    expect(got.y.length).toBe(300_000) // reassembled whole, not truncated
    expect(client.isClosed()).toBe(false)
  })

  it('ONE huge delivery is refused BEFORE it is allocated, not after', async () => {
    // THE CASE FRAGMENTATION NEVER COVERED. The single-buffer rewrite made absorption
    // linear, and then enforced the frame limit AFTER `append` had already doubled
    // capacity to hold the whole delivery — so the guard ran after the allocation it
    // exists to prevent. With a 64-byte cap, a 1 GiB chunk attempted a ~1 GiB
    // allocation and only then tore down.
    //
    // The other cases here are one-byte-over and fragmented accumulation; neither is
    // one huge chunk, which is why this needed its own.
    const client = new HerdrClient(60_000, 64) // 64-byte cap
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => void (ends += 1) })
    const pending = client.call('pane.read', {}).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    // 16 MiB in ONE delivery against a 64-byte cap. Kept well under a gigabyte so the
    // test cannot itself become the resource problem it is describing.
    client.onBytes(Buffer.alloc(16 * 1024 * 1024, 0x78))

    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
    // NOTHING was retained: the delivery was rejected before a byte was copied.
    expect(client.retainedBytes()).toBe(0)
    expect(client.bufferedBytes()).toBe(0)
    expect((await pending)!.message).toMatch(/no newline/)
  })

  it('a huge delivery of MANY VALID frames is accepted — the cap measures frames, not deliveries', async () => {
    // The control the rejection must not swallow. A delivery may legitimately be far
    // larger than the frame cap as long as every FRAME inside it fits; rejecting on
    // total delivery size would break ordinary batched traffic.
    const client = new HerdrClient(60_000, 4096)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const seen: Record<string, unknown>[] = []
    const sub = client.subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
      seen.push(d)
    })
    client.onBytes(Buffer.from('{"id":"n1","result":{"type":"ok"}}\n'))
    await sub

    // 20,000 small frames in ONE delivery — ~700 KB, far past the 4 KiB frame cap.
    const many = Array.from(
      { length: 20_000 },
      (_, i) => `{"event":"pane_exited","data":{"pane_id":"w1:p${i}"}}`,
    ).join('\n')
    client.onBytes(Buffer.from(`${many}\n`))

    expect(client.isClosed()).toBe(false) // not mistaken for an oversized frame
    expect(seen.length).toBe(20_000)
    expect(seen[0]).toEqual({ pane_id: 'w1:p0' })
    expect(seen.at(-1)).toEqual({ pane_id: 'w1:p19999' })
    // And none of it was retained: every frame was complete.
    expect(client.bufferedBytes()).toBe(0)
  })

  it('a frame SPANNING deliveries is still measured against the cap before allocating', async () => {
    // The boundary case between the two above: bytes already buffered count toward the
    // first frame of the next delivery. Ignoring the carry would let a peer exceed the
    // cap by splitting one oversized frame across two deliveries.
    const client = new HerdrClient(60_000, 1000)
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => void (ends += 1) })
    const pending = client.call('pane.read', {}).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    client.onBytes(Buffer.from('a'.repeat(900))) // under the cap on its own
    expect(client.isClosed()).toBe(false)
    // 900 carried + 200 more, then a newline: a 1100-byte FRAME against a 1000 cap.
    client.onBytes(Buffer.from(`${'b'.repeat(200)}\n`))
    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
    expect((await pending)!.message).toMatch(/1100 bytes exceeds/)
  })

  it('a fragmented UNTERMINATED frame still trips the cap, at the same boundary', async () => {
    // The bound must survive the rewrite: enforcing it on a running total rather than
    // on a concatenated buffer must not move where it fires. Without this pair, the
    // linearity case above is satisfied by simply deleting the bound.
    const cap = 4096
    const client = new HerdrClient(60_000, cap)
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => void (ends += 1) })
    const pending = client.call('pane.read', {}).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    // EXACTLY at the limit, delivered in fragments: accepted, still open.
    for (let i = 0; i < cap; i++) client.onBytes(Buffer.from('y'))
    expect(client.isClosed()).toBe(false)
    expect(client.bufferedBytes()).toBe(cap)
    // One byte past: torn down.
    client.onBytes(Buffer.from('y'))
    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
    expect((await pending)!.message).toMatch(/no newline/)
  })

  it('CONTROL — both LEGITIMATE envelopes still work', async () => {
    // Otherwise a validator that rejected everything would pass all of the above.
    const client = new HerdrClient(5000)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    // A reply with `result`.
    const ok = client.call('pane.get', {})
    feed(client, '{"id":"n1","result":{"type":"ok"}}\n')
    expect(await ok).toEqual({ type: 'ok' })
    // AND AN EMPTY `result` IS A REAL SUCCESS, the reply-path twin of the `data:{}`
    // case below. `{}` used to be the value the client INVENTED when it could not
    // read an outcome, which is precisely why it must stay a legitimate one here:
    // requiring "a usable outcome" must not become "a non-empty outcome", or a
    // server that acknowledges with no fields starts failing.
    const empty = client.call('pane.send_keys', {})
    feed(client, '{"id":"n2","result":{}}\n')
    expect(await empty).toEqual({})
    expect(client.isClosed()).toBe(false)
    // A reply with `error` — including the measured `id: ""` shape.
    const bad = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    feed(client, '{"id":"","error":{"code":"invalid_request","message":"nope"}}\n')
    expect((await bad)!.message).toContain('invalid_request')
    expect(client.isClosed()).toBe(false)
    // An event. `subscribe` issues its own rpc, so its reply has to be fed before it
    // resolves — the ids are sequential, and this is the fourth call.
    // Collected rather than overwritten: every delivery is kept, so "the second event
    // arrived with an empty object" is distinguishable from "the second event never
    // arrived and the first is still sitting in the variable".
    const seen: Record<string, unknown>[] = []
    const sub = client.subscribe('pane_exited', { type: 'pane.exited' }, (d) => {
      seen.push(d)
    })
    feed(client, '{"id":"n4","result":{"type":"ok"}}\n')
    await sub
    feed(client, '{"event":"pane_exited","data":{"pane_id":"w1:p1"}}\n')
    expect(seen).toEqual([{ pane_id: 'w1:p1' }])
    expect(client.isClosed()).toBe(false)
    // AND A GENUINELY EMPTY `data` IS STILL VALID — the distinction the fix rests on
    // is empty-and-known versus not-an-object. Without this, requiring `data` could
    // be "reject anything whose data is falsy", which would pass every case in the
    // table above and break a legitimate event carrying no fields.
    feed(client, '{"event":"pane_exited","data":{}}\n')
    expect(seen).toEqual([{ pane_id: 'w1:p1' }, {}])
    expect(client.isClosed()).toBe(false)
    client.close()
  })

  // ── WELL-FORMED-SO-FAR IS NOT COMPLETE ───────────────────────────────────────

  it('an unterminated frame EXACTLY at the limit is accepted and completes', async () => {
    // The at-limit case matters as much as the over case: a bound that rejects a
    // legitimate maximal frame is a new failure mode, not a fix.
    const LIMIT = 512 // a small bound so the test is cheap; the mechanism is identical
    const client = new HerdrClient(5000, LIMIT)
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => (void (ends += 1)) })
    const p = client.call('pane.read', {})

    // Build a VALID frame whose body is exactly LIMIT bytes.
    const head = '{"id":"n1","result":{"type":"ok","text":"'
    const tail = '"}}'
    const body = head + 'x'.repeat(LIMIT - head.length - tail.length) + tail
    expect(Buffer.byteLength(body, 'utf8')).toBe(LIMIT)

    feed(client, body) // no newline yet — exactly at the limit
    expect(client.isClosed()).toBe(false)
    expect(ends).toBe(0)
    feed(client, '\n') // now it completes
    const r = (await p) as { type: string; text: string }
    expect(r.type).toBe('ok')
    expect(client.isClosed()).toBe(false)
    client.close()
  })

  it('ONE BYTE over the limit with no newline tears the transport down', async () => {
    const LIMIT = 512
    const client = new HerdrClient(5000, LIMIT)
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => (void (ends += 1)) })
    const p = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    feed(client, 'x'.repeat(LIMIT + 1))
    const err = await p
    expect(err).toBeDefined()
    expect(err!.message).toContain('exceeded')
    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
  })

  it('the bound is enforced ACROSS chunks, not per chunk', async () => {
    // A peer streaming a byte at a time must still be caught — the limit is on what
    // has accumulated, not on any single delivery.
    const LIMIT = 64
    const client = new HerdrClient(5000, LIMIT)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const p = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    for (let i = 0; i <= LIMIT && !client.isClosed(); i++) feed(client, 'x')
    expect((await p)!.message).toContain('exceeded')
    expect(client.isClosed()).toBe(true)
  })

  it('a COMPLETE oversized frame is refused before it is decoded or dispatched', async () => {
    // THE HALF THAT WAS OPEN. The bound was checked AFTER the dispatch loop, against
    // whatever remained UNTERMINATED — so a fully-formed oversized frame was decoded,
    // parsed and dispatched, and by the time the check ran the buffer was empty. The
    // bound guarded accumulation, not a frame. Every earlier test fed bytes WITHOUT a
    // newline, exercising only the half that already worked.
    const LIMIT = 64
    const client = new HerdrClient(60_000, LIMIT)
    let ends = 0
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => (void (ends += 1)) })
    const p = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)

    // A VALID reply for the in-flight request, but over the limit — and TERMINATED.
    const big = `{"id":"n1","result":{"type":"ok","text":"${'x'.repeat(LIMIT * 4)}"}}`
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(LIMIT)
    feed(client, `${big}\n`)

    // It must NOT have been honoured: the call fails on the bound, not on the payload.
    const err = await p
    expect(err).toBeDefined()
    expect(err!.message).toContain('exceeds')
    expect(client.isClosed()).toBe(true)
    expect(ends).toBe(1)
  })

  it('an oversized frame TEARS DOWN rather than resynchronising on the next frame', async () => {
    // Proves the refusal is terminal and not a skip: a well-formed frame arriving
    // after the oversized one must not be honoured, because the connection is gone.
    const LIMIT = 64
    const client = new HerdrClient(60_000, LIMIT)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const first = client.call('pane.read', {}).then(() => undefined, (e: unknown) => e as Error)
    const big = `{"id":"n1","result":{"type":"ok","text":"${'x'.repeat(LIMIT * 4)}"}}`
    // Both frames in ONE delivery: a client that merely skipped the oversized one
    // would go on to honour the second.
    feed(client, `${big}\n{"id":"n2","result":{"type":"ok"}}\n`)
    expect((await first)!.message).toContain('exceeds')
    expect(client.isClosed()).toBe(true)
    // A later call is refused, not sent.
    const later = await client.call('pane.get', {}).then(() => undefined, (e: unknown) => e as Error)
    expect(later!.message).toContain('closed connection')
  })

  it('CONTROL — a COMPLETE frame exactly AT the limit is honoured', async () => {
    // The at-limit case for the terminated path, matching the unterminated one: a
    // bound that rejects a legitimate maximal frame is a new failure mode.
    const LIMIT = 512
    const client = new HerdrClient(60_000, LIMIT)
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const p = client.call('pane.read', {})
    const head = '{"id":"n1","result":{"type":"ok","text":"'
    const tail = '"}}'
    const body = head + 'x'.repeat(LIMIT - head.length - tail.length) + tail
    expect(Buffer.byteLength(body, 'utf8')).toBe(LIMIT)
    feed(client, `${body}\n`)
    const r = (await p) as { type: string }
    expect(r.type).toBe('ok')
    expect(client.isClosed()).toBe(false)
    client.close()
  })

  it('the default frame bound is pinned, and sits above a full-cap screen', () => {
    expect(HERDR_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024)
    // Comfortably above the ring's 512 KiB retained screen even after JSON escaping
    // inflates it several-fold.
    expect(HERDR_MAX_FRAME_BYTES).toBeGreaterThan(512 * 1024 * 4)
  })

  it('splits multiple replies arriving in one chunk', async () => {
    const client = new HerdrClient()
    // Returns the real byte count: a stub returning 0 is now a SHORT WRITE and
    // kills the connection — which is the guard working, not a test-harness detail.
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const a = client.call('pane.read', {})
    const b = client.call('pane.get', {})
    // Both replies in ONE delivery, plus a partial third — a client that treated a
    // chunk as a frame would resolve neither.
    feed(client, '{"id":"n1","result":{"type":"a"}}\n{"id":"n2","result":{"type":"b"}}\n{"id":"n3"')
    expect(await a).toEqual({ type: 'a' })
    expect(await b).toEqual({ type: 'b' })
    client.close()
  })

  it('a MULTIBYTE character split at EVERY byte boundary decodes exactly once', async () => {
    // THE UNITS DEFECT, THIRD TIME ON THIS PR. The transport decoded each socket
    // chunk with `d.toString()`, so a character split across two chunks became two
    // U+FFFD — one per half — and the JSON STILL PARSED. Nothing failed; pane text
    // and error messages corrupted silently. The previous chunk-boundary test split
    // only ASCII, which cannot see it.
    //
    // Every interior byte boundary is exercised, and the assertion is the exact
    // decoded CONTENT, not that the parse succeeded.
    const TEXT = 'héllo → 日本語 😀 ünïcødé'
    const frame = Buffer.from(`{"id":"n1","result":{"type":"ok","text":${JSON.stringify(TEXT)}}}\n`, 'utf8')
    for (let cut = 1; cut < frame.length; cut++) {
      const client = new HerdrClient()
      client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
      const p = client.call('pane.read', {})
      client.onBytes(frame.subarray(0, cut))
      client.onBytes(frame.subarray(cut))
      const r = (await p) as { text: string }
      expect(r.text).toBe(TEXT) // exact content, at every split point
      expect(r.text).not.toContain('\uFFFD')
      client.close()
    }
  })

  it('a frame split BYTE BY BYTE still decodes exactly', async () => {
    // The extreme: one byte per socket delivery, so every multi-byte sequence is
    // split repeatedly. A per-chunk decode produces nothing but replacement
    // characters here.
    const TEXT = '→ 日本語 😀'
    const frame = Buffer.from(`{"id":"n1","result":{"type":"ok","text":${JSON.stringify(TEXT)}}}\n`, 'utf8')
    const client = new HerdrClient()
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const p = client.call('pane.read', {})
    for (const byte of frame) client.onBytes(Uint8Array.of(byte))
    const r = (await p) as { text: string }
    expect(r.text).toBe(TEXT)
    client.close()
  })

  it('a reply split ACROSS chunks is still assembled', async () => {
    const client = new HerdrClient()
    // Returns the real byte count: a stub returning 0 is now a SHORT WRITE and
    // kills the connection — which is the guard working, not a test-harness detail.
    client.attach({ write: (d) => Buffer.byteLength(d, 'utf8'), end: () => {} })
    const p = client.call('ping', {})
    feed(client, '{"id":"n1","resu')
    feed(client, 'lt":{"type":"pong"}}\n')
    expect(await p).toEqual({ type: 'pong' })
    client.close()
  })
})
