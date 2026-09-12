/**
 * pty-host.ts — the host-boundary abstraction for running the interactive
 * `claude` REPL on a real terminal.
 *
 * § Sprint-1 deliverable #1 + § 2 (HOST-BOUNDARY decision). The lifted
 * lifecycle/supervision logic (session-capture, post-spawn-assertion, the
 * Sprint-2 watchdogs) talks ONLY to `PtyHost` — never to a specific multiplexer
 * or PTY library. That keeps the substrate portable.
 *
 * § herdr step 2b — THE WIRED BACKEND IS NOW OUT-OF-PROCESS. `spawn.ts` resolves
 * `options.ptyHost ?? herdrHost`: herdr is the REPL container, reached over its
 * unix-socket API, and it is the ONLY wired default. The in-process Bun-native
 * backend (`bun-terminal-host.ts`, `Bun.spawn({ terminal })`) is KEPT as an option
 * reachable by injecting it at that seam — kept compiling, contract-complete and
 * tested, but deliberately not exposed through a user-facing chooser.
 *
 * THE TWO BACKENDS ARE NOT INTERCHANGEABLE. Read this before assuming a caller that
 * works on one works on the other; `bun-terminal-host.ts` states the same list from
 * its own side, and the spec item names the one defect the divergence creates:
 *
 *  • EXIT CODES exist under Bun and NOWHERE in herdr. Everything below that says
 *    `exited` is always `null` is true OF HERDR — the Bun host resolves a real
 *    kernel status. Crash-versus-recycle collapses onto `wasKilledByUs` only on the
 *    herdr path.
 *  • EXIT DETECTION is a push under Bun (`proc.exited` settles) and a POLL under
 *    herdr (`pane.read` answering a typed `pane_not_found`), so herdr learns of an
 *    exit on the tick after it happens rather than at the instant it does.
 *  • `onScreen` is a RENDERED pane under herdr and an ACCUMULATION of the byte
 *    stream under Bun. Both satisfy snapshot-replace, but only herdr's collapses an
 *    Ink repaint: under Bun a repaint really is new bytes.
 *
 * Two parts of this interface changed as a direct consequence of the herdr backend,
 * and both changed rather than being quietly reinterpreted:
 *
 *  • `spawn` is ASYNC. Creating the terminal is now a socket round trip, so the
 *    child's `pid` cannot exist at the instant `spawn` returns. Keeping `spawn`
 *    synchronous would have meant handing back a child whose `pid` reads 0 for a
 *    window — and `pid` is load-bearing above here (`supervision.ts` liveness-
 *    probes it with `process.kill(pid, 0)`; the crashed-agent registry keys
 *    entries on `(name, pid)`). Awaiting the spawn fixes that at the construction
 *    site instead of asking every reader to know about the window.
 *  • `onData` became `onScreen`, and delivers a WHOLE CURRENT SCREEN, not a byte
 *    chunk. herdr has no raw output stream, so it synthesizes one by polling
 *    `pane.read`; the in-process host has the byte stream and accumulates it into the
 *    same shape. A callback still named `onData` and typed as bytes would have been
 *    false at every call site, and the ring below it would have kept appending screens
 *    to itself.
 *
 * KEY REALISATION (§ 2): tmux was never part of Nova's substrate — it was a
 * PID-keepalive + human-attach convenience. The actual turn I/O (dev-channel
 * MCP in, `reply` tool out) never touches terminal keystrokes. herdr earns its
 * place for the opposite reason: the owner must be able to `herdr session attach`
 * and move between working in herdr directly and working through Neutron.
 */

import type { Key } from './keystrokes.ts'

/**
 * WHY a child became terminal, IN HERDR'S TERMS. herdr reports no exit status (see
 * {@link PtyChild.exited}), so this is the only thing that distinguishes its routes.
 *
 * THE BUN BACKEND DOES NOT PROVIDE IT, deliberately: both values name herdr
 * mechanisms, and "the pane does not exist" cannot happen to an in-process pty, which
 * reports a real exit code instead. `exitCause` is optional and `undefined` there
 * means "not known" — the truth — rather than a default.
 *
 *  - `closed-by-us`   — we closed the pane (evict / respawn / cancel / shutdown).
 *  - `pane-vanished`  — herdr positively reports the pane does not exist, which is
 *    how a process that ended on its own is discovered.
 *
 * TWO WERE DELETED RATHER THAN LEFT UNREACHABLE. `pane-exited` came from a
 * `pane_exited` subscription event, and `transport-lost` from a long-lived socket
 * closing. The herdr transport is one request per connection — measured — so there is
 * no persistent socket to lose and no subscription to receive on: a connection ending
 * is how every exchange ends, not an event. Both routes now arrive as the same fact,
 * `pane_not_found` on a poll, and one fact deserves one name.
 */
