/**
 * pty-host.ts — the host-boundary abstraction for running the interactive
 * `claude` REPL on a real terminal.
 *
 * § Sprint-1 deliverable #1 + § 2 (HOST-BOUNDARY decision). The lifted
 * lifecycle/supervision logic (session-capture, post-spawn-assertion, the
 * Sprint-2 watchdogs) talks ONLY to `PtyHost` — never to a specific multiplexer
 * or PTY library. That keeps the substrate portable.
 *
 * § herdr step 2b — THE BACKEND IS NOW OUT-OF-PROCESS. The single backend is
 * `herdr-host.ts`: herdr is the REPL container, reached over its unix-socket API.
 * The previous in-process Bun-native backend (`Bun.spawn({ terminal })`) is gone,
 * not flagged off. Two parts of this interface changed as a direct consequence,
 * and both changed rather than being quietly reinterpreted:
 *
 *  • `spawn` is ASYNC. Creating the terminal is now a socket round trip, so the
 *    child's `pid` cannot exist at the instant `spawn` returns. Keeping `spawn`
 *    synchronous would have meant handing back a child whose `pid` reads 0 for a
 *    window — and `pid` is load-bearing above here (`supervision.ts` liveness-
 *    probes it with `process.kill(pid, 0)`; the crashed-agent registry keys
 *    entries on `(name, pid)`). Awaiting the spawn fixes that at the construction
 *    site instead of asking every reader to know about the window.
 *  • `onData` became `onScreen`, and delivers a RENDERED SCREEN, not a byte chunk.
 *    herdr has no raw output stream, so recent output is synthesized by polling
 *    `pane.read`; each delivery is the pane's whole current screen. A callback
 *    still named `onData` and typed as bytes would have been false at every call
 *    site, and the ring below it would have kept appending screens to itself.
 *
 * KEY REALISATION (§ 2): tmux was never part of Nova's substrate — it was a
 * PID-keepalive + human-attach convenience. The actual turn I/O (dev-channel
 * MCP in, `reply` tool out) never touches terminal keystrokes. herdr earns its
 * place for the opposite reason: the owner must be able to `herdr session attach`
 * and move between working in herdr directly and working through Neutron.
 */

import type { Key } from './keystrokes.ts'

/**
 * WHY a child became terminal. herdr reports no exit status (see
 * {@link PtyChild.exited}), so this is the only thing that distinguishes the routes
 * — and one of them is not a child event at all.
 *
 *  - `pane-exited`    — herdr sent `pane_exited`: the process in the pane ended.
 *  - `closed-by-us`   — we closed the pane (evict / respawn / cancel / shutdown).
 *  - `pane-vanished`  — reads failed and herdr no longer knows the pane.
 *  - `transport-lost` — THE CHANNEL DIED, NOT THE CHILD. The socket to the herdr
 *    server closed, so nothing about the process changed; what changed is that we
 *    can no longer observe or drive it. It is terminal because an unobservable REPL
 *    is unusable and the pool must recycle it — but it is NOT evidence the child
 *    exited, and nothing may report it as one.
 */
export type PtyExitCause = 'pane-exited' | 'closed-by-us' | 'pane-vanished' | 'transport-lost'

/** A spawned child attached to a terminal. The lifecycle/supervision logic
 *  consumes exactly this shape regardless of the underlying backend. */
export interface PtyChild {
  /** OS process id of the spawned child. Under the herdr backend this is the
   *  pane's own foreground pid, which `layout.apply` makes the argv's own pid.
   *  Always a real pid: the host refuses to return a child it could not learn one
   *  for, because a placeholder would make every liveness probe above here answer
   *  confidently about the wrong process. */
  readonly pid: number
  /**
   * Write text to the child's stdin. The fundamental write seam.
   *
   * DOES NOT SUBMIT, AND REFUSES TO PRETEND IT DOES. herdr's `pane.send_text`
   * types text at the prompt without submitting it — a literal `\r` in the text
   * does not fire (measured). So the herdr backend REFUSES data containing `\r`
   * or `\n` rather than accepting it and silently leaving the REPL sitting on an
   * unsubmitted line with no error anywhere. Submit with
   * {@link PtyChild.writeKey}`('enter')` — or, if the caller is going to REPORT
   * whether the command took effect, with {@link PtyChild.submitLine}, which is the
   * only form that can tell a delivered frame from a refused one.
   */
  write(data: string | Uint8Array): void
  /** Send one structured key (F2): encodes the correct key for
   *  enter/escape/ctrl-c/up/down/left/right/digit. Lets recovery detectors
   *  navigate Ink arrow-pickers + send Escape/Ctrl-C, which `write` cannot — and
   *  under herdr it is also the ONLY way to submit. No-op-safe after exit.
   *  OPTIONAL: a backward-compatible extension — the real backend provides it;
   *  lightweight test fakes that never receive keystrokes may omit it. */
  writeKey?(key: Key): void
  /** Send a multi-key sequence (e.g. `['down','enter']` to pick the second option
   *  of an arrow-driven picker). No-op-safe after exit. OPTIONAL (see
   *  `writeKey`). */
  writeKeys?(keys: readonly Key[]): void

