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
 * swaps onto this package. They are close to those originals but NOT
 * bit-for-bit.
 *
 * `logger/__tests__/logger.test.ts` is where the behavior is pinned; this
 * docblock is not. Read a case rather than a sentence, and when you change the
 * behavior, change a case rather than adding a sentence. It is not a COMPLETE
 * specification. Until this round it did not cover the throwing-sink half at
 * all, and the attempt-vs-delivery note below rested on a one-off execution
 * check written into `docs/AS_BUILT.md` — a normative claim with nothing under
 * it that had to be kept green. `a THROWING sink CONSUMES the window` is now
 * that claim, executable.
 *
 * This docblock states INTENT on purpose. Earlier revisions restated the
 * predicate in prose, then enumerated the deviations from the originals, then
 * enumerated which cases the suite covers — and each enumeration was falsified
 * by the next reader to grep. A docblock goes stale in silence; a test at least
 * has to be kept green — though only a test on the WIRED path proves anything.
 * So this docblock deliberately says less than it knows.
 *
 *   - `once(key)` — the GBrain unavailable latch
 *     (gbrain-memory/GBrainSyncHook.ts `latchIfUnavailable`): the FIRST
 *     passing emit under a key logs and latches; every later emit under that
 *     key is silent until `clearOnce` re-arms it. "Exactly ONE
 *     `gbrain_unavailable` event" — one ATTEMPT, on the same
 *     attempts-not-deliveries bound as `rateLimited` below.
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
 *     pool-state.ts `wedgeAlertState`): a throttle for a line that must keep
 *     appearing without flooding. An attempt the WINDOW suppresses does not
 *     extend it, and an attempt the LEVEL GATE drops does not start one (the
 *     original sets `wedgeAlertState` only inside `if (action.alert.send)`).
 *
 *     Three consequences that are easy to get wrong — not the whole
 *     caller-facing contract, and not an inventory of how this differs from
 *     the original:
 *
 *     A CLOCK JUMP MUST NOT BE ABLE TO SILENCE THE KEY FOR THE JUMP PLUS THE
 *     WINDOW. `Date.now()` can jump backward (an NTP correction, a VM resume),
 *     and a throttle that trusted the reading would stay silent for the jump
 *     AND then the window on top: an hour-long jump would silence a 10-minute
 *     heartbeat for over an hour, which presents as exactly the "it died"
 *     alarm the heartbeat exists to rule out. That is the failure this guards
 *     against, and it is the whole of what it promises — a jump can still move
 *     an individual attempt either way, so `ms` is a rough period and not a
 *     guaranteed one. WHICH readings emit is decided by the condition in
 *     `rateLimited` below; read it there. Prose restatements of it have shipped
 *     false in three consecutive rounds, so this docblock carries none.
 *
 *     THE BOUND IS ON ATTEMPTS, NOT ON DELIVERED LINES. State is stamped
 *     before the sink runs (see `emit`), so a sink that throws consumes a
 *     window with nothing necessarily delivered. Erring the other way would
 *     let a persistently-throwing sink re-attempt on every single call,
 *     precisely the flood the window exists to prevent. A caller that needs a
 *     DELIVERY bound must make its own sink non-throwing; this primitive will
 *     not do it for them. Pinned by `a THROWING sink CONSUMES the window` —
 *     which is what a swap of the two lines in `emit` now has to redden.
 *
 *     AN UNCOMPUTABLE WINDOW COUNTS AS DUE, NOT AS SILENCE. `ms` used to be
 *     unvalidated, and `rateLimited(key, NaN)` therefore suppressed the key
 *     for as long as the clock moved forward — an invisible failure inside
 *     the primitive that exists to make a flood visible. A window that is not
 *     computable as a finite number now counts as DUE, so for THAT input the
 *     failure direction is an extra line, never a dead one. That makes
 *     `rateLimited(key, Infinity)` a flood rather than a latch: `once(key)`
 *     is how "never again" is expressed.
 *
 *     That guard covers NON-FINITE input and nothing more. A finite `ms` is
 *     honoured as written, so a caller that passes an absurdly large one —
 *     `Number.MAX_VALUE`, or a unit mix-up that multiplies into milliseconds
 *     twice — gets exactly the permanent silence it asked for, and no guard
 *     here will save it. Earlier rounds of this docblock stated the universal
 *     ("nothing a caller passes can silence a key permanently"); it was false
 *     for every finite window, and `Number.isFinite(Number.MAX_VALUE)` is
 *     `true`, so what is claimed here is now only the bounded thing the
 *     condition below actually enforces. Choosing a sane `ms` remains the
 *     CALLER's obligation.
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
 * O1 built the package and its tests. Call sites have since started adopting
 * it (that is O2, in progress) — `grep -rn 'createLogger(' ` for the current
 * set rather than trusting a count written here.
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
   * A view that throttles a key to roughly one line per `ms` window (the
   * wedge-alert `alertDedupeMs` cooldown).
   *
   * "Roughly" is load-bearing: a clock jump can move an individual attempt in
   * either direction, a throwing sink consumes a window with no
   * guarantee that anything was delivered, and a window that is not a finite
   * number counts as due rather than as forever. All three are deliberate —
   * and all three err toward an extra line. That last one covers NON-FINITE
   * input only: a finite `ms` is honoured as written, however large, so
   * picking a window that is not effectively forever is the caller's job. The head
   * docblock gives the reasons, the condition itself is in the implementation
   * below, and `logger/__tests__/logger.test.ts` holds the pinned cases — all
   * three of these included, the throwing-sink one as of this round.
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
          // An UNCOMPUTABLE window counts as due. Every comparison against a
          // NaN is false, so without this line a single non-finite input — a
          // computed `ms`, or a clock reading that is not a number — makes
          // both halves of the condition below false and silences the key.
          // That is the fail-CLOSED direction, and it is strictly worse than
          // the flood this primitive exists to stop: a flood is visible in
          // the journal, a permanently silenced heartbeat reads as "the thing
          // died" and shows up nowhere at all. Erring toward an extra line
          // keeps the failure mode observable. `Infinity` is rejected here
          // too — see the head docblock for why `once` owns "never again".
          if (!Number.isFinite(elapsed) || !Number.isFinite(ms)) return true
          // `Date.now()` is not monotonic (NTP, a VM resume), so the reading
          // can land BEHIND `last` and a plain `>= ms` would then suppress the
          // line for the jump plus the window. For a rate-limited heartbeat
          // that silence reads as "the thing died", so a reading behind the
          // stamp counts as due now. The condition on the next line is the
          // whole rule; this comment deliberately does not restate it, because
          // the rounds that tried kept getting some input wrong.
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
