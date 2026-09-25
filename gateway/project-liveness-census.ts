/**
 * gateway/project-liveness-census.ts — the authoritative liveness census of ONE
 * project scope (#1237): its parent REPL, the parent's native children, and the
 * parent's shells.
 *
 * WHAT IT IS FOR. `ProjectAdmissionStore.advance(draining → quiesced)` proves only
 * that participating producers released their leases. A maintenance owner also
 * needs evidence about the things no lease describes: the parent's own turn, a
 * native child that outlived the dispatch turn that started it, a shell the parent
 * left running. This module answers that — and nothing else. It fences, advances,
 * replaces and attests NOTHING, and no trigger calls it in this build.
 *
 * THE DECISION IS PURE ({@link decideProjectLiveness}); the probes are injected
 * ({@link ProjectLivenessProbes}) and every one may answer `unknown`. Verdict order
 * is load-bearing: any `busy` → busy; else any `unknown` → unknown; else idle.
 *
 * THE RULES THAT KEEP IT HONEST.
 *   - Empty local counters cannot prove a previous gateway's children stopped
 *     (`docs/as-built/claude-native-profile-rollback.md`). So a parent with NO
 *     admission-generation stamp — a legacy or adopted-legacy parent, whose native
 *     children never held leases — reads children `unknown` whatever the leases and
 *     the transcript directory say. Only a participating (stamped) parent can have
 *     its children read idle, and then only from the leases.
 *   - Several candidate parents, or a supervised candidate whose child cannot be
 *     identified, is not a parent: every part reads `unknown`.
 *   - "false and unknown must not share a branch": an unreadable `/proc`, a
 *     recycled parent pid, or an unreadable transcript directory is `unknown`, never
 *     idle.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readProcessIdentity, type ProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import type { ProjectAdmission } from './project-admission.ts'
import type { ProjectAdmissionScope } from './project-admission-store.ts'

export type Verdict = 'idle' | 'busy' | 'unknown'

/** A native child whose transcript was written this recently is presumed running. */
export const NATIVE_CHILD_RECENT_MS = 120_000
/** How many descendant `comm` names a census records (names, never paths). */
export const SHELL_REASON_LIMIT = 3

export interface ProbeAnswer { verdict: Verdict; reasons: string[] }

/** One candidate parent session, as the pool reports it. */
export interface ParentObservation {
  sessionKey: string
  childGeneration: string
  sessionId: string
  pid: number
  /** The admission generation the child was SPAWNED under; undefined = legacy. */
  admissionGeneration: number | undefined
  /** `activeTurn !== undefined`. */
  activeTurn: boolean
  /** The session's turn-slot counter (busy STARTS here, not at `activeTurn`). */
  turnSlotHeld: number
  poisoned: boolean
  /** The pool is retiring this key; its state is in motion. */
  retiring: boolean
  /** The parent transcript's `subagents` directory; null when it cannot be resolved. */
  subagentsDirectory: string | null
}

export type SessionsAnswer =
  | { kind: 'answered'; live: ParentObservation[]; unresolved: number }
  | { kind: 'unknown'; reason: string }

export interface ProjectLivenessProbes {
  /** The live parent sessions for the scope by the pool's exact-identity rule. */
  sessions(projectId: string | null): Promise<SessionsAnswer>
  /** The activity inspector's `turn_in_flight` for the scope. */
  turnInFlight(projectId: string | null): boolean
  /** Non-terminal build runs in the scope WITHOUT a build lease (reconcile's
   *  `unleased_fenced`/`unknown` case). Optional; absent = not consulted. */
  unleasedLiveRuns?(projectId: string | null): number
  /** Recent native-child transcript activity in a parent's `subagents` directory. */
  subagentActivity(directory: string, nowMs: number): Promise<ProbeAnswer>
  /** Any descendant process of the parent pid. */
  descendants(pid: number): Promise<ProbeAnswer>
  /** Optional terminal-host view of the parent's pane (herdr `pane.process_info`). */
  paneForeground?(sessionKey: string): Promise<ProbeAnswer>
}

