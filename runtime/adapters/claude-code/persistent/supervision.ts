// persistent-repl-substrate.ts → supervision.ts
// Sprint-2 supervision actuation: respawn-is-always-resume, the watchdog ticks,
// the model-update watchdog, and test/operator introspection (D2 split).

import { existsSync, statSync } from 'node:fs'
import { emitSystemEvent } from '@neutronai/persistence/index.ts'
import { getBestModel, getKnownFallbackModels, setBestModelOverride } from '../../../models.ts'
import type { AgentSpec } from '../../../substrate.ts'
import { type CwdDriftSupervisedEntry, type CwdDriftTickResult, type CwdProbe, runCwdDriftTick } from './cwd-drift-watchdog.ts'
import { type HeartbeatWatchdog, startHeartbeatWatchdog } from './heartbeat-watchdog.ts'
import { makeInFlightGate } from './in-flight-gate.ts'
import { type ModelUpdateWatchdog, type SessionIdleSignals, loadModelUpdateState, realProbeModel, runGracefulUpgrade, saveModelUpdateState, startModelUpdateWatchdog } from './model-update-watchdog.ts'
import { basenameOf, cmdlineMatchesSession, defaultReadCmdline, registerOrphanKill } from './orphan-adoption.ts'
import { activeModelWatchdogs, activeWatchdogs, childByKey, cwdDriftAlertState, cwdDriftRespawnState, pendingChildKills, pool, supervisedBySessionKey, wedgeAlertState } from './pool-state.ts'
import { type ReplRegistryRecord, getRecord, loadRegistry, patchRecord, upsertRecord, withRegistry } from './repl-registry.ts'
import { buildCrashLoopWarningText, recordAndEvaluateRestart } from './restart-rate.ts'
import { type RespawnDeps, type RespawnOutcome, type RespawnTrigger, type SpawnReplOutcome, executeRespawn, planRespawn, shouldPostRespawnNotice } from './session-respawn.ts'
import { type SessionSizeWatchdog, sessionJsonlPath } from './session-size-watchdog.ts'
import { type ReplWedgeProbe, buildWedgeAlertText, buildWedgeCapHitAlertText, buildWedgeRecoveryInProgressText, decideWedgeAction, detectReplWedged } from './wedge-detector.ts'
import { dispatchWedgeRespawn } from './wedge-respawn-dispatch.ts'
import { DEFAULT_CWD_DRIFT_INTERVAL_MS, DEFAULT_WATCHDOG_INTERVAL_MS, RESPAWN_CAP_MAX, RESPAWN_CAP_WINDOW_MS, RESPAWN_IN_FLIGHT_TTL_MS, defaultIsPidAlive, resolveTranscriptProjectsDir } from './signatures.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'
import { type ReplSession, httpHealth, terminateChild, terminatePidGracefully } from './repl-session.ts'
import { clearRespawnInFlight, gateFor, getOrSpawnSession } from './spawn.ts'
import { drainPendingRespawns } from './pending-respawn.ts'
import { poolKeyFor } from './pool.ts'

// ---------------------------------------------------------------------------
// Sprint-2 supervision actuation: respawn-is-always-resume, double-spawn-safe.
// ---------------------------------------------------------------------------

// D1: `supervisedBySessionKey` lives in `pool-state.ts`, imported above.

/** Register a supervised substrate's options under its pool key so the watchdog
 *  tick + the admin-respawn endpoint actuate each session with the OWNING
 *  substrate's options. No-op when no registry path is set (supervision off). */
export function registerSupervisedSubstrate(options: PersistentReplSubstrateOptions): void {
  if (options.replRegistryPath !== undefined) {
    supervisedBySessionKey.set(poolKeyFor(options), options)
  }
}

/**
 * Operator force-recover entry point for the admin-respawn HTTP endpoint:
 * resolve the OWNING substrate's live options for `sessionKey` and actuate a
 * FORCED `--resume` respawn (clears `capped_at` so a hard-capped REPL the
 * auto-watchdog stopped retrying is released). `replRegistryPath` scopes the
 * lookup to this instance: a session whose registered options point at a DIFFERENT
 * registry is treated as not-found, so the operator route can only recover
 * sessions belonging to the resolved instance. Returns `session-not-found` when no
 * supervised substrate is registered for the key (supervision off, or no turn
 * has spawned a REPL for it yet). `force` still honors the in-flight gate so two
 * rapid operator requests spawn exactly once (acceptance #3 / Argus r1 IMPORTANT #3).
 */
export function respawnSupervisedSession(
  replRegistryPath: string,
  sessionKey: string,
): RespawnOutcome {
  const options = supervisedBySessionKey.get(sessionKey)
  if (options === undefined || options.replRegistryPath !== replRegistryPath) {
    return { ok: false, reason: 'session-not-found', sessionKey }
  }
  return respawnReplSession(options, sessionKey, 'admin-endpoint', 'manual', true)
}

// D1: `respawnGates` / `wedgeAlertState` / `cwdDriftRespawnState` /
// `cwdDriftAlertState` live in `pool-state.ts`, imported above.


/** A resume spec carries only what `spawnSession` needs to re-attach — model
 *  from the registry record, empty prompt (the inject happens in `start()`'s
 *  driver / pending-replay, not the spawn). */
