import { observeSession } from './observe-workers.ts'
import { hasUnresolvedNativeChild, hasUnresolvedNativeChildForChat } from './native-child-liveness.ts'
import { describeWorkerObservation, unclassifiedObservation, type WorkerObservation } from './worker-observation.ts'
// persistent-repl-substrate.ts → pool.ts
// The warm pool, the createPersistentReplSubstrate turn driver, ephemeral
// one-shots, and the dropped-inbound replay sink (D2 split).

import { getBestModel } from '../../../models.ts'
import { neutralizeAbandonedSettle } from '@neutronai/logger/fire-and-forget.ts'
import type { SessionHandle } from '../../../session-handle.ts'
import type { AgentSpec, Substrate } from '../../../substrate.ts'
import { requireReplCwd } from './spawn-configuration-error.ts'
import { classifyThrownSpawnError } from './classify-spawn-error.ts'
import { SUBSTRATE_ERROR_CODES } from '../../../errors.ts'
import { EventChannel } from './event-channel.ts'
import { type PendingRespawnEntry, enqueuePendingRespawn } from './pending-respawns-queue.ts'
import { REPL_DEBUG, activeModelWatchdogs, activeWatchdogs, childByKey, committedDispatches, cwdDriftAlertState, cwdDriftRespawnState, ephemeralSessions, pendingChildKills, pendingSpawns, pool, respawnGates, sink, supervisedBySessionKey, wedgeAlertState, retiringSessionKeys } from './pool-state.ts'
import { getRecord, refreshPaneClaim, registryConversationScopeMatches, sleepPane, withOwnedRegistry, type ReplRegistryRecord } from './repl-registry.ts'
import {
  SHUTDOWN_PENDING_SPAWN_GRACE_MS,
  cancellableWait,
  readChildPid,
  confirmShutdownExits,
  deliverShutdownKillReports,
  recordGatewayShutdownKill,
  sampleLivenessBeforeShutdownKill,
  type PendingShutdownKillReport,
  type ShutdownExitWatch,
} from './gateway-shutdown-kill.ts'
import { claimShutdownSurvival } from './gateway-shutdown-survival.ts'
import {
  releaseAdoptionClaim,
  resetBootAdoption,
  settleBootAdoptionsForShutdown,
} from './boot-adoption.ts'
import { randomUUID } from 'node:crypto'
import { normalizePtyText, stripAnsi } from './pty-text.ts'
import { CONTEXT_RESET_COMMAND, DEFAULT_IDLE_MAX_MS, DEFAULT_IDLE_QUIET_MS, DEFAULT_TURN_ABSOLUTE_CEILING_MS, DEFAULT_TURN_INACTIVITY_MS, REPL_LIVENESS_KEEPALIVE_MS, SESSION_KEY_SEP, runOutputScan, submitCommand } from './signatures.ts'
import type { ActiveTurn, PersistentReplSubstrateOptions, RecoveredReply } from './types.ts'
import { ReplSession, terminateChild, unlinkSessionConfigs } from './repl-session.ts'
import { AUTH_FAILURE_DETECTOR_ID } from './auth-failure-signature.ts'
import { gateFor, getOrSpawnSession, injectMessage, shutdownQuarantinedChildren, spawnWithChannelWedgeRespawn, waitForReplIdle } from './spawn.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

const activeTurnRoutes = new Map<string, { session: ReplSession; turn: ActiveTurn }>()

function activeTurnRoutePrefix(input: {
  substrate_instance_id: string
  user_id?: string
  project_id?: string
}): string {
  return `${JSON.stringify([
    input.substrate_instance_id,
    input.user_id ?? '_platform',
    input.project_id ?? 'default',
  ]).slice(0, -1)},`
}

function activeTurnRouteKey(input: {
  substrate_instance_id: string
  user_id?: string
  project_id?: string
  credential_identity?: string
}): string {
  return JSON.stringify([
    input.substrate_instance_id,
    input.user_id ?? '_platform',
    input.project_id ?? 'default',
    input.credential_identity ?? '_nocred',
  ])
}

