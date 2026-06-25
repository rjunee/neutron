/**
 * session-respawn.ts — context-preserving REPL respawn (substrate-lift S2 § 2
 * row #9, ◆ ADAPTED-AT-BOUNDARY).
 *
 * LIFTED from Nova `gateway/topic-respawn.ts`. `planRespawn` /
 * `shouldPostRespawnNotice` / `buildRespawnNoticeText` are ★ pure and lift
 * clean. `executeRespawn`'s side-effect deps adapt at the Bun-PTY / per-instance
 * boundary:
 *
 *   Nova                                   Neutron
 *   ─────────────────────────────────────  ────────────────────────────────────
 *   killPane (tmux kill-pane)               killChild (PtyChild.kill SIGTERM)
 *   killPortHolders (lsof -ti | kill -9)    (dropped — Bun-PTY binds a fresh
 *                                            ephemeral dev-channel port; no
 *                                            shared OS port to reclaim)
 *   clearReadyFlag (ccReadyTopics)          evictPool (delete the pool entry by
 *                                            sessionKey so getOrSpawn respawns)
 *   spawnCC(--resume)                        spawnResume (getOrSpawnSession with
 *                                            resolveRespawnStrategy forcing
 *                                            resume:true + the captured sessionId)
 *   keyed on topic name/thread_id            keyed on ReplSession.sessionKey
 *
 * THE INVARIANT (Nova hard contract, brief § 2 / § 6 acceptance #2 & #4): a
 * respawn ALWAYS resumes — never a fresh spawn. If the registry record has no
 * resumable session we REFUSE with `no-session-to-resume` rather than silently
 * wiping the conversation. This is what wires the previously-DORMANT
 * `resolveRespawnStrategy` (brief § 9 anti-pattern #1): planRespawn routes the
 * record through it and refuses unless the strategy resolves to `session-id`.
 */

import { resolveRespawnStrategy, type RespawnResolutionInput } from './respawn-strategy.ts'
import type { ReplRegistryRecord } from './repl-registry.ts'

/** Result of planning a respawn — pure, computed before any side-effects. */
export interface RespawnPlan {
  ok: boolean
  reason?: RespawnRefusalReason
  /** Session UUID the respawn will `--resume`. Only populated when `ok`. */
  sessionId?: string
  /** Pool key for downstream logging / actuation. */
  sessionKey?: string
}

export type RespawnRefusalReason =
  | 'session-not-found'
  | 'no-session-to-resume'
  | 'invalid-session-key'
  | 'spawn-cwd-invalid'
  | 'spawn-failed'

/** Who asked for this respawn — used for logging + notice text + silencing. */
export type RespawnTrigger =
  | 'admin-endpoint'
  | 'wedge-watchdog'
  | 'crash-watchdog'
  | 'stuck-turn-watchdog'
  | 'cwd-drift-watchdog'

/** Outcome of the injected spawn-with-resume. Returns a typed refusal so a
 *  ghost-cwd / bind failure propagates instead of lying "context preserved". */
export type SpawnReplOutcome = { ok: true } | { ok: false; reason: 'invalid-cwd' | 'spawn-failed' }

export interface RespawnOutcome {
  ok: boolean
  reason?: RespawnRefusalReason
  sessionId?: string
  sessionKey?: string
  /** Epoch ms at which the respawn was initiated. */
  initiatedAt?: number
}

export interface RespawnNoticeArgs {
  sessionKey: string
  sessionId: string
  trigger: RespawnTrigger
  reason: string
}

/**
 * Plan a respawn for `sessionKey`. Pure — never mutates the registry or touches
 * the filesystem. Routes the record through `resolveRespawnStrategy` (wiring the
 * S1-dormant resolver) and refuses unless it resolves to a resumable
 * `session-id`. Returns `{ok:true, sessionId, sessionKey}` on go.
 */
export function planRespawn(
  registry: Record<string, ReplRegistryRecord>,
  sessionKey: string,
): RespawnPlan {
  if (!sessionKey || typeof sessionKey !== 'string' || !sessionKey.trim()) {
    return { ok: false, reason: 'invalid-session-key' }
  }
  const record = registry[sessionKey]
  if (!record) {
    return { ok: false, reason: 'session-not-found' }
  }
  // Respawn-is-always-resume: the strategy MUST resolve to a session UUID.
  const resolutionInput: RespawnResolutionInput = { has_session: record.has_session }
  if (record.has_session && record.sessionId) resolutionInput.session_id = record.sessionId
  const resolution = resolveRespawnStrategy(resolutionInput)
  if (resolution.strategy !== 'session-id' || !resolution.sessionId) {
    return { ok: false, reason: 'no-session-to-resume', sessionKey }
  }
  return { ok: true, sessionId: resolution.sessionId, sessionKey }
}

