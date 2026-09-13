/**
 * bun-terminal-host.ts — the IN-PROCESS `PtyHost` backend: Bun's native PTY.
 *
 * `new Bun.Terminal({ cols, rows, data })` + `Bun.spawn(argv, { terminal })` attaches
 * a real PTY to the child (the child sees `process.stdout.isTTY === true`). No native
 * module, no `dlopen`, no `tmux -CC` TTY-coercion. POSIX-only (Linux + macOS). Bun
 * floor ≥ 1.3.5, when `Bun.Terminal` landed.
 *
 * NOT THE DEFAULT, AND NOT WIRED TO A CHOOSER. `spawn.ts` resolves
 * `options.ptyHost ?? herdrHost`: herdr is the only wired backend, and this one is
 * reached by INJECTING it at that seam. It is kept compiling, contract-complete and
 * tested so the option survives at near-zero cost — not so that it is exercised.
 * Building a user-facing switch between a proven path and an unproven one would hide
 * which is which, and that is a decision for after the herdr path is verified live.
 *
 * THE TWO BACKENDS ARE NOT INTERCHANGEABLE, and the differences are not incidental —
 * each is something herdr genuinely cannot express. Stated here and in the spec item
 * so the next reader does not assume parity:
 *
 *  1. EXIT CODES. This host has real kernel exit codes (`proc.exited` resolves the
 *     child's status). herdr has none anywhere in its API, so under `HerdrHost`
 *     `exited` always resolves `null` and crash-versus-recycle collapses ENTIRELY onto
 *     `wasKilledByUs`. Code that reads the exit code is strictly better informed here;
 *     code that relies on it is code that only works here.
 *  2. EXIT DETECTION. This host is TOLD: `proc.exited` settles. `HerdrHost` polls
 *     `pane.read` and concludes from a typed `pane_not_found`, so its exit is
 *     discovered on the tick after it becomes true rather than at the instant it does.
 *  3. `onScreen`. `HerdrHost` synthesizes it by polling a rendered pane. This host has
 *     the byte stream and derives the screen from it — see {@link BunTerminalHost} for
 *     why that means ACCUMULATING rather than forwarding each chunk.
 *
 * `exitCause` is deliberately NOT provided here. Its two values (`'closed-by-us'`,
 * `'pane-vanished'`) name herdr's routes, and "the pane does not exist" has no meaning
 * for an in-process PTY. It is optional on the interface, and `undefined` there means
 * "not known" — which is the truth — whereas answering `'pane-vanished'` for a process
 * that exited normally would be a claim about a mechanism this backend does not have.
 */

import { stripPtyNoise, newDcsStripState, type DcsStripState } from './pty-noise.ts'
import { encodeKey, encodeKeys, type Key } from './keystrokes.ts'
import { clampLeadingLines, DEFAULT_RING_MAX_BYTES } from './pty-ring.ts'
import { PTY_OUTPUT_GATE_MAX_MS, type PtyChild, type PtyHost, type PtySpawnOpts } from './pty-host.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

/**
 * How much accumulated output this host keeps as "the screen", in UTF-8 BYTES.
 *
 * BYTES, NOT LINES, and the first version got this wrong. A line-count bound
 * (`bottomNLines(screen, 2000)`) cannot bound memory at all, because a LINE IS
 * UNBOUNDED: a child whose output contains no newline — `yes x | tr -d '\n'` is the
 * one-command repro — is a single line forever, and every "trim" then retains
 * everything. The quantity that bounds memory is bytes, so that is the quantity the
 * code holds. This is the same move the herdr client's inbound buffer needed three
 * times (copying, retention, allocation count): stop bounding a proxy for the resource
 * and bound the resource.
 *
 * Set to the RING's own cap, deliberately: the host never retains more than its
 * consumer would keep, so the two cannot drift into a state where this holds megabytes
 * the ring is about to discard.
 */
const SCREEN_MAX_BYTES = DEFAULT_RING_MAX_BYTES

/**
 * Clamp down to this, not to the cap, when the cap is exceeded.
 *
 * A LOW-WATER MARK, for the same reason the client's buffer doubles rather than growing
 * by one: trimming back to exactly the cap means the very next chunk is over it again,
 * and an O(screen) clamp per chunk is the quadratic behaviour this branch already
 * removed once. Cutting to three quarters buys a quarter of the budget before the next
 * clamp, so the clamp is amortised O(1) per byte.
 */
