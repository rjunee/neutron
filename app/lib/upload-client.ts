/**
 * @neutronai/app — upload client for chat attachments.
 *
 * Two endpoints, picked by MIME / file shape:
 *
 *   1. Images (PNG/JPEG/GIF/WEBP) → `POST /api/app/upload`
 *      Returns `{ url }`; the URL rides on the user_message envelope's
 *      `attachments[]` field. The gateway echoes it back; the chat
 *      surface renders the bubble locally + reconciles on echo.
 *
 *   2. ChatGPT / Claude history-import ZIPs (`application/zip` or
 *      `.zip` suffix) → `POST /api/upload/<source>`
 *      Carries `X-Neutron-Topic-Id` so the post-upload engine emit
 *      (`engine.notifyImportUpload`) lands on the user's live WS. No
 *      `attachments[]` envelope is sent for ZIPs — the engine treats
 *      the upload itself as the canonical handoff (matches the landing
 *      chat client's behaviour in `landing/chat.ts:handleUploadFile`).
 *
 * Progress: web uploads stream byte-level progress via XMLHttpRequest
 * so the upload-modal can render a determinate bar. Native uploads stay
 * on `fetch` (RN polyfills don't expose `upload.onprogress`); the modal
 * falls back to an indeterminate shimmer for those.
 *
 * Cancellation: every upload accepts an `AbortSignal`. Web aborts via
 * `xhr.abort()`; native aborts via the fetch `AbortController` path.
 *
 * Failure semantics:
 *   - 4xx / 5xx → returns `null` (caller marks the attachment failed).
 *   - Network throw → returns `null`, logs to console.warn.
 *   - Abort → returns `null` with the final `error` progress event
 *     carrying code `aborted`.
 */

export type UploadKind = 'image' | 'history-import-zip';

export interface UploadProgressStarted {
  phase: 'started';
  kind: UploadKind;
  bytes_total?: number;
}
export interface UploadProgressBytes {
  phase: 'progress';
  bytes_sent: number;
  /** Undefined when the runtime can't report Content-Length. */
  bytes_total?: number;
}
export interface UploadProgressComplete {
  phase: 'complete';
  url: string;
  bytes_total?: number;
}
export interface UploadProgressError {
  phase: 'error';
  code: string;
  message: string;
}

export type UploadProgress =
  | UploadProgressStarted
  | UploadProgressBytes
  | UploadProgressComplete
  | UploadProgressError;

export interface UploadAttachmentInput {
  /** Local URI (file:// on native, blob:/data: on web). */
  uri: string;
  /** Filename hint (only used to disambiguate the ZIP source). */
  name?: string;
  /** Optional MIME hint (the gateway sniffs the bytes too). */
  mime_type?: string;
  /** Bearer token for the gateway. */
  token: string;
  /** Gateway base URL (HTTP). */
  base_url: string;
  /** Progress callback (start / progress / complete / error). */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * For history-import ZIPs only — value of the `X-Neutron-Topic-Id`
   * header the gateway uses to route the post-upload engine emit back
   * through this user's WS. The expo client derives this from the
   * session (`app:<user_id>` per `appWsTopicId`).
   */
  topic_id?: string;
  /**
   * Cancellation. When the caller aborts, the upload returns null and
   * the final progress event carries `code: 'aborted'`. Compatible with
   * both the XHR and fetch paths.
   */
  abort_signal?: AbortSignal;
  /** Override fetch for native + tests. */
  fetch_impl?: typeof fetch;
  /** Override the XMLHttpRequest constructor for tests. */
  xhr_impl?: typeof XMLHttpRequest;
}

export interface UploadResult {
  url: string;
  kind: UploadKind;
}

/** Magic-byte view at the start of a blob. Used only for the heuristic
 *  ZIP detector — does not replace the gateway's own sniff. */
const ZIP_FIRST_BYTES = [0x50, 0x4b];

const HISTORY_IMPORT_MIME_PATTERNS = [
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
];

/**
 * Decide which gateway endpoint a given file should target. ZIPs go to
 * the history-import route; everything else (images today) goes to the
 * generic chat-attachment route. The decision is intentionally on the
 * client so a future ZIP-typed attachment can stay out of the WS
 * envelope's `attachments[]` slot (the engine's notifyImportUpload
 * hook is the canonical handoff for those).
 */
