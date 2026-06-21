/**
 * @neutronai/google-workspace-core — GoogleWorkspaceClient interface +
 * reference in-memory adapter + production Drive v3 / Sheets v4 / Docs
 * v1 REST clients.
 *
 * The Tier 1 Google Workspace Core programs against a narrow
 * `GoogleWorkspaceClient` covering nine operations across three Google
 * APIs:
 *
 *   Drive  — driveList / driveRead / driveUpload
 *   Sheets — sheetsRead / sheetsAppend / sheetsUpdate
 *   Docs   — docsRead / docsCreate / docsUpdate
 *
 * Production: a hand-rolled `fetch`-based wrapper backed by an OAuth
 * bearer token resolved lazily from the per-Core SecretsAccessor (the
 * runtime composer refreshes out-of-band). No `googleapis` dependency
 * by design — the REST surface this Core uses is small, and a
 * hand-rolled wrapper avoids pulling the ~5MB transitive tree into a
 * Tier 1 Core (same call the Calendar + Email Cores made).
 *
 * Tests never hit the real Google APIs. Two seams cover the suite:
 *   - `buildInMemoryGoogleWorkspaceClient()` matches the contract with
 *     an in-process store so `__tests__/tools.test.ts` exercises the
 *     tool wiring end-to-end without network.
 *   - The production `buildGoogle*Client` wrappers accept a `fetchImpl`
 *     override so `__tests__/backend.test.ts` asserts the exact HTTP
 *     method / path / payload each op sends (the "performs its op
 *     against a mocked Google API" verify gate).
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DriveFileMeta {
  id: string
  name: string
  mime_type: string
  modified_time?: string
  /** Byte size; null for Google-native files which report no size. */
  size?: number | null
  web_view_link?: string
}

export interface DriveListInput {
  query?: string
  folder_id?: string
  page_size?: number
  page_token?: string
}

export interface DriveListResult {
  files: DriveFileMeta[]
  next_page_token?: string
}

export interface DriveReadInput {
  file_id: string
  export_mime_type?: string
}

export interface DriveFileContent {
  id: string
  name: string
  mime_type: string
  content_text: string
  /** The export MIME used for Google-native files; null for direct
   *  alt=media downloads. */
  exported_as?: string | null
}

export interface DriveReadResult {
  file: DriveFileContent
}

export interface DriveUploadInput {
  name: string
  mime_type: string
  content: string
  folder_id?: string
}

export interface DriveUploadResult {
  file: DriveFileMeta
}

export interface SheetsReadInput {
  spreadsheet_id: string
  range: string
}

export interface SheetsReadResult {
  range: string
  values: string[][]
}

export interface SheetsWriteInput {
  spreadsheet_id: string
  range: string
  values: string[][]
}

export interface SheetsWriteResult {
  updated_range: string
  updated_rows: number
  updated_cells: number
}

export interface DocsReadInput {
  document_id: string
}

export interface DocsDocument {
  document_id: string
  title: string
  body_text: string
}

export interface DocsReadResult {
  document: DocsDocument
}

export interface DocsCreateInput {
  title: string
  body?: string
}

export interface DocsCreateResult {
  document_id: string
  title: string
}

export interface DocsUpdateInput {
  document_id: string
  text: string
  /** Optional 1-based insertion offset; appends to end when omitted. */
  index?: number
}

export interface DocsUpdateResult {
  document_id: string
  replies_count: number
}

/**
 * Backend contract every GoogleWorkspaceClient implementation
 * satisfies. The shape mirrors the nine MCP tool inputs the manifest
 * declares.
 */