/** Injected side-effect surface. Tests record calls + assert without touching
 *  the real PtyHost / pool / disk. */
export interface RespawnDeps {
  /** SIGTERM the pooled child for `sessionKey`. `PtyChild.kill()` in prod —
   *  safe if the child is already dead. */
  killChild: (sessionKey: string) => void
  /** Evict the pool entry so the next `getOrSpawnSession` actually respawns. */
  evictPool: (sessionKey: string) => void
  /** Spawn with `--resume` (resume:true + the captured sessionId). Wraps
   *  `getOrSpawnSession` with a resume directive in prod. MUST return a typed
   *  outcome so the caller can propagate a refusal. */
  spawnResume: (record: ReplRegistryRecord) => SpawnReplOutcome
  /** Persist the mutated registry record (respawn bookkeeping). */
  saveRecord: (record: ReplRegistryRecord) => void
  /** Drop the dev-channel forward-gate cache for the resumed session (Argus r1
   *  IMPORTANT 3 parity — a `--resume` re-attaches the same sessionId so a
   *  stale forward stamp would otherwise re-trip the health gate). Optional. */
  clearForwardGate?: (sessionId: string) => void
  /** Non-blocking notice. Not awaited so a slow channel can't delay respawn. */
  postNotice?: (args: RespawnNoticeArgs) => Promise<void> | void
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Execute a planned respawn against `record`. Does NOT plan — pass a
 * `planRespawn()` result. Order of operations mirrors the Nova recovery
 * sequence, adapted to Bun-PTY:
 *   1. Kill the pooled child (SIGTERM via PtyChild.kill — safe if dead).
 *   2. Evict the pool entry so the next spawn doesn't reuse the dead session.
 *   3. Mutate the record: clear pid, bump last_respawn_at + recent_respawns,
 *      KEEP has_session=true + sessionId (never cleared — the resume invariant).
 *   4. Drop the forward-gate cache for the resumed sessionId.
 *   5. Persist the record BEFORE spawn (crash between save + spawn leaves a
 *      coherent "no pid, resumable" row the next tick re-heals).
 *   6. spawnResume(record) — `--resume` with the preserved sessionId.
 *   7. Fire-and-forget postNotice.
 */
export function executeRespawn(
  record: ReplRegistryRecord,
  plan: RespawnPlan,
  trigger: RespawnTrigger,
  reason: string,
  deps: RespawnDeps,
): RespawnOutcome {
  if (!plan.ok || !plan.sessionId || !plan.sessionKey) {
    return {
      ok: false,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.sessionKey ? { sessionKey: plan.sessionKey } : {}),
    }
  }
  if (record.sessionKey !== plan.sessionKey || record.sessionId !== plan.sessionId) {
    // Race: the record changed between plan + execute. Treat as not-found.
    return { ok: false, reason: 'session-not-found', sessionKey: plan.sessionKey }
  }

  const now = (deps.now ?? Date.now)()
  const log = deps.log ?? ((msg: string) => console.log(msg))

  log(
    `repl-respawn: ${plan.sessionKey} trigger=${trigger} ` +
      `reason=${JSON.stringify(reason)} session=${plan.sessionId.slice(0, 8)}`,
  )

  // 1. SIGTERM the pooled child — safe if already dead.
  try {
    deps.killChild(plan.sessionKey)
  } catch (e) {
    log(`repl-respawn: killChild threw for ${plan.sessionKey}: ${e}`)
  }

  // 2. Evict the pool entry so getOrSpawn respawns instead of reusing the dead.
  try {
    deps.evictPool(plan.sessionKey)
  } catch (e) {
    log(`repl-respawn: evictPool threw for ${plan.sessionKey}: ${e}`)
  }

