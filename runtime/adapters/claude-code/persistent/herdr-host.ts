/**
 * herdr-host.ts — the `PtyHost` backend: herdr is the REPL container.
 *
 * § herdr step 2b. The WIRED backend, replacing the in-process Bun-native one
 * (`Bun.spawn({ terminal })`, `bun-terminal-host.ts`) as the default — that host is
 * kept as an injectable option rather than deleted, and `pty-host.ts` records where
 * the two diverge. The lifted lifecycle/supervision logic still
 * talks only to `PtyHost`; the two places that interface had to change to admit an
 * out-of-process terminal (async `spawn`, and `onData` becoming `onScreen`) are
 * documented in `pty-host.ts` with the reasoning.
 *
 * SPAWN IS `layout.apply`, NOT `agent.start`. Verified against the live server:
 * `LayoutNode` type `pane` carries `command: string[]` and genuinely execs —
 * `pane.process_info` reported `shell_pid` EQUAL to the argv's own pid, with the
 * argv itself as `foreground_processes[0]`, and `pane.read` returned only the
 * program's output with no prompt and no echoed command line. `agent.start`
 * shell-quotes the argv and TYPES it into a running shell, and its `kind` is a
 * compiled-in enum, so it can neither run our argv faithfully nor admit `claude`
 * as we configure it.
 *
 * `onScreen` IS SYNTHESIZED BY POLLING. herdr has no raw output stream: of its 91
 * methods the only output-bearing subscription is `pane.output_matched`, which
 * needs a pattern registered in advance. `pane.output_changed` is declared in the
 * schema and is NOT usable — `events.subscribe` rejects it as an unknown variant
 * and `events.wait` rejects it with `unsupported_event_wait_match` ("events.wait
 * currently supports pane agent status matches"). Both measured on the wire. So
 * the bridge polls `pane.read` and delivers a snapshot when it CHANGES.
 *
 * THREE THINGS THE POLL LOOP MUST GET RIGHT, each of which a naive loop gets
 * wrong while still looking correct on a steady screen:
 *
 *  1. DELIVER ONLY ON CHANGE. `lastDataAt` drives the 900 ms idle gate that runs
 *     before every prompt inject. A loop that fires every tick keeps `lastDataAt`
 *     permanently fresh, so the REPL never reads as idle and every inject waits
 *     out the defensive cap instead of the quiet window.
 *  2. NEVER DELIVER A FAILED READ AS AN EMPTY SCREEN. A pane VANISHES on exit,
 *     taking its output with it, so the ring is the only surviving record of a
 *     dead REPL's last output. A read that ERRORS is dropped; a read that
 *     SUCCEEDS and is empty is delivered, because that is a genuinely cleared
 *     pane and the detector falling edge depends on seeing it.
 *  3. ASK FOR `viewport_rows + wanted` LINES. `lines=N` counts blank viewport
 *     rows BEFORE trimming: measured, a pane with three content lines under a
 *     62-row viewport returned EMPTY for `recent_unwrapped lines=10` and all
 *     three for `lines=200`.
 *
 * NO EXIT CODES EXIST ANYWHERE IN HERDR. `pane.exited` carries exactly
 * `{pane_id, workspace_id}`, so `exited` resolves `null` and crash-vs-recycle
 * collapses ENTIRELY onto `wasKilledByUs` — see `pty-host.ts`.
 */

import type { Key } from './keystrokes.ts'
import type { AdoptableHost, HandleInspection, PtyChild, PtyExitCause, PtySpawnOpts } from './pty-host.ts'
import {
  HERDR_POLL_INTERVAL_MS,
  HERDR_READ_LINE_CAP,
  HERDR_READ_SOURCE,
  HERDR_READ_WINDOW_LINES,
  HERDR_OUTPUT_GATE_MAX_MS,
  HERDR_PANE_NOT_FOUND,
  HERDR_VIEWPORT_REFRESH_MS,
  HERDR_VIEWPORT_ROWS_FALLBACK,
  herdrKeyNames,
  herdrReadWindow,
  type HerdrLayoutApply,
  type HerdrLayoutPaneNode,
  type HerdrPaneInfo,
  type HerdrPaneRead,
  type HerdrProcessInfo,
} from './herdr-protocol.ts'
import { createHerdrRpc, verifyHerdrProtocol, HerdrError, type HerdrRpc } from './herdr-client.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/** How long to wait for herdr to report the spawned pane's pid before refusing
 *  the spawn. A pane that has exec'd reports one within a poll or two; this is a
 *  bound on a hung server, not a normal wait. */
export const HERDR_PID_WAIT_MS = 5000

// DELETED WITH THE PATH THAT USED THEM: `HERDR_PID_KILL_GRACE_MS` (the signal-ladder
// grace for a transport-loss termination) and `parseProcStatStartTime` (the
// `/proc/<pid>/stat` field-22 reader that answered "is pid N still the process I
// started?"). There is no transport-loss termination and no PID signalling: a pid is an
// identifier, not a handle, and the pane id is the identity herdr maintains atomically.
// They are removed rather than left exported-and-unused, because an unused export is
// indistinguishable from a supported one and the repo rule is that the old path is
// deleted, not parked beside the new one. The reasoning that produced them is kept in
// the as-built record, which is where dead reasoning belongs.

/** Rejects invalid UTF-8 rather than substituting U+FFFD — the same discipline the
 *  inbound frame reader uses, applied to the bytes a caller hands `write()`. */
const FATAL_UTF8_IN = new TextDecoder('utf-8', { fatal: true })

/** The `label` put on the REPL's pane, so the owner can see what it is when they
 *  attach. */
export const HERDR_REPL_PANE_LABEL = 'neutron-repl'

/** One-line error text for a diagnostic string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Drop `undefined`-valued keys so the child sees only real env vars (the
 *  auth-scrub contract relies on the caller passing `KEY: undefined` to mean
 *  "unset" — we honour that by not forwarding it). */
function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Injectable seam so the host is testable without a live herdr server. */
export interface HerdrHostDeps {
  /** Open a protocol-verified connection. Defaults to {@link connectHerdr}, which
   *  is where the protocol version is checked and where a mismatch throws. */
  connect?: () => Promise<HerdrRpc>
  /** Poll interval override (tests). Defaults to {@link HERDR_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** How often to re-read the pane's viewport height. Defaults to
   *  {@link HERDR_VIEWPORT_REFRESH_MS}; a test shortens it to observe a resize. */
  viewportRefreshMs?: number
  /** Sleep, so a test can drive the loop deterministically. */
  sleep?: (ms: number) => Promise<void>
  /** Workspace to place the REPL's tab in. Defaults to `$HERDR_WORKSPACE_ID`. */
  workspaceId?: string
  /** How long to wait for `beginOutput()` before releasing screens anyway, with a
   *  warning. Defaults to {@link HERDR_OUTPUT_GATE_MAX_MS}. */
  outputGateMaxMs?: number
  /** How long to wait for herdr to report a pid. Defaults to
   *  {@link HERDR_PID_WAIT_MS}; a test shortens it so the refusal path is fast. */
  pidWaitMs?: number
  /** Called when the poll loop RETURNS. Tests only; production never passes it. See the
   *  `.finally` in `spawn` for why a task's completion needs its own observable. */
  onPollExit?: () => void
}

