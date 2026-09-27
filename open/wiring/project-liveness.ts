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
import { resolveTranscriptProjectsDir } from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import { OWN_SERVICE_PROVENANCE_ENV } from '@neutronai/runtime/mcp-servers.ts'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import {
  readSubagentActivity,
  runProjectLivenessCensus,
  walkProcessDescendants,
  type ProjectLivenessCensus,
  type ProjectLivenessProbes,
} from '@neutronai/gateway/project-liveness-census.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'

/** The census surface the composition exposes. `null` is General. */
export interface ProjectLivenessSurface {
  census(projectId: string | null): Promise<ProjectLivenessCensus>
}

export interface ProjectLivenessProbeDeps {
  admission: ProjectAdmission
  /** `ActivityInspector.snapshot(inspectorScopeKey(projectId)).turn_in_flight`. */
  turnInFlight(projectId: string | null): boolean
  /** Live (non-terminal) build runs, and the admission scope each belongs to. */
  runs?: { listNonTerminal(limit: number): TridentRun[] }
  projectIdForRun?(run: TridentRun): string | null
}

/** Listing limit for live runs — explicit and large; a truncated list would hide one. */
const LIVE_RUNS_LIMIT = 1_000_000

/**
 * The pool names General `'general'` or leaves it absent (`ReplSession.projectId`);
 * admission names it null. A real project whose id is literally `general` shares
 * that pool value today — the pool's existing boundary, not a new one.
 */
function poolProjectIds(projectId: string | null): ReadonlyArray<string | undefined> {
  return projectId === null ? ['general', undefined] : [projectId]
}

export function buildProjectLivenessProbes(deps: ProjectLivenessProbeDeps): ProjectLivenessProbes {
  return {
    sessions: async (projectId) => {
      const resolved = await resolveLiveProjectSessions(poolProjectIds(projectId))
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
    descendants: ({ pid, childGeneration }) => walkProcessDescendants(pid, {
      // The parent's own stdio MCP servers — the dev channel, the tools bridge and
      // every owner-installed server, including the real server an `npx`/`uvx`
      // wrapper starts — run for its whole life by design and are not shells. They
      // are recognised ONLY by the provenance marker the spawn wrote into their
      // mcp-config env, valued with this parent's `childGeneration` (the spawn
      // record), never by argv. An empty generation exempts nothing.
      ownService: { env: OWN_SERVICE_PROVENANCE_ENV, value: childGeneration },
    }),
  }
}

export function buildProjectLiveness(deps: ProjectLivenessProbeDeps): ProjectLivenessSurface {
  const probes = buildProjectLivenessProbes(deps)
  return { census: (projectId) => runProjectLivenessCensus({ admission: deps.admission, probes }, projectId) }
}
