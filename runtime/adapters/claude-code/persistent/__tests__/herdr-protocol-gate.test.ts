/**
 * herdr-protocol-gate.test.ts — the one-request-per-connection client.
 *
 * WHAT THIS FILE STOPPED TESTING, AND WHY. It used to cover a persistent multiplexing
 * client: subscriptions, event envelopes, teardown-of-pending, post-close dispatch,
 * correlation of many replies over one socket. None of that exists any more, because
 * the server does not: MEASURED on herdr 0.8.2 / protocol 20, it answers exactly ONE
 * request per connection and then closes it (two pings pipelined in the same tick get
 * one reply, socket gone 1 ms later). Those tests did not fail — they described a
 * client that could not run, against a fake that agreed with it. They are deleted
 * rather than left passing.
 *
 * What survives is everything that is still about a single reply: the version gate,
 * the frame bound enforced BEFORE the bytes are copied, one decode per complete line,
 * and an envelope carrying exactly one well-formed outcome.
 */

import { describe, expect, it } from 'bun:test'
import { herdrCall, herdrPing, HerdrError } from '../herdr-client.ts'
import { HERDR_PROTOCOL_VERSION } from '../herdr-protocol.ts'
import { newFrameReader } from '../herdr-client.ts'
import { HerdrHost } from '../herdr-host.ts'
import { FakeHerdrServer } from './herdr-fake-server.ts'

interface FakeSocket {
  write(data: string): number
  end(): void
}
interface Handlers {
  onBytes: (d: Uint8Array) => void
  onClose: (e?: Error) => void
}

/** Build an injected connector whose socket hands `reply` back, optionally in pieces. */
function replying(
  reply: string | undefined,
  opts: {
    chunkSize?: number
    writeReturns?: (frame: string) => number
    writeThrows?: Error
    closeInstead?: Error | 'silent'
    connectThrows?: Error
    onRequest?: (frame: string) => void
    never?: boolean
  } = {},
): { connect: (p: string, h: Handlers) => Promise<FakeSocket>; ends: () => number } {
  let ends = 0
  return {
    ends: () => ends,
    connect: async (_p, h) => {
      if (opts.connectThrows) throw opts.connectThrows
      return {
        write(frame: string): number {
          opts.onRequest?.(frame)
          if (opts.writeThrows) throw opts.writeThrows
          const n = opts.writeReturns ? opts.writeReturns(frame) : Buffer.byteLength(frame, 'utf8')
          if (n < Buffer.byteLength(frame, 'utf8')) return n
          if (opts.never === true) return n
          queueMicrotask(() => {
            if (opts.closeInstead !== undefined) {
              h.onClose(opts.closeInstead === 'silent' ? undefined : opts.closeInstead)
              return
            }
            const bytes = Buffer.from(reply ?? '', 'utf8')
            const size = opts.chunkSize ?? bytes.length
            for (let i = 0; i < bytes.length; i += size) h.onBytes(bytes.subarray(i, i + size))
          })
          return n
        },
        end(): void {
          ends += 1
        },
      }
    },
  }
}

const call = (reply: string | undefined, o: Parameters<typeof replying>[1] = {}) =>
  herdrCall('pane.read', {}, { socketPath: '/fake', connect: replying(reply, o).connect })

