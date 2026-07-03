/**
 * @neutronai/work-board — instance-scoped Work Board store.
 *
 * CRUD over the per-project `work_board_items` table (migration 0090).
 * One row == one thing the owner (or the agent) is working on / about to
 * work on / has finished. The board is the orchestrator's EXTERNAL memory:
 * it is injected into every orchestrator turn and rendered as a first-class
 * per-project tab.
 *
 * Shape mirrors `trident/store.ts`: a thin typed wrapper over `ProjectDb`,
 * async writes (busy-retry under the hood), sync reads. Two differences
 * driven by the data-integrity review:
 *
 *  - The append-at-end (`MAX(sort_order)+1`) and `reorder` (gap-renumber)
 *    paths are read-compute-write races, so they run inside
 *    `db.transaction()` — a bare `.get()` read bypasses the write mutex and
 *    would tear under N-parallel mutations.
 *  - Every committed mutation fires an optional `onChange` hook so the
 *    composer can push a `work_board_changed` app-ws frame from the SINGLE
 *    shared store instance, regardless of whether the write came from an
 *    agent tool or the HTTP surface (one code path).
 *
 * `project_slug` is ALWAYS supplied by the caller from a server-derived
 * value (the gateway instance slug / the bearer's project_slug), NEVER from
 * an agent- or client-supplied argument.
 */

import type { ProjectDb } from '../persistence/index.ts'

/** The board lane. `failed` is a run-driven terminal lane (a bound trident run
 *  that FAILED): it stays in the active list (`status != done`), KEEPS its
 *  `linked_run_id` so the client shows a red dot + "Failed" tag + the run's
 *  `failure_reason`, and is re-actionable via the ▶/↻ retry. It is NOT a
 *  client-writable status — only the terminal reconcile sets it. */
export type WorkBoardStatus = 'upcoming' | 'in_progress' | 'done' | 'failed'

/** Public, fully-typed board item. */
export interface WorkBoardItem {
  id: string
  project_slug: string
  title: string
  status: WorkBoardStatus
  sort_order: number
  design_doc_ref: string | null
  /** Lightweight inline (in-topic) work marker. Sub-agent activity is
   *  DERIVED via `linked_run_id` (Phase 2), not stored here. */
  inline_active: boolean
  /** Bound `code_trident_runs.id` when a trident run works this item. */
  linked_run_id: string | null
  created_at: string
  updated_at: string
  /** ISO-8601 UTC; null until status='done'. */
  completed_at: string | null
}

export interface CreateWorkBoardItemInput {
  title: string
  status?: WorkBoardStatus
  design_doc_ref?: string | null
  /** Test-injectable id; defaults to a fresh ULID. */
  id?: string
}

export interface WorkBoardItemUpdate {
  title?: string
  status?: WorkBoardStatus
  design_doc_ref?: string | null
  /** Phase 2b — the lightweight inline (in-topic) work marker. The agent flags
   *  an item it is working INLINE in the main topic (caret `›`) vs via a bound
   *  sub-agent/trident run (fork `⑂`, derived from `linked_run_id`). */
  inline_active?: boolean
}

/** Outcome of a bound run reaching a terminal phase (drives the reconcile). */
export type RunReconcileOutcome = 'done' | 'failed'

/** Where to drop the moved item relative to a sibling. */
export interface ReorderTarget {
  before?: string
  after?: string
}

export interface WorkBoardStoreOptions {
  /** Injectable clock for tests; defaults to wall-clock ISO-8601. */
  now?: () => string
  /** Injectable id generator for tests; defaults to a ULID. */
  ulid?: () => string
  /** Fired AFTER each committed mutation so a push can fan out. Receives the
   *  storage key (`project_slug` value) of the board that changed, so the
   *  composer can list + tag the RIGHT project's snapshot. Best-effort: a
   *  throwing hook is swallowed so it can never roll back a committed write. */
  onChange?: (project_key: string) => void
}

/**
 * Thrown by the store when a write violates a content rule (today: a
 * `design_doc_ref` whose scheme is not on the allow-list). Surfaces map it
 * to a 400 (HTTP) / an error result (agent tool) rather than a 500.
 */
export class WorkBoardValidationError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkBoardValidationError'
    this.code = code
  }
}