function resumeSpecFor(record: ReplRegistryRecord): AgentSpec {
  // `record.model` is the model the session spawned with; a graceful model
  // upgrade rewrites it BEFORE respawning so the resume re-attaches on the new
  // model. Absent (legacy record) → the live runtime best model.
  return { prompt: '', tools: [], model_preference: [record.model ?? getBestModel()] }
}

/** Build the `executeRespawn` dependency surface wired to the real module pool +
 *  persisted registry. Exposed for tests that want to drive `executeRespawn`
 *  against the live actuation without the watchdog tick. */
export function makeReplRespawnDeps(options: PersistentReplSubstrateOptions): RespawnDeps {
  const registryPath = options.replRegistryPath
  return {
    killChild: (sessionKey) => {
      // Synchronous liveness decision via the handle mirror (the pool only holds
      // a Promise). When the child is ALIVE-but-wedged the pool still owns the
      // process, so we must kill it AND wait for its exit before the `--resume`
      // replacement spawns — otherwise two processes briefly share one session
      // transcript (Argus r3 BLOCKER 1). When it has already exited (the crash
      // path), there is nothing to wait for and the resume spawns synchronously.
      const child = childByKey.get(sessionKey)
      if (child === undefined || child.hasExited()) {
        childByKey.delete(sessionKey)
        // Cross-restart orphan path (ISSUES #105): the in-memory mirror has no
        // live child, but a PRIOR gateway incarnation may have left a
        // `claude --resume` STILL RUNNING whose pid survives only in the persisted
        // registry. Verify-then-adopt-or-kill it BEFORE `spawnResume` so we never
        // run two processes on one session transcript. The identity check
        // (`adoptOrKillOrphan`) terminates the pid ONLY when it is alive AND its
        // cmdline matches our `claude` for this session; a dead pid (the common
        // crash path) or a RECYCLED/unrelated pid (cmdline mismatch) is left
        // untouched — a blind `process.kill(record.pid)` could SIGTERM an
        // unrelated process the OS recycled the pid onto. The registered promise
        // is awaited by `spawnResume` (same seam as the alive-child kill below).
        if (registryPath !== undefined) {
          const orphanRecord = getRecord(registryPath, sessionKey)
          // CONFIGURED binary basename — the identity gate compares argv[0]'s
          // basename against THIS, not the literal `claude`, so a CLAUDE_BIN
          // override (e.g. claude-headless) still recognises our own orphan
          // (Argus r3 BLOCKER). Resolution mirrors build-repl-argv.ts:68 so the
          // matcher's expected basename == what buildReplArgv actually spawned.
          const claudeBasename = basenameOf(
            options.claude_bin ?? process.env['CLAUDE_BIN'] ?? 'claude',
          )
          registerOrphanKill(
            sessionKey,
            orphanRecord,
            {
              isPidAlive: defaultIsPidAlive,
              readCmdline: defaultReadCmdline,
              // Re-verify identity right before the FORCE kill (Codex P2): the
              // verified orphan may exit during the SIGTERM grace window and the OS
              // may recycle its pid onto an unrelated process before SIGKILL — this
              // closure re-reads the cmdline and skips SIGKILL unless the pid is
              // STILL our claude for this session, collapsing the multi-second
              // grace-window TOCTOU to a synchronous check. Recycled-pid safety is
              // the whole point of this module.
              terminatePid: (pid) =>
                terminatePidGracefully(pid, () =>
                  cmdlineMatchesSession(
                    defaultReadCmdline(pid),
                    orphanRecord?.sessionId ?? '',
                    claudeBasename,
                  ),
                ),
            },
            (k, p) => pendingChildKills.set(k, p),
            claudeBasename,
          )
        }
        return
      }
      childByKey.delete(sessionKey)
      // Graceful SIGTERM + await exit (SIGKILL on overstay). `spawnResume` awaits
      // this before launching the resume so exactly one process owns the session.
      pendingChildKills.set(sessionKey, terminateChild(child))
    },
    evictPool: (sessionKey) => {
      pool.delete(sessionKey)
    },
    spawnResume: (record): SpawnReplOutcome => {
      // Consume the pending graceful-kill (if `killChild` found an alive child).
      const pendingKill = pendingChildKills.get(record.sessionKey)
      pendingChildKills.delete(record.sessionKey)
      // Synchronous honesty for the deterministic failure Codex flagged: a ghost
      // cwd would fail the spawn asynchronously and be reported as success. Catch
      // it up-front so the caller propagates `spawn-cwd-invalid` instead. (The
      // background kill still runs — a wedged child is terminated either way.)
      if (!existsSync(record.cwd)) {
        return { ok: false, reason: 'invalid-cwd' }
      }
      try {
        // Kick the resume spawn. forceResume re-attaches the captured UUID. An
        // ASYNC failure (assertion / dev-channel health) clears the in-flight
        // stamp in getOrSpawnSession's catch so the next tick retries rather
        // than treating the key as still-recovering for the whole TTL.
        //
        // Ordering (Argus r3 BLOCKER 1): if `killChild` SIGTERM'd an alive-but-
        // wedged child, AWAIT its exit before `getOrSpawnSession`, so the new
        // `claude --resume` never co-owns the transcript with the dying process.
        // When there is no pending kill (crash path) `getOrSpawnSession` is called
        // synchronously inside this IIFE (no `await` precedes it) — ptyHost.spawn
        // still records synchronously, preserving the fire-and-forget timing.
        void (async () => {
          if (pendingKill !== undefined) await pendingKill
          await getOrSpawnSession(record.sessionKey, options, resumeSpecFor(record), {
            sessionId: record.sessionId,
          })
        })().catch(() => undefined)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'spawn-failed' }
      }
    },
    saveRecord: (record) => {
      if (registryPath !== undefined) upsertRecord(registryPath, record)
    },
    now: () => Date.now(),
  }
}

