/**
 * gateway-shutdown-survival.ts — may THIS child outlive the gateway's shutdown? (#539)
 *
 * THE KILL THIS GATES IS NOT ARBITRARY, and anyone narrowing it should know what it
 * was for. `shutdownAllPersistentRepls` kills the whole warm pool on SIGTERM because
 * under the old `KillMode=process` units every descendant reparented to init on each
 * restart and accumulated: 632 orphaned processes, ~19 GB, on 2026-06-11. systemd's
 * `KillMode=control-group` is the guarantee layer for children in the gateway's own
 * cgroup; this loop is the polite layer, and the layer that covers non-systemd
 * deployments at all.
 *
 * WHY A HERDR PANE CHANGES THE QUESTION. A pane's process is a child of the HERDR
 * SERVER, not of the gateway — it is in neither the gateway's process tree nor its
 * cgroup. So for these children the cgroup guarantee never applied in the first place,
 * and the polite kill is the ONLY thing that was ending them. Removing it outright
 * would recreate 2026-06-11 exactly: processes nothing holds a handle to. Gating it on
 * the pane being RE-FINDABLE is what makes the difference real rather than verbal.
 *
 * WHAT REPLACES THE KILL, stated as the thing a reviewer can check:
 *
 *   1. A child may survive ONLY if a persisted row names its pane AND its generation.
 *      The handle is therefore never lost: the next boot reads the row.
 *   2. The next boot VISITS that row (`boot-adoption.ts`) and either re-adopts the
 *      pane or CLOSES it. There is no third branch that leaves a verified pane
 *      running, so a survivor is a handle we hold, not a process we forgot.
 *   3. Everything else still dies here, unchanged: the in-process host's children
 *      (which cannot survive anyway), ephemeral one-shots (never pooled, never in a
 *      row) and quarantined children (out of the pool by construction, and superseded
 *      in the row by the replacement that displaced them — so nothing would ever look
 *      for them again).
 *
 * The residual, named rather than hidden: if the registry file is LOST between the
 * shutdown and the next boot, the pane it named becomes unreferenced. It is still a
 * labelled, visible pane in herdr rather than an invisible reparented process, and it
 * is bounded by one pane per session key — but nothing will reap it automatically.
 * That is the price of the survival this feature exists to provide, and it is paid
 * once per registry loss rather than once per restart.
 */

import type { ReplRegistry, ReplRegistryRecord } from './repl-registry.ts'
import { withRegistryRead } from './repl-registry.ts'

/** Whether one pooled child may be left running when the gateway stops. */
export type ShutdownSurvivalVerdict =
  /** Leave it alive: a durable row names this exact pane AND this exact generation,
   *  so the next boot can find it and decide about it. */
  | { readonly kind: 'survive'; readonly handle: string }
  /** Kill it, as this loop always has. The reason is not decoration — it is what
   *  makes a survival policy auditable at the moment it declines to apply. */
  | { readonly kind: 'kill'; readonly reason: string }

/** The inputs, narrowed so a test supplies literals rather than a live session. */
export interface ShutdownSurvivalInput {
  /** `PtyChild.paneHandle` — absent when the child dies with this process. */
  readonly paneHandle: string | undefined
  /** The generation this session object owns. */
  readonly childGeneration: string
  /** The persisted row for this key, as read at shutdown. */
  readonly record: ReplRegistryRecord | undefined
}

/**
 * EVERY CONDITION IS A PIECE OF EVIDENCE THAT THE NEXT BOOT CAN FIND THIS CHILD.
 * Survival is not a property of the child alone; it is a property of the pair
 * (child, durable record). A child that would survive but is not written down is
 * exactly the orphan this gate exists to keep preventing, so the absence of the row —
 * or a row that names something else — is a KILL, not a survival with a warning.
 */
export function shutdownSurvivalVerdict(input: ShutdownSurvivalInput): ShutdownSurvivalVerdict {
  const handle = input.paneHandle
  if (handle === undefined) {
    return {
      kind: 'kill',
      reason: 'the host issued no durable handle — this child is ours and dies with us',
    }
  }
  const record = input.record
  if (record === undefined) {
    return {
      kind: 'kill',
      reason: `no persisted row names pane ${handle}; nothing would ever look for it again`,
    }
  }
  if (record.pane_handle !== handle) {
    return {
      kind: 'kill',
      reason:
        `the row names pane ${record.pane_handle ?? '<none>'} and this child is in pane ${handle} — ` +
        'the next boot would reconcile the other one and never learn about this',
    }
  }
  if (record.child_generation !== input.childGeneration) {
    return {
      kind: 'kill',
      reason:
        `the row describes generation ${(record.child_generation ?? '<none>').slice(0, 8)} and this child is ` +
        `${input.childGeneration.slice(0, 8)} — its sink credential could not be reproduced, so an adoption ` +
        'would register a session this child cannot authenticate to',
    }
  }
  return { kind: 'survive', handle }
}


/** The one seam {@link claimShutdownSurvival} needs, so a case can model another
 *  incarnation winning the lock immediately before this decision. */
export interface ShutdownSurvivalDeps {
  /** Defaults to {@link withRegistryRead} — the registry read taken UNDER THE FLOCK.
   *  `onOutcome` reports whether the lock was actually HELD while the read ran, and this
   *  caller rules on it: see {@link claimShutdownSurvival}. */
  readonly withRegistryRead?: <T>(
    path: string,
    read: (registry: ReplRegistry) => T,
    onOutcome?: (acquired: boolean) => void,
  ) => T
}