export interface GoogleWorkspaceClient {
  driveList(input: DriveListInput): Promise<DriveListResult>
  /** Throws `DriveFileNotFoundError` on unknown id. */
  driveRead(input: DriveReadInput): Promise<DriveReadResult>
  driveUpload(input: DriveUploadInput): Promise<DriveUploadResult>
  sheetsRead(input: SheetsReadInput): Promise<SheetsReadResult>
  sheetsAppend(input: SheetsWriteInput): Promise<SheetsWriteResult>
  sheetsUpdate(input: SheetsWriteInput): Promise<SheetsWriteResult>
  /** Throws `DocNotFoundError` on unknown id. */
  docsRead(input: DocsReadInput): Promise<DocsReadResult>
  docsCreate(input: DocsCreateInput): Promise<DocsCreateResult>
  /** Throws `DocNotFoundError` on unknown id. */
  docsUpdate(input: DocsUpdateInput): Promise<DocsUpdateResult>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the access-token accessor returns null. The runtime
 * composer can interpret this as "re-prompt the user for OAuth
 * consent" — surfaced separately from a generic API error so the
 * caller doesn't conflate a transient API failure with a revoked grant.
 */
export class OAuthMissingError extends Error {
  readonly code = 'oauth_missing' as const
  constructor() {
    super('Google Workspace OAuth token is unavailable — re-prompt for consent')
    this.name = 'OAuthMissingError'
  }
}

export class GoogleWorkspaceApiError extends Error {
  readonly code = 'google_workspace_api_error' as const
  readonly http_status: number
  constructor(http_status: number, message: string) {
    super(`Google API ${http_status}: ${message}`)
    this.name = 'GoogleWorkspaceApiError'
    this.http_status = http_status
  }
}

export class DriveFileNotFoundError extends Error {
  readonly code = 'drive_file_not_found' as const
  readonly file_id: string
  constructor(file_id: string) {
    super(`drive file not found: ${file_id}`)
    this.name = 'DriveFileNotFoundError'
    this.file_id = file_id
  }
}

export class DocNotFoundError extends Error {
  readonly code = 'doc_not_found' as const
  readonly document_id: string
  constructor(document_id: string) {
    super(`google doc not found: ${document_id}`)
    this.name = 'DocNotFoundError'
    this.document_id = document_id
  }
}

/** Default page size when callers omit `page_size`. */
export const DEFAULT_DRIVE_PAGE_SIZE = 25

/** Google-native MIME → default export MIME for `driveRead`. */
export const GOOGLE_EXPORT_DEFAULTS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

// ---------------------------------------------------------------------------
// In-memory reference adapter
// ---------------------------------------------------------------------------

interface InMemoryGoogleWorkspaceOptions {
  /** Id minter override for deterministic tests. */
  nextId?: () => string
  /** Wall-clock override for deterministic modified_time stamping. */
  now?: () => number
}

interface InMemoryDriveFile {
  id: string
  name: string
  mime_type: string
  // Always populated by the seed/upload paths — kept non-optional so
  // the `driveList` projection stays assignable to DriveFileMeta under
  // exactOptionalPropertyTypes.
  modified_time: string
  size: number | null
  web_view_link: string
  content_text: string
  parents: string[]
}

interface InMemorySheet {
  /** Dense grid keyed by "row,col" (0-based) → cell string. */
  cells: Map<string, string>
}

interface InMemoryDoc {
  document_id: string
  title: string
  body_text: string
}

/**
 * Reference in-memory `GoogleWorkspaceClient`. Used by the Core's
 * `__tests__/tools.test.ts` so the suite never reaches Google. The
 * production wrapper is `buildGoogleWorkspaceClient` below.
 *
 * Faithful-enough semantics:
 *   - Drive list returns newest-first by modified_time; `query` does a
 *     best-effort `name contains 'x'` substring match; `folder_id`
 *     filters by parent.
 *   - Sheets ranges parse a narrow A1 subset ("Sheet1!A1:C3" / "A1");
 *     append writes after the last non-empty row of the anchored
 *     column block; update writes from the top-left anchor.
 *   - Docs store flattened text; create seeds the body; update inserts
 *     text at the offset (or appends).
 */
export function buildInMemoryGoogleWorkspaceClient(
  options: InMemoryGoogleWorkspaceOptions = {},
): GoogleWorkspaceClient & {
  /** Test seam — insert a Drive file directly. Returns its id. */
  seedDriveFile(input: {
    id?: string
    name: string
    mime_type: string
    content_text?: string
    parents?: string[]
    modified_time?: string
    size?: number | null
    web_view_link?: string
  }): string
  /** Test seam — seed sheet cell values from a 2-D array at A1. */
  seedSheet(spreadsheet_id: string, values: string[][]): void
  /** Test seam — seed a doc. Returns its id. */
  seedDoc(input: { id?: string; title: string; body_text?: string }): string
} {
  const nextId = options.nextId ?? ((): string => randomUUID())
  const now = options.now ?? ((): number => Date.now())

  const driveFiles = new Map<string, InMemoryDriveFile>()
  const sheets = new Map<string, InMemorySheet>()
  const docs = new Map<string, InMemoryDoc>()

  function isoNow(): string {
    return new Date(now()).toISOString()
  }

  function getSheet(spreadsheet_id: string): InMemorySheet {
    let s = sheets.get(spreadsheet_id)
    if (s === undefined) {
      s = { cells: new Map<string, string>() }
      sheets.set(spreadsheet_id, s)
    }
    return s
  }

  return {
    seedDriveFile(input): string {
      const id = input.id ?? `file-${nextId()}`
      driveFiles.set(id, {
        id,
        name: input.name,
        mime_type: input.mime_type,
        content_text: input.content_text ?? '',
        parents: input.parents ?? [],
        modified_time: input.modified_time ?? isoNow(),
        size: input.size ?? (input.content_text ?? '').length,
        web_view_link: input.web_view_link ?? `https://drive.google.com/file/d/${id}/view`,
      })
      return id
    },

    seedSheet(spreadsheet_id, values): void {
      const sheet = getSheet(spreadsheet_id)
      for (let r = 0; r < values.length; r++) {
        const row = values[r] ?? []
        for (let c = 0; c < row.length; c++) {
          sheet.cells.set(`${r},${c}`, row[c] ?? '')
        }
      }
    },

    seedDoc(input): string {
      const id = input.id ?? `doc-${nextId()}`
      docs.set(id, {
        document_id: id,
        title: input.title,
        body_text: input.body_text ?? '',
      })
      return id
    },

    async driveList(input: DriveListInput): Promise<DriveListResult> {
      const limit = input.page_size ?? DEFAULT_DRIVE_PAGE_SIZE
      let rows = [...driveFiles.values()]
      if (input.folder_id !== undefined) {
        rows = rows.filter((f) => f.parents.includes(input.folder_id!))
      }
      if (input.query !== undefined) {
        const m = /name contains '([^']*)'/.exec(input.query)
        const needle = (m?.[1] ?? input.query).toLowerCase()
        rows = rows.filter((f) => f.name.toLowerCase().includes(needle))
      }
      rows.sort((a, b) => {
        const aMs = Date.parse(a.modified_time ?? '')
        const bMs = Date.parse(b.modified_time ?? '')
        return bMs - aMs
      })
      const files: DriveFileMeta[] = rows.slice(0, limit).map((f) => ({
        id: f.id,
        name: f.name,
        mime_type: f.mime_type,
        modified_time: f.modified_time,
        size: f.size,
        web_view_link: f.web_view_link,
      }))
      return { files }
    },

