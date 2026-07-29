/**
 * @neutronai/app — chat-upload phase gate (Argus r2 BLOCKING #1).
 *
 * Single predicate used by every file-entry path in the chat surface
 * (drag/drop, web file-picker, web paste, native DocumentPicker) to
 * decide whether to drop a file before it hits the upload modal.
 *
 * Rule:
 *   - Images: never gated. P5.1 chat attachments work in any phase the
 *     composer is enabled in.
 *   - History-import ZIPs: gated. The server-side engine only accepts
 *     `engine.notifyImportUpload` while the active phase exposes an
 *     `upload_affordance` (ai_substrate_offered → import_upload_pending).
 *     Outside that window, POST /api/upload/<source> returns
 *     noop_no_state / noop_wrong_phase silently — the chat modal would
 *     otherwise walk uploading → analyzing → auto-dismiss with no
 *     downstream advance, which is the worst kind of silent-success bug
 *     (the user can't tell the upload was rejected).
 *
 * `uploadAffordance` mirrors `useLatestUploadAffordance(messages)`'s
 * return — the latest non-streaming agent message's upload_affordance
 * field, or `null` when no such affordance is live.
 */

import type { UploadKind } from './upload-client';

export interface UploadAffordanceLike {
  source?: string;
}

export function shouldGateUpload(
  kind: UploadKind,
  uploadAffordance: UploadAffordanceLike | null,
): boolean {
  if (kind !== 'history-import-zip') return false;
  return uploadAffordance === null;
}

/**
 * ISSUES #15 — selects which dropped files to forward to the upload
 * pipeline + the optional user-visible hint. The drop handler in
 * `chat.tsx` keeps the previous "N files dropped, picker only allowed
 * one" behavior consistent with the web file-picker's
 * `<input multiple={false}>` guard by accepting the first file from a
 * multi-drop and surfacing a banner so the abandoned siblings don't
 * disappear silently. Pure function so the regression test can pin the
 * behavior without simulating browser drag-drop events.
 */
export interface DropFileLike {
  name: string;
  /** MIME type when known. */
  mime_type: string;
  /** Optional size in bytes — undefined when the browser doesn't surface it. */
  size_bytes?: number;
}

export interface DropOutcome {
  /** Files to forward to the upload pipeline (currently always 0 or 1). */
  files: DropFileLike[];
  /**
   * One-shot hint to render in the chat surface. `null` when no hint
   * applies (single-file drop, no multi-file rejection).
   */
  hint: string | null;
}

export function selectDropFiles(input: ReadonlyArray<DropFileLike>): DropOutcome {
  if (input.length === 0) return { files: [], hint: null };
  const first = input[0];
  if (first === undefined) return { files: [], hint: null };
  if (input.length === 1) return { files: [first], hint: null };
  return {
    files: [first],
    hint: `Dropped ${input.length} files; uploading the first one only — please upload one file at a time.`,
  };
}