export type CensusParent =
  | { kind: 'absent' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'unidentified'; reason: string }
  | { kind: 'legacy-unknown'; sessionKey: string; childGeneration: string; sessionId: string }
  | { kind: 'participating'; sessionKey: string; childGeneration: string; sessionId: string; generation: number; pid: number }

export interface ProjectLivenessCensus {
  scope: ProjectAdmissionScope
  fence: ReturnType<ProjectAdmission['inspect']>
  parent: CensusParent
  parentTurn: Verdict
  children: Verdict
  shells: Verdict
  verdict: Verdict
  reasons: string[]
  observedAt: string
}

/** busy beats unknown beats idle. */
export function combineVerdicts(...verdicts: Verdict[]): Verdict {
  if (verdicts.includes('busy')) return 'busy'
  if (verdicts.includes('unknown')) return 'unknown'
  return 'idle'
}

/** Everything the pure decision reads, already gathered. */
export interface CensusEvidence {
  sessions: SessionsAnswer
  turnInFlight: boolean
  childLeases: number
  unleasedLiveRuns: number
  /** Per-parent probe answers; only read when exactly one parent was identified. */
  subagents?: ProbeAnswer
  descendants?: ProbeAnswer
  pane?: ProbeAnswer
}

/** The pure census decision. */
export function decideProjectLiveness(evidence: CensusEvidence): Omit<ProjectLivenessCensus, 'scope' | 'fence' | 'observedAt'> {
  const reasons: string[] = []
  const leaseChildren: Verdict = evidence.childLeases > 0 || evidence.unleasedLiveRuns > 0 ? 'busy' : 'idle'
  if (evidence.childLeases > 0) reasons.push(`native-child leases held: ${evidence.childLeases}`)
  if (evidence.unleasedLiveRuns > 0) reasons.push(`live build runs without a lease: ${evidence.unleasedLiveRuns}`)
  const done = (parent: CensusParent, parentTurn: Verdict, children: Verdict, shells: Verdict) =>
    ({ parent, parentTurn, children, shells, verdict: combineVerdicts(parentTurn, children, shells), reasons })

  const sessions = evidence.sessions
  if (sessions.kind === 'unknown') {
    reasons.push(`parent sessions unreadable: ${sessions.reason}`)
    return done({ kind: 'unidentified', reason: sessions.reason }, 'unknown', combineVerdicts(leaseChildren, 'unknown'), 'unknown')
  }
  const count = sessions.live.length + sessions.unresolved
  if (count === 0) {
    // No parent: nothing of a parent's can be running. The turn signal is still
    // honoured (a turn in flight with no session is a spawn in progress).
    const parentTurn: Verdict = evidence.turnInFlight ? 'busy' : 'idle'
    if (evidence.turnInFlight) reasons.push('a turn is in flight for the scope')
    return done({ kind: 'absent' }, parentTurn, leaseChildren, 'idle')
  }
  if (sessions.live.length !== 1 || sessions.unresolved > 0) {
    if (sessions.live.length > 1 || count > 1) {
      reasons.push(`ambiguous parent: ${count} candidate sessions`)
      return done({ kind: 'ambiguous', count }, 'unknown', combineVerdicts(leaseChildren, 'unknown'), 'unknown')
    }
    reasons.push('a supervised parent candidate has no identifiable child')
    return done({ kind: 'unidentified', reason: 'unresolved candidate' }, 'unknown', combineVerdicts(leaseChildren, 'unknown'), 'unknown')
  }

  const observed = sessions.live[0]!
  const parent: CensusParent = observed.admissionGeneration === undefined
    ? { kind: 'legacy-unknown', sessionKey: observed.sessionKey, childGeneration: observed.childGeneration, sessionId: observed.sessionId }
    : { kind: 'participating', sessionKey: observed.sessionKey, childGeneration: observed.childGeneration,
      sessionId: observed.sessionId, generation: observed.admissionGeneration, pid: observed.pid }

  let parentTurn: Verdict = 'idle'
  if (observed.activeTurn || observed.turnSlotHeld > 0 || observed.poisoned || evidence.turnInFlight) {
    parentTurn = 'busy'
    reasons.push(`parent turn busy (${[
      observed.activeTurn ? 'active turn' : '', observed.turnSlotHeld > 0 ? 'turn slot held' : '',
      observed.poisoned ? 'abandoned turn' : '', evidence.turnInFlight ? 'turn in flight' : '',
    ].filter(Boolean).join(', ')})`)
  } else if (observed.retiring) {
    parentTurn = 'unknown'
    reasons.push('parent session is being retired')
  }

  // Directory evidence only ever ADDS busy or unknown; a participating parent's
  // idle answer comes from the leases alone.
  const subagents = evidence.subagents ?? { verdict: 'unknown' as const, reasons: ['native-child directory not probed'] }
  reasons.push(...subagents.reasons)
  let children = combineVerdicts(leaseChildren, subagents.verdict)
  if (parent.kind === 'legacy-unknown' && children !== 'busy') {
    children = 'unknown'
    reasons.push('legacy parent: its native children held no leases, so none can be proven finished')
  }

  const descendants = evidence.descendants ?? { verdict: 'unknown' as const, reasons: ['shells not probed'] }
  reasons.push(...descendants.reasons)
  let shells = descendants.verdict
  if (evidence.pane !== undefined) {
    reasons.push(...evidence.pane.reasons)
    shells = combineVerdicts(shells, evidence.pane.verdict)
  }
  return done(parent, parentTurn, children, shells)
}