describe('the protocol version gate', () => {
  const pong = (protocol: number): string =>
    `{"id":"r","result":{"type":"pong","version":"0.8.2","protocol":${protocol}}}\n`

  it('accepts the protocol this client was measured against', async () => {
    const got = await herdrPing({ socketPath: '/f', connect: replying(pong(HERDR_PROTOCOL_VERSION)).connect })
    expect(got.protocol).toBe(HERDR_PROTOCOL_VERSION)
  })

  it('REFUSES a higher protocol, naming both numbers', async () => {
    const e = await herdrPing({
      socketPath: '/f',
      connect: replying(pong(HERDR_PROTOCOL_VERSION + 2)).connect,
    }).catch((x: unknown) => x as Error)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).toContain(String(HERDR_PROTOCOL_VERSION + 2))
    expect((e as Error).message).toContain(String(HERDR_PROTOCOL_VERSION))
  })

  it('REFUSES a LOWER protocol too — this is equality, not a floor', async () => {
    // A floor would accept a server that has not yet grown the semantics we measured.
    const e = await herdrPing({
      socketPath: '/f',
      connect: replying(pong(HERDR_PROTOCOL_VERSION - 1)).connect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('refusing to drive it')
  })

  it('REFUSES a pong with no usable protocol rather than assuming one', async () => {
    const e = await herdrPing({
      socketPath: '/f',
      connect: replying('{"id":"r","result":{"type":"pong","version":"0.8.2"}}\n').connect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('no usable protocol')
  })
})

describe('one request, one reply, one connection', () => {
  it('sends exactly one newline-terminated frame and resolves with its result', async () => {
    const frames: string[] = []
    const r = replying('{"id":"r","result":{"type":"ok","text":"hi"}}\n', {
      onRequest: (f) => frames.push(f),
    })
    const got = await herdrCall('pane.read', { pane_id: 'w1:p1' }, { socketPath: '/f', connect: r.connect })
    expect(got).toEqual({ type: 'ok', text: 'hi' })
    expect(frames.length).toBe(1)
    expect(frames[0]!.endsWith('\n')).toBe(true)
    expect(JSON.parse(frames[0]!.trim())).toEqual({
      id: 'r',
      method: 'pane.read',
      params: { pane_id: 'w1:p1' },
    })
    // The connection is closed from our side too, rather than left to the GC.
    expect(r.ends()).toBe(1)
  })

  // A settled call accepts nothing further. There is no `close()` flag to consult any
  // more — the guard is that settlement is once-only and the bytes after it are dropped
  // rather than accumulated. Both halves are visible here: the FIRST result stands, and
  // the socket is ended once by the settlement rather than once per delivery.
  it('a settled call accepts nothing further — a second reply cannot overwrite the first', async () => {
    const two = '{"id":"r","result":{"n":1}}\n{"id":"r","result":{"n":2}}\n'
    // BOTH arrival shapes, because they exercise different code: chunked, the second
    // frame arrives at an already-settled call and is refused by the settlement guards;
    // COALESCED, it never arrives at all — the first frame's newline ends the copy and
    // the rest of the delivery is dropped unread.
    for (const chunkSize of [28, undefined]) {
      const r = replying(two, chunkSize === undefined ? {} : { chunkSize })
      const got = await herdrCall('pane.read', {}, { socketPath: '/f', connect: r.connect })
      expect(`${String(chunkSize)}: ${JSON.stringify(got)} ends=${r.ends()}`).toBe(
        `${String(chunkSize)}: {"n":1} ends=1`,
      )
    }
  })

  it('reassembles a reply split across many chunks, including mid-character', async () => {
    // A multi-byte character split across two socket chunks must not be decoded twice.
    const text = '✅ pane ✅ output ✅'
    const reply = `{"id":"r","result":{"text":${JSON.stringify(text)}}}\n`
    const got = await call(reply, { chunkSize: 1 })
    expect(got['text']).toBe(text)
  })

  it('a typed server error becomes a HerdrError carrying its code', async () => {
    const e = await call('{"id":"r","error":{"code":"pane_not_found","message":"pane w1:p1 not found"}}\n').catch(
      (x: unknown) => x as Error,
    )
    expect(e).toBeInstanceOf(HerdrError)
    expect((e as HerdrError).code).toBe('pane_not_found')
  })

  it('a connection closed BEFORE the reply is a failed call, not an empty one', async () => {
    // The server closes after answering, so a close with no reply means the request
    // died unanswered — which must not resolve with `{}`.
    const e = await call(undefined, { closeInstead: 'silent' }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('closed before')
  })

  it('a REFUSED connection rejects rather than hanging', async () => {
    const e = await call(undefined, { connectThrows: new Error('ECONNREFUSED') }).catch(
      (x: unknown) => x as Error,
    )
    expect((e as Error).message).toContain('ECONNREFUSED')
  })

  it('a SHORT write is a failed call — a truncated request can never be answered', async () => {
    const e = await call('{"id":"r","result":{}}\n', { writeReturns: () => 3 }).catch(
      (x: unknown) => x as Error,
    )
    expect((e as Error).message).toMatch(/short write/)
  })

  it('a THROWN write is a failed call too', async () => {
    const e = await call('{"id":"r","result":{}}\n', { writeThrows: new Error('EPIPE') }).catch(
      (x: unknown) => x as Error,
    )
    expect((e as Error).message).toContain('EPIPE')
  })

  // EVERY route ends the connection exactly once — the healthy one included. The control
  // inverted with the transport: a shared socket had to survive a healthy exchange, a
  // per-call socket has to be released by it, or a descriptor leaks per request. The one
  // honest exception is a REFUSED connect: there is no socket to end, so the count is 0.
  it('every terminal route ends the connection exactly once', async () => {
    const routes: [string, string | undefined, Parameters<typeof replying>[1], number][] = [
      ['a healthy reply', '{"id":"r","result":{}}\n', {}, 1],
      ['a close before the reply', undefined, { closeInstead: 'silent' }, 1],
      ['a short write', '{"id":"r","result":{}}\n', { writeReturns: () => 3 }, 1],
      ['a thrown write', '{"id":"r","result":{}}\n', { writeThrows: new Error('EPIPE') }, 1],
      ['a frame matching no envelope', '{}\n', {}, 1],
      ['an unparseable frame', 'not json\n', {}, 1],
      ['a deadline', undefined, { never: true }, 1],
      ['a REFUSED connect — there is no socket to end', undefined, { connectThrows: new Error('x') }, 0],
    ]
    for (const [label, reply, o, expected] of routes) {
      const r = replying(reply, o)
      await herdrCall('pane.read', {}, { socketPath: '/f', timeoutMs: 30, connect: r.connect }).catch(
        () => undefined,
      )
      expect(`${label}: ${r.ends()}`).toBe(`${label}: ${expected}`)
    }
  })

  it('an unanswered request is bounded by its own clock', async () => {
    const e = await herdrCall('pane.read', {}, {
      socketPath: '/f',
      timeoutMs: 30,
      connect: replying(undefined, { never: true }).connect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('went unanswered')
  })

  // A CONNECTOR THAT NEVER RESOLVES IS STILL BOUNDED, and the FIXTURE is the finding.
  // Every other timeout case here uses a connector that resolves — after 40 ms, or
  // instantly — and a connector that always resolves cannot test one that does not. The
  // unbounded path went in underneath an assertion about the ERROR rather than about
  // the call ending at all: the timer settled the pending outcome, but execution was
  // parked on `await connect(...)` and never reached the check.
  //
  // Asserted as a RACE against a sentinel rather than by measuring elapsed time: the
  // property is "this terminates", and a sentinel that wins is a hang.
  it('a connector that NEVER RESOLVES is still bounded — the deadline covers establishment', async () => {
    const SENTINEL = 'SENTINEL: herdrCall never returned'
    const call = herdrCall('pane.read', {}, {
      socketPath: '/f',
      timeoutMs: 1,
      connect: () => new Promise<FakeSocket>(() => {}), // never resolves, never rejects
    }).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message,
    )
    const sentinel = new Promise<string>((r) => {
      setTimeout(() => r(SENTINEL), 200)
    })
    expect(await Promise.race([call, sentinel])).toContain('went unanswered')
  })

  // RACING THE DEADLINE LOSES THE REFERENCE, so the close has to be deferred to the
  // connect itself. Without it a timed-out call leaks a descriptor per attempt, which
  // is a worse failure than the hang the race fixed — and nothing in the call's own
  // lifetime can observe it, because the call is already over.
  it('a socket that arrives AFTER the deadline is still released', async () => {
    let ends = 0
    const slowConnect = async (): Promise<FakeSocket> => {
      await new Promise((r) => setTimeout(r, 40))
      return {
        write: () => 0,
        end: () => {
          ends += 1
        },
      }
    }
    const e = await herdrCall('pane.read', {}, {
      socketPath: '/f',
      timeoutMs: 1,
      connect: slowConnect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('went unanswered')
    // The call is already over and the socket has not arrived: nothing to close YET,
    // which is what makes the deferred close the only thing that can do it.
    expect(ends).toBe(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(ends).toBe(1)
  })

  // The deadline can fire while the connect is STILL IN FLIGHT — nothing is holding
  // the call's own promise yet at that moment. If the call settled by REJECTING that
  // promise, the rejection would be unobserved for the rest of the connect and Bun's
  // process net would report (and in a server, kill) it. It settles by RESOLVING an
  // outcome record instead, and the failure becomes a throw at the await that hands it
  // back. This asserts the absence of the rejection, not just the presence of the error.
  it('a deadline that fires mid-connect leaves no unobserved rejection behind', async () => {
    const unobserved: unknown[] = []
    const record = (e: unknown): void => {
      unobserved.push(e)
    }
    process.on('unhandledRejection', record)
    try {
      const slowConnect = async (): Promise<FakeSocket> => {
        await new Promise((r) => setTimeout(r, 40))
        return { write: () => 0, end: () => undefined }
      }
      const e = await herdrCall('pane.read', {}, {
        socketPath: '/f',
        timeoutMs: 1,
        connect: slowConnect,
      }).catch((x: unknown) => x as Error)
      expect((e as Error).message).toContain('went unanswered')
      // Give the runtime a turn to report anything it considers unobserved.
      await new Promise((r) => setTimeout(r, 25))
      expect(unobserved).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })
})

describe('the reply envelope — exactly one well-formed outcome', () => {
  for (const [label, reply] of [
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an EMPTY OBJECT — parses, is an object, answers nothing', '{}'],
    ['a bare number', '42'],
    ['a bare string', '"hello"'],
    ['an id with no outcome', '{"id":"r"}'],
    ['an outcome with no id', '{"result":{"type":"ok"}}'],
    // A WELL-FORMED ANSWER TO A DIFFERENT QUESTION. Every other row here is malformed;
    // this one is perfectly shaped and simply is not ours, which is why it was the row
    // missing. One connection carries one request, so nothing but the server's own
    // discipline stops a stray or drifted response arriving — and the server is the
    // thing this branch measured as undisciplined: no version check of any kind, and a
    // protocol that moved 20 → 22 in nineteen days. Resolving on it would report a
    // `pane.close` as acknowledged when nothing acknowledged it.
    ['a MISMATCHED id — well-formed, but not our answer', '{"id":"wrong","result":{"type":"ok"}}'],
    ['a NUMERIC id where ours is a string', '{"id":0,"result":{"type":"ok"}}'],
    ['BOTH result and error', '{"id":"r","result":{},"error":{"code":"x"}}'],
    ['a string error', '{"id":"r","error":"refused"}'],
    ['a null error', '{"id":"r","error":null}'],
    ['an array error', '{"id":"r","error":[]}'],
    ['a string result', '{"id":"r","result":"ok"}'],
    ['a null result', '{"id":"r","result":null}'],
    ['an array result', '{"id":"r","result":[]}'],
    ['a boolean result', '{"id":"r","result":true}'],
  ] as [string, string][]) {
    it(`${label} is refused, never resolved`, async () => {
      // PRESENCE OF A KEY IS NOT THE CHECK. A string `error` once passed a presence
      // test, failed the object conversion downstream, skipped the error branch, and
      // RESOLVED the call with `{}` — a refused `pane.close` reported as acknowledged.
      const e = await call(`${reply}\n`).catch((x: unknown) => x as Error)
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).message).toMatch(/no known envelope|unparseable/)
    })
  }

  it('CONTROL — the MATCHING id resolves, so correlation is a check and not a refusal', async () => {
    // Without this, "reject a mismatched id" is satisfied by rejecting every id, which
    // would fail every call ever made.
    expect(await call('{"id":"r","result":{"type":"ok"}}\n')).toEqual({ type: 'ok' })
  })

  it('CONTROL — an EMPTY result object is a real success', async () => {
    // `{}` is what a client with no envelope check invents when it cannot read an
    // outcome, which is exactly why it must stay a legitimate one here: requiring "a
    // usable outcome" must not become "a non-empty outcome".
    expect(await call('{"id":"r","result":{}}\n')).toEqual({})
  })

  it('an unparseable frame is refused rather than guessed at', async () => {
    const e = await call('{not json at all\n').catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('unparseable')
  })
})

describe('the frame bound', () => {
  it('is enforced BEFORE the bytes are copied', async () => {
    // The limit exists to stop us allocating for a reply we will not accept, so it
    // cannot run after the allocation it guards. 16 MiB against a 64-byte cap.
    const e = await herdrCall('pane.read', {}, {
      socketPath: '/f',
      maxFrameBytes: 64,
      connect: replying(`${'x'.repeat(16 * 1024 * 1024)}\n`, { chunkSize: 1 << 20 }).connect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('exceeded 64 bytes')
  })

  it('CONTROL — a reply EXACTLY at the limit is accepted', async () => {
    // A bound that rejects a legitimate maximal reply is a new failure mode, not a fix.
    const body = '{"id":"r","result":{"type":"ok"}}'
    const exact = Buffer.byteLength(`${body}\n`, 'utf8')
    expect(await herdrCall('pane.read', {}, {
      socketPath: '/f',
      maxFrameBytes: exact,
      connect: replying(`${body}\n`).connect,
    })).toEqual({ type: 'ok' })
  })

  // THE BOUND IS PER FRAME, NOT PER DELIVERY — and only a COALESCED delivery can tell
  // the two apart. A peer is free to put a complete, legal reply and the first byte of
  // whatever follows it into one write; measuring the delivery rejects the legal reply
  // for something that is not part of it. Cap set to the frame's own exact length, with
  // one extra byte riding along: a per-delivery bound reads 29 > 28 and fails the call.
  it('a maximal reply COALESCED with a trailing byte is still accepted', async () => {
    const frame = '{"id":"r","result":{"n":1}}\n'
    const exact = Buffer.byteLength(frame, 'utf8')
    expect(exact).toBe(28)
    expect(await herdrCall('pane.read', {}, {
      socketPath: '/f',
      maxFrameBytes: exact,
      connect: replying(`${frame}x`).connect,
    })).toEqual({ n: 1 })
  })

  // The other direction, so "per frame" is not satisfied by having no bound at all: an
  // over-cap frame delivered in ONE chunk with its newline present must still be
  // refused. The 16 MiB case above arrives in pieces; this one does not.
  it('an over-cap frame arriving COMPLETE in one chunk is still refused', async () => {
    const body = `{"id":"r","result":{"pad":"${'y'.repeat(200)}"}}`
    const e = await herdrCall('pane.read', {}, {
      socketPath: '/f',
      maxFrameBytes: 64,
      connect: replying(`${body}\n`).connect,
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('exceeded 64 bytes')
  })
})

/**
 * THE BOUND RUNS BEFORE THE COPY — asserted through the reader, because end-to-end it is
 * UNFALSIFIABLE.
 *
 * Moving the check after the allocation produces the identical observable through
 * `herdrCall`: the same error, the same failed call, the same timing. So that mutation
 * SURVIVED every round and the as-built recorded it as surviving while the acceptance
 * criterion claimed the property. An unfalsifiable check is believed rather than tested.
 *
 * Third instance of one lesson today — a pure helper can prove the check works and
 * cannot prove anything still calls it; neither can prove WHEN it runs unless the thing
 * it guards is observable. So the reader reports the bytes it has COPIED, and "before"
 * becomes a number.
 */
describe('the frame bound is enforced BEFORE the allocation it exists to prevent', () => {
  it('an over-cap chunk is refused with NOTHING copied', () => {
    const reader = newFrameReader(64)
    const read = reader.push(new TextEncoder().encode('x'.repeat(4096)))
    expect(read.kind).toBe('oversized')
    // THE WHOLE POINT. A bound that runs after the grow-and-copy rejects the same frame
    // with the same message, having already done the work it exists to avoid.
    expect(reader.copiedBytes()).toBe(0)
  })

  it('an over-cap frame SPLIT across deliveries copies only what was under the cap', () => {
    const reader = newFrameReader(64)
    expect(reader.push(new TextEncoder().encode('y'.repeat(50))).kind).toBe('pending')
    expect(reader.copiedBytes()).toBe(50) // legitimate so far
    expect(reader.push(new TextEncoder().encode('y'.repeat(50))).kind).toBe('oversized')
    // The second delivery crossed the cap, so none of IT was taken.
    expect(reader.copiedBytes()).toBe(50)
  })

  it('CONTROL — an acceptable frame IS copied, so the counter measures something', () => {
    // Without this, `copiedBytes() === 0` is satisfied by a reader that never copies at
    // all, and every assertion above passes for a reader that does nothing.
    const reader = newFrameReader(64)
    const read = reader.push(new TextEncoder().encode('{"id":"r","result":{}}\n'))
    expect(read.kind).toBe('frame')
    expect(read.kind === 'frame' ? read.line : '').toBe('{"id":"r","result":{}}')
    // The frame's own bytes, WITHOUT its terminator — the newline is a delimiter, not
    // content, and copying it would put it in the decoded line.
    expect(reader.copiedBytes()).toBe(22)
  })

  it('a reply EXACTLY at the cap is accepted, terminator included in the budget', () => {
    const body = '{"id":"r","result":{}}'
    const exact = Buffer.byteLength(`${body}\n`, 'utf8')
    const reader = newFrameReader(exact)
    expect(reader.push(new TextEncoder().encode(`${body}\n`)).kind).toBe('frame')
  })

  it('a maximal reply COALESCED with a trailing byte is still accepted, and the extra is NOT copied', () => {
    const body = '{"id":"r","result":{}}'
    const exact = Buffer.byteLength(`${body}\n`, 'utf8')
    const reader = newFrameReader(exact)
    const read = reader.push(new TextEncoder().encode(`${body}\nSURPLUS`))
    expect(read.kind).toBe('frame')
    // Per FRAME, not per delivery — and the surplus is dropped unread rather than
    // buffered for a next frame this connection will never carry.
    expect(reader.copiedBytes()).toBe(body.length)
  })
})

/**
 * THE GATE THROUGH `spawn`, which is where the guarantee lives — and which no test could
 * reach until now.
 *
 * The check ran only when no `connect` dependency was injected: a runtime `if` keyed on
 * whether a TEST SEAM was present, so the seam's presence changed the safety property.
 * The consequence that matters is not that an injected client skipped the gate; it is
 * that the injected path is THE ONLY PATH A TEST CAN DRIVE, so the acceptance criterion
 * — a stub reporting protocol 21 makes `spawn` reject — was unwritable against the code.
 * `herdrPing()` called directly exercises the function in isolation, not the guarantee.
 *
 * A gate the instrument cannot reach is the same class as an instrument that cannot
 * fail, which this branch found in its own harness the same day.
 */
describe('the version gate holds SPAWN, not just the ping function', () => {
  const hostWith = (server: FakeHerdrServer): HerdrHost =>
    new HerdrHost({
      connect: async () => server,
      pollIntervalMs: 60_000,
      sleep: (ms) => Bun.sleep(ms),
      workspaceId: 'w9',
    })

  it('a stub reporting protocol 21 makes spawn REJECT, naming both numbers', async () => {
    const server = new FakeHerdrServer()
    // A SUCCESSFUL ping that answers with a different protocol — the drift shape, not a
    // broken server. `malformMethod` returns its payload as a success.
    server.malformMethod('ping', { type: 'pong', version: '0.9.0', protocol: 21 })
    const e = await hostWith(server)
      .spawn(['claude'], { cwd: '/tmp', env: {} })
      .catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('protocol 21')
    expect((e as Error).message).toContain(String(HERDR_PROTOCOL_VERSION))
  })

  it('...and NO PANE IS CREATED, so there is nothing left to clean up', async () => {
    // The cleanup obligation on this path is honoured by ORDERING — the gate runs before
    // `layout.apply` — and that is asserted rather than assumed. A gate that ran after
    // would leave a real `claude` running behind a rejected spawn, which is the orphan
    // class this host was fixed for twice.
    const server = new FakeHerdrServer()
    server.malformMethod('ping', { type: 'pong', version: '0.9.0', protocol: 21 })
    await hostWith(server)
      .spawn(['claude'], { cwd: '/tmp', env: {} })
      .catch(() => undefined)
    expect(server.callsTo('layout.apply')).toEqual([])
    expect(server.paneClosed).toBe(false)
  })

  it('CONTROL — a stub reporting the SUPPORTED protocol spawns normally', async () => {
    // Without this, "spawn rejects on a mismatch" is satisfied by a spawn that always
    // rejects, and the gate would be indistinguishable from a broken host.
    const server = new FakeHerdrServer() // answers the measured protocol
    const child = await hostWith(server).spawn(['claude'], { cwd: '/tmp', env: {} })
    expect(child.pid).toBeGreaterThan(0)
    expect(server.callsTo('ping').length).toBe(1) // ONCE, not per call
    expect(server.callsTo('layout.apply').length).toBe(1)
    child.kill()
  })
})

/**
 * MALFORMED UTF-8 IS A PROTOCOL ERROR, NOT A FRAME WITH ODD CHARACTERS IN IT.
 *
 * `Buffer.toString('utf8')` substitutes U+FFFD for every invalid sequence and returns
 * happily, so `c3 28` becomes `"�("` and `JSON.parse` SUCCEEDS on the result. A
 * corrupt frame is then accepted as a valid acknowledgement, and pane text that
 * detectors scan is altered with nothing reporting it.
 *
 * The last case is the one that stops the fix being a different bug: a VALID multi-byte
 * sequence split across deliveries must still decode. Without it, "reject malformed
 * UTF-8" is satisfied by rejecting every fragmented multi-byte read — which is most of
 * them, since the reader exists because frames arrive in pieces.
 */
describe('a frame that is not valid UTF-8 is refused, not substituted', () => {
  const reader = (): ReturnType<typeof newFrameReader> => newFrameReader(4096)
  /** `{"id":"r","result":{"t":"<bytes>"}}\n` with raw bytes spliced into the string. */
  const frameWith = (bad: number[]): Uint8Array =>
    new Uint8Array([
      ...new TextEncoder().encode('{"id":"r","result":{"t":"'),
      ...bad,
      ...new TextEncoder().encode('"}}\n'),
    ])

  it('an invalid LEAD byte is refused', () => {
    expect(reader().push(frameWith([0xff])).kind).toBe('undecodable')
  })

  it('an invalid CONTINUATION byte is refused — the case that parses as JSON once substituted', () => {
    // `c3 28`: a 2-byte lead followed by '('. Substituted it is "�(" and the frame
    // parses; rejected it is a protocol error.
    expect(reader().push(frameWith([0xc3, 0x28])).kind).toBe('undecodable')
  })

  it('a sequence TRUNCATED before the newline is refused', () => {
    // `e2 82` — the first two bytes of `€`, with the frame ending after them.
    expect(reader().push(frameWith([0xe2, 0x82])).kind).toBe('undecodable')
  })

  it('a VALID multi-byte sequence SPLIT ACROSS CHUNKS still decodes', () => {
    // The case that makes fatal decoding safe: bytes are reassembled before they are
    // decoded, so fragmentation is not corruption. `€` is e2 82 ac.
    const r = reader()
    const whole = frameWith([0xe2, 0x82, 0xac])
    for (let i = 0; i < whole.length - 1; i++) {
      expect(r.push(whole.subarray(i, i + 1)).kind).toBe('pending')
    }
    const last = r.push(whole.subarray(whole.length - 1))
    expect(last.kind).toBe('frame')
    expect(last.kind === 'frame' ? JSON.parse(last.line) : undefined).toEqual({
      id: 'r',
      result: { t: '€' },
    })
  })

  it('CONTROL — a plain ASCII frame still decodes, so the decoder is not rejecting everything', () => {
    const r = reader().push(new TextEncoder().encode('{"id":"r","result":{"t":"ok"}}\n'))
    expect(r.kind).toBe('frame')
  })

  it('through herdrCall, an undecodable reply FAILS the call and says why', async () => {
    const bytes = frameWith([0xc3, 0x28])
    const e = await herdrCall('pane.read', {}, {
      socketPath: '/f',
      connect: async (_p, h) => ({
        // The full frame must be ACCEPTED, or the call fails as a short write before it
        // ever reads a reply — the guard from an earlier round, firing first.
        write: (frame: string) => {
          queueMicrotask(() => h.onBytes(bytes))
          return Buffer.byteLength(frame, 'utf8')
        },
        end: () => undefined,
      }),
    }).catch((x: unknown) => x as Error)
    expect((e as Error).message).toContain('not valid UTF-8')
    // NOT AN EMPTY REPLY. A decode failure is the absence of a usable answer, and
    // resolving `{}` here would report an acknowledgement nobody sent.
    expect((e as Error).message).toContain('acknowledgement')
  })
})