const SCREEN_TRIM_TO_BYTES = Math.floor(SCREEN_MAX_BYTES * 0.75)

/**
 * The screen accumulator, EXTRACTED AND EXPORTED so it can be tested without a pty.
 *
 * Not extracted for tidiness — extracted because the pty fixture cannot test it. A pty
 * has a fixed kernel buffer and no flow control: when the reader is slower than the
 * writer the kernel DROPS output, silently and by a varying amount (measured: the same
 * 3 MB child delivered 490 KB on one run and 317 KB on another). So a bound asserted
 * end-to-end through a real pty can pass because the child's output never reached the
 * cap, and it can fail for reasons that have nothing to do with the bound. A fixture
 * does not have to be permissive to hide a defect; it only has to be unrepresentative.
 *
 * Driven directly, this is a pure function of the chunk sequence, and the byte bound is
 * decidable.
 */
export function newScreenAccumulator(
  maxBytes: number = SCREEN_MAX_BYTES,
  trimToBytes: number = SCREEN_TRIM_TO_BYTES,
): { push: (text: string) => string } {
  let screen = ''
  // TRACKED INCREMENTALLY. Measuring the whole accumulation on every delivery would be
  // O(screen) per chunk — cheap per call and quadratic over a session, which is exactly
  // the shape that had to be removed from the herdr client's inbound buffer.
  let bytes = 0
  return {
    push(text: string): string {
      screen += text
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes) {
        // ONE implementation of "cut a string to a byte budget, line-aligned, without
        // splitting a character" — `pty-ring.ts`'s, which already had to get the
        // mid-line cut and the surrogate pair right. It drops whole leading lines
        // first and falls back to a byte-boundary tail for a single over-long line,
        // which is the case a line-count bound could not reach. It preserves the line
        // structure exactly, including a trailing newline, so nothing here has to
        // reason about joining the last line to the next chunk.
        screen = clampLeadingLines(screen, trimToBytes)
        bytes = Buffer.byteLength(screen, 'utf8')
      }
      return screen
    },
  }
}

/**
 * Hand `data` to a pty write function and REPORT whether the kernel took all of it.
 *
 * EXPORTED AND SEAM-TAKING, for the same reason the accumulator is: the defect this
 * guards cannot be produced from outside. A real pty does not short-write for the small
 * payloads `submitLine` sends, so a mutation that deletes the check survives every
 * end-to-end test — it did, and the as-built recorded it as an uncovered boundary
 * rather than a covered one. Taking the write function as an argument makes zero and
 * partial acceptance ordinary inputs instead of conditions nobody can arrange.
 *
 * BYTES, NOT `String.length`. `terminal.write` returns bytes ACCEPTED, so comparing
 * against UTF-16 code units is too LAX for anything non-ASCII: a 2-byte character
 * counts as one unit, so a write that delivered half the payload can still look
 * complete. The same confusion was fixed three times on the herdr side of this branch.
 */
export function writeAllOrThrow(
  write: (data: string | Uint8Array) => number,
  data: string | Uint8Array,
  what: string,
): void {
  const expected = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length
  const written = write(data)
  if (written < expected) {
    throw new Error(
      `bun-terminal-host: short write of ${what} — the pty accepted ${written} of ` +
        `${expected} bytes, so the command was not fully delivered.`,
    )
  }
}

/** Minimal shape of `Bun.Terminal` we consume (kept narrow so the file type-
 *  checks even where the ambient Bun types lag the runtime). */
interface BunTerminalLike {
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}
interface BunTerminalCtor {
  new (opts: {
    cols?: number
    rows?: number
    data?: (term: BunTerminalLike, bytes: Uint8Array) => void
    exit?: (term: BunTerminalLike, code: number, signal: string | null) => void
  }): BunTerminalLike
}
interface BunSpawnedLike {
  readonly pid: number
  readonly exited: Promise<number | null>
  readonly exitCode: number | null
  kill(signal?: NodeJS.Signals | number): void
}

const BunTerminal = (Bun as unknown as { Terminal: BunTerminalCtor }).Terminal
const bunSpawn = (
  Bun as unknown as { spawn: (opts: Record<string, unknown>) => BunSpawnedLike }
).spawn

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

