// persistent/context-reset.ts — the `/reset` chat-command runtime primitive.
//
// Actuate CONTEXT_RESET_COMMAND (`/clear`) against the LIVE warm pooled cc-agent
// REPL for a conversation, clearing the MODEL's transcript while the underlying
// `claude` process (its MCP servers / dev-channel / system prompt) stays alive
// and keeps serving subsequent turns. This is the SAME mechanism the per-turn
// import warm-session reset uses (`pool.ts:372-402`), lifted into a standalone,
// gateway-invocable primitive for the user-facing `/reset` command.
//
// WHY NOT a respawn: `respawnSupervisedSession` (`supervision.ts`) ALWAYS
// `--resume`s the same transcript (`session-respawn.ts` — "respawn is always
// resume"), so it PRESERVES context — the wrong primitive for a reset. `/clear`
// is the context-wiping actuation.
//
// The reset runs UNDER the session's `acquireTurn()` mutex so it can never race
// a live in-flight turn's inject. A reset that arrives mid-turn waits up to
// `acquire_wait_ms` for the turn to settle; if it is still busy it reports `busy`
// and writes NOTHING — and it self-releases the abandoned mutex slot so a later
// turn is never wedged.

import { existsSync } from 'node:fs'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { pool } from './pool-state.ts'
import type { ReplSession } from './repl-session.ts'
import { measurePostCompactSize, sessionJsonlPath } from './session-size-watchdog.ts'
import {
  CONTEXT_RESET_COMMAND,
  DEFAULT_IDLE_MAX_MS,
  DEFAULT_IDLE_QUIET_MS,
  SESSION_KEY_SEP,
} from './signatures.ts'
import { waitForReplIdle } from './spawn.ts'

/** Default bound the reset waits for an in-flight turn to settle before it gives
 *  up and reports `busy`. Comfortably above `DEFAULT_IDLE_MAX_MS` (6 s) — the
 *  longest a settling turn holds the mutex during its own post-reply idle wait —
 *  so a reset arriving just as a turn finishes still gets the slot. */
const DEFAULT_ACQUIRE_WAIT_MS = 8_000

export interface ResetPooledContextInput {
  substrate_instance_id: string
  user_id: string
  /** Live project scope dimension of the pool key (`'general'` for the General chat). */
  project_scope: string
  /** How long to wait for an in-flight turn to settle before reporting `busy`.
   *  Default {@link DEFAULT_ACQUIRE_WAIT_MS} (8 s). */
  acquire_wait_ms?: number
  /** PTY-quiet floor the reset waits for before/after writing `/clear`.
   *  Default `DEFAULT_IDLE_QUIET_MS` (`signatures.ts`). */
  idle_quiet_ms?: number
  /** Cap on the idle wait. Default `DEFAULT_IDLE_MAX_MS` (`signatures.ts`). */
  idle_max_ms?: number
  /**
   * Fired SYNCHRONOUSLY under EACH session's turn mutex the instant its `/clear`
   * lands — the same seam as the sweep's `onResetUnderMutex`. PER SESSION (not once
   * on aggregate success) so a later `busy`/`reset_failed` short-circuit can never
   * strand an ALREADY-cleared session without rehydration: the caller emits the
   * rehydration signal for each session actually cleared, before any short-circuit.
   * A throwing listener is swallowed by {@link actuateSessionContextReset}.
   */
  on_reset_under_mutex?: () => void
}

export type ResetPooledContextOutcome =
  | { ok: true; sessions_reset: number }
  | { ok: false; reason: 'no_live_session' | 'busy' | 'reset_failed'; detail?: string }

