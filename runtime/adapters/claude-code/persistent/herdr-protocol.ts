/**
 * herdr-protocol.ts — the wire vocabulary of herdr's unix-socket API, and the
 * constants the polling bridge is bounded by.
 *
 * § herdr step 2b. Everything in this file was MEASURED against the live server
 * on 2026-09-12 (herdr 0.8.2, protocol 20) rather than read off a document, and
 * the measurement is recorded beside each value because several of them are
 * load-bearing in a way their plain reading does not suggest.
 *
 * The framing is newline-delimited JSON in both directions: a request is
 * `{ id, method, params }`, a reply is `{ id, result }` or `{ id, error }`.
 */

import { PTY_OUTPUT_GATE_MAX_MS } from './pty-host.ts'

import type { Key, NamedKey } from './keystrokes.ts'

/**
 * The protocol version this client was written and measured against.
 *
 * THE SOCKET SERVER DOES NO VERSION CHECK — only herdr's own CLI guards, so a
 * server that has moved on will happily accept our requests and answer them with
 * different semantics. Protocol went 20 → 22 in 19 days, so this is a live risk,
 * not a theoretical one. `HerdrClient.connect` therefore `ping`s and FAILS
 * LOUDLY on a mismatch: not a warning, not a degraded mode. A silent semantic
 * drift underneath a REPL supervisor is the failure this constant exists to
 * prevent.
 */
export const HERDR_PROTOCOL_VERSION = 20

/**
 * How often the bridge polls `pane.read` to synthesize `onScreen`.
 *
 * BOUNDED BY THE IDLE GATE, NOT BY TASTE. `waitForReplIdle` (`spawn.ts`) treats
 * the REPL as idle once `lastDataAt` is `DEFAULT_IDLE_QUIET_MS` (900 ms,
 * `signatures.ts`) old, and `pool.ts` runs that gate before EVERY prompt inject.
 * `lastDataAt` only advances when a poll observes a CHANGED screen, so the poll
 * interval is the resolution at which "still emitting" can be observed at all:
 * an interval at or above the quiet window would let a continuously-emitting
 * REPL look idle in the gap between two observations, and the inject would land
 * mid-turn and be dropped. 250 ms leaves a 3.6× margin inside 900 ms.
 *
 * Pinned as a VALUE as well as a relation in the tests — a test that only
 * asserts `poll < quiet` passes unchanged when either constant moves.
 */
export const HERDR_POLL_INTERVAL_MS = 250

/**
 * Content lines the bridge wants out of `pane.read`, over and above the pane's
 * own viewport.
 *
 * 200 is the largest window any detector reads (`DISCLAIMER_BOTTOM_N`), so a
 * smaller value would silently blind the widest positional guard.
 */
export const HERDR_READ_WINDOW_LINES = 200

/**
 * The measured hard cap on `pane.read`, regardless of the `lines` asked for:
 * `lines=5000` on a pane that had printed 1500 lines returned exactly 999 with
 * `truncated: true`. Recorded so the window arithmetic can be checked against it
 * rather than against a guess.
 */
export const HERDR_READ_LINE_CAP = 999

/**
 * The read source the bridge polls. `recent_unwrapped` joins soft wraps, which
 * is what a line-addressed detector window needs; `visible` cannot reach past
 * the viewport into scrollback, and `detection` is herdr's own agent-detection
 * snapshot rather than ours.
 */
export const HERDR_READ_SOURCE = 'recent_unwrapped'

/**
 * Fallback viewport allowance when `pane.get` has not (yet) reported one.
 *
 * `lines=N` COUNTS BLANK VIEWPORT ROWS BEFORE TRIMMING. Measured: a pane with
 * three content lines under a 62-row viewport returned EMPTY text for
 * `recent_unwrapped lines=10`, and all three lines for `lines=200`. So every
 * request asks for `viewport_rows + HERDR_READ_WINDOW_LINES`, and when the
 * viewport is unknown this stands in for it. Chosen well above any terminal we
 * run (and `+ 200` still sits under {@link HERDR_READ_LINE_CAP}).
 */
