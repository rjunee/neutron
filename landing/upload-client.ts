/**
 * @neutronai/landing — chunked resumable upload client.
 *
 * Drives the gateway's chunked-upload protocol
 * (`gateway/upload/chunked-upload-handler.ts`):
 *
 *   1. `POST /api/upload/<source>/start` → mints `{ upload_id, chunk_size_bytes }`
 *   2. Loops `PATCH /api/upload/<source>/<upload_id>` with
 *      `Content-Range: bytes <start>-<end>/<total>` until every chunk
 *      lands. Per-chunk failures are retried with exponential backoff
 *      (1s, 2s, 4s, 8s, 16s, 30s cap; max 10 attempts).
 *   3. On the final chunk the server validates ZIP magic, moves the
 *      assembled file to `<owner_home>/imports/<source>.zip`, and
 *      bridges into the InterviewEngine — the same `import_upload_pending`
 *      → `import_running` advance the legacy single-shot client triggered.
 *
 * Resume semantics: a caller that already has an `upload_id` (e.g.
 * cached in localStorage across a page reload) can pass `resumeUploadId`
 * to skip `/start` and immediately HEAD the session for its current
 * Upload-Offset. The client resumes from there. A 404 on HEAD means the
 * session expired or never existed — the client falls back to a fresh
 * `/start` so the caller doesn't see an unrecoverable error.
 *
 * Intentionally framework-free: no DOM dependencies, only `fetch` +
 * `File.slice`. Both are present in modern browsers AND happy-dom (the
 * landing test harness), and seam-mocked in unit tests via `fetchImpl` +
 * `sleep` deps.
 */

/** Chunk size (bytes) the client uses when the server's
 *  `chunk_size_bytes` is missing or invalid. Matches the server-side
 *  default in `chunked-upload-handler.ts:DEFAULT_CHUNK_SIZE_BYTES`. */
export const DEFAULT_CLIENT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024

/** Default retry envelope per the sprint brief. */
export const DEFAULT_RETRY_OPTS: Required<UploadChunkedRetryOpts> = {
  maxAttempts: 10,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
}

export interface UploadChunkedRetryOpts {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
}

export interface UploadChunkedOptions {
  /**
   * Base upload URL — e.g. `/api/upload/chatgpt`. The client appends
   * `/start` for the initial POST and `/<upload_id>` for PATCH / HEAD.
   * Pass an absolute origin (`https://example.com/api/upload/chatgpt`)
   * when uploading cross-origin.
   */
  url: string
  file: File
  /** Optional. Called after every successful chunk + at start (0, total)
   *  + at completion (total, total). */
  onProgress?: (loaded: number, total: number) => void
  /** Optional. Aborts in-flight + future fetches. The client surfaces
   *  abort by rejecting with the AbortSignal's reason. */
  signal?: AbortSignal
  /** Extra request headers forwarded on every fetch (start + PATCH + HEAD).
   *  `Content-Type` / `Content-Range` / `Content-Length` are managed by
   *  the client and overwrite any same-named entry here. */
  headers?: Record<string, string>
  /** When set, the client tries `HEAD /api/upload/<source>/<upload_id>`
   *  first. On 200 it resumes from `Upload-Offset`; on 404 it falls
   *  through to a fresh `POST /start`. */
  resumeUploadId?: string
  /** Override the server-advertised chunk size. Caller almost never
   *  needs this — provided for parity with the server's optional
   *  `chunk_size_bytes` response. */
  chunkSizeBytes?: number
  /** `fetch` seam — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /** Sleep seam — defaults to `setTimeout`. Tests inject a synchronous
   *  resolver so backoff doesn't slow the suite down. */
  sleep?: (ms: number) => Promise<void>
  /** Retry envelope. Defaults to `DEFAULT_RETRY_OPTS`. */
  retryOpts?: UploadChunkedRetryOpts
  /** Optional `credentials` mode. Default `'include'` (matches the
   *  landing chat.ts upload that runs on the same origin as the gateway). */
  credentials?: RequestCredentials
}

