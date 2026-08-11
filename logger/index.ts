/**
 * @neutronai/logger — the ONE leveled key=value logger for the repo (refactor O1).
 *
 * `createLogger(subsystem)` emits lines in the repo's best existing convention
 * (`LOG_TAG event=… k=v`, e.g. gateway/http/chat-bridge.ts,
 * gateway/proactive/reminder-outbound.ts):
 *
 *     [subsystem] event=<event> k=v k2="v with spaces"
 *
 * LEVELS — `error | warn | info | debug`, gated by the `NEUTRON_LOG_LEVEL`
 * env var (case-insensitive; unset/unknown → `info`). The env var is read on
 * EVERY emit, not cached at `createLogger` time, so long-lived singleton
 * loggers honor a level change without a process restart and tests can flip
 * the level around individual calls.
 *
 * SUPPRESSION HELPERS — these generalize the three hand-rolled patterns O2
 * will swap onto this package; their semantics deliberately match the
 * originals closely enough that the swaps are behavior-preserving under a
 * forward clock and a sink that returns. They are NOT bit-for-bit the
 * originals. Two differences change OBSERVABLE SUPPRESSION, and both are
 * deliberate and load-bearing:
 *
 *   1. A BACKWARD clock step EMITS, where the original would have suppressed.
 *   2. The window is stamped BEFORE the sink call, so a THROWING sink consumes
 *      it. The original stamps AFTER its delivery call returns
 *      (`runtime/adapters/claude-code/persistent/supervision.ts` — `postAlert?.()`
 *      then `wedgeAlertState.set(...)`), so a throwing alert leaves the
 *      original's window open and does NOT leave ours open.
 *
 * A third difference is in the clock READS, and it shifts window boundaries
 * rather than changing which rule applies. The gate and the stamp call `clock()`
 * SEPARATELY (the gate's read is skipped on a key's first emit, which
 * short-circuits on `last === undefined` before reading), whereas the original
 * captures a single `now` (`supervision.ts` — `const now = (wopts.now ??
 * Date.now)()`) and reuses it for both the comparison and the stamp. So the
 * anchor written here is a LATER reading than the one eligibility was decided
 * on, which pushes the next window boundary out by the gap between the two
 * reads. On a real clock that gap is negligible; with an injected clock that
 * advances per call it is whatever the test makes it, so a counter-style `now`
 * will not reproduce the original's arithmetic.
 *
 * This list is the set of differences that have been LOOKED FOR, not a proof
 * that no fourth exists — an earlier revision of this docblock asserted "ONE
 * deliberate exception" and then documented a second one thirty lines later.
 * Do not "fix" any of them without reading the argument where it is
 * implemented.
 *
 *   - `once(key)` — the GBrain unavailable latch
 *     (gbrain-memory/GBrainSyncHook.ts `latchIfUnavailable`): the FIRST
 *     passing emit under a key logs and latches; every later emit under that
 *     key is silent for the rest of the process. "Exactly ONE
 *     `gbrain_unavailable` event."
 *
 *   - `clearOnce(key)` — the falling edge of an EDGE-TRIGGERED latch
 *     (runtime/adapters/claude-code/persistent/rate-limit-banner.ts head
 *     comment / output-scan.ts per-detector latch): fire on absent→present,
 *     clear ONLY on present→absent, never time-dedupe. Express it as
 *     `log.once(key).warn(…)` on the rising edge + `log.clearOnce(key)` on
 *     the falling edge, so a still-present condition can never re-fire.
 *
 *   - `rateLimited(key, ms)` — the wedge-alert cooldown
 *     (runtime/…/persistent/dead-repl-detector.ts `decideWedgeAction` +
 *     pool-state.ts `wedgeAlertState`): suppressed while
 *     `0 <= now - last < ms`; the timestamp is stamped ONLY on an attempt that
 *     passes BOTH the level gate and the window gate (the original sets
 *     `wedgeAlertState` only inside `if (action.alert.send)`), so a
 *     suppressed/level-gated attempt never extends the window.
 *
 *     Precisely: the stamp lands immediately BEFORE the sink call, so it
 *     records an ATTEMPTED delivery, not a confirmed one. A `sink` that THROWS
 *     consumes the window without a line reaching anyone, and the throw
 *     propagates to the caller. That is deliberate rather than overlooked —
 *     stamping after the sink returned would let a persistently-throwing sink
 *     re-attempt on every single call, i.e. exactly the un-rate-limited flood
 *     these windows exist to prevent — but it means "one line per window" is a
 *     bound on ATTEMPTS, and the SECOND deliberate deviation from the original
 *     (which stamps after its delivery call returns).
 *
 *     This is NOT confined to injected sinks. The default sink dispatches to
 *     `console.error/warn/log/debug`, which can throw for real: `EPIPE` when
 *     the read end of the pipe is GONE (a killed `journalctl`/pager — a merely
 *     full pipe blocks or gives `EAGAIN`, it does not raise `EPIPE`), and — the
 *     common case in practice — a test that replaces `console.log` with a
 *     throwing mock. Verified by executing it with NO sink injected: one
 *     throwing attempt consumed a 600 s window and a fully recovered
 *     `console.log` was still suppressed, so no line ever reached anyone.
 *     Callers who need a DELIVERY bound rather than an ATTEMPT bound must
 *     make their sink non-throwing; this primitive does not do it for them.
 *
 *     The LOWER bound is the FIRST deliberate deviation from the original, and
 *     it is load-bearing: a NEGATIVE elapsed EMITS. `Date.now()` is not
 *     monotonic (an NTP correction, a VM resume), so it can step backward,
 *     and a plain `now - last < ms` would then suppress the key for
 *     step + `ms` — an hour-long step silences a 10-minute heartbeat for 70
 *     minutes, which presents as exactly the "it died" alarm the heartbeat
 *     exists to rule out. So a backward step counts as due now, and the emit
 *     re-stamps the window, which self-heals it. Verified by the backward-step
 *     case in `logger/__tests__/logger.test.ts` (`last = 3_600_000`, `now = 0`,
 *     `ms = 600_000` emits).
 *
 *     **The two deviations break DIFFERENT halves of "exactly one line per
 *     window", and a caller needs both:**
 *       - a backward clock step can produce MORE than one line per window
 *         (the upper bound is a forward-clock-only guarantee);
 *       - a throwing sink can produce ZERO lines while still consuming the
 *         window (there is no lower bound at all — the bound is on attempts).
 *     So: at most one line per window under a forward-only clock, and no
 *     guarantee that any given window delivers a line.
 *
 *     Edge case, for completeness: the predicate is `0 <= now - last < ms`, so
 *     a NaN `ms` makes both comparisons false and suppresses the key forever
 *     after its first emit. No live caller can hit it (all three pass numeric
 *     literals), but a computed `ms` should be validated by its caller.
 *
 * Both latch states are PER-PROCESS module state keyed by
 * `subsystem × key` — "once per process" holds even across two
 * `createLogger('x')` calls, mirroring the module-level `wedgeAlertState`
 * map. Latch/stamp consumption happens only on an emit that PASSES the level
 * gate: a `debug` that the level filter drops neither burns a `once` key nor
 * starts a rate window.
 *
 * FORMATTING — logfmt-style escaping: a value, field key, or subsystem tag
 * containing whitespace, quotes, `=`, backslashes, control characters, or
 * nothing at all is double-quoted with backslash escapes (the subsystem also
 * quotes on `[`/`]`), so a line is ALWAYS single-line and round-trips through
 * whitespace-split key=value parsing — no caller-supplied subsystem/key can
 * forge a second line or an extra `k=v` pair. `undefined` fields are omitted;
 * `null` renders as bare `null`.
 *
 * SINKS — by default lines route 1:1 to the matching `console` method
 * (`error`→`console.error`, `warn`→`console.warn`, `info`→`console.log`,
 * `debug`→`console.debug`). Tests (and O2's DI seams) inject a custom
 * `sink`; the clock is injectable via `now` for deterministic
 * `rateLimited` windows.
 *
 * O1 scope: package + tests only — NO call sites adopt this yet (that is O2).
 *
 * F3 addendum: the sibling module `./fire-and-forget.ts` exports
 * `fireAndForget` + the process-level safety net (`installProcessSafetyNet`),
 * which make voided fire-and-forget promises VISIBLE (log + counter). It is
 * imported directly as `@neutronai/logger/fire-and-forget.ts` (NOT re-exported
 * here — it depends on this module's `createLogger`, so a re-export would form
 * an import cycle the G4 no-cycles gate rejects).
 */

