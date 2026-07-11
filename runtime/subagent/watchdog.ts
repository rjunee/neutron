/**
 * @neutronai/runtime — agent-aware subagent watchdog.
 *
 * Closes gap-audit §(b) #8 ("Watchdog is generic, not agent-aware"). The
 * generic `lifecycle.ts` reaper silently cancels stale `running` records and
 * marks pid-gone ones `crashed`, but it never SURFACES the failure — a crashed
 * or stuck dispatched agent just disappears from `live()` and the caller that
 * was awaiting it hangs forever with no signal.
 *
 * This watchdog is agent-aware: it walks the dispatched-agent registry, and for
 * every LIVE (`pending`|`running`) record it detects one of two terminal
 * conditions and SURFACES it (marks the run failed via `failRun` + emits a
 * structured event through an injected `notify` sink — Telegram / the
 * `watchdog/` AlertStore / a log):
 *
 *   1. process_dead — the record carries a `pid` whose OS process is gone, yet
 *      it never reached a terminal status. The agent crashed without emitting a
 *      completion. (Takes precedence over `stuck`.)
 *   2. stuck — no progress past the per-agent-kind inactivity threshold. The
 *      process may still be alive (wedged), so `failRun` kills it via the
 *      registered canceller before surfacing.
 *
 * Source of truth for "stuck" — JSONL turn-progress, not the in-memory clock.
 *   Ported from Vajra `stuck-turn-watchdog.ts` (incident 2026-04-21): a topic CC
 *   kept answering its `/health` port probe while its turn had wedged for 3+ min,
 *   its JSONL filling with only `system`/`queue-operation` records and no real
 *   assistant output. The encoded lesson: *port probes lie — the transcript JSONL
 *   is the source of truth for whether a turn actually advanced.*
 *
 *   The same trap exists here in a subtler form: the registry's `last_event_at`
 *   is refreshed by `registry.update()` on EVERY patch (it defaults to `now()`
 *   when a caller doesn't pass one), so a heartbeat / status touch / queue
 *   bookkeeping bumps it without any real turn progress — keeping a wedged turn
 *   looking alive forever. To close that gap the stuck check keys off an
 *   injectable `turn_progress_at(rec)` probe (wired in production to a JSONL-tail
 *   read of the child's transcript — see `turn-progress.ts`). When the probe
 *   returns a timestamp it is AUTHORITATIVE: `last_event_at` is ignored for the
 *   staleness calc, so a heartbeat can no longer mask a wedge. When no probe is
 *   wired (or it returns null for a record with no transcript — e.g. an
 *   in-process `core` agent), the check falls back to `last_event_at` (the prior
 *   behaviour, preserved for back-compat).
 *
 * It deliberately does NOT auto-respawn (out of scope) — but each surfaced
 * event carries enough context (`run_id`, `agent_kind`, `instance_key`,
 * `delivery_target`) for a caller to retry/notify as policy dictates.
 *
 * This pass is the SOLE owner of live→terminal liveness transitions for
 * dispatched agents. `runLifecycleTick` (`lifecycle.ts`) does not reap liveness
 * itself — it COMPOSES this watchdog (runs it, then prunes already-terminal
 * records), so there is never a second independent reaper to race and a stale
 * agent can't be silently swallowed before it is surfaced here. It can also be
 * driven standalone. Pure + injectable (now / pid_alive / notify) so the tests
 * are hermetic; every transition is idempotent.
 */

import { failRun, type ControlState } from './control.ts'
import type { AgentKind, SubagentRecord, SubagentRegistry } from './registry.ts'

/** Default inactivity window before a `running` agent is judged stuck. */
export const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60_000

export type WatchdogReason = 'process_dead' | 'stuck'

/** A surfaced liveness failure — handed to the notifier + returned to callers. */
export interface AgentWatchdogEvent {
  run_id: string
  agent_kind: AgentKind
  instance_key: string
  reason: WatchdogReason
  /** Where a notice about this agent should be delivered, if the record had one. */
  delivery_target?: { channel: string; binding_id: string }
  /** The record's in-memory last-event timestamp at detection (may be heartbeat-fresh). */
  last_event_at: number
  /** The JSONL turn-progress timestamp the stuck decision actually used, when a
   *  `turn_progress_at` probe was wired AND it diverged from `last_event_at`
   *  (i.e. the source-of-truth signal that overrode a stale/heartbeat clock).
   *  Absent when the check fell back to `last_event_at`. */
  turn_progress_at?: number
  /** Wall-clock at detection. */
  detected_at: number
  /** `detected_at - <authoritative progress timestamp>` — staleness at the moment
   *  of reaping. The authoritative timestamp is the JSONL `turn_progress_at` when
   *  a probe was wired, else `last_event_at`. */
  age_ms: number
  /** The pid that was found dead (process_dead only). */
  pid?: number
}

