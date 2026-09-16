/**
 * child-exit-wiring.ts — what happens to a session when its child dies, in ONE place.
 *
 * Lifted out of `spawn.ts` (#539) because a child can now arrive by two routes and
 * must leave by one. A REPL is either SPAWNED by this gateway or RE-ADOPTED from a
 * herdr pane a previous gateway spawned, and the two paths differ only in how the
 * child is obtained: after that it is the same process, the same pool entry, the same
 * sink registration and the same temp config files on disk. Two copies of this
 * teardown would drift — one of them would learn about a new watcher, or about a new
 * map to clean, and the other would not — and the copy that lags is the one that
 * leaks, because a leak is silent.
 *
 * MOVED VERBATIM, not rewritten: every rule below was already load-bearing where it
 * came from, and its reasoning travels with it.
 */

import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { LiveProcessHandle } from '@neutronai/tools/process-registry.ts'
import { childByKey, pool, sink } from './pool-state.ts'
import { disownPane, withOwnedRegistry } from './repl-registry.ts'
import type { PtyChild } from './pty-host.ts'
import { ReplSession, unlinkSessionConfigs } from './repl-session.ts'

export interface ChildExitWiring {
  session: ReplSession
  child: PtyChild
  sessionKey: string
  sessionId: string
  /**
   * The watchdog live-process handle for THIS child — read through a GETTER, not
   * captured by value. The handle is assigned AFTER the child exists (it needs the
   * pid), so a caller wiring this at the same moment holds `undefined`; by the time
   * the child exits it is set. A by-value capture would silently skip the crash /
   * unregister reconciliation on every child, which is invisible until the day a
   * crash goes unreported.
   */
  liveHandle: () => LiveProcessHandle | undefined
  /** Label for the fire-and-forget wrapper, so a rejection is attributed to the
   *  route that installed it. */
  label: string
  /**
   * Where this session's row lives, CAPTURED AT WIRING TIME rather than looked up when
   * the child dies (#539 r40).
   *
   * The obvious version resolved it through `supervisedBySessionKey`, and that map is
   * CLEARED by `shutdownAllPersistentRepls` (`pool.ts:1325`) — which runs before these
   * handlers finish, so the one teardown that always ends children would silently skip
   * the row cleanup. Ambient state that something else tears down is not a dependency a
   * death handler can rely on.
   */
  registryPath: string | undefined
}

/**
 * Wire process death → fail the in-flight turn, unregister, and evict from the pool
 * so the next `start()` respawns.
 *
 * IDENTITY-GUARDED throughout: a respawn re-attaches the SAME sessionId/sessionKey,
 * so a dying OLD child must not evict the NEW session a concurrent respawn already
 * installed (the resume race the P2-3 regression caught).
 */
