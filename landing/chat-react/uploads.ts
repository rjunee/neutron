/**
 * landing/chat-react — the chat-attachment upload + authed-fetch client.
 *
 * The Phase-3 React surface reaches attachment parity with the vanilla client
 * over the EXISTING app-attachment surface (`gateway/http/app-upload-surface.ts`,
 * the same one the Expo client uses) — no new backend. Two operations live here,
 * both bearer-authed with the app-ws token (see `config.ts` → `token`):
 *
 *   - {@link uploadAttachment}: `POST /api/app/upload` (multipart, single `file`
 *     part). The server sniffs magic bytes, content-addresses the blob, and
 *     returns `{ ok, url, content_type, size_bytes }` where `url` is the
 *     bearer-authed GET path. The returned URL is what the composer stages and
 *     ultimately passes to `WebChatSession.send({ attachments })`.
 *   - {@link fetchAttachmentObjectUrl}: the render side. The GET handler is
 *     bearer-authed (a leaked URL only reveals one user's blobs), so a plain
 *     `<img src="/api/app/upload/…">` would 401 — we fetch it WITH the bearer and
 *     hand the bubble an `blob:` object URL instead. External `https:` / `data:`
 *     / `blob:` URLs need no auth and bypass this path.
 *
 * Everything is pure given an injected `fetchImpl` (+ `createObjectURL`), so it
 * unit-tests with a fake fetch and no DOM.
 */

import {
  uploadChunked,
  UploadChunkedError,
  type UploadChunkedOptions,
  type UploadChunkedResult,
} from '../upload-client.ts'

/** Mirrors the server cap (`MAX_CHAT_UPLOAD_BYTES`) for a friendly pre-flight
 *  rejection — the server remains the source of truth. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Mirrors the server's chat-upload allow-list
 *  (`CHAT_UPLOAD_MIME_WHITELIST`): raster images + PDF documents. The server
 *  re-sniffs magic bytes regardless; this only avoids a doomed round-trip. */
export const ACCEPTED_ATTACHMENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]

/** The shipped attachment upload/serve endpoint prefix. */
export const UPLOAD_ENDPOINT = '/api/app/upload'

/**
 * BUG 4 — the history-import (ChatGPT/Claude export ZIP) upload endpoint base.
 * The server mounts the CHUNKED resumable protocol under
 * `/api/upload/<source>/...` (`source` ∈ {chatgpt,claude}):
 * `POST …/start`, `PATCH …/<upload_id>` (per-chunk), `HEAD …/<upload_id>`
 * (resume). On the terminal chunk the handler assembles
 * `<owner_home>/imports/<source>.zip`, magic-byte checks it, and notifies the
 * onboarding engine so it advances out of `import_upload_pending` and emits
 * the next prompt over the same socket. {@link importHistoryZip} drives that
 * protocol via the shared {@link uploadChunked} client — a large export
 * uploads in 4 MiB slices (no single giant body → no 413) with live progress.
 * This is a SEPARATE path from image attachments (which are image-only and
 * single-shot).
 */
export const IMPORT_UPLOAD_ENDPOINT = '/api/upload'

/** The export sources the import endpoint accepts (mirrors the affordance). */
export type ImportSource = 'chatgpt' | 'claude'

/**
 * Header the import handler reads to route the post-upload engine prompt back
 * to THIS socket's topic (`TOPIC_ID_HEADER` in import-upload-handler.ts). Omit
 * it and the engine's "reading your export…" prompt is dropped (it falls back
 * to a topic with no live sender).
 */
export const IMPORT_TOPIC_HEADER = 'x-neutron-topic-id'

/** True when a picked/dropped file is a ChatGPT/Claude export ZIP (by MIME or
 *  by `.zip` extension — some browsers report an empty / generic type). */
export function isExportZip(file: File): boolean {
  const t = file.type.toLowerCase()
  if (t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'application/x-zip') return true
  return /\.zip$/i.test(file.name)
}

export interface ImportZipOptions {
  token: string
  /** The app-ws topic (`app:<user>`) so the post-upload prompt reaches this
   *  socket. */
  topicId?: string
  /** Defaults to {@link IMPORT_UPLOAD_ENDPOINT}. */
  endpoint?: string
  fetchImpl?: FetchImpl
  signal?: AbortSignal
  /**
   * UPLOAD progress callback — invoked with `(loadedBytes, totalBytes)` at
   * start (`0, total`), after each landed chunk, and at completion
   * (`total, total`). Wired to the chat-react upload progress bar. This is
   * the UPLOAD itself (bytes over the wire), distinct from the post-upload
   * import-ANALYSIS progress the engine streams once the zip lands.
   */
  onProgress?: (loaded: number, total: number) => void
}