/** Standard levels, most→least severe. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** Primitive field values. `undefined` fields are omitted from the line. */
export type LogValue = string | number | boolean | null | undefined

/** The `k=v` payload of a line. Insertion order is emission order. */
export type LogFields = Record<string, LogValue>

/** The four leveled emit methods (what `once`/`rateLimited` views expose). */
export interface LogEmitter {
  error(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  debug(event: string, fields?: LogFields): void
}

export interface Logger extends LogEmitter {
  /** The `[subsystem]` tag this logger stamps on every line. */
  readonly subsystem: string
  /**
   * A view that logs a given key ONLY ONCE per process (the GBrain
   * `latchIfUnavailable` semantics). The latch burns on the first emit that
   * passes the level gate; later emits under the same `subsystem × key` are
   * silent until {@link Logger.clearOnce}.
   */
  once(key: string): LogEmitter
  /**
   * Re-arm a {@link Logger.once} key — the falling edge of an edge-triggered
   * latch (the rate-limit-banner absent→present / present→absent pattern).
   * No-op if the key never fired.
   */
  clearOnce(key: string): void
  /**
   * A view that logs at most once per `ms` window per key (the
   * wedge-alert `alertDedupeMs` cooldown) — precisely, suppressed while
   * `0 <= now - last < ms`. The window starts ONLY on an attempt that passes
   * both the level gate and the window gate; suppressed and level-gated
   * attempts do not extend it. The stamp lands just BEFORE the sink call, so a
   * sink that THROWS still consumes the window — including the DEFAULT
   * `console` sink, which can throw on `EPIPE` or under a throwing test mock.
   * The bound is on attempts, not on delivered lines (see the head docblock for
   * why that is the safe side).
   *
   * The "at most once" bound has ONE exception, and it is intentional: a
   * BACKWARD clock step (negative elapsed) EMITS rather than suppressing, so
   * a non-monotonic `Date.now()` cannot silence a heartbeat for step + `ms`.
   * See the `rateLimited` bullet in the head docblock for why.
   */
  rateLimited(key: string, ms: number): LogEmitter
}

export interface LoggerOptions {
  /** Line sink override (default: the matching `console` method). */
  sink?: (level: LogLevel, line: string) => void
  /** Clock override for `rateLimited` windows (default: `Date.now`). */
  now?: () => number
}

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

const DEFAULT_LEVEL: LogLevel = 'info'

function isLogLevel(v: string): v is LogLevel {
  return v === 'error' || v === 'warn' || v === 'info' || v === 'debug'
}

/**
 * Resolve the active level from `NEUTRON_LOG_LEVEL` (trim + lowercase, the
 * repo's env-parsing convention — config/index.ts). Unset or unrecognized →
 * `info`: errors/warnings/normal operational lines flow, debug chatter is
 * opt-in.
 */
export function resolveLogLevel(raw: string | undefined = process.env['NEUTRON_LOG_LEVEL']): LogLevel {
  const v = (raw ?? '').trim().toLowerCase()
  return isLogLevel(v) ? v : DEFAULT_LEVEL
}

/**
 * A value containing whitespace, quotes, `=`, backslashes, or control chars
 * (or the empty string) gets logfmt-style quoting so `k=v` splitting on
 * whitespace stays unambiguous. (Spelled as a char-walk, not a regex with
 * control-char ranges, so this source file stays free of literal control
 * bytes — the leak-gate NUL tripwire scans the tree.)
 */
function needsQuoting(s: string): boolean {
  if (s === '') return true
  for (const ch of s) {
    const code = ch.codePointAt(0) as number
    if (code < 0x20 || code === 0x7f) return true
    if (ch === '"' || ch === "'" || ch === '=' || ch === '\\') return true
    if (/\s/.test(ch)) return true
  }
  return false
}

function quote(s: string): string {
  let out = '"'
  for (const ch of s) {
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else {
      const code = ch.codePointAt(0) as number
      if (code < 0x20 || code === 0x7f) {
        out += '\\u' + code.toString(16).padStart(4, '0')
      } else {
        out += ch
      }
    }
  }
  return out + '"'
}

/** Render one field value: numbers/booleans/null bare, strings escaped. */
export function formatLogValue(value: Exclude<LogValue, undefined>): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return needsQuoting(value) ? quote(value) : value
}

