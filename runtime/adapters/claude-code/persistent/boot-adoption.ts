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
  classifyPaneForAdoption,
  cmdlineMatchesSession,
  defaultReadCmdline,
  type OrphanAdoptionDeps,
} from './orphan-adoption.ts'
import { childByKey, pool, sink } from './pool-state.ts'
import { hostSupportsAdoption, type AdoptableHost, type PtyChild } from './pty-host.ts'
import { getRecord, loadRegistry, patchRecord, withRegistry, type ReplRegistryRecord } from './repl-registry.ts'
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
 * The bound on the gate a turn can wait behind.
 *
 * IT IS A WATCHDOG OVER A COMPOSITION OF BOUNDS, NOT THE BOUND ITSELF, and the
 * difference matters because presenting one as the other is how a number stops
 * describing anything. Each step already has its own deadline — the herdr client
 * refuses an unanswered RPC at 10 s, the pid wait at 5 s, the `/health` probe at 2 s —
 * so the real worst case is their SUM on a pathological server, which is longer than
 * this. This exists so that a composition that somehow exceeds its parts still
 * releases the gate, and it is deliberately generous: the thing it is trading against
 * is two `claude` processes on one transcript, which is worse than a slow first turn.
 *
 * ON EXPIRY THE PASS DOES NOT ADOPT. It is marked abandoned, and a verification still
 * in flight converts to a CLOSE rather than an adoption — because once the gate has
 * released, something else may already have cold-resumed that transcript, and the
 * surviving pane has become the second owner.
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
  const budgetMs = deps.budgetMs ?? BOOT_ADOPTION_BUDGET_MS
  const timer = setTimeout(() => {
    if (signal.abandoned) return
    signal.abandoned = true
    ;(deps.log ?? defaultLog)(
      `boot adoption for key=${sessionKey.slice(0, 32)} exceeded ${budgetMs}ms — releasing the spawn gate. ` +
        'A verification still in flight will CLOSE the pane rather than adopt it, because a cold spawn may ' +
        'now own that transcript.',
    )
  }, budgetMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  // THE STORED PROMISE IS THE ONE THAT CLEARS THE TIMER, so there is no second,
  // unobserved promise to leak or to swallow a rejection: `started` already
  // converts every failure into a verdict, and every caller awaits this.
  const gated = started.then((outcome) => {
    clearTimeout(timer)
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
    // The configured host's children die with this process, so nothing survived to be
    // adopted and any handle on this row is stale. Not an error — the in-process host
    // is a supported option — but it IS worth saying, because a row that still carries
    // a handle here means the instance changed hosts, and the pane that handle names
    // may genuinely still be running under a herdr server this process is not talking
    // to.
    log(
      `key=${sessionKey.slice(0, 32)} carries pane handle ${record.pane_handle} but the configured PTY host ` +
        'cannot adopt — that pane, if it exists, is not reachable from this process',
    )
    return { kind: 'no-handle', sessionKey }
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
  const claudeBasename = basenameOf(options.claude_bin ?? process.env['CLAUDE_BIN'] ?? 'claude')
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
        // nothing later mistakes it for evidence that a pane exists.
        if (registryPath !== undefined) clearPaneHandle(registryPath, sessionKey, deps)
        return { kind: 'handle-cleared', sessionKey }
      }
      case 'leave-not-ours':
        return { kind: 'undecided', sessionKey, reason: verdict.reason }
      case 'close-foreign-owner': {
        const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
        return closed
          ? { kind: 'closed-foreign-owner', sessionKey, reason: verdict.reason }
          : {
              kind: 'undecided',
              sessionKey,
              reason: `a foreign owner holds this transcript and the close FAILED — ${verdict.reason}`,
            }
      }
      case 'unverifiable':
      case 'unavailable':
        return await pidFallback(sessionKey, record, claudeBasename, verdict.reason, registryPath, deps)
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
  const verdict = await adoptOrKillOrphan(record.pid, record.sessionId, orphanDeps, claudeBasename)
  if (verdict === 'killed') {
    if (registryPath !== undefined) clearPaneHandle(registryPath, sessionKey, deps)
    return { kind: 'closed-by-pid', sessionKey }
  }
  return {
    kind: 'undecided',
    sessionKey,
    reason: `${why}; the pid fallback answered '${verdict}', which establishes neither ownership nor absence`,
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
): Promise<boolean> {
  try {
    await host.closeHandle(handle)
  } catch (e) {
    ;(deps.log ?? defaultLog)(
      `pane ${handle} could NOT be closed (${e instanceof Error ? e.message : String(e)}) — it is still running`,
    )
    return false
  }
  if (registryPath !== undefined) clearPaneHandle(registryPath, sessionKey, deps)
  return true
}

/**
 * Drop `pane_handle` from a row, and CHECK WHAT IS ON DISK AFTERWARDS rather than
 * assuming the write took.
 *
 * `patchRecord` is a no-op when the row has gone (a concurrent respawn removed it),
 * and its own write can be skipped when the registry is unreadable. Either way the
 * caller must not go on believing it cleared something: a stale handle left on disk
 * sends the NEXT boot to a pane id that may by then name someone else's pane.
 */
function clearPaneHandle(registryPath: string, sessionKey: string, deps: BootAdoptionDeps): void {
  const log = deps.log ?? defaultLog
  try {
    // REMOVED, not set to `undefined`: the record type is exact-optional, and a row
    // whose `pane_handle` key is present-but-undefined would serialise to a key the
    // next reader has to special-case. Absent is the only representation of absent.
    withRegistry(registryPath, (registry) => {
      const prev = registry[sessionKey]
      if (prev !== undefined) {
        const { pane_handle: _gone, ...rest } = prev
        registry[sessionKey] = rest
      }
      return { registry, result: undefined }
    })
    const after = getRecord(registryPath, sessionKey)
    if (after !== undefined && after.pane_handle !== undefined) {
      log(
        `row ${sessionKey.slice(0, 32)} STILL carries pane_handle ${after.pane_handle} after a clear — ` +
          `the next boot will re-inspect it`,
      )
    }
  } catch (e) {
    log(`could not clear pane_handle for ${sessionKey.slice(0, 32)}: ${e instanceof Error ? e.message : String(e)}`)
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
    const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
    const reason = 'the row carries no child_generation, so this child\'s sink credential cannot be reproduced'
    return closed
      ? { kind: 'closed-unadoptable', sessionKey, reason }
      : { kind: 'undecided', sessionKey, reason: `${reason}; and the close FAILED` }
  }
  const port = record.devchannel_port
  const health = deps.health ?? httpHealth
  if (port === undefined || port <= 0 || !(await health(port, { expectedSessionId: record.sessionId }))) {
    const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
    const reason =
      port === undefined || port <= 0
        ? 'the row records no dev-channel port, so there is nothing to inject a turn into'
        : `the dev-channel on port ${port} did not answer /health for session ${record.sessionId.slice(0, 8)}`
    return closed
      ? { kind: 'closed-unadoptable', sessionKey, reason }
      : { kind: 'undecided', sessionKey, reason: `${reason}; and the close FAILED` }
  }

  // ── The child is established. Rebuild around it, in the same order `spawnSession`
  //    builds around a fresh one, and for the same reasons. ──────────────────────

  // THE LAST POINT AT WHICH ADOPTING IS STILL THE RIGHT ACT. Past the gate's budget
  // the spawn path has been released, so a cold `--resume` may already own this
  // transcript; putting a second owner in the pool would be worse than losing the
  // pane. Close instead — the verification above is exactly what licenses closing it.
  if (signal.abandoned) {
    const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
    const reason = 'the spawn gate was released before this verification finished, so adopting could produce a second owner'
    return closed
      ? { kind: 'closed-unadoptable', sessionKey, reason }
      : { kind: 'undecided', sessionKey, reason: `${reason}; and the close FAILED` }
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
    const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
    const reason = 'the row carries no usable spawn-time reuse properties, so the first turn would evict this session anyway'
    return closed
      ? { kind: 'closed-unadoptable', sessionKey, reason }
      : { kind: 'undecided', sessionKey, reason: `${reason}; and the close FAILED` }
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
    const closed = await closeAndClear(host, handle, registryPath, sessionKey, deps)
    return closed
      ? { kind: 'closed-unadoptable', sessionKey, reason }
      : { kind: 'undecided', sessionKey, reason: `${reason}; and the close FAILED` }
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
    return await unwind('the spawn gate was released while the attach was in flight', child)
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
  if (registryPath !== undefined && record.pid !== child.pid) {
    try {
      patchRecord(registryPath, sessionKey, { pid: child.pid })
      const after = getRecord(registryPath, sessionKey)
      if (after?.pid !== child.pid) {
        log(
          `row ${sessionKey.slice(0, 32)} still records pid ${String(after?.pid)} after adopting pid ${child.pid} — ` +
            'liveness probes will ask about the wrong process',
        )
      }
    } catch (e) {
      log(`could not update pid for ${sessionKey.slice(0, 32)}: ${e instanceof Error ? e.message : String(e)}`)
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
