/**
 * boot-adoption.ts — #539: a gateway restart brings every project REPL back with its
 * conversation intact.
 *
 * WHAT CHANGED UNDERNEATH THIS. Before the herdr host a REPL was a child of the
 * gateway process: a restart killed it, and the only continuity available was
 * `--resume`ing the transcript into a NEW `claude` on the next turn. Under herdr the
 * REPL is a pane of the HERDR SERVER, so a gateway restart leaves it running — which
 * turns "kill it before it becomes an orphan" into "find it again before something
 * spawns over it".
 *
 * THE DURABILITY BOUNDARY, STATED EXACTLY, because the weaker and stronger claims are
 * easy to confuse and only one is true:
 *
 *   • A GATEWAY restart does not end these REPLs. They are not in the gateway's
 *     process tree or its cgroup. THAT is what this module recovers.
 *   • A HERDR SERVER restart DOES end them — panes are its children — and no amount
 *     of registry state changes that. What survives a herdr restart is the
 *     TRANSCRIPT, and recovery there is the pre-existing `--resume` path, not this.
 *
 * Nothing here should ever be described as making a REPL survive "a restart" without
 * saying which process restarted.
 *
 * ORDERING IS THE WHOLE DESIGN. The pass must complete before ANYTHING else can spawn
 * on a session key, because a spawn for a key whose pane is still alive puts two
 * `claude` processes on one transcript — the exact invariant the repo enforces by
 * killing the old process (`session-respawn.ts`, `spawn.ts`). So:
 *   - `beginBootAdoption` runs once per (registry path, SESSION KEY) — NOT once per
 *     registry, which is what an earlier revision of this line said and what six rounds
 *     went into removing. One registry holds a row per pool key, and reconciling one row
 *     under another row's options would scope a REPL to the wrong project; see the
 *     `passes` docblock below for the full argument. Started by the same block that arms
 *     the watchdog (`adapters/claude-code/index.ts`);
 *   - `awaitBootAdoption` gates the watchdog tick, the boot drain AND
 *     `getOrSpawnSession`. A turn that arrives during the pass WAITS FOR THE PASS TO
 *     FINISH — the evidence budget does NOT bound that wait, and an earlier revision of
 *     this line said it did. What bounds the wait is the pass itself completing: every
 *     probe it makes is bounded, and the budget only changes what the pass DECIDES once
 *     it does (a close rather than an adoption). A gate that released early would let a
 *     cold `--resume` start while the old child was still alive — two processes on one
 *     transcript, which is the thing this module exists to prevent.
 *
 * EVERY ADOPTION IS A CONJUNCTION OF THREE PROBES THAT COULD HAVE SAID NO, and none
 * of them is this module's own bookkeeping:
 *   1. the HOST says a live pane exists under the row's handle;
 *   2. the pane's FOREGROUND ARGV, as the host reports it, is a `claude` resuming
 *      THIS row's session id AND carrying THIS row's dev-channel
 *      (`orphan-adoption.ts`, `classifyPaneForAdoption`);
 *   3. the DEV-CHANNEL at the row's recorded port answers `/health` with THIS row's
 *      session id (`httpHealth`'s `expectedSessionId`, which exists precisely because
 *      a recycled port can serve a different REPL).
 * A row can therefore be `adopted` only if a live process answered for itself twice
 * over, through two different authorities. The verdict is never derived from the row
 * alone — a row is a claim, and this pass exists because claims go stale.
 *
 * AND A VERIFIED-OURS PANE IS NEVER SIMPLY LEFT. It is adopted or it is CLOSED. The
 * third option — "leave it and spawn a fresh one" — is how the 2026-06-11 orphan
 * incident (632 processes, ~19 GB) happened in its new clothes: a process nothing
 * holds a handle to and nothing will ever reap. Where the evidence does not license
 * either act (the host could not be asked, or reported no argv), the pass falls back
 * to the PID identity check this module's older half already implements
 * (`adoptOrKillOrphan`), and where THAT is inconclusive it says so loudly and leaves
 * the pane alone — an unverified pane must never be closed, because it may be the
 * owner's own work under a pane id herdr reissued.
 *
 * ───────────────────────────────────────────────────────────────────────────────────────
 * THE ORDERING INVARIANT — stated ONCE, cited by both paths (#539, Argus r47)
 * ───────────────────────────────────────────────────────────────────────────────────────
 *
 * Rounds thirty-seven to forty-seven turned "re-adopt a REPL" into a single-owner protocol
 * over a shared registry, one question at a time: verify, then claim, then keep the claim
 * meaningful, then act on losing it, then cover every owner, then be safe without observing
 * the winner, then contend rather than record — and now this, which is the one that orders
 * all of them:
 *
 *     **A PROCESS MUST HOLD ITS CLAIM (or a reservation for the key) BEFORE IT BECOMES
 *     CAPABLE OF TOUCHING THE TRANSCRIPT — not before it PUBLISHES.**
 *
 * "Capable" is the word that does the work, and it is earlier than it looks. Publishing —
 * entering the pool, becoming servable — was where the claim used to sit, and by then the
 * damage is already possible:
 *
 *   - AN ADOPTED PANE becomes capable at `beginOutput()` and the detector set: from that
 *     moment a screen can be delivered and a detector can ANSWER it, so a losing claimant
 *     could type `1`+Enter into the winner's live session. Priming does not save this — it
 *     latches signatures present on the FIRST screen, and the hazard is a fresh rising edge
 *     arriving during the race. So: attach (the pid is needed for the claim), then CLAIM,
 *     and only then enable delivery and the watchers.
 *   - A FRESH SPAWN becomes capable the instant `PtyHost.spawn` starts a
 *     `claude --resume <id>`: that process appends to the transcript through startup and
 *     readiness. Killing the loser afterwards does not unwrite what it appended, and the
 *     corruption this module exists to prevent is two processes resuming into one file, not
 *     a duplicated wrapper. A pane cannot be claimed before it exists, so the spawn path
 *     reserves the SESSION KEY under the registry lock first, and the loser never spawns.
 *
 * Both reservations are the same idiom as `respawn_in_flight_at`: a marker, a holder
 * identity, a TTL derived from the claim's own takeover window, a compare-and-set under the
 * flock, and a fail-closed refusal when the lock was not held. And both release on every
 * path that stops owning — which is the round-thirty-one table, one row wider.
 */

import { randomUUID } from 'node:crypto'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { registerLiveProcessSafe } from '@neutronai/tools/process-registry.ts'
import type { LiveProcessHandle } from '@neutronai/tools/process-registry.ts'
import { startApi5xxDeadTurnWatcher, type DeadTurnNotice } from './api5xx-dead-turn-watcher.ts'
import { wireChildExit } from './child-exit-wiring.ts'
import { configuredPtyHost } from './configured-pty-host.ts'
import {
  adoptOrKillOrphan,
  basenameOf,
  defaultListProcesses,
  identifyOrphanPid,
  scanTranscriptOwners,
  classifyPaneForAdoption,
  argvMatchesSession,
  defaultReadArgv,
  type OrphanAdoptionDeps,
  type OrphanAdoptionVerdict,
  type ProcessListing,
} from './orphan-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from './pool-state.ts'
import { hostSupportsAdoption, type AdoptableHost, type HandleInspection, type PtyChild } from './pty-host.ts'
import {
  disownPane,
  getRecord,
  handOverPane,
  loadRegistry,
  normaliseRecord,
  ownPane,
  readRegistryState,
  refreshPaneClaim,
  withOwnedRegistry,
  withRegistry,
  withRegistryRead,
  type ReplRegistryRecord,
} from './repl-registry.ts'
import { ReplSession, httpHealth, terminatePidGracefully } from './repl-session.ts'
import { replSessionConfigPaths } from './session-config-paths.ts'
import {
  ADOPTION_CLAIM_TAKEOVER_MS,
  SELF_FENCE_AFTER_MS,
  SESSION_COMPACT_IDLE_QUIESCE_MS,
  defaultIsPidAlive,
  paneClaimBlocksUs,
  spawnReservationBlocksUs,
  runOutputScan,
  surfaceSizeAlert,
} from './signatures.ts'
import { measurePostCompactSize, sessionJsonlPath, startSessionSizeWatchdog } from './session-size-watchdog.ts'
import { registerReplDetectors } from './repl-detectors.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

/**
 * HOW OLD THE EVIDENCE FOR AN ADOPTION MAY BE. Not a bound on the wait.
 *
 * SAYING WHICH QUANTITY IS BOUNDED IS THE POINT, because an earlier revision of this
 * comment claimed this number "releases the spawn gate" and it does not: every caller
 * awaits the pass to completion, deliberately. A gate that released early would let a
 * cold `--resume` start while the old child was still alive — two processes on one
 * transcript, which is the thing this whole module exists to prevent, and strictly
 * worse than a slow first turn after a restart.
 *
 * WHAT THE WAIT IS ACTUALLY BOUNDED BY is the composition of the per-step deadlines:
 * the herdr client refuses an unanswered RPC at 10 s, the pid wait is 5 s, the
 * `/health` probe 2 s. A pathological server can therefore hold a first turn for tens
 * of seconds, and that is the accepted cost.
 *
 * WHAT THIS BOUNDS is the freshness of what the decision rests on. An adoption is a
 * conjunction of observations — the pane's argv, the dev-channel's answer — and past
 * this many milliseconds those are no longer a description of now. A pass that slow
 * means herdr is badly unwell, so the safe act is the one that needs no fresh evidence:
 * the pane is CLOSED rather than adopted, and the transcript is resumed cleanly on the
 * next turn. Generous on purpose — it is a pathology detector, not a latency budget.
 */
export const BOOT_ADOPTION_BUDGET_MS = 45_000
/** Maximum time an attached pane gets to yield one readable baseline screen. */
export const BOOT_ADOPTION_BASELINE_MS = 5_000

/** The publication decision, named so the refusal remains independently testable. */
export function baselineAllowsAdoption(observed: boolean): boolean {
  return observed
}

/** What the pass decided about one registry row. */
export type RowAdoptionOutcome =
  /** Re-attached: the pane is live, verified twice over, and is back in the pool. */
  | { readonly kind: 'adopted'; readonly sessionKey: string; readonly paneHandle: string; readonly childGeneration: string }
  /** A `claude` on this row's transcript that is NOT this row's child — closed, so
   *  the transcript has exactly one owner again. */
  | { readonly kind: 'closed-foreign-owner'; readonly sessionKey: string; readonly reason: string }
  /** Verified as ours but not adoptable (no generation to restore its credential
   *  from, no dev-channel port, a `/health` that did not answer for this session, or
   *  the gate gave up waiting) — closed, which is the pre-#539 outcome: the next turn
   *  cold-resumes the transcript. */
  | { readonly kind: 'closed-unadoptable'; readonly sessionKey: string; readonly reason: string }
  /** The host positively reported the handle names nothing; the row's stale handle
   *  was cleared. */
  | { readonly kind: 'handle-cleared'; readonly sessionKey: string }
  /** The pid fallback verified and terminated the process behind an unverifiable
   *  pane. */
  | { readonly kind: 'closed-by-pid'; readonly sessionKey: string }
  /** Nothing was established, so nothing was done. The pane MAY still be alive. */
  | { readonly kind: 'undecided'; readonly sessionKey: string; readonly reason: string }
  /** There was nothing to reconcile: no row, or a row with no durable handle (the
   *  in-process host, or a build before handles existed). Not a failure. */
  | { readonly kind: 'no-handle'; readonly sessionKey: string }

/** Optional proactive-adoption constraint and injectable probe seams. */
export interface BootAdoptionDeps {
  /** Proactive boot must not authorize a child carrying a replaced credential.
   *  Empty string is meaningful (ambient auth); absent leaves turn-time reuse
   *  checks in charge. Compared against the actual row and again under its claim. */
  expectedAuthFingerprint?: string
  /** The host to ask. Defaults to `options.ptyHost ?? configuredPtyHost`. */
  host?: unknown
  /** `/health` probe. Defaults to the real one. */
  health?: (port: number, opts: { expectedSessionId?: string; timeoutMs?: number }) => Promise<boolean>
  /** Bound for proving the attached pane can actually be observed. */
  baselineMs?: number
  /** The pid-table fallback for a pane the host could not speak for. */
  orphanDeps?: (record: ReplRegistryRecord, claudeBasename: string) => OrphanAdoptionDeps
  /** The whole-machine process listing behind {@link scanTranscriptOwners}. Defaults
   *  to the real `ps`; a case injects one so "somebody else owns this transcript" is
   *  reachable without starting a second claude. */
  listProcesses?: () => ProcessListing[] | undefined
  /**
   * AN ORDERING SEAM, awaited between the row claim's compare-and-set and the publish
   * that acts on it. Defaults to nothing and exists for one case.
   *
   * The gap it opens is REAL — `claimRowOrUnwind` returns a promise and the two acts are
   * separated by a suspension point in the live path too — but in-process the CAS and the
   * publish run in a single synchronous stretch, so no concurrent pass can be scheduled
   * between them and the two-incarnation race cannot be constructed at all. The
   * alternative was to hand-write another incarnation's marker into the row, which tests
   * the REFUSAL while leaving the marker WRITE unexercised: drop the write and such a case
   * stays green, which is the shape of vacuity this suite keeps finding. Same argument as
   * {@link listProcesses} — an injection point whose purpose is to make an otherwise
   * unreachable branch reachable.
   */
  afterRowClaim?: () => Promise<void> | void
  /** The clock the row claim reads. Injected so a case can cross the takeover threshold
   *  without sleeping through it, matching `supervision.ts`'s `wopts.now`. */
  now?: () => number
  /** Is the process holding a claim still there — see {@link probeClaimantLiveness}. A case
   *  injects one because two incarnations in one test process share a pid, so the real probe
   *  can only ever answer `alive` and the takeover path would be unreachable. */
  claimantLiveness?: (pid: number) => 'alive' | 'gone' | 'unknown'
  /**
   * THIS GATEWAY'S OWN PID as the claim should record it. Defaults to `process.pid`.
   *
   * Injectable because the claim predicate has a same-process exception — a claim stamped
   * with our own pid is our own dead child's and must not refuse its replacement — and two
   * "gateways" in one test process share a pid, which would collapse every contest the suite
   * constructs. A case that models two gateways has to model two PIDS; pretending otherwise
   * is the fixture asserting something the environment makes untrue.
   */
  claimantPid?: number
  /** Diagnostics sink. Defaults to stderr. */
  log?: (msg: string) => void
  budgetMs?: number
}

/**
 * THREE REFUSALS, THREE SENTENCES — and the distinctions are the point, not the prose.
 *
 * A refused adoption can mean three different things and they are not interchangeable:
 * ANOTHER INCARNATION OWNS THIS ROW (a finding about somebody else), I COULD NOT TAKE
 * THE LOCK (the absence of a finding), and THE ROW NOW DESCRIBES A DIFFERENT CHILD (a
 * finding about the row). An earlier revision gave three branches identical text, which
 * means no case can tell which one fired: a test named for one passes when another ran
 * and reports that it proved something it did not. The same collapse this tree keeps
 * paying for, in a string.
 */
/** Another incarnation won the compare-and-set. A finding ABOUT SOMEBODY ELSE — distinct
 *  from {@link LOCK_UNACQUIRED_REASON} ("I could not find out who owns it") and from
 *  {@link ROW_MOVED_REASON} ("the row now names a different child"). */
const CLAIMED_ELSEWHERE_REASON =
  'another incarnation holds the adoption claim on this row — it got to the compare-and-set first, so this pass is not the owner and publishing would make it a second owner of one live transcript'

/** A spawn for this key is ALREADY IN FLIGHT in another gateway (r63). Distinct from
 *  {@link CLAIMED_ELSEWHERE_REASON}: nobody owns the row yet, but somebody is running
 *  `claude --resume` against this transcript right now, and adopting its pane would make two
 *  processes owners of one file. */
const RESERVED_ELSEWHERE_REASON =
  'another gateway holds a live SPAWN RESERVATION for this key and its `claude --resume` is starting now, so adopting this pane would put two processes on one transcript'

/** The claim could not be established because the lock was not held — the ABSENCE of a
 *  finding, which licenses neither publishing nor closing. */
const LOCK_UNACQUIRED_REASON =
  'the registry lock was NOT acquired for this adoption\'s row claim, so the compare-and-set was not atomic — the pane is left running and the row left alone, and the next construction of this substrate reconciles it'

/**
 * The shutdown abandonment reason, WITH THE POINT IT WAS TAKEN AT.
 *
 * One shared sentence for the disposition, so a reader can grep it, and a distinct
 * clause for WHERE — three sites, three branches, for the reason given above.
 */

const shutdownAbandonReason = (
  at: 'before the attach' | 'with the attach in flight' | 'at the row claim' | 'while awaiting the baseline',
  boundExpired = false,
): string =>
  boundExpired
    ? `the evidence bound expired AND the gateway then shut down ${at} — the SHUTDOWN is the operative cause, so the pane is left running: the row still names it and the next construction of this substrate reconciles it on fresh evidence`
    : `the gateway shut down ${at} — the pane is still running and the row still names it, so the next construction of this substrate reconciles it`

const defaultLog = (msg: string): void => {
  process.stderr.write(`[repl-adopt] ${msg}\n`)
}

/**
 * Set once something has stopped waiting for a pass — and WHY, because the two causes
 * call for opposite acts on the pane.
 *
 *   - `evidence-bound`: the pass outran {@link BOOT_ADOPTION_BUDGET_MS}, so what it
 *     established has stopped describing now. Closing needs no fresh evidence (the
 *     identity we proved is what licenses it), so a stale pass CLOSES.
 *   - `shutdown`: this gateway is going away while the pass is still running. The row
 *     names the pane and the next construction of this substrate reconciles it, so the pane is LEFT ALONE — a
 *     close here would destroy a REPL the whole feature exists to preserve, and it
 *     would do it at the one moment nobody is watching.
 *
 * One mechanism with two causes rather than two mechanisms: every site that must not
 * act past the point of no return already asks this object, and a second flag would
 * mean a site could be taught about one and not the other.
 */
