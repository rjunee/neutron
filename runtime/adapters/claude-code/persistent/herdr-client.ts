/**
 * herdr-client.ts — ONE REQUEST, ONE REPLY, ONE CONNECTION.
 *
 * § herdr step 2b. This file used to hold a persistent multiplexing client:
 * request/reply correlated by `id` over a long-lived socket, plus subscription
 * events delivered to registered handlers. THAT CLIENT COULD NOT EXECUTE against the
 * server we run, and no test could have told us — every fake modelled a persistent
 * connection, and the live proofs are opt-in and skipped in CI.
 *
 * MEASURED against herdr 0.8.2 / protocol 20 on the live socket:
 *
 *  • The server answers EXACTLY ONE request per connection and then closes it. Two
 *    `ping` frames pipelined in the same tick get ONE reply, with the socket gone
 *    1 ms later — so it is not an idle timeout. Sending again raises a broken pipe.
 *  • Every method works as the FIRST request on a fresh connection. `layout.apply`,
 *    `pane.read`, `pane.close`, `pane.get`, `pane.process_info`, `pane.list` all
 *    answered that way.
 *  • A fresh connection costs **2.02 ms** (mean of 60: connect + send + reply +
 *    close, over the unix socket).
 *
 * So the transport is a request/response RPC, and this client is the shape that
 * matches it. What that deletes is as important as what it adds: there is no
 * long-lived socket to lose, so there is no transport-loss branch, no post-close
 * dispatch, no teardown-of-pending, no settle-on-absence class, and no event
 * envelope. A connection that ends is not an event — it is how every exchange ends.
 *
 * WHAT IS KEPT, because it is about a single reply and still applies: the inbound
 * frame bound enforced BEFORE the bytes are copied, one decode per complete line at a
 * known character boundary, and an envelope that must carry exactly one well-formed
 * outcome. A protocol bump is still the hazard those exist for.
 *
 * THE VERSION GATE MOVED, it did not go. Pinging before every call would double the
 * cost of every operation, so {@link herdrPing} is called ONCE by the host at spawn.
 * The server's protocol cannot change under a running host without restarting herdr,
 * and herdr's panes are its children — a restart takes the REPLs with it, so there is
 * no version drift to detect mid-session that would leave a REPL to supervise.
 */

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

/** First allocation for a reply buffer. Most replies are a few hundred bytes; growth
 *  from here is amortised doubling. */
const INITIAL_REPLY_BUFFER_BYTES = 4096

/** The socket-path env var herdr injects into every managed pane. */
export const HERDR_SOCKET_ENV = 'HERDR_SOCKET_PATH'

/** A typed error from the server: `{error:{code,message}}`. `code` is what callers
 *  branch on — `pane_not_found` above all, which is POSITIVE absence. */
export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HerdrError'
  }
}

/**
 * The RPC seam the host depends on.
 *
 * Deliberately ONE method. There is no `close` (each call closes its own connection)
 * and no `subscribe` (a subscription needs a connection that outlives a request, and
 * the host no longer keeps one — exit is discovered by polling, which cannot be
 * missed, replayed, or delivered for somebody else's pane).
 */