/**
 * The server's `POST /api/upload/<source>` success body. The fields we care
 * about for honest client status are `outcome` (the engine's routing verdict)
 * and `job_id` — non-null ONLY when the engine actually started an import job.
 * A 200 with `job_id: null` is a no-op (e.g. a stray upload the engine
 * declined), and the client MUST NOT claim "reading your history now" for it
 * (ND2, dogfood 2026-06-27 — the banned silent-false-success).
 */
export interface ImportHistoryResult {
  ok: boolean
  source?: string
  outcome?: string
  /** Non-null ⇒ a real import job started; null ⇒ no-op, surface an honest notice. */
  job_id: string | null
}

/**
 * BUG 4 — upload a history-import export ZIP via the CHUNKED resumable
 * protocol (`…/start` → per-chunk `PATCH` → terminal completion), driving the
 * shared {@link uploadChunked} client. Large exports upload in 4 MiB slices so
 * a single giant request body never hits the server (no 413), and
 * `opts.onProgress` drives a live upload progress bar. On the terminal chunk
 * the server assembles the zip, magic-byte checks it, and bridges
 * `notifyImportUpload` — the SAME engine advance the old single-shot POST
 * triggered.
 *
 * Resolves with the server's parsed result so the caller can tell a real
 * job-started from a 200-OK no-op via {@link ImportHistoryResult.job_id} (the
 * engine then drives the rest of onboarding over the WebSocket); rejects with
 * an {@link AttachmentUploadError} on a client/network/HTTP failure (mapped
 * from {@link UploadChunkedError}). The server re-validates magic bytes + size.
 */
export async function importHistoryZip(
  file: File,
  source: ImportSource,
  opts: ImportZipOptions,
): Promise<ImportHistoryResult> {
  const base = opts.endpoint ?? IMPORT_UPLOAD_ENDPOINT
  const url = `${base}/${source}`
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` }
  if (opts.topicId !== undefined && opts.topicId.length > 0) headers[IMPORT_TOPIC_HEADER] = opts.topicId

  const chunkedOpts: UploadChunkedOptions = { url, file, headers }
  if (opts.onProgress !== undefined) chunkedOpts.onProgress = opts.onProgress
  if (opts.signal !== undefined) chunkedOpts.signal = opts.signal
  if (opts.fetchImpl !== undefined) {
    // Adapt the string-input `FetchImpl` this module already accepts to the
    // wider `typeof fetch` the chunked client expects. The client only ever
    // calls it with string URLs, so stringifying a non-string input is safe.
    const injected = opts.fetchImpl
    chunkedOpts.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      injected(typeof input === 'string' ? input : String(input), init)) as typeof fetch
  }

  let result: UploadChunkedResult
  try {
    result = await uploadChunked(chunkedOpts)
  } catch (err) {
    if (err instanceof UploadChunkedError) {
      if (err.opts.phase === 'abort') {
        throw new AttachmentUploadError('aborted', 'Import cancelled.')
      }
      // A positive HTTP status → `http_<status>`; a 0 status is a transport
      // failure after the retry envelope was exhausted → `network_error`.
      const code = err.opts.status > 0 ? `http_${err.opts.status}` : 'network_error'
      throw new AttachmentUploadError(code, err.message, err.opts.status)
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AttachmentUploadError('aborted', 'Import cancelled.')
    }
    throw new AttachmentUploadError('network_error', err instanceof Error ? err.message : 'network error')
  }

  // Map the completion result to the caller's honest-success contract. The
  // finaliser echoes `job_id` on the terminal PATCH: non-null ⇒ a real import
  // job started; null / absent ⇒ a 200 no-op → the caller surfaces "couldn't
  // start" rather than a false success (ND2).
  return {
    ok: true,
    ...(typeof result.source === 'string' ? { source: result.source } : {}),
    ...(typeof result.outcome === 'string' ? { outcome: result.outcome } : {}),
    job_id: typeof result.job_id === 'string' && result.job_id.length > 0 ? result.job_id : null,
  }
}

export interface UploadResult {
  /** Relative, bearer-authed GET path (`/api/app/upload/<user>/<hash>.<ext>`). */
  url: string
  contentType: string
  sizeBytes: number
}

/** A typed failure carrying the server's machine code (or a client-side code)
 *  so the UI can show a precise message + decide whether a retry helps. */
export class AttachmentUploadError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'AttachmentUploadError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface UploadOptions {
  token: string
  /** Defaults to {@link UPLOAD_ENDPOINT}. */
  endpoint?: string
  /** Defaults to the global `fetch` (bound to `globalThis`). */
  fetchImpl?: FetchImpl
  signal?: AbortSignal
}

/** Resolve the global fetch with a safe `this` binding (a bare `fetch`
 *  reference throws "Illegal invocation" in Chrome when called detached). */
function resolveFetch(fetchImpl?: FetchImpl): FetchImpl {
  if (fetchImpl !== undefined) return fetchImpl
  return (input, init) => fetch(input, init)
}

/**
 * Upload one image to the chat-attachment surface and return its stable,
 * bearer-authed URL. Rejects with {@link AttachmentUploadError} on a client
 * pre-flight failure (too large / unsupported type), a non-2xx response, or a
 * malformed body. An aborted upload rejects with code `aborted`.
 */
export async function uploadAttachment(file: File, opts: UploadOptions): Promise<UploadResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentUploadError(
      'upload_too_large',
      `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MiB — the limit is 10 MiB.`,
    )
  }
  // Only pre-reject when the browser actually gave us a type; an empty type
  // (some drag sources) falls through to the server's authoritative sniff.
  if (file.type.length > 0 && !ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
    throw new AttachmentUploadError(
      'unsupported_type',
      `${file.name} is ${file.type} — only PNG, JPEG, GIF, WEBP images and PDF documents are supported.`,
    )
  }
  const endpoint = opts.endpoint ?? UPLOAD_ENDPOINT
  const doFetch = resolveFetch(opts.fetchImpl)
  const form = new FormData()
  form.set('file', file)
  const init: RequestInit = {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}` },
    body: form,
  }
  if (opts.signal !== undefined) init.signal = opts.signal
  let res: Response
  try {
    res = await doFetch(endpoint, init)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AttachmentUploadError('aborted', 'Upload cancelled.')
    }
    throw new AttachmentUploadError(
      'network_error',
      err instanceof Error ? err.message : 'network error',
    )
  }
  let body: { ok?: boolean; url?: unknown; content_type?: unknown; size_bytes?: unknown; message?: unknown; code?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new AttachmentUploadError('malformed_response', `upload returned non-JSON (status ${res.status})`, res.status)
  }
  if (!res.ok || body.ok !== true) {
    const code = typeof body.code === 'string' ? body.code : `http_${res.status}`
    const message = typeof body.message === 'string' ? body.message : `upload failed (status ${res.status})`
    throw new AttachmentUploadError(code, message, res.status)
  }
  if (typeof body.url !== 'string' || body.url.length === 0) {
    throw new AttachmentUploadError('malformed_response', 'upload response missing a url', res.status)
  }
  return {
    url: body.url,
    contentType: typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream',
    sizeBytes: typeof body.size_bytes === 'number' ? body.size_bytes : file.size,
  }
}

