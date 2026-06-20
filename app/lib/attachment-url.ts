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
