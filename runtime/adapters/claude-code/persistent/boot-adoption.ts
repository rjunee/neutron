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
 *   - `beginBootAdoption` runs once per registry path, started by the same block that
 *     arms the watchdog (`adapters/claude-code/index.ts`);
 *   - `awaitBootAdoption` gates the watchdog tick, the boot drain AND
 *     `getOrSpawnSession`. A turn that arrives during the pass waits for it; the pass
 *     is bounded so the wait is too.
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
 */

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { registerLiveProcessSafe } from '@neutronai/tools/process-registry.ts'
import type { LiveProcessHandle } from '@neutronai/tools/process-registry.ts'
import { startApi5xxDeadTurnWatcher, type DeadTurnNotice } from './api5xx-dead-turn-watcher.ts'
import { wireChildExit } from './child-exit-wiring.ts'
import { herdrHost } from './herdr-host.ts'
import {
  adoptOrKillOrphan,
  basenameOf,
  defaultListProcesses,
  identifyOrphanPid,
  scanTranscriptOwners,
  classifyPaneForAdoption,
  cmdlineMatchesSession,
  defaultReadCmdline,
  type OrphanAdoptionDeps,
  type OrphanAdoptionVerdict,
  type ProcessListing,
} from './orphan-adoption.ts'
import { childByKey, pool, sink } from './pool-state.ts'
import { hostSupportsAdoption, type AdoptableHost, type HandleInspection, type PtyChild } from './pty-host.ts'
import {
  getRecord,
  loadRegistry,
  normaliseRecord,
  readRegistryState,
  withRegistry,
  withRegistryRead,
  type ReplRegistryRecord,
} from './repl-registry.ts'
import { ReplSession, httpHealth, terminatePidGracefully } from './repl-session.ts'
import { replSessionConfigPaths } from './session-config-paths.ts'
import {
  SESSION_COMPACT_IDLE_QUIESCE_MS,
  defaultIsPidAlive,
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

/** Injection seams. Production supplies none of them. */
export interface BootAdoptionDeps {
  /** The host to ask. Defaults to `options.ptyHost ?? herdrHost`. */
  host?: unknown
  /** `/health` probe. Defaults to the real one. */
  health?: (port: number, opts: { expectedSessionId?: string; timeoutMs?: number }) => Promise<boolean>
  /** The pid-table fallback for a pane the host could not speak for. */
  orphanDeps?: (record: ReplRegistryRecord, claudeBasename: string) => OrphanAdoptionDeps
  /** The whole-machine process listing behind {@link scanTranscriptOwners}. Defaults
   *  to the real `ps`; a case injects one so "somebody else owns this transcript" is
   *  reachable without starting a second claude. */
  listProcesses?: () => ProcessListing[] | undefined
  /** Diagnostics sink. Defaults to stderr. */
  log?: (msg: string) => void
  budgetMs?: number
}

/**
 * The shutdown abandonment reason, WITH THE POINT IT WAS TAKEN AT.
 *
 * One shared sentence for the disposition, so a reader can grep it, and a distinct
 * clause for WHERE — because the three sites are three different branches and an
 * earlier revision gave all of them identical text. Identical text means no test can
 * tell which one ran: a case named for the attach-side check passes when the pre-attach
 * check fired instead, and says it proved something it did not. The same collapse this
 * tree keeps paying for, in a string.
 */
/** The claim could not be established because the lock was not held. Distinct from
 *  {@link ROW_MOVED_REASON}: "someone else owns this row" is a finding, and "I could not
 *  find out who owns it" is the absence of one. */
const LOCK_UNACQUIRED_REASON =
  'the registry lock was NOT acquired for this adoption\'s row claim, so the compare-and-set was not atomic — the pane is left running and the row left alone, and the next boot reconciles it'

const shutdownAbandonReason = (
  at: 'before the attach' | 'with the attach in flight' | 'at the row claim',
  boundExpired = false,
): string =>
  boundExpired
    ? `the evidence bound expired AND the gateway then shut down ${at} — the SHUTDOWN is the operative cause, so the pane is left running: the row still names it and the next boot reconciles it on fresh evidence`
    : `the gateway shut down ${at} — the pane is still running and the row still names it, so the next boot reconciles it`

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
 *     names the pane and the next boot reconciles it, so the pane is LEFT ALONE — a
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
  readonly promise: Promise<RowAdoptionOutcome>
  readonly signal: AbandonSignal
  /** Mirrored synchronously so {@link resetBootAdoption} can tell a finished pass from
   *  one still in flight WITHOUT awaiting anything — it runs on a shutdown path that
   *  must not block. */
  settled: boolean
}

