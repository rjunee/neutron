/**
 * @neutronai/work-board — agent tool surface (`work_board_*`).
 *
 * The orchestrator's read+write handle on its own external memory. Registered
 * into the SAME `neutron` tools registry the #87 tools-bridge advertises, so
 * the live chat REPL reaches them as `mcp__neutron__work_board_*` (no `--tools`
 * edit — the board tools ride the MCP bridge, unlike the CC-native `Workflow`
 * tool).
 *
 * Tools: `work_board_list`, `work_board_add`, `work_board_update`,
 * `work_board_complete`, `work_board_reorder`, and — when a removal chokepoint
 * is wired — `work_board_remove`. All `approval_policy:'auto'` with a
 * `read:project_data` / `write:project_data` capability (mirrors
 * `memory_search`).
 *
 * SECURITY + SCOPE: the storage scope is NEVER an agent-supplied argument. It is
 * derived at dispatch time from the server-injected `ToolCallContext` via
 * `workBoardScopeKey(ctx.project_slug, ctx.project_id)` — `project_slug` is the
 * owner/instance boundary (`mcp/server.ts` overrides it on every dispatch, so the
 * model cannot spoof it) and `project_id` is the ACTIVE project of the composing
 * turn (threaded from the topic-agnostic warm REPL's per-project session scope).
 * So a card added while chatting in project X lands on X's board; a General turn
 * (no active project) still scopes to the owner slug (the General board). The
 * input schemas expose only `title / status / design_doc_ref / id / before|after`.
 * `design_doc_ref` schemes are allow-listed at the store.
 */

import type { JsonSchemaDocument } from '@neutronai/cores-sdk/manifest'
import type { ToolRegistry } from '@neutronai/tools/registry.ts'
import {
  WorkBoardValidationError,
  GENERAL_WORK_BOARD_PROJECT_ID,
  workBoardScopeKey,
  type CreateWorkBoardItemInput,
  type ReorderTarget,
  type WorkBoardItem,
  type WorkBoardItemUpdate,
  type WorkBoardStatus,
  type WorkBoardStore, WorkBoardRunStillLiveError } from './store.ts'
import type { WorkBoardSpecDocService } from './spec-doc-service.ts'
import type { WorkBoardChatAck } from './chat-ack.ts'
import {
  WORK_BOARD_REMOVAL_REASONS,
  type WorkBoardRemovalReason,
  type WorkBoardRemovalService,
} from './removal.ts'

export const WORK_BOARD_LIST_TOOL = 'work_board_list'
export const WORK_BOARD_ADD_TOOL = 'work_board_add'
export const WORK_BOARD_UPDATE_TOOL = 'work_board_update'
export const WORK_BOARD_COMPLETE_TOOL = 'work_board_complete'
export const WORK_BOARD_REORDER_TOOL = 'work_board_reorder'
export const WORK_BOARD_REMOVE_TOOL = 'work_board_remove'

// 'failed' is deliberately ABSENT: it is run-driven (only the terminal reconcile
// writes it), so it is not client-writable. 'archived' IS here — it is the
// deprioritise lever.
const STATUS_VALUES: WorkBoardStatus[] = ['upcoming', 'in_progress', 'done', 'archived']

const statusProp = {
  type: 'string',
  enum: STATUS_VALUES,
  description:
    "Lane: 'upcoming' (backlog) | 'in_progress' (active) | 'done' (SHIPPED — it happened) | " +
    "'archived' (SHELVED — deprioritised and taken off the active board WITHOUT shipping). " +
    "'archived' is not a quieter 'done': use it, never 'done'/work_board_complete, for anything " +
    'dropped, parked, or superseded, so the board never reports unshipped work as completed. ' +
    'A shelved card keeps its history and can be un-shelved back to upcoming.',
}

const designDocRefProp = {
  type: 'string',
  description:
    'Optional pointer to the full design doc for this item. Must be an https URL or an ' +
    'in-app docs link; javascript:/data:/file: are rejected.',
}

const itemSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: STATUS_VALUES },
    sort_order: { type: 'integer' },
    design_doc_ref: { type: ['string', 'null'] },
    inline_active: { type: 'boolean' },
    linked_run_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    completed_at: { type: ['string', 'null'] },
  },
  required: ['id', 'title', 'status', 'sort_order'],
}

const listOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: { items: { type: 'array', items: itemSchema } },
  required: ['items'],
}

const mutationOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    item: itemSchema,
    error: { type: 'string' },
  },
  required: ['ok'],
}