/**
 * A field key is escaped exactly like a string value — a key containing
 * whitespace, `=`, quotes, or control chars is quoted so it can never forge
 * a second `k=v` pair or a second line (`"bad key"=v` stays one splittable
 * token). Real call sites pass bare literal keys, so this is a no-op for them.
 */
function formatLogKey(key: string): string {
  return needsQuoting(key) ? quote(key) : key
}

/**
 * The `[subsystem]` tag. Quoted (inside the brackets) if it contains
 * whitespace / control chars / quotes / `=` / `[` / `]` — so a subsystem name
 * can never carry a raw newline that forges a second log line or a `]` that
 * closes the tag early. Normal single-token subsystems (`chat-bridge`) render
 * bare.
 */
function formatSubsystem(subsystem: string): string {
  return needsQuoting(subsystem) || subsystem.includes('[') || subsystem.includes(']')
    ? quote(subsystem)
    : subsystem
}

/** Build the full line: `[subsystem] event=<event> k=v …`. */
export function formatLogLine(subsystem: string, event: string, fields?: LogFields): string {
  let line = `[${formatSubsystem(subsystem)}] event=${formatLogValue(event)}`
  if (fields !== undefined) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue
      line += ` ${formatLogKey(k)}=${formatLogValue(v)}`
    }
  }
  return line
}