const passes = new Map<string, Map<string, PassHandle>>()

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
  let forRegistry = passes.get(registryPath)
  if (forRegistry === undefined) {
    forRegistry = new Map()
    passes.set(registryPath, forRegistry)
  }
  const live = forRegistry.get(sessionKey)
  if (live !== undefined) return live.promise
  const signal: AbandonSignal = { abandoned: false, cause: null, boundExpired: false }
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
  // THE BUDGET IS ARMED HERE, not inside the pass, so it bounds the WAIT rather than
  // the work: the pass runs to completion either way (and closes rather than adopts
  // once abandoned), while the gate stops blocking.
  // THE EVIDENCE CLOCK. It does not interrupt anything and it does not release the
  // gate — see {@link BOOT_ADOPTION_BUDGET_MS}. It marks the pass, so that a
  // verification which is still in flight this long after it started ends in a CLOSE
  // rather than in an adoption built on observations that are no longer current.
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
  const handle: PassHandle = { promise: undefined as unknown as Promise<RowAdoptionOutcome>, signal, settled: false }
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
      // going away, the row still names the pane, and the next boot visits that row and
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
): Promise<void> {
  const inFlight = [...passes.values()].flatMap((m) => [...m.values()]).filter((h) => !h.settled)
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
        'Their panes are LEFT RUNNING: the rows name them and the next boot reconciles them.',
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
}

/** Drop every pass, in flight or not. For test isolation ONLY — production uses
 *  {@link resetBootAdoption}, which keeps in-flight passes for the reason its docblock
 *  gives. A suite that leaks a pending pass into the next file would otherwise see a
 *  key it never created. */