export interface UploadChunkedResult {
  upload_id: string
  status: 'complete'
  /** Server-reported total bytes (mirrors `file.size`). Surfaced so the
   *  caller can log + compare against any local hash. */
  bytes: number
}

export class UploadChunkedError extends Error {
  constructor(
    message: string,
    readonly opts: {
      /** Server HTTP status that triggered the error, or 0 for a transport
       *  failure (network drop after retries exhausted). */
      status: number
      /** The upload_id, if one had been minted by the time this error fired. */
      upload_id?: string
      /** Phase the failure surfaced in. */
      phase: 'start' | 'head' | 'patch' | 'finalize' | 'abort'
      /** Server body when present (truncated to 512 chars). */
      body?: string
    },
  ) {
    super(message)
    this.name = 'UploadChunkedError'
  }
}

interface StartResponse {
  upload_id: string
  chunk_size_bytes?: number
  total_bytes?: number
  expires_at?: number
}

interface PatchResponse {
  ok?: boolean
  bytes_received?: number
  status?: 'complete'
  source?: string
  destination?: string
  outcome?: string
  job_id?: string | null
  error?: string
}

/**
 * Upload `opts.file` to `opts.url` using the chunked-upload protocol.
 * Resolves on completion; rejects with {@link UploadChunkedError} when
 * either a server response indicates a non-retryable failure OR the
 * retry envelope is exhausted on a transient one.
 */