/**
 * Clear the model context of the live warm REPL(s) for a conversation.
 *
 * Pool-key match: the key is `[instance, user, project, credential].join(NUL)`
 * (`poolKeyFor`); the credential dimension is resolved per-dispatch, so we
 * WILDCARD it — matching every pooled session whose key starts with
 * `[instance, user, project_scope].join(NUL) + NUL`. The trailing NUL guarantees
 * the 3-dim prefix can never false-match a legacy 2-dim key (which carries only
 * one NUL total).
 *
 * Outcomes:
 *  - `{ ok: true, sessions_reset }`   — one `/clear\r` written per live session.
 *  - `{ ok: false, reason: 'no_live_session' }` — nothing warm to clear.
 *  - `{ ok: false, reason: 'busy' }`  — a turn is still in flight; NOTHING written.
 *  - `{ ok: false, reason: 'reset_failed', detail }` — the actuation threw.
 */
export async function resetPooledSessionContext(
  input: ResetPooledContextInput,
): Promise<ResetPooledContextOutcome> {
  const waitMs = input.acquire_wait_ms ?? DEFAULT_ACQUIRE_WAIT_MS
  const quietMs = input.idle_quiet_ms ?? DEFAULT_IDLE_QUIET_MS
  const maxMs = input.idle_max_ms ?? DEFAULT_IDLE_MAX_MS
  const prefix =
    [input.substrate_instance_id, input.user_id, input.project_scope].join(SESSION_KEY_SEP) +
    SESSION_KEY_SEP

  // Collect the pooled session PROMISES whose key matches the (instance, user,
  // project) prefix — credential wildcarded. `pool` is `Map<string, Promise<…>>`.
  const matched: Array<Promise<ReplSession>> = []
  for (const [key, sessionP] of pool) {
    if (key.startsWith(prefix)) matched.push(sessionP)
  }
  if (matched.length === 0) return { ok: false, reason: 'no_live_session' }

  // Resolve each — a still-spawning promise that REJECTED is skipped (no live
  // session), and an already-exited child is skipped (nothing to clear).
  const live: ReplSession[] = []
  for (const sessionP of matched) {
    let session: ReplSession
    try {
      session = await sessionP
    } catch {
      continue
    }
    if (session.hasChildExited()) continue
    live.push(session)
  }
  if (live.length === 0) return { ok: false, reason: 'no_live_session' }

  let resetCount = 0
  for (const session of live) {
    // Delegate the per-session actuation to the shared helper (below). External
    // behavior + return shape are unchanged: a `busy`/`failed` outcome short-
    // circuits with the corresponding reason; a `dead` session is skipped (the
    // child exited between the resolve-loop liveness filter and the mutex); a
    // `reset` counts toward `sessions_reset`. A `failed` outcome carries the
    // actuation's error message — threaded into `detail` so the `/reset` reply
    // surfaces the real cause instead of a bare "unknown error" (Argus r1).
    const outcome = await actuateSessionContextReset(session, {
      acquire_wait_ms: waitMs,
      idle_quiet_ms: quietMs,
      idle_max_ms: maxMs,
      // Thread the per-session under-mutex hook so rehydration fires the instant
      // THIS session's `/clear` lands — before any later `busy`/`reset_failed`
      // short-circuit can return. N emits for N sessions is idempotent-safe
      // (each downstream bump/un-mark is monotone).
      ...(input.on_reset_under_mutex !== undefined
        ? { onResetUnderMutex: input.on_reset_under_mutex }
        : {}),
    })
    if (outcome.status === 'busy') return { ok: false, reason: 'busy' }
    if (outcome.status === 'failed')
      return {
        ok: false,
        reason: 'reset_failed',
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      }
    if (outcome.status === 'dead') continue
    resetCount += 1
  }

  // Every match was skipped as dead under the mutex ⇒ nothing was actually
  // cleared; report honestly rather than a hollow ok:0.
  if (resetCount === 0) return { ok: false, reason: 'no_live_session' }
  return { ok: true, sessions_reset: resetCount }
}

/**
 * Outcome of one per-session `/clear` actuation.
 *  - `{ status: 'reset' }`  — `/clear\r` written; model transcript cleared, process alive.
 *  - `{ status: 'busy' }`   — a turn is still in flight after `acquire_wait_ms`; NOTHING written.
 *  - `{ status: 'dead' }`   — the child exited before or under the mutex (nothing to clear).
 *  - `{ status: 'failed', detail }` — the actuation threw; `detail` carries the error message.
 */
