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