export function classifyUploadKind(input: {
  name?: string;
  mime_type?: string;
}): UploadKind {
  const mime = (input.mime_type ?? '').toLowerCase();
  if (HISTORY_IMPORT_MIME_PATTERNS.some((p) => mime === p || mime.startsWith(p))) {
    return 'history-import-zip';
  }
  const name = (input.name ?? '').toLowerCase();
  if (name.endsWith('.zip')) return 'history-import-zip';
  return 'image';
}

/**
 * Map a ZIP filename → `/api/upload/<source>` enum. Mirrors the landing
 * client's heuristic: anything containing 'claude' → claude, default
 * chatgpt. The engine doesn't actually care about the path — both end
 * up at `<owner_home>/imports/<source>.zip` — but routing the wrong
 * one means the `phase_state.ai_substrate_used` audit logs an unexpected
 * mismatch.
 */
export function inferHistoryImportSource(name?: string): 'chatgpt' | 'claude' {
  if (typeof name === 'string' && name.toLowerCase().includes('claude')) {
    return 'claude';
  }
  return 'chatgpt';
}

/**
 * Upload one attachment. Returns `{ url, kind }` on success, `null` on
 * any failure (including abort). The URL shape depends on the kind:
 *
 *   - 'image':              `/api/app/upload/<user>/<hash>.<ext>` (relative)
 *   - 'history-import-zip': absolute path (gateway returns `destination`
 *                            on the response, but the chat surface treats
 *                            ZIP uploads as a side-channel — the URL is
 *                            informational only).
 */
export async function uploadAttachment(input: UploadAttachmentInput): Promise<UploadResult | null> {
  const kind = classifyUploadKind({ name: input.name, mime_type: input.mime_type });
  const notify = input.onProgress ?? ((_: UploadProgress) => undefined);

  if (kind === 'history-import-zip') {
    return await uploadHistoryImportZip(input, notify);
  }
  return await uploadImageAttachment(input, notify);
}

// ─────────────────────────────────────────────────────────────────────
// Image attachment path — POST /api/app/upload, XHR on web for byte
// progress, fetch on native (RN's XMLHttpRequest polyfill doesn't fire
// upload.onprogress for FormData blobs).
// ─────────────────────────────────────────────────────────────────────

