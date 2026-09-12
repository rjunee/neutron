/**
 * herdr-client.ts — the newline-delimited-JSON client for herdr's unix socket.
 *
 * § herdr step 2b. One connection per host instance, multiplexing request/reply
 * by `id` and delivering subscription events to registered handlers.
 *
 * THE VERSION GATE IS THE POINT OF `connect`. The socket server does NO protocol
 * check of its own — only herdr's CLI guards — and the protocol moved 20 → 22 in
 * 19 days. A server that has moved on accepts our requests and answers them with
 * different semantics, underneath a REPL supervisor that cannot tell. So
 * {@link connectHerdr} `ping`s FIRST and throws on any mismatch. Not a warning,
 * not a degraded mode: a loud failure at connect time is the only outcome that
 * cannot be mistaken for a working bridge.
 *
 * A NOTE ON ERROR CORRELATION. An unparseable frame comes back with `id: ""`
 * (measured), so a reply cannot always be matched to the request that caused it.
 * A reply whose id matches nothing in flight therefore fails EVERY pending
 * request rather than being dropped — a client that dropped it would hang
 * forever on the one malformed request, which is precisely the shape a protocol
 * bump produces.
 */

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import {
  HERDR_MAX_FRAME_BYTES,
  HERDR_PROTOCOL_VERSION,
  HERDR_RPC_TIMEOUT_MS,
  type HerdrPong,
} from './herdr-protocol.ts'

/** The frame delimiter, as a BYTE. 0x0A can never appear inside a multi-byte UTF-8
 *  sequence (continuation bytes are ≥ 0x80), so splitting the byte stream on it
 *  always lands on a character boundary. */
const NEWLINE_BYTE = 0x0a

/** The socket-path env var herdr injects into every managed pane. */
export const HERDR_SOCKET_ENV = 'HERDR_SOCKET_PATH'

/** An error the server returned for one request. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`herdr: ${code}: ${message}`)
    this.name = 'HerdrError'
  }
}

/** A handler for one subscription event kind (herdr's `event` field, e.g.
 *  `pane_exited`). Receives the event's `data` object verbatim. */
export type HerdrEventHandler = (data: Record<string, unknown>) => void

/**
 * The RPC surface `HerdrHost` consumes. Narrow on purpose: the host depends on
 * this rather than on {@link HerdrClient}, so a test can substitute a scripted
 * server without reconstructing a real connection, and so nothing in the host can
 * reach past request/reply into the transport.
 */
export interface HerdrRpc {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
  subscribe(
    kind: string,
    subscription: Record<string, unknown>,
    handler: HerdrEventHandler,
  ): Promise<() => void>
  isClosed(): boolean
  close(): void
}

/**
 * A recognised inbound envelope. herdr sends exactly two shapes: an event
 * (`{event, data}`, no id) and a reply (`{id, result}` or `{id, error}`).
 *
 * THE CATEGORY THAT WAS MISSING. The teardown built for a "malformed frame" was
 * defined by the PARSER THROWING, so anything `JSON.parse` accepts and the protocol
 * forbids fell outside it — a payload can be WELL-FORMED WITHOUT BEING VALID.
 * `null\n` threw out of `onBytes` on the first property read (`null['event']`),
 * bypassing teardown entirely; `[]\n` and `{}\n` parsed, answered nothing, and were
 * SILENTLY IGNORED, which is worse than the throw because nothing notices.
 */
type Envelope =
  | { readonly kind: 'event'; readonly event: string; readonly data: Record<string, unknown> }
  // DISCRIMINATED, so "exactly one outcome" is a fact the COMPILER enforces rather
  // than a comment the dispatcher has to remember. With `result`/`error` both
  // optional, the success path needed a `?? {}` fallback for a state the validator
  // had already excluded — and that unreachable default is exactly the shape this
  // whole change is removing. There is now no default to write.
  | { readonly kind: 'reply'; readonly id: string; readonly ok: true; readonly result: Record<string, unknown> }
  | { readonly kind: 'reply'; readonly id: string; readonly ok: false; readonly error: Record<string, unknown> }

