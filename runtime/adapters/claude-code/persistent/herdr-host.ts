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
import type { PtyChild, PtyExitCause, PtyHost, PtySpawnOpts } from './pty-host.ts'
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
import { createHerdrRpc, herdrPing, HerdrError, type HerdrRpc } from './herdr-client.ts'
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

/** The `label` put on the REPL's pane, so the owner can see what it is when they
 *  attach. */
export const HERDR_REPL_PANE_LABEL = 'neutron-repl'

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
}

/**
 * A `PtyHost` whose terminal is a herdr pane.
 *
 * One herdr connection per `spawn`, so a REPL's poll loop and its `pane.exited`
 * subscription live and die with that REPL and cannot be starved by another
 * session's traffic.
 */
export class HerdrHost implements PtyHost {
  constructor(private readonly deps: HerdrHostDeps = {}) {}

  async spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild> {
    if (argv.length === 0) {
      throw new Error('herdr-host: argv must be non-empty')
    }
    const pollMs = this.deps.pollIntervalMs ?? HERDR_POLL_INTERVAL_MS
    const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms))

    // ONE RPC HANDLE, whose every call is its OWN connection — the shape the server
    // implements (it answers one request per connection and then closes it).
    const client = await (this.deps.connect ?? (async () => createHerdrRpc()))()

    // THE VERSION GATE, ONCE. It used to live in `connectHerdr`, which pinged as part
    // of connecting; with a connection per call that would double the cost of every
    // operation. Pinging here instead is not a weakening: the server's protocol cannot
    // change under a running host without restarting herdr, and herdr's panes are its
    // children — a restart takes the REPLs with it, so there is no drift to detect
    // mid-session that would leave a REPL to supervise. It still THROWS on a mismatch,
    // so a spawn that cannot verify the protocol does not happen.
    if (this.deps.connect === undefined) await herdrPing()

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
      paneId = await this.applyLayout(client, argv, opts)
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
      await this.abandonPane(client, paneId)
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
      if (gateTimer !== undefined) clearTimeout(gateTimer)
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
    let releaseOutput: () => void = () => {}
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
      ),
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
    const enqueue = (run: () => Promise<unknown>): Promise<unknown> => {
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
    const send = (label: string, method: string, params: Record<string, unknown>): void => {
      if (exited) return
      fireAndForget(
        label,
        enqueue(async () => (exited ? undefined : await client.call(method, params))),
      )
    }

    const child: PtyChild = {
      pid,
      write(data) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        // `pane.send_text` NEVER SUBMITS — measured: a literal `\r` in the text
        // does not fire at a prompt. Refusing the submit characters turns a silent
        // no-op (the text typed and left sitting at the prompt, the turn hanging
        // forever with no error anywhere) into a loud one, and names the sibling
        // that does work. `writeKey('enter')` / `writeKeys` submit.
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
        if (exited) {
          throw new Error(
            `herdr-host: submitLine(${JSON.stringify(command)}) after exit — the pane is gone, so ` +
              'the command was not submitted. Reporting success here would let a caller record a ' +
              'context reset that never happened.',
          )
        }
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
          interruptedByUs = true
          send('herdr-host.kill.sigint', 'pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] })
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

/** Default singleton — herdr is the REPL container. */
export const herdrHost: PtyHost = new HerdrHost()