/** What {@link HerdrHost.open} is being asked to produce a child for: a pane to be
 *  CREATED from an argv, or one that already EXISTS and is to be re-attached. */
type HerdrOpenTarget =
  | { readonly kind: 'create'; readonly argv: string[] }
  | { readonly kind: 'attach'; readonly paneId: string }

/**
 * WHY AN ACTUATION DID NOT REACH THE PANE — two outcomes, never one.
 *
 * `refused` means the call was ATTEMPTED and the server rejected it. `skipped` means it
 * never ran: the pane was already gone when the queued keystroke came up. The two are
 * not interchangeable for anyone latching intent, because a refusal that arrives after
 * the pane vanished is AMBIGUOUS — the pane may have vanished because the interrupt
 * landed — while a skip delivered nothing under any reading.
 */
type NotDelivered = 'refused' | 'skipped'

/**
 * A `PtyHost` whose terminal is a herdr pane.
 *
 * ONE CONNECTION PER REQUEST, not per spawn: the server answers exactly one request on a
 * connection and then closes it (measured), so a `HerdrRpc` is a handle that opens, asks
 * and closes for every call rather than a socket a REPL holds. And there is NO
 * SUBSCRIPTION — exit is discovered by POLLING `pane.read` for a typed `pane_not_found`,
 * because a subscription needs a connection that outlives a request and there is none.
 * See the notes in `spawn` for both, and `pty-host.ts` for what that cost the interface.
 *
 * This docblock said the opposite until 2026-09-13 — "one herdr connection per `spawn`,
 * so a REPL's poll loop and its `pane.exited` subscription live and die with that REPL"
 * — which is the architecture this file exists to replace, stated in the first thing a
 * reader of the class meets. **A present-tense architectural claim in a file that just
 * changed its architecture is the highest-density place for this**, and it is the fourth
 * on this branch.
 */
export class HerdrHost implements AdoptableHost {
  constructor(private readonly deps: HerdrHostDeps = {}) {}

  async spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild> {
    if (argv.length === 0) {
      throw new Error('herdr-host: argv must be non-empty')
    }
    return this.open({ kind: 'create', argv }, opts)
  }

  /**
   * Re-attach to a pane an EARLIER GATEWAY created (#539) — the adoption half of
   * {@link AdoptableHost}.
   *
   * IT EXECS NOTHING, and that is the whole difference from {@link spawn}: the
   * `claude` under this pane has been running since before this process existed, so
   * `opts.env` and `opts.cwd` describe a launch that already happened and are
   * deliberately not applied. Everything downstream of the pane id is identical —
   * the same poll loop, the same actuation queue, the same exit settlement — because
   * a re-attached child must be indistinguishable from a spawned one to every
   * consumer above the host boundary. Sharing the body rather than reimplementing it
   * is what makes that true by construction instead of by review.
   *
   * REJECTS rather than creating anything when the pane is gone. A caller that wants
   * "attach, else spawn fresh" must establish {@link HandleInspection} `gone` first
   * and decide deliberately — an attach that silently became a spawn would start a
   * second owner for a transcript whose first owner this method failed to find.
   */
  async attach(handle: string, opts: PtySpawnOpts): Promise<PtyChild> {
    if (handle === '') {
      throw new Error('herdr-host: attach requires a pane id')
    }
    return this.open({ kind: 'attach', paneId: handle }, opts)
  }

