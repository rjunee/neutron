/**
 * herdr-fake-server.ts — a scripted stand-in for a herdr server, shared by the
 * herdr host/client suites.
 *
 * Answers the handful of methods `HerdrHost` calls, records every request so a
 * test can assert what actually went over the wire (the `lines` a read asked for,
 * the key names a keystroke used), and lets a test make any method fail or a pane
 * disappear. Deliberately NOT a general herdr emulator: it should only be able to
 * answer what the host actually asks, so a host that started asking for something
 * new fails loudly here rather than being silently accommodated.
 */

import { HerdrError, type HerdrRpc } from '../herdr-client.ts'
import { HERDR_PANE_NOT_FOUND } from '../herdr-protocol.ts'

export interface FakeHerdrServerOpts {
  /** Pane id `layout.apply` hands back. Defaults to a fixed id. */
  paneId?: string
  /** `viewport_rows` reported by `pane.get`. Defaults to 62 (the measured value
   *  on the live server). `null` reports a pane with no scroll info. */
  viewportRows?: number | null
  /** `shell_pid` reported by `pane.process_info`. `null` means herdr never learns
   *  one — the shape that must make a spawn REFUSE rather than invent a pid. */
  shellPid?: number | null
}

export interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

/** A scripted herdr server plus the levers a test needs over it. */
export class FakeHerdrServer implements HerdrRpc {
  readonly calls: RecordedCall[] = []
  readonly paneId: string
  private closed = false
  /** MUTABLE: a pane can be resized at any time, and the bridge must notice. */
  viewportRows: number | null
  /** The pid `pane.process_info` reports. PUBLIC and mutable like the other levers:
   *  the transport-loss termination path is driven by this pid, so a test has to be
   *  able to choose one it can then decide the liveness of. */
  shellPid: number | null
  /** The pane's current screen, as `pane.read` will report it. */
  screen = ''
  /** When true, every `pane.read` REJECTS (a pane mid-teardown). */
  readFails = false
  /** When true, `pane.get` and `pane.read` reject with a TYPED `pane_not_found` —
   *  herdr positively reports the pane does not exist. */
  paneGone = false
  /** When true, `pane.get` and `pane.read` reject with an UNTYPED transient error.
   *  The pane is still there; the QUESTION failed. These must never be read as
   *  absence. */
  transientFailure = false
  /**
   * PER-METHOD FAILURE INJECTION, as a first-class property of this fake.
   *
   * A FAKE THAT CANNOT FAIL MAKES A WHOLE CLASS OF REQUIREMENT UNTESTABLE, and the
   * tests then pass because the fake is agreeable rather than because the code is
   * right. This has now cost three defects on this branch, each in a different
   * method: a no-op `end` hid a teardown that never closed the socket (r5), a
   * `write` that always returned `d.length` hid the short-write class (r6), and
   * `pane.close` succeeding unconditionally hid a failed kill reporting success
   * (r7). Each was fixed one method at a time, which is why there was a third.
   *
   * So failure is injectable for ANY method, not for the ones someone has needed so
   * far — otherwise the fourth is simply waiting on whichever method has not yet
   * needed to fail.
   */
  /** True once a `pane.close` has SUCCEEDED. A failed one must leave this false. */
  paneClosed = false

  private readonly failures = new Map<string, Error>()

  /** Make `method` reject until {@link clearFailure}. Default error is untyped, i.e.
   *  a transient failure; pass a `HerdrError` for a typed one. */
  failMethod(method: string, err?: Error): void {
    this.failures.set(method, err ?? new Error(`fake-herdr: ${method} refused`))
  }

  /** Stop failing `method`. */
  clearFailure(method: string): void {
    this.failures.delete(method)
  }

  private readonly malformed = new Map<string, Record<string, unknown>>()

  /**
   * Make `method` SUCCEED while returning `payload` instead of its real reply.
   *
   * The third lever, and the set is now complete: a call can fail
   * ({@link failMethod}), be slow ({@link holdMethod}), or answer with something the
   * caller cannot use. That last one is its own class — a successful RPC with an
   * unusable payload is neither an error nor an answer, and code that has only two
   * branches puts it in the wrong one. It is exactly how a same-version reply-shape
   * drift would arrive.
   */
  malformMethod(method: string, payload: Record<string, unknown>): void {
    this.malformed.set(method, payload)
  }

  /** Stop malforming `method`. */
  clearMalformed(method: string): void {
    this.malformed.delete(method)
  }

  private readonly holds = new Map<string, { promise: Promise<void>; fail: (e: Error) => void }>()