interface AbandonSignal {
  abandoned: boolean
  cause: 'evidence-bound' | 'shutdown' | null
  /** The evidence timer fired, whether or not it is the operative CAUSE. Recorded
   *  separately because the two facts are independent: a pass can outrun its bound and
   *  THEN be caught by a shutdown, and a log reader needs both to understand why a pane
   *  that looked closeable was left alive. */
  boundExpired: boolean
}

/**
 * The gate, keyed BY REGISTRY AND THEN BY SESSION KEY.
 *
 * PER KEY, NOT PER REGISTRY, and that is a correctness requirement rather than a
 * granularity preference. One registry holds a row per pool key, and a pool key folds
 * the instance, user, PROJECT and credential — so two rows in one file belong to
 * substrates with different options (a different `project_id` above all). Rebuilding
 * one row's session from another row's options would put a REPL in the pool scoped to
 * the wrong project, and every tool call it made would be attributed there. Each
 * substrate therefore reconciles its OWN key, with its own options, and the rows whose
 * substrate this process has not constructed are left alone — their panes keep running
 * and their rows stay, until the next construction of that substrate reconciles them.
 *
 * NOTHING COVERS THEM IN THE MEANTIME, and an earlier revision of this docblock said the
 * opposite: that the pre-existing `#105` orphan path in the watchdog picked them up if
 * one wedged. It does not. `supervisedBySessionKey` is populated by a substrate's own
 * `registerSupervisedSubstrate` call, and on `respawn-and-alert` a key with no entry
 * answers `unregistered-skip` and is skipped (`supervision.ts`) — deliberately, so it is
 * never actuated under the tick's own options. "No registered options" is the same
 * condition as "this process never constructed that substrate", so the watchdog declines
 * exactly the rows this paragraph is about. The narrowing is still right — actuating a
 * row under another substrate's identity is the worse defect — but it is a gap, not a
 * covered case, and it must not be written as one.
 */
interface PassHandle {
  readonly expectedAuthFingerprint: string | undefined
  readonly promise: Promise<RowAdoptionOutcome>
  readonly signal: AbandonSignal
  /** Mirrored synchronously so {@link resetBootAdoption} can tell a finished pass from
   *  one still in flight WITHOUT awaiting anything — it runs on a shutdown path that
   *  must not block. */
  settled: boolean
}

const passes = new Map<string, Map<string, PassHandle>>()

/**
 * SHUTDOWN HAS BEGUN — set BEFORE the settle takes its snapshot, and never cleared in
 * production (Argus r24).
 *
 * Round nine closed "a pass already running when shutdown starts". This closes the other
 * window: a pass that starts AFTER the settle has looked. The settle snapshots the live
 * passes and returns immediately when that snapshot is empty; nothing stopped a request
 * constructing a substrate a moment later and starting a pass that blocks in `attach`,
 * which is then never marked, never abandoned, and publishes into a pool already torn
 * down. `resetBootAdoption` preserves a still-running pass rather than stopping it —
 * correct for the passes it was written for, and it is what lets this one survive to
 * publish.
 *
 * NOT CLEARED IN PRODUCTION, DELIBERATELY. A real gateway restart is a fresh process with
 * a fresh module, so the latch costs it nothing; within THIS process, shutdown is
 * one-way, and clearing it would re-open the window it exists to close. The only clear is
 * {@link resetBootAdoptionForTests}, because a suite runs many gateway lifetimes in one
 * process and would otherwise inherit a dead module from the first case that shuts down.
 * That asymmetry is the whole design: production never needs the clear, tests always do.
 */
let shutdownLatched = false

/**
 * Start this substrate's own boot reconciliation, ONCE per (registry, session key).
 *
 * Idempotent because the substrate factory runs per construction — many times per
 * gateway lifetime — while the reconciliation is a BOOT act: the second caller gets
 * the first call's promise, not a second pass racing it onto the same pane.
 */
export function beginBootAdoption(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  deps: BootAdoptionDeps = {},
): Promise<RowAdoptionOutcome> {
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) {
    // No registry ⇒ nothing was ever persisted ⇒ nothing can be found again. This is
    // also why the shutdown path refuses to let a child survive without a row: the
    // handle would have nowhere to be written and nobody to read it.
    return Promise.resolve({ kind: 'no-handle', sessionKey })
  }
  // AND THE SELF-FENCING DEADLINE IS CHECKED ON THE TURN PATH TOO (Argus r44), not only on
  // the supervision tick. The tick is what RENEWS, so a tick that has stopped renews nothing
  // — and if the deadline were only evaluated there, a gateway whose tick loop died would go
  // on serving past the moment another gateway may take the row. Evaluated here it costs one
  // timestamp comparison per turn and needs nothing but this session's own last confirmation.
  //
  // AND ONLY IF THIS KEY IS NOT ALREADY FENCED. A key fenced by the renewal path carries the
  // more specific reason (`not-ours` — we SAW the takeover), and re-fencing here would
  // overwrite it with the generic one, telling an operator less than was actually known.
  const pooledForDeadline = fencedKeys.has(sessionKey) ? undefined : pool.get(sessionKey)
  const liveForDeadline =
    pooledForDeadline === undefined ? undefined : (Bun.peek(pooledForDeadline) as ReplSession | undefined)
  if (liveForDeadline !== undefined && liveForDeadline.paneClaimBy !== undefined) {
    fenceIfPastSelfDeadline(
      sessionKey,
      liveForDeadline,
      (deps.now ?? Date.now)(),
      'no-renewal-observed-on-this-turn',
      deps.log ?? defaultLog,
    )
  }
  // FENCED: this gateway was taken off this key by another incarnation (see
  // {@link fenceLostSession}). Answered BEFORE the pass map, because a fenced key must not
  // start a fresh pass either — that pass would inspect a pane the winner is serving and
  // could adopt it a second time. `undecided` routes it through the spawn gate's existing
  // refusal, and the reason travels with it.
  const fenced = fencedKeys.get(sessionKey)
  if (fenced !== undefined) {
    return Promise.resolve({ kind: 'undecided', sessionKey, reason: fenced })
  }
  let forRegistry = passes.get(registryPath)
  if (forRegistry === undefined) {
    forRegistry = new Map()
    passes.set(registryPath, forRegistry)
  }
  const live = forRegistry.get(sessionKey)
  if (live !== undefined) {
    if (deps.expectedAuthFingerprint !== undefined &&
        live.expectedAuthFingerprint !== deps.expectedAuthFingerprint) {
      // A real turn may already own an unguarded pass. Await its gate but do
      // not relabel its result as credential-checked proactive adoption, or
      // delete/replace the pass that its own callers are still consuming.
      return live.promise.then(() => {
        const reason = 'incompatible adoption policy: the existing pass did not verify this proactive credential'
        ;(deps.log ?? defaultLog)(`key=${sessionKey.slice(0, 32)}: ${reason}`)
        return { kind: 'undecided', sessionKey, reason } as const
      })
    }
    return live.promise
  }
  // READ AND REGISTERED IN THE SAME SYNCHRONOUS STEP as the pass below — a latch checked
  // and then awaited before registering would reproduce the very race one level down.
  //
  // ALREADY-ABANDONED RATHER THAN REFUSED OUTRIGHT: the caller still gets a well-formed
  // `undecided` carrying the existing shutdown reason, and the spawn gate refuses it
  // exactly as it refuses every other abandoned pass. One disposition for "this gateway
  // is going away", rather than a second one that every consumer would have to learn.
  const signal: AbandonSignal = shutdownLatched
    ? { abandoned: true, cause: 'shutdown', boundExpired: false }
    : { abandoned: false, cause: null, boundExpired: false }
  const started = reconcileOwnRepl(options, sessionKey, deps, signal).catch((e: unknown) => {
    // A pass that THREW decided nothing, and must not be mistaken for one that found
    // nothing: `reconcileRow` converts every expected failure into a verdict, so
    // reaching here means something structural went wrong and the pane's fate is
    // genuinely unknown.
    ;(deps.log ?? defaultLog)(
      `boot adoption FAILED for key=${sessionKey.slice(0, 32)}: ${e instanceof Error ? e.message : String(e)} — ` +
        'any surviving REPL on this key is unaccounted for',
    )
    return {
      kind: 'undecided',
      sessionKey,
      reason: `the pass threw: ${e instanceof Error ? e.message : String(e)}`,
    } satisfies RowAdoptionOutcome
  })
  // THE EVIDENCE CLOCK, AND IT BOUNDS NEITHER THE WAIT NOR THE WORK.
  //
  // It does not interrupt anything and it does not release the gate — see
  // {@link BOOT_ADOPTION_BUDGET_MS}. All it does is MARK the pass, so that a verification
  // still in flight this long after it started ends in a CLOSE rather than in an adoption
  // built on observations that are no longer current. The pass runs to completion either
  // way, and every caller awaits that completion.
  //
  // The two sentences that used to sit here contradicted each other three lines apart on
  // the same variable: one said the budget bounds the WAIT and the gate stops blocking,
  // the other said it does not release the gate. The first was a survivor of the design
  // this branch corrected, and it sat ABOVE the correction, so a reader met the false one
  // first. Releasing the gate early is precisely the defect: a cold `--resume` would start
  // while the old child was still alive.
  const budgetMs = deps.budgetMs ?? BOOT_ADOPTION_BUDGET_MS
  const timer = setTimeout(() => {
    // RECORDED UNCONDITIONALLY: the bound expired, and that stays true even when the
    // shutdown got here first and owns the disposition.
    signal.boundExpired = true
    // ONE-WAY, AND NOW LOAD-BEARING. A `shutdown` cause must never be downgraded to
    // `evidence-bound`, because the two call for opposite acts on the pane: the bound
    // closes it, the shutdown leaves it. This early return is the half that protects the
    // shutdown-then-timer order; `abandonInFlightPasses` is the half that protects the
    // timer-then-shutdown order, by UPGRADING rather than skipping.
    if (signal.abandoned) {
      // SAID OUT LOUD RATHER THAN RETURNED SILENTLY. The bound really did expire, and a
      // reader looking at a pane that outlived its evidence window deserves to see why it
      // was left alive anyway — and it is the only observable this branch has.
      ;(deps.log ?? defaultLog)(
        `boot adoption for key=${sessionKey.slice(0, 32)}: the ${budgetMs}ms evidence bound expired, but this ` +
          `pass was already abandoned (${signal.cause ?? 'unknown cause'}) — the bound does not take the ` +
          'disposition back, so the pane is left as that abandonment left it',
      )
      return
    }
    signal.abandoned = true
    signal.cause = 'evidence-bound'
    ;(deps.log ?? defaultLog)(
      `boot adoption for key=${sessionKey.slice(0, 32)} has been running ${budgetMs}ms — its evidence is too old ` +
        'to adopt on. If the verification finishes now it will CLOSE the pane instead; the transcript is then ' +
        'resumed cleanly on the next turn.',
    )
  }, budgetMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  // THE STORED PROMISE IS THE ONE THAT CLEARS THE TIMER, so there is no second,
  // unobserved promise to leak or to swallow a rejection: `started` already
  // converts every failure into a verdict, and every caller awaits this.
  const handle: PassHandle = {
    promise: undefined as unknown as Promise<RowAdoptionOutcome>, signal, settled: false,
    expectedAuthFingerprint: deps.expectedAuthFingerprint,
  }
  const gated = started.then((outcome) => {
    clearTimeout(timer)
    handle.settled = true
    // AN `undecided` PASS IS NOT REMEMBERED. Every other outcome is a settled fact
    // about a pane — adopted, gone, closed — and re-running the pass would at best
    // repeat itself. `undecided` is the opposite: it says the facts could not be
    // established THEN, and the caller's response is to refuse the spawn and let the
    // next turn try again. Caching it would freeze one bad moment (a herdr blip, a
    // close that failed) into a permanent refusal for the life of the process, with
    // nothing ever re-probing.
    if (outcome.kind === 'undecided') passes.get(registryPath)?.delete(sessionKey)
    return outcome
  })
  Object.assign(handle, { promise: gated })
  forRegistry.set(sessionKey, handle)
  return gated
}

/**
 * Wait for this key's boot adoption to settle before spawning anything on it.
 *
 * Resolves IMMEDIATELY when no pass was started for it — the unsupervised and test
 * paths — so it is safe on the hot path, and it never rejects (`beginBootAdoption`
 * already turned failure into a verdict). Omit `sessionKey` to wait for every pass
 * this registry has started, which is what the watchdog does before its first tick.
 */
export async function awaitBootAdoption(
  registryPath: string | undefined,
  sessionKey?: string,
): Promise<void> {
  if (registryPath === undefined) return
  const forRegistry = passes.get(registryPath)
  if (forRegistry === undefined) return
  if (sessionKey !== undefined) {
    const one = forRegistry.get(sessionKey)
    if (one !== undefined) await one.promise
    return
  }
  await Promise.allSettled([...forRegistry.values()].map((h) => h.promise))
}

/**
 * MAY A COLD SPAWN PROCEED ON THIS KEY, given how the reconciliation ended?
 *
 * THE VERDICTS DISTINGUISH FALSE FROM UNKNOWN, AND THIS IS WHERE THAT WORK IS FINALLY
 * SPENT. An earlier revision computed the whole taxonomy and then discarded it:
 * `getOrSpawnSession` awaited the pass purely for its ORDERING and spawned regardless,
 * so `undecided` — a pane we could not prove is gone, or one whose close we KNOW
 * failed — was followed by a fresh `claude --resume` on the same transcript. Two
 * owners, produced by the module built to prevent them, because nothing read the
 * answer.
 *
 * THE RULE: a spawn is licensed only by a POSITIVE statement about the other owner —
 * it was adopted (and is therefore in the pool, so no spawn happens at all), it was
 * proven gone, or it was closed and the close was confirmed. `undecided` licenses
 * nothing, and neither does anything this function has not been taught about: the
 * switch is exhaustive on purpose, so a new outcome kind fails the typecheck here
 * rather than defaulting into permission.
 */
export function adoptionPermitsSpawn(
  outcome: RowAdoptionOutcome,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  switch (outcome.kind) {
    // Adopted: the session is in `pool`, so the caller finds it and never reaches a
    // spawn. `ok` here is a statement about the KEY, not a recommendation to spawn.
    case 'adopted':
      return { ok: true }
    // Positive absence, or a confirmed close. Nothing owns the transcript.
    case 'handle-cleared':
    case 'closed-foreign-owner':
    case 'closed-unadoptable':
    case 'closed-by-pid':
    case 'no-handle':
      return { ok: true }
    // Nothing was established. The pane MAY be alive and holding this transcript.
    case 'undecided':
      return { ok: false, reason: outcome.reason }
  }
}

/** How long a shutdown waits for reconciliation passes that are still running before it
 *  gives up on them. Short on purpose: this sits in front of the whole teardown, and a
 *  pass that is wedged on a socket must not hold the kill loop behind it. */
export const SHUTDOWN_ADOPTION_GRACE_MS = 2_000

/**
 * Stop waiting for the passes still in flight, and tell each of them WHY (#539).
 *
 * Marked `shutdown`, not `evidence-bound`: the pane is left exactly as it is. The row
 * names it, and reconciling it is the next boot's job — closing it here would destroy
 * the REPL this feature exists to preserve.
 *
 * Returns the keys it abandoned, so the caller can say which ones in its log rather
 * than reporting a count nobody can act on.
 */
function abandonInFlightPasses(): string[] {
  const abandoned: string[] = []
  for (const forRegistry of passes.values()) {
    for (const [key, handle] of forRegistry) {
      // A SETTLED PASS HAS NOTHING LEFT TO DECIDE. Everything else is upgraded.
      if (handle.settled) continue
      // ALREADY OURS — idempotent, and the only cause this must not overwrite.
      if (handle.signal.cause === 'shutdown') continue
      // AND AN `evidence-bound` PASS IS UPGRADED, NOT SKIPPED (Argus r13). Skipping it
      // left the cause at `evidence-bound`, so when the held attach finally returned the
      // pass took the `unwind` path and CLOSED the pane — in the middle of a shutdown
      // whose whole contract is that an unfinished pass is left alone.
      //
      // `unwind`'s argument for closing is that the child is verified as ours on our
      // transcript, so leaving it is how a COLD SPAWN becomes a second owner. That
      // argument does not hold here: there is no cold spawn coming, this process is
      // going away, the row still names the pane, and the next construction of this substrate visits it and
      // adopts-or-closes it on FRESH evidence. Leaving the pane is recoverable at the
      // next boot; closing it destroys the conversation the feature exists to keep. The
      // same asymmetry as the survival decision, reached from the other side.
      handle.signal.abandoned = true
      handle.signal.cause = 'shutdown'
      abandoned.push(key)
    }
  }
  return abandoned
}

/**
 * WAIT FOR THE RECONCILIATION PASSES BEFORE TEARING ANYTHING DOWN (#539, Argus r9).
 *
 * A pass that is between `host.attach` and its publish is in NEITHER of the places
 * shutdown looks: it is not a `pool` entry yet, so the partition cannot see it, and
 * nothing else waited for it. It would then publish into a pool that had already been
 * torn down, having reinstalled `childByKey`, the sink and the watchers on the way.
 *
 * AWAITING IS STRICTLY BETTER THAN IGNORING. A pass that settles inside the grace lands
 * in `pool` like any other session and gets a real survival decision from
 * `claimShutdownSurvival` — which is the decision that keeps its pane alive across the
 * restart. A pass that does not settle is abandoned, and abandonment here means LEFT
 * ALONE, not closed.
 *
 * BOUNDED, because this runs in front of the entire teardown. `TimeoutStopSec` does not
 * wait for us, and a pass wedged on a socket must not cost every other child its marker
 * and its kill.
 */