export function wireChildExit(args: ChildExitWiring): void {
  const { session, child, sessionKey, sessionId } = args
  fireAndForget(
    args.label,
    child.exited.then(async (exitCode) => {
      session.onDeath(child.exitCause?.())
      // Detach the row-#11 dead-turn JSONL watcher — this child's transcript is now
      // terminal; a respawn starts a fresh watcher for the new child.
      session.deadTurnWatcher?.stop()
      session.deadTurnWatcher = undefined
      // Stop the size-watchdog cadence — the child it watched is gone (row #13) — AND CLEAR
      // THE REFERENCE, which this path did not (r53). `deadTurnWatcher` two lines up was
      // cleared and this one was not, and the audit table's cell claimed both were: an
      // asymmetry with no reason behind it, and the round-thirty-one lesson says a retained
      // reference on a path that stops owning deserves the question rather than the softer
      // wording. Stopping makes it inert; clearing makes the cell true and leaves nothing for
      // a later reader to wonder about.
      session.sizeWatchdog?.stop()
      session.sizeWatchdog = undefined
      // F4 — reconcile the watchdog's live-process view against this real exit,
      // distinguishing a CLEAN/EXPECTED exit from a CRASH so CrashedAgentDetector can
      // actually observe crashes in production (a child that exits between 30 s ticks
      // must not be silently dropped before the detector runs). The handle is bound
      // to the OWNING registry + this child's (name, pid), so BOTH branches no-op if
      // a concurrent respawn already replaced `sessionKey`, or a newer gateway boot
      // pushed a different ambient registry — it can only ever touch THIS child's own
      // entry (High 2). CLEAN = code 0 or a termination WE initiated (SIGTERM/SIGKILL
      // on evict/respawn/cancel/shutdown → `wasKilledByUs`): unregister outright.
      // CRASH = a non-zero code or an EXTERNAL signal we did not send: mark the record
      // crashed and LEAVE it so the detector reports it once and reaps it on commit.
      const killedByUs = child.wasKilledByUs?.() ?? false
      const liveHandle = args.liveHandle()
      if (!killedByUs && exitCode !== 0) {
        liveHandle?.markCrashed()
      } else {
        liveHandle?.unregister()
      }
      sink.unregisterIf(sessionId, session)
      // #539 r40 — THE PANE DIED WITH THE CHILD, so the row stops claiming both. The child
      // IS the pane's process: once it exits there is no pane to name and nobody serving
      // it, and a `pane_handle` or an ownership claim left behind is a statement about
      // something that no longer exists. The replacement spawn used to INHERIT that claim,
      // and a restart inside the takeover window then refused adoption on the strength of
      // an ownership marker belonging to a dead child.
      //
      // TWO IDENTITY GUARDS, because either one alone is insufficient:
      //   - the generation, so a concurrent respawn's row (already re-stated by the new
      //     spawn) is not clobbered by its predecessor's exit handler;
      //   - the CLAIM, because a takeover keeps the SAME generation — it is the same
      //     child — so the generation cannot tell "still ours" from "somebody else owns
      //     this now". A row claimed by another gateway is left exactly alone.
      // THE IN-MEMORY CLAIM GOES FIRST, BEFORE THE CANCEL (Argus r51). Round fifty made the
      // fence's guard read `paneClaimBy` — "a session with no claim has nothing to fence" —
      // and that premise is only true if EVERY give-back path clears it. This one predates
      // the premise and was never told: it cancelled the timer and disowned the durable row
      // and left the in-memory claim set. So a deadline callback already DISPATCHED when the
      // child exited would arrive after the cancel, see a stale claim, and install a
      // key-level fence — turning a crashed REPL into a permanently refused key instead of
      // one that respawns.
      //
      // ON THE ORDERING, MEASURED RATHER THAN ASSERTED. Clearing the claim before the cancel
      // reads as the safer order — a dispatched callback observes the cleared claim rather
      // than racing the cancel — but the mutation that swaps them does NOT red, and the
      // reason is structural: these are adjacent SYNCHRONOUS statements, and a runtime with no
      // preemption between them cannot run a callback in the gap. So the order is a
      // readability choice, not a guarantee, and this comment says so instead of claiming a
      // property the code does not have. What IS load-bearing is that the clear happens at all
      // (M146), and that it happens on this path (which is the finding).
      //
      // The round-thirty-one table has a column for this now — the durable row and the
      // in-memory claim are two representations of one fact, and it tracked only the first.
      // CAPTURED BEFORE IT IS CLEARED: the row disown below is CAS'd on this very value, so
      // clearing it first without keeping it would make the teardown unable to release its
      // own row — the fix for one path breaking another, which is the shape this round is
      // about.
      const claimHeldAtExit = session.paneClaimBy
      session.paneClaimBy = undefined
      session.selfFenceTimer?.cancel()
      session.selfFenceTimer = undefined
      disownPaneOnExit(args.registryPath, sessionKey, session, claimHeldAtExit)
      // Reclaim the temp config files now the child is gone (covers pool eviction,
      // crash, and shutdown — the ephemeral dispose path unlinks eagerly too).
      unlinkSessionConfigs(session)
      // Drop the synchronous handle mirror only if it still points at THIS child —
      // a concurrent respawn may have already installed a fresh one for the key.
      if (childByKey.get(sessionKey) === child) childByKey.delete(sessionKey)
      // THE ENTRY THIS SESSION WAS PUBLISHED UNDER — bound at publish time, not read here
      // (Argus r55, the THIRD version of this one guard; see the as-built for why each earlier
      // version failed). Reading the map inside this callback asks "what is registered now",
      // which is a tautology: a replacement published before this callback ran would be
      // captured, found current, and deleted — the very interleaving this file's own header
      // says must not happen.
      //
      // `pooledAs` is `undefined` for a session that never entered the pool, and then there is
      // no entry of ours to remove.
      //
      // Stated once, identically here, in `__tests__/child-exit-pool-identity.test.ts` and in
      // the as-built, so a grep can check the three agree:
      //   **the pool delete is ONE identity guard on the entry this session was published under**.
      const ownEntry = session.pooledAs
      if (ownEntry !== undefined) {
        // Awaited only to let a rejection settle; the settlement decides nothing, because an
        // entry that is still OURS is ours whichever way it resolved (r54).
        try {
          await ownEntry
        } catch {
          // A rejected entry owns no child, which is why this arm exists (r30).
        }
        if (pool.get(sessionKey) === ownEntry) pool.delete(sessionKey)
      }
    }),
  )
}

/**
 * Clear the pane handle and its claim when the child that owned them has exited.
 *
 * Best-effort and silent: a registry write failure must never break a teardown, and the
 * next boot reconciles the row against the process table anyway — a stale handle is a
 * question the adoption path already knows how to answer, and answering it costs one
 * inspection rather than a lost REPL.
 */
function disownPaneOnExit(
  registryPath: string | undefined,
  sessionKey: string,
  session: ReplSession,
  /** The claim this session held when its child exited — passed explicitly because the
   *  caller clears the live field first (r51), and this CAS is keyed on that value. */
  claimHeldAtExit: string | undefined,
): void {
  if (registryPath === undefined) return
  try {
    withOwnedRegistry(
      registryPath,
      (registry) => {
        const prev = registry[sessionKey]
        if (prev === undefined) return { registry, result: undefined, skipSave: true as const }
        const stillOurChild = prev.child_generation === session.childGeneration
        const claim = prev.adoption_claim_by
        const notSomebodyElses = claim === undefined || claim === claimHeldAtExit
        if (!stillOurChild || !notSomebodyElses) {
          return { registry, result: undefined, skipSave: true as const }
        }
        registry[sessionKey] = disownPane(prev)
        return { registry, result: undefined }
      },
      // THE DISPOSITION FOR AN UNACQUIRED LOCK: DO NOT DISOWN. Writing an unlocked
      // whole-registry snapshot would drop a concurrent gateway's rows, and refusing costs
      // only a row that still names a child which has exited — which the next boot's probe
      // answers as `pane_not_found`, a POSITIVE absence and a recoverable one. The
      // recoverable direction, chosen deliberately over the destructive one.
      () => undefined,
    )
  } catch {
    /* the next boot reconciles it */
  }
}