/** A plain (non-null, non-array) object, or `undefined`. */
function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Classify a parsed frame, or `undefined` when it matches NEITHER envelope — which
 * includes every JSON primitive (`null`, `42`, `"s"`, `true`), arrays, objects
 * with no recognised discriminator such as `{}`, and an event whose `data` is not a
 * plain object (absent, `null`, an array, or a primitive). A frame that answers nothing is not
 * a frame this client can act on, and the stream carrying it is not one it should
 * keep reading.
 */
function classifyEnvelope(parsed: unknown): Envelope | undefined {
  const o = asObject(parsed)
  if (o === undefined) return undefined
  if (typeof o['event'] === 'string') {
    // `data` MUST BE A REAL OBJECT — an absent, `null`, array or primitive `data` is
    // a malformed frame, not an empty one.
    //
    // THE DEFECT THIS REPLACES: `asObject(o['data']) ?? {}`. That coerced every one
    // of those into `{}`, so the frame passed validation, handlers were called with
    // an empty object, and `pane_exited`'s `data['pane_id'] === paneId` comparison in
    // `herdr-host.ts` quietly failed — an EXIT EVENT SILENTLY DROPPED, with the
    // child left polling a pane that no longer exists. `{"event":"pane_exited",
    // "data":null}` was accepted as valid and did nothing.
    //
    // It is the same mistake this whole change is about, arriving through the
    // validator instead of through `kill()`: a MISSING fact coerced into a
    // well-formed EMPTY one, so `unknown` rides the branch reserved for
    // `known-and-empty`. `{"event":"x","data":{}}` is genuinely empty and stays
    // valid; the four non-object forms are unknown and must reach the teardown.
    const data = asObject(o['data'])
    if (data === undefined) return undefined
    return { kind: 'event', event: o['event'], data }
  }
  // A reply must carry an id AND EXACTLY ONE well-formed outcome. `id: ''` is
  // legitimate — the server sends it when it could not parse our request well enough
  // to echo one.
  //
  // THE DEFECT THIS REPLACES — the third appearance of one mistake. The test was
  // `('result' in o || 'error' in o)`: PRESENCE of a key, with no check on what it
  // held and no objection to both. So `{"id":"n1","error":"refused"}` — a string
  // error, which the protocol never sends — was accepted as a valid reply; `asObject`
  // in the dispatcher then turned it into `undefined`, the error branch was skipped,
  // and the request RESOLVED SUCCESSFULLY with `{}`. A `pane.close` the server
  // REFUSED was reported to `kill()` as acknowledged.
  //
  // That is the same defect as the failed close, one layer down — through the
  // transport instead of the promise — and the same defect as the event `data`
  // coercion, through a third door. The common cause is worth stating plainly:
  // `{}` WAS BEING USED AS THE REPRESENTATION OF "NOTHING USABLE", and `{}` is
  // indistinguishable from a legitimate empty success. An unknown must never be
  // spelled the same way as a known.
  //
  // So: exactly one outcome, and it must be a plain object. `result: {}` is a real
  // empty success and stays valid; a primitive, `null`, an array, a missing outcome,
  // or BOTH outcomes are all unknowns and must reach the teardown.
  if (typeof o['id'] === 'string') {
    const hasResult = 'result' in o
    const hasError = 'error' in o
    // Exactly one. Both is not "helpfully redundant" — it means we cannot tell
    // whether the call succeeded, which is the one thing the caller asked.
    if (hasResult === hasError) return undefined
    if (hasResult) {
      const result = asObject(o['result'])
      if (result === undefined) return undefined
      return { kind: 'reply', id: o['id'], ok: true, result }
    }
    const error = asObject(o['error'])
    if (error === undefined) return undefined
    return { kind: 'reply', id: o['id'], ok: false, error }
  }
  return undefined
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
  /** The unanswered-RPC clock. Cleared the moment the reply lands, so at most one
   *  timer exists per in-flight request. */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** The minimal socket shape this client consumes, so the module type-checks
 *  without depending on Bun's ambient socket generics.
 *
 *  `write` RETURNS THE NUMBER OF BYTES ACCEPTED, which may be fewer than offered
 *  when the kernel buffer is full — see {@link HerdrClient.call}. */
interface SocketLike {
  write(data: string): number
  end(): void
}

/**
 * A live connection to a herdr server. Construct via {@link connectHerdr} — the
 * constructor deliberately does not connect, so the version gate cannot be
 * bypassed by instantiating the class directly.
 */
export class HerdrClient implements HerdrRpc {
  constructor(
    /** How long one RPC may go unanswered before the transport is torn down. */
    private readonly rpcTimeoutMs: number = HERDR_RPC_TIMEOUT_MS,
    /** Largest unterminated inbound frame to buffer. Injectable so a test can drive
     *  the at-limit and one-over boundaries without allocating 8 MiB. */
    private readonly maxFrameBytes: number = HERDR_MAX_FRAME_BYTES,
  ) {}

  private seq = 0
  /** Undecoded inbound bytes — never a string, so a split multi-byte character
   *  cannot be decoded twice. See {@link HerdrClient.onBytes}. */
  /**
   * Inbound bytes not yet formed into a complete frame, held as a QUEUE rather than
   * one growing Buffer.
   *
   * WHY NOT `Buffer.concat` PER CHUNK. That copied the entire accumulation on every
   * delivery, so cost was quadratic in the number of chunks: against the 8 MiB cap,
   * one-byte deliveries force on the order of 35 TB of cumulative copying before the
   * cap ever trips. THE SIZE CAP BOUNDS RETENTION AND SAYS NOTHING ABOUT CPU, which
   * is the resource actually exhausted — a limit on how much you KEEP is not a limit
   * on how much you DO, and the cap looked like it covered the hostile case while
   * covering half of it.
   *
   * Queued chunks are concatenated ONCE, only when a newline actually arrives, so a
   * peer that never terminates a frame costs O(bytes) in total rather than O(bytes²).
   */
  private chunks: Buffer[] = []

  /** Total bytes across {@link chunks}; tracked so the bound never needs a concat. */
  private pendingLength = 0
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, Set<HerdrEventHandler>>()
  private closed = false
  private socket: SocketLike | undefined

  /** The protocol version the server reported at connect. */
  serverProtocol = 0
  /** The server version string the server reported at connect. */
  serverVersion = ''

  /** @internal — wired by {@link connectHerdr}. */
  attach(socket: SocketLike): void {
    this.socket = socket
  }

  /**
   * @internal — feed raw BYTES from the socket.
   *
   * BYTES ARE DECODED EXACTLY ONCE, AT A POINT WHERE THE BYTE STREAM IS KNOWN TO BE
   * COMPLETE. This used to take an already-decoded string, and the transport called
   * `d.toString()` on every arbitrary socket chunk — so a multi-byte character split
   * across two chunks decoded as two U+FFFD, once per half. The JSON still PARSED,
   * so nothing failed: pane text and server error messages corrupted silently.
   *
   * Buffering bytes and decoding per LINE is safe because the frame delimiter is
   * `\n` = 0x0A, and a UTF-8 continuation byte is always ≥ 0x80 — so the newline
   * byte can never occur inside a multi-byte sequence, and a line boundary is always
   * a character boundary. (`session-size-watchdog.ts` reaches for the same Buffer
   * discipline on transcript files, for the same reason.)
   */
  onBytes(chunk: Uint8Array): void {
    // A CLOSED TRANSPORT ACCEPTS NOTHING. This is the same rule as the three above it
    // — once a terminal state is settled, no later path may rewrite it — enforced at
    // the EDGE rather than in the host's bookkeeping.
    //
    // THE DEFECT THIS REPLACES: `onBytes` buffered and dispatched unconditionally, so
    // bytes arriving after `close()` still parsed into a valid frame and still invoked
    // subscription handlers. The event that matters is precisely `pane_exited`: the
    // host's handler calls `settleExit`, so a post-close frame could re-open the exact
    // question the close had just settled. `settleExit` closing the client is a
    // meaningless guarantee if the socket can keep writing into the host afterwards.
    //
    // It also un-did teardown's other job. Teardown releases the queue because it
    // may hold up to `maxFrameBytes`; with no guard here, chunks arriving afterwards
    // simply started accumulating again — the buffer teardown claims to have released
    // grew back, unbounded by anything that would ever read it.
    if (this.closed) return
    // `Buffer.from(Uint8Array)` copies, so the socket may reuse its buffer.
    const buf = Buffer.from(chunk)
    if (buf.length === 0) return

    // FAST PATH: no frame completes in this chunk, so there is nothing to parse and
    // no reason to touch what is already queued. Cost is O(this chunk). This is the
    // path a hostile peer drives, and it is the one that used to be quadratic.
    //
    // Scanning only the NEW chunk is sound because the loop below drains every
    // complete frame it can see, so whatever remains queued is newline-free by
    // construction.
    const firstNewline = buf.indexOf(NEWLINE_BYTE)
    this.chunks.push(buf)
    this.pendingLength += buf.length
    if (firstNewline < 0) {
      // The unterminated bound, enforced on the RUNNING TOTAL — no concat needed to
      // ask the question. `>` not `>=`: a frame exactly at the limit is legitimate.
      if (this.pendingLength > this.maxFrameBytes) this.failUnterminated()
      return
    }

    // A frame completes here, so materialise the queue — ONCE, not once per chunk.
    const bytes =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.pendingLength)
    this.chunks = []
    this.pendingLength = 0

    // THE ORDER BELOW IS THE POINT, and it was wrong. A guard must run BEFORE the
    // thing it guards. The size bound lived after the loop, checking only what was
    // left UNTERMINATED — so a complete oversized frame was decoded, parsed and
    // dispatched, and by the time the check ran the buffer was empty. The bound
    // guarded ACCUMULATION and not A FRAME, leaving the exposure it was added to
    // close wide open for any oversized frame that arrived with its newline.
    //
    // Deliberate order, once per frame:
    //   1. SIZE, on bytes, before anything reads the frame's content.
    //   2. decode the complete line (one decode, at a known character boundary).
    //   3. parse, then validate the envelope — both necessarily after the decode,
    //      because you cannot parse bytes you have not decoded. That ordering is
    //      inherited but correct; the size check's was not.
    //
    // `start` is a CURSOR, not a re-slice. The previous version rebuilt the buffer
    // after every frame (`Buffer.from(subarray(nl + 1))`), which made a batch of N
    // frames in one delivery quadratic too — the same defect as the append, one loop
    // further in.
    let start = 0
    for (;;) {
      const nl = bytes.indexOf(NEWLINE_BYTE, start)
      if (nl < 0) break
      // (1) SIZE FIRST. The frame's byte length, excluding the delimiter.
      const frameBytes = nl - start
      if (frameBytes > this.maxFrameBytes) {
        this.teardown(
          new Error(
            `herdr: inbound frame of ${frameBytes} bytes exceeds the ${this.maxFrameBytes}-byte limit — ` +
              `refusing to decode or dispatch it. Treating the transport as failed rather than ` +
              `processing a frame this client will not accept.`,
          ),
        )
        return
      }
      // (2) A COMPLETE line — decode it, and only it.
      const line = bytes.toString('utf8', start, nl)
      start = nl + 1
      if (line.trim() === '') continue
      // (3) parse + envelope validation live in `dispatch`.
      this.dispatch(line)
      if (this.closed) return // a frame tore the transport down
    }

    // WHAT REMAINS IS UNTERMINATED. A frame is normally small, which is exactly why
    // no bound was written — but "normally small" is an expectation, not a limit. A
    // peer that never sends `0x0A` would grow this buffer until exhaustion, and the
    // RPC clock cannot help because bytes keep arriving whether or not a request is
    // waiting. Well-formed-so-far is not complete.
    if (start < bytes.length) {
      // COPY the tail rather than keeping a view: `subarray` retains the whole parent
      // allocation, so a 1-byte remainder of an 8 MiB delivery would pin 8 MiB.
      const tail = Buffer.from(bytes.subarray(start))
      this.chunks = [tail]
      this.pendingLength = tail.length
      if (this.pendingLength > this.maxFrameBytes) this.failUnterminated()
    }
  }

  /** The unterminated-frame bound, shared by both paths that can reach it. */
  private failUnterminated(): void {
    this.teardown(
      new Error(
        `herdr: inbound frame exceeded ${this.maxFrameBytes} bytes with no newline ` +
          `(${this.pendingLength} buffered) — the peer is not speaking this framing. Treating the ` +
          `transport as failed rather than buffering until exhaustion.`,
      ),
    )
  }

  private dispatch(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A frame we cannot parse is not attributable to one request, and the stream
      // position is now UNTRUSTWORTHY — we cannot know whether the rest of the
      // buffer is a frame boundary or the middle of one.
      //
      // So the connection is TERMINAL, not merely disrupted. An earlier version
      // failed the in-flight calls and left `closed === false`, so subsequent RPCs
      // went out over the very stream this branch had just declared unusable — the
      // same shape as the short write: the code knows the channel is broken and
      // keeps using it. `onClose` fails everything pending AND flips `isClosed()`,
      // which the host reads as `'transport-lost'`.
      this.teardown(
        new Error(
          `herdr: unparseable frame from server, so the stream position is no longer ` +
            `known — treating the transport as failed: ${line.slice(0, 200)}`,
        ),
      )
      return
    }
    // PARSED IS NOT THE SAME AS VALID. A frame that matches neither envelope is one
    // this client cannot act on, and it leaves the same question a parse failure does:
    // whether the peer is speaking this protocol at all. Same teardown.
    const env = classifyEnvelope(parsed)
    if (env === undefined) {
      this.teardown(
        new Error(
          `herdr: frame parsed but matches no known envelope (expected {event,data} or ` +
            `{id,result|error}) — treating the transport as failed: ${line.slice(0, 200)}`,
        ),
      )
      return
    }
    if (env.kind === 'event') {
      const data = env.data
      const set = this.handlers.get(env.event)
      if (set !== undefined) {
        for (const h of [...set]) {
          try {
            h(data)
          } catch {
            // A throwing handler must not stop the others or kill the read loop.
          }
        }
      }
      return
    }
    const id = env.id
    // Already validated by `classifyEnvelope`: exactly one outcome, and a plain
    // object. No `asObject` here — re-deriving it was how a refused call became a
    // successful one, because a failed conversion silently selected the success path.
    const err = env.ok ? undefined : (env.error as { code?: unknown; message?: unknown })
    const p = this.pending.get(id)
    if (p === undefined) {
      // No such request in flight. This is the `id: ""` case a malformed request
      // produces: the server could not read our id, so it cannot tell us which
      // request failed. Failing all pending is the only option that terminates.
      if (err !== undefined) {
        this.failAll(
          new HerdrError(
            typeof err.code === 'string' ? err.code : 'unknown',
            typeof err.message === 'string' ? err.message : JSON.stringify(err),
          ),
        )
      }
      return
    }
    this.pending.delete(id)
    if (p.timer !== undefined) clearTimeout(p.timer)
    if (err !== undefined) {
      p.reject(
        new HerdrError(
          typeof err.code === 'string' ? err.code : 'unknown',
          typeof err.message === 'string' ? err.message : JSON.stringify(err),
        ),
      )
      return
    }
    // No fallback, and none is reachable: `env.ok` is the validator's guarantee, so
    // the success path has a real object or this line does not run. The `?? {}` that
    // used to stand here is what made "no usable result" and "an empty success" the
    // same value.
    if (!env.ok) return
    p.resolve(env.result)
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(err)
    }
  }

  /**
   * THE SINGLE TEARDOWN. Idempotent, and it actually tears down.
   *
   * "Terminal" used to be a FLAG: `onClose` set `closed = true` and rejected the
   * pending calls, but only `close()` called `socket.end()` — and `close()` returns
   * early when `closed` is already true. So every path that went through `onClose`
   * (a malformed frame, a short write) marked the client closed and LEFT THE SOCKET
   * OPEN until the peer happened to close it, while the as-built claimed those paths
   * killed the connection. Asserting `isClosed()` could not see the difference,
   * because the flag is the SYMPTOM of teardown rather than the teardown — the same
   * mistake as testing a bound instead of retention.
   *
   * Every terminal route calls exactly this: socket ended ONCE, every pending
   * request rejected, flag set.
   */
  private teardown(err: Error): void {
    if (this.closed) return
    // Set before `failAll`, deliberately — but NOT load-bearing today, and saying so
    // is the honest version. `failAll` only calls `p.reject()`, and a promise's
    // rejection handler runs as a MICROTASK: it cannot execute inside `failAll`, so by
    // the time any caller re-enters this client, `teardown` has already returned and
    // the flag is set under either ordering. A mutation that moves this line below
    // `failAll` SURVIVES the suite, which is the proof rather than the suspicion.
    //
    // It stays here because it costs nothing and it is the ordering that remains
    // correct if `failAll` ever gains a SYNCHRONOUS callback — at which point the
    // difference becomes real and observable. What IS load-bearing and is tested: a
    // re-entrant call from a rejection handler is refused, and `teardown`'s own early
    // return makes it idempotent.
    this.closed = true
    try {
      this.socket?.end()
    } catch {
      // best-effort: the socket may already be gone, which is often why we are here.
    }
    // Release the inbound buffer: after teardown nothing will ever read it, and it
    // may be holding up to HERDR_MAX_FRAME_BYTES.
    this.chunks = []
    this.pendingLength = 0
    this.failAll(err)
  }

  /** @internal — the socket closed or errored. */
  onClose(err?: Error): void {
    this.teardown(err ?? new Error('herdr: socket closed'))
  }

  /** True once the connection is gone. */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Bytes currently held in the inbound frame buffer.
   *
   * Exposed because teardown's promise to RELEASE this buffer is otherwise
   * unobservable, and unobservable state cannot be tested, only believed — the same
   * reason the two kill flags collapsed into one. It is the only way to assert that
   * a closed client accumulates nothing.
   */
  bufferedBytes(): number {
    return this.pendingLength
  }

  /**
   * Bytes of ALLOCATION the queue is holding alive, which is not the same number as
   * {@link bufferedBytes}.
   *
   * A `subarray` is a VIEW: it keeps its parent allocation alive, so a 1-byte
   * remainder of an 8 MiB delivery pins 8 MiB while reporting a logical length of 1.
   * That is the same shape as the defect this whole change is about — a quantity that
   * looks bounded because the number you are watching is bounded — so the retained
   * size gets its own observable rather than being taken on trust.
   */
  retainedBytes(): number {
    let total = 0
    for (const c of this.chunks) total += c.buffer.byteLength
    return total
  }

  /**
   * Issue one request and resolve with its `result` object.
   *
   * A SHORT WRITE IS A TERMINAL TRANSPORT FAILURE, not something to shrug at.
   * `write` returns the bytes it ACCEPTED; a socket whose buffer is full can take
   * zero, or half a frame. Discarding that count — which this did — leaves a pending
   * promise whose request never fully reached the server: a HANG, not an error, and
   * the one shape `'transport-lost'` did not previously cover, because the socket is
   * still open, nothing threw and nothing closed. The bytes simply did not all go.
   *
   * We do NOT queue and retry the remainder. Correct partial-frame resumption is
   * real work, and a transport that cannot accept a frame is not one this host
   * should keep driving a REPL over. So a short write fails THIS call and kills the
   * connection, which reaches the host through `isClosed()` as its existing
   * `'transport-lost'` route.
   *
   * The comparison is against the frame's BYTE length, not its string length, and
   * the direction of that error is the dangerous one. `String.length` counts UTF-16
   * code units, which for any non-ASCII frame is SMALLER than the bytes on the wire
   * — so comparing against it makes the check too LAX, not too strict: a socket that
   * accepted 42 of 45 bytes on a 40-unit frame is genuinely short, and
   * `42 < 40` is false, so it sails through and hangs exactly as before. An argv,
   * cwd or env value with one accented character is enough to open that gap.
   */
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(`herdr: call('${method}') on a closed connection`))
    const sock = this.socket
    if (sock === undefined) return Promise.reject(new Error(`herdr: call('${method}') before attach`))
    const id = `n${(this.seq += 1)}`
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, timer: undefined })
      const frame = `${JSON.stringify({ id, method, params })}\n`
      const expected = Buffer.byteLength(frame, 'utf8')
      let written: number
      try {
        written = sock.write(frame)
      } catch (e) {
        // A THROWN write is the third route to "the channel is not working", and it
        // used to reject only THIS request and leave the client open — so other
        // in-flight requests never settled and later calls went out over a socket
        // that had just refused one. Same teardown as the other two.
        const cause = e instanceof Error ? e : new Error(String(e))
        const err = new Error(
          `herdr: write threw on '${method}' (${cause.message}) — the request never reached the ` +
            `server. Treating the transport as failed rather than leaving requests that can never ` +
            `be answered.`,
        )
        this.pending.delete(id)
        reject(err)
        this.teardown(err)
        return
      }
      if (written < expected) {
        this.pending.delete(id)
        const err = new Error(
          `herdr: short write on '${method}' — the socket accepted ${written} of ${expected} bytes, ` +
            `so this request never fully reached the server. Treating the transport as failed rather ` +
            `than leaving a request that can never be answered.`,
        )
        reject(err)
        // Terminal for the whole connection: ends the socket, fails every other
        // in-flight request, and flips `isClosed()` — which the host reads as
        // `'transport-lost'`.
        this.teardown(err)
        return
      }
      // THE FRAME WENT OUT WHOLE. Nothing has gone wrong, and nothing may ever
      // arrive — so arm a clock. Without it this promise is unbounded: a socket that
      // accepts every byte and answers nothing hangs `connectHerdr`'s handshake ping
      // (the gateway never finishes starting) and stalls the poll loop's
      // `pane.read`, with `isClosed()` cheerfully false throughout.
      const entry = this.pending.get(id)
      if (entry !== undefined) {
        entry.timer = setTimeout(() => {
          this.teardown(
            new Error(
              `herdr: '${method}' went unanswered for ${this.rpcTimeoutMs}ms — the frame was written ` +
                `in full and the server produced no reply, no error and no close. Treating the ` +
                `transport as failed rather than waiting forever.`,
            ),
          )
        }, this.rpcTimeoutMs)
      }
    })
  }

  /** Register a handler for a subscription event kind, and ask the server for it.
   *  Returns an unsubscribe for the local handler (herdr has no per-subscription
   *  teardown; dropping the connection is the teardown). */
  async subscribe(
    kind: string,
    subscription: Record<string, unknown>,
    handler: HerdrEventHandler,
  ): Promise<() => void> {
    // REGISTER BEFORE ASKING, because an event can arrive between our request and its
    // acknowledgement and the host subscribes to `pane_exited` precisely so that an
    // exit DURING STARTUP is still observed. Registering after the ack would open a
    // window in which the one event we cannot afford to miss is dropped.
    let set = this.handlers.get(kind)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(handler)
    try {
      await this.call('events.subscribe', { subscriptions: [subscription] })
    } catch (e) {
      // ...AND UNREGISTER IF THE ASK FAILED. Registering early is a deliberate race
      // win, not a licence to leave the handler behind: a rejected subscribe returns
      // no unsubscribe function, so the caller has no way to remove it and believes
      // it was never subscribed. A handler nobody can reach but the dispatcher still
      // calls is the same class of defect as the one above — state outliving the
      // operation that created it.
      this.handlers.get(kind)?.delete(handler)
      throw e
    }
    return () => {
      this.handlers.get(kind)?.delete(handler)
    }
  }

  /** Ask the server for its version + protocol. */
  async ping(): Promise<HerdrPong> {
    const r = await this.call('ping', {})
    const protocol = r['protocol']
    const version = r['version']
    if (typeof protocol !== 'number' || typeof version !== 'string') {
      throw new Error(`herdr: ping returned no version/protocol: ${JSON.stringify(r).slice(0, 200)}`)
    }
    return { type: 'pong', version, protocol }
  }

  /** Close the connection. Idempotent — one path, {@link HerdrClient.teardown}. */
  close(): void {
    this.teardown(new Error('herdr: connection closed by us'))
  }
}