export async function settleBootAdoptionsForShutdown(
  graceMs: number = SHUTDOWN_ADOPTION_GRACE_MS,
  log: (msg: string) => void = defaultLog,
  /** Fires once the latch is set and the snapshot is taken, BEFORE the wait begins — the
   *  seam a case needs to start a pass inside the window this function opens. Production
   *  passes nothing; without it a case can only pace with a sleep, and a sleep that lands
   *  late passes for the wrong reason. */
  onSnapshotTaken?: () => void,
): Promise<void> {
  // BEFORE THE SNAPSHOT, not after. Everything begun from here on is born abandoned; the
  // snapshot below deals with what was already running.
  shutdownLatched = true
  const inFlight = [...passes.values()].flatMap((m) => [...m.values()]).filter((h) => !h.settled)
  // AFTER THE LATCH AND THE SNAPSHOT, BEFORE THE WAIT. Both facts matter to the caller
  // that uses this: the latch is what a pass begun from here on will meet, and the
  // snapshot is what this function will wait for.
  onSnapshotTaken?.()
  if (inFlight.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  await Promise.race([Promise.allSettled(inFlight.map((h) => h.promise)).then(() => undefined), expired])
  if (timer !== undefined) clearTimeout(timer)
  const abandoned = abandonInFlightPasses()
  if (abandoned.length > 0) {
    log(
      `shutdown waited ${graceMs}ms for ${abandoned.length} reconciliation pass(es) that did not settle ` +
        `(${abandoned.map((k) => k.slice(0, 32)).join(', ')}) — they are abandoned and will publish nothing. ` +
        'Their panes are LEFT RUNNING: the rows name them and the next construction of each substrate reconciles it.',
    )
  }
}

/**
 * Forget every SETTLED pass, and keep the ones still running.
 *
 * Called by `shutdownAllPersistentRepls`, which tears the module state down so a
 * later boot in the SAME process (tests, an in-process restart) reconciles again
 * instead of reading a resolved promise from the incarnation before it. A stale
 * resolved gate is the dangerous shape here: it releases instantly and says a pane
 * was dealt with by a gateway that no longer exists.
 *
 * AN IN-FLIGHT PASS IS KEPT, and that is the opposite hazard (Argus r9). Deleting its
 * entry frees its key, so a later boot in this process starts a SECOND pass against the
 * same unchanged row and attaches the same pane concurrently — two owners of one
 * transcript, produced by the reset whose job was to make the next boot safe. The
 * retained entry is already marked `shutdown`-abandoned by
 * {@link settleBootAdoptionsForShutdown}, so it publishes nothing and resolves
 * `undecided`; `undecided` refuses the spawn and is not cached, so the key frees itself
 * the moment the pass actually ends. Keeping it errs toward refusing a spawn, which is
 * the direction this module always takes.
 */
export function resetBootAdoption(): void {
  for (const [registryPath, forRegistry] of passes) {
    for (const [key, handle] of forRegistry) {
      if (handle.settled) forRegistry.delete(key)
    }
    if (forRegistry.size === 0) passes.delete(registryPath)
  }
  // AND THE FENCES, deliberately. A fence says "this GATEWAY was taken off this key"; the
  // next construction of the substrate is a new owner asking the question again, and it is
  // not entitled to inherit the answer. Keeping them would disable the key for the life of
  // the process even after a legitimate re-boot — and nothing is lost by clearing, because
  // the claim's compare-and-set refuses the new pass by itself if the winner still holds
  // the row. The fence covers the interval where this gateway would otherwise keep SERVING;
  // it is not a durable verdict about the pane.
  fencedKeys.clear()
}

/** Drop every pass, in flight or not. For test isolation ONLY — production uses
 *  {@link resetBootAdoption}, which keeps in-flight passes for the reason its docblock
 *  gives. A suite that leaks a pending pass into the next file would otherwise see a
 *  key it never created. */
export function resetBootAdoptionForTests(): void {
  passes.clear()
  fencedKeys.clear()
  // AND THE SHUTDOWN LATCH. Production never clears it — see its docblock — but a suite
  // runs many gateway lifetimes in one module, so without this the first case that shuts
  // down leaves every later case adopting nothing, silently and green.
  shutdownLatched = false
}

/**
 * Reconcile THIS substrate's own row against what is actually running (#539).
 *
 * Exported for tests and for a caller that wants the verdict rather than the gate.
 */
export async function reconcileOwnRepl(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  deps: BootAdoptionDeps = {},
  signal: AbandonSignal = { abandoned: false, cause: null, boundExpired: false },
): Promise<RowAdoptionOutcome> {
  const log = deps.log ?? defaultLog
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return { kind: 'no-handle', sessionKey }
  // A `{}` FROM A FAILED READ IS NOT A POSITIVE ABSENCE (Argus r19). `no-handle` is
  // listed by `adoptionPermitsSpawn` under "nothing owns the transcript" and licenses a
  // cold `claude --resume`. `loadRegistry` answers `{}` for a corrupt file and for a
  // non-ENOENT read failure just as it does for a genuinely absent one, so a registry
  // that merely could not be READ would authorise a second owner on a live transcript
  // without anything ever inspecting the pane.
  //
  // ENOENT STAYS A TRUE ABSENCE: a cold boot has no registry, and a missing file that
  // refused spawns would stop the system starting.
  const state = readRegistryState(registryPath)
  if (state.kind === 'loaded' && state.droppedKeys.includes(sessionKey)) {
    // THIS KEY'S ROW WAS DISCARDED AS SCHEMA-INVALID. The file read fine and the row did
    // not, so the key is missing for a reason that is not absence — and a drop on some
    // OTHER key says nothing about this one, which is why the question is asked per key.
    log(`key=${sessionKey.slice(0, 32)}: this row was DROPPED as invalid — refusing to decide`)
    return {
      kind: 'undecided',
      sessionKey,
      reason:
        'this key\'s registry ROW WAS DROPPED as schema-invalid, so what it recorded is unknown — the file ' +
        'read cleanly and the row did not, which is the absence of a finding rather than a finding of absence',
    }
  }
  if (state.kind === 'unreadable') {
    log(`key=${sessionKey.slice(0, 32)}: the registry could not be READ (${state.reason}) — refusing to decide`)
    return {
      kind: 'undecided',
      sessionKey,
      reason:
        `the registry could NOT BE READ (${state.reason}), so nothing establishes whether a REPL is already ` +
        'running on this transcript — this is the absence of a finding, not a finding of absence',
    }
  }
  const record = state.kind === 'absent' ? undefined : normaliseRecord(state.registry[sessionKey])
  if (record === undefined) return { kind: 'no-handle', sessionKey }
  if (deps.expectedAuthFingerprint !== undefined &&
      record.reuse?.auth_fingerprint !== deps.expectedAuthFingerprint) {
    log(`key=${sessionKey.slice(0, 32)}: credential-changed — proactive adoption leaves the pane and row alone`)
    return { kind: 'undecided', sessionKey, reason: 'credential-changed: spawn-time auth fingerprint is missing or no longer authorized' }
  }
  if (record.pane_handle === undefined) {
    // A Bun child has no durable handle. An overlapping restart can still leave
    // it alive: inspect the transcript owners independently of the old gateway.
    const scan = scanTranscriptOwners(
      record.sessionId,
      deps.listProcesses ?? defaultListProcesses,
      claudeBasenameFor(options),
    )
    if (scan.kind !== 'none') {
      return {
        kind: 'undecided',
        sessionKey,
        reason: 'a REPL without a pane handle may still own this transcript; stop the previous gateway and retry after its child exits',
      }
    }
    return { kind: 'no-handle', sessionKey }
  }

  const hostCandidate = deps.host ?? options.ptyHost ?? configuredPtyHost
  if (!hostSupportsAdoption(hostCandidate as never)) {
    // THE HOST CHANGED UNDER A LIVE PANE, and this is a SUPPORTED configuration change
    // rather than a corner case: the in-process PTY host is a selectable backend
    // (SPEC.md Decisions Log 2026-09-12), so "herdr → Bun with REPLs running" is
    // something an operator can do on purpose. The configured host cannot reach that
    // pane — but the pane may very well still be running under a herdr server this
    // process is not talking to, and its `claude` still owns this row's transcript.
    //
    // SO THIS IS NOT `no-handle`, AND THE DIFFERENCE IS THE WHOLE POINT. `no-handle`
    // means "nothing survived, spawning is safe"; this means "something may have
    // survived and I cannot see it". An earlier revision returned the former and
    // logged the latter — the log line was true and the verdict licensed a second
    // `claude` on a live transcript.
    //
    // The process table can still settle it, though, and that is what the pid
    // fallback is: `adoptOrKillOrphan` terminates the recorded pid ONLY if it is
    // verifiably our claude for this session, which kills the pane's process and
    // takes the pane with it. Where it can confirm, the spawn is safe again; where it
    // cannot, the row stays `undecided` and the spawn path refuses.
    log(
      `key=${sessionKey.slice(0, 32)} carries pane handle ${record.pane_handle} but the configured PTY host ` +
        'cannot adopt — falling back to the process table to establish whether that pane is still running ours',
    )
    return await pidFallback(
      sessionKey,
      record,
      claudeBasenameFor(options),
      `the configured PTY host cannot reach pane ${record.pane_handle} (the instance changed hosts)`,
      registryPath,
      deps,
      // TERMINATE IF VERIFIED. This pane can never be adopted from this configuration
      // again, and the transcript has to be usable — so a child we can positively
      // identify as ours is ended deliberately rather than left to own it forever.
      true,
    )
  }
  const outcome = await reconcileRow(
    sessionKey,
    record,
    options,
    hostCandidate as AdoptableHost,
    deps,
    signal,
  )
  log(`${outcome.kind}: key=${sessionKey.slice(0, 32)}${'reason' in outcome ? ` — ${outcome.reason}` : ''}`)
  return outcome
}

/** The CONFIGURED binary basename, resolved the way `build-repl-argv.ts` resolves it,
 *  so the identity gate recognises our own child under a `CLAUDE_BIN` override. */
function claudeBasenameFor(options: PersistentReplSubstrateOptions): string {
  return basenameOf(options.claude_bin ?? process.env['CLAUDE_BIN'] ?? 'claude')
}

/** One row. NEVER throws: a row that cannot be decided is `undecided`, which is a
 *  verdict the caller can act on, whereas a rejection would take the whole pass with
 *  it and leave every OTHER row unreconciled. */
async function reconcileRow(
  sessionKey: string,
  record: ReplRegistryRecord,
  options: PersistentReplSubstrateOptions,
  host: AdoptableHost,
  deps: BootAdoptionDeps,
  signal: AbandonSignal,
): Promise<RowAdoptionOutcome> {
  const handle = record.pane_handle
  if (handle === undefined) return { kind: 'no-handle', sessionKey }
  const registryPath = options.replRegistryPath
  const claudeBasename = claudeBasenameFor(options)
  try {
    const inspection = await host.inspectHandle(handle)
    const verdict = classifyPaneForAdoption(
      inspection,
      { sessionId: record.sessionId, channelName: record.channelName },
      claudeBasename,
    )
    switch (verdict.kind) {
      case 'gone': {
        // The handle is stale. Clear it so the next boot does not ask again — and so
        // nothing later mistakes it for evidence that a pane exists. COMPARED, not
        // assumed: this decision came from a snapshot taken before the inspection, and
        // another incarnation can have written a new pane into this row since.
        return clearHandleThenVerdict(
          registryPath,
          sessionKey,
          { handle, generation: record.child_generation },
          deps,
          { kind: 'handle-cleared', sessionKey },
        )
      }
      case 'leave-not-ours':
        return { kind: 'undecided', sessionKey, reason: verdict.reason }
      case 'close-foreign-owner': {
        const close = await closeAndClear(
          host,
          handle,
          registryPath,
          sessionKey,
          deps,
          record,
          claudeBasename,
        )
        return outcomeOfClose(close, sessionKey, 'closed-foreign-owner', verdict.reason)
      }
      case 'unverifiable':
      case 'unavailable':
        // The host is configured and may answer again in a moment, so the fallback is
        // an IDENTITY probe here and never a kill.
        return await pidFallback(
          sessionKey,
          record,
          claudeBasename,
          verdict.reason,
          registryPath,
          deps,
          false,
        )
      case 'adopt':
        return await adoptRow(sessionKey, record, handle, options, host, deps, signal)
    }
  } catch (e) {
    return {
      kind: 'undecided',
      sessionKey,
      reason: `reconciliation threw: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * The fallback when the HOST could not speak for a pane: ask the PROCESS TABLE
 * instead, through the identity check this module already had (#105).
 *
 * TWO INDEPENDENT AUTHORITIES, AND NEITHER IS TRUSTED ALONE. herdr knows which pane
 * holds which process; the kernel knows which pid runs which argv. When the first is
 * unreachable the second can still establish "this pid is our claude for this
 * session" — and `adoptOrKillOrphan` terminates ONLY on that positive match, leaving
 * anything unverified alone. When neither can establish it, the row is `undecided`
 * and the pane is left running: a pane that may be the owner's own work is never
 * closed on a guess.
 */
async function pidFallback(
  sessionKey: string,
  record: ReplRegistryRecord,
  claudeBasename: string,
  why: string,
  registryPath: string | undefined,
  deps: BootAdoptionDeps,
  /**
   * MAY THIS FALLBACK END A PROCESS IT VERIFIES AS OURS?
   *
   * ONLY WHEN THE PANE IS UNREACHABLE FOR GOOD, which today means the configured host
   * changed (#540 makes that a supported setting). There, the transcript is needed and
   * the pane can never be adopted from this configuration again, so ending it is the
   * only way forward.
   *
   * NOT when herdr merely failed to answer, and this is the whole reason the flag
   * exists. A transport blip says NOTHING about the REPL behind it — killing a healthy
   * child on one unanswered socket call destroys exactly what this feature exists to
   * preserve, and it would do so at the moment the system is already unwell. There the
   * honest outcome is `undecided`: the pane stays, the turn refuses, and the next turn
   * re-probes and adopts if herdr has come back.
   */
  mayTerminate: boolean,
): Promise<RowAdoptionOutcome> {
  const orphanDeps =
    deps.orphanDeps?.(record, claudeBasename) ??
    ({
      isPidAlive: defaultIsPidAlive,
      readArgv: defaultReadArgv,
      terminatePid: (pid: number) =>
        terminatePidGracefully(pid, () =>
          argvMatchesSession(defaultReadArgv(pid) ?? [], record.sessionId, claudeBasename),
        ),
    } satisfies OrphanAdoptionDeps)
  const log = deps.log ?? defaultLog
  // THE PAIR THIS FALLBACK DECIDED ABOUT, captured from the snapshot it was handed so
  // a clear below can compare against it. `pane_handle` is what put this row on this
  // path at all; if it is somehow absent, the compare-and-clear will simply find the
  // row moved and touch nothing.
  const decidedHandle = record.pane_handle ?? ''
  // IDENTIFY FIRST, ACT SECOND. `identifyOrphanPid` has no side effect, so the branch
  // below decides whether anything is ended — the kill is not smuggled inside the
  // question.
  const identity = identifyOrphanPid(record.pid, record.sessionId, orphanDeps, claudeBasename)
  if (identity === 'ours' && !mayTerminate) {
    // ALIVE, AND VERIFIABLY THE CHILD THIS ROW DESCRIBES. The most informative answer
    // there is — and the one that must NOT lead to a kill here: the pane is reachable
    // in principle and only the host's answer went missing. Leave it running, refuse
    // the spawn, and let the next turn adopt it.
    return {
      kind: 'undecided',
      sessionKey,
      reason: `${why}; the process table confirms the recorded child is STILL RUNNING and still ours, so it is left alone and nothing may resume its transcript until it can be adopted or ended deliberately`,
    }
  }
  // THE KILL PATH RE-ESTABLISHES IDENTITY ITSELF, and that second look is deliberate
  // rather than a leftover: this one is a read, the kill is an act, and between them
  // the pid can die and be reissued. If the second read disagrees, `adoptOrKillOrphan`
  // declines and we land on `not-ours` — the conservative direction — instead of
  // SIGTERMing whatever now holds the number. The cost is one extra `ps`.
  const verdict: OrphanAdoptionVerdict =
    identity === 'ours'
      ? await adoptOrKillOrphan(record.pid, record.sessionId, orphanDeps, claudeBasename)
      : identity
  // FOUR VERDICTS, THREE MEANINGS, and getting that mapping right is the whole value of
  // the fallback. An earlier revision folded everything that was not `killed` into
  // `undecided`, which reads "I could not tell" onto two answers that are positive
  // statements — and then refuses a spawn that is perfectly safe, forever, because
  // nothing about a dead pid is going to change.
  switch (verdict) {
    case 'killed':
      // We ended it. Nothing of ours runs under that handle now.
      return clearHandleThenVerdict(
        registryPath,
        sessionKey,
        { handle: decidedHandle, generation: record.child_generation },
        deps,
        { kind: 'closed-by-pid', sessionKey },
      )
    case 'dead':
    case 'not-ours': {
      // THE RECORDED CHILD IS GONE — AND THAT IS NOT THE QUESTION.
      //
      // An earlier revision stopped here and called it a positive absence: the pid and
      // the handle are written by one spawn, so a dead pid means a stale handle. Sound
      // for a pane nothing else touched, and WRONG for the case this item's own spec
      // raises — a pane relaunched under a NEW pid (herdr's native restore does exactly
      // that) leaves the recorded pid genuinely dead while a live process owns the
      // transcript. Clearing the handle there authorises a second `claude --resume`.
      //
      // The config that makes that rare is in ANOTHER PROGRAM'S FILE, so it cannot be
      // the guard. The question a spawn actually needs is about the TRANSCRIPT, so ask
      // that: is ANY live process a `claude` on this session? Only a scan that RAN and
      // found nobody is a positive absence.
      const scan = scanTranscriptOwners(
        record.sessionId,
        deps.listProcesses ?? defaultListProcesses,
        claudeBasename,
      )
      if (scan.kind === 'none') {
        log(
          `key=${sessionKey.slice(0, 32)}: ${why}; the recorded pid is '${verdict}' AND no live process is a ` +
            `claude on session ${record.sessionId.slice(0, 8)}, so the transcript has no owner and the handle is stale`,
        )
        return clearHandleThenVerdict(
          registryPath,
          sessionKey,
          { handle: decidedHandle, generation: record.child_generation },
          deps,
          { kind: 'handle-cleared', sessionKey },
        )
      }
      if (scan.kind === 'owners') {
        return {
          kind: 'undecided',
          sessionKey,
          reason:
            `${why}; the recorded pid is '${verdict}' but pid(s) ${scan.pids.join(', ')} are running a claude on ` +
            `session ${record.sessionId.slice(0, 8)} — the transcript HAS an owner this row does not name, and ` +
            'resuming it would make a second one',
        }
      }
      return {
        kind: 'undecided',
        sessionKey,
        reason: `${why}; the recorded pid is '${verdict}' and the transcript-owner scan could not run (${scan.reason}), so nothing is established about who holds it`,
      }
    }
    case 'unreadable':
      // ALIVE AND UNREADABLE. The pid exists and the kernel would not tell us whose it
      // is, which is the absence of a finding rather than a finding of absence — the
      // one distinction `orphan-adoption.ts` grew a verdict for. Our child may be that
      // process, holding this transcript.
      return {
        kind: 'undecided',
        sessionKey,
        reason: `${why}; and the recorded pid is alive but its command line could not be read, so whether it is ours is unknown`,
      }
    case 'no-pid':
      // NOTHING TO ASK. No pid on the row, and a host that cannot speak for the handle:
      // there is no instrument left, so nothing is established and nothing may be done
      // on the strength of it.
      return {
        kind: 'undecided',
        sessionKey,
        reason: `${why}; and the row carries no pid, so the process table cannot be asked either`,
      }
  }
}

/** Close a pane and drop the row's handle. Returns whether the close SUCCEEDED —
 *  a close that failed closed nothing, and reporting it as done would leave a live
 *  process recorded as reaped. */
async function closeAndClear(
  host: AdoptableHost,
  handle: string,
  registryPath: string | undefined,
  sessionKey: string,
  deps: BootAdoptionDeps,
  /** The row, so identity can be RE-ESTABLISHED at the moment of the close. */
  record: ReplRegistryRecord,
  claudeBasename: string,
): Promise<CloseOutcome> {
  const log = deps.log ?? defaultLog
  // RE-CHECK AT THE MOMENT OF THE ACT, because everything between the first inspection
  // and this line is time the pane can use to stop existing. The `/health` probe alone
  // is a round trip; a stale-evidence close is further still. If the pane exits in that
  // window and the server reissues the id, `closeHandle` would destroy a pane belonging
  // to somebody else — against this module's own rule that an unverified pane is never
  // closed, and reachable only because the FIRST look was the only look.
  //
  // A CHECK IS NOT A LOCK, and this does not pretend otherwise: the window shrinks to
  // the gap between this reply and the close, and cannot be closed entirely without an
  // atomic compare-and-close the API does not offer. What it removes is the wide,
  // predictable window — the one a health probe and a 45-second evidence bound open.
  let recheck: HandleInspection
  try {
    recheck = await host.inspectHandle(handle)
  } catch (e) {
    log(`pane ${handle}: the pre-close re-check THREW (${errorText(e)}) — not closing on unverified evidence`)
    return { kind: 'unverified', reason: 'the pre-close identity re-check could not be made' }
  }
  if (recheck.kind === 'gone') {
    // It closed itself between the two looks. The post-condition the caller wanted
    // already holds, and the handle is stale — unless the ROW has moved, in which case
    // the handle on disk is somebody else's and this pass has nothing to say.
    if (registryPath === undefined) return { kind: 'closed' }
    return closeOutcomeOfClear(
      clearPaneHandleIfUnchanged(
        registryPath,
        sessionKey,
        { handle, generation: record.child_generation },
        deps,
      ),
    )
  }
  if (recheck.kind === 'unavailable') {
    log(`pane ${handle}: the pre-close re-check could not be made (${recheck.reason}) — not closing`)
    return { kind: 'unverified', reason: `the pre-close identity re-check failed: ${recheck.reason}` }
  }
  const still = classifyPaneForAdoption(
    recheck,
    { sessionId: record.sessionId, channelName: record.channelName },
    claudeBasename,
  )
  // ONLY A PANE THAT IS STILL A CLAUDE ON THIS TRANSCRIPT MAY BE CLOSED. `adopt` (our
  // own child) and `close-foreign-owner` (a claude on our transcript that is not our
  // child) are the two shapes that license it; anything else — a stranger's pane under
  // a reissued id, or a pane nothing can identify — is left alone.
  if (still.kind !== 'adopt' && still.kind !== 'close-foreign-owner') {
    log(
      `pane ${handle}: identity CHANGED between the inspection and the close (now '${still.kind}') — leaving it alone`,
    )
    return {
      kind: 'unverified',
      reason: `the pane no longer identifies as this row's transcript at close time (${still.kind})`,
    }
  }
  // AND THE ROW MUST STILL NAME THIS CHILD AT THE MOMENT OF THE CLOSE (Argus r18).
  //
  // The process check above is not sufficient to license a destructive act. A NEWER
  // INCARNATION OF OURS on a reused pane id classifies as `close-foreign-owner` — it is
  // a claude on this transcript that is not OUR child — so the identity gate happily
  // authorises closing the very thing that replaced us. The clearing CAS below would
  // then report `row-moved`, which is true and arrives after the pane is already gone.
  //
  // WHAT THIS ACHIEVES, AND WHAT IT DOES NOT. It does NOT eliminate the window; a row
  // can still move between this read and `closeHandle`. It narrows that window from the
  // whole close — an inspection round trip, a `/health` probe and a close, each an await
  // during which a spawn can complete — to the gap between this read and the next
  // statement, with no I/O in between. And it changes what licenses the act: the
  // destructive step now requires the ROW as well as the process, instead of the process
  // alone. The residual is stated in the spec item rather than being described as an
  // elimination.
  if (registryPath !== undefined) {
    const owned = rowStillNames(registryPath, sessionKey, {
      handle,
      generation: record.child_generation,
    })
    if (owned === 'reclaimed') {
      log(
        `pane ${handle}: the ROW now names this pane under ANOTHER generation — NOT closing. A newer ` +
          'incarnation on a reused pane id looks exactly like a foreign owner to the identity check, and ' +
          'ending it would destroy the child that replaced us.',
      )
      return { kind: 'row-moved' }
    }
    if (owned === 'unreadable') {
      // The same rule the `unavailable` branch above already follows: evidence we could
      // not gather does not license a destructive act.
      log(`pane ${handle}: the row could not be re-read under the lock before the close — NOT closing`)
      return {
        kind: 'unverified',
        reason: 'the row could not be re-read under the lock immediately before the close',
      }
    }
  }
  try {
    await host.closeHandle(handle)
  } catch (e) {
    log(`pane ${handle} could NOT be closed (${errorText(e)}) — it is still running`)
    return { kind: 'failed', reason: 'the close FAILED' }
  }
  if (registryPath === undefined) return { kind: 'closed' }
  return closeOutcomeOfClear(
    clearPaneHandleIfUnchanged(
      registryPath,
      sessionKey,
      { handle, generation: record.child_generation },
      deps,
    ),
  )
}

/**
 * Does the row STILL name this (handle, generation)? Read under the flock, written
 * nowhere — the pre-close gate's half of the row check (Argus r18).
 *
 * Separate from {@link clearPaneHandleIfUnchanged} because the two ask the same question
 * at opposite ends of the destructive act and only one of them writes. This one licenses;
 * that one records.
 */
function rowStillNames(
  registryPath: string,
  sessionKey: string,
  expected: { readonly handle: string; readonly generation: string | undefined },
): 'ours' | 'reclaimed' | 'not-named' | 'unreadable' {
  try {
    let acquired = false
    // READ UNDER THE LOCK, AND THREE-STATE (Argus r19). `loadRegistry` does not THROW on
    // a corrupt file — it answers `{}` — so the catch below never saw it and the row came
    // back `undefined`, which this function reported as `not-named`: the PROCEED branch.
    // Registry corruption therefore licensed closing a live pane whose ownership had not
    // been established. "Nothing names this pane" is true of a registry that was read.
    const state = withRegistryRead(
      registryPath,
      () => readRegistryState(registryPath),
      (ok) => {
        acquired = ok
      },
    )
    // An unheld lock makes this read unordered against a concurrent writer, and the act
    // it licenses is destructive — so it is not evidence, by the same rule the claim and
    // the shutdown decision already follow.
    if (!acquired) return 'unreadable'
    if (state.kind === 'unreadable') return 'unreadable'
    // A DROPPED ROW FOR THIS KEY IS NOT "no row names this pane" — same rule, per key.
    if (state.kind === 'loaded' && state.droppedKeys.includes(sessionKey)) return 'unreadable'
    // THE DISTINCTION THAT MATTERS IS WHICH PANE THE ROW NAMES, not merely that the row
    // changed. Refusing on any change is too strong and breaks the act this module exists
    // to perform:
    //
    //   - the row names THIS pane with ANOTHER generation → somebody re-claimed this
    //     exact pane, and closing it destroys the child that replaced us. REFUSE.
    //   - the row names a DIFFERENT pane, or no row exists → nothing names the pane we
    //     are holding, so it is an unreferenced live claude on this transcript. Closing
    //     it is precisely the orphan-and-second-owner prevention this path is for.
    //     PROCEED.
    //   - the row names this pane and this generation → ours. PROCEED.
    const row = state.kind === 'loaded' ? state.registry[sessionKey] : undefined
    if (row?.pane_handle === expected.handle) {
      return row.child_generation === expected.generation ? 'ours' : 'reclaimed'
    }
    return 'not-named'
  } catch {
    return 'unreadable'
  }
}

/**
 * DELETE THIS KEY'S POOL ENTRY ONLY IF IT IS STILL OURS (#539, Argus r30).
 *
 * `pool.delete(sessionKey)` was unconditional in all three cleanup paths while the same
 * functions identity-guarded `childByKey` and the sink — in `unwind` the guarded and
 * unguarded lines sit adjacent. So: pass A pauses in inspection or attach, something else
 * publishes a newer session under the same key, A finds the row moved and unwinds — and
 * evicts **B's** entry. B's child is alive, its row names it, and the map every turn
 * resolves through no longer has it.
 *
 * THE PATTERN IS `child-exit-wiring.ts`'s: the session remembers the exact promise under
 * which it was published, and cleanup compares the map against that promise. Promise
 * settlement says nothing about ownership: fulfilled, rejected, and pending entries all
 * follow the same identity rule.
 *
 * WORTH KNOWING WHAT THE "OURS" ARM IS FOR. Measured while testing this: none of the
 * three cleanup paths currently runs with this pass's OWN session in the pool —
 * `adoptRow` publishes only after the claim succeeds, and no cleanup follows a successful
 * claim. So the unconditional delete these paths used to perform could only ever have
 * evicted somebody ELSE's entry. The arm is kept because the guard's contract is "delete
 * iff ours", not "never delete": a future caller that publishes before it can fail must
 * not have to rediscover this, and a guard whose safe branch is unreachable today is one
 * bug-fix away from being reachable tomorrow. Exported for the unit cases, which is the
 * only level where all four arms are observable.
 */
export function deleteOwnPoolEntry(sessionKey: string, session: ReplSession): void {
  const ownEntry = session.pooledAs
  if (ownEntry !== undefined && pool.get(sessionKey) === ownEntry) pool.delete(sessionKey)
}

/**
 * WHAT A RENEWAL DID (#539, Argus r38) — four answers, because three of them are not
 * success and two of them are not the same failure.
 *
 * `not-ours` is the one that matters: the row now names a DIFFERENT claimant, so this
 * gateway has been taken over and must not write. Distinct from `no-row` (the row is gone
 * entirely) and from `unwritable` (the lock was not held, or the registry threw) — "somebody
 * else owns it" and "I could not find out" are the distinction this whole module is built
 * on, and a boolean would collapse them at the one place the collapse is dangerous.
 */
export type ClaimRenewal = 'renewed' | 'not-ours' | 'no-row' | 'unwritable'

/**
 * REFRESH THIS GATEWAY'S CLAIM, so that an unexpired claim means a live claimant.
 *
 * THE COMPARE-AND-SET IS THE POINT, not the timestamp. A refresh that wrote blindly would
 * let a gateway renew a claim somebody else has legitimately taken over — which is the
 * original two-owner defect arriving through the back door, and worse than the defect,
 * because it would be a gateway asserting ownership it had already lost. So: write only if
 * the marker is still ours.
 *
 * Same lock discipline as the give-back, for the same reason — this is a whole-registry
 * read-modify-write, and an unguarded save drops rows this key has nothing to do with.
 */
export function renewAdoptionClaim(
  registryPath: string,
  sessionKey: string,
  claimedBy: string,
  now: number = Date.now(),
  claimantPid: number = process.pid,
): ClaimRenewal {
  try {
    // ANY DECLINE IS `unwritable` (Argus r48), not just an unacquired lock: an unreadable
    // registry and a thrown save are equally "this renewal did not land", and the self-fencing
    // deadline is the mechanism that makes that safe — it only ever moves on a CONFIRMED
    // renewal, so a decline simply lets the clock run.
    const write = withOwnedRegistry(
      registryPath,
      (registry) => {
        const prev = registry[sessionKey]
        if (prev === undefined) {
          return { registry, result: 'no-row' as ClaimRenewal, skipSave: true as const }
        }
        // Re-stamped rather than assumed: a row written before the pid field existed, or
        // by a pass that could not read its own, gets one on the first renewal. The CAS
        // lives in the helper, so `undefined` here means the row is no longer ours.
        const refreshed = refreshPaneClaim(prev, claimedBy, now, claimantPid)
        if (refreshed === undefined) {
          return { registry, result: 'not-ours' as ClaimRenewal, skipSave: true as const }
        }
        registry[sessionKey] = refreshed
        return { registry, result: 'renewed' as ClaimRenewal }
      },
      // Not renewed and nothing written: the claim ages toward its takeover threshold,
      // which is exactly what the threshold is for.
      () => 'unwritable' as ClaimRenewal,
    )
    return write.prevented ? 'unwritable' : write.result
  } catch {
    return 'unwritable'
  }
}

/**
 * RENEW WHATEVER CLAIM THIS GATEWAY HOLDS ON ONE POOLED SESSION — the supervision tick's
 * one-line entry point.
 *
 * `Bun.peek` rather than `await`, matching {@link deleteOwnPoolEntry}: the pool holds
 * promises, a key may hold a spawn that has not settled, and a tick must not block on one.
 * An unsettled entry simply is not renewed this tick — it has no claim yet either, since the
 * claim is taken at the end of the adoption that publishes it.
 */
/**
 * KEYS THIS GATEWAY HAS BEEN TAKEN OFF, with the sentence explaining why (#539, r39).
 *
 * A fenced key answers `undecided` from {@link beginBootAdoption}, so the spawn gate
 * refuses the turn through the SAME path it refuses every other unestablished owner. One
 * disposition, not a second vocabulary every consumer would have to learn — the argument
 * the shutdown latch already makes three lines further down.
 *
 * Duration decision (#685): keep the key fenced until gateway restart, including
 * when registry writes recover and the row still names the old claimant. Fencing
 * has revoked the local claim and detached the wrapper; a matching row alone does
 * not restore its capabilities. Recovery must run fresh boot reconciliation in a
 * new gateway process. This deliberately costs a restart after a transient outage.
 * `resetBootAdoption` clears the map during teardown, but the one-way shutdown latch
 * still prevents that process from adopting again.
 *
 * Flat rather than per-registry because `pool` is, and this mirrors `pool`'s granularity:
 * a fenced key names a session this process must stop serving, and that is exactly the
 * thing `pool` is keyed by.
 */
const fencedKeys = new Map<string, string>()

/** Has this gateway been taken off the key — and if so, why. Exported for the one caller
 *  that must answer before the pool is consulted. */
export function fencedReasonFor(sessionKey: string): string | undefined {
  return fencedKeys.get(sessionKey)
}

/**
 * THE TIMER THAT MAKES THE SELF-FENCING DEADLINE AN INVARIANT RATHER THAN A HOPE
 * (#539, Argus r49).
 *
 * ROUND FORTY-FOUR SPECIFIED THE CONDITION AND NOT THE MECHANISM. The deadline was evaluated
 * in exactly two places: when a new turn enters `beginBootAdoption`, and when a watchdog
 * renewal runs. **Both are things the losing gateway has stopped doing** — which is the one
 * circumstance the deadline exists for. A gateway in a long turn whose tick loop has stalled
 * and whose next turn never arrives was never fenced at all: it stayed attached and
 * sink-registered while another gateway took the pane.
 *
 * So the fence is armed as a TIMER when the claim is confirmed, re-armed on each CONFIRMED
 * renewal, and fires on its own. **It must not depend on any path a stalled gateway would
 * also have stopped travelling** — no tick, no turn, no probe, no pool lookup. That is the
 * whole property, and it is why this is a timer rather than one more check at one more
 * caller.
 *
 * RE-ARMED ON CONFIRMED, NOT ON ATTEMPTED, for round forty-four's reason: an attempt that
 * failed tells this gateway nothing about who owns the pane, so treating it as evidence would
 * reinstate exactly the defect the deadline exists to close.
 */
type FenceTimerFactory = (fire: () => void, ms: number) => { cancel: () => void }

const defaultFenceTimerFactory: FenceTimerFactory = (fire, ms) => {
  const handle = setTimeout(fire, ms)
  // UNREF'd: this timer must never be the reason a process stays alive. It exists to stop a
  // gateway serving, and a gateway that is otherwise finished has nothing left to stop.
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return { cancel: () => clearTimeout(handle) }
}

let fenceTimerFactory: FenceTimerFactory = defaultFenceTimerFactory

/** Test-only seam, in the idiom of `setFlockImplForTests`: a suite cannot wait out a
 *  seventy-five-second deadline, and shortening the constant in a case would test a
 *  different relationship than the one production runs. */
export function setFenceTimerFactoryForTests(f: FenceTimerFactory | undefined): void {
  fenceTimerFactory = f ?? defaultFenceTimerFactory
}

/**
 * Arm (or re-arm) this session's autonomous fence. Called at the claim and on every confirmed
 * renewal; cancelled by every path that stops owning the pane.
 */
export function armSelfFence(
  registryPath: string,
  sessionKey: string,
  session: ReplSession,
  log: (msg: string) => void = defaultLog,
): void {
  session.selfFenceTimer?.cancel()
  // THE INSTANT THIS TIMER IS FOR, captured at arm time. A firing is evaluated AS OF its own
  // deadline rather than against the wall clock: the timer IS the deadline, and reading the
  // clock again would only re-derive what the delay already encoded.
  const armedFor = (session.paneClaimConfirmedAt ?? Date.now()) + SELF_FENCE_AFTER_MS
  /** THIS timer's own handle, so its callback can tell whether it is still the current one.
   *  Assigned immediately below; the callback cannot run before that. */
  let mine: { cancel: () => void } | undefined
  const armed = fenceTimerFactory(() => {
    // IDENTITY-GUARDED, and it is the SAME RULE as `childByKey.get(key) === child` (r30) and
    // `deleteOwnPoolEntry`'s `Bun.peek` comparison (r30/r31): a handle can be REPLACED between
    // the moment you captured it and the moment you act on it, and a callback is the purest
    // form of "later". A late firing of a superseded timer used to clear the field
    // unconditionally — erasing its REPLACEMENT's cancellation handle, so a later release could
    // not cancel it, and that orphan then fenced a key its gateway had legitimately let go.
    // One idiom, three resources: the pool entry, the child mirror, and now the timer.
    if (session.selfFenceTimer === mine) session.selfFenceTimer = undefined
    // THE PREDICATE STILL DECIDES. A re-arm cancels this timer, so a stale firing should be
    // impossible — and if one arrives anyway (a factory that does not cancel, a suspended
    // process), the deadline is re-checked against the CURRENT confirmation and a session that
    // has since renewed is left alone. Belt and braces, cheaply.
    fenceIfPastSelfDeadline(sessionKey, session, armedFor, 'no-renewal-observed-on-this-turn', log)
    void registryPath
  }, SELF_FENCE_AFTER_MS)
  mine = armed
  session.selfFenceTimer = armed
}

/**
 * STOP SERVING A PANE THIS GATEWAY NO LONGER OWNS — and do not close it (#539, Argus r39).
 *
 * THE DEFECT: detecting `not-ours` and only logging. The renewal correctly discovered that
 * another incarnation had taken the row over, said so, and returned with the session still
 * attached, still in `pool`, still registered at the sink and still answering turns. That is
 * the two-owner state this whole item exists to prevent, reached by the LOSING party — and
 * it is this branch's most repeated shape once more: a verdict computed correctly and
 * dropped by its caller.
 *
 * FENCING IS NOT CLOSING, and this is the one line in this function that must not be got
 * wrong. B owns the pane and its REPL is live and serving; a loser that closed on its way
 * out would destroy the conversation the takeover just preserved. `detach` exists as a
 * separate verb for exactly this, and the survival branch proved it at round twenty-five.
 *
 * ONE OF THE FIVE PATHS that stop owning a session, which the per-structure audit table
 * predicted there would eventually be — and its scope has since widened again to include child
 * exit (r52), because excluding that path is where the round-fifty-one defect hid. Same columns, same
 * identity guards: `deleteOwnPoolEntry` so it can only ever remove ITS OWN entry — the
 * winner's entry may live in the same map, and evicting that would take the pane away from
 * the gateway that legitimately holds it.
 */
export function fenceLostSession(
  sessionKey: string,
  session: ReplSession,
  reason: string,
  log: (msg: string) => void = defaultLog,
): void {
  // THE TIMER IS PART OF OWNING, so it goes with everything else. A fenced session that left
  // one behind would fence itself a second time on a pane it had already let go.
  session.selfFenceTimer?.cancel()
  session.selfFenceTimer = undefined
  // AND SO IS THE CLAIM ITSELF (r61). Not the ROW's claim — that stays exactly where it is,
  // because after a takeover it is the winner's and after a self-fence we are the gateway that
  // could not write. What goes is this process's assertion that it HOLDS that id: a fenced
  // session has stopped serving by definition, and while it went on claiming the id, the
  // ownership predicates would tell a second gateway IN THIS PROCESS that a live owner here
  // holds the claim — blocking the very takeover the self-fence exists to make possible.
  // The release matrix's fourth column, which is what found this.
  session.paneClaimBy = undefined
  // AND THE INBOUND DIRECTION (r49): a reply already in flight arrives over the sink, not over
  // the pane, so detaching does not stop it. See `ReplSession.fenced`.
  session.fenced = true
  // REFUSE FUTURE TURNS FIRST. Everything below is teardown; if any of it threw, a key left
  // unfenced would keep serving a pane somebody else owns, which is the state being escaped.
  fencedKeys.set(sessionKey, reason)
  sink.unregisterIf(session.sessionId, session)
  // NOT `close`. See the note above — the pane is the winner's and it is live.
  session.child?.detach?.()
  const child = childByKey.get(sessionKey)
  if (child !== undefined && child === session.child) childByKey.delete(sessionKey)
  deleteOwnPoolEntry(sessionKey, session)
  session.sizeWatchdog?.stop()
  session.deadTurnWatcher?.stop()
  // The wrapper is detached, so `exited` never settles and `child-exit-wiring`'s handler
  // never runs — the same reason the other two non-destructive paths do this themselves.
  session.liveHandle?.unregister()
  log(`row ${sessionKey.slice(0, 32)}: ${reason}`)
}

/**
 * WHAT THE SUPERVISION TICK MUST DO ABOUT THIS KEY — a value it cannot proceed without
 * handling (#539, Argus r46).
 *
 * THE DEFECT: the renewal fenced correctly and returned `void`, and the tick carried on with
 * the snapshot it had loaded BEFORE the fencing. If the probe then called the new owner's
 * session unhealthy, the losing tick emitted a crash notice, patched the winner's row and
 * attempted a respawn — **a gateway that had just concluded it does not own the pane
 * declaring the rightful owner crashed and respawning over it.**
 *
 * Round thirty-nine asked for exactly this to be impossible ("make the return value
 * impossible to drop"). What landed was fencing that worked and a value that was still
 * droppable, and it was dropped at the same two lines. So this is a DISCRIMINATED result and
 * the caller switches exhaustively: a future arm cannot default into "carry on", because the
 * compiler will name it.
 */
export type OwnershipTickOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'fenced'; readonly why: string }

