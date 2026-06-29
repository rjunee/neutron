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
