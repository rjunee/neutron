/**
 * generation-replacement.ts — replace ONE exact, quiescent pooled parent REPL with a
 * `--resume` of the SAME conversation (#1237).
 *
 * WHAT IT IS. The runtime half of the project maintenance owner
 * (`gateway/project-generation-replacement.ts`). The gateway fences admission, proves
 * the parent generation quiescent with the liveness census, and then asks this module
 * to replace EXACTLY the child it measured. This module re-verifies that identity
 * against the live pool BEFORE it mutates anything, and refuses on any difference.
 *
 * WHY NOT THE EXISTING RESPAWN. `respawnReplSession` (supervision.ts) resumes with
 * `resumeSpecFor`'s empty tool list, and neither it nor `retirePersistentRepl` knows
 * about a fence or a census. This primitive re-spawns through the SUPERVISED options
 * (same pool key, credential identity, project id and admission-generation reader)
 * under the caller's spec, so the conversation, the placement and the credential are
 * preserved by construction and the spawn stamps the fence's CURRENT generation.
 *
 * THE ONE-OWNER RULE. The replacement resumes the same transcript, so the old child
 * must be GONE first. An old child that does not exit after termination answers
 * `unknown` and nothing is spawned: two owners of one transcript is the harm the
 * whole persistent pool guards against.
 *
 * Runtime layer: imports only `persistent/*`. Nothing in production calls
 * {@link replaceQuiescentPooledSession} in this build.
 */
