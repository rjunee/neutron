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

import type { ReplRegistryRecord } from './repl-registry.ts'

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