    async driveRead(input: DriveReadInput): Promise<DriveReadResult> {
      const f = driveFiles.get(input.file_id)
      if (f === undefined) throw new DriveFileNotFoundError(input.file_id)
      const isNative = f.mime_type.startsWith('application/vnd.google-apps')
      const exported_as = isNative
        ? input.export_mime_type ?? GOOGLE_EXPORT_DEFAULTS[f.mime_type] ?? 'text/plain'
        : null
      return {
        file: {
          id: f.id,
          name: f.name,
          mime_type: f.mime_type,
          content_text: f.content_text,
          exported_as,
        },
      }
    },

    async driveUpload(input: DriveUploadInput): Promise<DriveUploadResult> {
      const id = `file-${nextId()}`
      const file: InMemoryDriveFile = {
        id,
        name: input.name,
        mime_type: input.mime_type,
        content_text: input.content,
        parents: input.folder_id !== undefined ? [input.folder_id] : [],
        modified_time: isoNow(),
        size: input.content.length,
        web_view_link: `https://drive.google.com/file/d/${id}/view`,
      }
      driveFiles.set(id, file)
      return {
        file: {
          id,
          name: file.name,
          mime_type: file.mime_type,
          web_view_link: file.web_view_link,
        },
      }
    },

    async sheetsRead(input: SheetsReadInput): Promise<SheetsReadResult> {
      const sheet = getSheet(input.spreadsheet_id)
      const parsed = parseA1Range(input.range)
      const values = readGrid(sheet, parsed)
      return { range: input.range, values }
    },