export interface AgentWatchdogNotifier {
  /** Surface a fired event. Best-effort — a throw is swallowed by the tick. */
  (event: AgentWatchdogEvent): void | Promise<void>
}

/**
 * Per-agent-kind stuck thresholds (ms). A bare number applies one threshold to
 * every kind; a partial map overrides per kind and falls back to
 * `DEFAULT_STUCK_THRESHOLD_MS` for unlisted kinds.
 */
export type StuckThresholdConfig = number | Partial<Record<AgentKind, number>>

export interface AgentWatchdogDeps {
  control: ControlState
  registry: SubagentRegistry
  /** Surface sink for fired events (Telegram / AlertStore / log). Optional. */
  notify?: AgentWatchdogNotifier
  /**
   * Probe whether a pid is still alive. Default: `process.kill(pid, 0)` (signal
   * 0 throws ESRCH if gone; EPERM means alive-but-not-ours). Tests inject a stub.
   */
  pid_alive?: (pid: number) => boolean
  /** Now-injection for tests. */
  now?: () => number
  /** Stuck threshold(s). Default `DEFAULT_STUCK_THRESHOLD_MS` for every kind. */
  stuck_threshold_ms?: StuckThresholdConfig
  /**
   * Authoritative turn-progress probe — the source of truth for "is this turn
   * advancing". Given a live record, returns the epoch-ms timestamp of the
   * agent's most recent REAL turn event read from its transcript JSONL, or
   * `null` when no transcript progress signal is available (no `child_session_id`
   * yet, unreadable JSONL, or an in-process agent with no transcript). When it
   * returns a number that value — NOT `rec.last_event_at` — drives the stuck
   * threshold, so a heartbeat / queue-operation / status touch that merely bumps
   * `last_event_at` can't keep a wedged turn looking alive (Vajra
   * stuck-turn-watchdog lesson, 2026-04-21: "port probes lie; JSONL is the source
   * of truth"). Wire it in production via `makeJsonlTurnProgressProbe`
   * (`turn-progress.ts`); leave it unset to preserve the legacy `last_event_at`
   * behaviour.
   */
  turn_progress_at?: (rec: SubagentRecord) => number | null
  /**
   * NOTIFY-ONLY mode (F4 — `[BEHAVIOR]` wire the watchdog, decision D-8 = wire).
   *
   * When `true`, the watchdog DETECTS a stuck/dead live record and NOTIFIES the
   * `notify` sink, but does NOT reap it: it never invokes the run's canceller
   * (nothing is killed) and never marks the record terminal (no `failRun`, so no
   * control-flow change). The record stays live; a caller still awaiting it is
   * unaffected. This is the mode the scheduled `runLifecycleTick` uses in F4 —
   * enforcement (killing a wedged dispatch after a verified threshold) is a
   * SEPARATE flagged PR, and the 5-min {@link DEFAULT_STUCK_THRESHOLD_MS} default
   * is UNVERIFIED for killing.
   *
   * Because the record is never transitioned, `live()` keeps returning it, so a
   * still-stuck run would be re-detected (and re-notified) every tick. Pass
   * {@link AgentWatchdogDeps.notified} to suppress the repeat: a run_id already in
   * the set is skipped, and a newly-surfaced one is added to it. Omitting the set
   * notifies every tick (acceptable for a pure detector; the caller owns dedup).
   *
   * Default `false` — the legacy reaping behaviour (`failRun` + kill + surface),
   * unchanged for every existing caller/test.
   */
  notify_only?: boolean
  /**
   * De-dup ledger for {@link notify_only} mode. A run_id present here is skipped
   * (already notified); a newly-surfaced run_id is inserted. The caller (the
   * scheduled tick closure) owns this set so the pure watchdog stays stateless.
   * Ignored when `notify_only` is false.
   */
  notified?: Set<string>
}

export interface AgentWatchdogResult {
  /** Events surfaced this tick, in detection order. */
  surfaced: AgentWatchdogEvent[]
}

function thresholdFor(kind: AgentKind, cfg: StuckThresholdConfig | undefined): number {
  if (cfg === undefined) return DEFAULT_STUCK_THRESHOLD_MS
  if (typeof cfg === 'number') return cfg
  return cfg[kind] ?? DEFAULT_STUCK_THRESHOLD_MS
}

/**
 * Run one agent-aware watchdog tick. Returns the events it surfaced. Each
 * surfaced run is marked `crashed` with a `failure_reason`, its process is
 * killed (stuck) or already gone (dead), and the `notify` sink is invoked.
 */