/** Count respawns inside the rolling cap window. */
function recentRespawnCount(record: ReplRegistryRecord, now: number): number {
  return (record.recent_respawns ?? []).filter((t) => now - t < RESPAWN_CAP_WINDOW_MS).length
}

/**
 * Actuate a respawn for `sessionKey` — the single guarded entry point used by
 * the watchdog tick AND the admin endpoint. Double-spawn-safe: a process-local
 * per-key gate + a registry-flock in-flight stamp serialize concurrent callers
 * so EXACTLY ONE spawn fires (brief § 6 acceptance #3). Respawn-is-always-resume
 * via `dispatchWedgeRespawn → planRespawn → executeRespawn` (brief § 6
 * acceptance #2 & #4). `force` (operator) bypasses the in-flight/cooldown gates
 * and clears `capped_at`.
 */
export function respawnReplSession(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  trigger: RespawnTrigger,
  reason: string,
  force = false,
): RespawnOutcome {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) {
    return { ok: false, reason: 'session-not-found', sessionKey }
  }
  const gate = gateFor(sessionKey)
  if (!gate.claim()) {
    // Another respawn for this key is already running in-process. The
    // process-local gate applies to `force` too: two rapid operator force
    // requests must NOT both spawn (acceptance #3 — exactly ONE spawn per
    // sessionKey). `force` only bypasses the cooldown/cap below, never the
    // in-flight serialization. (Argus r1 IMPORTANT #3.)
    return { ok: false, reason: 'spawn-failed', sessionKey }
  }
  const now = Date.now()
  try {
    // Cross-process guard + cap enforcement under the registry flock.
    const decision = withRegistry<
      | { kind: 'go'; record: ReplRegistryRecord }
      | { kind: 'no-record' }
      | { kind: 'in-flight' }
      | { kind: 'capped'; just_tripped?: boolean }
    >(registryPath, (registry) => {
      const rec = registry[sessionKey]
      if (!rec) return { registry, result: { kind: 'no-record' } }
      const inFlight =
        rec.respawn_in_flight_at !== undefined && now - rec.respawn_in_flight_at < RESPAWN_IN_FLIGHT_TTL_MS
      if (force) {
        // Operator force-recover: clear cap + bypass the cooldown/cap-count,
        // BUT still honor the cross-process in-flight stamp so two rapid force
        // requests (this or another process) can't both spawn the same
        // sessionKey (acceptance #3 — exactly ONE spawn). Argus r1 IMPORTANT #3.
        if (inFlight) return { registry, result: { kind: 'in-flight' } }
        const { capped_at: _dropped, ...rest } = rec
        const next: ReplRegistryRecord = { ...rest, respawn_in_flight_at: now }
        registry[sessionKey] = next
        return { registry, result: { kind: 'go', record: next } }
      }
      if (inFlight) return { registry, result: { kind: 'in-flight' } }
      if (rec.capped_at !== undefined) return { registry, result: { kind: 'capped' } }
      if (recentRespawnCount(rec, now) >= RESPAWN_CAP_MAX) {
        // Trip the hard cap — auto-recovery OFF until an operator clears it.
        // `just_tripped` marks the healthy→capped RISING EDGE (the `capped_at`
        // guard above returns for an already-capped session) so the O4 degrade
        // journal fires ONCE per cap episode, not on every subsequent respawn
        // attempt.
        registry[sessionKey] = { ...rec, capped_at: now }
        return { registry, result: { kind: 'capped', just_tripped: true } }
      }
      // CLAIM the respawn atomically under the flock: stamp in-flight BEFORE
      // releasing the lock so a racing process/tick that acquires the lock next
      // observes the stamp and refuses (the cross-process double-spawn guard).
      // Cleared below if the dispatch does NOT fire (so a refusal doesn't latch).
      const stamped: ReplRegistryRecord = { ...rec, respawn_in_flight_at: now }
      registry[sessionKey] = stamped
      return { registry, result: { kind: 'go', record: stamped } }
    })

    if (decision.kind === 'no-record') return { ok: false, reason: 'session-not-found', sessionKey }
    if (decision.kind === 'in-flight') return { ok: false, reason: 'spawn-failed', sessionKey }
    if (decision.kind === 'capped') {
      // O4 — VISIBILITY ONLY: journal the hard-cap trip on the rising edge
      // (emitted outside the registry flock so the locked critical section
      // stays pure). Control flow unchanged; emit can never throw.
      if (decision.just_tripped === true) {
        void emitSystemEvent({
          event: 'repl_session_capped',
          module: 'repl',
          level: 'error',
          payload: { session_key: sessionKey, respawn_cap_max: RESPAWN_CAP_MAX, trigger },
        })
      }
      return { ok: false, reason: 'spawn-failed', sessionKey }
    }

    const deps = makeReplRespawnDeps(options)
    if (!shouldPostRespawnNotice(trigger)) {
      delete deps.postNotice
    }
    const dispatch = dispatchWedgeRespawn({
      plan: () => planRespawn(loadRegistry(registryPath), sessionKey),
      execute: (plan) => {
        const rec = getRecord(registryPath, sessionKey)
        if (!rec) return { ok: false, reason: 'session-not-found' }
        const outcome = executeRespawn(rec, plan, trigger, reason, deps)
        return outcome.reason !== undefined
          ? { ok: outcome.ok, reason: outcome.reason }
          : { ok: outcome.ok }
      },
      // We already stamped in-flight under the flock (atomic claim); this refresh
      // is a confirmatory no-op on the fired path.
      markInFlight: () => patchRecord(registryPath, sessionKey, { respawn_in_flight_at: now }),
    })

    // A refused / threw dispatch must NOT leave the in-flight stamp latched (it
    // would block the next tick's retry for the whole TTL with no respawn
    // actually running). Clear the claim so recovery can retry immediately.
    if (dispatch.kind !== 'fired') {
      clearRespawnInFlight(registryPath, sessionKey)
    }

    switch (dispatch.kind) {
      case 'fired':
        return { ok: true, sessionKey, initiatedAt: now }
      case 'plan-refused':
        return { ok: false, reason: refusalFor(dispatch.reason), sessionKey }
      case 'execute-refused':
        return { ok: false, reason: refusalFor(dispatch.reason), sessionKey }
      case 'threw':
        return { ok: false, reason: 'spawn-failed', sessionKey }
    }
  } finally {
    gate.release()
  }
}

