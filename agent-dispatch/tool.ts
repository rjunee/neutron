/**
 * @neutronai/agent-dispatch — agent-native tool surface (`dispatch_agent`).
 *
 * Agent-native parity (a hard invariant): if a user can dispatch a background
 * agent (via the `/dispatch` chat command — `command.ts`), the live chat agent
 * can too. BOTH surfaces call the SAME `DispatchService.dispatch` backend — this
 * tool is a thin schema-validated wrapper, it holds no dispatch logic of its
 * own.
 *
 * The tool gates on the `agent:dispatch_subagent` capability (already in the
 * `NeutronCapability` union) and uses `prompt-user` approval: spawning a
 * background agent costs tokens + a process slot, so an agent-initiated
 * dispatch surfaces to the owner for a one-tap approval rather than firing
 * silently. The registry cap (`MAX_CONCURRENT_SUBAGENTS`) + double-spawn guard
 * are the second line of defence underneath.
 *
 * It returns IMMEDIATELY with the `run_id` (fire-and-forget) — the result is
 * delivered later through the service's report-back sink, exactly like `/code`
 * surfaces a Trident build's terminal result asynchronously.
 */

import type { JsonSchemaDocument } from '../core-sdk/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { workBoardScopeKey } from '../work-board/store.ts'
import { DISPATCH_KINDS, type DispatchKind } from './prompts.ts'
import type { DispatchRequest, DispatchService } from './service.ts'

export const DISPATCH_AGENT_TOOL = 'dispatch_agent'

const inputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: [...DISPATCH_KINDS],
      description:
        'Which specialist to dispatch: "research" (Atlas — research / analysis / ops / ' +
        'strategy / writing), "review" (Sentinel — independent quality check of NON-code ' +
        'work), or "adhoc" (a one-shot background agent with no named persona).',
    },
    task: {
      type: 'string',
      description:
        'The full task / instructions for the dispatched agent. It runs autonomously in its ' +
        'own session and reports the result back to this chat when done.',
    },
    board_item_id: {
      type: 'string',
      description:
        'The Plan (Work Board) item this dispatch is bound to — REQUIRED. Get it from ' +
        'work_board_list / work_board_add. A dispatch with no bound item is rejected; if the ' +
        'item is underspecified you must ask the owner a clarifying question before dispatching.',
    },
  },
  required: ['kind', 'task', 'board_item_id'],
  additionalProperties: false,
}

const outputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    run_id: { type: 'string', description: 'Registry run id — use it to stop or track the dispatch.' },
    kind: { type: 'string' },
    agent_kind: { type: 'string', description: 'The registry AgentKind it recorded under.' },
    status: { type: 'string', description: 'Always "dispatched" on success — the result arrives later.' },
  },
  required: ['run_id', 'kind', 'agent_kind', 'status'],
}

interface DispatchArgs {
  kind?: unknown
  task?: unknown
  board_item_id?: unknown
}

function isDispatchKind(v: unknown): v is DispatchKind {
  return typeof v === 'string' && (DISPATCH_KINDS as readonly string[]).includes(v)
}

/**
 * Register `dispatch_agent` against `registry`, backed by the dispatch service.
 * Returns the registered tool name.
 */
export function registerDispatchToolSurface(
  registry: ToolRegistry,
  service: DispatchService,
): string {
  registry.register({
    name: DISPATCH_AGENT_TOOL,
    description:
      'Dispatch a background specialist agent to autonomously complete a task and report the ' +
      'result back to this chat. Use "research" for investigation/analysis/writing, "review" ' +
      'for an independent quality check of non-code work, or "adhoc" for a one-off task. The ' +
      'agent runs in its own session; this returns immediately with a run_id.',
    input_schema: inputSchema,
    output_schema: outputSchema,
    capability_required: 'agent:dispatch_subagent',
    approval_policy: 'prompt-user',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as DispatchArgs
      if (!isDispatchKind(a.kind)) {
        throw new Error(
          `dispatch_agent: "kind" must be one of ${DISPATCH_KINDS.join(', ')}`,
        )
      }
      const task = typeof a.task === 'string' ? a.task.trim() : ''
      if (task.length === 0) {
        throw new Error('dispatch_agent: "task" is required and must be a non-empty string')
      }
      const board_item_id = typeof a.board_item_id === 'string' ? a.board_item_id.trim() : ''
      if (board_item_id.length === 0) {
        throw new Error(
          'dispatch_agent: "board_item_id" is required — bind the dispatch to a Plan item ' +
            '(work_board_add / work_board_list). No untracked dispatches.',
        )
      }
      // The service enforces the existence + ask-before-acting gate and throws a
      // DispatchValidationError (incl. the clarifying-question guidance) which
      // propagates to the agent as the tool error — exactly the intended block.
      // Scope the board lookup/binding to the ACTIVE project (the same scope the
      // `work_board_*` tools write under), so an item created while chatting in
      // project X is found here; General (no active project) → the owner slug.
      const req: DispatchRequest = {
        kind: a.kind,
        task,
        board_item_id,
        board_scope: workBoardScopeKey(ctx.project_slug, ctx.project_id),
      }
      const handle = await service.dispatch(req)
      return {
        run_id: handle.run_id,
        kind: a.kind,
        agent_kind: handle.record.agent_kind,
        status: 'dispatched',
      }
    },
  })
  return DISPATCH_AGENT_TOOL
}