export async function uploadChunked(
  opts: UploadChunkedOptions,
): Promise<UploadChunkedResult> {
  // Bind fetch to globalThis. Calling a bare `fetch` reference as a free
  // function (e.g. `args.fetchImpl(url, init)`) loses its `this` binding to
  // Window, and Chrome/Edge throw `Failed to execute 'fetch' on 'Window':
  // Illegal invocation`. globalThis is the safe binding target across
  // browser + bun-test + node — all expose `fetch` as a method on it.
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis)
  const sleep = opts.sleep ?? defaultSleep
  const retry: Required<UploadChunkedRetryOpts> = {
    maxAttempts: opts.retryOpts?.maxAttempts ?? DEFAULT_RETRY_OPTS.maxAttempts,
    initialDelayMs:
      opts.retryOpts?.initialDelayMs ?? DEFAULT_RETRY_OPTS.initialDelayMs,
    maxDelayMs: opts.retryOpts?.maxDelayMs ?? DEFAULT_RETRY_OPTS.maxDelayMs,
  }
  const credentials: RequestCredentials = opts.credentials ?? 'include'
  const baseHeaders = opts.headers ?? {}

  throwIfAborted(opts.signal, undefined, 'abort')

  // 1. Resolve session + offset. Either resume an existing upload_id
  //    (HEAD → Upload-Offset; 404 falls through to a fresh /start) or
  //    POST /start to mint a new one.
  let upload_id: string
  let chunk_size = opts.chunkSizeBytes ?? DEFAULT_CLIENT_CHUNK_SIZE_BYTES
  let offset = 0

  if (opts.resumeUploadId !== undefined && opts.resumeUploadId.length > 0) {
    const headArgs: HeadArgs = {
      url: opts.url,
      upload_id: opts.resumeUploadId,
      fetchImpl,
      headers: baseHeaders,
      credentials,
    }
    if (opts.signal !== undefined) headArgs.signal = opts.signal
    const headResult = await tryHeadResume(headArgs)
    if (headResult !== null) {
      upload_id = opts.resumeUploadId
      offset = headResult.offset
    } else {
      const startArgs: StartArgs = {
        url: opts.url,
        file: opts.file,
        fetchImpl,
        headers: baseHeaders,
        credentials,
      }
      if (opts.signal !== undefined) startArgs.signal = opts.signal
      const start = await postStart(startArgs)
      upload_id = start.upload_id
      if (typeof start.chunk_size_bytes === 'number' && start.chunk_size_bytes > 0) {
        chunk_size = opts.chunkSizeBytes ?? start.chunk_size_bytes
      }
    }
  } else {
    const startArgs: StartArgs = {
      url: opts.url,
      file: opts.file,
      fetchImpl,
      headers: baseHeaders,
      credentials,
    }
    if (opts.signal !== undefined) startArgs.signal = opts.signal
    const start = await postStart(startArgs)
    upload_id = start.upload_id
    if (typeof start.chunk_size_bytes === 'number' && start.chunk_size_bytes > 0) {
      chunk_size = opts.chunkSizeBytes ?? start.chunk_size_bytes
    }
  }

  const total = opts.file.size
  if (opts.onProgress !== undefined) opts.onProgress(offset, total)

  // 2. Chunk loop. Each iteration sends bytes [offset, offset+chunk_size)
  //    via PATCH with `Content-Range`. Per-chunk retry envelope handles
  //    transient network drops without restarting from byte 0.
  while (offset < total) {
    throwIfAborted(opts.signal, upload_id, 'patch')
    const end = Math.min(offset + chunk_size, total) - 1
    const slice = opts.file.slice(offset, end + 1)
    const range = `bytes ${offset}-${end}/${total}`
    const patchArgs: PatchArgs = {
      url: opts.url,
      upload_id,
      slice,
      range,
      fetchImpl,
      headers: baseHeaders,
      credentials,
      retry,
      sleep,
    }
    if (opts.signal !== undefined) patchArgs.signal = opts.signal
    const patchResult = await patchChunkWithRetry(patchArgs)
    // Server reports the new high-water mark — trust it over local
    // increment so a server-side idempotent merge / retry-on-the-line
    // doesn't double-advance the client offset.
    if (typeof patchResult.bytes_received === 'number') {
      offset = patchResult.bytes_received
    } else {
      offset = end + 1
    }
    if (opts.onProgress !== undefined) opts.onProgress(offset, total)
    if (patchResult.status === 'complete') {
      return { upload_id, status: 'complete', bytes: total }
    }
  }

  // 3. Loop exited without the server returning `status: 'complete'`.
  //    Either the file was zero-byte (which we reject earlier) or the
  //    server reported the final chunk landed without a status flip —
  //    treat it as completion to be defensive.
  if (opts.onProgress !== undefined) opts.onProgress(total, total)
  return { upload_id, status: 'complete', bytes: total }
}

interface StartArgs {
  url: string
  file: File
  fetchImpl: typeof fetch
  headers: Record<string, string>
  credentials: RequestCredentials
  signal?: AbortSignal
}