function refusalFor(reason: string): NonNullable<RespawnOutcome['reason']> {
  switch (reason) {
    case 'no-session-to-resume':
    case 'session-not-found':
    case 'invalid-session-key':
    case 'spawn-cwd-invalid':
    case 'spawn-failed':
      return reason
    default:
      return 'spawn-failed'
  }
}

// ---------------------------------------------------------------------------
// Sprint-2 supervision: the live watchdog tick + heartbeat.
// ---------------------------------------------------------------------------

export interface ReplWatchdogOptions {
  /** Tick cadence (ms). Default 15s. */
  intervalMs?: number
  /** Heartbeat file path. When set, a 100ms heartbeat tick runs alongside the
   *  watchdog (systemd `Type=notify`/`WatchdogSec` reads its mtime). */
  heartbeatFile?: string
  /** Operator alert sink for wedge notices. */
  postAlert?: (text: string) => void
  /** DI: setInterval shim (tests). */
  setIntervalFn?: (cb: () => void, ms: number) => unknown
  /** DI: clearInterval shim (tests). */
  clearIntervalFn?: (handle: unknown) => void
  /** DI: health probe (tests). Default the real dev-channel `/health` fetch.
   *  `expectedSessionId` lets the default verify the responder's identity (the
   *  port-recycle guard); injected probes may ignore it. */
  healthProbe?: (port: number, expectedSessionId?: string) => Promise<boolean>
  /** DI: pid-liveness probe for the cross-restart / post-crash case where the
   *  pool no longer holds the session but the registry still records a pid.
   *  Default `process.kill(pid, 0)` in a try/catch. */
  isPidAlive?: (pid: number) => boolean
  /** DI clock. */
  now?: () => number
  /** cwd-drift tick cadence (ms). Default 60s. */
  cwdDriftIntervalMs?: number
  /** DI: live-cwd probe for the cwd-drift tick (tests). Default async `lsof`. */
  cwdDriftProbeCwd?: CwdProbe
  /** DI: canonical-dir existence check for the cwd-drift tick (tests). Default
   *  `existsSync`. */
  cwdDriftCanonicalExists?: (cwd: string) => boolean
  /** Override the cwd-drift 1h respawn throttle (tests). */
  cwdDriftThrottleMs?: number
}

export interface ReplWatchdog {
  stop(): void
}


/** Probe one supervised key's liveness against the live pool + dev-channel. The
 *  pool is the authoritative source when it holds the session; otherwise (after
 *  a crash evicted it, or across a gateway restart) the registry's recorded
 *  `pid` is the liveness anchor — exactly Nova's "topic-map pid" fallback. */
async function probeReplLiveness(
  sessionKey: string,
  record: ReplRegistryRecord | undefined,
  healthProbe: (port: number, expectedSessionId?: string) => Promise<boolean>,
  isPidAlive: (pid: number) => boolean,
): Promise<ReplWedgeProbe> {
  const p = pool.get(sessionKey)
  let hasChild = false
  let childAlive = false
  let channelPort: number | undefined
  if (p !== undefined) {
    try {
      const session = await p
      hasChild = true
      childAlive = !session.hasChildExited()
      channelPort = session.channelPort
    } catch {
      hasChild = false
    }
  }
  // No live pool entry but the registry recorded a pid → probe the OS directly
  // (post-crash / cross-restart). A dead recorded pid is the wedge signal.
  if (!hasChild && record?.pid !== undefined) {
    hasChild = true
    childAlive = isPidAlive(record.pid)
  }
  const port = channelPort ?? record?.devchannel_port
  // Pass the recorded session id so the default probe can reject a recycled port
  // serving a DIFFERENT session (port-recycle guard).
  const healthOk = port !== undefined ? await healthProbe(port, record?.sessionId) : false
  return { hasChild, childAlive, healthOk, ccReady: record?.first_ready_at !== undefined }
}

/**
 * Run ONE watchdog tick: scan the registry, probe each REPL's liveness, decide
 * via the pure `detectReplWedged` + `decideWedgeAction` cores, and actuate a
 * `--resume` respawn on a confirmed wedge/crash. Exported so the live wiring is
 * directly testable (brief § 9 anti-pattern #1 — no built-but-not-wired core).
 * Returns a per-key summary of what the tick decided/did.
 */