/** One line; titles longer than this are truncated at the store layer. */
export const MAX_TITLE_LEN = 256
/** A defensive cap on a design-doc ref length. */
export const MAX_DESIGN_DOC_REF_LEN = 2048

/**
 * The reserved General/instance board id. The clients treat General as a
 * null/empty project id (web `ProjectShell.isGeneral = projectId == null ||
 * len === 0`; the app subscribes with `''`), and the server-wide convention
 * normalizes an absent project to `'general'` (`turn.project_id ?? 'general'`).
 * Any of these map onto the General board.
 */
export const GENERAL_WORK_BOARD_PROJECT_ID = 'general'

/**
 * The per-project Work Board STORAGE KEY (the `project_slug` column value),
 * scoped under the single owner.
 *
 * Neutron Open is single-owner: `owner_slug` (the bearer/instance project_slug)
 * IS the owner boundary and every project lives under it. The board must be
 * keyed per PROJECT — not per owner — or all projects collapse onto one board
 * (the bug this fixes). The map:
 *
 *  - General (project_id absent / `''` / `'general'`) → the bare `owner_slug`.
 *    Deliberate: it maps every PRE-EXISTING row (all written under the instance
 *    owner slug before per-project scoping) onto the General board — the context
 *    they were created in (the chat/agent tools + the instance Plan tab), so no
 *    history is stranded. The agent `work_board_*` tools (keyed on the instance
 *    slug via `mcp/server.ts`) also land here, so the agent and the General Plan
 *    tab share one board.
 *  - A real project (`project_id = 'acme'`)          → the project id verbatim.
 *    Already sanitized to `[A-Za-z0-9_.-]` (no `':'`), so it is filesystem-safe
 *    as a build-workspace / spec-doc directory component.
 *
 * Single-owner ∴ the bare project id is a sufficient key — there is no second
 * owner whose `'acme'` could collide. (Mirrors the intent of
 * `project-credentials/store.ts`'s `(owner_slug, project_id)` axis, collapsed to
 * one column because the owner is constant.) EDGE: a real project whose id
 * literally equals `owner_slug` would share the General bucket — not expected
 * (owner_slug is the instance slug, project ids are user identifiers).
 */
export function workBoardScopeKey(
  owner_slug: string,
  project_id: string | null | undefined,
): string {
  const pid = typeof project_id === 'string' ? project_id.trim() : ''
  if (pid.length === 0 || pid === GENERAL_WORK_BOARD_PROJECT_ID) return owner_slug
  return pid
}

/**
 * Reverse of {@link workBoardScopeKey} for the live `work_board_changed` frame's
 * `project_id` tag: map a storage key back to the per-project id the clients
 * filter on (`app/lib/work-board-live.decodeWorkBoardFrame` + the web
 * controller). General (key === owner_slug) → `undefined`: the frame carries NO
 * `project_id`, the clients' documented "no project_id = this/General board"
 * broadcast (a concrete tag would be dropped by the General viewer, whose
 * projectId is null/empty). A real project → its id, so only that project's
 * viewers apply the frame and siblings drop it.
 */
export function workBoardProjectIdForKey(
  owner_slug: string,
  scope_key: string,
): string | undefined {
  return scope_key === owner_slug ? undefined : scope_key
}

const COLS =
  'id, project_slug, title, status, sort_order, design_doc_ref, ' +
  'inline_active, linked_run_id, created_at, updated_at, completed_at'

interface WorkBoardItemDbRow {
  id: string
  project_slug: string
  title: string
  status: WorkBoardStatus
  sort_order: number
  design_doc_ref: string | null
  inline_active: number
  linked_run_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/**
 * Collapse newlines/runs of whitespace into single spaces, trim, and cap to
 * one line of at most `MAX_TITLE_LEN` chars. The board is a one-line-per-item
 * surface AND the title is spliced into the per-turn injection block, so a
 * multi-line title would both break the UI and let an item smuggle extra
 * lines into the prompt.
 */
export function sanitizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN)
}

/**
 * Allow-list a `design_doc_ref` scheme at WRITE time. Permits only `https:`
 * and the in-app docs deep-link scheme (`neutron-docs:` / a relative
 * `/api/app/projects/.../docs/...` path); rejects `javascript:`, `data:`,
 * `file:`, and anything else. Returns the trimmed ref (or null for an
 * empty/absent ref); throws `WorkBoardValidationError` on a disallowed scheme.
 */