async function postStart(args: StartArgs): Promise<StartResponse> {
  throwIfAborted(args.signal, undefined, 'start')
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify({
      filename: args.file.name,
      total_bytes: args.file.size,
      mime_type: args.file.type !== '' ? args.file.type : 'application/octet-stream',
    }),
    credentials: args.credentials,
    headers: { ...args.headers, 'Content-Type': 'application/json' },
  }
  if (args.signal !== undefined) init.signal = args.signal
  const res = await args.fetchImpl(`${args.url}/start`, init)
  if (!res.ok) {
    const body = await safeReadText(res)
    throw new UploadChunkedError(
      `POST /start failed (${res.status}): ${body.slice(0, 200)}`,
      { status: res.status, phase: 'start', body },
    )
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new UploadChunkedError(
      `POST /start returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { status: res.status, phase: 'start' },
    )
  }
  if (typeof json !== 'object' || json === null) {
    throw new UploadChunkedError(`POST /start returned non-object body`, {
      status: res.status,
      phase: 'start',
    })
  }
  const fields = json as Record<string, unknown>
  const upload_id = fields['upload_id']
  if (typeof upload_id !== 'string' || upload_id.length === 0) {
    throw new UploadChunkedError(`POST /start missing upload_id`, {
      status: res.status,
      phase: 'start',
    })
  }
  const out: StartResponse = { upload_id }
  if (typeof fields['chunk_size_bytes'] === 'number') {
    out.chunk_size_bytes = fields['chunk_size_bytes']
  }
  if (typeof fields['total_bytes'] === 'number') {
    out.total_bytes = fields['total_bytes']
  }
  if (typeof fields['expires_at'] === 'number') {
    out.expires_at = fields['expires_at']
  }
  return out
}

interface HeadArgs {
  url: string
  upload_id: string
  fetchImpl: typeof fetch
  headers: Record<string, string>
  credentials: RequestCredentials
  signal?: AbortSignal
}

async function tryHeadResume(
  args: HeadArgs,
): Promise<{ offset: number } | null> {
  throwIfAborted(args.signal, args.upload_id, 'head')
  const init: RequestInit = {
    method: 'HEAD',
    credentials: args.credentials,
    headers: { ...args.headers },
  }
  if (args.signal !== undefined) init.signal = args.signal
  let res: Response
  try {
    res = await args.fetchImpl(`${args.url}/${args.upload_id}`, init)
  } catch (err) {
    // Treat a transport failure on HEAD as "no resume" — the caller
    // falls back to /start. Logging is the caller's concern.
    throw new UploadChunkedError(
      `HEAD failed: ${err instanceof Error ? err.message : String(err)}`,
      { status: 0, phase: 'head', upload_id: args.upload_id },
    )
  }
  if (res.status === 404) return null
  if (!res.ok) {
    throw new UploadChunkedError(
      `HEAD returned ${res.status}`,
      { status: res.status, phase: 'head', upload_id: args.upload_id },
    )
  }
  const offsetHeader = res.headers.get('Upload-Offset')
  if (offsetHeader === null) {
    throw new UploadChunkedError(`HEAD missing Upload-Offset header`, {
      status: res.status,
      phase: 'head',
      upload_id: args.upload_id,
    })
  }
  const offset = Number(offsetHeader)
  if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
    throw new UploadChunkedError(
      `HEAD Upload-Offset malformed: ${offsetHeader}`,
      { status: res.status, phase: 'head', upload_id: args.upload_id },
    )
  }
  return { offset }
}

interface PatchArgs {
  url: string
  upload_id: string
  slice: Blob
  range: string
  fetchImpl: typeof fetch
  headers: Record<string, string>
  credentials: RequestCredentials
  signal?: AbortSignal
  retry: Required<UploadChunkedRetryOpts>
  sleep: (ms: number) => Promise<void>
}

/**
 * Send one chunk with exponential-backoff retry. Retries on:
 *   - Transport errors (fetch throws) — likely a connection drop.
 *   - 5xx responses — likely transient gateway failure.
 *   - 409 Conflict (server-detected gap) — re-read the server's
 *     `bytes_received` and re-issue from there. Since the chunk
 *     boundary may have shifted, we DON'T retry the same range; we
 *     surface a `bytes_received` so the loop continues from that offset.
 *
 * Does NOT retry on 4xx other than 409 — those are caller errors that
 * won't resolve on their own.
 */
async function patchChunkWithRetry(args: PatchArgs): Promise<PatchResponse> {
  let attempt = 0
  let delay = args.retry.initialDelayMs
  while (true) {
    attempt += 1
    throwIfAborted(args.signal, args.upload_id, 'patch')
    let res: Response
    try {
      const init: RequestInit = {
        method: 'PATCH',
        body: args.slice,
        credentials: args.credentials,
        headers: {
          ...args.headers,
          'Content-Range': args.range,
          'Content-Type': 'application/octet-stream',
        },
      }
      if (args.signal !== undefined) init.signal = args.signal
      res = await args.fetchImpl(`${args.url}/${args.upload_id}`, init)
    } catch (err) {
      // Transport failure — eligible for retry.
      if (attempt >= args.retry.maxAttempts) {
        throw new UploadChunkedError(
          `PATCH transport failed after ${attempt} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { status: 0, phase: 'patch', upload_id: args.upload_id },
        )
      }
      await args.sleep(delay)
      delay = Math.min(delay * 2, args.retry.maxDelayMs)
      continue
    }
    if (res.ok) {
      return await readPatchBody(res, args.upload_id)
    }
    // Conflict (gap) — surface the server's bytes_received so the
    // caller loop re-aligns to the right offset on the next iteration.
    if (res.status === 409) {
      const body = await safeReadJson(res)
      const offsetHeader = res.headers.get('Upload-Offset')
      const offsetFromHeader = offsetHeader !== null ? Number(offsetHeader) : NaN
      const offsetFromBody =
        body !== null && typeof body['bytes_received'] === 'number'
          ? (body['bytes_received'] as number)
          : NaN
      const offset = Number.isFinite(offsetFromHeader)
        ? offsetFromHeader
        : Number.isFinite(offsetFromBody)
          ? offsetFromBody
          : null
      if (offset === null) {
        throw new UploadChunkedError(
          `PATCH 409 without Upload-Offset / bytes_received`,
          { status: 409, phase: 'patch', upload_id: args.upload_id },
        )
      }
      return { ok: false, bytes_received: offset }
    }
    if (res.status >= 500 && res.status < 600) {
      if (attempt >= args.retry.maxAttempts) {
        const body = await safeReadText(res)
        throw new UploadChunkedError(
          `PATCH ${res.status} after ${attempt} attempts: ${body.slice(0, 200)}`,
          {
            status: res.status,
            phase: 'patch',
            upload_id: args.upload_id,
            body,
          },
        )
      }
      await args.sleep(delay)
      delay = Math.min(delay * 2, args.retry.maxDelayMs)
      continue
    }
    // Non-retryable client error.
    const body = await safeReadText(res)
    throw new UploadChunkedError(
      `PATCH ${res.status}: ${body.slice(0, 200)}`,
      { status: res.status, phase: 'patch', upload_id: args.upload_id, body },
    )
  }
}