export type ActuateContextResetOutcome =
  | { status: 'reset' | 'busy' | 'dead' }
  | { status: 'failed'; detail?: string }

/**
 * Per-session `/clear` actuation, extracted from {@link resetPooledSessionContext}
 * so BOTH the user-facing `/reset` command and the periodic Layer-B sweep
 * (`createPooledContextResetSweep`) actuate through the SAME mutex-safe path.
 *
 * Runs UNDER the session's `acquireTurn()` mutex so it can never race a live
 * in-flight turn's inject. On the `'busy'` path the still-queued mutex grant
 * self-releases so no later turn wedges. A `'failed'` outcome carries the thrown
 * error's message as `detail` (surfaced by the `/reset` reply).
 *
 * `onResetUnderMutex` (optional) fires SYNCHRONOUSLY under the mutex, immediately
 * after the `/clear` write and BEFORE the post-clear settle + release — the sweep
 * threads the per-scope rehydration un-mark here so a turn that acquires the
 * just-cleared session NEXT re-composes COLD. This closes the Argus r1 blocker:
 * with the un-mark deferred to a post-sweep policy loop, a whole multi-session
 * sweep's worth of `acquire_wait`/`idle_quiet` awaits was a window in which a warm
 * bare turn could run on an already-`/clear`-ed REPL (losing persona / work-board /
 * memory grounding for that turn). Doing the un-mark adjacent to the `/clear`,
 * under the same mutex, shrinks that window to the one session's own pre-clear
 * settle. A throwing listener MUST NOT abort the reset (the `/clear` already
 * landed) — it is swallowed (rehydrate is worst-case-redundant, never a
 * correctness break).
 */