export function validateDesignDocRef(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const ref = raw.trim()
  if (ref.length === 0) return null
  if (ref.length > MAX_DESIGN_DOC_REF_LEN) {
    throw new WorkBoardValidationError(
      'invalid_design_doc_ref',
      `design_doc_ref must be at most ${MAX_DESIGN_DOC_REF_LEN} chars`,
    )
  }
  // In-app docs deep link: an absolute API path into the project's docs tree.
  if (ref.startsWith('/api/app/') || ref.startsWith('neutron-docs:')) return ref
  // Otherwise it must be an absolute https URL.
  let scheme: string | null = null
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(ref)
  if (m !== null) scheme = m[1]!.toLowerCase()
  if (scheme === 'https') return ref
  throw new WorkBoardValidationError(
    'invalid_design_doc_ref',
    "design_doc_ref must be an https URL or an in-app docs link (javascript:/data:/file: are rejected)",
  )
}

/**
 * 48-bit timestamp + 80 random bits, Crockford base32 (sortable). Mirrors
 * the `notes` / `comments` stores; there is no `ulid` package in the repo.
 */
function defaultUlid(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const now = Date.now()
  let id = ''
  let ts = now
  for (let i = 9; i >= 0; i--) {
    const mod = ts % 32
    id = ENCODING[mod] + id
    ts = Math.floor(ts / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let rand = ''
  for (let i = 0; i < 16; i++) {
    const mod = Number(bits & 31n)
    rand = ENCODING[mod] + rand
    bits >>= 5n
  }
  return id + rand
}

function rowToItem(row: WorkBoardItemDbRow): WorkBoardItem {
  return {
    id: row.id,
    project_slug: row.project_slug,
    title: row.title,
    status: row.status,
    sort_order: row.sort_order,
    design_doc_ref: row.design_doc_ref,
    inline_active: row.inline_active === 1,
    linked_run_id: row.linked_run_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  }
}

export class WorkBoardStore {
  private readonly db: ProjectDb
  private readonly now: () => string
  private readonly ulid: () => string
  private readonly onChange: ((project_key: string) => void) | undefined

  constructor(db: ProjectDb, opts: WorkBoardStoreOptions = {}) {
    this.db = db
    this.now = opts.now ?? (() => new Date().toISOString())
    this.ulid = opts.ulid ?? defaultUlid
    this.onChange = opts.onChange
  }

  /** Fire the change hook for the mutated board key; never let a hook throw
   *  escape a committed write. */
  private emitChange(project_key: string): void {
    if (this.onChange === undefined) return
    try {
      this.onChange(project_key)
    } catch {
      /* push is best-effort — a committed write must not roll back on it */
    }
  }

  /**
   * Append a new item at the END of the board (highest `sort_order`).
   * Wrapped in a transaction so the `MAX(sort_order)+1` read-compute-write
   * cannot race another concurrent append.
   */
  async create(project_slug: string, input: CreateWorkBoardItemInput): Promise<WorkBoardItem> {
    const id = input.id ?? this.ulid()
    const ts = this.now()
    const title = sanitizeTitle(input.title)
    if (title.length === 0) {
      throw new WorkBoardValidationError('invalid_title', 'title must be a non-empty string')
    }
    const status: WorkBoardStatus = input.status ?? 'upcoming'
    const design_doc_ref = validateDesignDocRef(input.design_doc_ref)
    const completed_at = status === 'done' ? ts : null

    const item: WorkBoardItem = {
      id,
      project_slug,
      title,
      status,
      sort_order: 0,
      design_doc_ref,
      inline_active: false,
      linked_run_id: null,
      created_at: ts,
      updated_at: ts,
      completed_at,
    }

    await this.db.transaction(async (tx) => {
      const max = tx
        .prepare<{ next: number }, [string]>(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
             FROM work_board_items WHERE project_slug = ?`,
        )
        .get(project_slug)
      item.sort_order = max?.next ?? 1
      await tx.run(
        `INSERT INTO work_board_items (${COLS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.project_slug,
          item.title,
          item.status,
          item.sort_order,
          item.design_doc_ref,
          item.inline_active ? 1 : 0,
          item.linked_run_id,
          item.created_at,
          item.updated_at,
          item.completed_at,
        ],
      )
    })
    this.emitChange(project_slug)
    return item
  }

  /** A single item scoped to its project (for ownership checks). */
  get(project_slug: string, id: string): WorkBoardItem | null {
    const row = this.db
      .prepare<WorkBoardItemDbRow, [string, string]>(
        `SELECT ${COLS} FROM work_board_items WHERE project_slug = ? AND id = ?`,
      )
      .get(project_slug, id)
    return row === null ? null : rowToItem(row)
  }

  /** Active + next (status != done) ordered by `sort_order`. */
  listActive(project_slug: string): WorkBoardItem[] {
    return this.db
      .prepare<WorkBoardItemDbRow, [string]>(
        `SELECT ${COLS} FROM work_board_items
          WHERE project_slug = ? AND status != 'done'
          ORDER BY sort_order ASC`,
      )
      .all(project_slug)
      .map(rowToItem)
  }

  /** Completed (status = done) reverse-chronological (newest first). */
  listCompleted(project_slug: string): WorkBoardItem[] {
    return this.db
      .prepare<WorkBoardItemDbRow, [string]>(
        `SELECT ${COLS} FROM work_board_items
          WHERE project_slug = ? AND status = 'done'
          ORDER BY completed_at DESC, updated_at DESC`,
      )
      .all(project_slug)
      .map(rowToItem)
  }

  /**
   * The full board: active+next first (by `sort_order`), then the completed
   * history (reverse-chron). This is the snapshot the HTTP GET + the
   * `work_board_changed` frame send.
   */
  list(project_slug: string): WorkBoardItem[] {
    return [...this.listActive(project_slug), ...this.listCompleted(project_slug)]
  }

  /**
   * Patch title / status / design_doc_ref. Stamps `updated_at`. A `status`
   * change is treated as a REAL transition (loads the current row): it stamps
   * `completed_at` only on a genuine →done transition (a repeated `done` does
   * NOT refresh it / re-sort the completed history), and on a re-open OFF done
   * it NULLs `completed_at` AND re-appends the item to the END of the active
   * lane (a `sort_order` = MAX+1) so its stale completed-row position can't
   * collide with the renumbered active items. The status path runs in a
   * transaction because the reopen read-compute-write (MAX `sort_order`) must
   * be atomic. Scoped by `project_slug`.
   */
  async update(
    project_slug: string,
    id: string,
    patch: WorkBoardItemUpdate,
  ): Promise<WorkBoardItem | null> {
    // Validate eagerly so a bad design_doc_ref throws before any DB work.
    let title: string | undefined
    if (patch.title !== undefined) {
      title = sanitizeTitle(patch.title)
      if (title.length === 0) {
        throw new WorkBoardValidationError('invalid_title', 'title must be a non-empty string')
      }
    }
    let designDocRef: string | null | undefined
    if (patch.design_doc_ref !== undefined) {
      designDocRef = validateDesignDocRef(patch.design_doc_ref)
    }

    const result = await this.db.transaction(async (tx): Promise<WorkBoardItem | null> => {
      const current = this.get(project_slug, id)
      if (current === null) return null
      const sets: string[] = []
      const params: (string | number | null)[] = []
      const push = (col: string, val: string | number | null): void => {
        sets.push(`${col} = ?`)
        params.push(val)
      }
      if (title !== undefined) push('title', title)
      if (designDocRef !== undefined) push('design_doc_ref', designDocRef)
      if (patch.inline_active !== undefined) push('inline_active', patch.inline_active ? 1 : 0)
      if (patch.status !== undefined && patch.status !== current.status) {
        push('status', patch.status)
        if (patch.status === 'done') {
          // Genuine completion — stamp the datestamp ONCE.
          push('completed_at', this.now())
        } else if (current.status === 'done') {
          // Re-open OFF done: clear the completion + re-append to the active
          // lane end so the stale done-row sort_order can't collide.
          push('completed_at', null)
          const max = tx
            .prepare<{ next: number }, [string]>(
              `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
                 FROM work_board_items WHERE project_slug = ?`,
            )
            .get(project_slug)
          push('sort_order', max?.next ?? 1)
        }
        // active→active (e.g. upcoming→in_progress): no completed_at/sort_order change.
      }
      if (sets.length === 0) return current // nothing actually changed
      push('updated_at', this.now())
      params.push(project_slug, id)
      await tx.run(
        `UPDATE work_board_items SET ${sets.join(', ')} WHERE project_slug = ? AND id = ?`,
        params,
      )
      return this.get(project_slug, id)
    })
    if (result !== null) this.emitChange(project_slug)
    return result
  }

  /**
   * Mark an item done. Idempotent: re-completing an already-done item does NOT
   * refresh `completed_at` (it routes through the same transition logic).
   */
  async complete(project_slug: string, id: string): Promise<WorkBoardItem | null> {
    return this.update(project_slug, id, { status: 'done' })
  }

  /**
   * Move an active item before/after a sibling and gap-renumber the whole
   * active lane to a clean `1..N` integer sequence. Wrapped in a transaction
   * because the load-reorder-renumber is a read-compute-write over many rows.
   * No-op if the item isn't an active row.
   */
  async reorder(project_slug: string, id: string, target: ReorderTarget): Promise<void> {
    await this.db.transaction(async (tx) => {
      const ids = tx
        .prepare<{ id: string }, [string]>(
          `SELECT id FROM work_board_items
            WHERE project_slug = ? AND status != 'done'
            ORDER BY sort_order ASC`,
        )
        .all(project_slug)
        .map((r) => r.id)
      const from = ids.indexOf(id)
      if (from === -1) return // not an active item — nothing to reorder
      ids.splice(from, 1)
      let insertAt = ids.length
      if (target.before !== undefined) {
        const i = ids.indexOf(target.before)
        if (i !== -1) insertAt = i
      } else if (target.after !== undefined) {
        const i = ids.indexOf(target.after)
        if (i !== -1) insertAt = i + 1
      }
      ids.splice(insertAt, 0, id)
      const ts = this.now()
      for (let i = 0; i < ids.length; i++) {
        await tx.run(
          `UPDATE work_board_items SET sort_order = ?, updated_at = ?
            WHERE project_slug = ? AND id = ?`,
          [i + 1, ts, project_slug, ids[i]!],
        )
      }
    })
    this.emitChange(project_slug)
  }

  /** Toggle the lightweight inline-work marker. */
  async setInlineActive(project_slug: string, id: string, active: boolean): Promise<void> {
    await this.db.run(
      `UPDATE work_board_items SET inline_active = ?, updated_at = ?
        WHERE project_slug = ? AND id = ?`,
      [active ? 1 : 0, this.now(), project_slug, id],
    )
    this.emitChange(project_slug)
  }

  /** Bind a trident run to this item (Phase 2 correlation key). */
  async bindRun(project_slug: string, id: string, run_id: string): Promise<void> {
    await this.db.run(
      `UPDATE work_board_items SET linked_run_id = ?, updated_at = ?
        WHERE project_slug = ? AND id = ?`,
      [run_id, this.now(), project_slug, id],
    )
    this.emitChange(project_slug)
  }

  /** Clear a bound trident run — but ONLY if `run_id` is still the run bound to
   *  this item. Two concurrent dispatches can bind the same item in turn (the
   *  later `attachRun` supersedes the earlier `linked_run_id`); when the earlier
   *  run finishes it must NOT clear the still-live later run's marker. Guarding
   *  on `linked_run_id = run_id` makes the clear a no-op in that race. Leaves the
   *  lane/status untouched (a non-build dispatch finishing ≠ the item done). */
  async clearRun(project_slug: string, id: string, run_id: string): Promise<void> {
    await this.db.run(
      `UPDATE work_board_items SET linked_run_id = NULL, updated_at = ?
        WHERE project_slug = ? AND id = ? AND linked_run_id = ?`,
      [this.now(), project_slug, id, run_id],
    )
    this.emitChange(project_slug)
  }

  /** Look up the item a run is bound to (the partial `linked_run_id` index).
   *  Used by the terminal-reconcile path to find the item from a finished run.
   *  Scoped by `project_slug` so a run id can never cross instances. */
  getByRunId(project_slug: string, run_id: string): WorkBoardItem | null {
    const row = this.db
      .prepare<WorkBoardItemDbRow, [string, string]>(
        `SELECT ${COLS} FROM work_board_items
          WHERE project_slug = ? AND linked_run_id = ?
          LIMIT 1`,
      )
      .get(project_slug, run_id)
    return row === null ? null : rowToItem(row)
  }

  /**
   * Phase 2b — BIND a dispatched run to an item AND light it up live: set
   * `linked_run_id` (→ the fork `⑂` icon) and move the item to `in_progress`,
   * all in ONE transaction with ONE `onChange` push. A sub-agent supersedes
   * any inline marker, so `inline_active` is cleared. Re-opening a `done` item
   * (re-dispatch) nulls `completed_at` + re-appends it to the active lane so
   * its stale completed-row `sort_order` can't collide. Returns the bound row
   * (or null if the id no longer exists).
   */
  async attachRun(
    project_slug: string,
    id: string,
    run_id: string,
  ): Promise<WorkBoardItem | null> {
    const result = await this.db.transaction(async (tx): Promise<WorkBoardItem | null> => {
      const current = this.get(project_slug, id)
      if (current === null) return null
      const sets = ['linked_run_id = ?', 'inline_active = 0', "status = 'in_progress'"]
      const params: (string | number | null)[] = [run_id]
      if (current.status === 'done') {
        // Re-open OFF done: clear the datestamp + re-append to the active lane.
        sets.push('completed_at = NULL')
        const max = tx
          .prepare<{ next: number }, [string]>(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
               FROM work_board_items WHERE project_slug = ?`,
          )
          .get(project_slug)
        sets.push('sort_order = ?')
        params.push(max?.next ?? 1)
      }
      sets.push('updated_at = ?')
      params.push(this.now(), project_slug, id)
      await tx.run(
        `UPDATE work_board_items SET ${sets.join(', ')} WHERE project_slug = ? AND id = ?`,
        params,
      )
      return this.get(project_slug, id)
    })
    if (result !== null) this.emitChange(project_slug)
    return result
  }

  /**
   * Phase 2b — RECONCILE a bound run that reached a terminal phase. Finds the
   * item by `run_id` and sets the lane from the outcome:
   *   - `done`   → CLEAR the run binding (fork icon goes dark) + complete the
   *               item (datestamped history).
   *   - `failed` → mark the item FAILED and KEEP the run binding (#340). The
   *               still-linked failed run is what the client derives the red dot
   *               + "Failed" tag + `failure_reason` one-liner from (its
   *               `run_progress.step_label` is 'failed'), and the ▶/↻ retry
   *               re-dispatches against the same card. Do NOT revert to
   *               'upcoming' (that showed a grey never-started card and lost the
   *               failure) and do NOT null `linked_run_id`.
   * One transaction, one push. No-op (returns null) when no item is bound to the
   * run — terminal reconcile is idempotent + safe for unbound dispatches.
   */
  async detachRun(
    project_slug: string,
    run_id: string,
    outcome: RunReconcileOutcome,
  ): Promise<WorkBoardItem | null> {
    const result = await this.db.transaction(async (tx): Promise<WorkBoardItem | null> => {
      const current = this.getByRunId(project_slug, run_id)
      if (current === null) return null
      const sets = ['inline_active = 0']
      const params: (string | number | null)[] = []
      if (outcome === 'done') {
        // Done — clear the binding (fork ⑂ dark) + complete the item.
        sets.push('linked_run_id = NULL', "status = 'done'")
        // Stamp the datestamp only on a genuine →done transition.
        if (current.status !== 'done') {
          sets.push('completed_at = ?')
          params.push(this.now())
        }
      } else {
        // Failed — FAILED lane, KEEP the run link (see the header). The retry
        // path (`attachRun`) overwrites the link + flips back to in_progress.
        sets.push("status = 'failed'", 'completed_at = NULL')
      }
      sets.push('updated_at = ?')
      params.push(this.now(), project_slug, current.id)
      await tx.run(
        `UPDATE work_board_items SET ${sets.join(', ')} WHERE project_slug = ? AND id = ?`,
        params,
      )
      return this.get(project_slug, current.id)
    })
    if (result !== null) this.emitChange(project_slug)
    return result
  }

  /** Delete an item (human board is full-CRUD for the owner). */
  async delete(project_slug: string, id: string): Promise<void> {
    await this.db.run(`DELETE FROM work_board_items WHERE project_slug = ? AND id = ?`, [
      project_slug,
      id,
    ])
    this.emitChange(project_slug)
  }
}
