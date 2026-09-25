/**
 * gateway/project-generation-replacement.ts — the project maintenance owner (#1237):
 * replace the EXACT, proven-quiescent parent generation of one project scope, attest
 * the replacement's actual profile, and only then reopen admission.
 *
 * THE SEQUENCE ({@link replaceProjectGeneration}).
 *   1. Fence: `beginMaintenance` bumps the scope's generation and stops admission.
 *      A scope already fenced by another owner is never stolen (`already-fenced`).
 *   2. Drain: census until the parent generation is provably idle — or give up.
 *      `busy` is waited on (bounded); `unknown` never drains into idle; a legacy,
 *      ambiguous or unidentified parent is PROTECTED and never replaced; no parent
 *      at all is `absent` (the next admitted turn spawns under the new generation).
 *      Only a participating, idle parent with zero leases advances to `quiesced`.
 *   3. Exact generation: ONE more census after `quiesced`. The parent must be the
 *      SAME child the drain measured, spawned under an EARLIER generation, and idle.
 *   4. Replace: the runtime primitive re-verifies the identity against the live pool,
 *      terminates the exact child and resumes the same conversation.
 *   5. Attest the replacement from what was ACTUALLY spawned (the pooled session and
 *      its durable registry row), then reopen. A failed attestation leaves the scope
 *      fenced: the store permits no other way out of `replacing`/`attesting`.
 *
 * Every decision here is made on injected ports ({@link ProjectMaintenancePorts});
 * {@link attestReplacement} is pure. NOTHING in production calls
 * {@link replaceProjectGeneration} in this build — the composition exposes it with
 * no trigger. {@link resumeProjectMaintenance} is restart continuity and runs at boot.
 */
