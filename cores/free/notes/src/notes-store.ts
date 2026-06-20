/**
 * @neutronai/notes — per-project NotesStore.
 *
 * Self-contained drawers / wings / rooms / notes / KG-nodes / KG-edges
 * storage layer over a per-project SQLite handle. Replaces the
 * prior in-tree memory adapter that v0.1.0 shipped.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 4 + § 5.
 *
 * Mental model — RE-IMPLEMENTED from the proven drawer/KG vocabulary,
 * with ZERO imports from Nova or any external memory package:
 *
 *   - drawers : top-level containers (inbox, pinned, archive, custom).
 *   - wings   : optional cross-drawer groupings (forward-compat; v1
 *               ships the table but the UI ignores it).
 *   - rooms   : per-drawer sub-sections (forward-compat as above).
 *   - notes   : markdown-bodied content rows, tagged + soft-deletable.
 *   - kg_nodes: every persisted note auto-gets a kind='note' node.
 *   - kg_edges: directed edges between kg_nodes; kind='user_tunnel' for
 *               explicit `/note tunnel` calls, kind='auto_tunnel'
 *               reserved for S2 LLM enrichment.
 *
 * Concurrency: single-writer per Database handle (Bun's SQLite is a
 * single thread per open handle); every mutation is wrapped in
 * BEGIN IMMEDIATE so two concurrent appends serialise cleanly.
 */

import { Database } from 'bun:sqlite'

export const NOTES_SCHEMA_VERSION = 1

/** Default `inbox` drawer name. The store auto-provisions it on first
 *  capture so users can `/note <body>` without creating a drawer
 *  first. */
export const DEFAULT_INBOX_DRAWER_NAME = 'inbox'

export const DRAWER_KIND_INBOX = 'inbox' as const
export const DRAWER_KIND_PINNED = 'pinned' as const
export const DRAWER_KIND_ARCHIVE = 'archive' as const
export const DRAWER_KIND_CUSTOM = 'custom' as const

export type DrawerKind =
  | typeof DRAWER_KIND_INBOX
  | typeof DRAWER_KIND_PINNED
  | typeof DRAWER_KIND_ARCHIVE
  | typeof DRAWER_KIND_CUSTOM

export const KG_NODE_KIND_NOTE = 'note' as const
export const KG_EDGE_KIND_USER_TUNNEL = 'user_tunnel' as const
export const KG_EDGE_KIND_AUTO_TUNNEL = 'auto_tunnel' as const

export type KgEdgeKind =
  | typeof KG_EDGE_KIND_USER_TUNNEL
  | typeof KG_EDGE_KIND_AUTO_TUNNEL

export type NoteSourceKind = 'chat' | 'launcher' | 'mcp_tool' | 'import'

export interface DrawerRow {
  id: string
  name: string
  kind: DrawerKind
  position: number
  created_at: number
  updated_at: number
  archived_at: number | null
  note_count: number
}

export interface NoteRow {
  id: string
  drawer_id: string
  room_id: string | null
  content: string
  tags: readonly string[]
  source_kind: NoteSourceKind | null
  source_ref: string | null
  created_at: number
  updated_at: number
}

export interface KgNodeRow {
  id: string
  kind: 'note'
  note_id: string | null
  label: string | null
  created_at: number
  updated_at: number
}

export interface KgEdgeRow {
  id: string
  source_id: string
  target_id: string
  kind: KgEdgeKind
  weight: number
  created_at: number
}

export class NotesStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NotesStoreError'
    this.code = code
  }
}

export class NotesSidecarMismatchError extends Error {
  readonly code = 'sidecar_project_mismatch' as const
  constructor(message: string) {
    super(message)
    this.name = 'NotesSidecarMismatchError'
  }
}

export interface NoteWriteInput {
  drawer_id?: string
  drawer_name?: string
  content: string
  tags?: readonly string[]
  source_kind?: NoteSourceKind
  source_ref?: string
}

export interface NoteWriteResult {
  id: string
  drawer_id: string
  /**
   * v1 (S1): always empty. The shape is part of the contract so S2
   * (LLM enrichment) can populate it without changing the call site.
   */
  auto_tunnels: readonly string[]
}

