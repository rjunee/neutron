/**
 * @neutronai/work-board — reconcile a CC-native `TodoWrite` list into the board.
 *
 * The Claude Code orchestrator maintains its own ephemeral multi-step todo list
 * via the native `TodoWrite` tool. That list is INVISIBLE to the owner and dies
 * with the session — so multi-step work the agent is doing never shows up on the
 * Work Board unless the agent ALSO explicitly calls `work_board_add`. This module
 * closes that gap: a `PostToolUse` hook (matcher `TodoWrite`) POSTs the tool's
 * structured input to the substrate sink, which reconciles it — through the SAME
 * shared `WorkBoardStore` the agent tools + HTTP surface use, so a create/update
 * here fires the store's `onChange` live-push exactly like any other write.
 *
 * Design precedent: `trident/board-reconcile.ts` (reconcile an external list of
 * items into board cards, idempotently) — read for the SHAPE (diff / upsert /
 * mark-status), not reused verbatim (the external source there is Trident runs,
 * here it is a `TodoWrite` list).
 *
 * IDENTITY / IDEMPOTENCY: a `TodoWrite` item carries NO stable id (CC's
 * `TodoWriteInput.todos[]` is `{ content, status, activeForm }`), so the reconcile
 * keys on the card TITLE — the sanitized `content`. Re-running `TodoWrite` with an
 * unchanged list therefore creates ZERO new cards and issues ZERO status updates
 * (the critical invariant): every todo matches an existing card of the same title
 * and same mapped status. Editing a todo's text creates a new card and leaves the
 * old one where it was (a rename is a new identity) — acceptable for v1.
 */

import {
  sanitizeTitle,
  type WorkBoardItem,
  type WorkBoardStatus,
  type WorkBoardStore,
} from './store.ts'

/**
 * One CC `TodoWrite` item — the structured shape CC sends a `PostToolUse` hook in
 * `tool_input.todos[]` (verified against the installed CLI's `sdk-tools.d.ts`
 * `TodoWriteInput`). Only `content` + `status` drive the reconcile; `activeForm`
 * (the present-tense label CC renders while a todo is in progress) is carried for
 * completeness but unused here.
 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/** What a single reconcile pass did (drives the tests + optional logging). */
export interface TodoReconcileResult {
  /** Cards created for NEW todos (no title match). */
  created: number
  /** Existing cards whose status was moved to match their todo. */
  updated: number
  /** Todos that matched an existing card (whether or not a status change fired). */
  matched: number
}

/**
 * Map a CC todo status onto a board lane:
 *   pending      → upcoming    (backlog)
 *   in_progress  → in_progress (active)
 *   completed    → done        (history)
 */
export function todoStatusToBoardStatus(status: TodoItem['status']): WorkBoardStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'pending':
    default:
      return 'upcoming'
  }
}

const VALID_TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * Coerce the raw, untrusted `todos` payload (arrives over the sink from a
 * subprocess hook) into well-formed {@link TodoItem}s. Drops anything that is not
 * an object with a non-empty string `content` and a recognized `status`. Total —
 * never throws — so a malformed hook payload degrades to a no-op reconcile rather
 * than a 500 on the sink.
 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const content = obj['content']
    const status = obj['status']
    if (typeof content !== 'string' || content.trim().length === 0) continue
    if (typeof status !== 'string' || !VALID_TODO_STATUSES.has(status)) continue
    const item: TodoItem = { content, status: status as TodoItem['status'] }
    if (typeof obj['activeForm'] === 'string') item.activeForm = obj['activeForm']
    out.push(item)
  }
  return out
}

/**
 * Reconcile `todos` into the board `scope`, idempotently. Snapshots the board
 * ONCE, indexes existing cards by their (already-sanitized) title, then for each
 * todo: create a card if no title match, else move the matched card's status to
 * the todo's mapped lane (a no-op when already equal). Matching sanitizes the
 * todo `content` the SAME way the store sanitizes a title on write, so the two
 * compare like-for-like. `list()` returns active rows before completed, so
 * first-wins indexing prefers an active card over a stale completed one of the
 * same title. Writes go through the shared store, so each create/update fires its
 * `onChange` live-push. Returns a small summary (drives tests + optional logging).
 */
export async function reconcileTodosIntoBoard(
  store: WorkBoardStore,
  scope: string,
  todos: readonly TodoItem[],
): Promise<TodoReconcileResult> {
  const result: TodoReconcileResult = { created: 0, updated: 0, matched: 0 }

  const byTitle = new Map<string, WorkBoardItem>()
  for (const item of store.list(scope)) {
    if (!byTitle.has(item.title)) byTitle.set(item.title, item)
  }

  // De-dup titles WITHIN this one list so two todos that sanitize to the same
  // title don't spawn two cards / fight over one card's status.
  const seen = new Set<string>()
  for (const todo of todos) {
    if (typeof todo?.content !== 'string') continue
    const title = sanitizeTitle(todo.content)
    if (title.length === 0) continue
    if (seen.has(title)) continue
    seen.add(title)

    const target = todoStatusToBoardStatus(todo.status)
    const existing = byTitle.get(title)
    if (existing === undefined) {
      // task_type omitted → the store defaults to 'build' (per the brief: default
      // 'build' for a todo unless a clear research signal, which a bare todo line
      // never carries).
      await store.create(scope, { title, status: target })
      result.created += 1
    } else {
      result.matched += 1
      if (existing.status !== target) {
        await store.update(scope, existing.id, { status: target })
        result.updated += 1
      }
    }
  }
  return result
}