export async function runReplWatchdogTick(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): Promise<Array<{ sessionKey: string; action: string; respawned: boolean }>> {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return []
  const healthProbe =
    wopts.healthProbe ??
    ((port: number, expectedSessionId?: string) =>
      httpHealth(port, expectedSessionId !== undefined ? { expectedSessionId } : {}))
  const isPidAlive = wopts.isPidAlive ?? defaultIsPidAlive
  const now = (wopts.now ?? Date.now)()
  const registry = loadRegistry(registryPath)
  // Scope the scan to THIS instance registry (Codex P2): the registry on disk is
  // already scoped to this instance, but `pool` is module-global — without filtering,
  // instance A's tick would probe/respawn instance B's pooled sessions and misroute B's
  // wedge alerts through A's `postAlert`. Only include pool keys whose registered
  // owning substrate points at this `replRegistryPath`.
  const ownedPoolKeys = [...pool.keys()].filter(
    (k) => supervisedBySessionKey.get(k)?.replRegistryPath === registryPath,
  )
  const keys = new Set<string>([...Object.keys(registry), ...ownedPoolKeys])
  const results: Array<{ sessionKey: string; action: string; respawned: boolean }> = []

  for (const sessionKey of keys) {
    const record = registry[sessionKey]
    const probe = await probeReplLiveness(sessionKey, record, healthProbe, isPidAlive)
    const verdict = detectReplWedged(probe)
    const action = decideWedgeAction({
      verdict,
      firstReadyAt: record?.first_ready_at,
      cappedAt: record?.capped_at,
      respawnInFlight:
        record?.respawn_in_flight_at !== undefined &&
        now - record.respawn_in_flight_at < RESPAWN_IN_FLIGHT_TTL_MS,
      lastWedgeAutoRespawnAt: record?.last_respawn_at,
      lastWedgeAlertAt: wedgeAlertState.get(sessionKey),
      now,
    })

    let respawned = false
    if (action.kind === 'respawn-and-alert') {
      // Respawn with the OWNING substrate's options (env / instance-id / spawn
      // opts), resolved by pool key — one registry is shared by substrates that
      // differ (Codex P2). An unregistered key (a dead session for a substrate
      // that hasn't re-registered post-restart) is NOT actuated with the tick's
      // own options — that would resume it under the wrong env/identity. It is
      // recovered when its owner re-registers (resume-is-always-resume on its next
      // turn, or the next tick once registered). Surface as a skip.
      const keyOptions = supervisedBySessionKey.get(sessionKey)
      if (keyOptions === undefined) {
        results.push({ sessionKey, action: 'unregistered-skip', respawned: false })
        continue
      }
      const trigger: RespawnTrigger =
        action.verdict.reason === 'pid-dead' ? 'crash-watchdog' : 'wedge-watchdog'
      const outcome = respawnReplSession(keyOptions, sessionKey, trigger, action.verdict.detail)
      respawned = outcome.ok
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeAlertText({ sessionKey, reason: action.verdict.reason }))
        wedgeAlertState.set(sessionKey, now)
      }
    } else if (action.kind === 'cap-hit-alert') {
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeCapHitAlertText({ sessionKey, reason: action.verdict.reason }))
        wedgeAlertState.set(sessionKey, now)
      }
    } else if (action.kind === 'alert-only') {
      if (action.alert.send) {
        wopts.postAlert?.(buildWedgeRecoveryInProgressText({ sessionKey }))
        wedgeAlertState.set(sessionKey, now)
      }
    }
    // Surface the ignore *reason* (boot-window / never-ready / not-wedged) so
    // the live wiring is observable in tests + logs, not just "ignore".
    const label = action.kind === 'ignore' ? action.reason : action.kind
    results.push({ sessionKey, action: label, respawned })
  }
  // Replay any inbound dropped since the last tick (brief § 6 acceptance #1's
  // replay clause): a crash-respawn above resumed the session, so its dropped
  // inbound can now be re-injected via the dev-channel /message path. No-op when
  // the queue is unconfigured/absent. No stagger — a single fresh crash.
  await drainPendingRespawns(options, { baseDelayMs: 0 })
  return results
}

/**
 * Run ONE cwd-drift watchdog tick against this instance's live pool: for each
 * supervised, LIVE pooled child, ask the OS (async/batched `lsof`) for its live
 * cwd and compare to the session's canonical `record.cwd`. On drift, respawn the
 * session — the respawn spawns from `record.cwd`, so it is automatically PINNED
 * back to canonical (the `cd '<cwd>' && claude --resume` analog). NON-substrate:
 * a watchdog over the child pid, NOT an output-scan ring detector.
 *
 * Scoping mirrors `runReplWatchdogTick`: only pool keys whose owning substrate
 * points at THIS `replRegistryPath` (Codex P2 — one registry is shared by
 * substrates that differ). Only LIVE children with a resolvable pid + a canonical
 * cwd are probed; a registry-only / dead row has no child to ask lsof about and is
 * left to the wedge watchdog. Exported so the live wiring is directly testable
 * (brief § 9 anti-pattern #1 — no built-but-not-wired core).
 */