const defaultSink = (level: LogLevel, line: string): void => {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else if (level === 'info') console.log(line)
  else console.debug(line)
}

// ---------------------------------------------------------------------------
// Per-PROCESS suppression state (module-level, like pool-state.ts's
// `wedgeAlertState`), keyed `subsystem × key` as a NESTED map — the two
// dimensions are never concatenated into one string, so no subsystem/key
// value (even one containing the formatter's separators or a newline) can
// collide with a different pair. `('a\n b','c')` and `('a','b\n c')` stay
// distinct, which a single joined key would conflate.
// ---------------------------------------------------------------------------

/** subsystem → set of keys that have fired their one allowed line. */
const onceFired = new Map<string, Set<string>>()
/** subsystem → (key → last-emit timestamp) for `rateLimited` windows. */
const rateLimitState = new Map<string, Map<string, number>>()

/**
 * TEST-ONLY: wipe all per-process `once` / `rateLimited` state so suites
 * don't leak latches into each other.
 */
export function resetLoggerStateForTests(): void {
  onceFired.clear()
  rateLimitState.clear()
}

export function createLogger(subsystem: string, options?: LoggerOptions): Logger {
  const sink = options?.sink ?? defaultSink
  const clock = options?.now ?? Date.now

  /** Emit if the level passes AND `gate()` (checked only after the level
   *  passes — so suppressed-by-level attempts never consume a latch/window).
   *  `onEmit` stamps state once both gates pass, immediately BEFORE the sink
   *  call: a throwing sink consumes the latch/window, which keeps a broken sink
   *  from re-attempting on every call. The bound is on attempts, not
   *  deliveries. */
  function emit(
    level: LogLevel,
    event: string,
    fields: LogFields | undefined,
    gate?: () => boolean,
    onEmit?: () => void,
  ): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[resolveLogLevel()]) return
    if (gate !== undefined && !gate()) return
    onEmit?.()
    sink(level, formatLogLine(subsystem, event, fields))
  }

  function gatedEmitter(gate: () => boolean, onEmit: () => void): LogEmitter {
    return {
      error: (event, fields) => emit('error', event, fields, gate, onEmit),
      warn: (event, fields) => emit('warn', event, fields, gate, onEmit),
      info: (event, fields) => emit('info', event, fields, gate, onEmit),
      debug: (event, fields) => emit('debug', event, fields, gate, onEmit),
    }
  }

  return {
    subsystem,
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),

    once(key: string): LogEmitter {
      return gatedEmitter(
        () => !(onceFired.get(subsystem)?.has(key) ?? false),
        () => {
          let keys = onceFired.get(subsystem)
          if (keys === undefined) {
            keys = new Set<string>()
            onceFired.set(subsystem, keys)
          }
          keys.add(key)
        },
      )
    },

    clearOnce(key: string): void {
      onceFired.get(subsystem)?.delete(key)
    },

    rateLimited(key: string, ms: number): LogEmitter {
      return gatedEmitter(
        () => {
          const last = rateLimitState.get(subsystem)?.get(key)
          if (last === undefined) return true
          const elapsed = clock() - last
          // A BACKWARD clock step (`Date.now()` is not monotonic — NTP, a VM
          // resume) makes `elapsed` negative, and a plain `>= ms` would then
          // suppress the line for step+ms. For a rate-limited heartbeat that
          // silence reads as "the thing died", so treat a backward step as due
          // now: the window re-stamps on this emit and self-heals.
          return elapsed < 0 || elapsed >= ms
        },
        () => {
          let windows = rateLimitState.get(subsystem)
          if (windows === undefined) {
            windows = new Map<string, number>()
            rateLimitState.set(subsystem, windows)
          }
          windows.set(key, clock())
        },
      )
    },
  }
}
