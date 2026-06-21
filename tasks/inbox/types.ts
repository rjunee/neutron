/**
 * @neutronai/tasks/inbox — append-queue row schema + parsing.
 *
 * The task-inbox is a JSONL append-queue: agents and the user append one
 * JSON object per line to `task-inbox.jsonl`, and the scanner
 * (`scanner.ts`) drains the queue into the canonical `TaskStore`, then
 * re-renders the markdown surface (`tasks.md` + `DASHBOARD.md`).
 *
 * This mirrors Vajra's markdown-first task workflow
 * (`~/vajra/gateway/task-inbox.jsonl` + `~/vajra/scripts/task-scanner.py`)
 * but writes through the SQLite-backed `TaskStore` rather than mutating
 * markdown in place — the markdown is a pure projection of the store.
 *
 * Row shape (one JSON object per line):
 *
 *   {"action":"add","title":"...","priority":"P1","due":"2026-06-30",
 *    "project":"neutron","notes":"...","source":"chat","id":"opt-uuid"}
 *   {"action":"complete","id":"<uuid>"}
 *   {"action":"complete","title":"submit Q3 report","project":"neutron"}
 *   {"action":"update","id":"<uuid>","priority":"P0","due":"2026-06-22"}
 *   {"action":"cancel","id":"<uuid>"}
 *   {"action":"delete","id":"<uuid>"}
 *
 * Parsing is pure + total: a malformed line yields a `ParseError` rather
 * than throwing, so one bad row never blocks the rest of the queue.
 */

/** The mutation verbs the inbox understands. */
export type InboxAction = 'add' | 'complete' | 'update' | 'cancel' | 'delete'

export const ALL_INBOX_ACTIONS: ReadonlyArray<InboxAction> = [
  'add',
  'complete',
  'update',
  'cancel',
  'delete',
]

/**
 * Human-facing priority mnemonic accepted in inbox rows. `P0` is most
 * urgent. Maps to the store's 0..3 scale (3 = most urgent) via
 * {@link priorityTagToStorage}.
 */
export type PriorityTag = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * A parsed, normalized inbox row. `priority` is the STORAGE scale
 * (0..3, 3 = most urgent) and `due_date` is ISO-8601 — both already
 * converted from the human-facing inbox forms (`P0`..`P3`,
 * `YYYY-MM-DD`) so the apply layer can hand them straight to the
 * `TaskStore`.
 */
export interface InboxRow {
  action: InboxAction
  /** Optional caller-supplied id — enables idempotent `add` + targeted edits. */
  id?: string
  /** Project scope; defaults to the no-project sentinel at apply time. */
  project?: string
  title?: string
  /** Storage scale 0..3 (3 = most urgent), or null to clear. */
  priority?: number | null
  /** ISO-8601, or null to clear. */
  due_date?: string | null
  /** Free-text — applied as the task `description`. */
  notes?: string | null
  /** Provenance tag stamped onto the task `source` column. */
  source?: string | null
  /** The verbatim source line (for archive / audit). */
  raw: string
}

/** A line that could not be parsed into a valid {@link InboxRow}. */
export interface ParseError {
  raw: string
  /** 1-based line number within the inbox file. */
  line: number
  message: string
}

export interface ParsedInbox {
  rows: InboxRow[]
  errors: ParseError[]
}

const PRIORITY_TAGS: ReadonlyArray<PriorityTag> = ['P0', 'P1', 'P2', 'P3']

/**
 * Convert a human-facing `P0`..`P3` tag to the store's 0..3 scale
 * (P0 → 3, P1 → 2, P2 → 1, P3 → 0). Returns null for unrecognized
 * input so callers can treat it as "no priority".
 */
export function priorityTagToStorage(tag: string): number | null {
  const idx = PRIORITY_TAGS.indexOf(tag.toUpperCase() as PriorityTag)
  if (idx < 0) return null
  return 3 - idx
}

/**
 * Normalize a raw inbox `priority` value (either a `P0`..`P3` string or
 * a bare 0..3 storage integer) into the storage scale. Returns
 * `undefined` when the field was absent, `null` when explicitly cleared,
 * and a 0..3 integer otherwise.
 */
function normalizePriority(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 3) return undefined
    return value
  }
  if (typeof value === 'string') {
    const tag = priorityTagToStorage(value)
    return tag === null ? undefined : tag
  }
  return undefined
}

/**
 * Is `(y, m, d)` a real calendar date? `Date.UTC` silently rolls
 * impossible dates over (Feb 31 → Mar 3), so we build the date and check
 * the components round-trip. Catches typos before `Date.parse` accepts a
 * shifted day.
 */
