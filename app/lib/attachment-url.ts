/**
 * @neutronai/app — attachment-URL helpers (P5.1 / M2 chat-upload UX).
 *
 * Plain-TS module (no React / React-Native imports) so unit tests can
 * import the predicate without dragging the whole chat-state provider
 * tree + RN runtime into the bun test context.
 */

/**
 * Argus r1 BLOCKING #1 — returns true iff `uri` is already a server-
 * returned upload URL (either the relative
 * `/api/app/upload/<user>/<hash>.<ext>` the gateway hands back, or its
 * absolute form against any host). Used by `chat-state.tsx:performUpload`
 * to short-circuit re-uploads of attachments that the chat surface's
 * upload-modal flow already pushed to the server.
 *
 * Pre-r1 the chat surface would send `{ uri: '<server url>' }` back
 * through `send()` and chat-state piped it into `uploadAttachment` a
 * second time — `buildMultipartBody` only fetches `blob:`/`data:`/`http(s):`
 * URIs, so the relative URL fell into the native-FormData branch and
 * shipped a bogus multipart. Image attach silently failed.
 */
export function isAlreadyUploadedAttachmentUrl(uri: string): boolean {
  if (uri.startsWith('/api/app/upload/')) return true;
  return /^https?:\/\/[^/]+\/api\/app\/upload\//.test(uri);
}

/** The bearer + gateway origin the chat surface uses to fetch authed
 *  attachments. Mirrors the web client's `UploadsCtx`
 *  (`landing/chat-react/ChatApp.tsx`). `base_url` is the gateway origin
 *  (e.g. `http://127.0.0.1:8080`); `token` is the app-ws bearer. */
export interface AttachmentAuthCtx {
  base_url: string;
  token: string;
}

const UPLOAD_PREFIX = '/api/app/upload/';

/**
 * True when `uri` points at OUR bearer-authed attachment surface and so
 * MUST be fetched WITH the token (relative path or absolute same-origin),
 * rather than dropped raw into an `<Image src>` — which would 401 (the GET
 * handler requires `Authorization: Bearer` and honors no query/cookie token,
 * see `gateway/http/app-upload-surface.ts`).
 *
 * SECURITY: the bearer must never leave our origin. A relative
 * `/api/app/upload/…` path is ours by construction. An ABSOLUTE URL counts
 * only when its origin equals the gateway origin — otherwise a crafted
 * attachment like `https://evil.example/api/app/upload/x.png` would trick the
 * renderer into sending the bearer cross-origin. Without a known origin we
 * refuse every absolute URL (fail closed). Mirrors the web client's
 * `isAuthedAttachmentUrl`.
 */