    async sheetsAppend(input: SheetsWriteInput): Promise<SheetsWriteResult> {
      const sheet = getSheet(input.spreadsheet_id)
      const parsed = parseA1Range(input.range)
      const startCol = parsed.startCol
      // Find the next empty row at/after the anchor row within the
      // anchored column block.
      let appendRow = parsed.startRow
      for (const key of sheet.cells.keys()) {
        const [r, c] = key.split(',').map((n) => Number.parseInt(n, 10))
        if (r === undefined || c === undefined) continue
        if (c >= startCol && r >= appendRow) appendRow = r + 1
      }
      let cells = 0
      for (let i = 0; i < input.values.length; i++) {
        const row = input.values[i] ?? []
        for (let j = 0; j < row.length; j++) {
          sheet.cells.set(`${appendRow + i},${startCol + j}`, row[j] ?? '')
          cells++
        }
      }
      const rows = input.values.length
      const endRow = appendRow + Math.max(rows - 1, 0)
      const endCol = startCol + Math.max(maxRowLen(input.values) - 1, 0)
      return {
        updated_range: `${a1(appendRow, startCol)}:${a1(endRow, endCol)}`,
        updated_rows: rows,
        updated_cells: cells,
      }
    },

    async sheetsUpdate(input: SheetsWriteInput): Promise<SheetsWriteResult> {
      const sheet = getSheet(input.spreadsheet_id)
      const parsed = parseA1Range(input.range)
      let cells = 0
      for (let i = 0; i < input.values.length; i++) {
        const row = input.values[i] ?? []
        for (let j = 0; j < row.length; j++) {
          sheet.cells.set(`${parsed.startRow + i},${parsed.startCol + j}`, row[j] ?? '')
          cells++
        }
      }
      const rows = input.values.length
      const endRow = parsed.startRow + Math.max(rows - 1, 0)
      const endCol = parsed.startCol + Math.max(maxRowLen(input.values) - 1, 0)
      return {
        updated_range: `${a1(parsed.startRow, parsed.startCol)}:${a1(endRow, endCol)}`,
        updated_rows: rows,
        updated_cells: cells,
      }
    },

    async docsRead(input: DocsReadInput): Promise<DocsReadResult> {
      const d = docs.get(input.document_id)
      if (d === undefined) throw new DocNotFoundError(input.document_id)
      return { document: { ...d } }
    },

    async docsCreate(input: DocsCreateInput): Promise<DocsCreateResult> {
      const id = `doc-${nextId()}`
      docs.set(id, {
        document_id: id,
        title: input.title,
        body_text: input.body ?? '',
      })
      return { document_id: id, title: input.title }
    },

    async docsUpdate(input: DocsUpdateInput): Promise<DocsUpdateResult> {
      const d = docs.get(input.document_id)
      if (d === undefined) throw new DocNotFoundError(input.document_id)
      if (input.index === undefined) {
        d.body_text = d.body_text + input.text
      } else {
        const at = Math.max(0, Math.min(input.index - 1, d.body_text.length))
        d.body_text = d.body_text.slice(0, at) + input.text + d.body_text.slice(at)
      }
      return { document_id: input.document_id, replies_count: 1 }
    },
  }
}

// ---------------------------------------------------------------------------
// A1 range helpers (narrow subset — shared by the in-memory fake)
// ---------------------------------------------------------------------------