/** Run the census: gather every probe for the scope, then decide. */
export async function runProjectLivenessCensus(deps: {
  admission: ProjectAdmission
  probes: ProjectLivenessProbes
  now?: () => number
}, projectId: string | null): Promise<ProjectLivenessCensus> {
  const now = deps.now ?? Date.now
  const scope = deps.admission.scopeFor(projectId)
  const fence = deps.admission.inspect(projectId)
  const sessions = await deps.probes.sessions(projectId).catch((error: unknown): SessionsAnswer =>
    ({ kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }))
  const childLeases = deps.admission.listLeases('liveChild')
    .filter((lease) => lease.scope.projectId === scope.projectId).length
  const evidence: CensusEvidence = {
    sessions,
    turnInFlight: deps.probes.turnInFlight(projectId),
    childLeases,
    unleasedLiveRuns: deps.probes.unleasedLiveRuns?.(projectId) ?? 0,
  }
  if (sessions.kind === 'answered' && sessions.live.length === 1 && sessions.unresolved === 0) {
    const parent = sessions.live[0]!
    const guard = (p: Promise<ProbeAnswer>, what: string): Promise<ProbeAnswer> => p.catch((error: unknown) => ({
      verdict: 'unknown' as const, reasons: [`${what} probe failed: ${error instanceof Error ? error.message : String(error)}`] }))
    evidence.subagents = parent.subagentsDirectory === null
      ? { verdict: 'unknown', reasons: ['native-child directory unresolvable'] }
      : await guard(deps.probes.subagentActivity(parent.subagentsDirectory, now()), 'native-child directory')
    evidence.descendants = await guard(deps.probes.descendants(parent.pid), 'shell')
    if (deps.probes.paneForeground !== undefined) {
      evidence.pane = await guard(deps.probes.paneForeground(parent.sessionKey), 'pane')
    }
  }
  return { scope, fence, ...decideProjectLiveness(evidence), observedAt: new Date(now()).toISOString() }
}

/**
 * Native-child transcript activity: any `agent-*.jsonl` written within
 * {@link NATIVE_CHILD_RECENT_MS} → busy. A missing directory (ENOENT) or no recent
 * file → idle; any other read failure → unknown.
 */
export async function readSubagentActivity(directory: string, nowMs: number, recentMs = NATIVE_CHILD_RECENT_MS): Promise<ProbeAnswer> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { verdict: 'idle', reasons: [] }
    return { verdict: 'unknown', reasons: [`native-child directory unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`] }
  }
  let recent = 0
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue
    try {
      const info = await stat(join(directory, name))
      if (nowMs - info.mtimeMs < recentMs) recent += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { verdict: 'unknown', reasons: [`native-child transcript unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`] }
    }
  }
  return recent > 0
    ? { verdict: 'busy', reasons: [`recent native-child transcripts: ${recent}`] }
    : { verdict: 'idle', reasons: [] }
}