interface AddArgs {
  title?: unknown
  status?: unknown
  design_doc_ref?: unknown
  spec?: unknown
}
interface UpdateArgs {
  id?: unknown
  title?: unknown
  status?: unknown
  design_doc_ref?: unknown
  inline_active?: unknown
}
interface IdArg {
  id?: unknown
}
interface ReorderArgs {
  id?: unknown
  before?: unknown
  after?: unknown
}
interface RemoveArgs {
  id?: unknown
  reason?: unknown
  delete_plan_doc?: unknown
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asStatus(v: unknown): WorkBoardStatus | undefined {
  return typeof v === 'string' && (STATUS_VALUES as string[]).includes(v)
    ? (v as WorkBoardStatus)
    : undefined
}

/** Map a thrown validation error to a clean `{ ok:false, error }` tool result. */
function asErrorResult(err: unknown): { ok: false; error: string } {
  if (err instanceof WorkBoardValidationError) return { ok: false, error: err.message }
  throw err
}

function ok(item: WorkBoardItem | null): { ok: true; item?: WorkBoardItem } {
  return item === null ? { ok: true } : { ok: true, item }
}

/**
 * Register the `work_board_*` tools against `registry`, backed by the SINGLE
 * shared `WorkBoardStore` the HTTP surface + the per-turn injection also use
 * (one code path — every mutation fires the store's `onChange` push). Returns
 * the registered tool names.
 */
export function registerWorkBoardToolSurface(
  registry: ToolRegistry,
  store: WorkBoardStore,
  opts?: {
    /**
     * When wired, `work_board_add` persists a spec doc for a non-trivial `spec`
     * and points the card's `design_doc_ref` at it (M1 on-disk spec). Absent
     * (legacy / LLM-less boxes) the add falls back to a title-only create and a
     * supplied `spec` is ignored.
     */
    specDoc?: WorkBoardSpecDocService
    /**
     * #429 task 4 — deterministic chat ack. When wired, a SUCCESSFUL agent
     * `work_board_add` posts a short `card_added` confirmation to the chat, and
     * a `work_board_update` that flips `inline_active` false→true posts an
     * `inline_started` confirmation — RIGHT AWAY, independent of the turn's own
     * single terminal reply(). Delivered durable+live via the composer's app-ws
     * seam. Absent → byte-identical to the pre-task-4 behaviour (no post).
     */
    chatAck?: WorkBoardChatAck
    /**
     * The ONE card-removal chokepoint (`work-board/removal.ts`) — the SAME
     * composer-built instance the HTTP DELETE behind the UI's X runs: cancel a
     * live bound run FIRST, then dispose the card's own `plans/` doc by the
     * removal reason, then hard-delete the row. When wired, `work_board_remove`
     * is registered so the agent removes cards through the human's path instead
     * of misreporting deprioritised work as `done`. Absent (legacy / removal-less
     * boots) → the tool is NOT registered and the other five register unchanged.
     */
    removal?: WorkBoardRemovalService
  },
): string[] {
  const specDoc = opts?.specDoc
  const chatAck = opts?.chatAck
  const removal = opts?.removal
  registry.register({
    name: WORK_BOARD_LIST_TOOL,
    description:
      'List the Work Board for this project — active + upcoming items first (in board order), ' +
      'then the completed history (newest first). The board is also injected into every turn; ' +
      'call this when you need the full list incl. ids / completed items.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    output_schema: listOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async (_args, ctx) => {
      return { items: store.list(workBoardScopeKey(ctx.project_slug, ctx.project_id)) }
    },
  })