export type PtyExitCause = 'closed-by-us' | 'pane-vanished'

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
   * Deliver `data` to the child's stdin. The fundamental write seam.
   *
   * SAYS NOTHING ABOUT SUBMISSION, IN EITHER DIRECTION. This is a byte-delivery
   * operation: it is `void`, it is fire-and-forget, and whether the bytes end a line
   * is a property of the SUBSTRATE, not of this method. Under an in-process pty a
   * `\r` genuinely submits; under herdr `pane.send_text` types the text at the prompt
   * and a literal `\r` does not fire (measured). A caller that needs to know which
   * happened is asking the wrong method.
   *
   * WHY THIS WORDING IS DELIBERATE. The contract previously said "DOES NOT SUBMIT"
   * and described herdr's CR/LF refusal as if it were the interface's rule. That was
   * herdr's semantics written into a shared type — harmless while herdr was the only
   * implementation, and wrong the moment a second backend with the opposite behaviour
   * became supported, because a caller reading this interface could no longer reason
   * about its own bytes. A backend-specific PRECONDITION belongs on the backend:
   * `HerdrHost` documents and enforces its CR/LF refusal itself.
   *
   * THE SUBMISSION-BEARING OPERATION IS {@link PtyChild.submitLine}, and it is the one
   * any caller that reports an outcome must use. Both backends implement it honestly
   * and differently — that is the contract to reason about, not this one.
   */
  write(data: string | Uint8Array): void
  /** Send one structured key (F2): encodes the correct key for
   *  enter/escape/ctrl-c/up/down/left/right/digit. Lets recovery detectors
   *  navigate Ink arrow-pickers + send Escape/Ctrl-C, which `write` cannot.
   *  Fire-and-forget like `write`; no-op-safe after exit. OPTIONAL: a
   *  backward-compatible extension — both real backends provide it; lightweight test
   *  fakes that never receive keystrokes may omit it. */
  writeKey?(key: Key): void
  /** Send a multi-key sequence (e.g. `['down','enter']` to pick the second option
   *  of an arrow-driven picker). No-op-safe after exit. OPTIONAL (see
   *  `writeKey`). */
  writeKeys?(keys: readonly Key[]): void

  /**
   * Submit `command` as a line, and RESOLVE ONLY WHEN THE BACKEND HAS ACKNOWLEDGED
   * BOTH HALVES — the text and the Enter that submits it.
   *
   * SETTLEMENT IS NOT CONFIRMATION. {@link write} and {@link writeKey} are `void`, on
   * every backend: over a socket they hand a frame to the transport and return, so a
   * caller cannot distinguish "the REPL received `/clear`" from "the socket refused the
   * frame"; over a local pty they hand bytes to a fd whose acceptance count is
   * discarded. Every caller of the old pair nonetheless REPORTED SUCCESS on return —
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
   * WHAT EACH BACKEND CAN HONESTLY ASSERT DIFFERS, and neither fakes the other's
   * claim. `HerdrHost` awaits the server's acknowledgement of the text and of the
   * Enter, as two ordered round trips — the only evidence available when
   * `pane.send_text` types without firing. `BunTerminalHost` checks that the pty
   * accepted every byte of each half, which on a local fd IS delivery, and where `\r`
   * genuinely submits. Neither asserts that the REPL ACTED on the line; no backend
   * can, and this contract does not ask.
   *
   * Optional only because a host may predate it; `submitCommand` refuses to guess
   * with `write` + `writeKey` when it is absent rather than fabricate an ack.
   */
  submitLine?(command: string): Promise<void>
  /**
   * Resize the terminal (cols × rows). No-op-safe after exit.
   *
   * OPTIONAL. `BunTerminalHost` provides it (a pty has a cols × rows setter); the
   * HERDR BACKEND DOES NOT. herdr's `pane.resize`
   * takes `{direction, amount}` — it nudges a split ratio; herdr's layout engine
   * owns pane geometry and there is no cols × rows setter anywhere in its API.
   * Declared optional rather than implemented as a silent no-op that reports
   * success. It has zero production callers, so nothing is narrowed by its
   * absence.
   */
  resize?(cols: number, rows: number): void
  /** Send a signal to the child (default SIGTERM). Idempotent after exit.
   *
   *  WHAT "SIGNAL" MEANS DIFFERS BY BACKEND, and only the CLASSIFICATION is shared: a
   *  SIGINT is an interrupt (abandon the turn, keep the child) and anything else is
   *  terminal, which is what {@link wasKilledByUs} and {@link wasInterruptedByUs}
   *  record. `BunTerminalHost` delivers the real signal to the process. Under herdr
   *  only SIGINT is a real signal (`ctrl+c` on the pane raises one); anything else
   *  has no primitive but closing the pane, which destroys it. */
  kill(signal?: NodeJS.Signals | number): void
  /**
   * Resolves when the child exits.
   *
   * ALWAYS `null` UNDER HERDR, BECAUSE NO EXIT CODES EXIST THERE — and a REAL kernel
   * status under `bun-terminal-host.ts`, which is the sharpest difference between the
   * two backends. herdr's
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
   * UNDER HERDR THIS IS THE WHOLE SIGNAL, not an optimisation over exit codes: see
   * {@link PtyChild.exited}. Under `BunTerminalHost` it is one of two inputs, since a
   * real exit code is also available — but `spawn.ts` evaluates
   * `!killedByUs && exitCode !== 0`, so a wrongly-latched flag short-circuits the code
   * on BOTH backends and the rule that only a terminal operation may latch it is not a
   * herdr-only rule. OPTIONAL only so a lightweight test fake may omit it; both real
   * backends provide it.
   */
  readonly wasKilledByUs?: () => boolean
  /**
   * WHY this child became terminal, once it has. `undefined` while it is alive.
   *
   * A HERDR-SHAPED FIELD, and `BunTerminalHost` does not provide it. It exists because
   * under herdr `exited` cannot carry the reason: no exit status exists anywhere in that
   * API, so every death resolves `null` and the routes to it are otherwise
   * indistinguishable — a pane we closed deliberately looks exactly like one whose
   * process ended on its own. An in-process pty has a real exit code and no concept of a
   * pane that stopped existing, so `undefined` there is the truth rather than a gap.
   * OPTIONAL for both reasons; a caller that needs to tell the routes apart must treat
   * `undefined` as "not known", never as a default.
   */
  readonly exitCause?: () => PtyExitCause | undefined
  /**
   * True once WE sent this child an INTERRUPT (SIGINT / Ctrl-C) — a request to
   * abandon the current turn, NOT to end the process.
   *
   * It exists so that a transient intent has its own representation instead of
   * borrowing {@link PtyChild.wasKilledByUs}. An earlier version latched
   * `wasKilledByUs` on SIGINT, which left the child ALIVE and flagged as
   * intentionally-terminated. That is fatal under herdr, where the flag is the ENTIRE
   * crash-vs-recycle discriminator, and still wrong under a backend WITH exit codes,
   * because `spawn.ts` evaluates `!killedByUs && exitCode !== 0` — a true flag
   * short-circuits the code before it is read. One interrupt silently reclassified every
   * later crash as a clean recycle for the rest of the child's life, on either backend.
   *
   * **MUST NEVER BE USED FOR EXIT CLASSIFICATION.** An interrupted child that later
   * dies unexpectedly has crashed. Only a terminal operation may say otherwise, and
   * `wasKilledByUs` is the only thing licensed to.
   */
  readonly wasInterruptedByUs?: () => boolean
  /**
   * Tell the host its consumer is wired, and screens may start flowing.
   *
   * ALWAYS CALLABLE, AND WHAT IT GATES DIFFERS. `HerdrHost` holds its poll loop
   * behind it; `BunTerminalHost` has the byte stream from the moment the child is
   * spawned and implements it as a no-op. A caller calls it unconditionally either way,
   * which is why it is part of the shared contract rather than a herdr detail.
   *
   * WHY IT EXISTS: `spawn` is async, and the caller cannot wire anything that
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
   * NOT A BYTE STREAM, ON EITHER BACKEND. Every delivery is the child's WHOLE current
   * screen and the consumer REPLACES its ring with it (`PtyRing.replace`) rather than
   * appending. `pty-ring.ts` carries the reasoning for why snapshot-replace was taken
   * over diff-append and how a turn is scoped under it.
   *
   * WHERE THE SCREEN COMES FROM DIFFERS, and it has a consequence worth knowing before
   * choosing a backend. herdr exposes no raw output, so `HerdrHost` synthesizes this by
   * polling `pane.read` — a RENDERED pane, in which an Ink repaint redraws the same
   * content and `PtyRing.textSince` sees nothing new. `BunTerminalHost` has the byte
   * stream and accumulates it, so a repaint really is new bytes and the same content
   * reads as new output. Anything relying on repaint collapsing works on herdr only.
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
  /** Callback when the child exits. `null` ALWAYS under herdr, which has no exit codes
   *  anywhere in its API; a real kernel status under `BunTerminalHost`. See
   *  {@link PtyChild.exited}. */
  onExit?: (code: number | null) => void
  /**
   * Preferred terminal size. HONOURED by `BunTerminalHost`, which allocates the pty
   * with it. ADVISORY ONLY under herdr, which ignores it: herdr's layout engine owns
   * pane geometry and exposes no cols × rows setter (see {@link PtyChild.resize}).
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