export interface ProcWalkDeps {
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
  identity?: (pid: number) => ProcessIdentity | undefined
  /** A DIRECT child the parent always runs by design (its own stdio MCP servers):
   *  not a shell. Its descendants are still walked. */
  isOwnService?: (argv: string[]) => boolean
}

const sameIdentity = (a: ProcessIdentity | undefined, b: ProcessIdentity | undefined): boolean =>
  a !== undefined && b !== undefined && a.start_ticks === b.start_ticks && a.boot_id === b.boot_id

/**
 * Every descendant of `pid`, walked through `/proc/<pid>/task/<tid>/children`. The
 * parent's identity is read before the walk and re-checked after it, so a pid
 * recycled mid-walk cannot answer. Unreadable `/proc` or identity → unknown; any
 * descendant (other than the parent's own services) → busy, recording up to
 * {@link SHELL_REASON_LIMIT} `comm` names — never a path or an argv.
 */
export async function walkProcessDescendants(pid: number, deps: ProcWalkDeps = {}): Promise<ProbeAnswer> {
  const readText = deps.readFile ?? ((path: string) => readFile(path, 'utf8'))
  const list = deps.readdir ?? ((path: string) => readdir(path))
  const identity = deps.identity ?? ((p: number) => readProcessIdentity(p))
  const before = identity(pid)
  if (before === undefined) return { verdict: 'unknown', reasons: ['parent process identity unreadable'] }

  const childrenOf = async (p: number): Promise<number[] | null> => {
    let tids: string[]
    try { tids = await list(`/proc/${p}/task`) } catch (error) {
      // Only positive process absence licenses an empty descendant list.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
    }
    const out: number[] = []
    for (const tid of tids) {
      let raw: string
      try { raw = await readText(`/proc/${p}/task/${tid}/children`) } catch (error) {
        // A vanished thread does not prove its process exited. Confirm absence
        // at the process directory; permission and other failures stay unknown.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { await list(`/proc/${p}/task`) } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === 'ENOENT') return []
          }
        }
        return null
      }
      for (const token of raw.trim().split(/\s+/)) {
        const child = Number.parseInt(token, 10)
        if (Number.isInteger(child) && child > 0) out.push(child)
      }
    }
    return out
  }

  const rootChildren = await childrenOf(pid)
  if (rootChildren === null) return { verdict: 'unknown', reasons: ['parent process tree unreadable'] }
  const shells: string[] = []
  let unreadable = false
  const seen = new Set<number>([pid])
  const queue = rootChildren.map((child) => ({ pid: child, direct: true }))
  while (queue.length > 0) {
    const next = queue.shift()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    let own = false
    if (next.direct && deps.isOwnService !== undefined) {
      try {
        const argv = (await readText(`/proc/${next.pid}/cmdline`)).split('\0').filter(Boolean)
        own = deps.isOwnService(argv)
      } catch { /* vanished or unreadable: counted as a shell below if still listed */ }
    }
    if (!own) {
      let comm = 'unknown'
      try { comm = (await readText(`/proc/${next.pid}/comm`)).trim() || 'unknown' } catch { /* keep placeholder */ }
      shells.push(comm)
    }
    // An exempt service still has to prove its descendants are absent.
    const grand = await childrenOf(next.pid)
    if (grand === null) unreadable = true
    for (const g of grand ?? []) queue.push({ pid: g, direct: false })
  }

  if (!sameIdentity(before, identity(pid))) return { verdict: 'unknown', reasons: ['parent pid changed identity during the census'] }
  if (shells.length === 0) return unreadable
    ? { verdict: 'unknown', reasons: ['descendant process tree unreadable'] }
    : { verdict: 'idle', reasons: [] }
  const names = shells.slice(0, SHELL_REASON_LIMIT).join(', ')
  return { verdict: 'busy', reasons: [`parent descendants running: ${shells.length} (${names}${shells.length > SHELL_REASON_LIMIT ? ', …' : ''})`] }
}