export async function runAgentWatchdog(deps: AgentWatchdogDeps): Promise<AgentWatchdogResult> {
  const now = (deps.now ?? Date.now)()
  const isAlive = deps.pid_alive ?? defaultPidAlive
  const surfaced: AgentWatchdogEvent[] = []

  // Snapshot the live set up-front: `failRun` mutates statuses out of `live()`,
  // so iterating a frozen list keeps the pass deterministic.
  const live = deps.registry.live()

  // NOTIFY-ONLY dedup hygiene (F4 Blocker-2 fix). The `notified` ledger suppresses
  // the every-tick repeat for a still-stuck run, but a run that RECOVERED (or went
  // terminal / disappeared) must be dropped so a genuine SECOND incident on it
  // re-notifies. Prune the ledger down to the currently-live run_ids up-front;
  // recovery (live-but-healthy) is cleared per-record below. Without this a
  // stale→healthy→stale sequence silently swallowed the second incident.
  if (deps.notify_only === true && deps.notified !== undefined) {
    const liveIds = new Set(live.map((r) => r.run_id))
    for (const id of [...deps.notified]) {
      if (!liveIds.has(id)) deps.notified.delete(id)
    }
  }

  for (const rec of live) {
    // Authoritative progress timestamp: the JSONL turn-progress signal when a
    // probe is wired and reports one (source of truth — a heartbeat that bumps
    // `last_event_at` can't mask a wedged turn), else the in-memory
    // `last_event_at` (legacy fallback). A `null` from the probe means "no
    // transcript signal for this record" → fall back rather than false-flag.
    const probedProgress = deps.turn_progress_at?.(rec) ?? null
    const progressAt = probedProgress ?? rec.last_event_at

    let reason: WatchdogReason | undefined
    if (rec.pid !== undefined && !isAlive(rec.pid)) {
      // process_dead takes precedence — a gone process is gone regardless of
      // how recently it last reported progress.
      reason = 'process_dead'
    } else if (now - progressAt > thresholdFor(rec.agent_kind, deps.stuck_threshold_ms)) {
      reason = 'stuck'
    }
    if (reason === undefined) {
      // RECOVERY (Blocker-2 fix): a live record that is healthy again clears its
      // notified mark, so if it later goes stuck once more that is a NEW incident
      // and re-notifies. Only meaningful in notify_only mode (the enforcing path
      // transitions the record terminal, so it never returns to live()).
      if (deps.notify_only === true) deps.notified?.delete(rec.run_id)
      continue
    }

    if (deps.notify_only === true) {
      // NOTIFY-ONLY (F4): DETECT + NOTIFY, never reap. Do NOT call `failRun` —
      // that would invoke the canceller (kill a wedged subprocess) and drive the
      // record terminal (a control-flow change). The record stays live; nothing
      // is killed. Suppress the every-tick repeat via the caller-owned `notified`
      // ledger (the record is still live, so it re-detects until it completes on
      // its own).
      if (deps.notified?.has(rec.run_id) === true) continue
      const event = buildEvent(rec, reason, now, progressAt, probedProgress)
      surfaced.push(event)
      deps.notified?.add(rec.run_id)
      if (deps.notify) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await deps.notify(event)
        } catch {
          // Notifier is best-effort; a sink failure must not abort the tick.
        }
      }
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    const transitioned = await failRun(deps.control, rec.run_id, reason, now)
    if (!transitioned) continue // raced to terminal already; don't double-surface

    const event = buildEvent(rec, reason, now, progressAt, probedProgress)
    surfaced.push(event)

    if (deps.notify) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.notify(event)
      } catch {
        // Notifier is best-effort; a sink failure must not abort the tick or
        // un-fail the run (it is already terminal + recorded).
      }
    }
  }

  return { surfaced }
}

/**
 * Build a surfaced {@link AgentWatchdogEvent} from a detected record. Shared by
 * the enforcing and NOTIFY-ONLY paths so both report an identical shape — only
 * the side-effects (reap vs. observe) differ.
 */
function buildEvent(
  rec: SubagentRecord,
  reason: WatchdogReason,
  now: number,
  progressAt: number,
  probedProgress: number | null,
): AgentWatchdogEvent {
  const event: AgentWatchdogEvent = {
    run_id: rec.run_id,
    agent_kind: rec.agent_kind,
    instance_key: rec.instance_key,
    reason,
    last_event_at: rec.last_event_at,
    detected_at: now,
    age_ms: now - progressAt,
  }
  // Record the JSONL signal only when it actually overrode the in-memory clock,
  // so the surfaced event shows the source-of-truth timestamp the decision used.
  if (probedProgress !== null && probedProgress !== rec.last_event_at) {
    event.turn_progress_at = probedProgress
  }
  if (rec.delivery_target !== undefined) event.delivery_target = rec.delivery_target
  if (reason === 'process_dead' && rec.pid !== undefined) event.pid = rec.pid
  return event
}

function defaultPidAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard "is this process alive" probe.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = process exists but isn't ours; still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