interface ParsedRange {
  sheetName?: string
  startRow: number
  startCol: number
}

/**
 * Parse a narrow A1 subset into a 0-based top-left anchor:
 *   "Sheet1!A1:C3" / "Sheet1!A1" / "A1" / "Sheet1" (defaults to A1).
 * Only the START cell is significant for the in-memory fake's writes;
 * the end cell is informational. Sheet names are preserved but unused
 * by the single-grid fake.
 */
export function parseA1Range(range: string): ParsedRange {
  let sheetName: string | undefined
  let cellPart = range
  const bang = range.indexOf('!')
  if (bang >= 0) {
    sheetName = range.slice(0, bang)
    cellPart = range.slice(bang + 1)
  }
  const start = cellPart.split(':')[0] ?? 'A1'
  const m = /^([A-Za-z]*)(\d*)$/.exec(start)
  const colLetters = m?.[1] ?? 'A'
  const rowDigits = m?.[2] ?? '1'
  const startCol = colLetters.length > 0 ? colLettersToIndex(colLetters) : 0
  const startRow = rowDigits.length > 0 ? Number.parseInt(rowDigits, 10) - 1 : 0
  const out: ParsedRange = { startRow: Math.max(startRow, 0), startCol }
  if (sheetName !== undefined) out.sheetName = sheetName
  return out
}

function colLettersToIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return Math.max(n - 1, 0)
}