function calendarDateOk(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  )
}

/**
 * Normalize a raw inbox `due` value into ISO-8601. Accepts a date-only
 * `YYYY-MM-DD` (anchored to midnight UTC) or a full ISO timestamp.
 * Returns `undefined` when absent, `null` when explicitly cleared, and
 * `undefined` for unparseable input (treated as "no change").
 *
 * The leading `YYYY-MM-DD` (present in both forms) is validated as a real
 * calendar date FIRST — `Date.parse` would otherwise roll an impossible
 * date over (`2026-02-31` / `2026-02-31T00:00:00Z` → Mar 3) and silently
 * schedule the wrong day.
 */
function normalizeDue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return null
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (dateMatch !== null) {
    const y = Number(dateMatch[1])
    const m = Number(dateMatch[2])
    const d = Number(dateMatch[3])
    if (!calendarDateOk(y, m, d)) return undefined
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const ms = Date.parse(`${trimmed}T00:00:00.000Z`)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function isAction(value: unknown): value is InboxAction {
  return typeof value === 'string' && (ALL_INBOX_ACTIONS as string[]).includes(value)
}

/**
 * Read an aliased field by KEY PRESENCE: the primary key wins when
 * present (even when its value is an explicit `null` clear), else the
 * alias, else `undefined`. Using `??` here would drop a `null` clear
 * through to the alias and lose the user's intent to clear the field.
 */
function pickAliased(
  record: Record<string, unknown>,
  primary: string,
  alias: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(record, primary)) return record[primary]
  if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias]
  return undefined
}

/**
 * Parse a single inbox line into an {@link InboxRow}. Returns a string
 * error message on failure (caller wraps it with the line number).
 * Blank lines return `'blank'` so the scanner can silently skip them.
 */
export function parseInboxLine(raw: string): InboxRow | string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'blank'
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `invalid JSON: ${msg}`
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return 'row is not a JSON object'
  }
  const record = obj as Record<string, unknown>
  if (!isAction(record['action'])) {
    return `missing or unknown "action" (expected one of: ${ALL_INBOX_ACTIONS.join(', ')})`
  }
  const action = record['action']

  const row: InboxRow = { action, raw }

  const id = record['id']
  if (typeof id === 'string' && id.trim() !== '') row.id = id.trim()

  const project = record['project']
  if (typeof project === 'string') row.project = project

  const title = record['title']
  if (typeof title === 'string' && title.trim() !== '') row.title = title.trim()

  // A PRESENT-but-invalid priority/due is a hard parse error, not a
  // silent drop — a typo'd `"P9"` must surface as a malformed row rather
  // than quietly creating an unprioritized task.
  const rawPriority = record['priority']
  if (rawPriority !== undefined) {
    const priority = normalizePriority(rawPriority)
    if (priority === undefined) {
      return `invalid "priority": ${JSON.stringify(rawPriority)} (expected P0..P3 or an integer 0..3)`
    }
    row.priority = priority
  }

  // Aliased fields use KEY-PRESENCE (not `??`), so an explicit `null`
  // clear isn't mistaken for "absent" and fall through to the alias.
  const rawDue = pickAliased(record, 'due', 'due_date')
  if (rawDue !== undefined) {
    const due = normalizeDue(rawDue)
    if (due === undefined) {
      return `invalid "due": ${JSON.stringify(rawDue)} (expected YYYY-MM-DD or ISO-8601)`
    }
    row.due_date = due
  }

  const notes = pickAliased(record, 'notes', 'description')
  if (typeof notes === 'string') row.notes = notes
  else if (notes === null) row.notes = null

  const source = record['source']
  if (typeof source === 'string') row.source = source

  // Per-action required-field validation.
  if (action === 'add' && row.title === undefined) {
    return 'an "add" row requires a non-empty "title"'
  }
  if (action !== 'add' && row.id === undefined && row.title === undefined) {
    return `a "${action}" row requires either "id" or "title" to locate the task`
  }

  return row
}

/**
 * Parse a whole inbox file body into rows + errors. Pure — no I/O.
 * Blank lines are skipped silently; malformed lines accumulate in
 * `errors` (with 1-based line numbers) so the scanner can archive them
 * out of the way without blocking valid rows.
 */
export function parseInbox(body: string): ParsedInbox {
  const rows: InboxRow[] = []
  const errors: ParseError[] = []
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const result = parseInboxLine(line)
    if (result === 'blank') continue
    if (typeof result === 'string') {
      errors.push({ raw: line, line: i + 1, message: result })
      continue
    }
    rows.push(result)
  }
  return { rows, errors }
}