export const HERDR_VIEWPORT_ROWS_FALLBACK = 120

/**
 * How long the host waits for its caller to call `beginOutput()` before releasing
 * screens anyway, with a warning.
 *
 * The gate is an ORDERING device, not a permission: withholding output forever is
 * worse than delivering it late, because a REPL whose screens never reach the
 * detectors is wedged silently. So a caller that forgets is told loudly and the
 * screens flow — late, but they flow.
 */
export const HERDR_OUTPUT_GATE_MAX_MS = PTY_OUTPUT_GATE_MAX_MS

/**
 * The largest UNTERMINATED inbound frame the client will buffer before declaring the
 * transport failed.
 *
 * WELL-FORMED-SO-FAR IS NOT COMPLETE. Without a bound, a peer that streams bytes and
 * never sends `0x0A` grows the buffer without limit — and, because each chunk is
 * concatenated onto the last, copies quadratically on the way to exhaustion. The RPC
 * clock does not help: bytes keep arriving whether or not any request is still
 * waiting for a reply.
 *
 * THIS IS THE UNDECLARED HALF OF THE RISK THIS FILE ALREADY GUARDS. The protocol went
 * 20 → 22 in nineteen days with no server-side version check, which is why
 * {@link HERDR_PROTOCOL_VERSION} exists — but the `ping` comparison only catches a
 * change the server DECLARES. A framing change that does not (a different delimiter,
 * a length prefix, a binary envelope) presents as exactly this: bytes that are
 * well-formed so far and never terminate.
 *
 * 8 MiB is derived, not picked. The largest legitimate frame is a `pane.read` reply
 * carrying a screen: herdr caps a read at 999 lines, and the ring bounds a retained
 * screen at 512 KiB, so a wide 999-line screen is a few hundred KB raw. JSON string
 * escaping can inflate that several-fold (`\n` doubles, a control byte becomes
 * `\uXXXX`), which puts a worst-case real frame in the low megabytes. 8 MiB leaves
 * headroom over that and is still far below memory exhaustion.
 */
export const HERDR_MAX_FRAME_BYTES = 8 * 1024 * 1024

/**
 * How long one RPC may go unanswered before the transport is declared failed.
 *
 * THE ROUTE WHERE NOTHING GOES WRONG. Zero writes, partial writes, thrown writes,
 * malformed replies and closed sockets all produce something to react to. A socket
 * that accepts the whole frame and then simply never answers produces NOTHING: no
 * error, no close, no event — and an unbounded pending promise. **A channel can be
 * unusable without anything about it being false**, so liveness here needs a clock,
 * not a predicate.
 *
 * It hangs the two worst places: `connectHerdr`'s mandatory `ping` (the gateway never
 * finishes starting, and there is nothing to read) and any `pane.read` in the poll
 * loop.
 *
 * 10 s is far above every call this client makes — the slowest is `layout.apply`,
 * which execs a process — and far below "forever". The poll cadence is 250 ms, so a
 * 10 s stall is already pathological rather than slow.
 */
export const HERDR_RPC_TIMEOUT_MS = 10_000

/**
 * The error code herdr returns when a pane genuinely does not exist.
 *
 * MEASURED on the live server: `pane.get` and `pane.read` against an unknown — or
 * malformed — pane id both answer
 * `{"code":"pane_not_found","message":"pane w99:p999 not found"}`. Because the code
 * is TYPED, absence is discriminable from failure, and the bridge must discriminate:
 * a timeout, a transient server error or a transport hiccup are all rejections that
 * say nothing about whether the pane is there. **A rejection measures the call, not
 * the pane.**
 */
export const HERDR_PANE_NOT_FOUND = 'pane_not_found'