export interface NoteCreateDrawerInput {
  name: string
  kind?: DrawerKind
}

export interface NoteListOptions {
  drawer_id?: string
  limit?: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 500

export interface NotesStoreOptions {
  db: Database
  project_id: string
  ulid?: () => string
  now?: () => number
}

/**
 * NotesStore — per-project storage over a SQLite handle. The handle
 * MUST already have the migrations applied (the resolver does this
 * before constructing the store).
 */
export class NotesStore {
  private readonly db: Database
  readonly project_id: string
  private readonly ulid: () => string
  private readonly now: () => number

  constructor(opts: NotesStoreOptions) {
    this.db = opts.db
    this.project_id = opts.project_id
    this.ulid = opts.ulid ?? defaultUlid
    this.now = opts.now ?? (() => Date.now())
  }

  /** Lifetime: the resolver owns the Database; closing the store
   *  closes the handle. Idempotent. */
  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }

  /** ----- Drawers ----- */

  /**
   * Create a drawer (idempotent on `name` — if a drawer with the same
   * name exists, return it unchanged).
   */
  createDrawer(input: NoteCreateDrawerInput): DrawerRow {
    const kind = input.kind ?? DRAWER_KIND_CUSTOM
    const name = sanitizeDrawerName(input.name)
    const existing = this.findDrawerByName(name)
    if (existing !== null) return existing
    const id = this.ulid()
    const now = this.now()
    this.db.run(
      `INSERT INTO drawers (id, name, kind, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, kind, this.nextDrawerPosition(), now, now],
    )
    return {
      id,
      name,
      kind,
      position: 0,
      created_at: now,
      updated_at: now,
      archived_at: null,
      note_count: 0,
    }
  }

  /**
   * Return the default `inbox` drawer, auto-creating it on first call.
   */
  ensureInbox(): DrawerRow {
    const existing = this.findDrawerByName(DEFAULT_INBOX_DRAWER_NAME)
    if (existing !== null) return existing
    return this.createDrawer({ name: DEFAULT_INBOX_DRAWER_NAME, kind: DRAWER_KIND_INBOX })
  }

  findDrawerByName(name: string): DrawerRow | null {
    const row = this.db
      .query<DrawerSqlRow, [string]>(`SELECT * FROM drawers WHERE name = ?`)
      .get(name)
    if (row === null) return null
    return this.hydrateDrawer(row)
  }

  getDrawer(drawer_id: string): DrawerRow | null {
    const row = this.db
      .query<DrawerSqlRow, [string]>(`SELECT * FROM drawers WHERE id = ?`)
      .get(drawer_id)
    if (row === null) return null
    return this.hydrateDrawer(row)
  }

  listDrawers(): DrawerRow[] {
    const rows = this.db
      .query<DrawerSqlRow, []>(
        `SELECT * FROM drawers WHERE archived_at IS NULL ORDER BY position ASC, created_at ASC`,
      )
      .all()
    return rows.map((r) => this.hydrateDrawer(r))
  }

  /** ----- Notes ----- */

  write(input: NoteWriteInput): NoteWriteResult {
    if (input.content.length === 0) {
      throw new NotesStoreError('empty_content', 'content must be non-empty')
    }
    if (input.content.length > MAX_NOTE_CONTENT_BYTES) {
      throw new NotesStoreError(
        'content_too_large',
        `content exceeds ${MAX_NOTE_CONTENT_BYTES} bytes`,
      )
    }
    const drawer = this.resolveDrawer(input)
    const id = this.ulid()
    const now = this.now()
    const tags = sanitizeTags(input.tags ?? [])
    const tags_json = JSON.stringify(tags)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.run(
        `INSERT INTO notes (id, drawer_id, room_id, content, tags_json, source_kind, source_ref, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          drawer.id,
          input.content,
          tags_json,
          input.source_kind ?? null,
          input.source_ref ?? null,
          now,
          now,
        ],
      )
      this.createKgNodeForNote(id, drawer, input.content, now)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return { id, drawer_id: drawer.id, auto_tunnels: [] }
  }

