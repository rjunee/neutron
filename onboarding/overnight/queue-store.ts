/**
 * @neutronai/onboarding/overnight — the overnight-work queue store.
 *
 * CRUD over the per-project `overnight_queue` + `overnight_budget` tables
 * (migration 0078). This is the SQLite translation of Vajra's
 * `gateway/overnight-queue.json`: the runtime source of truth for every
 * autonomous overnight-work item. The agent-maintained STATUS.md block
 * (`status-md-sync.ts`) is a RENDERING of these rows, never the other way
 * round (the queue is chat-driven — the user never edits STATUS.md).
 *
 * Shape mirrors `trident/store.ts` / `reminders/store.ts`: a thin typed
 * wrapper over `ProjectDb`, async writes (busy-retry under the hood), sync
 * reads. owk-id allocation (`owk-YYYYMMDD-NNN`) lives here so both the scan
 * reconciler and any chat-driven "queue this" path mint ids the same way.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

export type OvernightAgentRole = 'forge' | 'atlas'
export type OvernightPriority = 'P1' | 'P2' | 'P3'
export type OvernightStatus = 'queued' | 'in-flight' | 'completed' | 'failed'

export interface OvernightItem {
  id: string
  project_slug: string
  agent_role: OvernightAgentRole
  priority: OvernightPriority
  description: string
  status: OvernightStatus
  /** The required `[context:<path>]` hard gate, relative to the project repo. */
  context_relpath: string | null
  /** The REAL terminal result (`PR#42`, `merged <branch>`, `failed: …`). */
  result: string | null
  /** The `code_trident_runs` row driving this item (NULL until dispatch). */
  trident_run_id: string | null
  trident_slug: string | null
  spawn_attempts: number
  ralph: boolean
  /** ISO-8601 UTC. */
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** Local YYYY-MM-DD of the window this item was dispatched in. */
  window_date_local: string | null
}

export interface CreateOvernightItemInput {
  id: string
  project_slug: string
  description: string
  agent_role?: OvernightAgentRole
  priority?: OvernightPriority
  status?: OvernightStatus
  context_relpath?: string | null
  ralph?: boolean
  created_at?: string
}

export interface OvernightItemUpdate {
  agent_role?: OvernightAgentRole
  priority?: OvernightPriority
  description?: string
  status?: OvernightStatus
  context_relpath?: string | null
  result?: string | null
  trident_run_id?: string | null
  trident_slug?: string | null
  spawn_attempts?: number
  ralph?: boolean
  started_at?: string | null
  finished_at?: string | null
  window_date_local?: string | null
}

interface OvernightItemDbRow {
  id: string
  project_slug: string
  agent_role: OvernightAgentRole
  priority: OvernightPriority
  description: string
  status: OvernightStatus
  context_relpath: string | null
  result: string | null
  trident_run_id: string | null
  trident_slug: string | null
  spawn_attempts: number
  ralph: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  window_date_local: string | null
}

const COLS =
  'id, project_slug, agent_role, priority, description, status, ' +
  'context_relpath, result, trident_run_id, trident_slug, spawn_attempts, ' +
  'ralph, created_at, started_at, finished_at, window_date_local'

/**
 * Allocate the next `owk-YYYYMMDD-NNN` id for `dateYYYYMMDD`, given the set
 * of ids already in use. NNN is zero-padded to at least 3 digits. Verbatim
 * port of Vajra's `nextOwkId`.
 */
export function nextOwkId(dateYYYYMMDD: string, existingIds: ReadonlySet<string>): string {
  const prefix = `owk-${dateYYYYMMDD}-`
  let maxN = 0
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue
    const n = parseInt(id.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > maxN) maxN = n
  }
  return `${prefix}${String(maxN + 1).padStart(3, '0')}`
}

/** UTC YYYYMMDD used as the date prefix on newly-allocated owk ids. */
export function owkDatePrefix(nowMs: number): string {
  const d = new Date(nowMs)
  const yy = d.getUTCFullYear().toString().padStart(4, '0')
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = d.getUTCDate().toString().padStart(2, '0')
  return `${yy}${mm}${dd}`
}