/**
 * Injection points, so the whole backend is drivable WITHOUT A REAL PTY.
 *
 * The same seam `HerdrHost` has for its socket, added for the same reason and after the
 * same evidence: the failure modes that matter here cannot be arranged on a real pty. A
 * kernel does not short-write the small payloads `submitLine` sends, so the mutation
 * that unwires the short-write guard from `submitLine` survived every end-to-end case —
 * the guard was tested and its WIRING was not. Extracting the check made the check
 * assertable; injecting the terminal makes the wiring assertable, which is the half a
 * pure helper could not reach.
 *
 * Production uses the defaults and never passes these.
 */
export interface BunTerminalHostDeps {
  /** Create the pty. Defaults to `new Bun.Terminal(...)`. */
  createTerminal?: (opts: {
    cols?: number
    rows?: number
    data?: (term: BunTerminalLike, bytes: Uint8Array) => void
  }) => BunTerminalLike
  /** Spawn the child attached to that pty. Defaults to `Bun.spawn`. */
  spawn?: (opts: Record<string, unknown>) => BunSpawnedLike
  /** How long to wait for `beginOutput()` before releasing screens anyway, with a
   *  warning. Defaults to the SHARED {@link PTY_OUTPUT_GATE_MAX_MS}; a test shortens it
   *  so the fail-open path is fast. Mirrors `HerdrHostDeps.outputGateMaxMs`. */
  outputGateMaxMs?: number
}

export class BunTerminalHost implements PtyHost {
  constructor(private readonly deps: BunTerminalHostDeps = {}) {}