export async function runCwdDriftWatchdogTick(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): Promise<CwdDriftTickResult[]> {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return []
  const registry = loadRegistry(registryPath)
  const ownedPoolKeys = [...pool.keys()].filter(
    (k) => supervisedBySessionKey.get(k)?.replRegistryPath === registryPath,
  )

  const entries: CwdDriftSupervisedEntry[] = []
  for (const sessionKey of ownedPoolKeys) {
    const p = pool.get(sessionKey)
    if (p === undefined) continue
    let session: ReplSession
    try {
      session = await p
    } catch {
      continue // spawn failed — wedge watchdog owns this row.
    }
    if (session.hasChildExited()) continue
    const canonicalCwd = registry[sessionKey]?.cwd
    if (!canonicalCwd) continue // no canonical recorded → nothing to compare against.
    let pid: number
    try {
      pid = session.child.pid
    } catch {
      continue // child detached (test fake / mid-teardown).
    }
    entries.push({ sessionKey, pid, canonicalCwd })
  }

  return runCwdDriftTick({
    entries,
    ...(wopts.cwdDriftProbeCwd ? { probeCwd: wopts.cwdDriftProbeCwd } : {}),
    ...(wopts.cwdDriftCanonicalExists ? { canonicalExists: wopts.cwdDriftCanonicalExists } : {}),
    lastDriftRespawnAt: (k) => cwdDriftRespawnState.get(k),
    markDriftRespawn: (k, at) => cwdDriftRespawnState.set(k, at),
    respawn: (entry) => {
      // Respawn with the OWNING substrate's options (env / instance-id / spawn
      // opts), resolved by pool key — never the tick's own options (an
      // unregistered key would resume under the wrong identity; mirror the wedge
      // tick's guard). `respawnReplSession` re-spawns from `record.cwd`, pinning
      // the child back to canonical.
      const keyOptions = supervisedBySessionKey.get(entry.sessionKey)
      if (keyOptions === undefined) return false
      const outcome = respawnReplSession(
        keyOptions,
        entry.sessionKey,
        'cwd-drift-watchdog',
        `cwd drifted off ${entry.canonicalCwd}`,
      )
      return outcome.ok
    },
    ...(wopts.postAlert ? { postAlert: wopts.postAlert } : {}),
    alertLatch: cwdDriftAlertState,
    ...(wopts.now ? { now: wopts.now } : {}),
    ...(wopts.cwdDriftThrottleMs !== undefined ? { throttleMs: wopts.cwdDriftThrottleMs } : {}),
  })
}

/**
 * Start the live REPL watchdog: an in-flight-gated tick (default 15s) that
 * self-heals wedged/crashed REPLs via `runReplWatchdogTick`, plus (when
 * `heartbeatFile` is set) the 100ms heartbeat that the systemd
 * `Type=notify`/`WatchdogSec` supervisor reads. No-op (returns a stop() that
 * does nothing) when `replRegistryPath` is unset — supervision is OFF.
 */
export function startReplWatchdog(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): ReplWatchdog {
  if (options.replRegistryPath === undefined) {
    return { stop: () => {} }
  }
  // Idempotent per registry: a second start for the same instance returns the live
  // handle rather than spawning a second 15 s tick + 100 ms heartbeat. The handle
  // is tracked so `shutdownAllPersistentRepls` can stop the timers — otherwise an
  // in-process gateway/test run with the flag on would leak both intervals and
  // keep the Bun event loop from draining after shutdown (Codex P2).
  const registryPath = options.replRegistryPath
  const live = activeWatchdogs.get(registryPath)
  if (live !== undefined) return live
  const intervalMs = wopts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
  const setIntervalFn =
    wopts.setIntervalFn ?? ((cb: () => void, ms: number) => globalThis.setInterval(cb, ms))
  const clearIntervalFn =
    wopts.clearIntervalFn ??
    ((h: unknown) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]))

  let heartbeat: HeartbeatWatchdog | undefined
  if (wopts.heartbeatFile !== undefined) {
    heartbeat = startHeartbeatWatchdog({ heartbeatFile: wopts.heartbeatFile })
  }

  // Restart-rate crash-loop guard (Vajra mechanism #20). Each boot records a
  // restart marker; two restarts <5min apart == a crash loop (the 2026-05-21
  // pristine signature: restart, then restart again 118s later). Edge-latched →
  // warns ONCE per loop, not every boot. Surfaced via `postAlert` (operator
  // chat) or stderr — auto-restart is making it worse, so a human must look.
  if (options.restartMarkersPath !== undefined) {
    try {
      const verdict = recordAndEvaluateRestart(options.restartMarkersPath, Date.now())
      if (verdict.warn) {
        const text = buildCrashLoopWarningText(verdict.detection)
        if (wopts.postAlert !== undefined) wopts.postAlert(text)
        else console.error(text)
      }
    } catch (e) {
      // Best-effort: the guard must never block watchdog startup.
      console.error(`repl-watchdog: restart-rate guard error: ${e}`)
    }
  }

  // Boot-drain (brief § 6 acceptance #1): replay anything a prior gateway crash
  // left queued — each entry is a turn whose REPL died mid-flight and whose
  // in-process replay never fired because the gateway itself went down. Fire-and-
  // forget with the default anti-thundering-herd stagger; errors are swallowed so
  // a poisoned entry can't block watchdog startup.
  void drainPendingRespawns(options).catch((e) =>
    console.error(`repl-watchdog: boot-drain error: ${e}`),
  )

  // Per-registry tick gate (Argus r3 MINOR 3): scoped to THIS watchdog so a slow
  // tick for one instance's registry never serializes another instance's tick in a
  // hosted single-process deployment. Consistent with round-8 per-registry pool
  // scoping. Lives in the closure → GC'd when the watchdog stops.
  const tickGate = makeInFlightGate()
  const tick = (): void => {
    // in-flight gate: skip if a prior tick is still running (the work can take
    // longer than the cadence; double-firing would race the respawn).
    if (!tickGate.claim()) return
    void runReplWatchdogTick(options, wopts)
      .catch((e) => console.error(`repl-watchdog: tick error: ${e}`))
      .finally(() => tickGate.release())
  }
  const handle = setIntervalFn(tick, intervalMs)

  // Separate, slower cwd-drift tick (default 60s) on its OWN in-flight gate: lsof
  // is heavier than the wedge tick's `/health` fetch, and the two ticks are
  // independent (a slow drift probe must not serialize the wedge/crash recovery).
  const cwdDriftIntervalMs = wopts.cwdDriftIntervalMs ?? DEFAULT_CWD_DRIFT_INTERVAL_MS
  const cwdDriftGate = makeInFlightGate()
  const cwdDriftTick = (): void => {
    if (!cwdDriftGate.claim()) return
    void runCwdDriftWatchdogTick(options, wopts)
      .catch((e) => console.error(`cwd-drift-watchdog: tick error: ${e}`))
      .finally(() => cwdDriftGate.release())
  }
  const cwdDriftHandle = setIntervalFn(cwdDriftTick, cwdDriftIntervalMs)

  let stopped = false
  const watchdog: ReplWatchdog = {
    stop: () => {
      if (stopped) return
      stopped = true
      clearIntervalFn(handle)
      clearIntervalFn(cwdDriftHandle)
      heartbeat?.stop()
      if (activeWatchdogs.get(registryPath) === watchdog) activeWatchdogs.delete(registryPath)
    },
  }
  activeWatchdogs.set(registryPath, watchdog)
  return watchdog
}