/**
 * How often the bridge RE-READS the pane's viewport height.
 *
 * A PANE CAN BE RESIZED AT ANY TIME — the owner drags a split, attaches from a
 * different terminal, zooms a pane. Reading `viewport_rows` once and caching it
 * forever makes every later read ask for the wrong number of lines, and the error
 * is silent in the dangerous direction: a viewport that GREW leaves the request too
 * small, blank rows eat the whole allowance (they count before trimming), and the
 * read returns NO CONTENT. That blinds every positional detector without anything
 * failing. 5 s is ~20 polls at the 250 ms cadence — cheap next to `pane.read`, and
 * far tighter than a human resizing a window.
 */
export const HERDR_VIEWPORT_REFRESH_MS = 5000

/**
 * Our internal {@link Key} names mapped onto herdr's key vocabulary.
 *
 * KEY NAMES USE `+`, NOT `-`. Measured directly against the live server by
 * sending each candidate: `enter`, `esc`, `escape`, `tab`, `up`, `down`, `left`,
 * `right`, `ctrl+c` and bare digits are all accepted; `ctrl-c` is REJECTED
 * (`invalid_key: unsupported key ctrl-c`), as are `arrow_up` and `ArrowUp`.
 * `ctrl+c` delivers a real SIGINT.
 *
 * Our own union spells the key `'ctrl-c'` (`keystrokes.ts`), so this table is
 * the translation and that single entry is the only place the hyphen dies —
 * every other name is herdr's own spelling unchanged. Pinned per-key by value in
 * the tests, because a test asserting only "no hyphens appear" would pass a
 * table that had silently lost an entry.
 */
export const HERDR_KEY_NAMES: Record<NamedKey, string> = {
  enter: 'enter',
  escape: 'esc',
  'ctrl-c': 'ctrl+c',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
}

/**
 * The `lines` to ask `pane.read` for, given the pane's viewport height — and what
 * that request can actually deliver.
 *
 * TWO CONSTRAINTS PULL AGAINST EACH OTHER. Blank viewport rows count toward `lines`
 * BEFORE trimming, so the request must be `viewport_rows + wanted` or a cleared pane
 * returns nothing. But the server hard-caps at {@link HERDR_READ_LINE_CAP}
 * regardless of what is asked. Up to AND INCLUDING a viewport of
 * `HERDR_READ_LINE_CAP - HERDR_READ_WINDOW_LINES` (= 799) both hold at once — at
 * exactly 799 the request is 999, which is the cap precisely. ABOVE it they cannot:
 * an 800-row viewport would need 1,000 lines to clear its own blanks and still yield
 * 200 of content, and the server will not return more than 999.
 *
 * THE POLICY IS TO CLAMP AND SAY SO, never to ask for more than the server will give
 * and quietly receive less. Asking for 1,000 gets 999 either way; the difference is
 * whether anything knows the content window has shrunk. `contentAllowance` is the
 * lines of real content the request can still carry, and it goes NEGATIVE for a
 * viewport at or past the cap — a pane that tall cannot be read past its own screen
 * at all, which is a fact the caller must surface rather than discover as an empty
 * detector window.
 */
export interface HerdrReadWindow {
  /** The `lines` value to send. Never above {@link HERDR_READ_LINE_CAP}. */
  readonly lines: number
  /** Content lines this request can carry beyond the viewport's own blank rows.
   *  `HERDR_READ_WINDOW_LINES` when unclamped; smaller (or negative) when clamped. */
  readonly contentAllowance: number
  /** True when the cap bit — the caller promised a window it cannot fully get. */
  readonly clamped: boolean
  /** True when the clamp cut below the widest detector window, i.e. a positional
   *  guard may now see less than it was written against. */
  readonly belowDetectorWindow: boolean
}

