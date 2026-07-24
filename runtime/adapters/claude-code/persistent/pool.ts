// persistent-repl-substrate.ts → pool.ts
// The warm pool, the createPersistentReplSubstrate turn driver, ephemeral
// one-shots, and the dropped-inbound replay sink (D2 split).

import { getBestModel } from '../../../models.ts'
import type { SessionHandle } from '../../../session-handle.ts'
import type { AgentSpec, Substrate } from '../../../substrate.ts'
import { classifySpawnError } from './classify-spawn-error.ts'
import { SUBSTRATE_ERROR_CODES } from '../../../errors.ts'
import { EventChannel } from './event-channel.ts'
import { type PendingRespawnEntry, enqueuePendingRespawn } from './pending-respawns-queue.ts'
import { REPL_DEBUG, activeModelWatchdogs, activeWatchdogs, childByKey, cwdDriftAlertState, cwdDriftRespawnState, ephemeralSessions, pendingChildKills, pool, respawnGates, sink, supervisedBySessionKey, wedgeAlertState } from './pool-state.ts'
import { getRecord } from './repl-registry.ts'
import { randomUUID } from 'node:crypto'
import { normalizePtyText } from './pty-text.ts'
import { CONTEXT_RESET_COMMAND, DEFAULT_IDLE_MAX_MS, DEFAULT_IDLE_QUIET_MS, DEFAULT_TURN_ABSOLUTE_CEILING_MS, DEFAULT_TURN_INACTIVITY_MS, REPL_LIVENESS_KEEPALIVE_MS, SESSION_KEY_SEP, runOutputScan } from './signatures.ts'
import type { ActiveTurn, PersistentReplSubstrateOptions, RecoveredReply } from './types.ts'
import { ReplSession, terminateChild, unlinkSessionConfigs } from './repl-session.ts'
import { AUTH_FAILURE_DETECTOR_ID } from './auth-failure-signature.ts'
import { getOrSpawnSession, injectMessage, spawnWithChannelWedgeRespawn, waitForReplIdle } from './spawn.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

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
    cwd: options.cwd ?? process.cwd(),
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
    ].join(SESSION_KEY_SEP)
  }
  return `${options.substrate_instance_id}${SESSION_KEY_SEP}${options.cwd ?? process.cwd()}`
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
  const cwd = options.cwd ?? process.cwd()
  const sessionKey = poolKeyFor(options)
  const inactivityDefaultMs = options.turnTimeoutMs ?? DEFAULT_TURN_INACTIVITY_MS
  const absoluteCeilingDefaultMs =
    options.turnAbsoluteCeilingMs ?? DEFAULT_TURN_ABSOLUTE_CEILING_MS
  const idleQuietMs = options.idleQuietMs ?? DEFAULT_IDLE_QUIET_MS
  const idleMaxMs = options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS
  const keepaliveMs = options.livenessKeepaliveMs ?? REPL_LIVENESS_KEEPALIVE_MS

  return {
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
      // Per-turn ACTIVITY-BASED timeout budgets (additive spec overrides). The
      // inactivity window is the idle-time-since-last-PTY-byte before a turn is
      // deemed frozen; the composer raises it for a cold/onboarding turn (heavier
      // initial processing) and keeps it snappy for a warm steady-state turn. The
      // absolute ceiling is the hard backstop a live-but-livelocked child can't
      // exceed. Non-positive values fall back to the construction defaults; the
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
       try {
        try {
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
          // (e.g. a transient crash) keeps the default retryable:true.
          const code = classifySpawnError(message)
          const retryable = code !== undefined ? SUBSTRATE_ERROR_CODES[code].retryable : true
          channel.push({ kind: 'error', message, retryable, ...(code !== undefined ? { code } : {}) })
          channel.close()
          return
        }
        release = await session.acquireTurn()
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
        // turn of a fresh/resumed spawn (`turnSeq === 0` ⇒ context already empty).
        // `/clear` produces no correlated reply, so it is NOT an ActiveTurn — it
        // is a fire-then-wait-for-idle interstitial. Concurrency-1 on the import
        // runner guarantees no live turn races this clear on the same REPL.
        if (
          options.reset_context_per_turn === true &&
          !ephemeral &&
          session.turnsServedThisIncarnation() > 0 &&
          !session.hasChildExited()
        ) {
          try {
            await waitForReplIdle(session, idleQuietMs, idleMaxMs)
            session.child.write(`${CONTEXT_RESET_COMMAND}\r`)
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
          await injectMessage(session.channelPort, spec.prompt, turn.turnId)
          channel.push({ kind: 'status', message: 'working' })
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
            // non-retryable hint; an ordinary mid-turn crash stays retryable:true.
            const code = classifySpawnError(message)
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
        // once keepalives cease; the absolute ceiling bounds a live-but-livelocked
        // child). Unref'd so it can never hold the event loop open; cleared
        // deterministically once the turn settles below.
        const keepalive = setInterval(() => {
          if (turn.settled || channel.closed) return
          if (session === undefined || session.hasChildExited()) return
          channel.push({ kind: 'status', message: 'working' })
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
        //      (emitting PTY noise forever without ever settling) can't run unbounded.
        // Both emit the SAME retryable `turn timeout` error the composer classifies
        // (auto-retry once → Retry affordance) and poison the warm session so the
        // next dispatch respawns a clean REPL.
        const turnStartedAt = Date.now()
        const watchdogTickMs = Math.max(50, Math.min(1_000, Math.floor(inactivityMs / 4)))
        const failFrozen = (reason: 'inactivity' | 'ceiling'): void => {
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
          if (!ephemeral && session !== undefined) session.poisoned = true
          // O3 — stamp the typed class so the composer's ladder classifies on
          // `code` before its `persistent-repl: turn timeout` regex fallback.
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
          if (!ephemeral && session !== undefined) session.poisoned = true
          channel.push({
            kind: 'error',
            message: 'persistent-repl: auth token invalid — reconnect required',
            retryable: false,
            code: 'auth_invalid',
          })
          channel.close()
          turn.settle()
        }
        const watchdog = setInterval(() => {
          if (turn.settled || channel.closed) return
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
            else failFrozen('ceiling')
            return
          }
          if (silent) {
            clearInterval(watchdog)
            if (authInvalid) failAuthInvalid()
            else failFrozen('inactivity')
          }
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
        if (session.activeTurn === turn) session.activeTurn = undefined
        if (release) release()
       } finally {
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
            if (!ephemeral && session !== undefined) session.poisoned = true
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
}

// D1: `activeWatchdogs` / `activeModelWatchdogs` live in `pool-state.ts`,
// imported above.

/** Test/operator helper: SIGTERM every warm REPL and clear the pool. */
export async function shutdownAllPersistentRepls(): Promise<void> {
  // Stop the watchdog/heartbeat timers FIRST so no tick fires mid-teardown.
  for (const w of activeWatchdogs.values()) w.stop()
  activeWatchdogs.clear()
  for (const w of activeModelWatchdogs.values()) w.stop()
  activeModelWatchdogs.clear()
  for (const [key, p] of pool.entries()) {
    pool.delete(key)
    try {
      const session = await p
      session.sizeWatchdog?.stop()
      session.child.kill()
      sink.unregister(session.sessionId)
      unlinkSessionConfigs(session)
    } catch {
      // ignore
    }
  }
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
  // Reset supervision state so tests don't leak per-key gates across cases.
  respawnGates.clear()
  childByKey.clear()
  pendingChildKills.clear()
  supervisedBySessionKey.clear()
  wedgeAlertState.clear()
  cwdDriftRespawnState.clear()
  cwdDriftAlertState.clear()
}