export function renewOwnAdoptionClaim(
  registryPath: string,
  sessionKey: string,
  now: number,
  log: (msg: string) => void = defaultLog,
): OwnershipTickOutcome {
  // ALREADY FENCED, AND THAT PERSISTS ACROSS TICKS. The fence removes the session from the
  // pool, so a later tick would find nothing to renew, return `proceed`, and go on to probe
  // and actuate a row that now belongs to somebody else — the same destructive path one tick
  // later. A fenced key is not this gateway's to supervise until a construction of this
  // substrate reconciles it.
  const fenced = fencedKeys.get(sessionKey)
  if (fenced !== undefined) return { kind: 'fenced', why: fenced }
  // SCOPED TO THIS REGISTRY, for the reason the tick's own key filter already gives: `pool`
  // is module-global, so in a hosted single-process deployment this key may belong to
  // ANOTHER instance's registry. Renewing there would ask a row that has never heard of this
  // session, get `not-ours`, and print the takeover sentence — a loud, alarming, false
  // report of a takeover that did not happen, on every tick.
  if (supervisedBySessionKey.get(sessionKey)?.replRegistryPath !== registryPath) {
    return { kind: 'proceed' }
  }
  const pooled = pool.get(sessionKey)
  if (pooled === undefined) return { kind: 'proceed' }
  const session = Bun.peek(pooled) as ReplSession | undefined
  if (session === undefined) return { kind: 'proceed' }
  renewClaimForSession(registryPath, sessionKey, session, now, log)
  // RE-READ AFTER THE ATTEMPT, not inferred from it: `renewClaimForSession` fences through
  // two different paths (an observed takeover, and the self-deadline), and asking the fence
  // map is the one answer that covers both without this function having to know which fired.
  const after = fencedKeys.get(sessionKey)
  return after === undefined ? { kind: 'proceed' } : { kind: 'fenced', why: after }
}