  /**
   * Submit `command` as a line, and RESOLVE ONLY WHEN THE BACKEND HAS ACKNOWLEDGED
   * BOTH HALVES — the text and the Enter that submits it.
   *
   * SETTLEMENT IS NOT CONFIRMATION. {@link write} and {@link writeKey} are `void`:
   * over a socket backend they hand a frame to the transport and return, so a caller
   * cannot distinguish "the REPL received `/clear`" from "the socket refused the
   * frame". Every caller of the old pair nonetheless REPORTED SUCCESS on return —
   * `context-reset.ts` returned `{status:'reset'}`, `pool.ts` logged a completed
   * reset — so a context reset that never happened was indistinguishable from one
   * that did, and the session kept a full context while the pool believed it empty.
   *
   * A DETACHED WRITE CANNOT SUPPORT ANY CLAIM ABOUT ITS EFFECT. Anything whose
   * caller asserts an outcome must therefore be awaitable and acknowledged, which is
   * this method. Rejection means the command is NOT known to have been submitted;
   * it may have been partially applied (text delivered, Enter refused), so the text
   * may be sitting at the prompt.
   *
   * Optional only because a host may predate it; `submitCommand` refuses to guess
   * with `write` + `writeKey` when it is absent rather than fabricate an ack.
   */
  submitLine?(command: string): Promise<void>
  /**
   * Resize the terminal (cols × rows). No-op-safe after exit.
   *
   * OPTIONAL, AND THE HERDR BACKEND DOES NOT PROVIDE IT. herdr's `pane.resize`
   * takes `{direction, amount}` — it nudges a split ratio; herdr's layout engine
   * owns pane geometry and there is no cols × rows setter anywhere in its API.
   * Declared optional rather than implemented as a silent no-op that reports
   * success. It has zero production callers, so nothing is narrowed by its
   * absence; a future backend on a substrate that can resize may supply it.
   */
  resize?(cols: number, rows: number): void
  /** Send a signal to the child (default SIGTERM). Idempotent after exit. Under
   *  herdr only SIGINT is a real signal (`ctrl+c` on the pane raises one);
   *  anything else means "end this process" and closes the pane. */
  kill(signal?: NodeJS.Signals | number): void
  /**
   * Resolves when the child exits.
   *
   * ALWAYS `null` UNDER HERDR, BECAUSE NO EXIT CODES EXIST THERE. herdr's
   * `pane.exited` carries exactly `{pane_id, workspace_id}` — there is no exit
   * status anywhere in its API. `null` is this interface's existing "terminated,
   * no code" value and is the only honest answer; it is also the only one that
   * preserves the exit classification in `spawn.ts`, which reads
   * `!killedByUs && exitCode !== 0`. Resolving `0` instead would route every real
   * crash to `unregister()` and blind the crashed-agent detector.
   *
   * The consequence, pinned by a test so it is not rediscovered as a bug:
   * CRASH-VS-RECYCLE IS DECIDED ENTIRELY BY {@link PtyChild.wasKilledByUs}, and
   * the exit-code half of that condition carries no information at all.
   */
  readonly exited: Promise<number | null>
  /** True once the child has exited. */
  readonly hasExited: () => boolean
  /**
   * True once WE signalled this child via {@link kill} (any intentional
   * termination — pool eviction, respawn, cancel, graceful shutdown). Lets the
   * exit handler tell a crash apart from an expected termination, so the F4
   * crashed-agent watchdog fires only on real crashes and never on routine
   * recycles.
   *
   * UNDER HERDR THIS IS THE WHOLE SIGNAL, not an optimisation over exit codes:
   * see {@link PtyChild.exited}. OPTIONAL only so a lightweight test fake may
   * omit it; the real backend always provides it.
   */
  readonly wasKilledByUs?: () => boolean
  /**
   * WHY this child became terminal, once it has. `undefined` while it is alive.
   *
   * Exists because `exited` cannot carry it: herdr reports no exit status, so every
   * death resolves `null` and the four routes to it are otherwise indistinguishable
   * — including {@link PtyExitCause} `'transport-lost'`, which is not a child event
   * at all. OPTIONAL, so a lightweight test fake may omit it; a caller that needs to
   * tell the routes apart must treat `undefined` as "not known", never as a default.
   */
  readonly exitCause?: () => PtyExitCause | undefined
  /**
   * True once WE sent this child an INTERRUPT (SIGINT / Ctrl-C) — a request to
   * abandon the current turn, NOT to end the process.
   *
   * It exists so that a transient intent has its own representation instead of
   * borrowing {@link PtyChild.wasKilledByUs}. An earlier version latched
   * `wasKilledByUs` on SIGINT, which left the child ALIVE and flagged as
   * intentionally-terminated — and since herdr has no exit codes, that flag is the
   * ENTIRE crash-vs-recycle discriminator, so one interrupt silently reclassified
   * every later crash as a clean recycle for the rest of the child's life.
   *
   * **MUST NEVER BE USED FOR EXIT CLASSIFICATION.** An interrupted child that later
   * dies unexpectedly has crashed. Only a terminal operation may say otherwise, and
   * `wasKilledByUs` is the only thing licensed to.
   */
  readonly wasInterruptedByUs?: () => boolean
  /**
   * Tell the host its consumer is wired, and screens may start flowing.
   *
   * WHY THIS EXISTS: `spawn` is async, and the caller cannot wire anything that
   * needs the child — the output scanner's keystroke target, the live-process handle
   * — until the `await` resolves. A host that begins polling before returning
   * therefore has a window in which it can deliver the FIRST screen to a consumer
   * that is not yet able to act on it. And because the ring is snapshot-replace,
   * which deliberately suppresses an unchanged screen, that screen is never
   * delivered again: a startup trust prompt or approval dialog goes unscanned and
   * undismissed for the life of the child, which stays alive and polling, waiting
   * on a prompt nobody saw.
   *
   * The general form, and the reason it did not exist before: **an `await` inserted
   * between a producer and its consumer creates a window for everything the producer
   * already started.** Making `spawn` async was right — a synchronous one handed back
   * a child whose `pid` read 0 while supervision probed it — and it created this.
   *
   * Idempotent. OPTIONAL only so a lightweight test fake may omit it; the real
   * backend always provides it, and a caller that forgets to call it gets a loud
   * warning and late delivery rather than permanent silence.
   */
  readonly beginOutput?: () => void
}