import type { AgentSpec } from '../../../substrate.ts'
import { readProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import {
  childByKey,
  committedDispatches,
  pendingChildKills,
  pendingSpawns,
  pool,
  retiringSessionKeys,
  supervisedBySessionKey,
} from './pool-state.ts'
import { getRecord } from './repl-registry.ts'
import { terminateChild, type ReplSession } from './repl-session.ts'
import { gateFor, getOrSpawnSession, notifyEvictedChild, requestedReplProfile } from './spawn.ts'
import type { PtyChild } from './pty-host.ts'
import type { PersistentReplSubstrateOptions, ResumeDirective } from './types.ts'

/** The exact parent a maintenance owner measured and wants replaced. */
export interface ExpectedParent {
  sessionKey: string
  childGeneration: string
  sessionId: string
  pid: number
  identity: ProcessIdentity
}

export type ReplacementRefusalReason =
  | 'absent'
  | 'pending'
  | 'identity-mismatch'
  | 'busy'
  | 'poisoned'
  | 'child-exited'
  | 'gate-held'
  | 'unsupervised'

/** Refused BEFORE any mutation: the pooled parent is exactly as it was. */
export interface ReplacementRefusal {
  status: 'refused'
  reason: ReplacementRefusalReason
}

export type ReplacementResult =
  | { status: 'replaced'; session: ReplSession }
  | ReplacementRefusal
  | { status: 'unknown'; reason: string }

/** What a replacement actually IS, read from the live pool and its durable row. */
export interface ReplacementObservation {
  sessionId: string
  childGeneration: string
  pid: number
  exited: boolean
  /** `childByKey.get(key) === session.child` — the pool's exact-identity rule. */
  identified: boolean
  admissionGeneration: number | undefined
  toolSurface: string
  toolBridgeActive: boolean
  adopted: boolean
  /** The persisted registry row's view; undefined when there is no row (or no registry). */
  registry: { sessionId: string; admission_generation: number | undefined; tool_surface: string | undefined; tool_bridge: boolean | undefined } | undefined
}

/** Injection seams for tests; production uses the real pool machinery. */
export interface ReplacementDeps {
  identity?: (pid: number) => ProcessIdentity | undefined
  terminate?: (child: PtyChild) => Promise<void>
  spawn?: (
    sessionKey: string,
    options: PersistentReplSubstrateOptions,
    spec: AgentSpec,
    forceResume: ResumeDirective,
  ) => Promise<ReplSession>
}

function sameIdentity(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a !== undefined && a.start_ticks === b.start_ticks && a.boot_id === b.boot_id
}

/** A fulfilled pool entry's session, without awaiting an unsettled promise. */
function fulfilledSession(entry: Promise<ReplSession> | undefined): ReplSession | 'absent' | 'pending' {
  if (entry === undefined) return 'absent'
  if (Bun.peek.status(entry) !== 'fulfilled') return 'pending'
  const session = Bun.peek(entry) as ReplSession | undefined
  return session === undefined ? 'absent' : session
}

/**
 * The profile the next dispatch of `spec` on `sessionKey` will demand of a warm
 * child (`requestedReplProfile`, the reuse guard's own rule) under the key's
 * SUPERVISED options. Undefined when the key is not supervised. The attestation's
 * expectation: a replacement that does not match it would be evicted by the very
 * next turn.
 */
export function requestedProfileFor(
  sessionKey: string,
  spec: AgentSpec,
): { toolSurface: string; toolBridge: boolean } | undefined {
  const options = supervisedBySessionKey.get(sessionKey)
  return options === undefined ? undefined : requestedReplProfile(options, spec)
}

/**
 * Replace the EXACT pooled parent `expected` names with a resume of its own
 * conversation. Every check runs before the first mutation; a refusal leaves the
 * pool untouched. The in-flight gate is held across the swap so a watchdog respawn
 * cannot race it.
 */
export async function replaceQuiescentPooledSession(
  expected: ExpectedParent,
  spec: AgentSpec,
  deps: ReplacementDeps = {},
): Promise<ReplacementResult> {
  const key = expected.sessionKey
  const identity = deps.identity ?? readProcessIdentity
  const terminate = deps.terminate ?? terminateChild
  const spawn = deps.spawn ?? getOrSpawnSession

  const options = supervisedBySessionKey.get(key)
  if (options === undefined || retiringSessionKeys.has(key)) return { status: 'refused', reason: 'unsupervised' }
  const entry = pool.get(key)
  const resolved = fulfilledSession(entry)
  if (resolved === 'absent') return { status: 'refused', reason: 'absent' }
  if (resolved === 'pending' || pendingSpawns.has(key) || pendingChildKills.has(key)) {
    return { status: 'refused', reason: 'pending' }
  }
  const session = resolved
  let child: PtyChild | undefined
  try { child = session.child } catch { child = undefined }
  if (
    session.childGeneration !== expected.childGeneration ||
    session.sessionId !== expected.sessionId ||
    child === undefined ||
    child.pid !== expected.pid ||
    childByKey.get(key) !== child ||
    !sameIdentity(identity(expected.pid), expected.identity)
  ) {
    return { status: 'refused', reason: 'identity-mismatch' }
  }
  if (session.hasChildExited()) return { status: 'refused', reason: 'child-exited' }
  if (session.activeTurn !== undefined || session.turnSlotHeld !== 0 || (committedDispatches.get(key) ?? 0) !== 0) {
    return { status: 'refused', reason: 'busy' }
  }
  // An abandoned turn may still be running on the child.
  if (session.poisoned) return { status: 'refused', reason: 'poisoned' }

  const gate = gateFor(key)
  if (!gate.claim()) return { status: 'refused', reason: 'gate-held' }
  try {
    // Identity-guarded: only OUR entry and OUR child leave the maps.
    if (pool.get(key) === entry) pool.delete(key)
    if (childByKey.get(key) === child) childByKey.delete(key)
    await terminate(child)
    if (!session.hasChildExited()) {
      return { status: 'unknown', reason: 'old child did not exit' }
    }
    await notifyEvictedChild(options, key, session.childGeneration, 'admission-generation-replacement')
    try {
      const replacement = await spawn(key, options, spec, { sessionId: expected.sessionId })
      return { status: 'replaced', session: replacement }
    } catch (error) {
      return { status: 'unknown', reason: `replacement spawn failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  } finally {
    gate.release()
  }
}

/**
 * A read-only observation of the FULFILLED pooled session under `sessionKey` and its
 * persisted registry row — the attestation's input. Undefined for an absent or
 * still-pending entry.
 */
export function observePooledSession(sessionKey: string): ReplacementObservation | undefined {
  const resolved = fulfilledSession(pool.get(sessionKey))
  if (resolved === 'absent' || resolved === 'pending') return undefined
  const session = resolved
  let child: PtyChild | undefined
  try { child = session.child } catch { child = undefined }
  const options = supervisedBySessionKey.get(sessionKey)
  const row = options?.replRegistryPath !== undefined ? getRecord(options.replRegistryPath, sessionKey) : undefined
  return {
    sessionId: session.sessionId,
    childGeneration: session.childGeneration,
    pid: child?.pid ?? -1,
    exited: session.hasChildExited(),
    identified: child !== undefined && childByKey.get(sessionKey) === child,
    admissionGeneration: session.admissionGeneration,
    toolSurface: session.toolSurface,
    toolBridgeActive: session.toolBridgeActive,
    adopted: session.adopted,
    registry: row === undefined
      ? undefined
      : {
          sessionId: row.sessionId,
          admission_generation: row.admission_generation,
          tool_surface: row.reuse?.tool_surface,
          tool_bridge: row.reuse?.tool_bridge,
        },
  }
}