/**
 * The same renewal for a session named EXPLICITLY rather than found in the pool.
 *
 * Split out because the pool cannot identify "our" session once a takeover has happened
 * inside one process — the winner's entry is under the same key — so the act of losing has
 * to be driven from the session that lost. {@link renewOwnAdoptionClaim} is this function
 * plus the pool lookup, which is the production path.
 */
export function renewClaimForSession(
  registryPath: string,
  sessionKey: string,
  session: ReplSession,
  now: number,
  log: (msg: string) => void = defaultLog,
): void {
  const claimedBy = session.paneClaimBy
  if (claimedBy === undefined) return
  // THE RESULT IS CONSUMED WHERE IT IS PRODUCED. `renewAdoptionClaim`'s four answers exist
  // so this branch can be taken; handing them further up to a tick that ignores them is how
  // this branch has twice ended up computing a classification and dropping it.
  const outcome = renewAdoptionClaim(registryPath, sessionKey, claimedBy, now)
  if (outcome === 'renewed') {
    // CONFIRMED. This is the only thing that moves the self-fencing deadline, because it is
    // the only outcome that proves this gateway still owns the pane — and the only thing that
    // re-arms the autonomous timer, for the same reason.
    session.paneClaimConfirmedAt = now
    armSelfFence(registryPath, sessionKey, session, log)
    return
  }
  if (outcome === 'not-ours') {
    // ANOTHER INCARNATION HOLDS THIS ROW, and we could see it. Logging alone was the r39
    // defect: the session stayed attached and kept answering turns on a pane it had lost.
    // Re-claiming is not the answer either — that is the second owner it was replaced for
    // being unable to be. It stops.
    fenceLostSession(
      sessionKey,
      session,
      'the adoption claim is NO LONGER OURS — another incarnation took this row over while this gateway ' +
        'was not renewing, so this one has STOPPED serving that pane: the wrapper is detached (never closed — ' +
        'the REPL is the new owner\'s and it is live), the registrations are released, and turns for this key ' +
        'are refused until a construction of this substrate reconciles it again',
      log,
    )
    return
  }
  // AND EVERY OTHER OUTCOME IS THE SAME FACT FROM THIS SEAT (Argus r44): `unwritable`,
  // `no-row` and a throw all mean *I can no longer prove I own this pane*. Fencing only on
  // `not-ours` made this gateway's safety depend on READING THE WINNER'S MARKER — which it
  // cannot do, because the very failure that costs it the lease is the failure that stops it
  // seeing anything about the lease. A renewal stuck on `unwritable` never becomes
  // `not-ours`, so the old holder served forever while the new one served too.
  fenceIfPastSelfDeadline(sessionKey, session, now, outcome, log)
}

/**
 * STOP SERVING BECAUSE WE CAN NO LONGER PROVE WE OWN IT (#539, Argus r44).
 *
 * THE PROPERTY THIS BUYS, stated because it is what makes the design correct rather than
 * merely careful: **a lease holder never needs to read the other gateway's state to be
 * safe.** Everything here is derived from this session's own last CONFIRMED renewal, so it
 * holds under a partition, under an unwritable registry, under a vanished row, and under a
 * lock this process can never acquire again — every case where looking harder at the registry
 * would have told us nothing. Fixing r44 by making the loser look harder would have been
 * wrong for exactly that reason.
 *
 * The deadline is {@link SELF_FENCE_AFTER_MS}, which is DERIVED from
 * {@link ADOPTION_CLAIM_TAKEOVER_MS} by subtracting one renewal interval. Both are measured
 * from the same instant — the timestamp a confirmed renewal writes — so this gateway has
 * stopped at least a full tick before any other is entitled to take over.
 *
 * Same fencing as round thirty-nine, and for the same reason NOT a close: whoever takes this
 * pane next inherits a live REPL.
 */
function fenceIfPastSelfDeadline(
  sessionKey: string,
  session: ReplSession,
  now: number,
  /** WHAT THIS PASS ACTUALLY KNOWS. A renewal that ran reports its own outcome; the turn
   *  path has not run one, and saying `unwritable` there would put a fact in an
   *  operator-facing message that nobody established. */
  reason: ClaimRenewal | 'no-renewal-observed-on-this-turn',
  log: (msg: string) => void,
): void {
  // No confirmation on record at all is treated as "now" rather than as "forever ago": the
  // claim was taken moments ago by definition (it is what put this session in the pool), and
  // a missing stamp must not fence a session that has never had a chance to renew.
  // A SESSION THAT HOLDS NO CLAIM HAS NOTHING TO FENCE (r50). Every give-back path clears
  // `paneClaimBy`, so this is the single check that makes a late timer firing inert after a
  // release — including one dispatched before its `cancel` could land.
  if (session.paneClaimBy === undefined) return
  const confirmedAt = session.paneClaimConfirmedAt
  if (confirmedAt === undefined) {
    session.paneClaimConfirmedAt = now
    return
  }
  if (now - confirmedAt < SELF_FENCE_AFTER_MS) return
  fenceLostSession(
    sessionKey,
    session,
    `this gateway has NOT CONFIRMED ownership of its pane for ${String(now - confirmedAt)}ms (last renewal ` +
      `outcome: ${reason}), which is past the self-fencing deadline — so it can no longer prove the pane is ` +
      'ours and has STOPPED serving it. The wrapper is detached (never closed — the REPL is live and whoever ' +
      'takes the row next inherits it), the registrations are released, and turns for this key are refused. ' +
      'Deliberately NOT conditional on observing another owner: the failure that costs a lease is the failure ' +
      'that hides who took it.',
    log,
  )
}

/**
 * GIVE THE ADOPTION CLAIM BACK, if this session holds it (#539, Argus r37).
 *
 * CAS'd on `adoption_claim_by` so a pass can only ever release its OWN claim — releasing
 * another incarnation's would hand its row to a third. Called from every path that stops
 * owning a session, which is the same four the round-thirty-one table enumerates: without
 * it the shutdown survival branch would leave a claim behind and the next boot — the one
 * the whole feature exists to serve — would be refused until the TTL elapsed.
 *
 * Best-effort and silent on failure: the TTL is the backstop, so a failed release costs a
 * bounded refusal rather than a wedge.
 */
export function releaseAdoptionClaim(
  registryPath: string | undefined,
  sessionKey: string,
  claimedBy: string | undefined,
): void {
  if (registryPath === undefined || claimedBy === undefined) return
  try {
    withOwnedRegistry(
      registryPath,
      (registry) => {
        // AND A WRITE IS ONLY SAFE WHILE THE LOCK HOLDS — the same argument the claim
        // makes, and this path is if anything more exposed to it. `withFlockSync` runs the
        // callback UNGUARDED when the FFI is missing or `flock` returns nonzero, and both
        // look like success from in here. `withRegistry` is a whole-registry
        // read-modify-write: a save from a snapshot loaded without the lock DROPS any row a
        // concurrent incarnation wrote in between. That is the lost update the claim's own
        // comment warns about, performed by the tidy-up rather than by the decision — and
        // it would corrupt rows belonging to keys this pass has nothing to do with.
        //
        // Skipping costs one bounded refusal on THIS key (the marker stands until its TTL),
        // which is precisely what the TTL is for. Losing somebody else's row costs a live
        // REPL nothing can find. Not a close call.
        const prev = registry[sessionKey]
        // THE HANDLE STAYS. This is the hand-over, not a disown: the pane is still running
        // and the row must go on naming it, or the next construction has nothing to adopt.
        const handed = prev === undefined ? undefined : handOverPane(prev, claimedBy)
        if (handed === undefined) {
          return { registry, result: undefined, skipSave: true as const }
        }
        registry[sessionKey] = handed
        return { registry, result: undefined }
      },
      // Not handed back: the claim stands until its takeover threshold, which costs one
      // bounded refusal on this key rather than somebody else's dropped row.
      () => undefined,
    )
  } catch {
    /* the TTL is the backstop */
  }
}

/**
 * Turn the clear's outcome into the CLOSE's outcome — exhaustively, so a new
 * `ClearOutcome` fails the typecheck here instead of defaulting into `closed`.
 *
 * The ternary this replaces read `=== 'row-moved' ? … : { kind: 'closed' }`, which lumped
 * every other answer — including a refused write — into "the pane is closed and the row
 * is tidy". Only `row-moved` changes what the CLOSE established: the pane really is
 * closed in every other branch, and a row that still carries a handle is recoverable
 * because the next boot probes it and gets a positive absence.
 */
function closeOutcomeOfClear(cleared: ClearOutcome): CloseOutcome {
  switch (cleared) {
    case 'row-moved':
      // The key now describes another incarnation's child, so our close licenses nothing.
      return { kind: 'row-moved' }
    case 'error':
    case 'lock-unacquired':
      // THE CLOSE REALLY HAPPENED — do not claim otherwise — but the row's state is
      // unestablished, so it must not license a resume. An earlier revision put these in
      // the same `case` list as the reads below, which is how the reasoning that is sound
      // for `absent` came to cover a refusal that says the opposite (Argus r23).
      return { kind: 'closed-row-unestablished' }
    case 'cleared':
    case 'absent':
      // READS THAT HAPPENED, and the pane IS closed — which together are what license a
      // resume. A row that still carries a handle after a successful read is recoverable:
      // the next boot probes it and gets a positive absence.
      return { kind: 'closed' }
  }
}

/**
 * Turn a close attempt into this row's verdict.
 *
 * ONE PLACE, because there are three ways a close can end and only one of them is
 * "nothing owns this transcript now". A boolean here is how "I refused to close it on
 * unverified evidence" would quietly become "it is closed".
 */
function outcomeOfClose(
  close: CloseOutcome,
  sessionKey: string,
  closedKind: 'closed-foreign-owner' | 'closed-unadoptable',
  reason: string,
): RowAdoptionOutcome {
  if (close.kind === 'closed') return { kind: closedKind, sessionKey, reason }
  if (close.kind === 'row-moved') return { kind: 'undecided', sessionKey, reason: ROW_MOVED_REASON }
  if (close.kind === 'closed-row-unestablished') {
    return { kind: 'undecided', sessionKey, reason: ROW_UNESTABLISHED_REASON }
  }
  return { kind: 'undecided', sessionKey, reason: `${reason}; and ${close.reason}` }
}

/** What {@link closeAndClear} did. THREE, not a boolean: "it is gone", "the close
 *  failed" and "I would not close it on this evidence" are different facts, and only
 *  the first licenses a resume. */
type CloseOutcome =
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'unverified'; readonly reason: string }
  /** The pane IS closed, and what the row says could not be established — the clear's
   *  compare-and-set had no lock, or the registry could not be written. Distinct from
   *  `closed`, which additionally means a read happened and agreed. */
  | { readonly kind: 'closed-row-unestablished' }
  /** The pane was dealt with, but the ROW is no longer the one this pass decided about
   *  — so the close licenses nothing: the key now describes another incarnation's
   *  child, and a resume on the strength of our finding would make a second owner. */
  | { readonly kind: 'row-moved' }