  registry.register({
    name: WORK_BOARD_ADD_TOOL,
    description:
      'Add a new item to the Work Board (appended at the end). Use this BEFORE acting on a new ' +
      'piece of work so the board stays the source of truth. `title` is the ONE-line label. For ' +
      'anything more than a trivial one-liner, ALSO pass `spec` = the FULL context/ask (the ' +
      "user's request + any clarifying detail): it is persisted to a per-project plans/ doc so it " +
      "survives session resets and drives the ▶ build. A short one-liner needs no `spec`. Returns " +
      'the created item.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The ONE-line item text.' },
        status: statusProp,
        design_doc_ref: designDocRefProp,
        spec: {
          type: 'string',
          description:
            'The FULL context/ask for this item (multi-line ok). When substantial it is saved to a ' +
            'plans/ doc and the item is linked to it; a short one-liner is left title-only. Omit ' +
            'when `design_doc_ref` already points at a doc.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output_schema: mutationOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as AddArgs
      const title = asString(a.title) ?? ''
      const status = asStatus(a.status)
      const ref = asString(a.design_doc_ref)
      const spec = asString(a.spec)
      const scope = workBoardScopeKey(ctx.project_slug, ctx.project_id)
      try {
        let item: WorkBoardItem
        if (specDoc !== undefined) {
          // The BOARD gets the scope key; the DOC gets the project id. Passing the
          // scope for both is what wrote General's plans into a phantom project
          // directory named after the instance — this is the agent path, which is
          // the one that created the card the owner could not open.
          // `ctx.project_id` is NULL in the General scope — that is what General IS,
          // the no-project scope. The docs root still needs a real directory name,
          // and it must be the SAME word the wire and the Documents tab already use:
          // `GENERAL_WORK_BOARD_PROJECT_ID`. One constant, not a literal, so the
          // board's collapse and the docs root can never drift apart again.
          item = await specDoc.createCardWithOptionalSpec(
            scope,
            ctx.project_id ?? GENERAL_WORK_BOARD_PROJECT_ID,
            {
            title,
            ...(status !== undefined ? { status } : {}),
            ...(ref !== undefined ? { design_doc_ref: ref } : {}),
            ...(spec !== undefined ? { spec } : {}),
            },
          )
        } else {
          const createInput: CreateWorkBoardItemInput = { title }
          if (status !== undefined) createInput.status = status
          if (ref !== undefined) createInput.design_doc_ref = ref
          item = await store.create(scope, createInput)
        }
        // #429 task 4 — a chat-dispatched add posts a deterministic ack now, so
        // the chat is not silent until the turn's single reply() lands at turn
        // end. Never perturbs the tool result (the ack self-swallows).
        chatAck?.post({
          project_id: ctx.project_id,
          item_id: item.id,
          title: item.title,
          kind: 'card_added',
        })
        return ok(item)
      } catch (err) {
        return asErrorResult(err)
      }
    },
  })

  registry.register({
    name: WORK_BOARD_UPDATE_TOOL,
    description:
      'Update a Work Board item by id: change its title, move its status ' +
      '(upcoming/in_progress/done/archived), set/replace its design_doc_ref, or flag inline_active ' +
      'when YOU are working the item INLINE in this topic (shows a caret › on the board; a bound ' +
      'sub-agent shows a fork ⑂ instead — that is set automatically when a build is dispatched). ' +
      'Clear inline_active when you stop. Re-opening off done clears the completion datestamp. ' +
      "To DEPRIORITISE a card, set status:'archived' (shelved) — never 'done', which claims it shipped.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (from work_board_list).' },
        title: { type: 'string' },
        status: statusProp,
        design_doc_ref: designDocRefProp,
        inline_active: {
          type: 'boolean',
          description:
            'Set true while you work this item directly (inline) in the topic; set false when done. ' +
            'Sub-agent/trident activity is tracked separately and automatically.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output_schema: mutationOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as UpdateArgs
      const id = asString(a.id)
      if (id === undefined) return { ok: false, error: 'id is required' }
      const title = asString(a.title)
      const status = asStatus(a.status)
      const ref = asString(a.design_doc_ref)
      const patch: WorkBoardItemUpdate = {}
      if (title !== undefined) patch.title = title
      if (status !== undefined) patch.status = status
      if (ref !== undefined) patch.design_doc_ref = ref
      if (typeof a.inline_active === 'boolean') patch.inline_active = a.inline_active
      const scope = workBoardScopeKey(ctx.project_slug, ctx.project_id)
      try {
        // #429 task 4 — snapshot BEFORE the update so we can detect an
        // inline_active false→true flip (the "I'm working this inline now" signal)
        // and ack it exactly once. Read is cheap (single-row PK lookup). Kept
        // INSIDE the try so a store read error degrades to a clean tool error
        // (asErrorResult) instead of escaping as an unhandled rejection.
        const prev = chatAck !== undefined ? store.get(scope, id) : null
        const item = await store.update(scope, id, patch)
        if (
          chatAck !== undefined &&
          item !== null &&
          patch.inline_active === true &&
          prev !== null &&
          prev.inline_active === false
        ) {
          chatAck.post({
            project_id: ctx.project_id,
            item_id: item.id,
            title: item.title,
            kind: 'inline_started',
          })
        }
        return ok(item)
      } catch (err) {
        // A refusal is an ANSWER, not a crash: the store throws when a card is
        // SHELVED (status:'archived') while its build is still live (see
        // WorkBoardRunStillLiveError). Surface its message so the agent learns
        // why and stops, rather than seeing a tool error and retrying.
        if (err instanceof WorkBoardRunStillLiveError) {
          return { ok: false, error: err.message }
        }
        return asErrorResult(err)
      }
    },
  })

  registry.register({
    name: WORK_BOARD_COMPLETE_TOOL,
    description: 'Mark a Work Board item done (stamps a completion datestamp; it moves to history).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The item id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output_schema: mutationOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as IdArg
      const id = asString(a.id)
      if (id === undefined) return { ok: false, error: 'id is required' }
      // A refusal is an ANSWER, not a crash: the store throws when the item's
      // build is still live (see WorkBoardRunStillLiveError). Surface its message
      // so the agent learns why and stops, rather than seeing a tool error and
      // retrying. Completion is reconciled from the run going terminal.
      try {
        return ok(await store.complete(workBoardScopeKey(ctx.project_slug, ctx.project_id), id))
      } catch (err) {
        if (err instanceof WorkBoardRunStillLiveError) {
          return { ok: false, error: err.message }
        }
        throw err
      }
    },
  })

  registry.register({
    name: WORK_BOARD_REORDER_TOOL,
    description:
      'Reorder an active Work Board item — move it before or after another active item by id ' +
      '(omit both to move it to the end). Only affects active + upcoming items.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item to move.' },
        before: { type: 'string', description: 'Place it immediately before this item id.' },
        after: { type: 'string', description: 'Place it immediately after this item id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    capability_required: 'write:project_data',
    approval_policy: 'auto',
    handler: async (args, ctx) => {
      const a = (args ?? {}) as ReorderArgs
      const id = asString(a.id)
      if (id === undefined) return { ok: false, error: 'id is required' }
      const before = asString(a.before)
      const after = asString(a.after)
      const target: ReorderTarget = {}
      if (before !== undefined) target.before = before
      if (after !== undefined) target.after = after
      await store.reorder(workBoardScopeKey(ctx.project_slug, ctx.project_id), id, target)
      return { ok: true }
    },
  })

  if (removal !== undefined) {
    registry.register({
      name: WORK_BOARD_REMOVE_TOOL,
      description:
        'Remove a card from the Work Board entirely. This is NOT the same as completing it — never ' +
        'mark unshipped work `done` just to clear it off the board; use THIS instead. Cancels any ' +
        "in-flight build/research run bound to the card first. The card's plans/ doc is MOVED to " +
        '`plans/<reason>/` (still readable in Documents), never deleted unless `delete_plan_doc` is ' +
        'explicitly true.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The item id (from work_board_list).' },
          reason: {
            type: 'string',
            enum: WORK_BOARD_REMOVAL_REASONS,
            description:
              "Why the card is leaving the board — drives where its plan doc is filed: 'shipped' " +
              "(done elsewhere/already delivered), 'cancelled' (deprioritised/scrapped), 'moved' " +
              '(tracked somewhere else now).',
          },
          delete_plan_doc: {
            type: 'boolean',
            description:
              'DESTROY the plan doc instead of filing it. Deliberate deletes only; default false ' +
              'files it under plans/<reason>/.',
          },
        },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          cancelled_run: { type: 'string' },
          plan_doc: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              disposition: { type: 'string', enum: ['moved', 'deleted', 'left_in_place'] },
              to: { type: 'string' },
            },
            required: ['path', 'disposition'],
          },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      capability_required: 'write:project_data',
      approval_policy: 'auto',
      handler: async (args, ctx) => {
        const a = (args ?? {}) as RemoveArgs
        const id = asString(a.id)
        if (id === undefined) return { ok: false, error: 'id is required' }
        const reason =
          typeof a.reason === 'string' && (WORK_BOARD_REMOVAL_REASONS as string[]).includes(a.reason)
            ? (a.reason as WorkBoardRemovalReason)
            : undefined
        if (reason === undefined) {
          return { ok: false, error: "reason is required: 'shipped' | 'cancelled' | 'moved'" }
        }
        const scope = workBoardScopeKey(ctx.project_slug, ctx.project_id)
        // The BOARD gets the scope key; the DOCS get the project id — the same
        // conflation hazard documented in `spec-doc-service.ts` (collapsing the
        // two wrote General's plans into a phantom project directory). A General
        // turn uses GENERAL_WORK_BOARD_PROJECT_ID, exactly as `work_board_add` does.
        const res = await removal.remove(scope, ctx.project_id ?? GENERAL_WORK_BOARD_PROJECT_ID, id, {
          reason,
          ...(a.delete_plan_doc === true ? { plan_doc: 'delete' as const } : {}),
        })
        if (!res.removed) return { ok: false, error: `no such item: ${id}` }
        return {
          ok: true,
          ...(res.cancelled_run !== undefined ? { cancelled_run: res.cancelled_run } : {}),
          ...(res.plan_doc !== undefined ? { plan_doc: res.plan_doc } : {}),
        }
      },
    })
  }

  return [
    WORK_BOARD_LIST_TOOL,
    WORK_BOARD_ADD_TOOL,
    WORK_BOARD_UPDATE_TOOL,
    WORK_BOARD_COMPLETE_TOOL,
    WORK_BOARD_REORDER_TOOL,
    ...(removal !== undefined ? [WORK_BOARD_REMOVE_TOOL] : []),
  ]
}