  // 3. Mutate the record. PRESERVE sessionId + has_session so --resume works.
  //    KEEP the (now-killed) `pid` as the liveness anchor (Codex P1): if the
  //    async resume spawn FAILS (post-spawn assertion / auth / dev-channel
  //    health), nothing overwrites this record, so the next watchdog tick must
  //    still see a wedge to retry. With `pid` cleared the probe would be
  //    {no-child, no-pid, ccReady:true} → `detectReplWedged` returns NOT-wedged
  //    (the `ccReady` gate) → the session is stranded with no running child.
  //    Retaining the dead pid makes the next tick read `pid-dead` → respawn-retry
  //    (cooldown-gated). On SUCCESS, `spawnSession` overwrites the record with the
  //    fresh child's pid; during the spawn window the in-flight stamp (set by
  //    `respawnReplSession`) gates any tick to alert-only, so the stale pid can't
  //    trigger a double-spawn.
  record.last_respawn_at = now
  record.recent_respawns = [...(record.recent_respawns ?? []), now]
  // has_session + sessionId + pid intentionally untouched — the resume invariant
  // + the liveness anchor for failed-respawn retry.

  // 4. Drop the forward-gate cache for the resumed session.
  if (deps.clearForwardGate) {
    try {
      deps.clearForwardGate(plan.sessionId)
    } catch (e) {
      log(`repl-respawn: clearForwardGate threw for ${plan.sessionKey}: ${e}`)
    }
  }

  // 5. Persist BEFORE spawn (crash-safe).
  try {
    deps.saveRecord(record)
  } catch (e) {
    log(`repl-respawn: saveRecord threw: ${e}`)
  }

  // 6. Spawn with --resume. Propagate a typed refusal.
  let spawnOutcome: SpawnReplOutcome
  try {
    spawnOutcome = deps.spawnResume(record)
  } catch (e) {
    log(`repl-respawn: spawnResume threw for ${plan.sessionKey}: ${e}`)
    return { ok: false, reason: 'spawn-failed', sessionKey: plan.sessionKey }
  }
  if (!spawnOutcome.ok) {
    log(`repl-respawn: spawnResume refused ${plan.sessionKey} (reason=${spawnOutcome.reason})`)
    return {
      ok: false,
      reason: spawnOutcome.reason === 'invalid-cwd' ? 'spawn-cwd-invalid' : 'spawn-failed',
      sessionKey: plan.sessionKey,
    }
  }

  // 7. Fire-and-forget notice. Swallow errors — the respawn is the contract.
  if (deps.postNotice) {
    Promise.resolve()
      .then(() =>
        deps.postNotice!({
          sessionKey: plan.sessionKey!,
          sessionId: plan.sessionId!,
          trigger,
          reason,
        }),
      )
      .catch((e) => log(`repl-respawn: postNotice failed: ${e}`))
  }

  return {
    ok: true,
    sessionId: plan.sessionId,
    sessionKey: plan.sessionKey,
    initiatedAt: now,
  }
}

/**
 * Whether a respawn from `trigger` should post a notice. Stuck-turn recovery is
 * SILENT (a topic the user can still type into is not "broken"); every other
 * trigger posts. Pure predicate — lifted from Nova `shouldPostRespawnNotice`.
 */
export function shouldPostRespawnNotice(trigger: RespawnTrigger): boolean {
  return trigger !== 'stuck-turn-watchdog'
}

/** Canonical respawn notice body. Lifted from Nova `buildRespawnNoticeText`. */
export function buildRespawnNoticeText(args: RespawnNoticeArgs): string {
  const triggerLabel =
    args.trigger === 'admin-endpoint'
      ? 'manual admin respawn'
      : args.trigger === 'wedge-watchdog'
        ? 'wedge watchdog'
        : args.trigger === 'crash-watchdog'
          ? 'crash watchdog'
          : args.trigger === 'cwd-drift-watchdog'
            ? 'cwd-drift watchdog'
            : 'stuck-turn watchdog'
  const symptom =
    args.trigger === 'admin-endpoint'
      ? 'operator-triggered respawn'
      : args.trigger === 'crash-watchdog'
        ? 'process exited'
        : args.trigger === 'wedge-watchdog'
          ? 'was unresponsive'
          : args.trigger === 'cwd-drift-watchdog'
            ? 'working dir drifted'
            : 'turn stalled'
  return (
    `\u{1F527} Auto-respawn: REPL \`${args.sessionKey}\` ${symptom} ` +
    `(${triggerLabel}) — resuming session \`${args.sessionId.slice(0, 8)}\`. ` +
    `Conversation context preserved. Reason: ${args.reason}`
  )
}