export class OvernightQueueStore {
  constructor(
    private readonly db: ProjectDb,
    /** Injectable clock for tests; defaults to wall-clock ISO-8601. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async create(input: CreateOvernightItemInput): Promise<OvernightItem> {
    const ts = input.created_at ?? this.now()
    const item: OvernightItem = {
      id: input.id,
      project_slug: input.project_slug,
      agent_role: input.agent_role ?? 'forge',
      priority: input.priority ?? 'P3',
      description: input.description,
      status: input.status ?? 'queued',
      context_relpath: input.context_relpath ?? null,
      result: null,
      trident_run_id: null,
      trident_slug: null,
      spawn_attempts: 0,
      ralph: input.ralph ?? false,
      created_at: ts,
      started_at: null,
      finished_at: null,
      window_date_local: null,
    }
    await this.db.run(
      `INSERT INTO overnight_queue (${COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.project_slug,
        item.agent_role,
        item.priority,
        item.description,
        item.status,
        item.context_relpath,
        item.result,
        item.trident_run_id,
        item.trident_slug,
        item.spawn_attempts,
        item.ralph ? 1 : 0,
        item.created_at,
        item.started_at,
        item.finished_at,
        item.window_date_local,
      ],
    )
    return item
  }

  get(id: string): OvernightItem | null {
    const row = this.db
      .prepare<OvernightItemDbRow, [string]>(
        `SELECT ${COLS} FROM overnight_queue WHERE id = ?`,
      )
      .get(id)
    return row === null ? null : rowToItem(row)
  }

  /** Every item, newest-first. Cheap (per-instance queue is small). */
  list(): OvernightItem[] {
    return this.db
      .prepare<OvernightItemDbRow, []>(
        `SELECT ${COLS} FROM overnight_queue ORDER BY created_at DESC`,
      )
      .all()
      .map(rowToItem)
  }

  listByProject(project_slug: string): OvernightItem[] {
    return this.db
      .prepare<OvernightItemDbRow, [string]>(
        `SELECT ${COLS} FROM overnight_queue WHERE project_slug = ? ORDER BY created_at ASC`,
      )
      .all(project_slug)
      .map(rowToItem)
  }

  listByStatus(status: OvernightStatus): OvernightItem[] {
    return this.db
      .prepare<OvernightItemDbRow, [OvernightStatus]>(
        `SELECT ${COLS} FROM overnight_queue WHERE status = ? ORDER BY created_at ASC`,
      )
      .all(status)
      .map(rowToItem)
  }

  /** Count currently in-flight items — the live concurrency number. */
  countInFlight(): number {
    const row = this.db
      .prepare<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM overnight_queue WHERE status = 'in-flight'`,
      )
      .get()
    return row?.n ?? 0
  }

  async update(id: string, patch: OvernightItemUpdate): Promise<OvernightItem | null> {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    const push = (col: string, val: string | number | null): void => {
      sets.push(`${col} = ?`)
      params.push(val)
    }
    if (patch.agent_role !== undefined) push('agent_role', patch.agent_role)
    if (patch.priority !== undefined) push('priority', patch.priority)
    if (patch.description !== undefined) push('description', patch.description)
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.context_relpath !== undefined) push('context_relpath', patch.context_relpath)
    if (patch.result !== undefined) push('result', patch.result)
    if (patch.trident_run_id !== undefined) push('trident_run_id', patch.trident_run_id)
    if (patch.trident_slug !== undefined) push('trident_slug', patch.trident_slug)
    if (patch.spawn_attempts !== undefined) push('spawn_attempts', patch.spawn_attempts)
    if (patch.ralph !== undefined) push('ralph', patch.ralph ? 1 : 0)
    if (patch.started_at !== undefined) push('started_at', patch.started_at)
    if (patch.finished_at !== undefined) push('finished_at', patch.finished_at)
    if (patch.window_date_local !== undefined) push('window_date_local', patch.window_date_local)
    if (sets.length === 0) return this.get(id)
    params.push(id)
    await this.db.run(`UPDATE overnight_queue SET ${sets.join(', ')} WHERE id = ?`, params)
    return this.get(id)
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM overnight_queue WHERE id = ?`, [id])
  }

  // ---- budget ----------------------------------------------------------

  /** Dispatches already started in `window_date_local` (0 if unseen). */
  startedThisWindow(window_date_local: string): number {
    const row = this.db
      .prepare<{ started_this_window: number }, [string]>(
        `SELECT started_this_window FROM overnight_budget WHERE window_date_local = ?`,
      )
      .get(window_date_local)
    return row?.started_this_window ?? 0
  }

  /** Atomically bump the per-window dispatch counter (UPSERT). */
  async incrementStarted(window_date_local: string, by: number = 1): Promise<void> {
    await this.db.run(
      `INSERT INTO overnight_budget (window_date_local, started_this_window)
       VALUES (?, ?)
       ON CONFLICT(window_date_local)
       DO UPDATE SET started_this_window = started_this_window + ?`,
      [window_date_local, by, by],
    )
  }
}

function rowToItem(row: OvernightItemDbRow): OvernightItem {
  return {
    id: row.id,
    project_slug: row.project_slug,
    agent_role: row.agent_role,
    priority: row.priority,
    description: row.description,
    status: row.status,
    context_relpath: row.context_relpath,
    result: row.result,
    trident_run_id: row.trident_run_id,
    trident_slug: row.trident_slug,
    spawn_attempts: row.spawn_attempts,
    ralph: row.ralph === 1,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    window_date_local: row.window_date_local,
  }
}