/** Message text for a thrown value, without assuming it is an Error. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * THE SURVIVAL DECISION, TAKEN UNDER THE REGISTRY LOCK (#539, Argus r7 BLOCKER).
 *
 * WHAT WAS WRONG WITH READING FIRST AND DECIDING AFTER. The shutdown path used to take
 * an unlocked `getRecord` snapshot and hand it to {@link shutdownSurvivalVerdict}. A
 * registry is shared across PROCESSES by design — that is why every writer in this
 * module family takes a flock — so an unlocked read orders this decision against a
 * concurrent writer by nothing at all:
 *
 *   A writes (H1,G1) → A starts shutting down and snapshots (H1,G1)
 *                    → B writes (H2,G2)
 *                    → A leaves H1 alive because its SNAPSHOT said the row named it.
 *
 * The durable row now names H2 and nothing will ever look for H1 again: an unreferenced
 * pane, which is the 2026-06-11 orphan in its herdr-shaped form and the symptom this
 * gate exists to prevent. It is the same defect this branch has already fixed twice
 * elsewhere — `clearPaneHandleIfUnchanged` and `claimRowOrUnwind` both refuse to act on
 * a row that has moved — and the shutdown boundary simply never got the treatment.
 *
 * WHAT TAKING THE LOCK BUYS, stated exactly so nobody reads more into it. B's write
 * lands strictly before this compare (we see H2 and KILL) or strictly after it (B held
 * the lock, so B is a writer that read (H1,G1) and chose to replace it — and every
 * writer that does so goes through the boot-adoption pass, which closes or adopts the
 * pane it displaces before writing over its handle). What it does NOT buy, because no
 * lock can: a guarantee about a writer arriving after this process has exited. The
 * residual named in this file's header — a LOST registry strands the pane it named —
 * is unchanged by this and is still the price of the feature.
 *
 * The verdict is {@link shutdownSurvivalVerdict}'s, unchanged; this function only
 * decides WHICH ROW that function is allowed to see.
 */
export function claimShutdownSurvival(args: {
  readonly registryPath: string | undefined
  readonly sessionKey: string
  readonly paneHandle: string | undefined
  readonly childGeneration: string
  readonly deps?: ShutdownSurvivalDeps
}): ShutdownSurvivalVerdict {
  // No handle → no row can rescue it, and no lock need be taken to say so. This is the
  // in-process host's every child, so it is also the common case.
  if (args.paneHandle === undefined) {
    return shutdownSurvivalVerdict({
      paneHandle: undefined,
      childGeneration: args.childGeneration,
      record: undefined,
    })
  }
  const read = args.deps?.withRegistryRead ?? withRegistryRead
  // NO registry configured is NOT an empty registry: either way nothing durable names
  // this pane, and `shutdownSurvivalVerdict` turns that into a kill with its own reason.
  if (args.registryPath === undefined) {
    return shutdownSurvivalVerdict({
      paneHandle: args.paneHandle,
      childGeneration: args.childGeneration,
      record: undefined,
    })
  }
  // BOTH OF THESE MUST SUCCEED FOR A SURVIVAL, AND NEITHER IS FREE.
  //
  // (1) The read can THROW. The lock's `openSync` raises on ENXIO / ELOOP / a missing
  //     parent / EACCES, and the lock throws explicitly when its path is not a regular
  //     file. Nothing above this catches it usefully: teardown's own `catch {}` would
  //     swallow it and SKIP the kill, the sink unregister and the config unlink — the
  //     child left alive by an exception nobody sees. That is worse than the race this
  //     function was added to close, and it is a hazard the unlocked `getRecord` it
  //     replaced did not have (`loadRegistry` answers `{}` on every read failure).
  //
  // (2) The lock can fail to be HELD. `withFlockSync` runs its callback unguarded when
  //     FFI is missing and when `flock` returns nonzero — correct for a generic helper,
  //     and indistinguishable from success to a caller that does not ask. This
  //     function's whole correctness argument is the lock, so it asks.
  //
  // EITHER FAILURE IS A KILL, and the asymmetry is the reason rather than caution for
  // its own sake. The child is OURS and we hold its handle, so killing it carries none
  // of the recycled-identifier risk this module family exists to guard: the cost is one
  // respawn at the next boot. The cost of a wrong `survive` is a process nothing will
  // ever look for again, writing a second stream into a transcript another owner holds.
  // When one outcome is recoverable and the other is not, the tie does not go to the
  // permissive branch.
  let acquired = false
  let record: ReplRegistryRecord | undefined
  try {
    record = read(
      args.registryPath,
      (registry) => registry[args.sessionKey],
      (ok) => {
        acquired = ok
      },
    )
  } catch (e) {
    // DISTINCT FROM "no row names it": that is a finding about the registry's CONTENT,
    // this is the absence of any finding at all. A log reader must be able to tell a
    // stale row from a registry we never read.
    return {
      kind: 'kill',
      reason:
        `the registry could NOT BE READ (${errorText(e)}) — nothing establishes that a row names ` +
        `pane ${args.paneHandle}, and a child left alive on an unread registry is one nothing ` +
        'would ever look for again',
    }
  }
  if (!acquired) {
    return {
      kind: 'kill',
      reason:
        `the registry LOCK WAS NOT ACQUIRED for the survival decision about pane ${args.paneHandle} ` +
        '— the row was read unguarded, so another incarnation may have replaced it inside this ' +
        'decision and the only thing that would make this safe is the lock we did not get',
    }
  }
  return shutdownSurvivalVerdict({
    paneHandle: args.paneHandle,
    childGeneration: args.childGeneration,
    record,
  })
}