// ---------------------------------------------------------------------------
// Model-update watchdog wiring (Vajra port row #16).
// ---------------------------------------------------------------------------

/** Snapshot a pooled warm session's idle signals for the graceful-upgrade gate,
 *  or `null` if the session is gone / its child exited. Reads the four Vajra idle
 *  signals off the live `ReplSession`:
 *    - isTyping            → a turn is actively in flight (`activeTurn` set)
 *    - hasToolPromptPending→ a wedge/tool-prompt recovery ladder is running
 *    - lastDataAt          → last PTY byte (assistant-write proxy)
 *    - jsonlMtimeMs        → session transcript mtime (cold ⇒ idle) */
async function modelUpgradeIdleSignals(
  sessionKey: string,
  projectsDir: string,
  cwd: string | undefined,
): Promise<SessionIdleSignals | null> {
  const p = pool.get(sessionKey)
  if (p === undefined) return null
  let session: ReplSession
  try {
    session = await p
  } catch {
    return null
  }
  if (session.hasChildExited()) return null
  let jsonlMtimeMs: number | null = null
  try {
    // The session transcript lives at `<projectsDir>/<cwd-dashed>/<id>.jsonl`; a
    // missing cwd (legacy record) means we can't address it → treat mtime as
    // unknown (the mid-turn / tool-prompt gates still guard the upgrade).
    if (cwd !== undefined) {
      const jsonlPath = sessionJsonlPath(session.sessionId, cwd, projectsDir)
      jsonlMtimeMs = existsSync(jsonlPath) ? statSync(jsonlPath).mtimeMs : null
    }
  } catch {
    jsonlMtimeMs = null
  }
  return {
    isTyping: session.activeTurn !== undefined,
    hasToolPromptPending: session.wedgeRecovering,
    lastDataAt: session.lastDataAt,
    jsonlMtimeMs,
  }
}

/**
 * Start the model-update watchdog for THIS instance (Vajra port row #16). A
 * 6h-gated tick probes the CLI's live model id (NO `--fallback-model`); on a
 * genuinely-new top-tier id it posts the upgrade notice, adopts the model as the
 * runtime default ({@link setBestModelOverride} — so fresh spawns use it), and
 * idle-gated graceful-respawns each warm session onto it (rewriting each
 * record's `model` BEFORE the `--resume`). Idempotent per model-update state
 * path; a no-op (inert handle) when no state path is configured.
 */