  /**
   * Make `method` HANG until the returned function is called. Latency is as real as
   * failure and needs the same first-class lever: a socket call is in flight for a
   * round trip, and the code under test has to be correct DURING that window, not
   * only at its two ends. A fake that always answers instantly collapses the window
   * to nothing and makes every in-flight property vacuously true.
   */
  holdMethod(method: string): () => void {
    let release: () => void = () => {}
    let fail: (e: Error) => void = () => {}
    const promise = new Promise<void>((res, rej) => {
      release = () => {
        this.holds.delete(method)
        res()
      }
      fail = (e: Error) => {
        this.holds.delete(method)
        rej(e)
      }
    })
    // The rejection path must exist because THE REAL TRANSPORT HAS IT: `close()` on
    // the real client runs `failAll`, so every in-flight RPC rejects. A fake whose
    // held call quietly succeeds after the connection closed cannot reproduce the
    // most interesting ordering there is — a request outliving the socket it was
    // sent on — and the code that mishandles it looks correct under test.
    promise.catch(() => {})
    this.holds.set(method, { promise, fail })
    return release
  }

  constructor(opts: FakeHerdrServerOpts = {}) {
    this.paneId = opts.paneId ?? 'w9:p1'
    this.viewportRows = opts.viewportRows === undefined ? 62 : opts.viewportRows
    this.shellPid = opts.shellPid === undefined ? 31337 : opts.shellPid
  }

  /** Every recorded call to `method`. */
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** The pane's process ends. NOTHING IS ANNOUNCED — the server has no way to tell a
   *  host that holds no long-lived connection, so this is discovered on the next poll
   *  as `pane_not_found`, which is exactly how the real one behaves. */
  exitPane(): void {
    this.paneGone = true
    this.readFails = true
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    if (this.closed) throw new Error('fake-herdr: call on a closed connection')
    // Held BEFORE the failure check, so a method can be made slow, slow-then-failing,
    // or simply failing.
    const hold = this.holds.get(method)
    if (hold !== undefined) await hold.promise
    // Injected failure BEFORE any method-specific behaviour, so every method can be
    // made to fail without this fake growing a flag per method.
    const injected = this.failures.get(method)
    if (injected !== undefined) throw injected
    // A malformed reply is a SUCCESS, so it is returned rather than thrown.
    const bad = this.malformed.get(method)
    if (bad !== undefined) return bad
    switch (method) {
      case 'ping':
        return { type: 'pong', version: '0.8.2', protocol: 20 }
      case 'layout.apply':
        // The real server REPLACES the tab and mints new ids, so the host must read
        // the pane id out of the reply. Hand back an id it could not have guessed.
        return { layout: { workspace_id: 'w9', tab_id: 'w9:t7', root: { pane_id: this.paneId } } }
      case 'pane.process_info':
        return {
          process_info:
            this.shellPid === null
              ? { pane_id: this.paneId }
              : { pane_id: this.paneId, shell_pid: this.shellPid, foreground_processes: [] },
        }
      case 'pane.get':
        if (this.transientFailure) throw new Error('fake-herdr: temporarily unavailable')
        if (this.paneGone) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        return {
          pane: {
            pane_id: this.paneId,
            scroll: this.viewportRows === null ? null : { viewport_rows: this.viewportRows },
          },
        }
      case 'pane.read': {
        if (this.transientFailure) throw new Error('fake-herdr: temporarily unavailable')
        if (this.readFails) {
          throw this.paneGone
            ? new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
            : new Error('fake-herdr: read failed')
        }
        return {
          read: {
            pane_id: this.paneId,
            source: String(params['source']),
            text: this.screen,
            // INERT, exactly as measured: hardcoded 0 on every read.
            revision: 0,
            truncated: false,
          },
        }
      }
      case 'pane.send_text':
      case 'pane.send_keys':
        return { type: 'ok' }
      case 'pane.close':
        // ALREADY GONE REJECTS, exactly as the real server does — MEASURED on 0.8.2:
        // `pane.close` on a missing pane answers
        // `{"error":{"code":"pane_not_found"}}`, not ok. The fake used to return ok
        // regardless, so the branch that treats `pane_not_found` as confirmed closure
        // was never reached and its mutation survived. A fixture does not have to be
        // permissive to hide a defect; it only has to be unrepresentative.
        if (this.paneGone) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        // A CLOSE THAT SUCCEEDS DESTROYS THE PANE, as the real server's does: it is
        // gone and unreadable afterwards, and no `pane_exited` follows. Recording it
        // separately from `paneGone` is what lets a test ask the question that
        // matters — "was anything actually closed?" — rather than only asking what
        // the child now claims about itself.
        this.paneClosed = true
        this.paneGone = true
        this.readFails = true
        return { type: 'ok' }
      default:
        throw new Error(`fake-herdr: unscripted method '${method}' — the host asked for something new`)
    }
  }

  /** No longer part of {@link HerdrRpc} — kept only so existing arrangements can mark
   *  a fake unusable. Each real call opens and closes its own connection, so there is
   *  no shared transport to lose. */
  close(): void {
    this.closed = true
  }
}

/** Wait until `cond()` holds, or throw. Polls on the real clock, so it works with
 *  the host's own `sleep`. */
export async function until(cond: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`until: timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}