async function readPatchBody(res: Response, upload_id: string): Promise<PatchResponse> {
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new UploadChunkedError(
      `PATCH returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { status: res.status, phase: 'patch', upload_id },
    )
  }
  if (typeof json !== 'object' || json === null) {
    throw new UploadChunkedError(`PATCH returned non-object body`, {
      status: res.status,
      phase: 'patch',
      upload_id,
    })
  }
  const fields = json as Record<string, unknown>
  const out: PatchResponse = {}
  if (typeof fields['ok'] === 'boolean') out.ok = fields['ok']
  if (typeof fields['bytes_received'] === 'number') {
    out.bytes_received = fields['bytes_received']
  }
  if (fields['status'] === 'complete') out.status = 'complete'
  if (typeof fields['source'] === 'string') out.source = fields['source']
  if (typeof fields['destination'] === 'string') {
    out.destination = fields['destination']
  }
  if (typeof fields['outcome'] === 'string') out.outcome = fields['outcome']
  if (typeof fields['job_id'] === 'string' || fields['job_id'] === null) {
    out.job_id = fields['job_id'] as string | null
  }
  return out
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function safeReadJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v = await res.json()
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  upload_id: string | undefined,
  phase: UploadChunkedError['opts']['phase'],
): void {
  if (signal === undefined || !signal.aborted) return
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : signal.reason !== undefined
        ? String(signal.reason)
        : 'aborted'
  const opts: UploadChunkedError['opts'] = { status: 0, phase: 'abort' }
  if (upload_id !== undefined) opts.upload_id = upload_id
  // Preserve the abort phase distinct from the working phase so callers
  // can branch on it. `phase` parameter only matters for the error
  // message text below.
  throw new UploadChunkedError(`upload aborted during ${phase}: ${reason}`, opts)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