export function startModelUpdateWatchdogForInstance(
  options: PersistentReplSubstrateOptions,
  wopts: ReplWatchdogOptions = {},
): ModelUpdateWatchdog {
  const statePath = options.modelUpdateStatePath
  if (statePath === undefined) {
    return { stop: () => {}, tick: async () => {} }
  }
  // Idempotent per state path (mirrors startReplWatchdog): one cadence tick per
  // instance, re-armable after shutdown.
  const live = activeModelWatchdogs.get(statePath)
  if (live !== undefined) return live

  const projectsDir = resolveTranscriptProjectsDir(options)
  const registryPath = options.replRegistryPath

  // The probe inherits the instance's scrubbed env + isolated config dir so it
  // authenticates exactly as the warm REPLs do.
  const probeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...((options.env ?? {}) as NodeJS.ProcessEnv),
    ...(options.claudeConfigDir !== undefined ? { CLAUDE_CONFIG_DIR: options.claudeConfigDir } : {}),
  }

  const deps: Parameters<typeof startModelUpdateWatchdog>[0] = {
    probeModel:
      options.modelProbe ??
      (() =>
        realProbeModel({
          ...(options.claude_bin !== undefined ? { claudeBin: options.claude_bin } : {}),
          env: probeEnv,
        })),
    loadState: () => loadModelUpdateState(statePath),
    saveState: (s) => saveModelUpdateState(statePath, s),
    getConfiguredModel: getBestModel,
    adoptModel: (m) => setBestModelOverride(m),
    knownFallbacks: getKnownFallbackModels,
    postNotice: (notice) => {
      if (options.onModelUpdate !== undefined) {
        options.onModelUpdate(notice)
      } else if (wopts.postAlert !== undefined) {
        wopts.postAlert(notice.text)
      } else {
        process.stderr.write(`[model-update] ${notice.text}\n`)
      }
    },
    runUpgrade: async (newModel: string) => {
      if (registryPath === undefined) return
      // Target only the warm sessions this instance owns (pool keys whose owning
      // substrate points at this registry) — never another instance's sessions.
      const ownedKeys = [...pool.keys()].filter(
        (k) => supervisedBySessionKey.get(k)?.replRegistryPath === registryPath,
      )
      await runGracefulUpgrade({
        listSessionKeys: () => ownedKeys,
        idleSignals: (key) =>
          modelUpgradeIdleSignals(key, projectsDir, getRecord(registryPath, key)?.cwd),
        upgradeSession: (key) => {
          // Rewrite the registry record's model BEFORE the respawn so the
          // `--resume` re-attaches on the NEW model (resumeSpecFor reads it).
          patchRecord(registryPath, key, { model: newModel })
          const owner = supervisedBySessionKey.get(key) ?? options
          const outcome = respawnReplSession(
            owner,
            key,
            'model-update-watchdog',
            `model upgrade → ${newModel}`,
          )
          return outcome.ok
        },
        log: (msg) => console.log(msg),
        ...(options.modelUpgradeIdleQuiesceMs !== undefined ? { idleQuiesceMs: options.modelUpgradeIdleQuiesceMs } : {}),
        ...(options.modelUpgradeJsonlFreshMs !== undefined ? { jsonlFreshMs: options.modelUpgradeJsonlFreshMs } : {}),
        ...(options.modelUpgradePollMs !== undefined ? { pollMs: options.modelUpgradePollMs } : {}),
        ...(options.modelUpgradePerSessionTimeoutMs !== undefined
          ? { perSessionTimeoutMs: options.modelUpgradePerSessionTimeoutMs }
          : {}),
      })
    },
    ...(options.modelCheckTickMs !== undefined ? { intervalMs: options.modelCheckTickMs } : {}),
    ...(options.modelCheckIntervalMs !== undefined ? { checkIntervalMs: options.modelCheckIntervalMs } : {}),
  }

  const watchdog = startModelUpdateWatchdog(deps)
  const wrapped: ModelUpdateWatchdog = {
    stop: () => {
      watchdog.stop()
      if (activeModelWatchdogs.get(statePath) === wrapped) activeModelWatchdogs.delete(statePath)
    },
    tick: () => watchdog.tick(),
  }
  activeModelWatchdogs.set(statePath, wrapped)
  return wrapped
}

/** Test/introspection: the live model-update watchdog for a state path, or
 *  undefined. Lets the wiring test drive a synchronous `tick()`. */
export function peekModelUpdateWatchdogForTest(
  statePath: string,
): ModelUpdateWatchdog | undefined {
  return activeModelWatchdogs.get(statePath)
}

// ---------------------------------------------------------------------------
// Test/operator introspection helpers.
// ---------------------------------------------------------------------------

/** Read the persisted registry (snapshot). Operator/test helper. */
export function getReplRegistrySnapshot(registryPath: string): Record<string, ReplRegistryRecord> {
  return loadRegistry(registryPath)
}

/** Whether the module pool currently holds a (possibly dead) session for a key. */
export function poolHasSessionForTest(sessionKey: string): boolean {
  return pool.has(sessionKey)
}

/**
 * Actuate the surfaced Compact affordance (Vajra port row #13) for a pooled warm
 * session: `escape` + `/compact\r`, fire-once, behind the watchdog's mid-compact
 * lock + debounce. This is the MANUAL entry point a gateway calls when the user
 * presses "🗜️ Compact" on a surfaced size alert. (The watchdog ALSO actuates the
 * same compaction automatically at the critical band when the session is idle —
 * the gap-#4 POLICY — so a single-owner Open session with no pressable affordance
 * still can't wedge; this manual path remains for any surface that wires a
 * button.) Returns false when there is no live session for the key or a
 * compaction is already mid-flight / within the debounce floor.
 */
export async function requestSessionCompact(sessionKey: string): Promise<boolean> {
  const p = pool.get(sessionKey)
  if (p === undefined) return false
  try {
    const session = await p
    if (session.hasChildExited()) return false
    return session.sizeWatchdog?.requestCompact() ?? false
  } catch {
    return false
  }
}

/** Test/introspection: the live size watchdog for a pooled session, or undefined.
 *  Lets the wiring test drive a synchronous `tick()` against a pre-seeded JSONL. */
export async function peekSizeWatchdogForTest(
  sessionKey: string,
): Promise<SessionSizeWatchdog | undefined> {
  const p = pool.get(sessionKey)
  if (p === undefined) return undefined
  try {
    return (await p).sizeWatchdog
  } catch {
    return undefined
  }
}