  /**
   * `async` ONLY to satisfy the interface, and that is worth saying rather than
   * hiding: `PtyHost.spawn` became `Promise<PtyChild>` because creating a herdr pane
   * is a socket round trip and a synchronous `spawn` would hand back a child whose
   * `pid` reads 0 while supervision probes it. Here the pid exists the moment
   * `Bun.spawn` returns, so the promise is already resolved. Widening the interface
   * for the backend that needs it costs this one nothing.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild> {
    if (argv.length === 0) {
      throw new Error('bun-terminal-host: argv must be non-empty')
    }
    const stripState: DcsStripState = newDcsStripState()
    let exited = false
    // Set the instant WE signal the child with a TERMINAL signal, so the spawn exit
    // handler can distinguish a crash from an expected recycle.
    let killedByUs = false
    // An INTERRUPT is not a termination, and it gets its own flag for the reason the
    // herdr backend learned the hard way: `wasKilledByUs` is what licenses a 'clean'
    // exit verdict, so latching it on a SIGINT leaves the child ALIVE and flagged as
    // intentionally terminated, and every later crash reads as a routine recycle. The
    // old version of this file latched on any signal. It is the same defect here even
    // though this backend has exit codes, because `spawn.ts` evaluates
    // `!killedByUs && exitCode !== 0` — a true flag short-circuits the code entirely.
    let interruptedByUs = false
    let exitResolve: (code: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      exitResolve = res
    })

    // THE SCREEN IS ACCUMULATED, NOT FORWARDED. `onScreen` promises the consumer a
    // WHOLE current screen, and `PtyRing` REPLACES its contents with each delivery.
    // Handing it one byte chunk at a time would therefore make every delivery erase
    // all previous output — the exact inverse of the old `onData` contract, and
    // silently: the ring would look alive and hold only the last few bytes.
    const accumulator = newScreenAccumulator()

    // THE READINESS GATE, AND IT IS NOT A NO-OP HERE EITHER.
    //
    // This host has the byte stream from the instant the child is spawned, so it was
    // written to forward straight through and return an empty `beginOutput`. That
    // reintroduces exactly the race the gate exists to prevent, and the shared contract
    // is where the requirement lives — not in the backend that happened to need it
    // first. `spawn.ts` cannot assign `scanChild` until `await ptyHost.spawn(...)`
    // RETURNS, and it releases output only after the rest of its wiring completes. A
    // child that writes before then — a startup trust prompt, an approval dialog — is
    // recorded into a ring with no detector attached, and because the ring is
    // snapshot-replace the screen is never re-delivered: the prompt's keystroke never
    // fires and the REPL waits forever on a dialog nobody saw.
    //
    // The gate holds the CALL, never the bytes: output accumulates throughout and the
    // latest screen is delivered the moment the consumer exists.
    let outputReleased = false
    let heldScreen: string | undefined
    let gateTimer: ReturnType<typeof setTimeout> | undefined
    const gateMaxMs = this.deps.outputGateMaxMs ?? PTY_OUTPUT_GATE_MAX_MS
    let spawnedPid: number | undefined
    const releaseOutput = (): void => {
      if (outputReleased) return
      outputReleased = true
      const held = heldScreen
      heldScreen = undefined
      if (held !== undefined && opts.onScreen !== undefined) {
        // A THROWING CONSUMER MUST NOT PROPAGATE INTO THE HOST'S CALLER, and here it
        // would: this host delivers SYNCHRONOUSLY from `beginOutput()`, so a detector
        // that threw would come back out of the caller's own readiness handshake, while
        // under herdr the same throw is swallowed by the poll loop. Found while
        // enumerating the latch-before-a-fallible-act sites — a different rule, the same
        // sweep: a caller must not be able to tell which backend it has by how its own
        // bug reaches it.
        try {
          opts.onScreen(held)
        } catch {
          // Same policy as the poll loop's dispatch on the herdr side.
        }
      }
    }
    // FAIL OPEN, LOUDLY — the same policy as the herdr host, for the same reason.
    // Withholding output forever is worse than delivering it late: a REPL whose screens
    // never reach the detectors is wedged silently and looks idle. The gate orders
    // delivery; it does not authorise it.
    gateTimer = setTimeout(() => {
      if (outputReleased) return
      process.stderr.write(
        `[bun-terminal-host] pid ${String(spawnedPid ?? 'pending')}: beginOutput() was not ` +
          `called within ${gateMaxMs}ms — releasing screens anyway. This is a WIRING BUG in the ` +
          `caller: screens delivered before its consumer exists cannot be scanned, and a ` +
          `snapshot-replace ring never re-delivers an unchanged screen.\n`,
      )
      releaseOutput()
    }, gateMaxMs)
    // A STREAMING decoder. `stripPtyNoise` removes escape sequences at the BYTE level,
    // so a stripped chunk can end mid-character; decoding each chunk independently
    // turns that into U+FFFD pairs while everything downstream still looks like text.
    const decoder = new TextDecoder('utf-8')

    const createTerminal = this.deps.createTerminal ?? ((o) => new BunTerminal(o))

    // THE OBLIGATION STARTS WHEN THE RESOURCE EXISTS, NOT WHEN THE FUNCTION SUCCEEDS.
    //
    // Third time this branch has met this, and the first two are why it is written out
    // here: the host learned it as `abandonPane` (a `layout.apply` that returned left a
    // pane and a `claude` running, and both post-creation failures closed only the
    // connection), and the live E2E suites learned it again by leaking four real panes
    // into the owner's herdr because their spawn sat outside the `try`. It was STILL in
    // this backend. By the time `Bun.spawn` runs, the readiness timer is armed and the
    // pty is allocated — so an executable that does not exist is enough to reject out of
    // `spawn()` with an open terminal, and five seconds later emit a `beginOutput()`
    // wiring warning about a child that was never created. A false diagnostic on top of
    // a leak.
    //
    // Both the allocation and the spawn are inside, because `createTerminal` can throw
    // too — with nothing to close, but with the timer already armed.
    let allocated: BunTerminalLike | undefined
    let proc: BunSpawnedLike
    try {
      allocated = createTerminal({
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 40,
        data: (_t, bytes) => {
          if (opts.onScreen === undefined) return
          const clean = stripPtyNoise(bytes, stripState)
          if (clean.length === 0) return
          const text = decoder.decode(clean, { stream: true })
          if (text === '') return // the chunk was a partial character; wait for the rest
          // ACCUMULATE ALWAYS, DELIVER ONLY ONCE RELEASED. The bytes are never dropped;
          // what the gate holds back is the CALL, so a screen produced before the
          // consumer exists is delivered the moment it does.
          const screen = accumulator.push(text)
          if (!outputReleased) {
            heldScreen = screen
            return
          }
          try {
            opts.onScreen(screen)
          } catch {
            // A throwing consumer must not kill the stream, exactly as it must not kill
            // the herdr poll loop.
          }
        },
      })
      proc = (this.deps.spawn ?? bunSpawn)({
        cmd: argv,
        cwd: opts.cwd,
        env: compactEnv(opts.env),
        terminal: allocated,
      })
    } catch (e) {
      clearTimeout(gateTimer)
      try {
        allocated?.close()
      } catch {
        // Best-effort: a close that fails must not mask the error that caused the
        // abandonment — the same rule `abandonPane` follows on the herdr side.
      }
      throw e
    }
    const terminal = allocated
    spawnedPid = proc.pid

    // Surface the real subprocess exit (the Terminal `exit` cb reports PTY
    // lifecycle, not the child exit code — per Bun docs we use proc.exited).
    fireAndForget(
      'bun-terminal-host.exit',
      proc.exited.then((code) => {
        exited = true
        // THE EXIT SETTLES; IT DOES NOT RELEASE. Recording that the child is gone is not
        // the same act as delivering its screen, and conflating them was a race in the
        // exact case the gate exists for.
        //
        // An earlier version released here, reasoning that a dead child's last screen is
        // the only record of what it printed and must not be withheld. The reason is
        // sound and is preserved — the held screen IS still delivered, at release rather
        // than before it. What was wrong was the ordering, and the comment that claimed
        // this "runs on a later tick than `spawn()` returning, so it cannot pre-empt the
        // caller's await" was simply false: if `proc.exited` is ALREADY RESOLVED, this
        // callback is queued as a microtask BEFORE the caller's continuation from
        // `await host.spawn(...)`, so `onScreen` fired before the caller even held the
        // child. A child that dies instantly is also the child whose output most needs a
        // detector already attached.
        //
        // So the gate survives the exit. The timer stays armed too: a caller that never
        // calls `beginOutput()` still gets the final screen, late and with the warning it
        // has earned, rather than never.
        try {
          terminal.close()
        } catch {
          // best-effort
        }
        if (opts.onExit !== undefined) {
          // A THROWING CONSUMER MUST NOT BREAK THE EXIT PATH — and here it did more than
          // break it, it STRANDED it. The throw propagated out of this handler and
          // rejected the promise `fireAndForget` holds, which logs and swallows, so
          // `exitResolve` below never ran: `hasExited()` returned true while
          // `child.exited` stayed pending forever. Every caller that awaits the exit —
          // the escalation ladder, the pool's teardown — waits on a child that is
          // already gone.
          //
          // `HerdrHost` has carried this guard since its own exit path was written. That
          // is the THIRD asymmetry of this kind found on this backend (the kill latch,
          // the `onScreen` dispatch, now this), so the fix came with an enumeration of
          // every consumer callback either host invokes rather than a fix at the site
          // that was reported.
          try {
            opts.onExit(code)
          } catch {
            // Logged nowhere on purpose: the consumer's own failure is the consumer's,
            // and the exit must settle regardless.
          }
        }
        exitResolve(code)
      }),
    )

    const child: PtyChild = {
      pid: proc.pid,
      write(data) {
        if (exited) return
        terminal.write(data)
      },
      writeKey(key: Key) {
        if (exited) return
        terminal.write(encodeKey(key))
      },
      writeKeys(keys: readonly Key[]) {
        if (exited) return
        if (keys.length === 0) return
        terminal.write(encodeKeys(keys))
      },
      /**
       * THE HONEST ACKNOWLEDGEMENT THIS BACKEND CAN ACTUALLY MAKE, and no more.
       *
       * `submitCommand` refuses a child without this method because a detached write
       * cannot support a claim about its effect. Under herdr that is literally true:
       * `pane.send_text` types without firing, and a frame handed to a socket may be
       * refused, so only a round trip can tell a delivered command from a lost one.
       *
       * Here the seam is a local pty fd. A `terminal.write` that accepts every byte
       * HAS delivered them to the kernel, and `\r` on a pty genuinely submits — so
       * "the bytes reached the child's terminal" is a fact this host can assert
       * synchronously, and a short write is a fact it can refuse on. What it still
       * CANNOT assert is that the REPL acted on the line; no backend can, and
       * `submitLine`'s contract does not ask for it.
       *
       * So this is deliberately not a fabricated round trip. It is the strongest
       * true statement available on this substrate, which is why the two backends'
       * implementations look so different for the same method.
       */
      // eslint-disable-next-line @typescript-eslint/require-await
      async submitLine(command: string): Promise<void> {
        if (exited) {
          throw new Error(
            `bun-terminal-host: submitLine(${JSON.stringify(command)}) after exit — the child is ` +
              'gone, so the command was not submitted.',
          )
        }
        // TEXT FIRST, THEN THE SUBMIT, each checked: an unacknowledged text followed
        // by a blind Enter submits whatever was already at the prompt.
        const write = (d: string | Uint8Array): number => terminal.write(d)
        if (command !== '') writeAllOrThrow(write, command, JSON.stringify(command))
        writeAllOrThrow(write, encodeKey('enter'), "the 'enter' key")
      },
      resize(cols, rows) {
        if (exited) return
        try {
          terminal.resize(cols, rows)
        } catch {
          // best-effort; terminal may have closed
        }
      },
      kill(signal) {
        if (exited) return
        // CLASSIFY BEFORE LATCHING — see `interruptedByUs` above.
        const asInt = signal === 'SIGINT' || signal === 2
        if (asInt) interruptedByUs = true
        else killedByUs = true
        try {
          proc.kill(signal)
        } catch (e) {
          // A SIGNAL THAT THREW WAS NEVER DELIVERED, so the flag asserting it was must
          // not survive. This is the same rule `herdr-host.ts` states for a failed
          // `pane.close` — "do not settle, and do not latch; clearing the flag leaves
          // the child exactly as it is, alive and unflagged, which is both the truth and
          // what RE-ARMS the ladder" — and both of its named consequences apply here
          // unchanged. `spawn.ts` evaluates `!killedByUs && exitCode !== 0`, so a latched
          // flag short-circuits the exit code entirely and the child's later NONZERO exit
          // — a real crash, since nothing killed it — reads as a clean recycle. And
          // `repl-session.ts`'s escalation returns early at both of its `hasExited()`
          // guards, so leaving the child unflagged is what lets the SIGKILL retry fire.
          //
          // GUARDED ON LIVENESS. ONCE A TERMINAL STATE IS SETTLED, NO LATER PATH MAY
          // REWRITE IT: clearing after the exit had settled would flip `wasKilledByUs()`
          // from true to false and rewrite a deliberate recycle into an apparent crash —
          // the same defect in the opposite direction, a cleanup path that never asked
          // whether the question was still open. `herdr-host.ts` carries the identical
          // guard for the identical reason.
          //
          // IT IS UNREACHABLE IN THIS HOST TODAY, AND THAT IS WORTH SAYING RATHER THAN
          // IMPLYING OTHERWISE. `exited` is set in ONE place — the `proc.exited` handler,
          // a microtask — and this whole method is synchronous from its entry guard
          // through `proc.kill` to this catch, so `exited` cannot change mid-call. The
          // guard that actually runs is the one at the top. They are therefore REDUNDANT
          // for the flag, each absorbing a single mutation of the other, and only the
          // COMBINED mutation reddens; the top one has its own independent observable
          // (an already-exited child is not signalled at all). The difference from the
          // herdr sibling is real: there the failure arrives as an async rejection, so
          // the exit genuinely can settle in between. This one is kept because the rule
          // is the shared rule and the interface admits a host whose `kill` awaits — not
          // because a test can see it.
          if (exited) return
          if (asInt) interruptedByUs = false
          else killedByUs = false
          process.stderr.write(
            `[bun-terminal-host] pid ${proc.pid}: kill(${String(signal ?? 'SIGTERM')}) FAILED ` +
              `(${e instanceof Error ? e.message : String(e)}) — the signal was NOT delivered. ` +
              `Leaving the child unflagged: claiming a termination that did not happen would ` +
              `disarm the caller's SIGKILL escalation and misreport a later crash as an ` +
              `intentional recycle.\n`,
          )
        }
      },
      exited: exitedPromise,
      hasExited: () => exited,
      wasKilledByUs: () => killedByUs,
      wasInterruptedByUs: () => interruptedByUs,
      beginOutput: () => {
        clearTimeout(gateTimer)
        releaseOutput()
      },
    }
    return child
  }
}

/** The in-process POSIX backend, reachable by injection at `spawn.ts`'s
 *  `options.ptyHost` seam. NOT the default — see this file's header. */
export const bunTerminalHost: PtyHost = new BunTerminalHost()