export interface HerdrRpc {
  call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** The minimal socket shape this module consumes, so it type-checks without Bun's
 *  ambient socket generics. `write` returns the bytes accepted. */
interface SocketLike {
  write(data: string): number
  end(): void
}

interface SocketHandlers {
  onBytes: (d: Uint8Array) => void
  onClose: (e?: Error) => void
}

export interface HerdrCallOpts {
  /** Protocol the caller was measured against; {@link herdrPing} gates on it. */
  expectProtocol?: number
  /** Defaults to `$HERDR_SOCKET_PATH`. */
  socketPath?: string
  /** Per-call deadline. A request that is never answered must not wait forever. */
  timeoutMs?: number
  /** Largest reply this client will assemble. */
  maxFrameBytes?: number
  /** Socket opener, injected by tests. */
  connect?: (path: string, handlers: SocketHandlers) => Promise<SocketLike>
}

/** A plain (non-null, non-array) object, or `undefined`. */
function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * Validate a parsed reply and return its outcome.
 *
 * EXACTLY ONE well-formed outcome, and it must be a plain object. Presence of a key
 * is not the check: a string `error` once passed a presence test, failed the object
 * conversion downstream, skipped the error branch, and RESOLVED the call with `{}` —
 * a refused `pane.close` reported as acknowledged. `result:{}` is a real empty
 * success and stays valid; a primitive, `null`, an array, a missing outcome, or BOTH
 * outcomes are unknowns and must be refused.
 */
function classifyReply(
  parsed: unknown,
): { ok: true; result: Record<string, unknown> } | { ok: false; error: Record<string, unknown> } | undefined {
  const o = asObject(parsed)
  if (o === undefined) return undefined
  if (typeof o['id'] !== 'string') return undefined
  const hasResult = 'result' in o
  const hasError = 'error' in o
  if (hasResult === hasError) return undefined
  if (hasResult) {
    const result = asObject(o['result'])
    return result === undefined ? undefined : { ok: true, result }
  }
  const error = asObject(o['error'])
  return error === undefined ? undefined : { ok: false, error }
}

async function connectUnix(path: string, handlers: SocketHandlers): Promise<SocketLike> {
  const bunConnect = (
    Bun as unknown as { connect: (opts: Record<string, unknown>) => Promise<SocketLike> }
  ).connect
  return await bunConnect({
    unix: path,
    socket: {
      // RAW BYTES, never `d.toString()`: decoding per socket chunk splits multi-byte
      // characters at arbitrary boundaries. Complete lines are decoded below.
      data: (_s: unknown, d: Uint8Array) => handlers.onBytes(d),
      close: () => handlers.onClose(),
      error: (_s: unknown, e: Error) => handlers.onClose(e),
    },
  })
}

function resolveSocketPath(opts: HerdrCallOpts): string {
  const socketPath = opts.socketPath ?? process.env[HERDR_SOCKET_ENV]
  if (socketPath === undefined || socketPath === '') {
    throw new Error(
      `herdr: no socket path — set ${HERDR_SOCKET_ENV} or pass socketPath. herdr injects ` +
        `this into every managed pane, so an empty value means we are not running under one.`,
    )
  }
  return socketPath
}

/** How one call ended. The pending call is settled by RESOLVING this — never by
 *  rejecting — so the promise cannot be an unhandled rejection during the window
 *  between its creation and the `await` at the bottom of {@link herdrCall}. The
 *  failure is turned back into a `throw` there, where a handler exists. */
type CallOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: Error }

/**
 * Issue ONE request on ITS OWN connection and resolve with the reply's `result`.
 *
 * The connection is opened, written once, read until the first newline, and closed —
 * which is also what the server does from its side. Rejection means the call did not
 * succeed: a refused connect, a short or thrown write, a deadline, a malformed frame,
 * or a typed server error ({@link HerdrError}).
 */