  getNote(id: string): NoteRow | null {
    const row = this.db
      .query<NoteSqlRow, [string]>(
        `SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id)
    if (row === null) return null
    return this.hydrateNote(row)
  }

  listNotes(opts: NoteListOptions = {}): NoteRow[] {
    const limit = clampLimit(opts.limit ?? DEFAULT_LIST_LIMIT)
    if (opts.drawer_id !== undefined) {
      const rows = this.db
        .query<NoteSqlRow, [string, number]>(
          `SELECT * FROM notes
            WHERE drawer_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?`,
        )
        .all(opts.drawer_id, limit)
      return rows.map((r) => this.hydrateNote(r))
    }
    const rows = this.db
      .query<NoteSqlRow, [number]>(
        `SELECT * FROM notes
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(limit)
    return rows.map((r) => this.hydrateNote(r))
  }

  /** Soft-delete a note. Idempotent (re-deleting a deleted row is a no-op). */
  deleteNote(id: string): boolean {
    const now = this.now()
    const result = this.db.run(
      `UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, id],
    )
    return result.changes > 0
  }

  /** ----- KG nodes + edges ----- */

  /**
   * Find the kg_nodes row that mirrors a notes row. Every persisted
   * note has exactly one such node (created in `write`).
   */
  kgNodeForNote(note_id: string): KgNodeRow | null {
    const row = this.db
      .query<KgNodeSqlRow, [string]>(
        `SELECT * FROM kg_nodes WHERE note_id = ? LIMIT 1`,
      )
      .get(note_id)
    if (row === null) return null
    return hydrateKgNode(row)
  }

  /**
   * Create a directed edge between two NOTE-kind kg_nodes (looked up
   * by note id). Rejects self-loops. Idempotent on
   * (source_id, target_id, kind) — if the edge exists already, return
   * the existing row.
   */
  tunnel(from_note_id: string, to_note_id: string, kind: KgEdgeKind = KG_EDGE_KIND_USER_TUNNEL): KgEdgeRow {
    if (from_note_id === to_note_id) {
      throw new NotesStoreError('tunnel_self_loop', 'cannot tunnel a note to itself')
    }
    const source = this.kgNodeForNote(from_note_id)
    if (source === null) {
      throw new NotesStoreError('unknown_note', `unknown note: ${from_note_id}`)
    }
    const target = this.kgNodeForNote(to_note_id)
    if (target === null) {
      throw new NotesStoreError('unknown_note', `unknown note: ${to_note_id}`)
    }
    const existing = this.db
      .query<KgEdgeSqlRow, [string, string, string]>(
        `SELECT * FROM kg_edges
          WHERE source_id = ? AND target_id = ? AND kind = ? AND archived_at IS NULL
          LIMIT 1`,
      )
      .get(source.id, target.id, kind)
    if (existing !== null) return hydrateKgEdge(existing)
    const id = this.ulid()
    const now = this.now()
    this.db.run(
      `INSERT INTO kg_edges (id, source_id, target_id, kind, weight, created_at)
       VALUES (?, ?, ?, ?, 1.0, ?)`,
      [id, source.id, target.id, kind, now],
    )
    return {
      id,
      source_id: source.id,
      target_id: target.id,
      kind,
      weight: 1.0,
      created_at: now,
    }
  }

  /** Return the outgoing edges from a note (1-hop, kind-agnostic). */
  outgoingTunnels(from_note_id: string): readonly KgEdgeRow[] {
    const source = this.kgNodeForNote(from_note_id)
    if (source === null) return []
    const rows = this.db
      .query<KgEdgeSqlRow, [string]>(
        `SELECT * FROM kg_edges WHERE source_id = ? AND archived_at IS NULL`,
      )
      .all(source.id)
    return rows.map((r) => hydrateKgEdge(r))
  }

  /** Return the incoming edges to a note (1-hop, kind-agnostic). */
  incomingTunnels(to_note_id: string): readonly KgEdgeRow[] {
    const target = this.kgNodeForNote(to_note_id)
    if (target === null) return []
    const rows = this.db
      .query<KgEdgeSqlRow, [string]>(
        `SELECT * FROM kg_edges WHERE target_id = ? AND archived_at IS NULL`,
      )
      .all(target.id)
    return rows.map((r) => hydrateKgEdge(r))
  }

  /**
   * BFS traverse outgoing edges from a starting note id, up to `depth`
   * hops. Returns the set of nodes + edges visited. Depth is clamped
   * to [1, 3] per the brief — deeper traversals risk run-away N²-ish
   * scans on the dev SQLite handle.
   */
  traverse(from_note_id: string, depth: number): { nodes: KgNodeRow[]; edges: KgEdgeRow[] } {
    const start = this.kgNodeForNote(from_note_id)
    if (start === null) return { nodes: [], edges: [] }
    const maxDepth = Math.max(1, Math.min(3, Math.trunc(depth)))
    const nodesById = new Map<string, KgNodeRow>()
    const edges: KgEdgeRow[] = []
    nodesById.set(start.id, start)
    let frontier: string[] = [start.id]
    for (let d = 0; d < maxDepth; d++) {
      if (frontier.length === 0) break
      const nextFrontier: string[] = []
      for (const sourceId of frontier) {
        const out = this.db
          .query<KgEdgeSqlRow, [string]>(
            `SELECT * FROM kg_edges WHERE source_id = ? AND archived_at IS NULL`,
          )
          .all(sourceId)
        for (const e of out) {
          edges.push(hydrateKgEdge(e))
          if (!nodesById.has(e.target_id)) {
            const targetRow = this.db
              .query<KgNodeSqlRow, [string]>(
                `SELECT * FROM kg_nodes WHERE id = ?`,
              )
              .get(e.target_id)
            if (targetRow !== null) {
              const node = hydrateKgNode(targetRow)
              nodesById.set(node.id, node)
              nextFrontier.push(node.id)
            }
          }
        }
      }
      frontier = nextFrontier
    }
    return { nodes: Array.from(nodesById.values()), edges }
  }

  /** ----- Search ----- */

  /**
   * Lex search via SQLite FTS5 BM25. Returns hits ordered by relevance
   * (lower BM25 = better, but the caller's hybrid scorer transforms it
   * into a [0, 1] score where higher = better).
   */
  ftsSearch(query: string, limit: number): Array<{ note_id: string; rank: number }> {
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const ftsQuery = sanitizeFtsQuery(trimmed)
    if (ftsQuery.length === 0) return []
    const rows = this.db
      .query<{ id: string; rank: number }, [string, number]>(
        `SELECT n.id AS id, bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ?
            AND n.deleted_at IS NULL
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(ftsQuery, clampLimit(limit))
    return rows.map((r) => ({ note_id: r.id, rank: r.rank }))
  }

  /** ----- internal helpers ----- */

  private resolveDrawer(input: NoteWriteInput): DrawerRow {
    if (input.drawer_id !== undefined) {
      const row = this.getDrawer(input.drawer_id)
      if (row === null) {
        throw new NotesStoreError('unknown_drawer', `unknown drawer: ${input.drawer_id}`)
      }
      return row
    }
    if (input.drawer_name !== undefined) {
      const existing = this.findDrawerByName(input.drawer_name)
      if (existing !== null) return existing
      return this.createDrawer({ name: input.drawer_name, kind: DRAWER_KIND_CUSTOM })
    }
    return this.ensureInbox()
  }

  private createKgNodeForNote(
    note_id: string,
    drawer: DrawerRow,
    content: string,
    now: number,
  ): void {
    const id = this.ulid()
    const label = denormalisedNoteLabel(drawer.name, content)
    this.db.run(
      `INSERT INTO kg_nodes (id, kind, note_id, label, created_at, updated_at)
       VALUES (?, 'note', ?, ?, ?, ?)`,
      [id, note_id, label, now, now],
    )
  }

  private hydrateDrawer(row: DrawerSqlRow): DrawerRow {
    const note_count = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM notes WHERE drawer_id = ? AND deleted_at IS NULL`,
      )
      .get(row.id)?.n ?? 0
    return {
      id: row.id,
      name: row.name,
      kind: (row.kind as DrawerKind) ?? DRAWER_KIND_CUSTOM,
      position: row.position,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
      note_count,
    }
  }

  private hydrateNote(row: NoteSqlRow): NoteRow {
    let tags: readonly string[] = []
    try {
      const parsed: unknown = JSON.parse(row.tags_json)
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string')
      }
    } catch {
      tags = []
    }
    return {
      id: row.id,
      drawer_id: row.drawer_id,
      room_id: row.room_id,
      content: row.content,
      tags,
      source_kind: (row.source_kind as NoteSourceKind | null) ?? null,
      source_ref: row.source_ref,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private nextDrawerPosition(): number {
    const row = this.db
      .query<{ p: number | null }, []>(`SELECT MAX(position) AS p FROM drawers`)
      .get()
    return (row?.p ?? -1) + 1
  }
}

interface DrawerSqlRow {
  id: string
  name: string
  kind: string
  position: number
  created_at: number
  updated_at: number
  archived_at: number | null
}

interface NoteSqlRow {
  id: string
  drawer_id: string
  room_id: string | null
  content: string
  tags_json: string
  source_kind: string | null
  source_ref: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

interface KgNodeSqlRow {
  id: string
  kind: string
  note_id: string | null
  label: string | null
  created_at: number
  updated_at: number
}

interface KgEdgeSqlRow {
  id: string
  source_id: string
  target_id: string
  kind: string
  weight: number
  created_at: number
  archived_at: number | null
}

function hydrateKgNode(row: KgNodeSqlRow): KgNodeRow {
  return {
    id: row.id,
    kind: 'note',
    note_id: row.note_id,
    label: row.label,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function hydrateKgEdge(row: KgEdgeSqlRow): KgEdgeRow {
  const kind: KgEdgeKind =
    row.kind === KG_EDGE_KIND_AUTO_TUNNEL ? KG_EDGE_KIND_AUTO_TUNNEL : KG_EDGE_KIND_USER_TUNNEL
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    kind,
    weight: row.weight,
    created_at: row.created_at,
  }
}

/** ----- exported pure helpers (used by chat-commands / search) ----- */

const MAX_NOTE_CONTENT_BYTES = 1024 * 1024  // 1 MB hard cap

export function sanitizeDrawerName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new NotesStoreError('empty_drawer_name', 'drawer name must be non-empty')
  }
  if (trimmed.length > 120) {
    throw new NotesStoreError('drawer_name_too_long', 'drawer name must be 120 chars or less')
  }
  return trimmed
}

export function sanitizeTags(raw: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string') continue
    const trimmed = t.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > 64) continue
    out.push(trimmed)
  }
  // Dedup, stable order
  const seen = new Set<string>()
  return out.filter((t) => {
    if (seen.has(t)) return false
    seen.add(t)
    return true
  })
}

function denormalisedNoteLabel(drawer_name: string, content: string): string {
  const snippet = content.replace(/\s+/g, ' ').trim().slice(0, 40)
  return `${drawer_name}: ${snippet}`
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(Math.trunc(n), MAX_LIST_LIMIT)
}

/**
 * Sanitize an FTS5 MATCH query — strip characters with FTS5 syntactic
 * meaning so user input doesn't accidentally cause a parse error or a
 * tautological match. We accept words + spaces; everything else
 * collapses to a space. Returns the empty string if nothing usable
 * survives.
 */
export function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) return ''
  // Wrap each token in double-quotes to defeat any residual operator
  // confusion (FTS5 treats unquoted bareword tokens as terms but
  // SQLite-internal punctuation can still leak). Quoted tokens are
  // literal matches; multiple quoted tokens default to AND.
  return cleaned
    .split(' ')
    .filter((tok) => tok.length > 0)
    .map((tok) => `"${tok.replace(/"/g, '')}"`)
    .join(' ')
}

/**
 * Minimal Crockford-base32 ULID generator. The store accepts a custom
 * factory for tests; the default uses a 48-bit ms-timestamp prefix +
 * 80 random bits encoded as 26 base32 chars.
 */
function defaultUlid(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const now = Date.now()
  let id = ''
  // 10 chars from 48-bit timestamp
  let ts = now
  for (let i = 9; i >= 0; i--) {
    const mod = ts % 32
    id = ENCODING[mod] + id
    ts = Math.floor(ts / 32)
  }
  // 16 chars from random bytes
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
