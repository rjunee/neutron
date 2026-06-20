/**
 * @neutronai/runtime — pathological-tool-call-loop detector.
 *
 * Lifted from OpenClaw's `tool-loop-detection.ts` (TIER-0 lift target per
 * internal design notes).
 * Three orthogonal signals + a sliding-window cooldown:
 *
 *   (a) Identical-call repetition within a turn — same name + same input hash
 *       N times in a row (default N=3). Catches the classic "tool returned
 *       error, model retries the same tool with the same args" loop.
 *
 *   (b) Ping-pong A → B → A → B for K cycles (default K=4). Catches the
 *       "two tools alternately fix each other's output" deadlock.
 *
 *   (c) Cooldown-window violations: same `name+input_hash` signature firing
 *       more than M times in a 60s window (default M=5). Catches the slower
 *       "same tool every 10s for 2 minutes" pattern that (a) misses because
 *       the calls are interleaved with other tools.
 *
 * Hook point: call `checkToolCall(state, { name, input })` immediately after
 * the substrate emits a `tool_call` event, BEFORE dispatching to the tool
 * runner. On `block`, intercept the call and inject a synthetic `tool_result`
 * carrying `{ error: 'loop_guard_blocked', reason }` so the model self-corrects
 * instead of being terminated mid-thought.
 *
 * Per-turn state: call `newDetectorState(turn_id)` on every new turn so the
 * (a) and (b) counters reset; cooldowns persist across turns within a session
 * so the (c) signal catches drift.
 */

/** Repetition threshold for signal (a). */
export const REPEAT_IDENTICAL_LIMIT = 3
/** Cycle threshold for signal (b). */
export const PINGPONG_LIMIT = 4
/** Window length for signal (c) in ms. */
export const COOLDOWN_WINDOW_MS = 60_000
/** Per-window cap for signal (c). */
export const COOLDOWN_MAX_PER_WINDOW = 5

interface ToolCallRecord {
  call_id: string
  name: string
  input_hash: string
  ts: number
}

interface CooldownRecord {
  signature: string
  count_in_window: number
  first_ts: number
}

export interface DetectorState {
  turn_id: string
  /** Bounded ring buffer (last 50). */
  history: ToolCallRecord[]
  /** Persists across turns within a session — see file head. */
  cooldowns: Map<string, CooldownRecord>
}

export interface ToolCallProbe {
  name: string
  input: unknown
}

export type LoopGuardDecision =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string }

/**
 * Construct a fresh detector state for a new turn. Cooldowns are NOT carried
 * over because each `DetectorState` is per-turn; if you want the cooldown
 * signal to span turns within a session, plumb a single state across turns.
 */
export function newDetectorState(turn_id: string): DetectorState {
  return { turn_id, history: [], cooldowns: new Map() }
}

/**
 * Check a candidate tool call against the three loop signals. Mutates `state`
 * to record the call (when allowed) so subsequent calls see the updated history.
 *
 * Block decisions carry a human-readable `reason` suitable for echoing back to
 * the model as `tool_result.content` so it understands why the call was
 * suppressed and can change strategy.
 */
export function checkToolCall(state: DetectorState, probe: ToolCallProbe): LoopGuardDecision {
  const input_hash = hashCanonical(probe.input)
  const sig = `${probe.name}:${input_hash}`
  const now = Date.now()

  // (a) Identical-call repetition within turn — count only the consecutive
  // tail of identical calls. A sequence like A, B, A, C, A is NOT a retry
  // loop and must not be blocked just because the same tool was revisited
  // later in the turn (Codex r1 P2 finding).
  let consecutiveIdentical = 0
  for (let i = state.history.length - 1; i >= 0; i--) {
    const r = state.history[i]!
    if (r.name === probe.name && r.input_hash === input_hash) consecutiveIdentical++
    else break
  }
  if (consecutiveIdentical >= REPEAT_IDENTICAL_LIMIT) {
    return {
      decision: 'block',
      reason: `repeated_identical_call: ${probe.name} called ${consecutiveIdentical + 1}× consecutively with same input in this turn (limit ${REPEAT_IDENTICAL_LIMIT})`,
    }
  }

  // (b) Ping-pong A↔B for K cycles. Look at last (2K - 1) entries plus the
  // candidate; require the resulting (2K)-length sequence to alternate
  // between exactly two distinct tool names.
  const window = 2 * PINGPONG_LIMIT
  if (state.history.length >= window - 1) {
    const tail = state.history.slice(-(window - 1)).map((r) => r.name)
    tail.push(probe.name)
    const distinct = new Set(tail)
    if (distinct.size === 2) {
      const first = tail[0]
      const second = tail[1]
      const alternating = tail.every((n, i) => n === (i % 2 === 0 ? first : second))
      if (alternating) {
        return {
          decision: 'block',
          reason: `pingpong: ${first}↔${second} for ${PINGPONG_LIMIT} cycles`,
        }
      }
    }
  }

  // (c) Cooldown-window violation. Sliding window keyed on signature.
  const cd = state.cooldowns.get(sig)
  if (cd && now - cd.first_ts < COOLDOWN_WINDOW_MS) {
    cd.count_in_window++
    if (cd.count_in_window > COOLDOWN_MAX_PER_WINDOW) {
      return {
        decision: 'block',
        reason: `cooldown_violation: ${sig} fired ${cd.count_in_window}× in ${COOLDOWN_WINDOW_MS}ms (cap ${COOLDOWN_MAX_PER_WINDOW})`,
      }
    }
  } else {
    state.cooldowns.set(sig, { signature: sig, count_in_window: 1, first_ts: now })
  }

  // Record the call + trim ring buffer.
  state.history.push({
    call_id: cryptoRandomId(),
    name: probe.name,
    input_hash,
    ts: now,
  })
  if (state.history.length > 50) state.history.shift()

  return { decision: 'allow' }
}

/**
 * Canonical-JSON hash. Uses sorted-key serialization so `{a:1,b:2}` and
 * `{b:2,a:1}` collapse to the same hash. Hash is FNV-1a 64-bit (no Web Crypto
 * dependency in test environments) — collisions matter only for false-positive
 * rate on signal (a), which is bounded anyway by the `REPEAT_IDENTICAL_LIMIT`.
 */
function hashCanonical(value: unknown): string {
  const canonical = canonicalJson(value)
  // FNV-1a 64-bit (BigInt) — handles arbitrary-length strings deterministically.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}

function cryptoRandomId(): string {
  // Bun ships globalThis.crypto.randomUUID; fall back to a counter-based id if
  // the runtime lacks it (vanishingly unlikely; documented for completeness).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