export async function actuateSessionContextReset(
  session: ReplSession,
  opts: {
    acquire_wait_ms: number
    idle_quiet_ms: number
    idle_max_ms: number
    onResetUnderMutex?: () => void
  },
): Promise<ActuateContextResetOutcome> {
  // Pre-mutex liveness: an already-exited child has nothing to clear.
  if (session.hasChildExited()) return { status: 'dead' }

  // BOUNDED acquire: `acquireTurn()` enqueues the slot SYNCHRONOUSLY on call, so
  // once we've called it the slot WILL eventually be granted. Race it against a
  // timeout — if the timeout wins we must NOT drop the (still-queued) grant on the
  // floor: self-release it when it lands, else the session's turn mutex wedges
  // forever (every later `acquireTurn` awaits a `prev` that never resolves).
  // Nothing is written on the busy path.
  const acquireP = session.acquireTurn()
  const granted = await Promise.race([
    acquireP.then(() => true),
    Bun.sleep(opts.acquire_wait_ms).then(() => false),
  ])
  if (!granted) {
    fireAndForget(
      'context-reset.selfReleaseAbandonedSlot',
      acquireP.then((release) => release()),
    )
    return { status: 'busy' }
  }

  const release = await acquireP
  try {
    // Re-check liveness under the mutex — the child could have exited while we
    // waited for the slot.
    if (session.hasChildExited()) return { status: 'dead' }
    // The pool.ts:378-385 sequence verbatim: settle idle, write `/clear`, force a
    // beat so the idle wait can't short-circuit before the TUI reacts, settle idle
    // again so the REPL is clean + at rest for the next turn.
    await waitForReplIdle(session, opts.idle_quiet_ms, opts.idle_max_ms)
    session.child.write(`${CONTEXT_RESET_COMMAND}\r`)
    // Un-mark the scope's warm topics NOW — under the mutex, adjacent to the
    // `/clear` write, before any turn blocked on `acquireTurn` can resume. Best-
    // effort: a throwing listener must not abort a reset whose `/clear` already
    // landed.
    if (opts.onResetUnderMutex !== undefined) {
      try {
        opts.onResetUnderMutex()
      } catch {
        /* rehydrate is worst-case-redundant context, never a correctness break */
      }
    }
    await Bun.sleep(opts.idle_quiet_ms)
    await waitForReplIdle(session, opts.idle_quiet_ms, opts.idle_max_ms)
    return { status: 'reset' }
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    release()
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer B — periodic composer-side context reset + rehydrate (SPEC WAVE 3.5).
//
// The CLI persistent-REPL context-editing beta (`clear_tool_uses` tool-result
// eviction) is NOT available for the interactive `claude` PTY REPL substrate —
// no CLI flag, no codebase primitive (verified 2026-07-23). Layer B is therefore
// the composer-side periodic reset: when a warm orchestrator session's LIVE
// context grows past the good-zone band, actuate `/clear` (the SAME primitive as
// `/reset`), then re-mark the topic cold so its next turn re-assembles the full
// grounding (work board + STATUS + docs + persona) — lossless because every
// durable piece of state is external. This is the aggressive-reset half; the
// rehydration half lives in the gateway runner (`contextResetSignal`) + composer.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Default post-compact live-delta threshold at/above which the sweep resets a
 * warm orchestrator session: 2 MB of growth SINCE the last reset.
 *
 * Well under the 5 MB warn / 10 MB critical wedge bands of `session-size-
 * watchdog.ts`: Layer B keeps the orchestrator in the good zone with frequent
 * small resets, and the size watchdog stays the wedge backstop for the rare
 * session that outruns it (e.g. one enormous turn between ticks).
 */
export const DEFAULT_CONTEXT_RESET_THRESHOLD_BYTES = 2 * 1024 * 1024

/** Background acquire policy: a busy session is skipped and retried next tick, so
 *  the sweep waits only briefly for the mutex (NOT the interactive `/reset`'s 8 s
 *  ride-out — a periodic sweep must never block on a live turn). */
const SWEEP_ACQUIRE_WAIT_MS = 2_000

export interface SweepReport {
  /** Sessions whose live-delta crossed the threshold and were `/clear`-ed. */
  reset: Array<{ project_scope: string; bytes_live: number }>
  /** Sessions left untouched, with the reason nothing was written to their PTY. */
  skipped: Array<{
    project_scope: string
    reason:
      | 'busy'
      | 'under_threshold'
      | 'no_new_turns'
      | 'cooldown'
      | 'dead'
      | 'failed'
      | 'no_transcript'
  }>
}

/**
 * Build a stateful sweep over the owner's warm `cc-agent-*` orchestrator pool.
 *
 * One call to `sweep()` walks every pooled session matching the (instance, user)
 * prefix — wildcarding BOTH the project and credential key dimensions — and, for
 * each idle session whose POST-COMPACT transcript has grown ≥ `threshold_bytes`
 * SINCE its last reset, actuates `/clear` (mutex-safe, never mid-turn) and
 * records a per-scope report.
 *
 * The no-loop invariant is a per-session-object BASELINE delta held in a
 * `WeakMap` inside the returned closure: the trigger fires only on growth since
 * the last reset, never on the stale absolute pre-clear size. See the inline
 * comment at the actuation for WHY the delta (not the absolute) is correct
 * regardless of whether CC rotates the transcript JSONL after `/clear`.
 */
export function createPooledContextResetSweep(opts?: {
  threshold_bytes?: number
  /** Claude Code transcript root the sweep measures under. Resolve it the SAME
   *  canonical way every other transcript reader does — `resolveTranscriptProjectsDir`
   *  (`signatures.ts`) — and thread the result here from the composer. `undefined`
   *  falls back to `sessionJsonlPath`'s `~/.claude/projects` default, which EQUALS
   *  the resolver's output today (no live caller threads `claudeConfigDir` — it is
   *  dormant/RESERVED plumbing per `substrate-profiles.ts`). Passing the resolved
   *  value keeps the sweep from silently measuring the wrong root the day
   *  `claudeConfigDir` is activated for the `cc-agent-*` substrate (Argus r1). */
  projects_dir?: string
  acquire_wait_ms?: number
  idle_quiet_ms?: number
  idle_max_ms?: number
  /** Fired SYNCHRONOUSLY under the per-session turn mutex the instant a session's
   *  `/clear` lands — the composer threads its rehydration un-mark
   *  (`emitContextResetScope`) here so a turn that ACQUIRES the just-cleared scope
   *  next re-composes COLD (Argus r1 blocker). NOTE: the mutex alone does NOT cover
   *  a turn that already read `isColdFirstTurn` (chose warm) BEFORE this fired and
   *  re-marks `contextSent` after — the runner closes that residual race with a
   *  per-scope reset-epoch guard (Argus r2 blocker), not this callback. */
  onScopeReset?: (project_scope: string) => void
}): {
  sweep(input: {
    substrate_instance_id: string
    user_id: string
    should_reset?: (project_scope: string) => boolean
  }): Promise<SweepReport>
} {
  const thresholdBytes = opts?.threshold_bytes ?? DEFAULT_CONTEXT_RESET_THRESHOLD_BYTES
  const acquireWaitMs = opts?.acquire_wait_ms ?? SWEEP_ACQUIRE_WAIT_MS
  const idleQuietMs = opts?.idle_quiet_ms ?? DEFAULT_IDLE_QUIET_MS
  const idleMaxMs = opts?.idle_max_ms ?? DEFAULT_IDLE_MAX_MS
  const projectsDir = opts?.projects_dir // undefined → sessionJsonlPath default (homedir)
  const onScopeReset = opts?.onScopeReset

  // The no-loop invariant: a per-session baseline of the last-observed
  // post-compact bytes + turns-served. Keyed on the `ReplSession` OBJECT so a
  // respawn (a NEW `ReplSession`) naturally restarts at baseline 0 — and the
  // entry is GC'd with the session, so this never leaks across the pool's churn.
  const baselines = new WeakMap<ReplSession, { bytes: number; turns: number }>()

  const measure = (session: ReplSession): number | null =>
    measurePostCompactSize(sessionJsonlPath(session.sessionId, session.cwd, projectsDir))

  return {
    async sweep(input): Promise<SweepReport> {
      const report: SweepReport = { reset: [], skipped: [] }
      // 2-dim pool prefix — wildcards BOTH the project AND credential dims (the
      // full key is `[instance, user, project, credential]`). The TRAILING
      // separator makes a legacy 2-dim key (one separator total) unmatchable, so a
      // pre-4-dim session can never false-match.
      const prefix = [input.substrate_instance_id, input.user_id].join(SESSION_KEY_SEP) + SESSION_KEY_SEP

      const matched: Array<{ key: string; sessionP: Promise<ReplSession> }> = []
      for (const [key, sessionP] of pool) {
        if (key.startsWith(prefix)) matched.push({ key, sessionP })
      }

      for (const { key, sessionP } of matched) {
        const project_scope = key.split(SESSION_KEY_SEP)[2] ?? 'general'
        // Resolve; a still-spawning promise that REJECTED is silently dropped
        // (no live session — same as `resetPooledSessionContext`), not reported.
        let session: ReplSession
        try {
          session = await sessionP
        } catch {
          continue
        }
        // An already-exited child → skip 'dead'.
        if (session.hasChildExited()) {
          report.skipped.push({ project_scope, reason: 'dead' })
          continue
        }
        // Caller's cooldown predicate vetoes this scope → measure NOTHING.
        if (input.should_reset?.(project_scope) === false) {
          report.skipped.push({ project_scope, reason: 'cooldown' })
          continue
        }
        // Busy PRE-CHECK: never contend the mutex on a live turn.
        if (session.activeTurn !== undefined) {
          report.skipped.push({ project_scope, reason: 'busy' })
          continue
        }
        // MEASUREMENT — baseline delta (the no-loop invariant).
        const measured = measure(session)
        if (measured === null) {
          // Distinguish a BENIGN absent transcript (a freshly-spawned warm session
          // whose `<sessionId>.jsonl` hasn't been written yet) from a genuine read
          // error. The absent case is a normal no-op skip, not a failure — reporting
          // it as 'failed' every sweep pollutes the honest-report contract (Argus r2
          // minor). Only a present-but-unreadable file is a real 'failed'.
          const jsonl = sessionJsonlPath(session.sessionId, session.cwd, projectsDir)
          report.skipped.push({
            project_scope,
            reason: existsSync(jsonl) ? 'failed' : 'no_transcript',
          })
          continue
        }
        let baseline = baselines.get(session) ?? { bytes: 0, turns: 0 }
        // Re-anchor DOWN after an external CC auto-compact (Argus r2). A compaction
        // between sweeps drops the post-compact measurement BELOW our stored baseline
        // (which was stamped at a larger pre-compact size), so `max(0, measured -
        // baseline.bytes)` would clamp bytesLive to 0 and defer the next reset until
        // growth re-crossed the STALE-high baseline + threshold — letting the live
        // window drift toward the 5 MB watchdog warn band. If the transcript shrank
        // below baseline, the baseline is stale: re-anchor its bytes to the compacted
        // floor (KEEP `turns` so the no-loop gate below still holds) and persist it,
        // so subsequent growth is measured from what is actually live now.
        if (measured < baseline.bytes) {
          baseline = { bytes: measured, turns: baseline.turns }
          baselines.set(session, baseline)
        }
        // An idle scope is never reset twice: no turn has run since the last reset,
        // so the transcript cannot have grown from live use.
        if (session.turnsServedThisIncarnation() <= baseline.turns) {
          report.skipped.push({ project_scope, reason: 'no_new_turns' })
          continue
        }
        const bytesLive = Math.max(0, measured - baseline.bytes)
        if (bytesLive < thresholdBytes) {
          report.skipped.push({ project_scope, reason: 'under_threshold' })
          continue
        }
        // Over threshold → actuate the SAME mutex-safe `/clear` the `/reset`
        // command uses. Thread the rehydration un-mark so it fires UNDER the mutex
        // the instant `/clear` lands (Argus r1 blocker — see actuate's docs).
        const outcome = await actuateSessionContextReset(session, {
          acquire_wait_ms: acquireWaitMs,
          idle_quiet_ms: idleQuietMs,
          idle_max_ms: idleMaxMs,
          ...(onScopeReset !== undefined
            ? { onResetUnderMutex: (): void => onScopeReset(project_scope) }
            : {}),
        })
        if (outcome.status === 'reset') {
          // WHY baseline-delta (not absolute size): whether CC keeps appending the
          // same pinned-session JSONL after `/clear` or rotates to a NEW file, an
          // absolute-size trigger would re-fire forever on the stale pre-clear
          // bytes. The delta trigger fires only on growth SINCE this reset — so we
          // RE-MEASURE immediately and stamp the new baseline (bytes + turns).
          //
          // Rotation-robust fallback (Argus r1): if the re-measure reads `null`
          // (the transcript was rotated/removed by `/clear`), stamp the baseline at
          // ZERO — NOT the stale pre-clear `measured`. Stamping the pre-clear size
          // would suppress Layer B until the NEW file re-grew past the OLD absolute
          // size + threshold (a ~2 MB dead zone that silently disables periodic
          // resets AND blinds the size-watchdog backstop). Zero measures the fresh
          // incarnation's growth from empty, exactly like a respawned `ReplSession`
          // (new object → WeakMap miss → baseline 0). In practice CC keeps the same
          // `<sessionId>.jsonl` across `/clear` — the per-turn `/clear` reset
          // (`pool.ts`) already relies on that pinned path and the size-watchdog
          // measures it, so a non-null re-measure is the norm; `?? 0` hardens the
          // rotation edge either way.
          baselines.set(session, {
            bytes: measure(session) ?? 0,
            turns: session.turnsServedThisIncarnation(),
          })
          report.reset.push({ project_scope, bytes_live: bytesLive })
        } else {
          // 'busy' | 'dead' | 'failed' — a raced turn/exit/throw under the mutex.
          report.skipped.push({ project_scope, reason: outcome.status })
        }
      }
      return report
    },
  }
}