/** One-line error text. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Drop `pane_handle` from a row, and CHECK WHAT IS ON DISK AFTERWARDS rather than
 * assuming the write took.
 *
 * The write is a no-op when the row has gone (a concurrent respawn removed it), and
 * can be skipped entirely when the registry is unreadable. Either way the caller must
 * not go on believing it cleared something: a stale handle left on disk sends the NEXT
 * boot to a pane id that may by then name someone else's pane.
 */
/**
 * THE VERDICT WHEN THE ROW MOVED UNDER THIS PASS — and it is the same one everywhere,
 * because nothing this pass established is about the row as it now stands.
 *
 * It exists because the compare-and-clear's own return value was, for one revision,
 * computed and then discarded: the write correctly refused to touch a row it had not
 * decided about, and the caller went on to report `handle-cleared` (or `closed-by-pid`)
 * anyway — a positive statement that LICENSES A SPAWN, about a key another incarnation
 * had just written a live child into. That is the same "compute the answer and ignore
 * it" shape this module was already caught on once, arriving through the fix for it.
 */
/**
 * CLAIM THE ROW FOR THIS ADOPTION — publish the session, or give the child back.
 *
 * THE THIRD INSTANCE OF ONE HABIT, AND THE REASON THE SHAPE CHANGED AGAIN. The pid
 * write here already compared the row correctly and returned a `wrote` boolean — which
 * reached a LOG and nothing else. So an adoption whose row had been replaced mid-pass
 * left its child live in the pool and reported `adopted`, while the durable row named
 * somebody else's: two live owners on one transcript, which is the invariant this whole
 * item exists to hold. Exactly the shape of the two instances before it — a value added
 * last to a function whose caller was already written to ignore it.
 *
 * THE ARGUMENT FOR LEAVING IT WAS NOT AVAILABLE, and that is worth stating: "two
 * gateways sharing one instance home is outside this design" cannot be true here while
 * the compare-and-clear six hundred lines up exists precisely because they can race on
 * this file (`repl-registry.ts`'s mutation model is cross-process by construction). The
 * same race cannot be a blocker in one place and out of scope in the other.
 *
 * So this function owns BOTH outcomes. The caller returns its result and can do nothing
 * else with it: there is no branch in which the verdict is computed and ignored, and
 * none in which the failure path forgets to unwind.
 */
async function claimRowOrUnwind(args: {
  readonly registryPath: string | undefined
  readonly sessionKey: string
  readonly expected: { readonly handle: string; readonly generation: string }
  /** The pid this adoption is attached to — written back when the row's is stale. */
  readonly pid: number
  readonly recordedPid: number | undefined
  /** THIS pass's incarnation — minted fresh per adoption, and the only thing that
   *  distinguishes two claimants of one row. */
  readonly incarnation: string
  /** Injected so a case can drive the takeover boundary without sleeping through it. */
  readonly now: number
  /** THIS gateway's own process id, recorded with the claim so the next claimant can
   *  establish this one's death rather than wait it out. */
  readonly claimantPid: number
  readonly deps: BootAdoptionDeps
  /** Install the session and answer `adopted`. Runs ONLY if the row is still ours — which
   *  is also when the caller is permitted to enable output delivery and the detectors, so
   *  this may be async (see the ordering invariant in the module docblock). */
  readonly publish: () => RowAdoptionOutcome | Promise<RowAdoptionOutcome>
  /** Take everything back — pool entry, child, sink registration, watchers, pane. */
  readonly unwind: (reason: string) => Promise<RowAdoptionOutcome>
  /** Take back only OUR registrations, leaving the pane and the row exactly as they are.
   *  For the case where the claim could not be established at all — see the
   *  `!acquired` branch, which must neither publish nor close. */
  readonly release: (reason: string) => RowAdoptionOutcome
}): Promise<RowAdoptionOutcome> {
  const log = args.deps.log ?? defaultLog
  // Unsupervised: there is no row, so there is nothing to race for and nothing to
  // claim. (`reconcileOwnRepl` cannot reach an adoption without a registry, so this is
  // a total-function guard rather than a live path.)
  if (args.registryPath === undefined) return await args.publish()
  const registryPath = args.registryPath
  /** What the claim's critical section concluded. THREE, not a boolean: the row is ours,
   *  the row moved, or we never held the lock — and the third must not be able to reach
   *  the code that writes. */
  type ClaimResult = 'ours' | 'row-moved' | 'credential-changed' | 'lock-unacquired' | 'claimed-elsewhere' | 'reserved-elsewhere'
  let claim: ClaimResult
  // THE CLAIM IS A COMPARE-AND-SET, AND A CAS IS ONLY A CAS WHILE THE LOCK HOLDS
  // (Argus r14). `withFlockSync` deliberately runs unguarded when FFI is missing or
  // `flock` returns nonzero, and both look exactly like success to a caller that does not
  // ask. Unguarded, two incarnations read this row, both find it matching, and both
  // publish an attached owner — two owners of one live transcript, the single outcome
  // this module exists to prevent. Round eight gave the shutdown decision this treatment;
  // the claim is its neighbour and inherited nothing.
  try {
    const claimWrite = withOwnedRegistry<ClaimResult>(
      registryPath,
      (registry) => {
        // CHECKED INSIDE THE CALLBACK, BEFORE ANY WRITE (Argus r15). `onOutcome` fires
        // before `fn`, so `acquired` is already correct here — and `withRegistry` SAVES
        // whatever this returns, so a check placed after the call is a check placed after
        // the write. An earlier revision refused the adoption at the outer branch and had
        // already rewritten the pid without mutual exclusion, while logging that it had
        // left the row alone.
        //
        // BOTH SITES NOW CHECK ACQUISITION FIRST. An earlier version of this comment named
        // the clear below as the exemplar the claim had failed to inherit from. That was
        // true of the clear's FINAL branch and false of its early returns, which returned
        // `absent`/`row-moved` above their own `acquired` check and wrote the snapshot
        // back — so the comment was a false claim about the code three lines above the
        // correct implementation. Argus r21 hoisted that check too; the clear's early
        // returns were the last place this rule had not reached.
        const prev = registry[args.sessionKey]
        if (args.deps.expectedAuthFingerprint !== undefined &&
            prev?.reuse?.auth_fingerprint !== args.deps.expectedAuthFingerprint) {
          return { registry, result: 'credential-changed' as ClaimResult, skipSave: true }
        }
        if (
          prev === undefined ||
          prev.pane_handle !== args.expected.handle ||
          prev.child_generation !== args.expected.generation
        ) {
          return { registry, result: 'row-moved' as ClaimResult }
        }
        // THE PID IS THE ONE FIELD AN ADOPTION MAY CORRECT: the child is the same process
        // it always was, so a disagreement means the row was stale — and a stale pid is
        // what every liveness probe above here uses.
        // A VERIFICATION IS NOT A CLAIM (Argus r37). Everything above this line only
        // READ the row, and the lock is released the moment this callback returns —
        // `publish()` runs after it. So two incarnations could each take the lock in turn,
        // each find the row unchanged BECAUSE the other had only read it, and each publish
        // an attached wrapper on the same pane: two owners of one live transcript, which is
        // the invariant this module exists to hold. Nothing already in the row can tell
        // them apart — the generation is RESTORED from this row so both carry the same one,
        // and the pid is the same pane's process. Only a write can.
        //
        // AND A CLAIM MUST GO ON MEANING SOMETHING (Argus r38). For one round this asked
        // only how OLD the claim was, which is a different question from the one that
        // matters: a healthy owner that had been serving this pane for ninety-one seconds
        // had a claim any new gateway was entitled to overwrite, and the invariant fell to
        // the clock instead of to a race. An age is evidence about a claimant only while
        // something keeps the two in step — so the owner RENEWS on its supervision tick, and
        // what expires is a claim nobody is refreshing.
        //
        // TWO WAYS TO ESTABLISH THE CLAIMANT IS GONE, and the cheap one is exact: if its
        // process is provably dead the claim dies with it, immediately, which is what keeps
        // a CRASHED gateway's panes adoptable at once instead of after a threshold. The
        // threshold covers everything a pid cannot say — a wedged gateway still holding its
        // process open, a pid we may not signal, a row written before this field existed.
        // ONE PREDICATE, SHARED WITH THE FRESH-SPAWN CONTEST (r45). It used to be inline
        // here, which is how the spawn path came to write ownership with no contest at all —
        // two implementations of "is this claim live" is two things to keep in step, and one
        // of them was missing.
        const live = paneClaimBlocksUs(prev, {
          ours: args.incarnation,
          now: args.now,
          ourPid: args.claimantPid,
          ...(args.deps.claimantLiveness !== undefined
            ? { liveness: args.deps.claimantLiveness }
            : {}),
        })
        if (live) {
          return { registry, result: 'claimed-elsewhere' as ClaimResult, skipSave: true }
        }
        // AND A SPAWN RESERVATION BLOCKS AN ADOPTION TOO (#539, Argus r63 — the gap the
        // capability enumeration turned up).
        //
        // Round forty-seven's reservation stops two SPAWNERS reaching one transcript, and only
        // spawners ever consulted it: this path never looked. So a gateway holding a live
        // reservation — which means its `claude --resume <id>` is starting right now, appending
        // through startup and readiness — could be overtaken by an adopter that claimed the row
        // out from under it, and the spawner would learn of it only at its own ownership write,
        // after its child had been writing. Two processes on one transcript for the length of a
        // spawn: exactly what the reservation exists to prevent, in the direction nobody
        // enumerated.
        //
        // The same predicate as the spawn path's, so the two cannot drift, and a dead or
        // expired holder does not block by that predicate's own rules.
        const reserved = spawnReservationBlocksUs(prev, {
          ours: args.incarnation,
          now: args.now,
          ourPid: args.claimantPid,
          ...(args.deps.claimantLiveness !== undefined
            ? { liveness: args.deps.claimantLiveness }
            : {}),
        })
        if (reserved) {
          return { registry, result: 'reserved-elsewhere' as ClaimResult, skipSave: true }
        }
        // OURS FROM HERE, and the write is what makes it so. The next claimant reads a
        // CHANGED row and takes the refusal path above rather than a fresh success.
        registry[args.sessionKey] = ownPane(
          { ...prev, ...(args.recordedPid !== args.pid ? { pid: args.pid } : {}) },
          {
            // The handle and generation are RE-STATED rather than changed: this pass
            // verified both against the row above, so `ownPane` writes back what is
            // already there and adds the claim in the same write.
            handle: args.expected.handle,
            generation: args.expected.generation,
            claimant: args.incarnation,
            now: args.now,
            pid: args.claimantPid,
          },
        )
        return { registry, result: 'ours' as ClaimResult }
      },
      // NO WRITE AT ALL, not "write the same thing back" — the snapshot loaded before the
      // callback ran would drop any row a concurrent incarnation wrote in between: a lost
      // update performed by the branch that refuses to act because it did not get the
      // lock. The verdict below neither publishes nor closes.
      () => 'lock-unacquired' as ClaimResult,
    )
    // AND A CLAIM THAT DID NOT PERSIST IS NOT A CLAIM (Argus r48). `ours` means the mutator
    // decided the row was ours; only `persisted` means the next claimant will READ that. An
    // unreadable registry or a thrown save would otherwise publish a session whose ownership
    // nothing durable records — the r41 hazard, reached through a different decline.
    // THREE FACTS, THREE SENTENCES — still (r15, preserved through r48). `withOwnedRegistry`
    // now REPORTS a throw instead of propagating it, which is what stops it being swallowed
    // further out; but "I could not ask at all" is a different fact from "I could not get the
    // lock", and collapsing them would undo the distinction this module was built on. So the
    // throw keeps its own branch and its own sentence, with the error text the report carries.
    if (claimWrite.why === 'threw') {
      return args.release(
        `the registry could NOT BE READ OR WRITTEN for this adoption's row claim (${claimWrite.error ?? 'unknown error'}) — ` +
          'nothing establishes who owns this pane, so it is left running and the row left alone',
      )
    }
    claim = claimWrite.prevented ? 'lock-unacquired' : claimWrite.result
  } catch (e) {
    // THE REGISTRY COULD NOT BE READ OR WRITTEN, and that establishes nothing about who
    // owns this pane (Argus r15). A thrown lockfile open, a read error, an EACCES — none
    // of them say the pane is ours to end, and this branch used to call `unwind`, which
    // CLOSES it. Six lines down, the unacquired-lock branch argues correctly that an
    // unestablished claim licenses neither act; the same argument applies here verbatim,
    // and this is a THIRD fact with its own sentence: not "someone else owns this row",
    // not "I could not get the lock", but "I could not ask at all".
    return args.release(
      `the registry could NOT BE READ OR WRITTEN for this adoption's row claim (${errorText(e)}) — ` +
        'nothing establishes who owns this pane, so it is left running and the row left alone',
    )
  }
  if (claim === 'credential-changed') {
    log(`row ${args.sessionKey.slice(0, 32)}: credential-changed while attaching — leaving the pane and row alone`)
    return args.release('credential-changed: durable auth fingerprint changed before the adoption claim')
  }
  if (claim === 'lock-unacquired') {
    // NOT PUBLISHED, AND NOT CLOSED. "Someone else owns this row" and "I could not find
    // out who owns it" are different facts and get different acts. `undecided` maps to
    // `{ ok: false }` in the spawn gate, so no cold spawn follows and no second owner can
    // arise from the refusal — while CLOSING would destroy a live REPL that another
    // incarnation may have legitimately claimed. We verified the child is ours; we did
    // not establish that we are still its rightful owner, and an unestablished claim
    // licenses neither act.
    log(
      `row ${args.sessionKey.slice(0, 32)}: the registry LOCK WAS NOT ACQUIRED for this adoption's claim, so ` +
        `the compare-and-set is not atomic and two incarnations could both have claimed pane ` +
        `${args.expected.handle}. Giving the child back and leaving the pane and the row alone.`,
    )
    return args.release(LOCK_UNACQUIRED_REASON)
  }
  if (claim === 'claimed-elsewhere') {
    // ANOTHER INCARNATION HOLDS THIS ROW. Not published and not closed: its pane is
    // somebody else's to finish adopting, and `undecided` refuses the spawn without
    // touching anything. The reason names the claim so a log reader can tell this from a
    // row that moved — "somebody else got here first" and "the row now describes a
    // different child" are different facts.
    log(
      `row ${args.sessionKey.slice(0, 32)}: another incarnation holds the adoption claim on pane ` +
        `${args.expected.handle} — giving the child back rather than becoming a second owner.`,
    )
    return args.release(CLAIMED_ELSEWHERE_REASON)
  }
  if (claim === 'reserved-elsewhere') {
    // A SPAWN IS IN FLIGHT FOR THIS KEY IN ANOTHER GATEWAY. Give the child back, leave the pane
    // and the row alone, and let the turn retry: the spawner either records ownership (and the
    // next pass sees its claim) or releases the reservation and the pane is adoptable again.
    log(
      `row ${args.sessionKey.slice(0, 32)}: another gateway holds a live SPAWN RESERVATION for this key, so ` +
        `adopting pane ${args.expected.handle} would put two processes on one transcript. Giving the child ` +
        'back and leaving both alone.',
    )
    return args.release(RESERVED_ELSEWHERE_REASON)
  }
  if (claim === 'row-moved') {
    log(
      `row ${args.sessionKey.slice(0, 32)} was REPLACED while this adoption was attaching — it now names another ` +
        `incarnation's child. Giving pane ${args.expected.handle} back rather than serving a second owner.`,
    )
    return await args.unwind(ROW_MOVED_REASON)
  }
  if (args.recordedPid !== args.pid) {
    // WHAT IS ON DISK, not what was asked for.
    const after = getRecord(registryPath, args.sessionKey)
    if (after?.pid !== args.pid) {
      log(
        `row ${args.sessionKey.slice(0, 32)} still records pid ${String(after?.pid)} after adopting pid ${args.pid} — ` +
          'liveness probes will ask about the wrong process',
      )
    }
  }
  // THE CLAIM IS TAKEN AND NOTHING IS PUBLISHED YET — the window a second incarnation
  // must lose in. See {@link BootAdoptionDeps.afterRowClaim}.
  await args.deps.afterRowClaim?.()
  return await args.publish()
}

/**
 * Clear the handle and PRODUCE THE CALLER'S VERDICT — the shape that makes the result
 * impossible to drop.
 *
 * TWICE ON THIS BRANCH A CLASSIFIER'S ANSWER WAS COMPUTED AND IGNORED, and both times
 * the ignored value was the one added last, after the call sites had already been
 * written to call a `void` function. First `beginBootAdoption`'s outcome, awaited by
 * `getOrSpawnSession` for its ordering and discarded; then this clear's `row-moved`,
 * which correctly refused to touch a row another incarnation had replaced — and was
 * followed by `handle-cleared` / `closed-by-pid` anyway, verdicts that LICENSE A COLD
 * SPAWN on a transcript whose live owner had just been written into that row. The data
 * corruption was fixed and the two-owner outcome it existed to prevent was not.
 *
 * A `void` function with an interesting return value is an invitation to that mistake.
 * This one returns the caller's own verdict instead of a status, so a caller that fails
 * to use it fails to return anything and the typecheck refuses it. The safety is in the
 * shape, not in remembering.
 */