export function isAuthedAttachmentUrl(uri: string, origin?: string): boolean {
  if (uri.startsWith(UPLOAD_PREFIX)) return true;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (!parsed.pathname.startsWith(UPLOAD_PREFIX)) return false;
  return origin !== undefined && parsed.origin === origin;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i;

/**
 * True when an attachment URL points at a raster image (by `data:image/` prefix
 * or an image file extension). Mirrors the web client's `isImageAttachmentUrl`
 * (`landing/chat-react/message-adapter.ts`). The mobile bubble renderer
 * ({@link AuthedAttachmentImage}) uses this to branch between an `<Image>` and
 * a downloadable file chip — so a NON-image attachment (e.g. a PDF, newly
 * uploadable in M2) never renders as a broken image (Argus r2 BLOCKER #1).
 */
export function isImageAttachmentUrl(uri: string): boolean {
  if (/^data:image\//i.test(uri)) return true;
  return IMAGE_EXT.test(uri);
}

const AUDIO_EXT = /\.(mp3|m4a|wav)(\?|#|$)/i;

/**
 * True when an attachment URL points at an AUDIO voice note (by `data:audio/`
 * prefix or an audio file extension). Mirrors the web client's
 * `isAudioAttachmentUrl` (`landing/chat-react/message-adapter.ts`) — kept
 * per-client because `landing` and `app` are separate packages. The mobile
 * file-chip renderer ({@link AuthedAttachmentFile}) uses this to show a 🎵 icon
 * instead of the generic 📎 for a voice note (M2 task 5).
 */
export function isAudioAttachmentUrl(uri: string): boolean {
  if (/^data:audio\//i.test(uri)) return true;
  return AUDIO_EXT.test(uri);
}

/**
 * Basename of an attachment URL (strips the path + any query/hash), for the
 * non-image file chip's display + open affordance. Falls back to 'attachment'.
 * Mirrors the web client's `attachmentBasename` (`landing/chat-react/ChatApp.tsx`)
 * including the malformed-percent-escape guard: a poisoned URL like
 * `report%ZZ.pdf` makes `decodeURIComponent` throw during render, so we fall
 * back to the raw (still-encoded) segment rather than crashing the chat view.
 */
export function attachmentBasename(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  const last = withoutQuery.split('/').pop() ?? '';
  if (last.length === 0) return 'attachment';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export interface AttachmentImageSource {
  uri: string;
  headers?: Record<string, string>;
}

/**
 * Resolve a message-attachment URL into a React-Native `<Image>` source.
 *
 * The gateway hands back attachment URLs as RELATIVE, bearer-authed paths
 * (`/api/app/upload/<user>/<hash>.<ext>`, `app-upload-surface.ts`). RN
 * `<Image source={{ uri }}>` neither resolves a host-less path nor sends a
 * bearer, so rendering the raw echo URL yields a broken thumbnail (the
 * GET 401s). For our own authed attachments we therefore (a) resolve the
 * path against the gateway `base_url` and (b) attach the bearer header
 * (RN `<Image>` honors `source.headers` on native; RN-web needs a fetch
 * fallback — see `AuthedAttachmentImage`).
 *
 * Non-authed URLs (`data:`, `blob:`, `file:`, external `https:`) pass
 * through unchanged with no header. A `null` ctx (no session) also passes
 * through — there is no token to attach.
 */
export function resolveAttachmentSource(
  uri: string,
  ctx: AttachmentAuthCtx | null,
): AttachmentImageSource {
  if (ctx === null) return { uri };
  let origin: string | undefined;
  try {
    origin = new URL(ctx.base_url).origin;
  } catch {
    origin = undefined;
  }
  if (!isAuthedAttachmentUrl(uri, origin)) return { uri };
  const absolute = uri.startsWith('/') ? `${ctx.base_url.replace(/\/+$/, '')}${uri}` : uri;
  return { uri: absolute, headers: { Authorization: `Bearer ${ctx.token}` } };
}

/**
 * Convert the attachment URIs stored on an optimistic chat bubble into
 * gateway-sendable URLs ahead of a (re)send.
 *
 * An optimistic bubble stores the raw *local* device URIs
 * (`file://`/`content://`/`ph://`, `chat-state.tsx:send`); only a
 * successful echo swaps them for the `/api/app/upload/<user>/<hash>.<ext>`
 * server URL via `reconcileEcho`. A FAILED send never echoed, so on
 * `retry()` the bubble still holds local URIs — and the gateway's
 * `sanitizeAttachments` rejects the WHOLE array if any entry isn't
 * `https?://`- or `/`-prefixed (`channels/adapters/app-ws/envelope.ts`),
 * so the image-only retry 400s (`missing_body`) and a text+image retry
 * silently loses the image.
 *
 * Routing every stored URI back through `uploadFn` (which itself no-ops
 * any entry that is already an uploaded URL, via
 * `isAlreadyUploadedAttachmentUrl`) guarantees the gateway only ever sees
 * URLs it will accept — and makes retry idempotent for the
 * already-uploaded case + recoverable for the upload-failed case.
 */
export async function resolveSendableAttachments(
  storedUris: ReadonlyArray<string>,
  uploadFn: (atts: ReadonlyArray<{ uri: string }>) => Promise<string[]>,
): Promise<string[]> {
  if (storedUris.length === 0) return [];
  return uploadFn(storedUris.map((uri) => ({ uri })));
}