/** Compute the read window for a viewport. See {@link HerdrReadWindow}. */
export function herdrReadWindow(
  viewportRows: number,
  wanted: number = HERDR_READ_WINDOW_LINES,
  cap: number = HERDR_READ_LINE_CAP,
): HerdrReadWindow {
  const requested = viewportRows + wanted
  const lines = Math.min(requested, cap)
  const contentAllowance = lines - viewportRows
  const clamped = requested > cap
  return { lines, contentAllowance, clamped, belowDetectorWindow: contentAllowance < wanted }
}

/** A digit key is sent as its own character; herdr accepts the literal. */
function isDigitKey(key: string): boolean {
  return key.length === 1 && key >= '0' && key <= '9'
}

/** herdr's name for one {@link Key}. Throws on an unknown key so a typo in a
 *  detector's action surfaces here rather than as an `invalid_key` from the
 *  server after the rest of a multi-key sequence has already been written. */
export function herdrKeyName(key: Key): string {
  if (isDigitKey(key)) return key
  const name = HERDR_KEY_NAMES[key as NamedKey]
  if (name === undefined) {
    throw new Error(`herdr-protocol: no herdr key name for '${String(key)}'`)
  }
  return name
}

/** herdr's names for a multi-key sequence, in order. */
export function herdrKeyNames(keys: readonly Key[]): string[] {
  return keys.map(herdrKeyName)
}

// ————————————————————————————————————————————————————————————————————————————
// Wire shapes. Narrow on purpose: only the fields this bridge reads, so a
// server-side addition cannot break the types, and a server-side REMOVAL of
// something we read shows up as a runtime shape error rather than silently
// typechecking.
// ————————————————————————————————————————————————————————————————————————————

/** `ping` → the only place the server states its protocol version. */
export interface HerdrPong {
  readonly type: 'pong'
  readonly version: string
  readonly protocol: number
}

/** One `pane.read` reply. `revision` is INERT — hardcoded 0 on every read
 *  (measured), which is why the bridge mints its own poll sequence instead. */
export interface HerdrPaneRead {
  readonly pane_id: string
  readonly source: string
  readonly text: string
  readonly revision: number
  readonly truncated: boolean
}

/** A pane's live geometry, via `pane.get`. */
export interface HerdrPaneInfo {
  readonly pane_id: string
  readonly scroll?: { readonly viewport_rows: number } | null
  /** The pane's label — what {@link HERDR_REPL_PANE_LABEL} put there at spawn.
   *  NULLABLE in herdr's own schema and measured as absent on panes nobody
   *  labelled, so it is REPORTED but never gated on: a REPL whose label herdr
   *  dropped on a restore is still the REPL, and a stranger's pane could carry any
   *  label at all. Identity comes from the argv (`pane.process_info`), not here. */
  readonly label?: string | null
}

/** One entry of `pane.process_info.foreground_processes`. */
export interface HerdrProcess {
  readonly pid: number
  readonly name?: string
  readonly argv?: readonly string[]
}

/** `pane.process_info`. `shell_pid` is NULLABLE, and for a `layout.apply` pane it
 *  is the argv's OWN pid (measured: equal to `foreground_processes[0].pid`). */
export interface HerdrProcessInfo {
  readonly pane_id: string
  readonly shell_pid?: number | null
  readonly foreground_processes?: readonly HerdrProcess[]
}

/** A `LayoutNode` of type `pane`. `command` genuinely EXECS — this is the spawn
 *  primitive, in preference to `agent.start` (which shell-quotes argv and types
 *  it into a running shell, and whose `kind` is a compiled-in enum). */
export interface HerdrLayoutPaneNode {
  readonly type: 'pane'
  readonly command?: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly label?: string
}

/** `layout.apply` reply. THE IDS COME BACK CHANGED: applying a layout to an
 *  existing tab REPLACES it and mints a new tab id and new pane ids (measured:
 *  a request naming `w6:t2` answered with `tab_id: w6:t3`). Never assume the
 *  requested tab id survived — read it from here. */
export interface HerdrLayoutApply {
  readonly layout: {
    readonly workspace_id?: string
    readonly tab_id: string
    readonly root: { readonly pane_id: string }
  }
}
