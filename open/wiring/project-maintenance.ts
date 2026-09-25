/**
 * open/wiring/project-maintenance.ts — the production ports behind the project
 * maintenance owner (#1237, `gateway/project-generation-replacement.ts`).
 *
 * The replacement re-spawns the parent through its SUPERVISED options with the
 * project REPL's real surface (`PROJECT_REPL_TOOL_DEFS`, the spec the project
 * prewarm and the acting turn already use), so the next dispatch reuses it instead
 * of evicting it. The attestation's expected profile is computed from that SAME spec
 * by the reuse guard's own rule (`requestedProfileFor`), never typed a second time.
 *
 * #1226 coordination: nothing here changes the pool key, the credential identity,
 * the project id or the workspace record. A credential rotation that re-keys the
 * parent is not a replacement; its key is simply not the one the census measured.
 *
 * EXPOSED ONLY. `replace` has no caller in production; `resume` runs once per scope
 * at boot (restart continuity) from the composer's `on_graph_ready`.
 */
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import {
  observePooledSession,
  replaceQuiescentPooledSession,
  requestedProfileFor,
} from '@neutronai/runtime/adapters/claude-code/persistent/generation-replacement.ts'
import { readProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import type { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import {
  replaceProjectGeneration,
  resumeProjectMaintenance,
  type MaintenanceLog,
  type ProjectMaintenancePorts,
  type ReplacementOutcome,
  type ResumeOutcome,
} from '@neutronai/gateway/project-generation-replacement.ts'
import { PROJECT_REPL_TOOL_DEFS } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { ProjectLivenessSurface } from './project-liveness.ts'

/** The maintenance surface the composition exposes. `null` is General. */
export interface ProjectMaintenanceSurface {
  replace(projectId: string | null): Promise<ReplacementOutcome>
  resume(projectId: string | null): Promise<ResumeOutcome>
}

/** The prompt of the replacement spawn: the project prewarm's, answered by nothing. */
export const REPLACEMENT_SPAWN_PROMPT = 'Reply with the single word: ready'

/** The spec a replacement is spawned with — the project REPL's real surface. */
export function replacementSpec(): AgentSpec {
  return { prompt: REPLACEMENT_SPAWN_PROMPT, tools: PROJECT_REPL_TOOL_DEFS, model_preference: [getBestModel()], max_tokens: 16 }
}

export function buildProjectMaintenancePorts(liveness: ProjectLivenessSurface): ProjectMaintenancePorts {
  return {
    census: (projectId) => liveness.census(projectId),
    replace: (expected) => replaceQuiescentPooledSession(expected, replacementSpec()),
    observe: (sessionKey) => observePooledSession(sessionKey),
    identity: (pid) => readProcessIdentity(pid),
    expectedProfile: (sessionKey) => requestedProfileFor(sessionKey, replacementSpec()),
  }
}

export function buildProjectMaintenance(deps: {
  admission: ProjectAdmission
  liveness: ProjectLivenessSurface
  log?: MaintenanceLog
  /** Override the production ports (tests). */
  ports?: ProjectMaintenancePorts
}): ProjectMaintenanceSurface {
  const ports = deps.ports ?? buildProjectMaintenancePorts(deps.liveness)
  const owner = { admission: deps.admission, ports, ...(deps.log !== undefined ? { log: deps.log } : {}) }
  return {
    replace: (projectId) => replaceProjectGeneration(owner, projectId),
    resume: (projectId) => resumeProjectMaintenance(owner, projectId),
  }
}
