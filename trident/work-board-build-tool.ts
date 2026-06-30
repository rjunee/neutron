/**
 * @neutronai/trident — agent-native board-bound build dispatch tool
 * (`work_board_dispatch_build`, Work Board Phase 2b).
 *
 * Agent-native parity: a build started by a human via `/code --item <id>` can
 * also be started by the live orchestrator via this tool. It is the
 * orchestrator's handle on the trident loop — fire N of these (each bound to a
 * distinct Plan item) and N autonomous Forge→Argus→merge builds run in
 * PARALLEL, harvested independently by the durable `TridentTickLoop`, each
 * tracked live on its board item (fork `⑂`).
 *
 * The handler is a thin wrapper over the SAME `dispatchBoardBoundBuild`
 * chokepoint the `/code` command uses, so the hard rules are enforced once, in
 * one place:
 *   - board_item_id is REQUIRED (schema-required + chokepoint-rejected),
 *   - the item must exist, and
 *   - the ask-before-acting gate BLOCKS an underspecified item (returns the
 *     clarifying-question guidance instead of dispatching).
 *
 * It returns IMMEDIATELY with the run id (fire-and-forget) — the build runs
 * detached and its terminal result is delivered + reconciled onto the board by
 * the loop, exactly like `/code`.
 */

import type { JsonSchemaDocument } from '../core-sdk/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { Topic } from '../channels/types.ts'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import type { MergeMode, TridentRunStore } from './store.ts'

export const WORK_BOARD_DISPATCH_BUILD_TOOL = 'work_board_dispatch_build'

const inputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    board_item_id: {
      type: 'string',
      description:
        'The Plan (Work Board) item this build is bound to — REQUIRED. Get it from ' +
        'work_board_list / work_board_add. A build with no bound item is rejected.',
    },
    task: {
      type: 'string',
      description:
        'The full build task / instructions. Forge builds it, Argus reviews, and it merges ' +
        'autonomously; the result is reported back here when it lands.',
    },
  },
  required: ['board_item_id', 'task'],
  additionalProperties: false,
}

const outputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    run_id: { type: 'string', description: 'The trident run id (track / stop the build with it).' },
    board_item_id: { type: 'string' },
    status: { type: 'string', description: '"dispatched" on success; the result arrives later.' },
    error: { type: 'string', description: 'Set when ok=false — incl. the ask-before-acting guidance.' },
  },
  required: ['ok'],
}

interface DispatchBuildArgs {
  board_item_id?: unknown
  task?: unknown
}

/**
 * What the tool needs that is NOT per-call (the per-call project_slug comes from
 * the server-injected `ToolCallContext`). `work_board` + `store` write to the
 * SAME `db` the durable loop reads, so a row created here is fired by the loop.
 */
export interface TridentBuildToolDeps {
  store: TridentRunStore
  work_board: TridentBoardBinder
  /** Absolute repo path builds run in (Open: the owner's repo). */
  repo_path: string
  resolveMergeMode?: () => Promise<MergeMode>
  resolveRalph?: () => Promise<boolean>
  channel_kind?: Topic['channel_kind']
  max_rounds?: number
  max_ralph_rounds?: number
}

/** Register `work_board_dispatch_build` against `registry`. Returns the name. */
export function registerTridentBuildToolSurface(
  registry: ToolRegistry,
  deps: TridentBuildToolDeps,
): string {
  registry.register({
    name: WORK_BOARD_DISPATCH_BUILD_TOOL,
    description:
      'Start an autonomous Forge→Argus→merge build (trident) BOUND to a Plan item. Requires ' +
      'board_item_id — add the work to the Plan first if needed. If the item is underspecified ' +
      '(no design doc, terse title) the dispatch is REJECTED and you MUST ask the owner a ' +
      'clarifying question before retrying. Returns immediately; fire several (one per item) to ' +
      'run builds in parallel.',
    input_schema: inputSchema,
    output_schema: outputSchema,
    capability_required: 'agent:dispatch_subagent',
    approval_policy: 'prompt-user',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as DispatchBuildArgs
      const board_item_id = typeof a.board_item_id === 'string' ? a.board_item_id : undefined
      const task = typeof a.task === 'string' ? a.task.trim() : ''
      if (task.length === 0) {
        return { ok: false, error: 'task is required and must be a non-empty string' }
      }
      const buildDeps: BoardBoundBuildDeps = {
        store: deps.store,
        board: deps.work_board,
        project_slug: ctx.project_slug,
        repo_path: deps.repo_path,
        ...(deps.resolveMergeMode !== undefined ? { resolveMergeMode: deps.resolveMergeMode } : {}),
        ...(deps.resolveRalph !== undefined ? { resolveRalph: deps.resolveRalph } : {}),
        ...(deps.channel_kind !== undefined ? { channel_kind: deps.channel_kind } : {}),
        ...(deps.max_rounds !== undefined ? { max_rounds: deps.max_rounds } : {}),
        ...(deps.max_ralph_rounds !== undefined ? { max_ralph_rounds: deps.max_ralph_rounds } : {}),
      }
      const result = await dispatchBoardBoundBuild({ board_item_id, task }, buildDeps)
      if (!result.ok) {
        return { ok: false, error: result.message }
      }
      return {
        ok: true,
        run_id: result.run.id,
        board_item_id: board_item_id ?? '',
        status: 'dispatched',
      }
    },
  })
  return WORK_BOARD_DISPATCH_BUILD_TOOL
}