/** Options for spawning a terminal-hosted child. */
export interface PtySpawnOpts {
  /** Working directory for the child. */
  cwd: string
  /**
   * Environment for the child. Passed verbatim — the caller is responsible
   * for the auth scrub (unset `ANTHROPIC_API_KEY` / set
   * `CLAUDE_CODE_OAUTH_TOKEN`). `undefined` values are dropped.
   */
  env: Record<string, string | undefined>
  /**
   * Callback for the child's RENDERED SCREEN, each time it CHANGES.
   *
   * NOT A BYTE STREAM. herdr exposes no raw output, so this is synthesized by
   * polling `pane.read`: every delivery is the pane's whole current screen, and
   * the consumer REPLACES its ring with it (`PtyRing.replace`) rather than
   * appending. `pty-ring.ts` carries the reasoning for why snapshot-replace was
   * taken over diff-append and how a turn is scoped under it.
   *
   * Two guarantees the consumer depends on, both of which a naive poll loop
   * breaks while still looking right on a steady screen:
   *  • FIRES ONLY ON CHANGE — an unchanged screen produces no call, so
   *    `lastDataAt` can go stale and the 900 ms idle gate can actually resolve.
   *  • AN EMPTY SCREEN IS DELIVERED (a cleared pane — the detector falling edge
   *    needs to see it), but a FAILED READ IS NOT. A pane vanishes on exit taking
   *    its output with it, so the ring is the only record of a dead REPL's last
   *    output and must never be overwritten with the emptiness of a failed read.
   *
   * The substrate does NOT parse this for the turn answer — that flows via the
   * dev-channel `reply` tool.
   */
  onScreen?: (screen: string) => void
  /** Callback when the child exits. The code is always `null` under herdr — there
   *  are no exit codes; see {@link PtyChild.exited}. */
  onExit?: (code: number | null) => void
  /**
   * Preferred terminal size. ADVISORY ONLY under the herdr backend, which ignores
   * it: herdr's layout engine owns pane geometry and exposes no cols × rows
   * setter (see {@link PtyChild.resize}). Retained because the interface is meant
   * to admit a backend on a substrate that can honour it.
   */
  cols?: number
  rows?: number
}

/** The host-boundary interface. One method: spawn an argv on a terminal.
 *
 *  ASYNC because the terminal now lives in another process — see the file header.
 *  The returned child's `pid` is real the moment it is handed back. */
export interface PtyHost {
  spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild>
}