  /**
   * Create-or-attach, then wire the child. ONE body for both, so the two cannot
   * drift: a re-attached child gets the identical poll loop, actuation ordering and
   * exit settlement a freshly-spawned one gets.
   */
  private async open(target: HerdrOpenTarget, opts: PtySpawnOpts): Promise<PtyChild> {
    const pollMs = this.deps.pollIntervalMs ?? HERDR_POLL_INTERVAL_MS
    const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms))

    // ONE RPC HANDLE, whose every call is its OWN connection — the shape the server
    // implements (it answers one request per connection and then closes it).
    const client = await (this.deps.connect ?? (async () => createHerdrRpc()))()

    // THE VERSION GATE, ONCE, AND THROUGH THE SAME HANDLE. It used to live in
    // `connectHerdr`, which pinged as part of connecting; with a connection per call
    // that would double the cost of every operation. Pinging here instead is not a
    // weakening: the server's protocol cannot change under a running host without
    // restarting herdr, and herdr's panes are its children — a restart takes the REPLs
    // with it, so there is no drift to detect mid-session that would leave a REPL to
    // supervise.
    //
    // UNCONDITIONAL. This was `if (this.deps.connect === undefined)` — a runtime check
    // keyed on whether a TEST SEAM was present, so the seam's presence changed the
    // safety property. Two consequences, and the second is the worse: `spawn` did not
    // have the property the comment above claimed, because the claim held only on the
    // production path; and the injected path is THE ONLY PATH A TEST CAN DRIVE, so no
    // test could exercise this gate through `spawn` at all. Pinging `herdrPing()`
    // directly tests the function in isolation, not the guarantee. A gate the
    // instrument cannot reach is the same class as an instrument that cannot fail.
    //
    // It runs BEFORE `layout.apply`, so a refused protocol creates no pane — the
    // cleanup obligation below is honoured by ordering rather than by a handler, and
    // the test asserts that rather than assuming it.
    await verifyHerdrProtocol(client)

    // THE CLEANUP OBLIGATION STARTS HERE, NOT AT THE END OF A SUCCESSFUL SPAWN.
    // The pane — and the `claude` process in it — exists the moment `layout.apply`
    // returns. Every initialization failure after that point must close it, or the
    // caller gets a rejected spawn while the process keeps running unmanaged, with
    // NOTHING holding a record of it: the pool never learned about a spawn that
    // failed. That is an orphan manufactured in the constructor, on an error path,
    // where nobody will ever look for it.
    let paneId: string | undefined
    let pid: number
    try {
      paneId =
        target.kind === 'create'
          ? await this.applyLayout(client, target.argv, opts)
          : await this.claimExistingPane(client, target.paneId)
      // The pid. Load-bearing above here: `supervision.ts` liveness-probes it with
      // `process.kill(pid, 0)` and the crashed-agent registry keys entries on
      // `(name, pid)`. herdr reports it as `shell_pid`, which is NULLABLE — and
      // for a `layout.apply` pane it is the argv's OWN pid. If it never arrives we
      // REFUSE the spawn rather than invent one: a child whose pid we cannot learn
      // cannot be supervised, and a placeholder would make every liveness probe
      // answer confidently about the wrong process.
      const pidWaitMs = this.deps.pidWaitMs ?? HERDR_PID_WAIT_MS
      const found = await this.awaitPid(client, paneId, sleep, pidWaitMs)
      if (found === undefined) {
        throw new Error(
          `herdr-host: pane ${paneId} never reported a pid within ${pidWaitMs}ms — ` +
            `refusing to return a child whose pid supervision cannot probe`,
        )
      }
      pid = found
    } catch (e) {
      // THE CLEANUP OBLIGATION BELONGS TO WHOEVER CREATED THE PANE. On a `create` a
      // failed initialisation leaves a process running that no caller ever received,
      // so it must be closed — the orphan-manufactured-on-an-error-path case above.
      // On an `attach` we created nothing: the pane was already running the previous
      // gateway's REPL, and closing it because WE could not finish wiring would
      // destroy a live session (and its conversation) to tidy up our own failure.
      // A failed attach therefore leaves the pane exactly as it found it, and the
      // caller decides what to do about a pane it could not adopt.
      if (target.kind === 'create') await this.abandonPane(client, paneId)
      throw e instanceof Error ? e : new Error(String(e))
    }

    let exited = false
    /**
     * "WE ENDED THIS CHILD" — the entire crash-vs-recycle discriminator, since herdr
     * reports no exit codes anywhere (`spawn.ts`), so it is load-bearing rather than
     * an optimisation.
     *
     * ONE flag, not two. Set synchronously when a terminal `kill` is REQUESTED, so a
     * `pane_exited` arriving while the close is in flight still reads as intentional;
     * CLEARED if that close fails, so an attempt that closed nothing leaves no trace.
     * A separate "confirmed" flag would be indistinguishable from this one in every
     * reachable state — and unobservable state cannot be tested, only believed.
     */
    let terminating = false
    // A transient intent, tracked separately from `terminating` so an interrupt can
    // never be mistaken for a termination. See `pty-host.ts`.
    let interruptedByUs = false
    let exitResolve: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      exitResolve = res
    })

    let exitCause: PtyExitCause | undefined
    /** The fail-open timer for the output gate, declared here so {@link settleExit}
     *  can clear it: a child that dies during startup, before `beginOutput()` is ever
     *  called, must not leave a pending timer behind. */
    let gateTimer: ReturnType<typeof setTimeout> | undefined
    /** Release the output gate. Assigned when the gate below is constructed; declared
     *  here so {@link settleExit} can call it — see the note there for why cancelling
     *  the timer alone is not enough. */
    let releaseOutput: () => void = () => {}
    /** Terminal state, exactly once — first cause wins. Always resolves `null`: no
     *  exit code exists anywhere in herdr. */
    const settleExit = (cause: PtyExitCause): void => {
      if (exited) return
      exited = true
      exitCause = cause
      if (opts.onExit !== undefined) {
        try {
          opts.onExit(null)
        } catch {
          // A throwing consumer must not break the exit path.
        }
      }
      exitResolve(null)
      // CANCEL THE TIMER *AND* RELEASE THE GATE. Cancelling alone strands the poll
      // loop: it is parked on `await outputGate`, and the gate's only two resolvers are
      // `beginOutput()` and this timer — so a child that dies before the caller ever
      // calls `beginOutput()` (spawn, kill, a `pane.close` that succeeds) left the loop
      // pending FOREVER, holding its closure over the host and client after the child
      // was gone.
      //
      // THE OBLIGATION WAS TO THE TASK; THE TIMER WAS ONLY ITS INSTRUMENT. The docblock
      // above names exactly this scenario and the code discharged half of it — the same
      // shape as `pane_not_found` landing in the unknown branch and the SIGINT latch: a
      // cleanup path that handles the object it can see and not the one that object was
      // standing in for.
      //
      // Releasing is safe rather than merely convenient: the loop's first statement
      // after the gate is `while (!hasExited())`, and `exited` is already true here, so
      // it returns without issuing a read. Checked rather than assumed — the fix must
      // not trade a stranded task for a spurious call against a closed pane.
      if (gateTimer !== undefined) clearTimeout(gateTimer)
      releaseOutput()
    }

    // NO SUBSCRIPTION. A `pane.exited` event needs a connection that outlives a
    // request, and there is no longer one to keep: every call is its own connection.
    // Exit is discovered by POLLING instead — `pane.read` answering `pane_not_found`
    // is the same fact, arriving on the tick after it becomes true rather than as a
    // push. That trade is deliberate: a poll cannot be missed while we are not
    // listening, cannot be replayed (a fresh subscription is delivered recent exits —
    // MEASURED: a subscriber saw a `pane_exited` for a pane that had already gone
    // before it subscribed), and cannot arrive for somebody else's pane.

    // THE OUTPUT GATE. The poll loop must not deliver a screen before the caller has
    // wired the consumer, which it cannot do until this `spawn` resolves. See
    // `PtyChild.beginOutput`: the first screen is precisely where a trust prompt
    // lives, and snapshot-replace never re-delivers it.
    let released = false
    const outputGate = new Promise<void>((res) => {
      releaseOutput = () => {
        if (released) return
        released = true
        res()
      }
    })
    // Fail OPEN, loudly. The gate orders delivery; it does not authorise it. A caller
    // that never calls `beginOutput()` would otherwise get a REPL that polls forever
    // and scans nothing — silent, and indistinguishable from a healthy idle session.
    gateTimer = setTimeout(() => {
      if (released) return
      process.stderr.write(
        `[herdr-host] pane ${paneId}: beginOutput() was not called within ` +
          `${this.deps.outputGateMaxMs ?? HERDR_OUTPUT_GATE_MAX_MS}ms — releasing screens anyway. This is a WIRING BUG in the ` +
          `caller: screens delivered before its consumer exists cannot be scanned, and a ` +
          `snapshot-replace ring never re-delivers an unchanged screen.\n`,
      )
      releaseOutput()
    }, this.deps.outputGateMaxMs ?? HERDR_OUTPUT_GATE_MAX_MS)

    fireAndForget(
      'herdr-host.poll',
      this.pollLoop(
        client,
        paneId,
        opts,
        pollMs,
        sleep,
        () => exited,
        settleExit,
        outputGate,
      ).finally(() => {
        // OBSERVABLE COMPLETION, so "the poll operation settles" is assertable rather
        // than believed. Production never passes this; it exists because the defect
        // above — a task parked forever on a gate nobody will open — has no other
        // outward sign: the child still settles, no read is issued either way, and the
        // warning is cancelled on both paths. The only difference is whether the task
        // is still pending, so that is what the seam reports.
        // Guarded like every other consumer callback, for the same reason and even
        // though this one is a test seam: a throw here would reject the promise
        // `fireAndForget` holds and turn a failing assertion into a swallowed log.
        try {
          this.deps.onPollExit?.()
        } catch {
          // the observer's failure is the observer's
        }
      }),
    )

    // ACTUATIONS ARE SERIALISED, AND THIS IS A COST OF ONE CONNECTION PER REQUEST.
    //
    // A single multiplexed socket ordered our writes for free: frames left in the
    // order we wrote them, on one stream, so `pane.send_text` was on the wire before
    // the `pane.send_keys` that submits it. One connection per request — which is the
    // only shape this server supports — throws that away. Two fire-and-forget calls
    // started in the same tick are two independent connects racing each other, and
    // the loser can be the one that had to go first.
    //
    // The sequence that breaks is real and already in the tree: the session-size
    // watchdog actuates `escape`, then `/compact`, then `enter`
    // (`session-size-watchdog.ts`). If Enter overtakes the text, it submits whatever
    // was already on the line and leaves `/compact` typed and unsent — a compaction
    // that silently did not happen, and possibly a stray prompt that did.
    //
    // So every actuation goes through ONE chain: a call does not start until the
    // previous one has been ANSWERED.
    //
    // THE TAIL IS NEUTRALISED, AND THAT IS THE LOAD-BEARING LINE. `actuations` is
    // re-pointed at a promise that settles FULFILLED however `started` ended, for two
    // reasons that are easy to conflate: a rejected keystroke must not wedge every
    // later one (the cost of a dropped actuation is one lost key; the cost of a wedged
    // queue is the session), and the tail is a promise nobody awaits, so a rejection
    // left on it is an unobserved rejection — fatal under Bun's process net. The
    // caller's own view of the failure is `started`, which is returned and IS observed
    // (`fireAndForget` for the fire-and-forget callers, the caller's `await` for
    // `submitLine`). Mutating the neutralisation away breaks the queue; a mutation of
    // the `.then(run)` shape does not, because the tail can no longer be rejected.
    //
    // NOT queued: `pane.read` (the poll is a sampler, and ordering it behind a stalled
    // keystroke would blind us exactly when something is wrong) and `pane.close` (a
    // teardown preempts, it does not wait — the escalation ladder in `repl-session.ts`
    // depends on the close being prompt).
    let actuations: Promise<unknown> = Promise.resolve()
    const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
      const started = actuations.then(run)
      actuations = started.then(
        () => undefined,
        () => undefined,
      )
      return started
    }

    /** Issue a pane ACTUATION, best-effort and in order. No-op after exit (the
     *  interface's "no-op-safe after exit" contract) — checked again when the call
     *  actually starts, because the pane can go while it is queued. */
    const send = (
      label: string,
      method: string,
      params: Record<string, unknown>,
      /**
       * Called when the actuation DID NOT REACH THE PANE, with which of the two ways it
       * did not. Optional, and deliberately not a change of shape for anyone else:
       * fire-and-forget is right for keystrokes, and making every caller await a
       * keypress would be a worse contract than the one being fixed. What is wrong is
       * LATCHING A CLAIM on top of a fire-and-forget act — so the one caller that
       * latches gets a way to unlatch, and the rest are untouched.
       *
       * THE REASON IS PART OF THE SIGNAL. This took no argument and was wired only to
       * `fireAndForget`'s rejection handler, so it could report a REFUSAL and nothing
       * else — and the queued body answered a skip with `undefined`, which is a
       * SUCCESSFUL resolution. A no-op and a delivery were therefore indistinguishable
       * to every caller: the interrupt latch stayed true although no keys were ever
       * sent. That is the fourth latch-outlives-the-act on this branch and the first to
       * arrive through success rather than failure, which is exactly why the existing
       * liveness guard could not catch it — the path never reached the guard.
       */
      onNotDelivered?: (why: NotDelivered) => void,
    ): void => {
      if (exited) {
        // ALREADY OVER, SYNCHRONOUSLY. Still a skip, and still has to be reported: a
        // caller that latched before calling `send` must hear about it either way.
        onNotDelivered?.('skipped')
        return
      }
      const started = enqueue(async (): Promise<boolean> => {
        // RE-CHECKED AT EXECUTION TIME, because a queue moves the moment of execution
        // away from the moment of the check. Returning FALSE rather than `undefined` is
        // the whole fix: the outcome now says whether the call ran, instead of leaving
        // "skipped" wearing the shape of "succeeded".
        if (exited) return false
        await client.call(method, params)
        return true
      })
      fireAndForget(
        label,
        started.then((delivered) => {
          if (!delivered) onNotDelivered?.('skipped')
        }),
        onNotDelivered === undefined ? undefined : () => onNotDelivered('refused'),
      )
    }

    const child: PtyChild = {
      pid,
      // THE DURABLE HANDLE. Its presence is what tells the shutdown path this child
      // is a child of the herdr SERVER rather than of this process, and it is what
      // the next gateway's boot reconciliation looks the child up by (#539).
      paneHandle: paneId,
      write(data) {
        // FATAL, LIKE THE INBOUND BOUNDARY. `PtyChild.write` promises to deliver the
        // BYTES it was given; `Buffer.toString('utf8')` substitutes U+FFFD for every
        // invalid sequence and returns happily, so `write(new Uint8Array([0xc3, 0x28]))`
        // sent `"\uFFFD("` — different bytes, silently, on the seam whose whole contract
        // is byte delivery. Odd next to the strict inbound validation, and the same
        // defect in the opposite direction: there the wire was trusted to carry what the
        // server meant, here the caller's bytes were altered on their way out.
        //
        // `pane.send_text` takes TEXT, so a payload that is not valid UTF-8 cannot be
        // sent over this transport at all — which is a refusal, not a substitution.
        let text: string
        if (typeof data === 'string') text = data
        else {
          try {
            text = FATAL_UTF8_IN.decode(data)
          } catch {
            throw new Error(
              'herdr-host: write() refuses bytes that are not valid UTF-8 — herdr\'s ' +
                'pane.send_text carries TEXT, so these cannot be sent as given. Decoding them ' +
                'with replacement characters would deliver DIFFERENT bytes than the caller ' +
                'passed, on the one seam whose contract is byte delivery.',
            )
          }
        }
        // THIS BACKEND'S OWN PRECONDITION, NOT THE INTERFACE'S. `PtyChild.write`
        // promises byte delivery and says nothing about submission, because whether a
        // `\r` submits is a property of the substrate — under an in-process pty it
        // does. Under herdr it does not: `pane.send_text` NEVER SUBMITS (measured — a
        // literal `\r` in the text does not fire at a prompt). Refusing the submit
        // characters here turns a silent no-op (the text typed and left sitting at the
        // prompt, the turn hanging forever with no error anywhere) into a loud one, and
        // names the sibling that does work. `writeKey('enter')` / `writeKeys` submit.
        // Stated as a precondition of HerdrHost so a caller reading the shared
        // interface is not told one backend's rule as if it were everyone's.
        if (text.includes('\r') || text.includes('\n')) {
          throw new Error(
            'herdr-host: write() refuses a submit character (\\r or \\n) — herdr\'s pane.send_text ' +
              'does not submit, so the text would be typed and left at the prompt with no error ' +
              "anywhere. Send the text, then writeKey('enter').",
          )
        }
        if (text === '') return
        send('herdr-host.write', 'pane.send_text', { pane_id: paneId, text })
      },
      writeKey(key: Key) {
        send('herdr-host.writeKey', 'pane.send_keys', { pane_id: paneId, keys: herdrKeyNames([key]) })
      },
      writeKeys(keys: readonly Key[]) {
        if (keys.length === 0) return
        send('herdr-host.writeKeys', 'pane.send_keys', { pane_id: paneId, keys: herdrKeyNames(keys) })
      },
      async submitLine(command) {
        // ACKNOWLEDGED, IN ORDER, AND NOT NO-OP-SAFE. `write`/`writeKey` are
        // fire-and-forget by interface; this is the variant a caller may build a
        // claim on, so every way it can fail has to reach the caller — including
        // "the child is already gone", which a silent no-op would report as a
        // completed reset.
        const goneAfterExit = (): Error =>
          new Error(
            `herdr-host: submitLine(${JSON.stringify(command)}) after exit — the pane is gone, so ` +
              'the command was not submitted. Reporting success here would let a caller record a ' +
              'context reset that never happened.',
          )
        if (exited) throw goneAfterExit()
        if (command.includes('\r') || command.includes('\n')) {
          throw new Error(
            'herdr-host: submitLine() refuses an embedded submit character (\\r or \\n) — ' +
              'pane.send_text does not submit, so it would be typed literally. Pass the bare ' +
              'command; submitLine sends the Enter key itself.',
          )
        }
        // Text first, then Enter, each awaited: an unacknowledged text followed by a
        // blind Enter submits whatever was already at the prompt. The PAIR is queued
        // as one unit, so a fire-and-forget actuation from another caller cannot land
        // between the text and the Enter that submits it.
        await enqueue(async () => {
          // RE-CHECKED HERE, AND IT IS NOT THE SAME CHECK AS THE ONE AT THE DOOR.
          //
          // A QUEUE MOVES THE MOMENT OF EXECUTION AWAY FROM THE MOMENT OF THE CHECK, so
          // every precondition tested before enqueueing is a claim about a world that
          // may have moved by the time the work runs. The window is real: hold an
          // earlier actuation, call this, let polling settle the child, release the
          // hold — without this line the text and Enter go to a vanished pane.
          //
          // It THROWS rather than dropping, which is where it differs from the
          // fire-and-forget path's identical-looking guard. `write`/`writeKey` are
          // no-op-safe by contract and a queued one is simply discarded; this is the
          // acknowledged seam a caller REPORTS an outcome from, so "the child went while
          // you were waiting" has to reach that caller. Resolving quietly would record a
          // context reset that never happened — the defect this whole method exists for.
          if (exited) throw goneAfterExit()
          if (command !== '') {
            await client.call('pane.send_text', { pane_id: paneId, text: command })
          }
          await client.call('pane.send_keys', { pane_id: paneId, keys: herdrKeyNames(['enter']) })
        })
      },
      kill(signal) {
        if (exited) return
        // CLASSIFY BEFORE LATCHING. SIGINT is the one real signal herdr can deliver
        // (`ctrl+c` on a pane raises a genuine one — measured), and it is an
        // INTERRUPT: abandon the current turn, keep the child. Anything else means
        // "end this process", and the only primitive for that is closing the pane —
        // which destroys it, so no `pane_exited` follows and we settle locally.
        const asInt = signal === 'SIGINT' || signal === 2
        if (asInt) {
          // ONLY A TERMINAL OPERATION MAY SET `terminating`. An earlier version set
          // it here, before distinguishing the signal, and then returned without
          // terminating anything — leaving the child ALIVE and flagged as
          // intentionally-terminated. Because herdr has no exit codes,
          // `wasKilledByUs` is the ENTIRE crash-vs-recycle discriminator
          // (`spawn.ts`), so that one interrupt silently reclassified every later
          // crash as a clean recycle for the rest of the child's life. A transient
          // intent gets its own flag.
          // AND THE LATCH IS ROLLED BACK IF THE ACTUATION FAILS. `send` is
          // fire-and-forget, so this set a flag asserting "WE sent this child an
          // INTERRUPT" (`pty-host.ts`) on top of an act that the server can refuse —
          // the same defect, in the same direction, as the Bun host's `kill()` latching
          // before a `proc.kill` that throws. THE RULE DOES NOT ATTACH TO A FILE THAT
          // HAS LEARNED IT; IT ATTACHES TO EVERY OPERATION THAT LATCHES INTENT BEFORE AN
          // ACT THAT CAN FAIL — and this one sits twenty lines above the comment stating
          // it for the close path.
          //
          // Guarded on liveness for the reason the close path records: once a terminal
          // state is settled, no later path may rewrite it.
          interruptedByUs = true
          send(
            'herdr-host.kill.sigint',
            'pane.send_keys',
            { pane_id: paneId, keys: ['ctrl+c'] },
            (why) => {
              // A SKIP IS UNAMBIGUOUS; A REFUSAL AFTER THE EXIT IS NOT — and collapsing
              // them onto one liveness test is what hid this. A call that was ATTEMPTED
              // and then rejected because the pane vanished may well have vanished
              // BECAUSE the interrupt landed, so clearing the latch there would deny a
              // real interrupt; that is what the guard was protecting and it stays. A
              // call that NEVER RAN delivered nothing, whatever the pane did afterwards,
              // so the latch is false and must come down. False and unknown must not
              // share a branch, one level up from where that rule usually bites.
              if (why === 'refused' && exited) return
              interruptedByUs = false
              process.stderr.write(
                `[herdr-host] pane ${paneId}: the SIGINT actuation was ` +
                  `${why === 'refused' ? 'REFUSED' : 'NEVER SENT (the pane was gone before the queued keystroke ran)'}` +
                  ` — no interrupt was delivered. Clearing wasInterruptedByUs: claiming an ` +
                  `interrupt that did not happen would let a caller record a turn as ` +
                  `abandoned when the child never saw it.\n`,
              )
            },
          )
          return
        }
        // Terminal from here. Record the intent for the IN-FLIGHT WINDOW only, so a
        // `pane_exited` racing a close we did ask for still classifies as intentional.
        terminating = true
        fireAndForget(
          'herdr-host.kill.close',
          // ONE-ARG `.then` on purpose: the rejection must reach `fireAndForget`'s
          // own handler so it is counted and logged like every other background
          // failure, and only THEN reach the `onError` below. A two-arg
          // `.then(onOk, onRej)` would swallow it before the wrapper ever saw it —
          // which is the whole point of the pre-swallow lint gate.
          client.call('pane.close', { pane_id: paneId }).then(() => {
            // CONFIRMED CLOSURE. Only now is the pane known to be gone, and only
            // now may the exit settle.
            settleExit('closed-by-us')
          }),
          (e: unknown) => {
            // `pane_not_found` IS CONFIRMATION, AND IT WAS LANDING IN THE BRANCH FOR
            // "COULD NOT FIND OUT". FALSE AND UNKNOWN MUST NOT SHARE A BRANCH: a typed
            // not-found is a FACT — the pane is gone — while a timeout, a transport
            // error or a malformed reply are the ABSENCE of a fact. One `catch` cannot
            // mean both, and treating the fact as an unknown broke the same two things
            // the handler below exists to protect: `hasExited()` stayed false, so
            // `repl-session.ts`'s ladder kept escalating against a pane that no longer
            // existed; and `terminating` was cleared, so when polling later settled the
            // exit, `wasKilledByUs()` was false and a deliberate recycle read as a crash
            // — the defect the comment below was written to prevent, arriving through
            // the other door.
            //
            // The poll path already knew this (`paneIsGone`, and the typed check in the
            // read handler); the close path had no case for it at all. It settles
            // exactly as `ok` does: we asked for the termination and the pane is gone,
            // so the cause is ours and the flag stays latched.
            if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) {
              settleExit('closed-by-us')
              return
            }
            // A FAILED CLOSE CLOSED NOTHING. An earlier version settled from
            // `.finally()`, so a rejected `pane.close` still resolved `exited`,
            // flipped `hasExited()` and reported `exitCause` 'closed-by-us' — a
            // live REPL recorded as cleanly terminated. Two things then broke at
            // once. The escalation ladder in `repl-session.ts` (`terminateChild`)
            // returns early at BOTH of its `child.hasExited()` guards, so the
            // SIGKILL retry never fired and the process leaked; and the kill flag
            // latched on an attempt that failed, which — with no exit codes
            // anywhere in herdr — is the entire crash-vs-recycle discriminator, so
            // every later real crash on this child read as a clean recycle.
            //
            // So: do not settle, and do not latch. Clearing `terminating` leaves
            // the child exactly as it is — alive and unflagged — which is both the
            // truth and what RE-ARMS the ladder: `hasExited()` stays false, the
            // grace race times out, and `kill('SIGKILL')` runs a second, bounded
            // attempt. Escalation is the retry.
            // ONCE A TERMINAL STATE IS SETTLED, NO LATER PATH MAY REWRITE IT.
            //
            // THE DEFECT THIS REPLACES: this reset was unconditional. Our own
            // `pane.close` can reject AFTER the exit has already settled — the poll
            // sees `pane_not_found` and settles while the close is still unanswered,
            // and then the close comes back as an error. Running this handler then
            // flipped `wasKilledByUs()` from true to FALSE after the child had
            // settled. With no exit codes anywhere in herdr that flag is the entire
            // crash-vs-recycle discriminator, so a deliberate recycle was rewritten
            // into an apparent crash by a cleanup path that never asked whether the
            // question was still open.
            //
            // And the rejection is not even evidence: once `exited` is true the pane
            // IS gone, so "the pane was NOT closed" would be a false statement about
            // a dead pane. The whole handler is only meaningful while the child is
            // still alive — which is exactly when clearing the flag is the truth.
            if (exited) return
            terminating = false
            process.stderr.write(
              `[herdr-host] pane ${paneId}: pane.close FAILED (${e instanceof Error ? e.message : String(e)}) — the pane was ` +
                `NOT closed. Not settling exit: reporting a close that did not happen would ` +
                `disarm the caller's SIGKILL escalation and misreport a later crash as an ` +
                `intentional recycle.\n`,
            )
          },
        )
      },
      exited: exitedPromise,
      hasExited: () => exited,
      wasKilledByUs: () => terminating,
      wasInterruptedByUs: () => interruptedByUs,
      exitCause: () => exitCause,
      beginOutput: () => {
        clearTimeout(gateTimer)
        releaseOutput()
      },
    }
    return child
  }

  /**
   * WHAT IS RUNNING UNDER `handle`, PER HERDR — the evidence the adoption decision is
   * made from (#539). Never decides anything itself: it reports, and
   * `orphan-adoption.ts` classifies.
   *
   * TWO CALLS, AND THE SECOND IS THE ONE THAT MATTERS. `pane.get` answers whether the
   * pane exists at all and gives its label; `pane.process_info` gives the FOREGROUND
   * PROCESS ARGV, which is the only thing that can say WHICH `claude` is in there.
   * Measured on the live server (2026-09-12): a `layout.apply` pane answers
   * `foreground_processes[0].argv` with the exact argv vector it was given, and a
   * production REPL child's argv carries both `--resume <uuid>` and
   * `--dangerously-load-development-channels server:<channel>` — the two tokens the
   * classifier needs. (A `claude` that was started bare, with no flags, reports
   * `argv: ["claude"]`; it therefore matches nothing and is never adopted, which is
   * the correct answer for a REPL this gateway did not launch.)
   *
   * ABSENCE IS ONLY EVER THE TYPED ONE. `pane_not_found` — the code herdr returns for
   * an unknown OR malformed pane id, measured — is the single route to `gone`. Every
   * other rejection is `unavailable`, because a timeout or a transport error measures
   * the call and says nothing about the pane. A pane we could not ask about may be
   * running a `claude` that owns a transcript; treating that as `gone` is how a second
   * owner gets started.
   */
  async inspectHandle(handle: string): Promise<HandleInspection> {
    if (handle === '') return { kind: 'unavailable', reason: 'empty pane id' }
    let client: HerdrRpc
    try {
      client = await (this.deps.connect ?? (async () => createHerdrRpc()))()
    } catch (e) {
      return { kind: 'unavailable', reason: `connect failed: ${errText(e)}` }
    }
    let info: HerdrPaneInfo | undefined
    try {
      const r = (await client.call('pane.get', { pane_id: handle })) as unknown as {
        pane?: HerdrPaneInfo
      }
      info = r.pane
    } catch (e) {
      if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) return { kind: 'gone' }
      return { kind: 'unavailable', reason: `pane.get failed: ${errText(e)}` }
    }
    if (info === undefined) {
      // The call SUCCEEDED and carried no pane. That is neither a typed absence nor a
      // transport failure — it is a reply this client cannot read, so it establishes
      // nothing and must not be read as either answer.
      return { kind: 'unavailable', reason: 'pane.get returned no pane object' }
    }
    let argv: readonly string[] = []
    let pid: number | undefined
    try {
      const r = (await client.call('pane.process_info', { pane_id: handle })) as unknown as {
        process_info?: HerdrProcessInfo
      }
      const pi = r.process_info
      const fg = pi?.foreground_processes?.[0]
      argv = fg?.argv ?? []
      const candidate = pi?.shell_pid ?? fg?.pid
      if (typeof candidate === 'number' && candidate > 0) pid = candidate
    } catch (e) {
      if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) return { kind: 'gone' }
      // The pane EXISTS (pane.get answered) but we could not sample what is in it.
      // `live` with an empty argv would be read by the classifier as "not ours", which
      // is a verdict about the process; this is a failure to look. Say so.
      return { kind: 'unavailable', reason: `pane.process_info failed: ${errText(e)}` }
    }
    return {
      kind: 'live',
      argv,
      ...(pid !== undefined ? { pid } : {}),
      ...(typeof info.label === 'string' ? { label: info.label } : {}),
    }
  }

  /** Terminate whatever runs under `handle`. Idempotent: a pane that is already gone
   *  resolves, because the post-condition ("nothing runs under this handle") already
   *  holds. Any OTHER failure rejects — the caller asked for a guarantee it did not
   *  get, and a silent success there would let a live REPL be recorded as reaped. */
  async closeHandle(handle: string): Promise<void> {
    const client = await (this.deps.connect ?? (async () => createHerdrRpc()))()
    try {
      await client.call('pane.close', { pane_id: handle })
    } catch (e) {
      if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) return
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * Confirm a pane we are about to ATTACH to exists, and hand back its id.
   *
   * The mirror of {@link applyLayout} for the attach path — and it deliberately
   * REFUSES rather than creating anything when the pane is gone, so a caller that
   * meant "adopt the running REPL" can never silently receive a new one.
   */
  private async claimExistingPane(client: HerdrRpc, paneId: string): Promise<string> {
    try {
      await client.call('pane.get', { pane_id: paneId })
    } catch (e) {
      if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) {
        throw new Error(`herdr-host: cannot attach — pane ${paneId} does not exist`)
      }
      throw e instanceof Error ? e : new Error(String(e))
    }
    return paneId
  }

  /**
   * Create the pane that will run `argv`.
   *
   * THE IDS COME BACK CHANGED. `layout.apply` REPLACES a tab: measured, a request
   * naming `w6:t2` was answered with `tab_id: w6:t3` and a fresh pane id. So we
   * never point it at a tab anyone else is using — we let herdr make one — and we
   * read the pane id out of the response rather than assuming anything we sent
   * survived.
   */
  private async applyLayout(client: HerdrRpc, argv: string[], opts: PtySpawnOpts): Promise<string> {
    const workspaceId = this.deps.workspaceId ?? process.env['HERDR_WORKSPACE_ID']
    // TYPED, not a bare literal. `HerdrLayoutPaneNode` records what was measured
    // against the live server about this node — `command` genuinely execs — and an
    // exported shape with no consumer is a supported-looking dead option. Using it
    // here is what makes it a description of the request we actually send.
    const root: HerdrLayoutPaneNode = {
      type: 'pane',
      command: argv,
      cwd: opts.cwd,
      env: compactEnv(opts.env),
      label: HERDR_REPL_PANE_LABEL,
    }
    const params: Record<string, unknown> = {
      // The owner's focus is theirs: they must be able to `herdr session attach`
      // and find themselves where they left off, not yanked to a REPL pane.
      focus: false,
      root,
    }
    if (workspaceId !== undefined && workspaceId !== '') params['workspace_id'] = workspaceId
    const applied = (await client.call('layout.apply', params)) as unknown as HerdrLayoutApply
    const paneId = applied.layout?.root?.pane_id
    if (typeof paneId !== 'string' || paneId === '') {
      throw new Error(
        `herdr-host: layout.apply returned no pane id: ${JSON.stringify(applied).slice(0, 300)}`,
      )
    }
    return paneId
  }

  /**
   * Tear down a pane we created but never handed to a caller, then drop the
   * connection. Best-effort in both halves: a failing `pane.close` must not mask the
   * error that caused the abandonment, and the connection closes either way.
   *
   * `paneId` is `undefined` when `layout.apply` itself failed — there is then no
   * pane to close, and no obligation.
   */
  private async abandonPane(client: HerdrRpc, paneId: string | undefined): Promise<void> {
    if (paneId !== undefined) {
      try {
        await client.call('pane.close', { pane_id: paneId })
      } catch {
        // Best-effort: the pane may already be gone, or the server unreachable —
        // which is exactly when the spawn was failing anyway.
      }
    }
  }

  /** Poll `pane.process_info` until herdr reports a pid for the pane. */
  private async awaitPid(
    client: HerdrRpc,
    paneId: string,
    sleep: (ms: number) => Promise<void>,
    waitMs: number,
  ): Promise<number | undefined> {
    const deadline = Date.now() + waitMs
    for (;;) {
      try {
        const info = (await client.call('pane.process_info', {
          pane_id: paneId,
        })) as unknown as { process_info?: HerdrProcessInfo }
        const pi = info.process_info
        const pid = pi?.shell_pid ?? pi?.foreground_processes?.[0]?.pid
        if (typeof pid === 'number' && pid > 0) return pid
      } catch {
        // The pane may not be fully wired yet; keep trying until the deadline.
      }
      if (Date.now() >= deadline) return undefined
      await sleep(100)
    }
  }

  /**
   * Poll `pane.read` and deliver a snapshot to `onScreen` WHEN IT CHANGES.
   *
   * The change filter is rule 1 in the class docstring, not an optimisation. The
   * error handling is rule 2: a read that throws leaves the ring holding the last
   * screen it saw, which for an exited pane is the only record of what the REPL
   * last printed.
   */
  private async pollLoop(
    client: HerdrRpc,
    paneId: string,
    opts: PtySpawnOpts,
    pollMs: number,
    sleep: (ms: number) => Promise<void>,
    hasExited: () => boolean,
    settleExit: (cause: PtyExitCause) => void,
    outputGate: Promise<void>,
  ): Promise<void> {
    // BEFORE THE FIRST READ, not before the first delivery: polling at all would set
    // `lastDataAt` and mutate the ring behind a consumer that cannot scan yet.
    await outputGate
    let last: string | undefined
    let viewportRows: number | undefined
    let viewportReadAt = 0
    let warnedShortWindow = false
    /** Said once: the viewport is a GUESS rather than a measurement. */
    let warnedViewportAssumed = false
    /** Said once: a successful read carried no usable text. */
    let warnedMalformedRead = false
    let warnedForRows: number | undefined
    const refreshMs = this.deps.viewportRefreshMs ?? HERDR_VIEWPORT_REFRESH_MS
    while (!hasExited()) {
      // RE-READ THE GEOMETRY PERIODICALLY. A pane can be resized after the first
      // read, and a stale height makes every request the wrong size — silently
      // returning nothing at all when the pane grew. Not cached forever.
      if (viewportRows === undefined || Date.now() - viewportReadAt >= refreshMs) {
        const rows = await this.readViewportRows(client, paneId)
        if (rows !== undefined) viewportRows = rows
        viewportReadAt = Date.now()
      }
      // `viewport_rows + wanted`: blank viewport rows count toward `lines` BEFORE
      // trimming, so a bare `wanted` returns EMPTY on a cleared pane (measured).
      // CLAMPED to the server's hard cap — see `herdrReadWindow`. A viewport at or
      // past `cap - wanted` (799) cannot carry the full detector window, and that
      // is said out loud ONCE rather than surfacing later as a short read.
      // THE FALLBACK IS A GUESS, AND IT LOOKS EXACTLY LIKE A MEASUREMENT.
      // `viewportRows ?? 120` yields a value indistinguishable from a pane that
      // really is 120 rows, so "we could not read the geometry" and "the geometry is
      // 120" were the same state — and the consequence is silent: on a 400-row pane
      // the window is sized for 120, every read comes back short, and positional
      // detectors see less than they were written for with nothing anywhere saying
      // why. The fallback STAYS (a REPL whose geometry cannot be read must still
      // poll), but it is no longer mute.
      const viewportIsAssumed = viewportRows === undefined
      const effectiveRows = viewportRows ?? HERDR_VIEWPORT_ROWS_FALLBACK
      if (viewportIsAssumed && !warnedViewportAssumed) {
        warnedViewportAssumed = true
        process.stderr.write(
          `[herdr-host] pane ${paneId}: could not read viewport_rows — ASSUMING ` +
            `${HERDR_VIEWPORT_ROWS_FALLBACK}. This is a guess, not a measurement: if the pane is ` +
            `taller, every read is short by the difference and positional detectors see less than ` +
            `the ${HERDR_READ_WINDOW_LINES} lines they are written against.\n`,
        )
      }
      const win = herdrReadWindow(effectiveRows)
      if (win.belowDetectorWindow && (!warnedShortWindow || warnedForRows !== effectiveRows)) {
        // Once per DISTINCT geometry, not once per process: a pane resized into a
        // short window after an earlier warning is new information.
        warnedShortWindow = true
        warnedForRows = effectiveRows
        process.stderr.write(
          `[herdr-host] pane ${paneId}: viewport ${effectiveRows} rows ` +
            `+ ${HERDR_READ_WINDOW_LINES} wanted exceeds the ${HERDR_READ_LINE_CAP}-line read cap; ` +
            `requesting ${win.lines} and carrying ${win.contentAllowance} content lines. Positional ` +
            `detectors written against ${HERDR_READ_WINDOW_LINES} lines may see less.\n`,
        )
      }
      const lines = win.lines
      let text: string | undefined
      try {
        const r = (await client.call('pane.read', {
          pane_id: paneId,
          source: HERDR_READ_SOURCE,
          lines,
          strip_ansi: true,
          format: 'text',
        })) as unknown as { read?: HerdrPaneRead }
        const read = r.read
        if (read !== undefined && typeof read.text === 'string') {
          text = read.text
        } else if (!warnedMalformedRead) {
          // The CALL SUCCEEDED and the payload was unusable — which is neither a
          // failed read nor a screen. Leaving `text` undefined is right (see below:
          // an unknown must not be delivered as an empty screen), but doing it
          // silently means a server whose reply shape drifted would poll forever
          // delivering nothing, looking exactly like a permanently idle REPL. The
          // protocol-version gate catches a declared change; this catches a
          // same-version one.
          warnedMalformedRead = true
          process.stderr.write(
            `[herdr-host] pane ${paneId}: pane.read SUCCEEDED but carried no usable text ` +
              `(read=${read === undefined ? 'absent' : `text:${typeof read.text}`}). Delivering ` +
              `nothing rather than an empty screen. If this persists the reply shape has ` +
              `changed under a protocol version that did not.\n`,
          )
        }
      } catch (e) {
        // A read that FAILED tells us nothing about the screen. Drop it — do NOT
        // synthesize an empty snapshot, which would erase the ring's record of a
        // dead REPL's last output.
        //
        // UNKNOWN MUST NOT CONFIRM — AND KNOWN MUST NOT BE DISCARDED. Every other
        // rule on this branch is the first half: an ambiguous failure settles
        // nothing. This is its other half, and it was the one being broken. The
        // handler caught every rejection alike and threw the error away, then asked
        // `pane.get` the same question again — so a read that came back with the
        // exact typed positive absence herdr offers (`pane_not_found`) settled
        // nothing if the FOLLOW-UP probe happened to fail transiently. A definite
        // answer discarded because the code did not look at it.
        if (e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND) {
          settleExit('pane-vanished')
          return
        }
        // Genuinely ambiguous: a timeout, a transport hiccup, a server error. Only
        // now is a second question worth asking.
        if (await this.paneIsGone(client, paneId)) {
          settleExit('pane-vanished')
          return
        }
      }
      // Deliver only a CHANGED screen. An empty-but-successful read IS a change
      // worth delivering (a cleared pane), which is what lets a detector's latch
      // fall.
      if (text !== undefined && text !== last) {
        last = text
        if (opts.onScreen !== undefined) {
          try {
            opts.onScreen(text)
          } catch {
            // A throwing consumer must not kill the poll loop.
          }
        }
      }
      await sleep(pollMs)
    }
  }

  /** The pane's viewport height, so reads can ask for `viewport_rows + wanted`. */
  private async readViewportRows(client: HerdrRpc, paneId: string): Promise<number | undefined> {
    try {
      const r = (await client.call('pane.get', { pane_id: paneId })) as unknown as {
        pane?: HerdrPaneInfo
      }
      const rows = r.pane?.scroll?.viewport_rows
      return typeof rows === 'number' && rows > 0 ? rows : undefined
    } catch {
      return undefined
    }
  }

  /** True ONLY when herdr positively reports the pane does not exist. A rejection
   *  that does not carry {@link HERDR_PANE_NOT_FOUND} means the question failed, not
   *  that the answer is no — see the body. Used to turn a failing read into a
   *  DEFINITE exit, which it can only do when the exit is actually definite. */
  private async paneIsGone(client: HerdrRpc, paneId: string): Promise<boolean> {
    try {
      await client.call('pane.get', { pane_id: paneId })
      return false
    } catch (e) {
      // ONLY A TYPED not-found PROVES ABSENCE. Every other rejection — a timeout, a
      // transient server error, a transport hiccup — is a failure of the QUESTION,
      // and "I could not determine whether it is gone" is not "it is gone".
      // Returning true for any rejection recycled live REPLs and stamped them
      // `'pane-vanished'`, a claim nothing had observed.
      //
      // The cost of being strict here is that a pane we cannot ask about keeps being
      // polled rather than being declared dead. That is the correct side to err on: a
      // turn against an unresponsive REPL is ended by the inactivity watchdog above,
      // and a server that is briefly unreachable recovers on the next tick. What must
      // not happen is a confident wrong answer.
      return e instanceof HerdrError && e.code === HERDR_PANE_NOT_FOUND
    }
  }
}

/** Default singleton — herdr is the REPL container. Typed as {@link AdoptableHost}
 *  because its children outlive this process: that is the capability #539 is built
 *  on, and a `PtyHost`-typed export would hide it behind a runtime narrowing at
 *  every call site. */
export const herdrHost: AdoptableHost = new HerdrHost()