/** Inject a user message into this substrate's currently running Claude turn. */
export async function injectPersistentReplActiveTurn(
  input: {
    substrate_instance_id: string
    user_id?: string
    project_id?: string
    credential_identity?: string
    text: string
  },
): Promise<boolean> {
  const routeKey = activeTurnRouteKey(input)
  const candidates = input.credential_identity !== undefined
    ? [activeTurnRoutes.get(routeKey)].filter((entry): entry is { session: ReplSession; turn: ActiveTurn } => entry !== undefined)
    : [...activeTurnRoutes.entries()]
      .filter(([key]) => key.startsWith(activeTurnRoutePrefix(input)))
      .map(([, entry]) => entry)
  // The gateway intentionally does not know the selected secret identity. A
  // rotation can briefly leave two credential-scoped routes alive; queue in
  // that ambiguous window instead of delivering to whichever registered last.
  const active = candidates.length === 1 ? candidates[0] : undefined
  if (active === undefined || active.turn.settled || active.session.channelPort === undefined) {
    return false
  }
  const prior = active.turn.injectionTail ?? Promise.resolve()
  const delivery = prior.then(async () => {
    if (active.turn.settled || active.session.activeTurn !== active.turn) {
      throw new Error('persistent-repl: active turn settled before injection')
    }
    await injectMessage(active.session, input.text, active.turn.turnId, true)
  })
  active.turn.injectionTail = delivery.catch(() => undefined)
  try {
    await delivery
    // Once POST /message succeeds the text was delivered. Settlement can race
    // this continuation; reporting false here would enqueue the same text as a
    // fresh turn and duplicate user-visible work.
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Pending-respawns queue wiring (brief § 2 row #11 / § 6 acceptance #1).
// Disk-is-source-of-truth deferred-respawn replay: a turn dropped when its REPL
// died mid-turn is enqueued, then replayed after the session resumes — in-
// process via the watchdog tick's drain, or across a gateway restart via the
// boot-drain. The replay re-injects the dropped inbound through the SAME
// dev-channel `POST /message` path a normal turn uses ("replay sink").
// ---------------------------------------------------------------------------

/** Record a mid-turn-dropped inbound for replay-after-resume. No-op when the
 *  pending-respawns queue is not configured (supervision off). Best-effort: a
 *  queue write failure degrades to "no replay for this inbound", never bricks
 *  the live path. */
function enqueueDroppedInbound(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  session: ReplSession,
  droppedInbound: string,
  turnId: string,
): void {
  const path = options.pendingRespawnsPath
  if (path === undefined) return
  const entry: PendingRespawnEntry = {
    sessionKey,
    sessionId: session.sessionId,
    cwd: session.cwd,
    substrate_instance_id: options.substrate_instance_id,
    droppedInbound,
  }
  if (session.channelPort !== undefined) entry.devchannel_port = session.channelPort
  // S3 #106: record the redelivery routing so the replay path can re-deliver the
  // recovered reply to the user on reconnect (deduped on `turn_id`). `topic_id`
  // is persisted explicitly so the boot-drain (pre-registration) can route it.
  if (options.delivery_topic_id !== undefined) entry.topic_id = options.delivery_topic_id
  if (options.instance_slug !== undefined) entry.instance_slug = options.instance_slug
  entry.turn_id = turnId
  try {
    enqueuePendingRespawn(path, entry)
  } catch {
    /* best-effort */
  }
}

/** Replay ONE queued dropped inbound through the OWNING substrate's registered
 *  options (`ownerOptions`, resolved by the caller from `supervisedBySessionKey`).
 *  Drives a full turn so `getOrSpawnSession` `--resume`s the captured session and
 *  the driver re-injects the dropped inbound via the dev-channel `POST /message`.
 *  Returns true once the replay turn completes. A turn with no actual inbound
 *  (empty `droppedInbound`) is a no-op.
 *
 *  Routing correctness (Codex P2): the pending queue is SHARED by every substrate
 *  under one instance registry (`cc-llm-*`, `cc-llm-router-*`, `cc-import-*` all
 *  write `<owner_home>/.neutron/.pending-respawns.json`). Replaying through the
 *  drain's own options would resume the WRONG substrate's session and with the
 *  wrong env. The caller resolves the owner by `entry.sessionKey`, so the
 *  computed pool key === `entry.sessionKey` and env/identity are exactly the
 *  owning substrate's; unregistered entries are retained for a later drain rather
 *  than replayed with a fallback (see `drainPendingRespawns`).
 *
 *  S3 REDELIVERY (#106 — closes the prior S2 limitation): this re-drives the
 *  resumed REPL so it PROCESSES the dropped inbound AND now CAPTURES the recovered
 *  assistant reply (the completion's preceding `token` text). When the owning
 *  substrate threaded an `onRecoveredReply` sink + the entry carries a routing
 *  handle (`topic_id` + `turn_id`), the recovered reply is handed to that sink —
 *  which delivers it to the user's reconnect channel now (if online) or persists
 *  it as an undelivered row the existing reconnect re-emit path flushes (deduped
 *  on `turn_id`). The substrate is a runtime-layer module and never imports the
 *  gateway delivery layer; the sink is the injected seam. */
export async function replayPendingInbound(
  ownerOptions: PersistentReplSubstrateOptions,
  entry: PendingRespawnEntry,
): Promise<boolean> {
  if (entry.droppedInbound === undefined || entry.droppedInbound === '') return false
  const record =
    ownerOptions.replRegistryPath !== undefined
      ? getRecord(ownerOptions.replRegistryPath, entry.sessionKey)
      : undefined
  const replaySpec: AgentSpec = {
    prompt: entry.droppedInbound,
    tools: [],
    // The live runtime best model (the watchdog override when one was adopted,
    // else the env/default) — never a hardcoded id, so a model upgrade reaches
    // the replay path too.
    model_preference: [record?.model ?? getBestModel()],
  }
  const handle = createPersistentReplSubstrate(ownerOptions).start(replaySpec)
  let recoveredText = ''
  try {
    for await (const ev of handle.events) {
      if (ev.kind === 'token') {
        recoveredText += ev.text
        continue
      }
      if (ev.kind === 'completion') {
        await deliverRecoveredReply(ownerOptions, entry, recoveredText)
        return true
      }
      if (ev.kind === 'error') return false
    }
  } catch {
    return false
  }
  return false
}

/** Hand a recovered reply to the gateway's injected redelivery sink (#106). The
 *  routing handle (`topic_id` + `turn_id`) is required — without it the recovered
 *  reply can't be addressed to a user channel, so it is dropped (the turn's
 *  conversation state already advanced in the resumed transcript). Best-effort:
 *  a sink throw never bricks the drain. */
async function deliverRecoveredReply(
  ownerOptions: PersistentReplSubstrateOptions,
  entry: PendingRespawnEntry,
  text: string,
): Promise<void> {
  const sink = ownerOptions.onRecoveredReply
  if (sink === undefined) return
  if (entry.topic_id === undefined || entry.turn_id === undefined) return
  const reply: RecoveredReply = {
    topic_id: entry.topic_id,
    turn_id: entry.turn_id,
    text,
  }
  if (entry.instance_slug !== undefined) reply.instance_slug = entry.instance_slug
  try {
    await sink(reply)
  } catch (err) {
    process.stderr.write(
      `[repl-redelivery] sink failed for topic=${entry.topic_id} turn=${entry.turn_id}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
}
/**
 * The POISON-TIME log line. Until 2026-09-03 the only trace of an abandon-poison
 * was the `[repl] evicting abandon-poisoned …` line at the NEXT dispatch — minutes
 * to hours later, on a different turn — which is why correlating an eviction with
 * the turn that caused it took a full investigation. Stamp who poisoned the
 * session, which turn, and when, at the moment it happens.
 */
export function logAbandonPoison(session: ReplSession, by: string, turnId: string): void {
  process.stderr.write(
    `[repl] abandon-poison session=${session.sessionId.slice(0, 8)} generation=${session.childGeneration.slice(0, 8)} by=${by} turn=${turnId} at=${new Date().toISOString()}\n`,
  )
}

/** The module-level warm-pool key for a substrate's options. The SINGLE
 *  definition of the key shape — used by the substrate itself, the supervised-
 *  options registry, and the pending-respawns drain, so none can drift. Every
 *  consumer keys on the VALUE this returns (never on a hand-built literal), so
 *  the S3 re-namespace is a change to this function's composition only, not a
 *  rewrite of any consumer (lift-not-rewrite, brief §2 / §8 #2).
 *
 *  S3 re-namespace (closes #104, makes the substrate instance-isolation-SAFE — the
 *  precondition for the persistent REPL becoming the sole substrate, now done):
 *  the conversational session identity is
 *  `(substrate_instance_id, user_id, project_id, credential_identity)`.
 *    - `substrate_instance_id` is `cc-{role}-{instance}` (OSS-split C4-a § 2.3;
 *      the `{instance}` segment is the per-instance handle value, so no
 *      legacy ownership token is emitted in the label) — it ALREADY encodes the
 *      instance boundary AND the substrate role, so the router (`cc-llm-router-*`),
 *      import (`cc-import-*`) and email (`cc-email-*`) substrates never collapse
 *      into the conversational REPL (the §2 "router exception"), and two instances
 *      never share a REPL. Keeping it IS the role+instance discriminator the brief
 *      calls for.
 *    - `user_id` + `project_id` split what used to collapse: every non-router
 *      LLM turn for one instance shared ONE REPL regardless of user/project; now a
 *      distinct (user, project) gets a distinct REPL.
 *    - `credential_identity` (the `PooledCredential.id`, NEVER the secret) folds
 *      the selected credential in (#104): a rotation re-keys to a fresh REPL
 *      under the new env, so the child serving a turn always matches the
 *      credential cooldown is attributed to.
 *    - `cwd` is DERIVED, not keyed: two turns for the same identity land on the
 *      same REPL even if a caller computed `cwd` differently.
 *
 *  Back-compat: when NONE of the conversational identity fields are threaded
 *  (legacy / platform-internal / test callers that pass only
 *  `substrate_instance_id` + `cwd`), fall back to the S1/S2 key shape so the
 *  supervision suite + S1 fixtures compose unchanged (they key on whatever this
 *  returns). Production always threads `credential_identity`, so the new shape
 *  is always taken on the live path. */
export function poolKeyFor(options: PersistentReplSubstrateOptions): string {
  if (
    options.user_id !== undefined ||
    options.project_id !== undefined ||
    options.credential_identity !== undefined
  ) {
    return [
      options.substrate_instance_id,
      options.user_id ?? '_platform',
      options.project_id ?? 'default',
      options.credential_identity ?? '_nocred',
      // Never resume an ambiguous pre-scope 'general' row as a fresh General
      // conversation. Both explicit scopes have their own collision-free key.
      ...(options.conversationProjectId === null ? ['general-conversation'] : []),
      ...(options.conversationProjectId === 'general' ? ['literal-project'] : []),
    ].join(SESSION_KEY_SEP)
  }
  return `${options.substrate_instance_id}${SESSION_KEY_SEP}${options.cwd ?? ''}`
}

/** Validate an unregistered row against the identity encoded by this module.
 * This permits crash reporting, never adoption or assignment of an owner. */
export function isUnregisteredPoolScopeConsistent(key: string, record: ReplRegistryRecord): boolean {
  const parts = key.split(SESSION_KEY_SEP)
  if (parts.length === 4) {
    // No marker alone proves which owner wrote the historical ambiguous key.
    return parts[2] !== 'general' && registryConversationScopeMatches(record, { project_id: parts[2]! })
  }
  if (parts.length === 5) {
    if (parts[4] === 'general-conversation') {
      return registryConversationScopeMatches(record, { conversationProjectId: null })
    }
    if (parts[4] === 'literal-project') {
      return parts[2] === 'general' && registryConversationScopeMatches(record, {
        project_id: 'general', conversationProjectId: 'general',
      })
    }
    return false
  }
  // Platform/older non-project keys carry no encoded conversation scope;
  // retain their existing crash-reporting behavior, without assigning one.
  return true
}

/**
 * Spawn a FRESH, never-pooled, disposable REPL for one stateless one-shot turn
 * (Argus r4 BLOCKER). The key is `poolKeyFor(options)` suffixed with a unique
 * nonce so it can NEVER collide with the warm pool or another ephemeral session
 * in `childByKey` / a death handler — and it is deliberately NOT inserted into
 * `pool`, so nothing can reuse it. Supervision is stripped (`replRegistryPath` /
 * `pendingRespawnsPath` deleted): a one-turn disposable session must never be
 * registered for watchdog respawn, `--resume`, or pending-replay. The caller
 * (`start`'s driver) terminates it via `disposeEphemeralSession` after the turn.
 *
 * Exported for the #112 invariant test; not part of the substrate's public API.
 */
export async function spawnEphemeralSession(
  options: PersistentReplSubstrateOptions,
  spec: AgentSpec,
): Promise<ReplSession> {
  // Defensive invariant (#112): the disposable one-shot path is reached ONLY
  // when `spec.session === undefined`. The `ephemeral` gate in `start()` ANDs
  // `options.ephemeral === true` with `spec.session === undefined`, so a
  // session-ful dispatch always pools (and may `--resume`) instead of landing
  // here. An ephemeral REPL must therefore never carry a resumable session id:
  // if one ever did, a future edit would have wired a session dimension into the
  // disposable path and this turn would `--resume` and replay a transcript a
  // one-shot must never share. Fail fast on the impossible input rather than
  // silently leak a shared transcript. No behaviour change today (unreachable).
  if (spec.session !== undefined) {
    throw new Error(
      'persistent-repl invariant violation (#112): ephemeral disposable session ' +
        `reached with a resumable spec.session.id (${spec.session.id}); one-shot ` +
        'REPLs are session-less by construction (see the start() ephemeral gate)',
    )
  }
  const ephemeralKey = `${poolKeyFor(options)}${SESSION_KEY_SEP}ephemeral${SESSION_KEY_SEP}${randomUUID()}`
  const ephemeralOptions: PersistentReplSubstrateOptions = { ...options }
  delete ephemeralOptions.replRegistryPath
  delete ephemeralOptions.pendingRespawnsPath
  // Route the disposable one-shot through the SAME bounded channel-wedge respawn
  // (port row #6, Codex r1 [P2]): a Stage-4 `channel-wedged` assertion would
  // otherwise throw straight to `start()` with no bounded recovery + no cap alert.
  // resume is undefined here, so each retry gets a FRESH sessionId (no transcript
  // sharing) — clean to retry on the same disposable key.
  const session = await spawnWithChannelWedgeRespawn(ephemeralKey, ephemeralOptions, spec)
  // Track for shutdown teardown — ephemeral sessions are never pooled, so the
  // pool-walk in `shutdownAllPersistentRepls` would otherwise miss them.
  ephemeralSessions.add(session)
  return session
}

export type HelperRetirement = 'absent' | 'deferred' | 'retired' | 'refused'

/**
 * #1226 SLEEP: retire an idle owner conversation and keep it RESUMABLE. The row keeps
 * its exact session identity and loses every liveness/ownership fact ({@link sleepPane}),
 * so the next spawn `--resume`s its transcript.
 *
 * A sleep is never a scheduled retirement. `stillIdle` is the caller's whole-scope awake
 * evidence, re-read SYNCHRONOUSLY after the key is fenced and immediately before the
 * child is terminated — nothing can be admitted between that read and actuation. Any
 * other outcome (a turn or spawn in flight, work that arrived, a claim that changed)
 * lifts this call's fence and schedules NOTHING: the pool's drain retry never retires a
 * conversation the sleeper did not re-verify.
 *
 * A #1226 Chat HANDOFF uses the same RE-VERIFIED mode with `keepResumableRow: false`
 * (a credential rotation deletes the row, as any retirement does) or `true` (a
 * provider switch keeps the Claude conversation resumable): its caller re-censuses the
 * scope after waiting the owner's turn out, so the pool must never retire the key on its
 * own drain retry, which would skip that re-census.
 */
export interface SleepRetirement {
  keepResumableRow: boolean
  stillIdle: () => boolean
}

/** Retire an exact, already owned pool identity. Never discovers or kills by prefix.
 * The caller stops admitting work first. Busy/spawning sessions finish normally;
 * the turn driver's finally retries once its last committed dispatch has left.
 * Transcripts are retained. An unverified survivor is an explicit refusal.
 */
export async function retirePersistentRepl(
  sessionKey: string,
  existing?: { registryPath: string; requireFreshIdle: true },
  sleep?: SleepRetirement,
): Promise<HelperRetirement> {
  if (hasUnresolvedNativeChild(supervisedBySessionKey.get(sessionKey))) return 'refused'
  // #1226 sleep never joins a retirement already in motion (a handoff, a migration):
  // that one owns the key, and a sleep may only retire what it re-verified itself.
  if (sleep !== undefined && (existing !== undefined || retiringSessionKeys.has(sessionKey))) return 'refused'
  // Registry discovery is not ownership. Legacy cleanup cannot acquire, probe,
  // adopt or close a registry-only survivor. Nor may it borrow a same-key pool
  // entry belonging to another registry. Refuse before any mutable marker.
  if (existing !== undefined && (
    !pool.has(sessionKey) ||
    supervisedBySessionKey.get(sessionKey)?.replRegistryPath !== existing.registryPath ||
    pendingSpawns.has(sessionKey) || (committedDispatches.get(sessionKey) ?? 0) > 0
  )) return 'refused'
  const alreadyRetiring = retiringSessionKeys.has(sessionKey)
  retiringSessionKeys.add(sessionKey)
  const gate = gateFor(sessionKey)
  if (!gate.claim()) {
    if ((existing !== undefined || sleep !== undefined) && !alreadyRetiring) retiringSessionKeys.delete(sessionKey)
    return 'refused'
  }
  const attempt = { beganTermination: false }
  let outcome: HelperRetirement = 'refused'
  try {
    outcome = await retireOwnedPersistentRepl(sessionKey, attempt, existing?.registryPath, sleep)
    return outcome
  } finally {
    gate.release()
    // A sleep leaves the key ADMITTING work: a completed sleep is not a completed
    // lifecycle (the next dispatch resumes the conversation), and one that did not
    // retire leaves the key exactly as it found it, with nothing scheduled. Only a
    // child whose termination began without a confirmed exit keeps the fence.
    if (sleep !== undefined && !alreadyRetiring && (outcome === 'retired' || !attempt.beganTermination)) {
      retiringSessionKeys.delete(sessionKey)
    }
    // A rejected migration is observational: keep the survivor's normal
    // admission and supervision. Never undo a prior explicit retirement.
    if (existing !== undefined && outcome === 'refused' && !alreadyRetiring && !attempt.beganTermination) {
      retiringSessionKeys.delete(sessionKey)
    }
  }
}

/** Read-only view of an exact key for a caller waiting on {@link retirePersistentRepl}
 * (#1226 Chat handoff). `absent`: no pool entry (retired or never spawned). `busy`: a
 * spawn is pending or a dispatch/turn is still committed, so the pool's own drain
 * retry owns the next step. `idle`: an entry with nothing in flight. Never mutates. */
export async function persistentReplRetirementPhase(sessionKey: string): Promise<'absent' | 'busy' | 'idle'> {
  const pending = pool.get(sessionKey)
  if (pending === undefined) return 'absent'
  if (pendingSpawns.get(sessionKey) === pending || (committedDispatches.get(sessionKey) ?? 0) > 0) return 'busy'
  let session: ReplSession
  try { session = await pending } catch { return 'absent' }
  if (pool.get(sessionKey) !== pending) return 'busy'
  return session.activeTurn !== undefined || session.turnSlotHeld > 0 ? 'busy' : 'idle'
}

/** Lift a COMPLETED retirement's admission fence so the exact key may serve a fresh
 * conversation again (#1226: a credential handoff back to a previously retired Chat
 * credential). Only when the key has no pool entry, no pending spawn and no committed
 * dispatch — a retirement still in motion keeps its fence. Returns whether the key
 * now admits work. */
export function readmitRetiredPersistentRepl(sessionKey: string): boolean {
  if (!retiringSessionKeys.has(sessionKey)) return true
  if (pool.has(sessionKey) || pendingSpawns.has(sessionKey) || (committedDispatches.get(sessionKey) ?? 0) > 0) return false
  retiringSessionKeys.delete(sessionKey)
  return true
}

async function retireOwnedPersistentRepl(
  sessionKey: string,
  attempt: { beganTermination: boolean },
  expectedRegistryPath?: string,
  sleep?: SleepRetirement,
): Promise<HelperRetirement> {
  const requireFreshIdle = expectedRegistryPath !== undefined
  const pending = pool.get(sessionKey)
  if (pending === undefined) return requireFreshIdle ? 'refused' : 'absent'
  if (pendingSpawns.get(sessionKey) === pending) {
    // A sleep schedules nothing: its caller re-reads the scope later.
    if (sleep === undefined) neutralizeAbandonedSettle(pending.then(() => retirePersistentRepl(sessionKey)))
    return 'deferred'
  }
  if ((committedDispatches.get(sessionKey) ?? 0) > 0) return requireFreshIdle ? 'refused' : 'deferred'
  let session: ReplSession
  try { session = await pending } catch { return requireFreshIdle ? 'refused' : 'absent' }
  if (pool.get(sessionKey) !== pending || childByKey.get(sessionKey) !== session.child) return 'refused'
  if ((committedDispatches.get(sessionKey) ?? 0) > 0 || session.activeTurn !== undefined || session.turnSlotHeld > 0) return requireFreshIdle ? 'refused' : 'deferred'
  // A survivor can still be doing work started before this gateway. The local
  // turn mutex cannot establish its idleness; refuse migration without a live
  // rendered empty input prompt. Silence or a missing screen is not idleness.
  if (session.adopted || requireFreshIdle) {
    if (session.child.readScreen === undefined) return 'refused'
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const screen = await Promise.race([
        session.child.readScreen(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('idle observation timed out')), 2000)
        }),
      ])
      const footer = stripAnsi(screen).trimEnd().split('\n').slice(-6)
      if (/esc\s+to\s+interrupt/i.test(footer.join(' ')) ||
          !footer.some(line => /^❯\s*$/.test(line.trim()))) return 'refused'
    } catch {
      return 'refused'
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    if (pool.get(sessionKey) !== pending || (committedDispatches.get(sessionKey) ?? 0) > 0 ||
        session.activeTurn !== undefined || session.turnSlotHeld > 0) return requireFreshIdle ? 'refused' : 'deferred'
  }
  const options = supervisedBySessionKey.get(sessionKey)
  const registryPath = options?.replRegistryPath
  // The pool promise and screen observation yielded; ownership configuration
  // may have changed since the migration's initial read-only preflight.
  if (requireFreshIdle && registryPath !== expectedRegistryPath) return 'refused'
  const claimant = session.paneClaimBy
  const matches = (row: ReplRegistryRecord | undefined): boolean => row !== undefined &&
    row.sessionId === session.sessionId && row.child_generation === session.childGeneration &&
    row.adoption_claim_by === claimant &&
    (options === undefined || registryConversationScopeMatches(row, options))
  if (registryPath !== undefined) {
    // Refresh the existing claim under the ownership lock before actuation. A
    // lock/read/write failure or changed owner prevents the kill entirely.
    const checked = withOwnedRegistry(registryPath, registry => {
      const row = registry[sessionKey]
      if (!matches(row)) return { registry, result: false, skipSave: true }
      if (claimant !== undefined) {
        const refreshed = refreshPaneClaim(row!, claimant, Date.now(), process.pid)
        if (refreshed === undefined) return { registry, result: false, skipSave: true }
        registry[sessionKey] = refreshed
      }
      return { registry, result: true }
    }, () => false)
    if (!checked.persisted || !checked.result) return 'refused'
  } else if (session.child.paneHandle !== undefined) {
    return 'refused'
  }
  // Do not discard a row or pool entry merely because termination was requested.
  // terminateChild has a bounded force deadline, so independently confirm death.
  if (hasUnresolvedNativeChild(supervisedBySessionKey.get(sessionKey))) return 'refused'
  // #1226 sleep: the scope's awake evidence, re-read with the key fenced and no await
  // between this read and the termination below. Work that arrived keeps the Chat.
  if (sleep !== undefined && !sleep.stillIdle()) return 'deferred'
  attempt.beganTermination = true
  await terminateChild(session.child)
  if (!session.hasChildExited()) return 'refused'
  if (registryPath !== undefined) {
    const removed = withOwnedRegistry(registryPath, registry => {
      const row = registry[sessionKey]
      if (row === undefined) return { registry, result: true }
      if (row.sessionId !== session.sessionId || row.child_generation !== session.childGeneration ||
          (row.adoption_claim_by !== claimant &&
            !(row.adoption_claim_by === undefined && row.pane_handle === undefined))) {
        return { registry, result: false, skipSave: true }
      }
      // #1226 sleep keeps the conversation resumable; every other retirement deletes.
      if (sleep?.keepResumableRow === true && row.has_session) registry[sessionKey] = sleepPane(row, Date.now())
      else delete registry[sessionKey]
      return { registry, result: true }
    }, () => false)
    if (!removed.persisted || !removed.result) return 'refused'
  }
  if (pool.get(sessionKey) === pending) pool.delete(sessionKey)
  if (childByKey.get(sessionKey) === session.child) childByKey.delete(sessionKey)
  supervisedBySessionKey.delete(sessionKey)
  session.sizeWatchdog?.stop()
  session.paneClaimBy = undefined
  sink.unregister(session.sessionId)
  unlinkSessionConfigs(session)
  return 'retired'
}

/**
 * Tear down a disposable one-shot REPL after its single turn settled. Terminating
 * the child is the whole point — the disposable REPL must never linger warm, so no
 * later one-shot purpose can reuse its transcript and no transcript can grow
 * unbounded. `terminateChild` is safe on an already-dead child; the spawn's own
 * exit handler clears the `childByKey` mirror once it exits, and we drop the sink
 * registration explicitly so a never-firing exit can't leak it.
 */
async function disposeEphemeralSession(session: ReplSession): Promise<void> {
  ephemeralSessions.delete(session)
  session.sizeWatchdog?.stop()
  try {
    if (!session.hasChildExited()) await terminateChild(session.child)
  } catch {
    /* already gone */
  }
  sink.unregister(session.sessionId)
  // Eager unlink so the temp configs are gone by the time dispose resolves (the
  // child-exit handler also unlinks, but that fires on its own microtask chain).
  unlinkSessionConfigs(session)
}

/**
 * Construct a persistent-REPL substrate. The session pool is module-level, so
 * per-turn `createPersistentReplSubstrate(opts).start(spec)` calls reuse the
 * same warm REPL keyed by `poolKeyFor(opts)` — S3: `(substrate_instance_id,
 * user_id, project_id, credential_identity)`.
 *
 * EXCEPTION (Argus r4 BLOCKER): when `opts.ephemeral` is set AND a dispatch
 * carries no `spec.session`, that turn runs on a fresh disposable REPL that is
 * terminated after the turn (see `spawnEphemeralSession`) — stateless one-shot
 * purposes never share a transcript. A session-ful dispatch always pools.
 */
export function createPersistentReplSubstrate(options: PersistentReplSubstrateOptions): Substrate {
  const sessionKey = poolKeyFor(options)
  const inactivityDefaultMs = options.turnTimeoutMs ?? DEFAULT_TURN_INACTIVITY_MS
  const absoluteCeilingDefaultMs =
    options.turnAbsoluteCeilingMs ?? DEFAULT_TURN_ABSOLUTE_CEILING_MS
  const idleQuietMs = options.idleQuietMs ?? DEFAULT_IDLE_QUIET_MS
  const idleMaxMs = options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS
  const keepaliveMs = options.livenessKeepaliveMs ?? REPL_LIVENESS_KEEPALIVE_MS

  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      const channel = new EventChannel()
      let cancelled = false
      let release: (() => void) | undefined
      let session: ReplSession | undefined
      // Argus r4 BLOCKER: a session-less dispatch on an ephemeral substrate runs
      // on a fresh disposable REPL (terminated after the turn), so stateless
      // one-shot purposes never collapse into one shared transcript. A dispatch
      // carrying a real `spec.session` (a multi-turn resume) always pools.
      const ephemeral = options.ephemeral === true && spec.session === undefined
      if (!ephemeral && retiringSessionKeys.has(sessionKey)) {
        throw new Error('Helper session lifecycle has completed')
      }
      // Per-turn ACTIVITY-BASED timeout budgets (additive spec overrides). The
      // inactivity window is the idle-time-since-last-PTY-byte before a turn is
      // deemed frozen; the composer raises it for a cold/onboarding turn (heavier
      // initial processing) and keeps it snappy for a warm steady-state turn. The
      // absolute ceiling is the hard backstop a live-but-livelocked child can't
      // exceed, with or without a working control. Non-positive values fall back to the construction defaults; the
      // ceiling is coerced ≥ the inactivity window (a ceiling below the idle
      // window would pre-empt the freeze detector).
      const inactivityMs =
        typeof spec.turn_timeout_ms === 'number' && spec.turn_timeout_ms > 0
          ? spec.turn_timeout_ms
          : inactivityDefaultMs
      const absoluteCeilingMs = Math.max(
        inactivityMs,
        typeof spec.turn_absolute_ceiling_ms === 'number' && spec.turn_absolute_ceiling_ms > 0
          ? spec.turn_absolute_ceiling_ms
          : absoluteCeilingDefaultMs,
      )

      // The turn-id this driver declared OUTSTANDING on the watchdog's
      // live-process view, if any. Declared OUT here so the `finally` below can
      // settle it on EVERY unwind — return, throw, cancel, or timeout. A turn
      // that ended without settling would latch `busy_since` forever and alert
      // permanently: the exact mirror image of the bug this replaces.
      let watchdogTurnId: string | undefined
      const driver = (async (): Promise<void> => {
       // COMMITTED TO THIS KEY FROM HERE, and released in the `finally` below. Between the
       // get-or-spawn and `acquireTurn()` neither `activeTurn` nor `turnSlotHeld` is set,
       // so a concurrent MCP revocation read this session as idle and killed the child
       // this dispatch was about to inject into. See {@link committedDispatches}; the
       // window is not microtask-sized, because the warm-reuse freshness check awaits the
       // owner-MCP resolver, which reads and decrypts from the database.
       //
       // Held for the whole turn rather than dropped the instant the slot is won: from
       // that point `turnSlotHeld` says the same thing, so releasing early would buy
       // nothing and add an exit path that can forget to.
       if (!ephemeral) {
         committedDispatches.set(sessionKey, (committedDispatches.get(sessionKey) ?? 0) + 1)
       }
       try {
        try {
          requireReplCwd(options.cwd)
          session = ephemeral
            ? await spawnEphemeralSession(options, spec)
            : await getOrSpawnSession(sessionKey, options, spec)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // O3 — stamp the typed class at the producer (binary-not-found /
          // channel-wedged) so the composer classifies on `code` first, and emit
          // the taxonomy-consistent recovery hint (both classes are FATAL /
          // non-retryable) so a DIRECT runtime consumer — not just the gateway
          // composer — reads the correct `retryable`. An unclassified spawn error
          // (e.g. a transient crash) keeps the default retryable:true — and that default
          // is EXPENSIVE (#539 r42): the composer maps an unstamped retryable error to
          // `mapStatusForPoolCooldown(null, true)` → a synthetic 429 → a cooldown on the
          // selected credential. A refusal that has nothing to do with the provider must
          // never take that branch, so the class is read FROM THE THROWN ERROR when the
          // producer stamped one, and only then from its prose.
          const code = classifyThrownSpawnError(err)
          const retryable = code !== undefined ? SUBSTRATE_ERROR_CODES[code].retryable : true
          channel.push({ kind: 'error', message, retryable, ...(code !== undefined ? { code } : {}) })
          channel.close()
          return
        }
        release = await session.acquireTurn()
        // The local queue can be empty after restart while durable native children
        // still own work. An ordinary turn cannot bypass their unresolved lease.
        if (hasUnresolvedNativeChildForChat(options)) {
          channel.push({ kind: 'error', message: 'persistent-repl: native child ownership remains unresolved; reconcile before an ordinary turn', retryable: false })
          channel.close()
          release()
          return
        }
        if (cancelled) {
          channel.close()
          if (release) release()
          return
        }
        await session.ready

        // PER-TURN CONTEXT RESET (import warm-session). Before serving a turn on
        // a warm REPL that has ALREADY served one this incarnation, wipe the
        // prior turn's transcript with a `/clear` slash command written straight
        // to the PTY, so each chunk analysis runs on a fresh, bounded context —
        // ONE warm process, isolated per-turn context. Skipped on the ephemeral
        // path (each ephemeral turn is already a fresh REPL) and on the first
        // turn of a fresh/resumed spawn (`turnSeq === 0` ⇒ context already empty —
        // which is NOT true of an adopted one, see `mayHoldPriorContext`).
        // `/clear` produces no correlated reply, so it is NOT an ActiveTurn — it
        // is a fire-then-wait-for-idle interstitial. Concurrency-1 on the import
        // runner guarantees no live turn races this clear on the same REPL.
        if (
          options.reset_context_per_turn === true &&
          !ephemeral &&
          // `mayHoldPriorContext`, NOT the turn counter: an ADOPTED session's counter
          // starts at 0 while its child's conversation does not (#539), and skipping
          // the reset there would run an isolated-by-contract turn on top of the
          // previous gateway's transcript.
          session.mayHoldPriorContext() &&
          !session.hasChildExited()
        ) {
          try {
            await waitForReplIdle(session, idleQuietMs, idleMaxMs)
            // TEXT, THEN AN `enter` KEY. herdr's `pane.send_text` does NOT submit —
            // a literal `\r` in the text is typed and left sitting at the prompt
            // (measured), so the old `write('/clear\r')` would have silently done
            // nothing. `write` now REFUSES a `\r` rather than no-op, and `writeKey`
            // is the submit.
            // Awaited: the catch below is the only thing that keeps a failed reset
            // from being logged as a completed one.
            await submitCommand(session.child, CONTEXT_RESET_COMMAND)
            // Force a beat so `waitForReplIdle` can't short-circuit before the
            // TUI starts reacting to the `/clear`, then wait for it to settle so
            // the subsequent inject lands on a cleared, idle REPL.
            await Bun.sleep(idleQuietMs)
            await waitForReplIdle(session, idleQuietMs, idleMaxMs)
          } catch (err) {
            // A clear failure must not strand the import: log + proceed. Worst
            // case the turn runs with the prior chunk still in context (the
            // pre-sprint warm-reuse behaviour), which the runner tolerates.
            process.stderr.write(
              `[repl] context-reset /clear failed on session=${session.sessionId.slice(0, 8)}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          }
          if (cancelled) {
            channel.close()
            session.activeTurn = undefined
            if (release) release()
            return
          }
        }

        const turn: ActiveTurn = {
          channel,
          settled: false,
          settle: () => {},
          substrateInstanceId: options.substrate_instance_id,
          sessionId: session.sessionId,
          turnId: session.nextTurnId(),
        }
        const settledP = new Promise<void>((res) => {
          turn.settle = res
        })
        session.activeTurn = turn
        // Scope the auth-failure signal to THIS turn: clear it BEFORE the inject
        // (which is when the child processes the prompt and can print an
        // invalid-credential banner) so a stale banner from a PRIOR turn can't leak
        // into this one's classification. A real auth failure THIS turn re-stamps it
        // fresh via the scanner, and the watchdog then applies the auth verdict only
        // once the turn has ALSO frozen (banner THEN silence).
        //
        // Also reset the auth-detector's edge-latch (Argus r2 MAJOR): on a WARM
        // session the prior turn's banner (or an unfenced echo of it) can still sit
        // in the detector's bottom-N window when this turn's REAL banner prints —
        // with the latch still set from before, `present` never drops, so no rising
        // edge fires and the re-stamp above never happens. Clearing the latch lets
        // the next scan re-fire and re-stamp, catching the "warm session, second
        // turn also 401" shape the feature exists for.
        session.authFailureAt = undefined
        session.authFailureMatched = undefined
        // Mark THIS turn's boundary in the ring. The auth detector matches only
        // within `ring.textSince(turnOutputMark)` (codex r3 BLOCKER fix), so a stale
        // banner ALREADY ON SCREEN when this mark was taken is excluded from the
        // current-turn window and can't re-arm the latch. Set BEFORE the inject so
        // everything the child prints in response to this turn's prompt counts.
        // The mark captures the screen as a BASELINE (§ herdr step 2b) — the ring is
        // snapshot-replace now, and a character count could not distinguish an Ink
        // repaint from real output. See `pty-ring.ts`.
        session.turnOutputMark = session.ring.mark()
        session.scanner.resetLatch(AUTH_FAILURE_DETECTOR_ID)
        // Declare this turn OUTSTANDING to the watchdog. From here until the
        // `finally` settles it, this process has work in flight and its age is
        // measured from NOW — so a turn that stops progressing is reported even
        // if the child keeps chattering, while a warm REPL between turns (the
        // resting state) is never stuck.
        watchdogTurnId = turn.turnId
        session.liveHandle?.markTurnStarted(turn.turnId)

        if (session.channelPort === undefined) {
          turn.settled = true
          // O3 — a channel that never bound is the `channel_wedged` class, which
          // is FATAL: emit the taxonomy-consistent non-retryable hint at the
          // producer (the composer already treats this as fatal).
          channel.push({
            kind: 'error',
            message: 'persistent-repl: channel not ready',
            retryable: SUBSTRATE_ERROR_CODES.channel_wedged.retryable,
            code: 'channel_wedged',
          })
          channel.close()
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // Gate the inject on the REPL being idle: injecting a channel
        // notification while claude is still booting or finishing the prior
        // turn drops the notification (the back-to-back-turn race). Wait for
        // the PTY to go quiet first.
        await waitForReplIdle(session, idleQuietMs, idleMaxMs)
        if (cancelled) {
          if (!turn.settled) {
            turn.settled = true
            channel.close()
          }
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // Inject the turn, then surface a status so the typing indicator lights.
        try {
          // Commit this turn's prompt to the REPL: from here on a `/reply` on
          // this session belongs to THIS turn. `turn.turnId` (`<incarnation>:<seq>`)
          // is injected with the prompt and echoed back on the reply so `onReply`
          // correlates it to exactly this turn — rejecting a delayed straggler
          // from a timed-out/cancelled prior turn (different seq) or a prior
          // incarnation of this resumed session (different nonce), in both the
          // pre-inject-park and inject-in-flight windows (see ActiveTurn.turnId).
          const initialDelivery = injectMessage(session, spec.prompt, turn.turnId)
          // Publish immediately, but serialize follow-ups behind the initial
          // POST. This removes the wire-observed/route-not-yet-visible race
          // without allowing a follow-up to overtake the prompt.
          turn.injectionTail = initialDelivery.catch(() => undefined)
          activeTurnRoutes.set(activeTurnRouteKey(options), { session, turn })
          await initialDelivery
          // The post-inject status carries the child GENERATION now hosting this
          // turn (the same key the completion carries). Trident's fire seam reads
          // it: a launcher turn that outlives its settle budget is parked
          // UNCONFIRMED, and this is what lets the orchestrator record which
          // child hosts that run BEFORE the turn settles — so the pool's eviction
          // guard (`hostsLiveWork`) and the crash latch can see it.
          channel.push({ kind: 'status', message: 'working', launcher_session_key: session.childGeneration })
          // Flush any spawn-time buffered notices (e.g. the resume-picker
          // recovered/lost notice, which fired before this turn existed) onto the
          // now-live channel so they reach the user (Codex P2).
          session.flushPendingNotices()
        } catch (err) {
          // (keepalive is started AFTER this try succeeds — see below)
          if (!turn.settled) {
            turn.settled = true
            const message = err instanceof Error ? err.message : String(err)
            // O3 — a classified fatal spawn/channel failure emits the taxonomy's
            // non-retryable hint; an ordinary mid-turn crash stays retryable:true. Same
            // producer-first rule as the spawn catch above.
            const code = classifyThrownSpawnError(err)
            const retryable = code !== undefined ? SUBSTRATE_ERROR_CODES[code].retryable : true
            channel.push({ kind: 'error', message, retryable, ...(code !== undefined ? { code } : {}) })
            channel.close()
          }
          // Enqueue-on-crash for the CRASH-DURING-INJECTION case (Codex P2): if the
          // REPL died while the inbound was being injected, this catch returns
          // BEFORE the `await settledP` enqueue block below — so without this the
          // dropped inbound would be lost (only a retryable error, no replay). The
          // REPL having exited (or `onDeath` having stamped `diedMidTurn`) is the
          // crash signal; a plain inject failure on a live REPL is NOT enqueued.
          //
          // EPHEMERAL EXCEPTION (Argus r5 BLOCKER): an ephemeral one-shot must NEVER
          // persist to pending-respawns or replay. The enqueue uses the POOLED
          // `options`/`sessionKey` (which still carry `pendingRespawnsPath` +
          // `delivery_topic_id` + the `cc-llm-*` pooled key registered in the
          // supervision map) — NOT the stripped ephemeral session — so a crashed
          // disposable one-shot's INTERNAL prompt would otherwise be queued, then
          // replayed by the watchdog/boot-drain and routed by `deliverRecoveredReply`
          // to `webTopicId(owner)` = the USER's chat topic: exactly the cross-purpose
          // bleed-to-user this whole fix exists to kill. A crashed ephemeral one-shot
          // just fails its internal call (the caller retries); nothing is persisted.
          if (
            !ephemeral &&
            session !== undefined &&
            (turn.diedMidTurn === true || session.hasChildExited())
          ) {
            enqueueDroppedInbound(options, sessionKey, session, spec.prompt, turn.turnId)
          }
          session.activeTurn = undefined
          if (release) release()
          return
        }

        // LIVENESS KEEPALIVE (2026-06-18 synthesis false-wedge fix). The turn has
        // injected and is now in flight. A synthesis read pass reads + thinks
        // SILENTLY (no tokens / no `send_typing`) before its first token; on a
        // loaded box that silence can exceed the consumer's idle window, which a
        // pure stream-event heartbeat reads as a wedge (the live failure: 100 % of
        // read passes false-wedged). Surface the child's LIVENESS as activity: while
        // the turn is unsettled AND the `claude` child is alive, emit a periodic
        // `status` heartbeat — the synthesis drain resets its idle timer on it, so a
        // silently-reading-but-alive pass is never falsely abandoned. The keepalive
        // self-stops the instant the turn settles, the channel closes, or the child
        // exits (a true hang then trips fast via `onDeath`'s error + the idle window
        // once keepalives cease; the deadline bounds unclassified turns). Unref'd so it can never hold the event loop open; cleared
        // deterministically once the turn settles below.
        const keepalive = setInterval(() => {
          if (turn.settled || channel.closed) return
          if (session === undefined || session.hasChildExited()) return
          // `keepalive: true` — this tick is SYNTHETIC (a timer, not evidence of
          // work). The Activity Inspector excludes it from its "last real
          // activity" clock so a livelocked-but-alive child is reported WEDGED
          // rather than working (ISSUES #386's failure mode). Consumers that only
          // care about liveness (the synthesis drain's idle timer) ignore the flag
          // and behave exactly as before.
          channel.push({ kind: 'status', message: 'working', keepalive: true })
          // P0: a wedged AskUserQuestion / arrow-menu emits NO further output, so
          // the `onData` scan never re-fires to satisfy the 2-tick stability gate.
          // Re-run the output scan on this same keepalive cadence (the wedge can
          // only happen mid-turn, which is exactly when this interval runs) so a
          // STATIC wedge is detected + recovered instead of being killed by the
          // inactivity watchdog.
          runOutputScan(session, session.child, options, Date.now())
        }, keepaliveMs)
        ;(keepalive as { unref?: () => void }).unref?.()

        // ACTIVITY-BASED TIMEOUT WATCHDOG (2026-07-01). Replaces the old fixed
        // `setTimeout(perTurnTimeoutMs)` wall clock that hard-failed a
        // slow-but-actively-working turn. Two conditions abandon the turn:
        //   1. INACTIVITY — the child produced NO PTY output for `inactivityMs`.
        //      `session.lastDataAt` advances on every PTY byte (spinner ticks,
        //      streamed tokens, tool output — see the `onData` handler), so a turn
        //      that is genuinely making progress keeps resetting this and runs as
        //      long as it needs. Only a FROZEN turn goes silent long enough to trip.
        //      (The liveness keepalive above pushes `status` events but does NOT
        //      touch `lastDataAt`, so an alive-but-frozen child — keepalive still
        //      firing — is correctly detected as frozen here.)
        //   2. ABSOLUTE CEILING — a hard upper bound so a live-but-livelocked child
        //      (emitting PTY noise, or holding an interrupt control, forever without
        //      ever settling) can't run unbounded. A working control spares gate 1
        //      only.
        // Both emit the SAME retryable `turn timeout` error the composer classifies
        // (auto-retry once → Retry affordance) and poison the warm session so the
        // next dispatch respawns a clean REPL.
        const turnStartedAt = Date.now()
        const watchdogTickMs = Math.max(50, Math.min(1_000, Math.floor(inactivityMs / 4)))
        const failFrozen = (reason: 'inactivity' | 'ceiling', observation: WorkerObservation): void => {
          if (turn.settled) return
          if (REPL_DEBUG && session !== undefined) {
            const r = session.getRecentOutput()
            process.stderr.write(
              `[repl-timeout:${reason}] PTY tail:\n${normalizePtyText(r).slice(-1200)}\n`,
            )
          }
          turn.settled = true
          // ABANDON-POISON (2026-06-18): the turn was abandoned but the REPL may
          // still be running it (a late reply will arrive after we've moved on).
          // Mark the warm session so the NEXT dispatch respawns a clean REPL rather
          // than landing on the busy/desynced one (the cascade fix).
          if (!ephemeral && session !== undefined) {
            session.poisoned = true
            logAbandonPoison(session, `turn-timeout:${reason}`, turn.turnId)
          }
          // O3 — stamp the typed class so the composer's ladder classifies on
          // `code` before its `persistent-repl: turn timeout` regex fallback.
          // THE PRODUCER LITERAL IS A GOVERNED RATCHET. `g6-error-string-conformance`
          // extracts `message: 'persistent-repl: turn timeout', retryable: true`
          // from THIS source text and fails loudly when it is reworded; rewording
          // it into a template took that pin out (shard 4, three tests) and a
          // re-pin needs the §2.4 PR-body note + sign-off. The observation is
          // disclosed on the run record by the orchestrator's own observer
          // (`observe_run_worker`), which is where #754 needs it, so the turn-level
          // wording stays put and the evidence is logged rather than spliced in.
          process.stderr.write(`[repl-timeout:${reason}] ${describeWorkerObservation(observation).slice(0, 1200)}\n`)
          channel.push({ kind: 'error', message: 'persistent-repl: turn timeout', retryable: true, code: 'turn_timeout' })
          channel.close()
          turn.settle()
        }
        // AUTH-INVALID reclassification (2026-07-24 dogfood; Argus r1 BLOCKER fix).
        // When the auth-failure output-scan signature fired DURING this turn (the
        // `claude` child printed an invalid/expired-credential banner) AND the turn
        // has since FROZEN (the inactivity or ceiling window elapsed with no further
        // PTY output — the real "banner THEN silence" shape), classify the frozen
        // turn with the DISTINCT `auth_invalid` class instead of the generic
        // freeze-timeout ("tap Retry"). This is a RECLASSIFICATION of an
        // already-frozen turn, NOT a fast-fail on mere signal presence: a healthy
        // in-flight turn whose OWN reply prose merely contains a credential-shaped
        // string keeps streaming, never freezes, and so never gets this verdict
        // (the false-abort the r1 blocker flagged). NON-retryable — retrying is
        // pointless while the token is invalid; the gateway surfaces a reconnect
        // bubble on this class. Poison the warm session like the freeze path so the
        // next dispatch respawns a clean REPL. The matched CLI line is NOT embedded
        // in the error message (it is surfaced separately via the notice) so the
        // message stays stable.
        const failAuthInvalid = (): void => {
          if (turn.settled) return
          turn.settled = true
          if (!ephemeral && session !== undefined) {
            session.poisoned = true
            logAbandonPoison(session, 'auth-invalid', turn.turnId)
          }
          channel.push({
            kind: 'error',
            message: 'persistent-repl: auth token invalid — reconnect required',
            retryable: false,
            code: 'auth_invalid',
          })
          channel.close()
          turn.settle()
        }
        let captureInFlight = false
        const watchdog = setInterval(() => {
          if (turn.settled || channel.closed || captureInFlight || session === undefined) return
          captureInFlight = true
          const observedSession = session
          // Reuse this watchdog's cadence. Await a bounded fresh observation before
          // applying timeout policy, so the answer and the decision share a sample.
          //
          // THE OBSERVER MUST NOT BE ABLE TO DISABLE THE WATCHDOG IT FEEDS. Every
          // timeout decision now sits DOWNSTREAM of this capture, so a capture that
          // REJECTS would skip the inactivity gate and the ceiling both, leaving the
          // turn with no deadline at all — this card's own failure mode, one level
          // up. A failed capture is therefore degraded to `unknown` (never working,
          // never blocked) and the policy below runs on it unchanged. The wrapper is
          // `fireAndForget`, not a bare `void`: a throw in the POLICY is logged and
          // counted rather than taking the process down with it.
          const applyTimeoutPolicy = async (): Promise<void> => {
           try {
            let observation: WorkerObservation
            try {
              observation = await observeSession(observedSession)
            } catch (err) {
              observation = unclassifiedObservation(
                `worker observation failed: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
            if (turn.settled || channel.closed || observedSession.activeTurn !== turn) return
            if (observation.state === 'blocked') {
              turn.settled = true
              if (!ephemeral) observedSession.poisoned = true
              channel.push({
                kind: 'error', code: 'channel_wedged', retryable: false,
                message: `worker blocked: ${describeWorkerObservation(observation)}`,
              })
              channel.close()
              turn.settle()
              return
            }
            // SPARES THE INACTIVITY WINDOW, NOT THE CEILING — see the same rule in
            // `trident/orchestrator.ts`. A visible interrupt control proves a turn is
            // in flight, not that it is progressing, so it must not outrank the
            // backstop that exists precisely for a child which emits forever.
            if (observation.state === 'working' && Date.now() - turnStartedAt < absoluteCeilingMs) return
            const nowMs = Date.now()
            // Auth-invalid is a RECLASSIFICATION of a frozen turn, NOT a fast-fail on
            // mere presence (Argus r1 BLOCKER). The signal is cleared at THIS turn's
            // start (before the inject) and re-stamped only if the scanner sees a
            // credential banner on this turn's output. We consult it ONLY when a
            // freeze gate below has already tripped AND the turn is CURRENTLY SILENT
            // — so a healthy turn that merely printed a credential-shaped string but
            // kept streaming (never froze) never gets the auth verdict; only the real
            // "banner THEN silence" shape does.
            const authInvalid = session !== undefined && session.authFailureAt !== undefined
            // Idle since the later of turn-start and the last PTY byte. Clamping to
            // `turnStartedAt` means a turn that begins with a stale `lastDataAt`
            // (e.g. a warm REPL quiet since its prior turn) still gets a full
            // inactivity window before it can be judged frozen. Computed up front so
            // BOTH freeze gates share the same silence measure.
            const lastActivity =
              session !== undefined ? Math.max(turnStartedAt, session.lastDataAt) : turnStartedAt
            // The DECISIVE auth guard (Argus r2 BLOCKER): the auth verdict requires
            // the real "banner THEN silence" shape — the signal latched AND the turn
            // currently silent (no PTY output for the inactivity window). A turn that
            // is STILL STREAMING when it trips the absolute ceiling is a livelock, not
            // an auth freeze; it must get the retryable ceiling-freeze, NEVER the
            // non-retryable auth verdict + reconnect bubble. (`absoluteCeilingMs` is
            // coerced ≥ `inactivityMs` at construction, so a genuine post-banner
            // freeze always trips the inactivity gate below — where `silent` is true
            // by definition — well before the ceiling; the ceiling's auth branch only
            // ever engages on the exact-equal-window edge, and only when silent.)
            const silent = nowMs - lastActivity >= inactivityMs
            if (nowMs - turnStartedAt >= absoluteCeilingMs) {
              clearInterval(watchdog)
              if (authInvalid && silent) failAuthInvalid()
              else failFrozen('ceiling', observation)
              return
            }
            if (silent) {
              clearInterval(watchdog)
              if (authInvalid) failAuthInvalid()
              else failFrozen('inactivity', observation)
            }
           } finally { captureInFlight = false }
          }
          fireAndForget('persistent-repl.turn-observation', applyTimeoutPolicy())
        }, watchdogTickMs)
        ;(watchdog as { unref?: () => void }).unref?.()

        await settledP
        clearInterval(watchdog)
        clearInterval(keepalive)
        // Enqueue-on-crash (brief § 2 row #11 / § 6 acceptance #1): if the REPL
        // process exited mid-turn, this turn's inbound was dropped (the caller
        // only saw a retryable error). Record it so the supervision layer
        // replays it after the session resumes — in-process via the next
        // watchdog tick's drain, or across a gateway restart via the boot-drain.
        // EPHEMERAL EXCEPTION (Argus r5 BLOCKER): skip for disposable one-shots —
        // see the matching guard in the inject-crash catch above for why an
        // ephemeral crash must never persist/replay to the user's chat topic.
        if (!ephemeral && turn.diedMidTurn === true && session !== undefined) {
          enqueueDroppedInbound(options, sessionKey, session, spec.prompt, turn.turnId)
        }
        if (activeTurnRoutes.get(activeTurnRouteKey(options))?.turn === turn) {
          activeTurnRoutes.delete(activeTurnRouteKey(options))
        }
        if (session.activeTurn === turn) session.activeTurn = undefined
        if (release) release()
        // A REVOKED-SURFACE SESSION IS RETIRED HERE, now that it is idle. It was BUSY when
        // the revocation landed, so `evictWarmReplsForMcpSurfaceChange` could only poison
        // it — killing it mid-turn would have stranded a turn running under a grant that
        // WAS in force. That turn has now ended, and waiting for the next dispatch to
        // respawn is not good enough: nothing reaps an idle warm session, so a child whose
        // MCP grant was withdrawn would keep its env resident for as long as the owner
        // stayed quiet. Checked AFTER `release()` so `turnSlotHeld` has already dropped.
        //
        // Ephemeral sessions are skipped — the `finally` below disposes them outright.
        if (
          !ephemeral &&
          session.retireOnIdle &&
          session.activeTurn === undefined &&
          session.turnSlotHeld === 0 &&
          childByKey.get(sessionKey) === session.child
        ) {
          await retireWarmSession(sessionKey, session)
        }
       } finally {
         // RELEASE THE COMMIT FIRST, so the key stops reading as busy before the teardown
         // below can run. Deleting at zero keeps the map the size of the in-flight set
         // rather than of every key ever dispatched; a floor at zero because several early
         // returns above unwind through here and a double decrement would read as a
         // NEGATIVE count, which `> 0` would then treat as idle.
         if (!ephemeral) {
           const outstanding = (committedDispatches.get(sessionKey) ?? 0) - 1
           if (outstanding > 0) committedDispatches.set(sessionKey, outstanding)
           else committedDispatches.delete(sessionKey)
           if (outstanding <= 0 && retiringSessionKeys.has(sessionKey)) {
             const outcome = await retirePersistentRepl(sessionKey)
             if (outcome === 'refused') {
               process.stderr.write('[repl] helper retirement refused after drain: ownership or exit not confirmed\n')
             }
           }
         }
         // LEAK PREVENTION (the crux). Settle the watchdog's outstanding-turn
         // marker on EVERY exit path — normal completion, early return, thrown
         // error, cancellation, or timeout. Turn-id-guarded inside the registry,
         // so a late settle from a superseded turn cannot clear the marker of the
         // turn that replaced it. Process DEATH is covered separately: the
         // child-exit handler in spawn.ts drops the record entirely (unregister)
         // or moves it to the crash queue (markCrashed), so a dead child leaves
         // no busy record behind either way.
         if (watchdogTurnId !== undefined) {
           session?.liveHandle?.markTurnSettled(watchdogTurnId)
         }
         // Dispose the one-shot disposable REPL once its single turn has fully
         // settled (success, error, cancel, or timeout) — it is never reused, so
         // it must not linger warm. Runs for the ephemeral path only; a pooled
         // warm session is left untouched. Fire-and-forget: nothing awaits the
         // driver, and disposal happens AFTER the channel's terminal event was
         // already delivered, so it can't truncate the caller's drain.
         if (ephemeral && session !== undefined) {
           await disposeEphemeralSession(session).catch(() => undefined)
         }
       }
      })()
      fireAndForget('pool.driver', driver)

      // The concrete handle is a SUPERSET of the locked `SessionHandle` contract:
      // it additionally exposes `isAlive()` — a child-process liveness probe the
      // synthesis drain reads (structurally, defensively) so an idle-window expiry
      // on a silently-reading-but-alive turn is treated as liveness, not a wedge
      // (2026-06-18 false-wedge fix). The locked `session-handle.ts` interface is
      // unchanged; consumers that don't know about `isAlive` are unaffected.
      const handle: SessionHandle & { isAlive(): boolean } = {
        events: channel,
        respondToTool(): Promise<void> {
          return Promise.reject(
            new Error(
              'persistent-repl: respondToTool called on tool_resolution=internal substrate (caller bug; CC resolves MCP tools server-side)',
            ),
          )
        },
        isAlive(): boolean {
          // Before the session resolves the REPL is still spawning (alive-by-
          // default); after, this reflects the real child. A child that has EXITED
          // returns false so the synthesis drain wedges fast on a true hang; a live
          // (silently reading) child returns true so the idle window doesn't fire a
          // false wedge.
          return session === undefined || !session.hasChildExited()
        },
        cancel(): Promise<void> {
          // Abort the in-flight turn; leave the REPL WARM (do not kill child).
          // Do NOT await the driver — settle the turn so its `settledP`
          // resolves and the driver releases the lock + clears the timer.
          cancelled = true
          const t = session?.activeTurn
          if (t !== undefined && t.channel === channel && !t.settled) {
            // ABANDON-POISON (2026-06-18): the caller gave up on this turn (its
            // budget elapsed — e.g. synthesis `dispatchTurn` cancels at 90s) while
            // the REPL is still running it. The runaway turn's late reply would
            // desync the dev-channel correlation for the next turn on this warm
            // session (stale-reply debt strips its turn_id → never delivers). Mark
            // the session so the next dispatch respawns a clean REPL. Skip for an
            // ephemeral one-shot (it is disposed after its single turn anyway).
            if (!ephemeral && session !== undefined) {
              session.poisoned = true
              logAbandonPoison(session, 'cancel', t.turnId)
            }
            t.settled = true
            t.settle()
            if (session !== undefined) session.activeTurn = undefined
          }
          if (!channel.closed) channel.close()
          return Promise.resolve()
        },
        tool_resolution: 'internal',
      }
      return handle
    },
  }
  return substrate
}

// D1: `activeWatchdogs` / `activeModelWatchdogs` live in `pool-state.ts`,
// imported above.

/**
 * Test/operator helper: SIGTERM every warm REPL and clear the pool.
 *
 * IN PRODUCTION THIS IS THE DEPLOY (#518). The gateway's SIGTERM handler calls it
 * (`gateway/index.ts`), so `systemctl restart` — which is what a deploy does after
 * it checks out the new vendor tree — reaches `session.child.kill()` below and
 * takes every detached trident workflow inside those children with it. Three of
 * five recorded `trident_launcher_crashes` landed 18-28 s after a vendor checkout,
 * and the 08-13 deploy rolled trident's own merge: a build that lands killed the
 * builds still running, at the rate the pipeline succeeded.
 *
 * So before each kill we say so, durably — `reportGatewayShutdownKill` writes the
 * generation-scoped marker to the REPL registry AND tells the durable crash sink
 * with `cause: 'gateway-shutdown'`. Without it the owner learned about his lost
 * build from the next boot's watchdog as `pid-dead → pooled child exited`, or from
 * the liveness probe as `inner workflow launcher crashed`: true sentences about a
 * fault that never happened.
 *
 * Reporting is NOT gated on how much live work the child hosts. `hostsLiveWork` is
 * optional and its absence means zero, so gating on it would turn an unwired
 * callback into silence — and a run the sink cannot match is a cheap no-op the
 * store's own 7-day prune clears. Surviving the restart instead of reporting it is
 * the herdr-host half (#538 moves the REPL out of this process tree; #539 gates
 * this kill and adds the adopt arm); this is the half that is true either way.
 *
 * #539 — EXCEPT THE CHILDREN THAT CAN BE FOUND AGAIN. A herdr-hosted child is a child
 * of the herdr SERVER, so it does not die with this process and the next gateway can
 * re-adopt it — but ONLY if a persisted row names its pane AND its generation.
 * `claimShutdownSurvival` (`gateway-shutdown-survival.ts`) is that check — taken under
 * the registry lock, so another incarnation cannot replace the row inside it — and it
 * runs BEFORE the marking phase below, because a child we do not kill must never be
 * recorded as killed. Everything it does not clear is killed and reported exactly as
 * described above. Read that module before widening this: the kill it gates exists
 * because of the 632-orphan / ~19 GB incident, and what replaces it is the guarantee
 * that a surviving pane is always reachable from a row the next boot reads.
 */
/**
 * The owner changed WHICH MCP SERVERS MAY RUN — retire the warm children that were
 * spawned under the old answer, now rather than eventually.
 *
 * `getOrSpawnSession`'s `freshMcpServers` guard already evicts a stale child, but it
 * only runs ON A DISPATCH. A warm REPL can sit idle for hours, so revoking a server
 * left its stdio subprocess alive that whole time — still holding the copied
 * environment it was handed, which for a server configured with a secret means that
 * secret stays resident in a process the owner has just said must not run. The durable
 * grant is revoked immediately and correctly; it is the PROCESS that lingered.
 *
 * IDLE CHILDREN DIE NOW; A BUSY ONE IS POISONED INSTEAD. Killing a child mid-turn
 * would strand the turn and desync the dev-channel correlation — the cascade the
 * abandon-poison guard exists for. So a session with an active turn is marked
 * `poisoned`, which `getOrSpawnSession` already treats like a failed freshness guard:
 * it evicts and respawns at the next dispatch boundary, resuming the transcript. The
 * in-flight turn is not made safer by killing it either — it is running under a grant
 * that WAS in force when it started.
 *
 * A COMMITTED DISPATCH COUNTS AS BUSY EVEN BEFORE IT HOLDS THE TURN SLOT, and that takes
 * two signals neither of the session fields can supply:
 *
 *   `committedDispatches` — a dispatch between `getOrSpawnSession` and `acquireTurn()`.
 *     `activeTurn` is assigned later still, and the slot is taken in the CALLER's
 *     continuation, so for that whole span a warm session reads as idle. This was the
 *     real, reproduced failure: a revocation landing in the window killed the child the
 *     dispatch was about to inject into and the turn failed with a drain error. The window
 *     is not microtask-sized — an earlier revision of this comment said it was, and was
 *     wrong. The warm-reuse branch computes the MCP freshness fingerprint by awaiting
 *     `options.resolveExtraMcpServers()`, which in the real composition reads the
 *     installed list from the database and decrypts every env value.
 *
 *   `pendingSpawns` — a spawn nobody is waiting on. The supervision crash/wedge respawn
 *     calls `getOrSpawnSession` with no dispatch behind it, so the counter above never
 *     sees it; without this the evictor would `await` the unresolved promise and block the
 *     revocation for the whole ready budget.
 *
 * Both are read SYNCHRONOUSLY in the snapshot below, and NEITHER IS AWAITED, so no branch
 * of this function can be made to wait on a spawn.
 *
 * WHAT THEY ARE ANSWERED WITH DIFFERS, AND THE DIFFERENCE WAS A HOLE. Marking both
 * `poisoned` + `retireOnIdle` and stopping there was correct for `committed` — a dispatch
 * is behind that spawn and its `finally` retires the child the moment it goes idle. It was
 * NOT correct for `spawning`, whose second population (the supervision respawn, an admin
 * respawn) has no dispatch and therefore NO TURN DRIVER TO EVER READ THOSE FLAGS: the
 * resolved child kept running under the revoked configuration, env resident, until some
 * future dispatch arrived. So the callback now DECIDES on resolution rather than merely
 * marking — it retires a session that is genuinely idle, and defers only where the
 * deferral has a receiver. The flags are still set first, so a retire that fails still
 * leaves the next dispatch refusing to reuse the child.
 *
 * WHAT REMAINS, STATED RATHER THAN IMPLIED: nothing between commit and slot, and from the
 * slot onward `turnSlotHeld` covers it. A turn already RUNNING is still deliberately not
 * killed — it is poisoned and retired the moment it ends, for the reason two paragraphs
 * up. That is a choice, not a gap.
 *
 * Instance-wide on purpose. Installed servers are instance-wide (one set serves every
 * project on this box), so a revocation invalidates every warm child, not one key's.
 * Returns the counts so the caller can log what it retired; never throws — an eviction
 * failure must not turn into a failed revocation.
 */
export async function evictWarmReplsForMcpSurfaceChange(): Promise<{
  evicted: number
  poisoned: number
}> {
  let evicted = 0
  let poisoned = 0
  // SNAPSHOT BOTH BUSY SIGNALS SYNCHRONOUSLY, in the same tick as the pool read. The loop
  // below awaits, so a lookup taken inside it would be answering about a later moment than
  // the entry it is deciding about — and for `committed` that is the whole point: the state
  // being protected is one that changes across exactly such an await.
  const entries = [...pool.entries()].map(([key, p]) => ({
    key,
    p,
    spawning: pendingSpawns.get(key) === p,
    committed: (committedDispatches.get(key) ?? 0) > 0,
  }))
  for (const { key, p, spawning, committed } of entries) {
    // A DISPATCH THAT IS COMMITTED BUT NOT YET SERVING IS BUSY, AND IS NOT AWAITED HERE.
    // Two populations reach this branch and neither can speak through the two session
    // fields below:
    //
    //   `committed` — a dispatch past `getOrSpawnSession` and short of `acquireTurn()`. The
    //     session exists and looks perfectly idle; killing its child strands the turn with
    //     a drain error. Reproduced by holding the owner-MCP resolver open, which is inside
    //     this very window on the warm-reuse path.
    //   `spawning`  — a spawn that has not resolved, so there is no session to ask at all.
    //
    // NEITHER IS AWAITED, and that is deliberate twice over: awaiting is what broke the
    // cold case (the evictor's continuation resumes several await-hops before the caller's,
    // so it read a brand-new session as idle and killed the child the dispatch was about to
    // inject into), and awaiting a cold spawn would also make a deny or an uninstall block
    // for the whole ready budget.
    //
    // So DECIDE on resolution instead: `poisoned` keeps the NEXT dispatch from reusing a
    // child spawned under a withdrawn grant, `retireOnIdle` has a waiting dispatch's own
    // completion path tear the child down the moment the queue drains, and — for a spawn
    // with NO dispatch behind it, where nothing would ever read that flag — the callback
    // retires the child itself. For an already-resolved warm session the `.then` runs on
    // the next microtask, which is early enough: the flags are read at turn boundaries,
    // never mid-turn, and the self-retire re-checks every busy signal before it fires.
    if (spawning || committed) {
      // NEUTRALIZED, NOT FIRE-AND-FORGOTTEN. The only way this derived promise rejects is
      // that the SPAWN failed, which is neither news nor this function's business: the
      // spawn's own `spawning.catch` already un-pools it and logs, so routing it through
      // `fireAndForget` would count and log an expected failure a second time. A spawn that
      // rejected has no child for anyone to retire.
      neutralizeAbandonedSettle(
        p.then(async (session) => {
          session.poisoned = true
          session.retireOnIdle = true
          // A SPAWN NOBODY IS WAITING ON HAS NO TURN DRIVER TO HONOUR `retireOnIdle`.
          //
          // The two flags above are a message to a turn's completion path, and for the
          // `committed` population that is exactly right — a dispatch is behind this
          // spawn, and its `finally` retires the child the moment it goes idle. But
          // `spawning` catches a SECOND population with no dispatch behind it at all:
          // the supervision crash/wedge respawn and an admin respawn both call
          // `getOrSpawnSession` directly, so `committedDispatches` never counted them
          // and no `finally` will ever read these flags. The freshly-resolved child
          // then survived under the REVOKED configuration — still holding the env it
          // was handed — until some future dispatch happened to arrive, which for a
          // quiet instance is unbounded. That is the same hazard as the idle-warm-child
          // case this function was written for, reached through the one door where the
          // deferral had no receiver.
          //
          // So retire it HERE when it is genuinely idle, and defer only when something
          // will actually honour the deferral. The gates are the turn-completion
          // path's own, re-read AFTER the spawn resolved rather than trusted from the
          // synchronous snapshot: a dispatch that committed while the spawn was in
          // flight is caught by the counter and left to its `finally`, and
          // `childByKey` identity keeps a respawn that already replaced this child
          // from being torn down by its predecessor's decision.
          if (
            (committedDispatches.get(key) ?? 0) === 0 &&
            session.activeTurn === undefined &&
            session.turnSlotHeld === 0 &&
            childByKey.get(key) === session.child
          ) {
            await retireWarmSession(key, session)
          }
        }),
      )
      // COUNTED AS `poisoned`, which is what was DECIDED synchronously. Whether this
      // entry ends up retired instead is only knowable after the spawn resolves, and
      // this function must not await that — see the paragraph above the branch. The
      // counts describe the decision, not the eventual disposal.
      poisoned += 1
      continue
    }
    let session: ReplSession
    try {
      session = await p
    } catch {
      // A spawn that rejected is not a child anyone has to retire; its own
      // `spawning.catch` already removes it from the pool.
      continue
    }
    // BUSY IS `session.activeTurn`, NOT AN `activeTurnRoutes` LOOKUP. Both are cleared
    // on the same completion path, one line apart, but the route delete is guarded on a
    // RECOMPUTED key (`activeTurnRoutes.get(activeTurnRouteKey(options))?.turn === turn`)
    // while the session field is plain identity. A key that does not recompute to the
    // one used at insert leaves a route entry behind for a session that is idle — and
    // reading that as "busy" would poison a child this function is supposed to evict,
    // deferring the kill to the next dispatch and doing nothing beyond the freshness
    // guard it exists to pre-empt. The first draft did read the routes; `activeTurn` is
    // the strictly safer signal, so it is the one used.
    //
    // THE DIFFERENCE IS NOT COVERED, and an earlier revision of this comment wrongly
    // said it was. Substituting the routes lookup back in leaves the whole suite —
    // including the idle-eviction test in `__tests__/owner-mcp-servers.test.ts` —
    // passing, because in every scenario exercised there the key DOES recompute and the
    // route entry is duly deleted. The `evicted=0, poisoned=1` reading that was
    // attributed to the routes lookup turned out to have a different cause entirely: an
    // evict issued on the same tick `drain` returns, when `activeTurn` has legitimately
    // not been cleared yet. That is this function answering correctly about a session
    // that is still, for one more tick, mid-turn.
    //
    // BUSY ALSO MEANS "HOLDS THE TURN SLOT". `session.activeTurn` is assigned well after
    // `acquireTurn()` returns — `await session.ready` sits between them, and on the import
    // path so does the entire `/clear` context-reset interstitial, which awaits the REPL
    // going idle. A revocation landing in that window read the session as idle and killed
    // the child a COMMITTED dispatch was about to inject into, stranding the turn: exactly
    // the outcome the paragraph above says this function refuses. `turnSlotHeld` is taken
    // the instant the slot is won, so it covers the gap.
    if (session.activeTurn !== undefined || session.turnSlotHeld > 0 || hasUnresolvedNativeChild(supervisedBySessionKey.get(key))) {
      session.poisoned = true
      // AND RETIRED THE MOMENT THE TURN ENDS, not merely at the next dispatch. `poisoned`
      // alone is a promise the NEXT dispatch will respawn cleanly — and nothing in this
      // build reaps an idle warm session, so if no next message ever arrives there is no
      // next dispatch and the child outlives the grant indefinitely, still holding the env
      // it was handed. That is the very hazard this function exists to close, merely
      // narrowed to the sessions that happened to be busy at revocation time. The turn's
      // own completion path honours this flag once the session is genuinely idle.
      session.retireOnIdle = true
      poisoned += 1
      continue
    }
    await retireWarmSession(key, session)
    evicted += 1
  }
  return { evicted, poisoned }
}

/**
 * Tear one warm session out of the pool and kill its child. Best effort; never throws.
 *
 * Extracted so {@link evictWarmReplsForMcpSurfaceChange} and the turn-completion path's
 * `retireOnIdle` check cannot drift into two different notions of "retired" — the second
 * caller exists precisely because a session that was BUSY at revocation time still has to
 * be torn down, and doing that with a copy of this teardown is how the two come to
 * disagree about, say, unregistering the reply sink.
 */
async function retireWarmSession(key: string, session: ReplSession): Promise<void> {
  if (hasUnresolvedNativeChild(supervisedBySessionKey.get(key))) return
  pool.delete(key)
  if (childByKey.get(key) === session.child) childByKey.delete(key)
  try {
    session.sizeWatchdog?.stop()
    if (!session.hasChildExited()) await terminateChild(session.child)
    sink.unregister(session.sessionId)
    unlinkSessionConfigs(session)
  } catch {
    // ignore — best effort, and the entry is already out of the pool
  }
}

/** Test/operator helper: SIGTERM every warm REPL and clear the pool. */
export async function shutdownAllPersistentRepls(
  opts: {
    pendingSpawnGraceMs?: number
    adoptionGraceMs?: number
    onAdoptionSnapshot?: () => void
  } = {},
): Promise<void> {
  // Stop the watchdog/heartbeat timers FIRST so no tick fires mid-teardown.
  for (const w of activeWatchdogs.values()) w.stop()
  activeWatchdogs.clear()
  for (const w of activeModelWatchdogs.values()) w.stop()
  activeModelWatchdogs.clear()
  // #539 — THE RECONCILIATION PASSES NEXT, AND STILL BEFORE THE POOL IS PARTITIONED.
  //
  // A pass between `host.attach` and its publish is in neither place this function
  // looks: it is not a `pool` entry yet, so the partition below cannot see it, and
  // nothing else waits for it. It would publish into a pool that had already been torn
  // down, having reinstalled `childByKey`, the sink and the watchers on the way.
  //
  // Awaiting is strictly better than ignoring: a pass that settles inside the grace
  // lands in `pool` and gets a REAL survival decision from `claimShutdownSurvival` —
  // the decision that keeps its pane alive across this restart. One that does not
  // settle is marked `shutdown`-abandoned, which means LEFT ALONE, not closed.
  //
  // AND IT HAPPENS BETWEEN TWO DRAINS OF `pool`, NOT BEFORE THE FIRST ONE. Draining is
  // the only thing in this function that is synchronous with its caller, and it has to
  // stay that way: ANY await in front of it — a bare `Promise.resolve()` is enough,
  // measured — lets a queued child-exit handler run first and empty the entry the walk
  // was about to report, which cost #518's already-dead-child cases their report. So
  // the first drain keeps its synchronous position, the passes are awaited after it,
  // and the second drain picks up exactly the sessions those passes published. The
  // property the await exists for is unchanged: a pass that settles inside the grace
  // still lands in `pool` and still gets a real `claimShutdownSurvival` decision.
  // ONE timestamp for the whole teardown: every child in this pool dies of the
  // same event, and a per-child `Date.now()` would invite a reader to treat the
  // spread as evidence of separate causes.
  const shutdownAt = Date.now()
  // The live reports owed once every child is marked and killed — delivered in a
  // bounded phase at the end, never inline. See `gateway-shutdown-kill.ts`.
  const owedReports: PendingShutdownKillReport[] = []
  // Children that have been signalled and whose exit is not yet confirmed.
  const awaitingExit: ShutdownExitWatch[] = []

  // PHASE 0 — PARTITION WITHOUT AWAITING ANYTHING.
  //
  // `pool` stores the spawn PROMISE and inserts it BEFORE it settles (`spawn.ts`), so an
  // entry can be a spawn still in flight, or one that will never finish. This walk used to
  // `await` each entry in turn, which put a wedged spawn in front of every later child's
  // MARKER AND KILL — the timing note on this function measures that at ~40 s against a
  // 30 s `TimeoutStopSec`, so the children behind it were killed by the cgroup with
  // NEITHER channel having reported. The guarantee this change exists to make ("a deploy
  // kill is always recorded") then held only until the first entry that would not settle,
  // and the launcher it lost was the one whose gateway was already in trouble.
  //
  // `Bun.peek.status` reads the settled state synchronously — the same
  // synchronous-mirror trick `supervision.ts` uses on this map — so the children that CAN
  // be reported are reported first and nothing pending is in front of them.
  const settledNow: Array<[string, ReplSession]> = []
  const stillSpawning: Array<[string, Promise<ReplSession>]> = []
  /**
   * THE FIRST CALL OF THIS MUST NOT BE PRECEDED BY ANY `await`. Read this before
   * collapsing the two calls below into one.
   *
   * Draining `pool` is the only part of `shutdownAllPersistentRepls` that runs
   * synchronously with its caller, and #518's guarantees depend on that. A queued
   * child-exit handler is sitting in the microtask queue whenever a child died just
   * before teardown; ANY yield in front of the first drain lets it run first and delete
   * the entry this walk was about to report, and the death is then attributed to
   * nothing at all.
   *
   * This is measured, not theorised: a bare `await Promise.resolve()` placed before the
   * first drain is enough to break it, and it reds three cases in
   * `poison-eviction-live-work-guard.test.ts` —
   *   - "a child that was ALREADY DEAD when teardown arrived … reports cause unknown and
   *     records it AS undetermined";
   *   - "a delivered undetermined report is not reported again … the next watchdog tick
   *     says NOTHING further";
   *   - "… THE COMPLEMENT — an UNDELIVERED unknown still leaves the edge open for retry".
   *
   * That is why #539's wait for the reconciliation passes sits BETWEEN two drains rather
   * than in front of the first one, which is where it was originally asked to go.
   */
  const drainPool = (): number => {
    let taken = 0
    for (const [key, p] of pool.entries()) {
      pool.delete(key)
      taken += 1
      const status = Bun.peek.status(p)
      if (status === 'fulfilled') {
        settledNow.push([key, Bun.peek(p) as ReplSession])
        continue
      }
      if (status === 'rejected') {
        // A spawn that failed owns no child. Attach a catch so an abandoned rejection
        // cannot surface later as an unhandled one.
        p.catch(() => undefined)
        continue
      }
      stillSpawning.push([key, p])
    }
    return taken
  }
  drainPool()

  // #539 — NOW WAIT FOR THE RECONCILIATION PASSES, AND DRAIN AGAIN. The position is
  // load-bearing in both directions: after the first drain because that one cannot be
  // preceded by a yield (see `drainPool`), and before the teardown walk because a pass
  // that settles must be torn down like any other session.
  //
  // A pass between `host.attach` and its publish is in neither place this function
  // looks: it was not a `pool` entry when the drain above ran, and nothing else waits
  // for it. Left alone it would publish into a pool already torn down, having
  // reinstalled `childByKey`, the sink and the watchers on the way.
  //
  // Awaiting is strictly better than ignoring: a pass that settles inside the grace
  // publishes, the second drain takes it, and it gets a REAL survival decision from
  // `claimShutdownSurvival` — the decision that keeps its pane alive across this
  // restart. A pass that does NOT settle is marked `shutdown`-abandoned, which means
  // left alone rather than closed, and it checks that at its attach AND at its publish,
  // so nothing lands in `pool` behind this second drain.
  await settleBootAdoptionsForShutdown(opts.adoptionGraceMs, undefined, opts.onAdoptionSnapshot)
  const lateArrivals = drainPool()
  if (lateArrivals > 0) {
    process.stderr.write(
      `[repl] gateway shutdown: ${lateArrivals} session(s) finished reconciling during the grace and are ` +
        'included in this teardown\n',
    )
  }

  // LEFT RUNNING, AND HANDED OVER — which is not the same as left alone. Shared by the
  // SETTLED teardown and the LATE-SPAWN callback (#674), so both survivors retire the same
  // way; it takes `registryPath` as an argument because the late caller runs after
  // `supervisedBySessionKey` has been cleared and must use coordinates captured before that.
  //
  // No kill and no marker, and — load-bearing — NO `unlinkSessionConfigs`: those files are
  // the live child's `--mcp-config` and `--settings`, and deleting them under a running REPL
  // would leave it wired to nothing the next gateway could rebuild.
  //
  // BUT THIS WRAPPER MUST LET GO (Argus r25). An earlier revision of this comment said "no
  // sink unregister that matters (this process is going away)", and the parenthetical was
  // doing all the work — in a module whose own sibling (`gateway/index.ts`) names "tests,
  // in-process restarts, overlapping boots" as supported. When this process does NOT go
  // away, the retired `PtyChild` keeps its poll loop running against a pane it has given up,
  // still wired to this session's detectors: the next adoption attaches a SECOND wrapper,
  // and the retired one can fire a detector actuation into a screen it no longer owns. That
  // is the stale-screen keystroke hazard, arriving from a gateway already told to stop.
  //
  // So: `detach` (stop reading, stop delivering, send nothing — and never close), stop the
  // watchers, and unregister the sink, because a retired wrapper that stays registered can
  // receive a reply meant for the incarnation that replaced it. The PANE and its process are
  // untouched, which is the whole distinction between detach and close.
  //
  // AND THE LIVE-PROCESS HANDLE (Argus r31). The three non-destructive releases in
  // `boot-adoption.ts` do it — and `unwind` deliberately does NOT, because that path CLOSES
  // the pane, so the child exits and `child-exit-wiring`'s handler unregisters for it. This
  // path is the opposite and has exactly the property that makes the leak matter: the pane is
  // left running and the wrapper is detached, so `exited` never settles and the exit handler
  // never fires. The scope that finds this is not "the cleanup paths in one file" but EVERY
  // PATH THAT STOPS OWNING A SESSION (r52: the exclusion of child exit was itself where a
  // defect hid).
  //
  // AND THE SELF-FENCE TIMER (r49) and THE ADOPTION CLAIM (r50), same rule — and the claim is
  // the one where leaving it behind would be worst: the next construction is exactly what this
  // branch keeps the pane alive FOR, and a claim left set would refuse it until the TTL elapsed.
  const releaseSurvivor = (key: string, session: ReplSession, registryPath: string | undefined, handle: string): void => {
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    session.child.detach?.()
    sink.unregisterIf(session.sessionId, session)
    session.liveHandle?.unregister()
    session.selfFenceTimer?.cancel()
    session.selfFenceTimer = undefined
    releaseAdoptionClaim(registryPath, key, session.paneClaimBy)
    session.paneClaimBy = undefined
    process.stderr.write(
      `[repl] gateway shutdown LEAVING session=${session.sessionId.slice(0, 8)} generation=${session.childGeneration.slice(0, 8)} ` +
        `alive in pane ${handle} — the registry row names it, so the next construction of this substrate re-adopts or closes it\n`,
    )
  }

  const teardown = async (key: string, session: ReplSession): Promise<void> => {
    // The report owed for THIS child, so the kill's outcome can be attached to it.
    let owedForThisChild: PendingShutdownKillReport | null = null
    try {
      session.sizeWatchdog?.stop()
      // The owning options come from `supervisedBySessionKey` — the SAME map the
      // supervision watchdog resolves a crash sink through. The production adapter
      // populates it for every REPL whose instance home resolves
      // (`adapters/claude-code/index.ts`, beside `replRegistryPath`), which is every
      // supervised REPL including the trident fire launcher. An UNREGISTERED key can
      // only be a directly-constructed substrate (tests); say so rather than killing
      // a child that hosted work and recording nothing, which is the silence this
      // whole change exists to remove.
      const owner = supervisedBySessionKey.get(key)
      // #539 — THE SURVIVAL GATE, AND IT RUNS BEFORE THE MARKING BELOW. A record
      // written here attributes a death to this shutdown, so a child this gate leaves
      // ALIVE must never reach it: "killed by the deploy" about a process that is
      // still serving turns is exactly the false sentence #518 exists to remove,
      // arriving from the other direction.
      //
      // READ AT SHUTDOWN, not remembered from spawn: the row is what the NEXT boot
      // will read, so it is the only thing that can answer whether this child is
      // findable. A respawn may have rewritten it since this session was created.
      //
      // AND READ UNDER THE REGISTRY LOCK, not with an unlocked `getRecord` snapshot.
      // The registry is shared across processes, so an unlocked read leaves this
      // decision unordered against a concurrent writer: another incarnation can replace
      // the row between the snapshot and the choice, and this loop then leaves a pane
      // alive that the only durable row no longer names. `claimShutdownSurvival` takes
      // the same flock every writer takes — see its docblock for what that does and does
      // not guarantee.
      const registryPath = owner?.replRegistryPath
      const survival = claimShutdownSurvival({
        registryPath,
        sessionKey: key,
        paneHandle: session.child.paneHandle,
        childGeneration: session.childGeneration,
      })
      if (survival.kind === 'survive') {
        releaseSurvivor(key, session, registryPath, survival.handle)
        return
      }
      process.stderr.write(
        `[repl] gateway shutdown killing session=${session.sessionId.slice(0, 8)} generation=${session.childGeneration.slice(0, 8)}: ${survival.reason}\n`,
      )
      if (owner !== undefined) {
        // PHASE 1 — MARK, synchronously. The owed live report is COLLECTED, not
        // awaited: a sink we do not own, awaited here, would sit between this child's
        // kill and every later child's marker AND kill, and the cgroup SIGKILL at
        // `TimeoutStopSec` does not wait for it. One hung sink would then cost every
        // remaining child its durable marker — this function's own purpose, defeated
        // inside this function. See the constraint at the top of
        // `gateway-shutdown-kill.ts`.
        //
        // SAMPLED BEFORE THE KILL, because `kill()` is idempotent after exit
        // (`pty-host.ts`): teardown "kills" a child that died of a real fault moments
        // earlier exactly as readily as a live one, and calling that a deploy buries a
        // fault where nobody investigates it. Only an observed-alive child is
        // attributed to this shutdown.
        const owed = recordGatewayShutdownKill(
          owner,
          key,
          session.childGeneration,
          shutdownAt,
          sampleLivenessBeforeShutdownKill(() => session.hasChildExited()),
          // The pid goes ON the durable entry so a later reader can confirm this death
          // against the process table instead of trusting the entry. Read before the
          // kill, while the handle is certainly still valid.
          readChildPid(session.child),
        )
        if (owed !== null) owedReports.push(owed)
        owedForThisChild = owed
      } else {
        process.stderr.write(
          `[repl] gateway shutdown killing generation=${session.childGeneration.slice(0, 8)} with NO registered owning substrate — nothing could be told it was a restart/deploy rather than a crash\n`,
        )
      }
      // SIGNAL ONLY — the confirmation is a SHARED pass after every child has been
      // signalled (`confirmShutdownExits`). `kill()` returns void and only REQUESTS
      // termination; a child that ignores or delays SIGTERM returns normally from it, so
      // "the signal did not throw" is the absence of one failure mode, not evidence of
      // death. Waiting per child here would also put one child's grace period in front
      // of the next child's signal, which is the phase rule this module already obeys.
      let signalDelivered = false
      try {
        session.child.kill()
        signalDelivered = true
      } catch {
        /* the signal failed; a later death is then not ours to claim */
      }
      if (owedForThisChild !== null) {
        awaitingExit.push({ report: owedForThisChild, child: session.child, signalDelivered })
      }
      sink.unregister(session.sessionId)
      unlinkSessionConfigs(session)
    } catch {
      // ignore
    }
  }

  for (const [key, session] of settledNow) await teardown(key, session)

  // PHASE 0b — and only now, the ones that had not spawned yet, on ONE shared bound.
  // A spawn that lands inside it takes ordinary teardown; one that does not gets a
  // detached survival decision when it resolves, with a fail-closed kill fallback.
  // Nothing durable is written while it remains unresolved:
  // it has no `child_generation` yet, so there is no generation to attribute anything to
  // — and a pool entry that never resolved never had a turn injected, so it hosts no
  // detached workflow. The builds at risk are behind the SETTLED entries above, which is
  // why they go first.
  if (stillSpawning.length > 0) {
    const bound = cancellableWait(opts.pendingSpawnGraceMs ?? SHUTDOWN_PENDING_SPAWN_GRACE_MS)
    try {
      await Promise.race([Promise.allSettled(stillSpawning.map(([, p]) => p)), bound.expired])
    } finally {
      bound.cancel()
    }
    for (const [key, p] of stillSpawning) {
      if (Bun.peek.status(p) === 'fulfilled') {
        await teardown(key, Bun.peek(p) as ReplSession)
        continue
      }
      if (Bun.peek.status(p) === 'rejected') {
        p.catch(() => undefined)
        continue
      }
      process.stderr.write(
        `[repl] gateway shutdown reached pool key ${key.slice(0, 24)} whose SPAWN has not settled — it has no ` +
          `generation yet; survival will be checked if it resolves after the grace\n`,
      )
      // Capture before reset clears supervision. Read the row only AFTER resolution.
      const registryPath = supervisedBySessionKey.get(key)?.replRegistryPath
      fireAndForget(
        'pool.shutdown.late-spawn-kill',
        p.then((session) => {
          const survival = claimShutdownSurvival({
            registryPath,
            sessionKey: key,
            paneHandle: session.child.paneHandle,
            childGeneration: session.childGeneration,
          })
          if (survival.kind === 'survive') {
            releaseSurvivor(key, session, registryPath, survival.handle)
            return
          }
          process.stderr.write(
            `[repl] gateway shutdown late spawn killing session=${session.sessionId.slice(0, 8)}: ${survival.reason}\n`,
          )
          try {
            session.child.kill()
          } catch {
            /* already gone */
          }
        }),
      )
    }
  }
  // Quarantined children are OUT of `pool` by construction (that is what makes
  // them quarantined), so the loop above cannot see them. At teardown the hosted
  // work they were being kept alive for is going away anyway — kill them, or the
  // process is orphaned.
  const quarantined = shutdownQuarantinedChildren(shutdownAt)
  owedReports.push(...quarantined.reports)
  awaitingExit.push(...quarantined.awaitingExit)

  // PHASE 2b — CONFIRM THE KILLS, once, with one shared budget. Only a child that is
  // actually gone is recorded as killed by this shutdown; one that outlives the
  // escalation records an undetermined disposition instead.
  await confirmShutdownExits(awaitingExit)
  // Terminate in-flight EPHEMERAL one-shots too (Argus r5 IMPORTANT): they are
  // never pooled, so the pool loop above misses them — a disposable child mid-turn
  // at shutdown would orphan its process + leak its temp configs.
  for (const session of ephemeralSessions) {
    try {
      session.sizeWatchdog?.stop()
      session.child.kill()
      sink.unregister(session.sessionId)
      unlinkSessionConfigs(session)
    } catch {
      // ignore
    }
  }
  ephemeralSessions.clear()
  // PHASE 3 — every child is now marked and killed, so the live reports can be
  // attempted with no child's fate behind them. Bounded per sink AND across the
  // phase; anything abandoned here is still attributed on the next boot from the
  // marker phase 1 wrote, which is what the marker is for.
  await deliverShutdownKillReports(owedReports)
  // The reply listener belongs to this gateway, even when its REPL panes survive.
  // Release it after the pool and reports drain so it cannot retain the process
  // or the durable port needed by the next gateway. This does not close a pane.
  sink.stop()
  // Reset supervision state so tests don't leak per-key gates across cases.
  // #539 — the boot-adoption gates go too: a resolved gate from the incarnation that
  // just shut down would release a later boot's first spawn instantly while its
  // surviving panes were still unreconciled.
  resetBootAdoption()
  respawnGates.clear()
  childByKey.clear()
  pendingChildKills.clear()
  supervisedBySessionKey.clear()
  retiringSessionKeys.clear()
  activeTurnRoutes.clear()
  wedgeAlertState.clear()
  cwdDriftRespawnState.clear()
  cwdDriftAlertState.clear()
}