function clearHandleThenVerdict(
  registryPath: string | undefined,
  sessionKey: string,
  expected: { readonly handle: string; readonly generation: string | undefined },
  deps: BootAdoptionDeps,
  /** What this pass concluded, for the case where the row is still its own. */
  whenCleared: RowAdoptionOutcome,
): RowAdoptionOutcome {
  // Unsupervised: there is no row to clear and nothing to disagree with.
  if (registryPath === undefined) return whenCleared
  const cleared = clearPaneHandleIfUnchanged(registryPath, sessionKey, expected, deps)
  switch (cleared) {
    case 'row-moved':
      return { kind: 'undecided', sessionKey, reason: ROW_MOVED_REASON }
    case 'lock-unacquired':
    case 'error':
      // THE COMMENT THAT USED TO SIT HERE WAS THE DEFECT (Argus r23). It said a registry
      // that could not be written is "a stale handle the NEXT boot re-inspects — not a
      // live owner", and that argument is sound for `absent`: we READ the row and found
      // nothing. Without the lock we did not read it, which is the entire reason
      // `lock-unacquired` exists — and the sound reasoning was inherited by it because
      // the two shared a `case` list.
      //
      // The interleaving is real: A establishes H1 gone and closes it; B replaces the row
      // with a live H2/G2; A fails to acquire the clear's lock and therefore cannot see B
      // at all; A reports the caller's spawn-permitting finding and a cold spawn starts a
      // third owner. Refusing costs one turn, and the next turn retries with a fresh lock
      // attempt. Permitting costs a second `claude` on a live transcript.
      return { kind: 'undecided', sessionKey, reason: ROW_UNESTABLISHED_REASON }
    case 'cleared':
    case 'absent':
      // READS THAT HAPPENED. The row is ours and now carries no handle, or there was no
      // row — either way the caller's finding stands.
      return whenCleared
  }
}

const ROW_UNESTABLISHED_REASON =
  "the registry row's state could NOT BE ESTABLISHED for this key (the clear's compare-and-set had no lock, or the registry could not be written) — the pane this pass decided about is dealt with, but nothing here rules out another incarnation having claimed this key in the meantime, so no spawn is licensed on the strength of it"

const ROW_MOVED_REASON =
  'the registry row for this key was replaced by another incarnation while this pass was deciding, so ' +
  'nothing it established describes the child that row now names'

/** What a compare-and-clear did. `row-moved` is the one that matters: the row is no
 *  longer the one the caller decided about, so nothing was touched. */
type ClearOutcome = 'cleared' | 'row-moved' | 'absent' | 'error' | 'lock-unacquired'

/**
 * Strip `pane_handle` — but ONLY from the row the caller actually inspected.
 *
 * THE LOCK MAKES THE WRITE ATOMIC WITH RESPECT TO THE ROW; IT DOES NOT MAKE IT ATOMIC
 * WITH RESPECT TO THE DECISION. Every caller here decided from a snapshot taken before
 * a chain of `await`s — an `inspectHandle` round trip, a `/health` probe, a close —
 * and another gateway can complete a whole spawn in that window. An earlier revision
 * re-read the row under the lock (correctly) and then stripped the handle from
 * WHATEVER row now occupied the key:
 *
 *   1. A reads `(H1, G1)` and starts inspecting `H1`.
 *   2. B finishes a spawn and writes `(H2, G2)`.
 *   3. A's inspection answers `gone` — true of `H1`, and irrelevant to `H2`.
 *   4. A strips `H2`.
 *
 * B's live child is then unfindable: no durable handle, so the next boot cannot adopt
 * it and the shutdown gate kills it. The continuity this whole item exists to provide,
 * destroyed by its own cleanup path — and silently, because clearing a handle looks
 * like tidying up.
 *
 * So the write is a COMPARE-AND-CLEAR against the pair the caller inspected. A row that
 * has moved is left exactly as it is and said out loud; the handle it now carries
 * belongs to a child somebody else is responsible for.
 *
 * The generation is compared too, not just the handle: a respawn can reuse a pane id
 * the server reissued, and a handle alone cannot tell those apart.
 */
function clearPaneHandleIfUnchanged(
  registryPath: string,
  sessionKey: string,
  expected: { readonly handle: string; readonly generation: string | undefined },
  deps: BootAdoptionDeps,
): ClearOutcome {
  const log = deps.log ?? defaultLog
  try {
    const clearWrite = withOwnedRegistry(
      registryPath,
      (registry) => {
        // FIRST, BEFORE ANY READING OR WRITING (Argus r21). This check used to sit BELOW
        // the two early returns, so an absent row and a moved row both returned without
        // `skipSave` and `withRegistry` wrote the snapshot back — dropping any row a
        // concurrent incarnation had written in between. The lost update round eighteen
        // fixed, surviving in the two branches that returned early.
        //
        // AND IT CHANGES THE ANSWER, WHICH IS THE HONEST PART. Those two readings came
        // from an UNGUARDED snapshot: without the lock we do not know the row is absent
        // or moved, only that we read something we had no right to trust. So both become
        // `lock-unacquired` — the truthful answer and the fail-closed one — rather than
        // being preserved by checking `acquired` on the write alone.
        //
        // REFUSED RATHER THAN WRITTEN, for the reason the clear exists: without the lock
        // this compare-and-clear is not atomic, and the row it would erase may be one
        // another incarnation has just written for a LIVE pane — stranding it, the
        // unrecoverable direction. A stale row pointing at a pane we did close is the
        // recoverable one: the next boot probes the handle, gets a positive absence, and
        // clears it then.
        const prev = registry[sessionKey]
        if (prev === undefined) return { registry, result: 'absent' as ClearOutcome }
        if (prev.pane_handle !== expected.handle || prev.child_generation !== expected.generation) {
          return { registry, result: 'row-moved' as ClearOutcome }
        }
      // REMOVED, not set to `undefined`: the record type is exact-optional, and a row
      // whose `pane_handle` key is present-but-undefined would serialise to a key the
      // next reader has to special-case. Absent is the only representation of absent.
      //
      // AND THE CLAIM GOES WITH IT (r40). This path runs when the pane is gone or has been
      // closed; a claim left behind would assert that somebody is serving a pane that no
      // longer exists, which is the inherited-claim defect from the other direction.
      registry[sessionKey] = disownPane(prev)
      return { registry, result: 'cleared' as ClearOutcome }
      },
      // See the note above: `absent` and `row-moved` read off an unguarded snapshot are
      // not findings, so every unlocked outcome collapses to this one.
      () => 'lock-unacquired' as ClearOutcome,
    )
    // A CLEAR THAT DID NOT PERSIST CLEARED NOTHING (r48). `cleared` on an unpersisted write
    // would license a cold spawn on a row that still names a live pane, which is the
    // unrecoverable direction this function's own docblock refuses. `absent`/`row-moved` are
    // findings read off a snapshot nobody saved, so they collapse the same way.
    const outcome: ClearOutcome = clearWrite.prevented ? 'lock-unacquired' : clearWrite.result
    if (outcome === 'lock-unacquired') {
      log(
        `row ${sessionKey.slice(0, 32)}: the registry LOCK WAS NOT ACQUIRED, so pane_handle ` +
          `${expected.handle} is LEFT IN PLACE rather than cleared on a non-atomic write. The pane is ` +
          'closed; the next boot probes that handle, gets a positive absence, and clears it then.',
      )
      return outcome
    }
    if (outcome === 'row-moved') {
      const now = getRecord(registryPath, sessionKey)
      log(
        `row ${sessionKey.slice(0, 32)} MOVED while this pass was deciding — it now names pane ` +
          `${now?.pane_handle ?? '<none>'} / generation ${(now?.child_generation ?? '<none>').slice(0, 8)}, not ` +
          `${expected.handle} / ${(expected.generation ?? '<none>').slice(0, 8)}. Left untouched: that handle ` +
          'belongs to a child another incarnation is responsible for.',
      )
      return outcome
    }
    if (outcome === 'cleared') {
      // WHAT IS ON DISK, not what was asked for — the read-back convention this tree
      // keeps, because a write that silently did nothing looks exactly like one that
      // worked.
      const after = getRecord(registryPath, sessionKey)
      if (after !== undefined && after.pane_handle !== undefined) {
        log(
          `row ${sessionKey.slice(0, 32)} STILL carries pane_handle ${after.pane_handle} after a clear — ` +
            `the next boot will re-inspect it`,
        )
      }
    }
    return outcome
  } catch (e) {
    log(`could not clear pane_handle for ${sessionKey.slice(0, 32)}: ${errorText(e)}`)
    return 'error'
  }
}

/**
 * Rebuild a live `ReplSession` around a pane that is already running our child.
 *
 * THE THIRD PROBE HAPPENS HERE, before anything is registered: the dev-channel at the
 * row's recorded port must answer `/health` WITH THIS ROW'S SESSION ID. It is not a
 * formality — it is the only evidence that the half of the REPL we actually inject
 * turns into is alive and is the right one, and `expectedSessionId` exists because a
 * recycled port can serve a different REPL entirely. A pane that fails it is CLOSED,
 * not left: we have established it is our claude on our transcript, so leaving it
 * running while the next turn resumes that transcript would put two owners on it.
 */