export interface FetchObjectUrlOptions {
  token: string
  fetchImpl?: FetchImpl
  signal?: AbortSignal
  /** Injectable for tests (no URL.createObjectURL in some runtimes). */
  createObjectURL?: (blob: Blob) => string
}

/**
 * True when a URL points at OUR bearer-authed attachment surface and therefore
 * must be fetched WITH the token rather than dropped into an `<img src>`.
 *
 * SECURITY: the app-ws bearer must never leave our origin. A relative
 * `/api/app/upload/…` path is ours by construction. An ABSOLUTE URL only counts
 * when its origin equals the page origin — otherwise a crafted message
 * attachment like `https://evil.example/api/app/upload/x.png` (CORS-permitting)
 * would trick the renderer into sending the bearer cross-origin. Without a known
 * page origin we refuse every absolute URL (fail closed).
 */
export function isAuthedAttachmentUrl(url: string, origin?: string): boolean {
  if (url.startsWith(`${UPLOAD_ENDPOINT}/`)) return true
  try {
    const u = new URL(url)
    if (!u.pathname.startsWith(`${UPLOAD_ENDPOINT}/`)) return false
    return origin !== undefined && u.origin === origin
  } catch {
    return false
  }
}

/**
 * Fetch a bearer-authed attachment and return a `blob:` object URL the bubble
 * can render. The caller owns the returned URL's lifetime (revoke on unmount).
 * Throws {@link AttachmentUploadError} on a non-2xx response or network error.
 */
export async function fetchAttachmentObjectUrl(url: string, opts: FetchObjectUrlOptions): Promise<string> {
  const doFetch = resolveFetch(opts.fetchImpl)
  const init: RequestInit = { method: 'GET', headers: { authorization: `Bearer ${opts.token}` } }
  if (opts.signal !== undefined) init.signal = opts.signal
  let res: Response
  try {
    res = await doFetch(url, init)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AttachmentUploadError('aborted', 'fetch cancelled')
    }
    throw new AttachmentUploadError('network_error', err instanceof Error ? err.message : 'network error')
  }
  if (!res.ok) {
    throw new AttachmentUploadError(`http_${res.status}`, `attachment fetch failed (status ${res.status})`, res.status)
  }
  const blob = await res.blob()
  const make =
    opts.createObjectURL ??
    ((b: Blob) => (globalThis as { URL?: { createObjectURL?: (x: Blob) => string } }).URL?.createObjectURL?.(b) ?? '')
  return make(blob)
}
