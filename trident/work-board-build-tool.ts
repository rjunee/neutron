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
import { isTerminalPhase } from './state-machine.ts'
import { workBoardScopeKey } from '../work-board/store.ts'
import type { MergeMode, TridentRunStore } from './store.ts'

export const WORK_BOARD_DISPATCH_BUILD_TOOL = 'work_board_dispatch_build'
export const WORK_BOARD_START_TOOL = 'work_board_start'

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
  /**
   * The owner HOME base (Open: `resolveNeutronHome`). The chokepoint resolves
   * each project's own git-initialized workspace `<home>/Projects/<slug>/code`
   * under it — NOT the git repo directly — so brand-new projects are buildable.
   */
  repo_path: string
  /** Resolve the per-project git workspace; defaults to `ensureProjectBuildWorkspace`. */
  resolveBuildRepo?: (owner_home: string, project_slug: string) => Promise<string>
  resolveMergeMode?: () => Promise<MergeMode>
  resolveRalph?: () => Promise<boolean>
  channel_kind?: Topic['channel_kind']
  max_rounds?: number
  max_ralph_rounds?: number
  /**
   * Resolve the build spec for a board item — its `design_doc_ref` doc content
   * when present + readable, else the item title. Wired to the work-board
   * spec-doc service so `work_board_start` (and the ▶ button, via the HTTP
   * route) build from the SAME on-disk spec. When absent, `work_board_start`
   * falls back to the item title.
   */
  resolve_task?: (
    project_slug: string,
    item: { title: string; design_doc_ref: string | null },
  ) => Promise<string>
}

interface StartArgs {
  board_item_id?: unknown
}

const startOutputSchema: JsonSchemaDocument = {
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
      'run builds in parallel. ROUTE HERE for COMPLEX builds — multi-file, a real project or ' +
      'shared code, anything that warrants code review, or large/risky work — and TELL the owner ' +
      'you are routing to trident and why. Build SIMPLE work (a single file, a quick script, a ' +
      'small self-contained edit) INLINE with your own Read/Write/Edit tools instead; do not ' +
      'dispatch trivia here.',
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
      // Scope the build to the ACTIVE project of the composing turn — the run row's
      // `project_slug` AND the bound board item both key here, so a build started
      // while chatting in project X lands on X's board (not General). Mirrors the
      // HTTP ▶ route (`work-board-surface.ts`), which scope-keys from the URL.
      const scope = workBoardScopeKey(ctx.project_slug, ctx.project_id)
      const buildDeps: BoardBoundBuildDeps = {
        store: deps.store,
        board: deps.work_board,
        project_slug: scope,
        repo_path: deps.repo_path,
        ...(deps.resolveBuildRepo !== undefined ? { resolveBuildRepo: deps.resolveBuildRepo } : {}),
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

  // `work_board_start` — the agent-native equivalent of the ▶ (play) button:
  // START (never-dispatched item) or RETRY (last run failed/stopped) a build
  // bound to a Plan item, using the item's PERSISTED spec (its design_doc_ref
  // doc, else its title) as the task — no need to re-supply the full context.
  // Same `dispatchBoardBoundBuild` chokepoint (required item + ask-before-acting
  // gate), so a card that is both doc-less AND thin is REJECTED with the
  // clarifying-question guidance rather than firing a doomed build.
  registry.register({
    name: WORK_BOARD_START_TOOL,
    description:
      'START or RETRY an autonomous Forge→Argus→merge build (trident) for a Plan item, using the ' +
      "item's SAVED spec (its linked design doc, else its title) as the task — you do NOT re-supply " +
      'the context. Use this to (re)launch a card the owner added to the Plan or a card whose last ' +
      'build failed. Requires board_item_id. If the item is underspecified (no design doc AND a thin ' +
      'title) the start is REJECTED and you MUST ask the owner a clarifying question first. Returns ' +
      'immediately; the result reconciles onto the board when it lands. (To build with a DIFFERENT, ' +
      'explicitly-supplied task, use work_board_dispatch_build instead.)',
    input_schema: {
      type: 'object',
      properties: {
        board_item_id: {
          type: 'string',
          description: 'The Plan item to start/retry — REQUIRED. From work_board_list / work_board_add.',
        },
      },
      required: ['board_item_id'],
      additionalProperties: false,
    },
    output_schema: startOutputSchema,
    capability_required: 'agent:dispatch_subagent',
    approval_policy: 'prompt-user',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as StartArgs
      const board_item_id = typeof a.board_item_id === 'string' ? a.board_item_id.trim() : ''
      if (board_item_id.length === 0) {
        return { ok: false, error: 'board_item_id is required and must be a non-empty string' }
      }
      // Active-project scope (see `work_board_dispatch_build` above) — the item
      // lookup, the spec resolve, and the run creation all key on the same scope.
      const scope = workBoardScopeKey(ctx.project_slug, ctx.project_id)
      const item = deps.work_board.get(scope, board_item_id)
      if (item === null) {
        return {
          ok: false,
          error: `No Plan item "${board_item_id}" on this project's board. Use work_board_list to find the item id.`,
        }
      }
      // Don't launch a SECOND build for a card that already has a LIVE run —
      // `attachRun` would overwrite the binding and orphan the first build
      // (uncancelable/unreconcilable from the board). Parity with the HTTP ▶
      // route's `already_running` guard (Codex [P1]). A terminal linked run
      // (failed/stopped/done) is fine — that's the RETRY case.
      const linkedRunId = item.linked_run_id
      if (typeof linkedRunId === 'string' && linkedRunId.length > 0) {
        const run = deps.store.get(linkedRunId)
        if (run !== null && !isTerminalPhase(run.phase)) {
          return {
            ok: false,
            error: `Plan item "${board_item_id}" already has a live build (${linkedRunId}). Stop it (or wait for it) before starting another.`,
          }
        }
      }
      const task =
        deps.resolve_task !== undefined
          ? await deps.resolve_task(scope, {
              title: item.title,
              design_doc_ref: item.design_doc_ref,
            })
          : item.title
      const buildDeps: BoardBoundBuildDeps = {
        store: deps.store,
        board: deps.work_board,
        project_slug: scope,
        repo_path: deps.repo_path,
        ...(deps.resolveBuildRepo !== undefined ? { resolveBuildRepo: deps.resolveBuildRepo } : {}),
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
        board_item_id,
        status: 'dispatched',
      }
    },
  })
  return WORK_BOARD_DISPATCH_BUILD_TOOL
}
