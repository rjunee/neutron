/**
 * @neutronai/app — voice-note send orchestration.
 *
 * The step between "capture stopped" and "the message is on the wire":
 * validate the clip, upload it to `/api/app/upload`, hand the returned URL to
 * the host surface. Kept out of the React hook (`use-voice-recorder.ts`) so it
 * can be unit-tested against a stub uploader with no device and no network.
 *
 * There is deliberately NO new server endpoint here. A voice note is an
 * ordinary chat attachment: the same multipart POST an image takes
 * (`app/lib/upload-client.ts:167`), against a whitelist that already accepts
 * `audio/mpeg` / `audio/mp4` / `audio/wav`
 * (`gateway/http/app-upload-surface.ts:72-81`), transcribed at upload-complete
 * by the ASR sidecar seam (`:322-351`) and rendered into the agent's turn with
 * its transcript inline (`gateway/wiring/build-live-agent-turn.ts:263-278`).
 * The mobile client was the only missing half.
 */

import { uploadAttachment, type UploadProgress } from './upload-client';
import { isSendableDuration, mimeForRecordingUri, voiceNoteFileName } from './voice-recording';

/** Why a send attempt ended without a message. */
export type VoiceSendFailure =
  | 'too_short'
  | 'unsupported_format'
  | 'not_signed_in'
  | 'upload_failed';

export type VoiceSendOutcome =
  | { ok: true; url: string; mime_type: string; duration_ms: number; transcript?: string }
  | { ok: false; reason: VoiceSendFailure; message: string };

export interface SendVoiceNoteInput {
  /** Local `file://` URI the recorder produced. */
  uri: string;
  /** Captured length, used for the too-short guard and the host's bubble. */
  duration_ms: number;
  base_url: string;
  token: string | null;
  /** Upload progress passthrough (the overlay renders a determinate bar). */
  onProgress?: (progress: UploadProgress) => void;
  abort_signal?: AbortSignal;
  /** Injected for tests; defaults to the real multipart uploader. */
  upload_impl?: typeof uploadAttachment;
}

/**
 * Upload one recorded clip and report the attachment URL.
 *
 * NEVER throws — every failure is a typed `{ ok: false }` outcome so the hook
 * can put a precise message in front of the owner instead of a stack trace.
 * The caller owns the follow-on `send('', [url])`; this function stops at the
 * URL so the same orchestration serves both the long-press and tap flows.
 */
export async function sendVoiceNote(input: SendVoiceNoteInput): Promise<VoiceSendOutcome> {
  if (!isSendableDuration(input.duration_ms)) {
    return {
      ok: false,
      reason: 'too_short',
      message: 'Hold the mic a moment longer to record.',
    };
  }
  const mime_type = mimeForRecordingUri(input.uri);
  if (mime_type === null) {
    return {
      ok: false,
      reason: 'unsupported_format',
      // The recorder is configured for .m4a, so reaching here means the
      // platform substituted a container we cannot send — surface it rather
      // than uploading bytes the gateway will 415.
      message: 'That recording format cannot be sent.',
    };
  }
  if (input.token === null || input.token.length === 0) {
    return { ok: false, reason: 'not_signed_in', message: 'Not signed in.' };
  }

  const upload = input.upload_impl ?? uploadAttachment;
  const result = await upload({
    uri: input.uri,
    name: voiceNoteFileName(input.uri),
    mime_type,
    token: input.token,
    base_url: input.base_url,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    ...(input.abort_signal !== undefined ? { abort_signal: input.abort_signal } : {}),
  });

  if (result === null) {
    return {
      ok: false,
      reason: 'upload_failed',
      message: 'Could not send the voice message.',
    };
  }
  // The transcript rides back on the upload response (see `UploadResult.transcript`)
  // and is passed to the host so it lands on the message row and therefore in the
  // local search index. Omitted when the server produced none, so a box without
  // transcription configured behaves exactly as before.
  return {
    ok: true,
    url: result.url,
    mime_type,
    duration_ms: input.duration_ms,
    ...(result.transcript !== undefined ? { transcript: result.transcript } : {}),
  };
}
