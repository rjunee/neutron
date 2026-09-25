/**
 * open/wiring/project-liveness.ts — the production probes behind the project
 * liveness census (#1237, `gateway/project-liveness-census.ts`).
 *
 * Assembled from what the Open composition already owns: the persistent-REPL pool
 * state (the parent and its pid), the activity inspector (a turn in flight for the
 * scope), the run store (live builds with no lease) and the admission service (the
 * native-child leases, read by the census itself). READ-ONLY: nothing here fences,
 * replaces or attests, and no loop or trigger calls it — the composition only
 * exposes it (`project_liveness`).
 */
import { join } from 'node:path'
import { retiringSessionKeys } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { sessionJsonlPath } from '@neutronai/runtime/adapters/claude-code/persistent/jsonl-resumability.ts'
import {
  DEFAULT_DEV_CHANNEL_PATH,
  DEFAULT_TOOLS_BRIDGE_PATH,
  resolveTranscriptProjectsDir,
} from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import {
  matchesConfiguredService,
  readSubagentActivity,
  runProjectLivenessCensus,
  walkProcessDescendants,
  type ConfiguredServiceLaunch,
  type ProjectLivenessCensus,
  type ProjectLivenessProbes,
} from '@neutronai/gateway/project-liveness-census.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

/** The census surface the composition exposes. `null` is General. */
export interface ProjectLivenessSurface {
  /** Handoff excludes the requesting dispatch's scope activity; the exact pool
   * session's turn state and all descendant evidence remain authoritative. */
  census(projectId: string | null, options?: { excludePendingDispatch?: boolean }): Promise<ProjectLivenessCensus>
}

export interface ProjectLivenessProbeDeps {
  admission: ProjectAdmission
  /** `ActivityInspector.snapshot(inspectorScopeKey(projectId)).turn_in_flight`. */
  turnInFlight(projectId: string | null): boolean
  /** Live (non-terminal) build runs, and the admission scope each belongs to. */
  runs?: { listNonTerminal(limit: number): TridentRun[] }
  projectIdForRun?(run: TridentRun): string | null
  /** The owner-installed stdio MCP servers the parent's MCP configuration launches
   * (the SAME registry the spawn reads). A direct child whose argv is exactly one of
   * these launches is an own service, not a shell. Absent = only the built-ins. */
  ownServices?(): Promise<ReadonlyArray<ConfiguredServiceLaunch>> | ReadonlyArray<ConfiguredServiceLaunch>
}

/** Listing limit for live runs — explicit and large; a truncated list would hide one. */
const LIVE_RUNS_LIMIT = 1_000_000

/**
 * The pool names General `'general'` or leaves it absent (`ReplSession.projectId`);
 * admission names it null. A real project whose id is literally `general` shares
 * that pool value, so the sessions probe also drops candidates whose RECORDED
 * conversation scope is positively another one (#1226: General and the literal
 * `general` project are two scopes). A candidate with no recorded scope stays — it
 * cannot be attributed, so it still reads ambiguous rather than absent.
 */
function poolProjectIds(projectId: string | null): ReadonlyArray<string | undefined> {
  return projectId === null ? ['general', undefined] : [projectId]
}

export function buildProjectLivenessProbes(deps: ProjectLivenessProbeDeps): ProjectLivenessProbes {
  return {
    sessions: async (projectId) => {
      const resolved = await resolveLiveProjectSessions(poolProjectIds(projectId), {
        excludeConversationScopesOtherThan: projectId,
      })
      return {
        kind: 'answered',
        unresolved: resolved.unresolved,
        live: resolved.live.map(({ sessionKey, options, session }) => {
          let subagentsDirectory: string | null = null
          try {
            const transcript = sessionJsonlPath(session.sessionId, session.cwd, resolveTranscriptProjectsDir(options))
            subagentsDirectory = join(transcript.slice(0, -'.jsonl'.length), 'subagents')
          } catch { /* unresolvable: the census reads the directory as unknown */ }
          return {
            sessionKey,
            childGeneration: session.childGeneration,
            sessionId: session.sessionId,
            pid: session.child.pid,
            admissionGeneration: session.admissionGeneration,
            activeTurn: session.activeTurn !== undefined,
            turnSlotHeld: session.turnSlotHeld,
            poisoned: session.poisoned,
            retiring: retiringSessionKeys.has(sessionKey),
            subagentsDirectory,
          }
        }),
      }
    },
    turnInFlight: (projectId) => deps.turnInFlight(projectId),
    ...(deps.runs !== undefined && deps.projectIdForRun !== undefined
      ? {
          unleasedLiveRuns: (projectId: string | null): number => {
            const leased = new Set(deps.admission.listLeases('build')
              .filter((lease) => lease.scope.projectId === projectId).map((lease) => lease.workRef))
            return deps.runs!.listNonTerminal(LIVE_RUNS_LIMIT)
              .filter((run) => deps.projectIdForRun!(run) === projectId && !leased.has(run.id)).length
          },
        }
      : {}),
    subagentActivity: (directory, nowMs) => readSubagentActivity(directory, nowMs),
    descendants: async (pid) => {
      // The parent's own stdio MCP servers (the dev channel, the tools bridge and every
      // owner-installed server its configuration launches) run for its whole life by
      // design; they are not shells. Their descendants are still walked. An unreadable
      // registry proves nothing: only the built-ins are exempt, so a server reads busy.
      let installed: ReadonlyArray<ConfiguredServiceLaunch> = []
      try { installed = (await deps.ownServices?.()) ?? [] } catch { /* fail closed: built-ins only */ }
      return walkProcessDescendants(pid, {
        isOwnService: (argv) => argv.includes(DEFAULT_DEV_CHANNEL_PATH) || argv.includes(DEFAULT_TOOLS_BRIDGE_PATH)
          || matchesConfiguredService(argv, installed),
      })
    },
  }
}

export function buildProjectLiveness(deps: ProjectLivenessProbeDeps): ProjectLivenessSurface {
  const probes = buildProjectLivenessProbes(deps)
  return { census: (projectId, options) => runProjectLivenessCensus({
    admission: deps.admission,
    // A handoff's requesting dispatch is already visible to ActivityInspector,
    // but has not entered the old owner. Its turn is measured by the pool's
    // activeTurn/turnSlotHeld/poisoned evidence; descendants still need proof.
    probes: options?.excludePendingDispatch === true ? { ...probes, turnInFlight: () => false } : probes,
  }, projectId) }
}