/** How a {@link connectHerdr} caller reaches a socket. Injectable so the gate and
 *  the framing are testable without a live herdr server. */
export interface HerdrConnectOpts {
  /** Unix socket path. Defaults to `$HERDR_SOCKET_PATH`. */
  socketPath?: string
  /** Override the transport (tests). Must call `client.onBytes` / `client.onClose`. */
  connect?: (path: string, client: HerdrClient) => Promise<SocketLike>
  /** Protocol version to require. Defaults to {@link HERDR_PROTOCOL_VERSION}. */
  expectProtocol?: number
  /** How long one RPC may go unanswered before teardown. Defaults to
   *  {@link HERDR_RPC_TIMEOUT_MS}; a test shortens it. Covers the handshake `ping`,
   *  which is why a hung server cannot wedge `connectHerdr` any more. */
  rpcTimeoutMs?: number
  /** Largest unterminated inbound frame to buffer. Defaults to
   *  {@link HERDR_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number
}

async function connectUnix(path: string, client: HerdrClient): Promise<SocketLike> {
  const bunConnect = (
    Bun as unknown as {
      connect: (opts: Record<string, unknown>) => Promise<SocketLike>
    }
  ).connect
  return await bunConnect({
    unix: path,
    socket: {
      // RAW BYTES, never `d.toString()`: decoding per socket chunk splits multi-byte
      // characters at arbitrary boundaries. The client decodes complete lines.
      data: (_s: unknown, d: Uint8Array) => {
        client.onBytes(d)
      },
      close: () => {
        client.onClose()
      },
      error: (_s: unknown, e: Error) => {
        client.onClose(e)
      },
    },
  })
}

/**
 * Connect to herdr and VERIFY THE PROTOCOL before returning. Throws when the
 * socket path is unset, when the connection fails, or — the reason this function
 * exists — when the server's protocol version is not the one this client was
 * measured against.
 */
export async function connectHerdr(opts: HerdrConnectOpts = {}): Promise<HerdrClient> {
  const socketPath = opts.socketPath ?? process.env[HERDR_SOCKET_ENV]
  if (socketPath === undefined || socketPath === '') {
    throw new Error(
      `herdr: ${HERDR_SOCKET_ENV} is unset — there is no herdr server to host the REPL on`,
    )
  }
  const client = new HerdrClient(
    opts.rpcTimeoutMs ?? HERDR_RPC_TIMEOUT_MS,
    opts.maxFrameBytes ?? HERDR_MAX_FRAME_BYTES,
  )
  const socket = await (opts.connect ?? connectUnix)(socketPath, client)
  client.attach(socket)
  const expected = opts.expectProtocol ?? HERDR_PROTOCOL_VERSION
  let pong: HerdrPong
  try {
    pong = await client.ping()
  } catch (e) {
    client.close()
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (pong.protocol !== expected) {
    client.close()
    // FAIL LOUDLY. Both numbers are named because the actionable fact is the
    // delta: the server moved, this client did not, and nothing downstream can
    // detect that on its own.
    throw new Error(
      `herdr: protocol mismatch — server reports protocol ${pong.protocol} (herdr ${pong.version}), ` +
        `this client was written and measured against protocol ${expected}. Refusing to drive a REPL ` +
        `over an unverified protocol: the socket server does no version check of its own, so a ` +
        `semantic change would be silent. Re-measure the API and update HERDR_PROTOCOL_VERSION.`,
    )
  }
  client.serverProtocol = pong.protocol
  client.serverVersion = pong.version
  return client
}

/** Best-effort fire-and-forget close, for teardown paths that cannot await. */
export function closeHerdrQuietly(client: HerdrClient | undefined): void {
  if (client === undefined) return
  fireAndForget(
    'herdr-client.close',
    (async () => {
      client.close()
    })(),
  )
}