export async function herdrCall(
  method: string,
  params: Record<string, unknown>,
  opts: HerdrCallOpts = {},
): Promise<Record<string, unknown>> {
  const socketPath = resolveSocketPath(opts)
  const timeoutMs = opts.timeoutMs ?? HERDR_RPC_TIMEOUT_MS
  const maxFrameBytes = opts.maxFrameBytes ?? HERDR_MAX_FRAME_BYTES
  const frame = `${JSON.stringify({ id: 'r', method, params })}\n`

  let settled = false
  let socket: SocketLike | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // ONE buffer, grown by doubling. A reply may arrive in any number of chunks, and
  // the fragment count must not become a quantity this code holds: bytes are copied
  // in and the delivered chunk is dropped.
  let buf = Buffer.alloc(0)
  let end = 0

  let settle!: (outcome: CallOutcome) => void
  const pending = new Promise<CallOutcome>((resolve) => {
    settle = resolve
  })

  const finish = (err: Error | undefined, value?: Record<string, unknown>): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    try {
      socket?.end()
    } catch {
      /* the server closes its side anyway */
    }
    settle(err !== undefined ? { ok: false, error: err } : { ok: true, result: value ?? {} })
  }

  const onBytes = (chunk: Uint8Array): void => {
    if (settled) return
    // BOUND BEFORE COPYING. The limit exists to stop us allocating for a reply we
    // will not accept, so it cannot run after the allocation it guards.
    if (end + chunk.length > maxFrameBytes) {
      finish(
        new Error(
          `herdr: reply to '${method}' exceeded ${maxFrameBytes} bytes — refusing to assemble it.`,
        ),
      )
      return
    }
    if (end + chunk.length > buf.length) {
      let capacity = Math.max(buf.length * 2, INITIAL_REPLY_BUFFER_BYTES)
      while (capacity < end + chunk.length) capacity *= 2
      const grown = Buffer.allocUnsafe(capacity)
      buf.copy(grown, 0, 0, end)
      buf = grown
    }
    buf.set(chunk, end)
    end += chunk.length
    const nl = buf.indexOf(NEWLINE_BYTE, 0)
    if (nl < 0 || nl >= end) return // reply not complete yet

    const line = buf.toString('utf8', 0, nl)
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      finish(
        new Error(
          `herdr: unparseable reply to '${method}' — the stream position is no longer known: ${line.slice(0, 200)}`,
        ),
      )
      return
    }
    const outcome = classifyReply(parsed)
    if (outcome === undefined) {
      finish(
        new Error(
          `herdr: reply to '${method}' matched no known envelope (an id plus exactly one ` +
            `object-valued result or error): ${line.slice(0, 200)}`,
        ),
      )
      return
    }
    if (!outcome.ok) {
      const e = outcome.error as { code?: unknown; message?: unknown }
      finish(
        new HerdrError(
          typeof e.code === 'string' ? e.code : 'unknown',
          typeof e.message === 'string' ? e.message : JSON.stringify(e),
        ),
      )
      return
    }
    finish(undefined, outcome.result)
  }

  const onClose = (e?: Error): void => {
    // The server closes after answering, so a close AFTER we have settled is normal
    // and silent. A close BEFORE is the request dying unanswered.
    finish(
      e ??
        new Error(
          `herdr: connection closed before '${method}' was answered — the server accepted the ` +
            `request and produced no reply.`,
        ),
    )
  }

  timer = setTimeout(() => {
    finish(
      new Error(
        `herdr: '${method}' went unanswered for ${timeoutMs}ms — treating the call as failed ` +
          `rather than waiting forever.`,
      ),
    )
  }, timeoutMs)

  // The connect is AWAITED, not fired and forgotten: a refused connect is a failed
  // call, and its rejection has to reach `finish` rather than being dropped.
  try {
    const s = await (opts.connect ?? connectUnix)(socketPath, { onBytes, onClose })
    if (settled) {
      // The deadline (or a synchronous failure) already ended the call while the
      // connect was in flight. Hand the socket straight back.
      try {
        s.end()
      } catch {
        /* nothing to do */
      }
    } else {
      socket = s
      const expected = Buffer.byteLength(frame, 'utf8')
      const written = s.write(frame)
      // A SHORT OR REFUSED WRITE IS A FAILED CALL, not a partial one: the server
      // frames on newlines, so a truncated request can never be answered.
      if (written < expected) {
        finish(
          new Error(
            `herdr: short write on '${method}' — the socket accepted ${written} of ${expected} ` +
              `bytes, so this request never fully reached the server.`,
          ),
        )
      }
    }
  } catch (e) {
    finish(e instanceof Error ? e : new Error(String(e)))
  }

  const outcome = await pending
  if (!outcome.ok) throw outcome.error
  return outcome.result
}

/** Bind {@link herdrCall} to a set of options, giving the host one {@link HerdrRpc}
 *  whose every call is its own connection. */
export function createHerdrRpc(opts: HerdrCallOpts = {}): HerdrRpc {
  return {
    call: (method, params) => herdrCall(method, params, opts),
  }
}

/**
 * Verify the server's protocol version, ONCE, before anything is spawned.
 *
 * The socket server does NO protocol check of its own — only herdr's CLI guards — and
 * the protocol moved 20 → 22 in 19 days. A server that has moved on answers our
 * requests with different semantics underneath a supervisor that cannot tell. So this
 * throws on any mismatch: not a warning, not a degraded mode.
 */
export async function herdrPing(opts: HerdrCallOpts = {}): Promise<HerdrPong> {
  const expected = opts.expectProtocol ?? HERDR_PROTOCOL_VERSION
  const result = await herdrCall('ping', {}, opts)
  const protocol = result['protocol']
  const version = result['version']
  if (typeof protocol !== 'number' || typeof version !== 'string') {
    throw new Error(
      `herdr: ping reply carried no usable protocol/version (${JSON.stringify(result).slice(0, 160)}) — ` +
        `refusing to drive a server whose protocol cannot be established.`,
    )
  }
  if (protocol !== expected) {
    throw new Error(
      `herdr: protocol ${protocol} (server ${version}) is not the ${expected} this client was ` +
        `measured against — refusing to drive it. Every call below assumes 'measured on ${expected}' ` +
        `semantics, and a server that has moved on answers them differently with no error anywhere.`,
    )
  }
  return { type: 'pong', version, protocol } as HerdrPong
}
