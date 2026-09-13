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
import { getRecord, loadRegistry, withRegistry, type ReplRegistryRecord } from './repl-registry.ts'
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

const defaultLog = (msg: string): void => {
  process.stderr.write(`[repl-adopt] ${msg}\n`)
}

/** Set once the gate has stopped waiting for a pass. See {@link BOOT_ADOPTION_BUDGET_MS}. */
interface AbandonSignal {
  abandoned: boolean
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
 * substrate this process has not constructed are left alone — their panes keep
 * running, and the pre-existing `#105` orphan path in the watchdog still covers them
 * if one of them turns out to be wedged.
 */
const passes = new Map<string, Map<string, Promise<RowAdoptionOutcome>>>()

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
  if (live !== undefined) return live
  const signal: AbandonSignal = { abandoned: false }
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
    if (signal.abandoned) return
    signal.abandoned = true
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
  const gated = started.then((outcome) => {
    clearTimeout(timer)
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
  forRegistry.set(sessionKey, gated)
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
    if (one !== undefined) await one
    return
  }
  await Promise.allSettled([...forRegistry.values()])
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

/**
 * Forget every pass.
 *
 * Called by `shutdownAllPersistentRepls`, which tears the module state down so a
 * later boot in the SAME process (tests, an in-process restart) reconciles again
 * instead of reading a resolved promise from the incarnation before it. A stale
 * resolved gate is the dangerous shape here: it releases instantly and says a pane
 * was dealt with by a gateway that no longer exists.
 */
export function resetBootAdoption(): void {
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
  signal: AbandonSignal = { abandoned: false },
): Promise<RowAdoptionOutcome> {
  const log = deps.log ?? defaultLog
  const registryPath = options.replRegistryPath
  if (registryPath === undefined) return { kind: 'no-handle', sessionKey }
  const record = getRecord(registryPath, sessionKey)
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
    return clearPaneHandleIfUnchanged(
      registryPath,
      sessionKey,
      { handle, generation: record.child_generation },
      deps,
    ) === 'row-moved'
      ? { kind: 'row-moved' }
      : { kind: 'closed' }
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
  try {
    await host.closeHandle(handle)
  } catch (e) {
    log(`pane ${handle} could NOT be closed (${errorText(e)}) — it is still running`)
    return { kind: 'failed', reason: 'the close FAILED' }
  }
  if (registryPath === undefined) return { kind: 'closed' }
  return clearPaneHandleIfUnchanged(
    registryPath,
    sessionKey,
    { handle, generation: record.child_generation },
    deps,
  ) === 'row-moved'
    ? { kind: 'row-moved' }
    : { kind: 'closed' }
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
  return { kind: 'undecided', sessionKey, reason: `${reason}; and ${close.reason}` }
}

/** What {@link closeAndClear} did. THREE, not a boolean: "it is gone", "the close
 *  failed" and "I would not close it on this evidence" are different facts, and only
 *  the first licenses a resume. */
type CloseOutcome =
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'unverified'; readonly reason: string }
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
  if (cleared === 'row-moved') {
    return { kind: 'undecided', sessionKey, reason: ROW_MOVED_REASON }
  }
  // `cleared`, `absent` and `error` all leave the caller's finding standing: the pane
  // this pass decided about is gone either way, and a registry that could not be
  // written is a stale handle the NEXT boot re-inspects — not a live owner.
  return whenCleared
}

const ROW_MOVED_REASON =
  'the registry row for this key was replaced by another incarnation while this pass was deciding, so ' +
  'nothing it established describes the child that row now names'

/** What a compare-and-clear did. `row-moved` is the one that matters: the row is no
 *  longer the one the caller decided about, so nothing was touched. */
type ClearOutcome = 'cleared' | 'row-moved' | 'absent' | 'error'

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
    const outcome = withRegistry(registryPath, (registry) => {
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
    })
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

    // In the pool LAST, because being in the pool is what makes this session servable:
    // until every line above has run, a turn that found it here would inject into a
    // session whose exit wiring, watchers or scan target were still missing.
    pool.set(sessionKey, Promise.resolve(session))
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

  // WHAT THE ROW NOW HOLDS, read back, not what we asked it to hold. The pid is the
  // one field adoption can legitimately correct — the child is the same process, so a
  // disagreement means the row was stale, and a stale pid is what every liveness probe
  // above here uses.
  //
  // AND ONLY ONTO THE ROW THIS PASS ADOPTED FROM. Same hazard as the handle clear: the
  // decision came from a snapshot taken before the inspection, the health probe and the
  // attach, and another incarnation can have written a whole new child into this key
  // meanwhile. Writing our pid over THAT row would point every liveness probe at a
  // process belonging to a different child.
  if (registryPath !== undefined && record.pid !== child.pid) {
    try {
      const wrote = withRegistry(registryPath, (registry) => {
        const prev = registry[sessionKey]
        if (
          prev === undefined ||
          prev.pane_handle !== handle ||
          prev.child_generation !== generation
        ) {
          return { registry, result: false }
        }
        registry[sessionKey] = { ...prev, pid: child.pid }
        return { registry, result: true }
      })
      if (!wrote) {
        log(
          `row ${sessionKey.slice(0, 32)} moved while this adoption was running — NOT writing pid ${child.pid} ` +
            'over it; the row now describes a child this pass did not adopt',
        )
      } else {
        const after = getRecord(registryPath, sessionKey)
        if (after?.pid !== child.pid) {
          log(
            `row ${sessionKey.slice(0, 32)} still records pid ${String(after?.pid)} after adopting pid ${child.pid} — ` +
              'liveness probes will ask about the wrong process',
          )
        }
      }
    } catch (e) {
      log(`could not update pid for ${sessionKey.slice(0, 32)}: ${errorText(e)}`)
    }
  }
  return { kind: 'adopted', sessionKey, paneHandle: handle, childGeneration: generation }
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
