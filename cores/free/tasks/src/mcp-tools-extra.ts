/**
 * @neutronai/tasks-core — Tier 1 S1 added MCP tools (`tasks_pick_next`).
 *
 * Kept in a sibling module from `tools.ts` so the legacy 5 (create /
 * list / update / complete / delete) and the new 1 (pick-next) can
 * evolve independently — if a future refactor drops the legacy 5,
 * this module stays standing.
 *
 * Capability gate: `read:tasks_core.db` (pick-next READS the focus_
 * score-ranked top open tasks; it does not mutate any row). The LLM
 * call itself happens INSIDE the Core's process boundary via the
 * supplied `PickNextService` — no manifest secret declaration needed.
 *
 * Spec input: docs/plans/tasks-core-tier1-brief.md § 4.
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { CORE_SLUG, READ_CAPABILITY } from './manifest.ts'
import type { TaskRow } from './backend.ts'
import type { PickNextService } from './pick-next.ts'

export interface TasksPickNextInput {
  project_id?: string
  /** Alternatives count to surface alongside the chosen candidate (default 3, cap 5). */
  limit_alternatives?: number
}

export interface TasksPickNextOutput {
  candidate: TaskRow | null
  rationale: string
  alternatives: TaskRow[]
  audit: {
    candidates_considered: number
    focus_score_used: boolean
    llm_model: string
  }
}

export interface ExtraToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  pickNext: PickNextService
  /**
   * Identity threaded onto the PickNextInput.user_id for audit. The
   * runtime composer fills this from the tool-call context; tests
   * may omit and fall back to the instance slug as a stable id.
   */
  user_id?: string
}

export interface BuiltExtraTools {
  tasks_pick_next: (input: TasksPickNextInput) => Promise<TasksPickNextOutput>
}

/**
 * Construct the pick-next tool handler, wrapped in the CapabilityGuard
 * audit envelope.
 */
export function buildExtraTools(deps: ExtraToolDeps): BuiltExtraTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })
  const userId = deps.user_id ?? deps.project_slug

  const tasks_pick_next = guard.wrapToolHandler<TasksPickNextInput, TasksPickNextOutput>({
    tool_name: 'tasks_pick_next',
    capability_required: READ_CAPABILITY,
    fn: async (input: TasksPickNextInput): Promise<TasksPickNextOutput> => {
      const pickInput: Parameters<PickNextService['pick']>[0] = { user_id: userId }
      if (input.project_id !== undefined) pickInput.project_id = input.project_id
      if (input.limit_alternatives !== undefined) {
        pickInput.limit_alternatives = input.limit_alternatives
      }
      const result = await deps.pickNext.pick(pickInput)
      return {
        candidate: result.candidate,
        rationale: result.rationale,
        alternatives: result.alternatives,
        audit: result.audit,
      }
    },
  })

  return { tasks_pick_next }
}