function colIndexToLetters(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function a1(row: number, col: number): string {
  return `${colIndexToLetters(col)}${row + 1}`
}

function maxRowLen(values: string[][]): number {
  return values.reduce((m, r) => Math.max(m, r.length), 0)
}

function readGrid(sheet: InMemorySheet, parsed: ParsedRange): string[][] {
  // Determine the populated extent at/after the anchor.
  let maxRow = parsed.startRow - 1
  let maxCol = parsed.startCol - 1
  for (const key of sheet.cells.keys()) {
    const [r, c] = key.split(',').map((n) => Number.parseInt(n, 10))
    if (r === undefined || c === undefined) continue
    if (r >= parsed.startRow && c >= parsed.startCol) {
      if (r > maxRow) maxRow = r
      if (c > maxCol) maxCol = c
    }
  }
  if (maxRow < parsed.startRow || maxCol < parsed.startCol) return []
  const out: string[][] = []
  for (let r = parsed.startRow; r <= maxRow; r++) {
    const row: string[] = []
    let lastNonEmpty = -1
    for (let c = parsed.startCol; c <= maxCol; c++) {
      const v = sheet.cells.get(`${r},${c}`) ?? ''
      row.push(v)
      if (v.length > 0) lastNonEmpty = c - parsed.startCol
    }
    // Trim trailing empty cells (Sheets API omits them).
    out.push(row.slice(0, lastNonEmpty + 1))
  }
  // Trim trailing fully-empty rows.
  while (out.length > 0 && (out[out.length - 1]?.length ?? 0) === 0) out.pop()
  return out
}

// ---------------------------------------------------------------------------
// Production REST clients (Drive v3 / Sheets v4 / Docs v1)
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>

export interface GoogleWorkspaceClientOptions {
  /** Lazy access-token resolver. Called before each request so the
   *  runtime can refresh out-of-band. Returns `null` to signal a
   *  permanent OAuth failure — the wrapper throws `OAuthMissingError`. */
  accessToken: () => Promise<string | null>
  /** Override the Drive v3 base URL (defaults to the public endpoint). */
  driveBaseUrl?: string
  /** Override the Drive upload base URL. */
  driveUploadBaseUrl?: string
  /** Override the Sheets v4 base URL. */
  sheetsBaseUrl?: string
  /** Override the Docs v1 base URL. */
  docsBaseUrl?: string
  /** Override fetch — tests inject a stub. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike
}

interface DriveFileResource {
  id?: string
  name?: string
  mimeType?: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
  parents?: string[]
}

/**
 * Production Google Workspace REST client. Talks to Drive v3, Sheets
 * v4, and Docs v1 via global `fetch`. The wrapper accepts an
 * `accessToken` accessor closure so the runtime composer can refresh
 * tokens out-of-band without the client caching stale credentials.
 *
 * v1 limitations (deliberate — flagged in README + AGENTS.md):
 *   - Text upload only (multipart). No resumable/binary uploads.
 *   - `driveRead` returns text — Google-native files are exported,
 *     other files are alt=media-downloaded and decoded as UTF-8.
 *   - `docsUpdate` is insertText-only (append or at-index); it does
 *     not expose the full batchUpdate request grammar.
 */
export function buildGoogleWorkspaceClient(
  options: GoogleWorkspaceClientOptions,
): GoogleWorkspaceClient {
  const driveBase = options.driveBaseUrl ?? 'https://www.googleapis.com/drive/v3'
  const driveUploadBase =
    options.driveUploadBaseUrl ?? 'https://www.googleapis.com/upload/drive/v3'
  const sheetsBase = options.sheetsBaseUrl ?? 'https://sheets.googleapis.com/v4/spreadsheets'
  const docsBase = options.docsBaseUrl ?? 'https://docs.googleapis.com/v1/documents'
  const f: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))

  async function authHeader(): Promise<string> {
    const token = await options.accessToken()
    if (token === null) throw new OAuthMissingError()
    return `Bearer ${token}`
  }

  async function callJson(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body?: unknown,
    notFound?: { kind: 'drive' | 'doc'; id: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: await authHeader() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
    const res = await f(url, init)
    if (!res.ok) {
      throwForStatus(res.status, await res.text().catch(() => ''), notFound)
    }
    return res.json()
  }

  function throwForStatus(
    status: number,
    text: string,
    notFound?: { kind: 'drive' | 'doc'; id: string },
  ): never {
    if (status === 404 && notFound !== undefined) {
      if (notFound.kind === 'drive') throw new DriveFileNotFoundError(notFound.id)
      throw new DocNotFoundError(notFound.id)
    }
    throw new GoogleWorkspaceApiError(status, text)
  }

  function metaFromResource(r: DriveFileResource): DriveFileMeta {
    const meta: DriveFileMeta = {
      id: r.id ?? '',
      name: r.name ?? '',
      mime_type: r.mimeType ?? '',
    }
    if (r.modifiedTime !== undefined) meta.modified_time = r.modifiedTime
    meta.size = r.size !== undefined ? Number.parseInt(r.size, 10) : null
    if (r.webViewLink !== undefined) meta.web_view_link = r.webViewLink
    return meta
  }

  return {
    async driveList(input: DriveListInput): Promise<DriveListResult> {
      const limit = input.page_size ?? DEFAULT_DRIVE_PAGE_SIZE
      const params = new URLSearchParams()
      const clauses: string[] = []
      if (input.query !== undefined && input.query.length > 0) clauses.push(input.query)
      if (input.folder_id !== undefined) clauses.push(`'${input.folder_id}' in parents`)
      // Drive `files.list` returns Trash by default. Honor the tool
      // contract ("omitted query → non-trashed files") by AND-ing
      // `trashed = false` unless the caller's own query already
      // constrains the trashed state.
      const mentionsTrashed = clauses.some((c) => /\btrashed\b/.test(c))
      if (!mentionsTrashed) clauses.push('trashed = false')
      params.set('q', clauses.join(' and '))
      params.set('pageSize', String(limit))
      params.set('orderBy', 'modifiedTime desc')
      params.set(
        'fields',
        'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)',
      )
      if (input.page_token !== undefined) params.set('pageToken', input.page_token)
      const raw = (await callJson('GET', `${driveBase}/files?${params.toString()}`)) as {
        files?: DriveFileResource[]
        nextPageToken?: string
      }
      const result: DriveListResult = {
        files: (raw.files ?? []).map(metaFromResource),
      }
      if (typeof raw.nextPageToken === 'string' && raw.nextPageToken.length > 0) {
        result.next_page_token = raw.nextPageToken
      }
      return result
    },

    async driveRead(input: DriveReadInput): Promise<DriveReadResult> {
      // Resolve metadata first to learn the MIME type (export vs download).
      const metaParams = new URLSearchParams({ fields: 'id,name,mimeType' })
      const meta = (await callJson(
        'GET',
        `${driveBase}/files/${encodeURIComponent(input.file_id)}?${metaParams.toString()}`,
        undefined,
        { kind: 'drive', id: input.file_id },
      )) as DriveFileResource
      const mime = meta.mimeType ?? ''
      const isNative = mime.startsWith('application/vnd.google-apps')
      let url: string
      let exported_as: string | null = null
      if (isNative) {
        exported_as =
          input.export_mime_type ?? GOOGLE_EXPORT_DEFAULTS[mime] ?? 'text/plain'
        const p = new URLSearchParams({ mimeType: exported_as })
        url = `${driveBase}/files/${encodeURIComponent(input.file_id)}/export?${p.toString()}`
      } else {
        url = `${driveBase}/files/${encodeURIComponent(input.file_id)}?alt=media`
      }
      const res = await f(url, { method: 'GET', headers: { Authorization: await authHeader() } })
      if (!res.ok) {
        throwForStatus(res.status, await res.text().catch(() => ''), {
          kind: 'drive',
          id: input.file_id,
        })
      }
      const content_text = await res.text()
      return {
        file: {
          id: meta.id ?? input.file_id,
          name: meta.name ?? '',
          mime_type: mime,
          content_text,
          exported_as,
        },
      }
    },

    async driveUpload(input: DriveUploadInput): Promise<DriveUploadResult> {
      // Multipart upload: a JSON metadata part + the text content part.
      const boundary = `neutron-${randomUUID()}`
      const metadata: Record<string, unknown> = {
        name: input.name,
        mimeType: input.mime_type,
      }
      if (input.folder_id !== undefined) metadata['parents'] = [input.folder_id]
      const body =
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${input.mime_type}\r\n\r\n` +
        `${input.content}\r\n` +
        `--${boundary}--`
      const params = new URLSearchParams({
        uploadType: 'multipart',
        fields: 'id,name,mimeType,webViewLink',
      })
      const res = await f(`${driveUploadBase}/files?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: await authHeader(),
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      })
      if (!res.ok) {
        throwForStatus(res.status, await res.text().catch(() => ''))
      }
      const raw = (await res.json()) as DriveFileResource
      const meta: DriveFileMeta = {
        id: raw.id ?? '',
        name: raw.name ?? input.name,
        mime_type: raw.mimeType ?? input.mime_type,
      }
      if (raw.webViewLink !== undefined) meta.web_view_link = raw.webViewLink
      return { file: meta }
    },

    async sheetsRead(input: SheetsReadInput): Promise<SheetsReadResult> {
      const url = `${sheetsBase}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}`
      const raw = (await callJson('GET', url)) as {
        range?: string
        values?: unknown[][]
      }
      const values = (raw.values ?? []).map((row) =>
        row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
      )
      return { range: raw.range ?? input.range, values }
    },

    async sheetsAppend(input: SheetsWriteInput): Promise<SheetsWriteResult> {
      const params = new URLSearchParams({
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      })
      const url = `${sheetsBase}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}:append?${params.toString()}`
      const raw = (await callJson('POST', url, {
        range: input.range,
        majorDimension: 'ROWS',
        values: input.values,
      })) as {
        updates?: {
          updatedRange?: string
          updatedRows?: number
          updatedColumns?: number
          updatedCells?: number
        }
      }
      return {
        updated_range: raw.updates?.updatedRange ?? input.range,
        updated_rows: raw.updates?.updatedRows ?? input.values.length,
        updated_cells: raw.updates?.updatedCells ?? 0,
      }
    },

    async sheetsUpdate(input: SheetsWriteInput): Promise<SheetsWriteResult> {
      const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' })
      const url = `${sheetsBase}/${encodeURIComponent(input.spreadsheet_id)}/values/${encodeURIComponent(input.range)}?${params.toString()}`
      const raw = (await callJson('PUT', url, {
        range: input.range,
        majorDimension: 'ROWS',
        values: input.values,
      })) as {
        updatedRange?: string
        updatedRows?: number
        updatedCells?: number
      }
      return {
        updated_range: raw.updatedRange ?? input.range,
        updated_rows: raw.updatedRows ?? input.values.length,
        updated_cells: raw.updatedCells ?? 0,
      }
    },

    async docsRead(input: DocsReadInput): Promise<DocsReadResult> {
      const url = `${docsBase}/${encodeURIComponent(input.document_id)}`
      const raw = (await callJson('GET', url, undefined, {
        kind: 'doc',
        id: input.document_id,
      })) as GoogleDocResource
      return {
        document: {
          document_id: raw.documentId ?? input.document_id,
          title: raw.title ?? '',
          body_text: flattenDocBody(raw),
        },
      }
    },

    async docsCreate(input: DocsCreateInput): Promise<DocsCreateResult> {
      const created = (await callJson('POST', docsBase, { title: input.title })) as GoogleDocResource
      const document_id = created.documentId ?? ''
      if (input.body !== undefined && input.body.length > 0 && document_id.length > 0) {
        await callJson('POST', `${docsBase}/${encodeURIComponent(document_id)}:batchUpdate`, {
          requests: [{ insertText: { location: { index: 1 }, text: input.body } }],
        })
      }
      return { document_id, title: created.title ?? input.title }
    },

    async docsUpdate(input: DocsUpdateInput): Promise<DocsUpdateResult> {
      // Resolve the insert offset. When the caller omits `index`, append
      // at the end of the body — Docs' end index is the last segment's
      // endIndex minus 1 (the final newline is not editable).
      let index = input.index
      if (index === undefined) {
        const doc = (await callJson(
          'GET',
          `${docsBase}/${encodeURIComponent(input.document_id)}`,
          undefined,
          { kind: 'doc', id: input.document_id },
        )) as GoogleDocResource
        index = endIndexOf(doc)
      }
      const raw = (await callJson(
        'POST',
        `${docsBase}/${encodeURIComponent(input.document_id)}:batchUpdate`,
        { requests: [{ insertText: { location: { index }, text: input.text } }] },
        { kind: 'doc', id: input.document_id },
      )) as { replies?: unknown[] }
      return {
        document_id: input.document_id,
        replies_count: (raw.replies ?? []).length,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Google Docs structured-document flattening
// ---------------------------------------------------------------------------

interface GoogleDocTextRun {
  content?: string
}
interface GoogleDocParagraphElement {
  textRun?: GoogleDocTextRun
  endIndex?: number
}
interface GoogleDocParagraph {
  elements?: GoogleDocParagraphElement[]
}
interface GoogleDocStructuralElement {
  paragraph?: GoogleDocParagraph
  endIndex?: number
}
interface GoogleDocResource {
  documentId?: string
  title?: string
  body?: { content?: GoogleDocStructuralElement[] }
}

/**
 * Flatten a Docs `documents.get` response body into plain text:
 * concatenate every paragraph element's textRun content. Google already
 * embeds `\n` at paragraph ends in the run content, so no extra joining
 * is needed.
 */
export function flattenDocBody(doc: GoogleDocResource): string {
  const out: string[] = []
  for (const el of doc.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      if (pe.textRun?.content !== undefined) out.push(pe.textRun.content)
    }
  }
  return out.join('').replace(/\n$/, '')
}

/**
 * Compute the append offset for `documents.batchUpdate` insertText. The
 * document body's last structural element carries the highest endIndex;
 * Google reserves the final index for an immutable newline, so we
 * insert at endIndex-1.
 */
function endIndexOf(doc: GoogleDocResource): number {
  const content = doc.body?.content ?? []
  let maxEnd = 1
  for (const el of content) {
    if (typeof el.endIndex === 'number' && el.endIndex > maxEnd) maxEnd = el.endIndex
  }
  return Math.max(maxEnd - 1, 1)
}