async function uploadImageAttachment(
  input: UploadAttachmentInput,
  notify: (p: UploadProgress) => void,
): Promise<UploadResult | null> {
  const isWeb = typeof window !== 'undefined' && typeof XMLHttpRequest !== 'undefined';
  notify({ phase: 'started', kind: 'image' });

  let body: BodyInit;
  let bytes_total: number | undefined;
  try {
    const built = await buildMultipartBody(input.uri, input.mime_type, input.name);
    body = built.body;
    bytes_total = built.size_bytes;
  } catch (err) {
    notify({
      phase: 'error',
      code: 'multipart_build_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const url = `${input.base_url}/api/app/upload`;
  const xhrCtor = input.xhr_impl ?? (isWeb ? XMLHttpRequest : undefined);

  if (xhrCtor !== undefined && body instanceof FormData) {
    return await uploadWithXhr({
      xhrCtor,
      url,
      body,
      token: input.token,
      bytes_total,
      kind: 'image',
      notify,
      abort_signal: input.abort_signal,
    });
  }

  return await uploadWithFetch({
    url,
    body,
    token: input.token,
    kind: 'image',
    notify,
    fetch_impl: input.fetch_impl,
    abort_signal: input.abort_signal,
  });
}

// ─────────────────────────────────────────────────────────────────────
// History-import ZIP path — POST /api/upload/<source>. The gateway's
// handler responds with `{ ok, destination, outcome, job_id }`. We
// surface `destination` as the result URL so callers can render an
// informational chip, but the canonical handoff is server-side via
// `engine.notifyImportUpload` (no `attachments[]` envelope is sent).
// ─────────────────────────────────────────────────────────────────────

async function uploadHistoryImportZip(
  input: UploadAttachmentInput,
  notify: (p: UploadProgress) => void,
): Promise<UploadResult | null> {
  const isWeb = typeof window !== 'undefined' && typeof XMLHttpRequest !== 'undefined';
  const source = inferHistoryImportSource(input.name);
  notify({ phase: 'started', kind: 'history-import-zip' });

  let body: BodyInit;
  let bytes_total: number | undefined;
  try {
    const built = await buildMultipartBody(input.uri, input.mime_type ?? 'application/zip', input.name);
    body = built.body;
    bytes_total = built.size_bytes;
  } catch (err) {
    notify({
      phase: 'error',
      code: 'multipart_build_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const url = `${input.base_url}/api/upload/${source}`;
  const xhrCtor = input.xhr_impl ?? (isWeb ? XMLHttpRequest : undefined);
  const extraHeaders: Record<string, string> = {};
  if (typeof input.topic_id === 'string' && input.topic_id.length > 0) {
    extraHeaders['x-neutron-topic-id'] = input.topic_id;
  }

  if (xhrCtor !== undefined && body instanceof FormData) {
    return await uploadWithXhr({
      xhrCtor,
      url,
      body,
      token: input.token,
      bytes_total,
      kind: 'history-import-zip',
      notify,
      abort_signal: input.abort_signal,
      extra_headers: extraHeaders,
      response_url_key: 'destination',
    });
  }

  return await uploadWithFetch({
    url,
    body,
    token: input.token,
    kind: 'history-import-zip',
    notify,
    fetch_impl: input.fetch_impl,
    abort_signal: input.abort_signal,
    extra_headers: extraHeaders,
    response_url_key: 'destination',
  });
}

// ─────────────────────────────────────────────────────────────────────
// Transport helpers — one XHR variant (web; byte progress), one fetch
// variant (native + fallback; coarse progress).
// ─────────────────────────────────────────────────────────────────────

interface UploadWithXhrInput {
  xhrCtor: typeof XMLHttpRequest;
  url: string;
  body: FormData;
  token: string;
  bytes_total?: number;
  kind: UploadKind;
  notify: (p: UploadProgress) => void;
  abort_signal?: AbortSignal;
  extra_headers?: Record<string, string>;
  /** Response key holding the URL — defaults to 'url' (chat attachment). */
  response_url_key?: string;
}

function uploadWithXhr(input: UploadWithXhrInput): Promise<UploadResult | null> {
  return new Promise((resolve) => {
    const xhr = new input.xhrCtor();
    let resolved = false;
    const finish = (result: UploadResult | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    const onAbort = (): void => {
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
      input.notify({ phase: 'error', code: 'aborted', message: 'upload aborted' });
      finish(null);
    };
    if (input.abort_signal !== undefined) {
      if (input.abort_signal.aborted) {
        onAbort();
        return;
      }
      input.abort_signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open('POST', input.url, true);
    xhr.setRequestHeader('authorization', `Bearer ${input.token}`);
    if (input.extra_headers !== undefined) {
      for (const [k, v] of Object.entries(input.extra_headers)) {
        xhr.setRequestHeader(k, v);
      }
    }
    xhr.upload.onprogress = (ev: ProgressEvent): void => {
      const ev_total = ev.lengthComputable ? ev.total : input.bytes_total;
      input.notify({
        phase: 'progress',
        bytes_sent: ev.loaded,
        ...(ev_total !== undefined ? { bytes_total: ev_total } : {}),
      });
    };
    xhr.onerror = (): void => {
      input.notify({ phase: 'error', code: 'network', message: 'XHR network error' });
      finish(null);
    };
    xhr.onload = (): void => {
      if (xhr.status < 200 || xhr.status >= 300) {
        input.notify({
          phase: 'error',
          code: `http_${xhr.status}`,
          message: (xhr.responseText ?? '').slice(0, 200),
        });
        finish(null);
        return;
      }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        input.notify({
          phase: 'error',
          code: 'malformed_response',
          message: 'response was not valid JSON',
        });
        finish(null);
        return;
      }
      const url_key = input.response_url_key ?? 'url';
      const url_val = parsed[url_key];
      if (typeof url_val !== 'string' || url_val.length === 0) {
        input.notify({
          phase: 'error',
          code: 'malformed_response',
          message: `expected { ${url_key}: string }`,
        });
        finish(null);
        return;
      }
      input.notify({
        phase: 'complete',
        url: url_val,
        ...(input.bytes_total !== undefined ? { bytes_total: input.bytes_total } : {}),
      });
      finish({ url: url_val, kind: input.kind });
    };
    xhr.send(input.body);
  });
}

interface UploadWithFetchInput {
  url: string;
  body: BodyInit;
  token: string;
  kind: UploadKind;
  notify: (p: UploadProgress) => void;
  fetch_impl?: typeof fetch;
  abort_signal?: AbortSignal;
  extra_headers?: Record<string, string>;
  response_url_key?: string;
}

async function uploadWithFetch(input: UploadWithFetchInput): Promise<UploadResult | null> {
  const fetcher = input.fetch_impl ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
  };
  if (input.extra_headers !== undefined) {
    for (const [k, v] of Object.entries(input.extra_headers)) {
      headers[k] = v;
    }
  }
  try {
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: input.body,
    };
    if (input.abort_signal !== undefined) init.signal = input.abort_signal;
    const res = await fetcher(input.url, init);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      input.notify({
        phase: 'error',
        code: `http_${res.status}`,
        message: txt.slice(0, 200),
      });
      return null;
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const url_key = input.response_url_key ?? 'url';
    const url_val = json?.[url_key];
    if (typeof url_val !== 'string' || url_val.length === 0) {
      input.notify({
        phase: 'error',
        code: 'malformed_response',
        message: `expected { ${url_key}: string }`,
      });
      return null;
    }
    input.notify({ phase: 'complete', url: url_val });
    return { url: url_val, kind: input.kind };
  } catch (err) {
    const is_abort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    input.notify({
      phase: 'error',
      code: is_abort ? 'aborted' : 'network',
      message: err instanceof Error ? err.message : String(err),
    });
    if (!is_abort) console.warn('[upload-client] fetch threw:', err);
    return null;
  }
}

interface BuiltMultipart {
  body: FormData;
  size_bytes?: number;
}

async function buildMultipartBody(
  uri: string,
  mime_type?: string,
  name?: string,
): Promise<BuiltMultipart> {
  if (uri.startsWith('blob:') || uri.startsWith('data:') || uri.startsWith('http')) {
    const res = await fetch(uri);
    const blob = await res.blob();
    const form = new FormData();
    const file_name = name ?? fileNameFromUri(uri, mime_type);
    form.append('file', blob, file_name);
    return { body: form, size_bytes: blob.size };
  }
  // file:// (Expo native): React Native fetch supports passing
  // { uri, name, type } as a FormData entry.
  const form = new FormData();
  const file_name = name ?? fileNameFromUri(uri, mime_type);
  const native_entry = {
    uri,
    name: file_name,
    type: mime_type ?? 'application/octet-stream',
  } as unknown as Blob;
  form.append('file', native_entry, file_name);
  return { body: form };
}

function fileNameFromUri(uri: string, mime_type?: string): string {
  const last = uri.split('/').pop() ?? 'attachment';
  if (last.includes('.')) return last;
  const ext = mime_type ? mimeToExt(mime_type) : 'bin';
  return `${last}.${ext}`;
}

/** Canonical MIME → on-disk extension for the multipart filename. Exported for
 *  unit testing the accepted-type parity (M2 adds PDF). */
export function mimeToExt(mime: string): string {
  if (mime.startsWith('image/png')) return 'png';
  if (mime.startsWith('image/jpeg') || mime.startsWith('image/jpg')) return 'jpg';
  if (mime.startsWith('image/gif')) return 'gif';
  if (mime.startsWith('image/webp')) return 'webp';
  if (mime.startsWith('application/pdf')) return 'pdf';
  // M2 task 5 — audio voice notes (canonical + iOS `x-`/legacy aliases).
  if (mime.startsWith('audio/mpeg') || mime.startsWith('audio/mp3')) return 'mp3';
  if (mime.startsWith('audio/mp4') || mime.startsWith('audio/m4a') || mime.startsWith('audio/x-m4a') || mime.startsWith('audio/aac'))
    return 'm4a';
  if (mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav') || mime.startsWith('audio/wave')) return 'wav';
  if (mime.startsWith('application/zip') || mime === 'application/x-zip') return 'zip';
  return 'bin';
}

/** Heuristic test for "looks like a ZIP" by first-two-byte magic. Used
 *  by the file-input change handler to short-circuit the path through
 *  the upload modal before the upload starts. */
export async function looksLikeZipBlob(blob: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    return head.length >= 2 && head[0] === ZIP_FIRST_BYTES[0] && head[1] === ZIP_FIRST_BYTES[1];
  } catch {
    return false;
  }
}