import type { ProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import type {
  ExpectedParent,
  ReplacementObservation,
  ReplacementResult,
} from '@neutronai/runtime/adapters/claude-code/persistent/generation-replacement.ts'
import { SUBAGENT_TOOL_NAME } from '@neutronai/runtime/workers/claude-tool-contract.ts'
import type { ProjectAdmission } from './project-admission.ts'
import type { MaintenanceFence, MaintenancePhase } from './project-admission-store.ts'
import type { ProjectLivenessCensus } from './project-liveness-census.ts'

export const DEFAULT_DRAIN_BUDGET_MS = 60_000
export const DEFAULT_DRAIN_POLL_MS = 500

/** The spawn-time profile a replacement must carry (the next dispatch's demand). */
export interface ReplProfile { toolSurface: string; toolBridge: boolean }

export interface ProjectMaintenancePorts {
  census(projectId: string | null): Promise<ProjectLivenessCensus>
  replace(expected: ExpectedParent): Promise<ReplacementResult>
  observe(sessionKey: string): ReplacementObservation | undefined
  identity(pid: number): ProcessIdentity | undefined
  /** The profile the next dispatch on `sessionKey` demands; undefined = unsupervised. */
  expectedProfile(sessionKey: string): ReplProfile | undefined
  drainPollMs?: number
  drainBudgetMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Flat `k=v` fields (the repo logger's shape); reason lists are joined. */
export type MaintenanceLogFields = Record<string, string | number | boolean | null | undefined>
export interface MaintenanceLog {
  info(event: string, fields?: MaintenanceLogFields): void
  error(event: string, fields?: MaintenanceLogFields): void
}

export interface ProjectMaintenanceDeps {
  admission: ProjectAdmission
  ports: ProjectMaintenancePorts
  log?: MaintenanceLog
}

export type ReplacementOutcome =
  | { status: 'replaced'; generation: number; parent: { sessionId: string; from: string; to: string } }
  | { status: 'absent' }
  | { status: 'busy' | 'unknown' | 'protected' | 'already-fenced'; reasons: string[] }
  | { status: 'attestation-failed'; reasons: string[]; generation: number }

export type ResumeOutcome =
  | { status: 'open' }
  | { status: 'abandoned'; phase: MaintenancePhase }
  | { status: 'reopened'; generation: number }
  | { status: 'held'; phase: MaintenancePhase; reasons: string[] }

export interface AttestationExpectation {
  /** The conversation the replacement must have resumed. */
  sessionId: string
  /** The replaced child's generation; null when unknown (restart), where the stamp
   *  equal to the fence's generation is what proves the child is new. */
  priorChildGeneration: string | null
  /** The fence generation the replacement must be stamped with. */
  generation: number
  toolSurface: string
  toolBridge: boolean
}

/**
 * PURE. Every failing fact is listed; `ok` only when all hold. The observation is
 * what was actually spawned (memory AND the durable row), never the request.
 */
export function attestReplacement(
  observation: ReplacementObservation | undefined,
  expected: AttestationExpectation,
): { ok: true } | { ok: false; reasons: string[] } {
  if (observation === undefined) return { ok: false, reasons: ['no fulfilled pooled replacement to observe'] }
  const reasons: string[] = []
  if (observation.exited) reasons.push('replacement child has exited')
  if (!observation.identified) reasons.push('replacement child is not the pool\'s identified child')
  if (observation.sessionId !== expected.sessionId) reasons.push('replacement did not resume the same conversation')
  if (expected.priorChildGeneration !== null && observation.childGeneration === expected.priorChildGeneration) {
    reasons.push('replacement is the replaced child (same child generation)')
  }
  if (observation.admissionGeneration !== expected.generation) {
    reasons.push(`replacement admission generation ${String(observation.admissionGeneration)} is not the fence generation ${expected.generation}`)
  }
  if (observation.toolSurface !== expected.toolSurface) reasons.push('replacement tool surface differs from the expected surface')
  if (!observation.toolSurface.split(',').includes(SUBAGENT_TOOL_NAME)) {
    reasons.push(`replacement tool surface does not carry ${SUBAGENT_TOOL_NAME}`)
  }
  if (observation.toolBridgeActive !== expected.toolBridge) reasons.push('replacement tool bridge differs from the expected bridge')
  const row = observation.registry
  if (row === undefined) {
    reasons.push('replacement has no durable registry row')
  } else {
    if (row.sessionId !== observation.sessionId) reasons.push('registry row names a different conversation')
    if (row.admission_generation !== expected.generation) reasons.push('registry row is not stamped with the fence generation')
    if (row.tool_surface !== observation.toolSurface) reasons.push('registry row tool surface disagrees with the live session')
    if (row.tool_bridge !== observation.toolBridgeActive) reasons.push('registry row tool bridge disagrees with the live session')
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

type Participating = Extract<ProjectLivenessCensus['parent'], { kind: 'participating' }>

function sameParent(a: Participating, b: ProjectLivenessCensus['parent']): boolean {
  return b.kind === 'participating' && a.sessionKey === b.sessionKey && a.childGeneration === b.childGeneration &&
    a.sessionId === b.sessionId && a.pid === b.pid
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Drain, prove, replace and attest ONE scope's parent generation. See the file
 * header for the sequence. A refusal before `replacing` releases the fence
 * (`abandon`); from `replacing` on, only an attested replacement reopens.
 */
export async function replaceProjectGeneration(
  deps: ProjectMaintenanceDeps,
  projectId: string | null,
): Promise<ReplacementOutcome> {
  const { admission, ports, log } = deps
  const now = ports.now ?? Date.now
  const sleep = ports.sleep ?? ((ms: number) => Bun.sleep(ms))
  const pollMs = ports.drainPollMs ?? DEFAULT_DRAIN_POLL_MS
  const budgetMs = ports.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS
  const store = admission.maintenance
  const scope = admission.scopeFor(projectId)

  if ((await admission.generationFor(projectId)) === undefined) {
    return { status: 'unknown', reasons: ['project scope is not live'] }
  }
  const draining = await store.beginMaintenance(scope)
  if (draining === null) {
    return { status: 'already-fenced', reasons: [`scope phase is ${admission.inspect(projectId)?.phase ?? 'unregistered'}`] }
  }
  const giveUp = async (fence: MaintenanceFence, status: 'busy' | 'unknown' | 'protected', reasons: string[]): Promise<ReplacementOutcome> => {
    const released = await store.abandon(fence)
    log?.info('project_generation_replacement_abandoned', { projectId, status, released, reasons: reasons.join('; ') })
    return { status, reasons: released ? reasons : [...reasons, 'the fence could not be released'] }
  }

  // ── DRAIN ────────────────────────────────────────────────────────────────
  const deadline = now() + budgetMs
  let quiesced: MaintenanceFence | null = null
  let measured: Participating | undefined
  for (;;) {
    let census: ProjectLivenessCensus
    try { census = await ports.census(projectId) } catch (error) {
      return giveUp(draining, 'unknown', [`census failed: ${errorText(error)}`])
    }
    const parent = census.parent
    if (parent.kind === 'legacy-unknown' || parent.kind === 'ambiguous' || parent.kind === 'unidentified') {
      return giveUp(draining, 'protected', [`parent is ${parent.kind}`, ...census.reasons])
    }
    if (census.verdict === 'unknown') return giveUp(draining, 'unknown', census.reasons)
    if (census.verdict === 'idle' && parent.kind === 'absent') {
      const released = await store.abandon(draining)
      log?.info('project_generation_replacement_abandoned', { projectId, status: 'absent', released })
      return released ? { status: 'absent' } : { status: 'unknown', reasons: ['no parent, and the fence could not be released'] }
    }
    if (census.verdict === 'idle' && parent.kind === 'participating' && (admission.inspect(projectId)?.leases ?? 1) === 0) {
      // A lease admitted between the census and here makes this refuse; re-census.
      quiesced = await store.advance(draining)
      if (quiesced !== null) { measured = parent; break }
    }
    if (now() >= deadline) {
      return giveUp(draining, 'busy', census.verdict === 'busy' ? census.reasons : ['admitted work did not drain within the budget'])
    }
    await sleep(pollMs)
  }

  // ── EXACT GENERATION ─────────────────────────────────────────────────────
  let confirm: ProjectLivenessCensus
  try { confirm = await ports.census(projectId) } catch (error) {
    return giveUp(quiesced, 'unknown', [`confirming census failed: ${errorText(error)}`])
  }
  if (!sameParent(measured, confirm.parent)) return giveUp(quiesced, 'unknown', ['parent changed after quiescence'])
  if (confirm.verdict !== 'idle') return giveUp(quiesced, 'unknown', ['parent not idle after quiescence', ...confirm.reasons])
  if (measured.generation >= quiesced.generation) {
    return giveUp(quiesced, 'unknown', [`parent generation ${measured.generation} is not older than the fence generation ${quiesced.generation}`])
  }
  const identity = ports.identity(measured.pid)
  if (identity === undefined) return giveUp(quiesced, 'unknown', ['parent process identity unreadable'])
  const profile = ports.expectedProfile(measured.sessionKey)
  if (profile === undefined) return giveUp(quiesced, 'unknown', ['parent session is not supervised'])

  // ── REPLACE ──────────────────────────────────────────────────────────────
  const replacing = await store.advance(quiesced)
  if (replacing === null) return giveUp(quiesced, 'unknown', ['the fence could not advance to replacing'])
  const expected: ExpectedParent = {
    sessionKey: measured.sessionKey, childGeneration: measured.childGeneration,
    sessionId: measured.sessionId, pid: measured.pid, identity,
  }
  let replaced: ReplacementResult
  try { replaced = await ports.replace(expected) } catch (error) {
    replaced = { status: 'unknown', reason: errorText(error) }
  }
  if (replaced.status !== 'replaced') {
    // The store forbids `abandon` from `replacing`: admission stays CLOSED until an
    // attested replacement or an operator resume. That is the store's contract.
    const reason = replaced.status === 'refused' ? `replacement refused: ${replaced.reason}` : `replacement unknown: ${replaced.reason}`
    log?.error('project_generation_replacement_refused', { projectId, generation: replacing.generation, reason })
    return { status: 'unknown', reasons: [reason] }
  }

  // ── ATTEST, THEN REOPEN ──────────────────────────────────────────────────
  const attesting = await store.advance(replacing)
  if (attesting === null) {
    log?.error('project_generation_replacement_refused', { projectId, generation: replacing.generation, reason: 'could not advance to attesting' })
    return { status: 'attestation-failed', reasons: ['the fence could not advance to attesting'], generation: replacing.generation }
  }
  const observation = ports.observe(measured.sessionKey)
  const attested = attestReplacement(observation, {
    sessionId: measured.sessionId, priorChildGeneration: measured.childGeneration,
    generation: attesting.generation, toolSurface: profile.toolSurface, toolBridge: profile.toolBridge,
  })
  if (!attested.ok) {
    log?.error('project_generation_attestation_failed', { projectId, generation: attesting.generation, reasons: attested.reasons.join('; ') })
    return { status: 'attestation-failed', reasons: attested.reasons, generation: attesting.generation }
  }
  if (!(await store.reopen(attesting))) {
    log?.error('project_generation_attestation_failed', { projectId, generation: attesting.generation, reasons: 'reopen refused' })
    return { status: 'attestation-failed', reasons: ['reopen refused'], generation: attesting.generation }
  }
  log?.info('project_generation_replaced', { projectId, generation: attesting.generation })
  return {
    status: 'replaced',
    generation: attesting.generation,
    parent: { sessionId: measured.sessionId, from: measured.childGeneration, to: observation!.childGeneration },
  }
}

/**
 * RESTART CONTINUITY. A fence persisted by a previous process:
 *   - `draining`/`quiesced`: nothing was replaced — release it (`abandon`);
 *   - `replacing`/`attesting`: reopen ONLY when the live parent is the replacement
 *     (stamped with the fence's own generation) and it attests; otherwise HOLD the
 *     fence (fail closed). Boot never spawns, kills or abandons a replacement.
 */
export async function resumeProjectMaintenance(
  deps: ProjectMaintenanceDeps,
  projectId: string | null,
): Promise<ResumeOutcome> {
  const { admission, ports, log } = deps
  const store = admission.maintenance
  const fence = store.resume(admission.scopeFor(projectId))
  if (fence === null) return { status: 'open' }
  const held = (phase: MaintenancePhase, reasons: string[]): ResumeOutcome => {
    log?.error('project_maintenance_held', { projectId, phase, generation: fence.generation, reasons: reasons.join('; ') })
    return { status: 'held', phase, reasons }
  }
  if (fence.phase === 'draining' || fence.phase === 'quiesced') {
    return (await store.abandon(fence))
      ? { status: 'abandoned', phase: fence.phase }
      : held(fence.phase, ['the pre-replacement fence could not be released'])
  }
  let census: ProjectLivenessCensus
  try { census = await ports.census(projectId) } catch (error) {
    return held(fence.phase, [`census failed: ${errorText(error)}`])
  }
  const parent = census.parent
  if (parent.kind !== 'participating' || parent.generation !== fence.generation) {
    return held(fence.phase, [`no replacement parent at generation ${fence.generation} (parent is ${parent.kind})`])
  }
  const attesting = fence.phase === 'replacing' ? await store.advance(fence) : fence
  if (attesting === null) return held(fence.phase, ['the fence could not advance to attesting'])
  const profile = ports.expectedProfile(parent.sessionKey)
  if (profile === undefined) return held(attesting.phase, ['replacement parent is not supervised'])
  const attested = attestReplacement(ports.observe(parent.sessionKey), {
    sessionId: parent.sessionId, priorChildGeneration: null, generation: attesting.generation,
    toolSurface: profile.toolSurface, toolBridge: profile.toolBridge,
  })
  if (!attested.ok) return held(attesting.phase, attested.reasons)
  if (!(await store.reopen(attesting))) return held(attesting.phase, ['reopen refused'])
  return { status: 'reopened', generation: attesting.generation }
}