async function adoptRow(
  sessionKey: string,
  record: ReplRegistryRecord,
  handle: string,
  options: PersistentReplSubstrateOptions,
  host: AdoptableHost,
  deps: BootAdoptionDeps,
  signal: AbandonSignal,
): Promise<RowAdoptionOutcome> {
  const log = deps.log ?? defaultLog
  const registryPath = options.replRegistryPath
  const generation = record.child_generation
  if (generation === undefined || generation === '') {
    // WITHOUT THE GENERATION THERE IS NO CREDENTIAL. The child presents
    // `HMAC(root token, childGeneration)` and the sink authorises credential →
    // session, so a session registered under a different (or minted) generation can
    // never route this child's replies: it would sit in the pool answering 401 to its
    // own REPL. Close it and let the transcript be resumed cleanly.
    const close = await closeAndClear(
      host,
      handle,
      registryPath,
      sessionKey,
      deps,
      record,
      claudeBasenameFor(options),
    )
    const reason = 'the row carries no child_generation, so this child\'s sink credential cannot be reproduced'
    return outcomeOfClose(close, sessionKey, 'closed-unadoptable', reason)
  }
  const port = record.devchannel_port
  const health = deps.health ?? httpHealth
  if (port === undefined || port <= 0 || !(await health(port, { expectedSessionId: record.sessionId }))) {
    const close = await closeAndClear(
      host,
      handle,
      registryPath,
      sessionKey,
      deps,
      record,
      claudeBasenameFor(options),
    )
    const reason =
      port === undefined || port <= 0
        ? 'the row records no dev-channel port, so there is nothing to inject a turn into'
        : `the dev-channel on port ${port} did not answer /health for session ${record.sessionId.slice(0, 8)}`
    return outcomeOfClose(close, sessionKey, 'closed-unadoptable', reason)
  }

  // ── The child is established. Rebuild around it, in the same order `spawnSession`
  //    builds around a fresh one, and for the same reasons. ──────────────────────

  // THE LAST POINT AT WHICH ADOPTING IS STILL THE RIGHT ACT. The checks above are
  // observations, and past the evidence clock they have stopped describing now: the
  // pane may have died, or been replaced, since we looked. Closing needs no fresh
  // evidence — the identity we established is what licenses it — so that is what a
  // stale pass does.
  if (signal.abandoned) {
    // THE TWO CAUSES WANT OPPOSITE ACTS, and nothing here has registered anything yet,
    // so both are a plain return.
    if (signal.cause === 'shutdown') {
      log(
        `pane ${handle}: this gateway is shutting down mid-verification — LEAVING the pane and the row ` +
          'exactly as they are for the next boot to reconcile',
      )
      return { kind: 'undecided', sessionKey, reason: shutdownAbandonReason('before the attach', signal.boundExpired) }
    }
    const close = await closeAndClear(
      host,
      handle,
      registryPath,
      sessionKey,
      deps,
      record,
      claudeBasenameFor(options),
    )
    const reason = `this verification took longer than the ${BOOT_ADOPTION_BUDGET_MS}ms evidence bound, so what it established is no longer current`
    return outcomeOfClose(close, sessionKey, 'closed-unadoptable', reason)
  }

  // The sink FIRST, on the coordinates the surviving child was baked with (#537):
  // its port is derived per instance and its token is persisted, so this is the same
  // sink the child has been POSTing to all along. Idempotent.
  await sink.ensureStarted({
    ...(options.sinkPort !== undefined ? { port: options.sinkPort } : {}),
    ...(options.sinkTokenPath !== undefined ? { tokenPath: options.sinkTokenPath } : {}),
  })

  // GENERATION RESTORED, INCARNATION FRESH. The generation is the child's identity —
  // its credential derives from it, so it must be exactly what the row says. The
  // incarnation is this OBJECT's identity and is minted anew by the constructor,
  // which is what makes a turn id from before the restart unmatchable against a turn
  // after it: a straggler reply from the old gateway's last turn cannot be accepted
  // as the answer to a new one.
  const session = new ReplSession(sessionKey, generation, record.sessionId, record.channelName, record.cwd)
  session.adopted = true
  session.projectId = options.project_id
  const reuse = record.reuse
  if (reuse === undefined || typeof reuse.tool_surface !== 'string' || typeof reuse.tool_bridge !== 'boolean') {
    // A row from before this field existed, or a malformed one. The warm-reuse guards
    // would then all compare unequal and the first turn would evict what we just
    // adopted — so do not pretend: close it, and let the cold resume happen now
    // rather than one turn later.
    const close = await closeAndClear(
      host,
      handle,
      registryPath,
      sessionKey,
      deps,
      record,
      claudeBasenameFor(options),
    )
    const reason = 'the row carries no usable spawn-time reuse properties, so the first turn would evict this session anyway'
    return outcomeOfClose(close, sessionKey, 'closed-unadoptable', reason)
  }
  session.toolSurface = reuse.tool_surface
  session.toolBridgeActive = reuse.tool_bridge
  session.authFingerprint = typeof reuse.auth_fingerprint === 'string' ? reuse.auth_fingerprint : ''
  // The temp config files this child was spawned with, derived from the channel name
  // the row carries, so the exit path can still unlink them — they hold the child's
  // sink credential in plaintext.
  const cfg = replSessionConfigPaths(record.channelName)
  session.configPaths = reuse.tool_bridge
    ? [cfg.mcpConfigPath, cfg.settingsPath, cfg.toolsManifestPath]
    : [cfg.mcpConfigPath, cfg.settingsPath]
  // The port we just PROVED, and with it `session.ready` — which every turn awaits and
  // which nothing else would ever resolve for an adopted session: `/channel-ready` was
  // POSTed once, to a gateway that no longer exists.
  session.onChannelReady(port)
  // The MCP handshake completed in this child before the restart and is a fact about
  // the CHILD, not about the gateway that watched it. The `/health` answer above is
  // that child speaking.
  session.onChannelBound()

  // Detectors here, THE SINK REGISTRATION NOT UNTIL THE CLAIM (r47's rule, corrected r63 —
  // see `enableAfterClaim`). Registering detectors is inert: nothing can actuate one until
  // output flows, which `beginOutput` gates on the claim. Registering with the SINK is not
  // inert — it makes replies acceptable AND revokes the credential of whoever held this
  // transcript id — so a contender that does it before claiming can strip the winner without
  // ever winning anything itself.
  registerReplDetectors(session, options)

  let liveHandle: LiveProcessHandle | undefined
  let scanChild: PtyChild | undefined
  // THE TRAP (#539, and the one defect here that ACTS rather than fails): every latch
  // is in-memory, so the first screen of an adopted pane would look like a rising edge
  // for whatever is already on it — including a tool-approval prompt the owner was
  // reading, which the auto-approver would answer `1`+Enter. The first screen is
  // therefore a BASELINE and never a stimulus: it fills the ring, primes the latches
  // of everything already present, and fires nothing. Detectors act only on what the
  // pane emits AFTER we arrived, which is the only output this gateway can claim to
  // have caused.
  /**
   * EVERYTHING THIS FUNCTION INSTALLED, TAKEN BACK — then the pane closed.
   *
   * The two halves are separate obligations and both are ours. The registration must
   * go or a credential stays authorised for a session with no child, which is the
   * standing-grant orphan the credential model exists to refuse. And the PANE must go
   * because by this point it has been verified as our child on our transcript: the
   * rule is adopt or close, and "leave it and report a failure" is how a cold spawn
   * ends up as a second owner of a live transcript.
   */
  const unwind = async (reason: string, attached?: PtyChild): Promise<RowAdoptionOutcome> => {
    sink.unregisterIf(record.sessionId, session)
    // AND THE SELF-FENCE TIMER (r49). A path that stops owning leaves no timer behind: it
    // would fire later against a session already released, and until then it holds a
    // reference to it. The round-thirty-one table is one row wider.
    session.selfFenceTimer?.cancel()
    session.selfFenceTimer = undefined
    releaseAdoptionClaim(registryPath, sessionKey, session.paneClaimBy)
    // AND THE SESSION STOPS HOLDING A CLAIM AT ALL (r50). Cancelling the timer is not enough:
    // a cancel cannot un-dispatch a callback that has already fired, and such a callback would
    // otherwise fence a key this gateway had legitimately released — refusing turns for a
    // session nothing was wrong with. A session with no claim has nothing to fence, which
    // makes the timer's residual race harmless rather than merely unlikely.
    session.paneClaimBy = undefined
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    deleteOwnPoolEntry(sessionKey, session)
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    const close = await closeAndClear(
      host,
      handle,
      registryPath,
      sessionKey,
      deps,
      record,
      claudeBasenameFor(options),
    )
    return outcomeOfClose(close, sessionKey, 'closed-unadoptable', reason)
  }

  /**
   * GIVE EVERYTHING BACK WITHOUT TOUCHING THE PANE — the shutdown counterpart of
   * {@link unwind}.
   *
   * Same de-registration, deliberately NOT the close. `unwind` ends the pane because
   * its callers have established that nothing may own this transcript; a shutdown has
   * established the opposite — the row names the pane, and the next boot is the thing
   * that reconciles it. Closing here would destroy the REPL the feature exists to
   * preserve, at the one moment nobody is watching.
   *
   * `undecided`, so nothing reads this as permission to resume the transcript, and so
   * the key is not cached against a later pass.
   */
  const release = (
    at: 'with the attach in flight' | 'at the row claim' | 'while awaiting the baseline',
    attached?: PtyChild,
  ): RowAdoptionOutcome => {
    const reason = shutdownAbandonReason(at, signal.boundExpired)
    sink.unregisterIf(record.sessionId, session)
    // AND THE SELF-FENCE TIMER (r49). A path that stops owning leaves no timer behind: it
    // would fire later against a session already released, and until then it holds a
    // reference to it. The round-thirty-one table is one row wider.
    session.selfFenceTimer?.cancel()
    session.selfFenceTimer = undefined
    releaseAdoptionClaim(registryPath, sessionKey, session.paneClaimBy)
    // AND THE SESSION STOPS HOLDING A CLAIM AT ALL (r50). Cancelling the timer is not enough:
    // a cancel cannot un-dispatch a callback that has already fired, and such a callback would
    // otherwise fence a key this gateway had legitimately released — refusing turns for a
    // session nothing was wrong with. A session with no claim has nothing to fence, which
    // makes the timer's residual race harmless rather than merely unlikely.
    session.paneClaimBy = undefined
    // THE WRAPPER LETS GO OF THE PANE IT KEEPS ALIVE (Argus r26). `HerdrHost.open` starts
    // the poll loop before it returns the child, so a pass abandoned AFTER a completed
    // attach was leaving a live wrapper on a pane it had decided not to own — and the
    // next gateway attaches a second one. The duplicate-wrapper hazard, reached through
    // the deliberately NON-destructive path. `detach?.()` because the contract makes it
    // optional: a backend whose children die with this process has no loop to stop.
    attached?.detach?.()
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    deleteOwnPoolEntry(sessionKey, session)
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    // AND THE LIVE-PROCESS HANDLE (Argus r30, found by the per-structure audit rather than
    // by a gate). It is registered at the adopt path's `registerLiveProcessSafe` and
    // released by ONE thing: `child-exit-wiring`'s exit handler calling `unregister()`.
    // `unwind` does not need to do it — that path CLOSES the pane, the child exits, and the
    // handler fires. This path is the opposite: the pane is left running and the wrapper is
    // detached, so `exited` never resolves and the handler never runs. On a real shutdown
    // the process is going away and the registry is in-memory, so it costs nothing; on the
    // in-process restart this detach exists for, the retired handle would stay registered
    // and the next adoption would add a second entry for the same pid. An attribution
    // defect rather than a corruption one, and there is no reason to leave it.
    session.liveHandle?.unregister()
    log(`pane ${handle}: ${reason} — registrations released, pane and row left alone`)
    return { kind: 'undecided', sessionKey, reason }
  }

  /** {@link release} with an explicit sentence rather than an abandonment cause — the
   *  give-back is the same, and only the reason differs. */
  const releaseWithReason = (reason: string, attached?: PtyChild): RowAdoptionOutcome => {
    sink.unregisterIf(record.sessionId, session)
    // AND THE SELF-FENCE TIMER (r49). A path that stops owning leaves no timer behind: it
    // would fire later against a session already released, and until then it holds a
    // reference to it. The round-thirty-one table is one row wider.
    session.selfFenceTimer?.cancel()
    session.selfFenceTimer = undefined
    releaseAdoptionClaim(registryPath, sessionKey, session.paneClaimBy)
    // AND THE SESSION STOPS HOLDING A CLAIM AT ALL (r50). Cancelling the timer is not enough:
    // a cancel cannot un-dispatch a callback that has already fired, and such a callback would
    // otherwise fence a key this gateway had legitimately released — refusing turns for a
    // session nothing was wrong with. A session with no claim has nothing to fence, which
    // makes the timer's residual race harmless rather than merely unlikely.
    session.paneClaimBy = undefined
    // Same hand-over as {@link release} — see the note there.
    attached?.detach?.()
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    deleteOwnPoolEntry(sessionKey, session)
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    // AND THE LIVE-PROCESS HANDLE (Argus r30, found by the per-structure audit rather than
    // by a gate). It is registered at the adopt path's `registerLiveProcessSafe` and
    // released by ONE thing: `child-exit-wiring`'s exit handler calling `unregister()`.
    // `unwind` does not need to do it — that path CLOSES the pane, the child exits, and the
    // handler fires. This path is the opposite: the pane is left running and the wrapper is
    // detached, so `exited` never resolves and the handler never runs. On a real shutdown
    // the process is going away and the registry is in-memory, so it costs nothing; on the
    // in-process restart this detach exists for, the retired handle would stay registered
    // and the next adoption would add a second entry for the same pid. An attribution
    // defect rather than a corruption one, and there is no reason to leave it.
    session.liveHandle?.unregister()
    log(`pane ${handle}: ${reason} — registrations released, pane and row left alone`)
    return { kind: 'undecided', sessionKey, reason }
  }

  /** Minted once per pass: the value that distinguishes this claimant from any other,
   *  and the value every give-back path CASes against. */
  const claimIdentity = randomUUID()
  session.paneClaimBy = claimIdentity
  /** The instant the claim is stamped into the row — ALSO this session's first confirmed
   *  ownership, so the self-fencing deadline starts from the same origin the takeover
   *  threshold is measured from rather than from an unrelated clock read. */
  const claimTakenAt = (deps.now ?? Date.now)()

  let primed = false
  let baselineResolve: ((observed: boolean) => void) | undefined
  const baselineObserved = new Promise<boolean>((resolve) => {
    baselineResolve = resolve
  })
  /** Set only when the durable claim has succeeded — the gate the ordering invariant names.
   *  Everything that can READ the pane or WRITE to it is behind this. */
  let claimConfirmed = false
  let child: PtyChild
  try {
    child = await host.attach(handle, {
      cwd: record.cwd,
      env: {},
      onScreen: (screen) => {
        // THE ORDERING INVARIANT, ENFORCED AT THE HANDLER (see the module docblock). Not
        // only by withholding `beginOutput()`: that relies on the HOST honouring the
        // contract, and this is the one place where a screen arriving early can be ANSWERED
        // by a detector — `1`+Enter into a session another gateway owns. Until the claim is
        // confirmed this wrapper is blind and mute: nothing is recorded, nothing is primed,
        // nothing is scanned.
        if (!claimConfirmed || (!primed && screen.trim().length === 0)) return
        session.ring.replace(screen)
        const now = Date.now()
        session.lastDataAt = now
        liveHandle?.touch()
        if (!primed) {
          primed = true
          const silenced = session.scanner.primeLatches(session.ring.text(), now)
          log(
            `adopted pane ${handle} baseline screen: ${silenced.length} detector(s) already present and now latched` +
              (silenced.length > 0 ? ` [${silenced.join(', ')}]` : '') +
              ' — they cannot fire until they fall and rise again',
          )
          baselineResolve?.(true)
          baselineResolve = undefined
          // FALLS THROUGH TO THE SCAN DELIBERATELY, and the fall-through is provably
          // inert: `scan` fires only on a rising edge, every signature present in this
          // very screen was just latched by the line above, and both read the same
          // ring. Returning early here would look safer and would hide which mechanism
          // is actually holding the line — so the priming carries the whole weight,
          // and a mutation to it reddens `adopted-pane-latches.test.ts` rather than
          // being masked by a second guard.
        }
        const target = scanChild
        if (target === undefined) return
        runOutputScan(session, target, options, now)
      },
    })
  } catch (e) {
    // The attach failed, so nothing is attached — but we ALREADY registered the
    // session, which would leave a credential authorised for a session with no child.
    // And the pane itself is still running, still verified as ours: by the rule this
    // module keeps, it is adopted or CLOSED, never left for a cold spawn to race.
    return await unwind(`attach to pane ${handle} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  // CHECKED AGAIN, AFTER THE AWAIT. The attach is a socket round trip and the budget
  // can expire inside it — the window between the check above and this line is the
  // one thing that check cannot cover.
  if (signal.abandoned) {
    // THE ATTACH-SIDE CHECK, and it is not redundant with the publish-side one. This is
    // the window a second pass can race: the pane is attached and nothing has claimed
    // the row yet, so a publish-only check would leave exactly this gap open.
    if (signal.cause === 'shutdown') {
      return release('with the attach in flight', child)
    }
    return await unwind('the evidence bound elapsed while the attach was in flight', child)
  }
  scanChild = child
  session.attachChild(child)
  try {
    // THE LIVE-PROCESS REGISTRATION IS ALSO A DISPLACING CAPABILITY, so it waits for the claim
    // too (r63, the second one the capability enumeration found).
    //
    // `registerLiveProcessSafe` unregisters whatever holds the name first
    // (`tools/process-registry.ts`), and the name is the SESSION KEY — so a contender that
    // registered here, before it claimed, removed the winner's record; and `unregister` is
    // guarded on the pid, which in an adoption is the SAME pane process, so the contender's own
    // release then deleted the record it had displaced. Net effect: the winner serves with no
    // entry in the process registry, so the crashed-agent watchdog can never report its death —
    // the ~170-minute lag this change exists to remove, reintroduced by a pass that lost.
    //
    // Moved into `enableAfterClaim` below. The exit wiring reads it through a late-bound
    // closure (`liveHandle: () => liveHandle`), so registering later is transparent to it, and
    // an unwind before the claim finds nothing to unregister — which is correct, because
    // nothing was registered.
    wireChildExit({
      session,
      child,
      sessionKey,
      sessionId: record.sessionId,
      liveHandle: () => liveHandle,
      label: 'boot-adoption.exit',
      registryPath,
    })
    // DELIVERY AND THE WATCHERS ARE NOT STARTED HERE ANY MORE (Argus r47). They are the
    // moment this wrapper becomes CAPABLE of reading the pane and answering it, and the
    // ordering invariant puts that after the claim, not before. They now run inside
    // `publish` below — see the module docblock.
  } catch (e) {
    // A WATCHER THAT WOULD NOT START MUST NOT STRAND A LIVE CHILD. Everything between
    // the attach and the pool insert can throw — a host's `beginOutput`, a watcher
    // whose transcript path is unreadable — and until `pool.set` runs, nothing owns
    // this session: the next turn would spawn over a child that is attached,
    // registered and invisible. Unwind, close, and say what happened.
    return await unwind(
      `wiring the adopted session failed: ${e instanceof Error ? e.message : String(e)}`,
      child,
    )
  }

  /**
   * TURN THE EYES AND HANDS ON. Called ONLY after the claim has succeeded, which is what
   * the ordering invariant requires: before this returns, a delivered screen is neither
   * recorded nor scanned, and no detector can answer one.
   */
  const enableAfterClaim = (): void => {
    claimConfirmed = true
    // THE PROCESS REGISTRY, now that this pass owns the row (r63). Ordered before the sink
    // registration for no reason except that the watchdog's view should exist by the time
    // replies can arrive.
    liveHandle = registerLiveProcessSafe({
      name: sessionKey,
      pid: child.pid,
      tool_name: 'cc-repl',
      meta: { session_id: record.sessionId, channel: record.channelName },
    })
    session.liveHandle = liveHandle
    // THE POOL MIRROR IS ALSO A DISPLACING CAPABILITY, and it was the one member of this
    // class the r63 enumeration missed. `childByKey` is process-wide and keyed by the
    // SESSION KEY, which two adoption passes for one row share, and the `set` is an
    // unconditional overwrite. Written before the claim, a losing contender overwrote the
    // winner's mirror and then its own give-back deleted the key — `release`,
    // `releaseWithReason` and `unwind` each delete iff the entry is still the child they
    // are releasing, which after the overwrite it is. Net: the winner's mirror was gone
    // rather than restored, and `killChild` (`supervision.ts`) then found no mirror and
    // fell through to the slower cross-restart orphan path. One owner still held, so this
    // was a degraded kill route rather than a second owner — which is why it is fixed here
    // rather than having blocked the merge. The exact slot within this function is
    // immaterial; what matters is that it is inside it.
    childByKey.set(sessionKey, child)
    // THE SINK REGISTRATION IS A CAPABILITY, AND IT IS THE ONE THAT REVOKES (r63). It belongs
    // behind the claim like the eyes and hands: it is what makes this child's replies
    // acceptable, and taking it displaces whoever held this transcript id. Behind the claim
    // that displacement is a TAKEOVER — we own the row, the holder has lost it and its own
    // renewal will fence it. Before the claim it was a revocation by a contender that had won
    // nothing, which is the defect this move fixes.
    sink.register(record.sessionId, session)
    // Only NOW may screens flow: the scan target and the activity handle both exist, and the
    // row has confirmed this child is ours to drive.
    child.beginOutput?.()

    const projectsDir = options.projectsDir
    session.deadTurnWatcher = startApi5xxDeadTurnWatcher({
      jsonlPath: sessionJsonlPath(record.sessionId, record.cwd, projectsDir),
      notify:
        options.onDeadTurnNotice ??
        ((notice: DeadTurnNotice): void => {
          process.stderr.write(
            `[repl-api5xx] dead turn on session=${record.sessionId.slice(0, 8)} matched=${notice.matched} — user should resend last message\n`,
          )
        }),
    })
    session.sizeWatchdog = startSessionSizeWatchdog({
      readSize: () => measurePostCompactSize(sessionJsonlPath(record.sessionId, record.cwd, projectsDir)),
      surface: (severity, sizeBytes) => surfaceSizeAlert(session, sessionKey, severity, sizeBytes, options),
      writeKey: (key) => child.writeKey?.(key),
      write: (data) => child.write(data),
      isIdle: () =>
        session.activeTurn === undefined &&
        Date.now() - session.lastDataAt >= (options.sizeCompactIdleQuiesceMs ?? SESSION_COMPACT_IDLE_QUIESCE_MS),
      ...(options.sizeCheckIntervalMs !== undefined ? { intervalMs: options.sizeCheckIntervalMs } : {}),
    })

  }

  // CLAIM THE ROW, THEN PUBLISH — one act, and the only place this function can answer
  // `adopted` from. If the row was replaced while this pass was inspecting, probing and
  // attaching, the child we hold is a SECOND owner of that transcript: the durable row
  // names the one that should serve it, so ours is given back rather than served.
  return await claimRowOrUnwind({
    registryPath,
    sessionKey,
    expected: { handle, generation },
    pid: child.pid,
    recordedPid: record.pid,
    // THIS PASS'S OWN IDENTITY, minted once above and recorded on the session so every
    // path that stops owning it can give the claim back.
    incarnation: claimIdentity,
    now: claimTakenAt,
    claimantPid: deps.claimantPid ?? process.pid,
    deps,
    publish: async () => {
      // THE PUBLISH-SIDE CHECK. The row claim is an await, so the shutdown can arrive
      // inside it; publishing into a pool that has already been drained would reinstall
      // this key behind the teardown's back.
      if (signal.abandoned && signal.cause === 'shutdown') {
        return release('at the row claim', child)
      }
      // CONFIRMED AT THE CLAIM. The compare-and-set above succeeded, which is the same
      // evidence a renewal produces — so the self-fencing deadline runs from here.
      session.paneClaimConfirmedAt = claimTakenAt
      // AND THE AUTONOMOUS FENCE IS ARMED FROM THE SAME INSTANT (r49) — not from the first
      // tick, which a stalled gateway never reaches.
      if (registryPath !== undefined) armSelfFence(registryPath, sessionKey, session, log)
      // AND ONLY NOW IS THIS WRAPPER ALLOWED TO SEE OR TOUCH THE PANE (Argus r47). A
      // watcher that will not start still must not strand a live child, so the same unwind
      // the pre-claim wiring had applies — it just runs on the other side of the claim now.
      try {
        enableAfterClaim()
      } catch (e) {
        return await unwind(
          `wiring the adopted session failed after the claim: ${e instanceof Error ? e.message : String(e)}`,
          child,
        )
      }
      // ATTACHED IS NOT OBSERVABLE. `attach()` proves only that a wrapper could be
      // constructed; adoption requires one real screen to reach the detector baseline.
      // A pane that vanishes or never yields a readable screen is closed and cleared so
      // the waiting dispatch can cold-resume instead of publishing a blind session.
      let observed = primed
      if (!primed) {
        let baselineTimer: ReturnType<typeof setTimeout> | undefined
        observed = await Promise.race([
          baselineObserved,
          child.exited.then(() => false),
          new Promise<false>((resolve) => {
            baselineTimer = setTimeout(() => resolve(false), deps.baselineMs ?? BOOT_ADOPTION_BASELINE_MS)
          }),
        ])
        if (baselineTimer !== undefined) clearTimeout(baselineTimer)
      }
      if (signal.abandoned) {
        if (signal.cause === 'shutdown') return release('while awaiting the baseline', child)
        return await unwind('the evidence bound elapsed awaiting the baseline', child)
      }
      if (!baselineAllowsAdoption(observed)) {
        return await unwind('the attached pane yielded no observable baseline screen', child)
      }
      if (child.hasExited()) return await unwind('the pane exited before publication', child)
      // PUBLISHED, AND THE SESSION REMEMBERS WHAT IT WAS PUBLISHED AS (r55) — the promise its
      // teardown will compare the map against.
      //
      // WHY THIS PUBLISH IS NOT IDENTITY-GUARDED, and the licence for it, written here because
      // the ownership model's rule for R2 is "only the turn whose own entry it is" and this
      // line looks like an exception to it (divergence D4 on the r59 walk).
      //
      // It is the WINNER'S publish: the compare-and-set above succeeded, so the durable row —
      // the authority — names this pass. Any entry sitting under this key belongs to a session
      // whose claim we have just taken; it cannot renew (the row names us), so it stops serving
      // on its own evidence within one self-fence deadline, which is the mechanism rule 5
      // exists to provide. Refusing to publish would be worse in both directions: this gateway
      // would hold a row it does not serve, and the key would keep resolving to a session that
      // has already lost it.
      //
      // WHAT IS NOT DONE HERE, deliberately: fencing the displaced session. `fencedKeys` is
      // keyed by SESSION KEY and is never cleared in this process, so fencing here would
      // permanently refuse the key we have just adopted — the remedy would cost more than the
      // defect. No interleaving reaching this line with a foreign entry is known today (the
      // spawn gate serialises a key's pass against its spawns); if one is ever found, the fix
      // is to fence the displaced SESSION without marking the key.
      const published = Promise.resolve(session)
      session.pooledAs = published
      pool.set(sessionKey, published)
      return { kind: 'adopted', sessionKey, paneHandle: handle, childGeneration: generation }
    },
    unwind: (reason) => unwind(reason, child),
    release: (reason) => releaseWithReason(reason, child),
  })
}

/** Fire this key's pass without awaiting it, for the wiring site that is synchronous
 *  (the substrate factory). The gate is what everything else waits on. */
export function startBootAdoption(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  deps: BootAdoptionDeps = {},
): void {
  fireAndForget('boot-adoption', beginBootAdoption(options, sessionKey, deps).then(() => undefined))
}