export function resetBootAdoptionForTests(): void {
  passes.clear()
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
  if (record === undefined || record.pane_handle === undefined) {
    return { kind: 'no-handle', sessionKey }
  }

  const hostCandidate = deps.host ?? options.ptyHost ?? herdrHost
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
      readCmdline: defaultReadCmdline,
      terminatePid: (pid: number) =>
        terminatePidGracefully(pid, () =>
          cmdlineMatchesSession(defaultReadCmdline(pid), record.sessionId, claudeBasename),
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
  readonly deps: BootAdoptionDeps
  /** Install the session and answer `adopted`. Runs ONLY if the row is still ours. */
  readonly publish: () => RowAdoptionOutcome
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
  if (args.registryPath === undefined) return args.publish()
  const registryPath = args.registryPath
  /** What the claim's critical section concluded. THREE, not a boolean: the row is ours,
   *  the row moved, or we never held the lock — and the third must not be able to reach
   *  the code that writes. */
  type ClaimResult = 'ours' | 'row-moved' | 'lock-unacquired'
  let claim: ClaimResult
  // THE CLAIM IS A COMPARE-AND-SET, AND A CAS IS ONLY A CAS WHILE THE LOCK HOLDS
  // (Argus r14). `withFlockSync` deliberately runs unguarded when FFI is missing or
  // `flock` returns nonzero, and both look exactly like success to a caller that does not
  // ask. Unguarded, two incarnations read this row, both find it matching, and both
  // publish an attached owner — two owners of one live transcript, the single outcome
  // this module exists to prevent. Round eight gave the shutdown decision this treatment;
  // the claim is its neighbour and inherited nothing.
  let acquired = false
  try {
    claim = withRegistry<ClaimResult>(
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
        // NO WRITE AT ALL, not "write the same thing back". Without `skipSave` this
        // returns the snapshot loaded before the callback ran and `withRegistry` saves
        // it — dropping any row a concurrent incarnation wrote in between. A lost update
        // performed by the branch that refuses to act because it did not get the lock.
        if (!acquired) return { registry, result: 'lock-unacquired' as ClaimResult, skipSave: true }
        const prev = registry[args.sessionKey]
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
        if (args.recordedPid !== args.pid) registry[args.sessionKey] = { ...prev, pid: args.pid }
        return { registry, result: 'ours' as ClaimResult }
      },
      {},
      (ok) => {
        acquired = ok
      },
    )
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
  return args.publish()
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
  let acquired = false
  try {
    const outcome = withRegistry(
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
        if (!acquired) {
          return { registry, result: 'lock-unacquired' as ClearOutcome, skipSave: true }
        }
        const prev = registry[sessionKey]
        if (prev === undefined) return { registry, result: 'absent' as ClearOutcome }
        if (prev.pane_handle !== expected.handle || prev.child_generation !== expected.generation) {
          return { registry, result: 'row-moved' as ClearOutcome }
        }
      // REMOVED, not set to `undefined`: the record type is exact-optional, and a row
      // whose `pane_handle` key is present-but-undefined would serialise to a key the
      // next reader has to special-case. Absent is the only representation of absent.
      const { pane_handle: _gone, ...rest } = prev
      registry[sessionKey] = rest
      return { registry, result: 'cleared' as ClearOutcome }
      },
      {},
      (ok) => {
        acquired = ok
      },
    )
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

  // Detectors, then the sink registration, then the attach — the same order, and the
  // same reason, as the spawn path: the child can POST at any instant, and a
  // registration that lands after the first POST is a 401 on a reply we asked for.
  registerReplDetectors(session, options)
  sink.register(record.sessionId, session)

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
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    pool.delete(sessionKey)
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
    at: 'with the attach in flight' | 'at the row claim',
    attached?: PtyChild,
  ): RowAdoptionOutcome => {
    const reason = shutdownAbandonReason(at, signal.boundExpired)
    sink.unregisterIf(record.sessionId, session)
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    pool.delete(sessionKey)
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    log(`pane ${handle}: ${reason} — registrations released, pane and row left alone`)
    return { kind: 'undecided', sessionKey, reason }
  }

  /** {@link release} with an explicit sentence rather than an abandonment cause — the
   *  give-back is the same, and only the reason differs. */
  const releaseWithReason = (reason: string, attached?: PtyChild): RowAdoptionOutcome => {
    sink.unregisterIf(record.sessionId, session)
    if (attached !== undefined && childByKey.get(sessionKey) === attached) childByKey.delete(sessionKey)
    pool.delete(sessionKey)
    session.sizeWatchdog?.stop()
    session.deadTurnWatcher?.stop()
    log(`pane ${handle}: ${reason} — registrations released, pane and row left alone`)
    return { kind: 'undecided', sessionKey, reason }
  }

  let primed = false
  let child: PtyChild
  try {
    child = await host.attach(handle, {
      cwd: record.cwd,
      env: {},
      onScreen: (screen) => {
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
  childByKey.set(sessionKey, child)
  try {
    liveHandle = registerLiveProcessSafe({
      name: sessionKey,
      pid: child.pid,
      tool_name: 'cc-repl',
      meta: { session_id: record.sessionId, channel: record.channelName },
    })
    session.liveHandle = liveHandle
    wireChildExit({
      session,
      child,
      sessionKey,
      sessionId: record.sessionId,
      liveHandle: () => liveHandle,
      label: 'boot-adoption.exit',
    })
    // Only NOW may screens flow: the scan target and the activity handle both exist.
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

    // The pool insert is the LAST thing, and it is now inside the row claim below:
    // being in the pool is what makes this session servable, and it must not become
    // servable until the durable row has been confirmed to still name THIS child.
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
    deps,
    publish: () => {
      // THE PUBLISH-SIDE CHECK. The row claim is an await, so the shutdown can arrive
      // inside it; publishing into a pool that has already been drained would reinstall
      // this key behind the teardown's back.
      if (signal.abandoned && signal.cause === 'shutdown') {
        return release('at the row claim', child)
      }
      pool.set(sessionKey, Promise.resolve(session))
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
