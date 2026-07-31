/**
 * @neutronai/app — voice-message recording: the pure, platform-free half.
 *
 * Everything in this module is a plain function or constant: no React, no
 * React Native, no `expo-audio`. The stateful half (permission prompt,
 * recorder lifecycle, upload) lives in `use-voice-recorder.ts`, and the
 * pixels live in `VoiceRecorderOverlay.tsx`. Splitting it this way means the
 * gesture arithmetic and the duration rules are unit-testable without a
 * device, a microphone, or a native module.
 *
 * THE INTERACTION (modelled on iMessage — Apple Support "Send and receive
 * audio messages", and the iOS 16 recorder behaviour):
 *
 *   LONG-PRESS MODE
 *     Hold the mic → recording starts. While held the mic glyph becomes a
 *     SEND glyph. Release over it → send. Slide the finger away past
 *     `CANCEL_SLIDE_DX` → the glyph flips to ✕ and a release discards.
 *
 *   TAP MODE
 *     Tap the mic → recording starts and latches (no finger held). Tap stop →
 *     recording ends and the clip is held for REVIEW: play it back, ✕ to
 *     discard, send to send.
 *
 * Both modes share one recorder and one upload path; they differ only in which
 * transitions the host component drives.
 */

/**
 * Recorder lifecycle.
 *
 *   idle        nothing captured, mic button at rest
 *   requesting  the OS permission sheet is up (first use only)
 *   recording   capturing; `elapsed_ms` ticks
 *   review      tap-mode only — capture stopped, clip held for preview
 *   uploading   POSTing to /api/app/upload, then handing the URL to the host
 *   error       terminal for this attempt; the host shows `error_message`
 */
export type VoicePhase = 'idle' | 'requesting' | 'recording' | 'review' | 'uploading' | 'error';

/**
 * What a release WOULD do right now, in long-press mode. Mirrors the glyph
 * under the user's finger: 'send' shows the send arrow, 'cancel' shows ✕.
 */
export type VoiceDragIntent = 'send' | 'cancel';

/**
 * Horizontal slide (in px, leftward positive) past which a long-press release
 * discards instead of sends. iMessage puts the discard affordance to the LEFT
 * of the mic in LTR; 80px is far enough not to trigger on the jitter of a
 * normal press and close enough to reach with the same thumb.
 */
export const CANCEL_SLIDE_DX = 80;

/**
 * Vertical travel past which we stop treating the gesture as a slide-to-cancel
 * at all. Sliding UP is iMessage's "lock" affordance on some builds; we do not
 * implement lock, so a large vertical excursion simply keeps the intent at
 * 'send' rather than accidentally discarding a real recording.
 */
export const CANCEL_SLIDE_MAX_DY = 120;

/**
 * A press shorter than this produced no usable audio — an accidental tap on
 * the mic, not a message. Releasing before it elapses discards silently rather
 * than sending a 200ms blip (and rather than showing an error, which would be
 * noise for what is obviously a misfire).
 */
export const MIN_RECORDING_MS = 700;

/**
 * Hard cap on a single voice note. At this point capture auto-stops and the
 * clip drops into the normal send/review path — the recording is kept, never
 * thrown away. 10 minutes of 32kbps mono AAC is ~2.4MB, comfortably inside the
 * gateway's 10 MiB attachment cap (`MAX_CHAT_UPLOAD_BYTES`).
 */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

/** How often the elapsed-time readout ticks while recording. */
export const ELAPSED_TICK_MS = 100;

/**
 * Voice-tuned capture settings for `expo-audio`'s `useAudioRecorder`.
 *
 * Deliberately NOT `RecordingPresets.HIGH_QUALITY` (44.1kHz stereo @128kbps):
 * this is speech destined for an ASR model that resamples to 16kHz mono
 * anyway, so the extra bits buy nothing and cost upload time on a phone
 * network. Mono 22.05kHz @32kbps AAC is ~4KB/s — a one-minute note is ~240KB.
 *
 * `.m4a` (AAC in an MPEG-4 container) is the one container both platforms
 * record natively AND the gateway already whitelists
 * (`gateway/http/app-upload-surface.ts:72-81` accepts `audio/mp4`), so no
 * transcoding is needed anywhere in the path.
 *
 * Typed structurally rather than as `expo-audio`'s `RecordingOptions` so this
 * module stays importable in a plain unit test with no native module present.
 */
export const VOICE_RECORDING_OPTIONS = {
  extension: '.m4a',
  sampleRate: 22050,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    // 'aac ' — IOSOutputFormat.MPEG4AAC. Spelled literally to keep this
    // module free of an `expo-audio` import.
    outputFormat: 'aac ',
    audioQuality: 96,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 32000,
  },
} as const;

/**
 * Format elapsed capture time the way a messaging app does: `M:SS`, growing to
 * `MM:SS` past ten minutes. Never shows hours — `MAX_RECORDING_MS` caps a note
 * long before that.
 *
 * Truncates rather than rounds, so the readout shows `0:00` for the first
 * second and only flips to `0:01` once a full second is actually captured.
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total_seconds = Math.floor(safe / 1000);
  const minutes = Math.floor(total_seconds / 60);
  const seconds = total_seconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Resolve what a long-press release should do, from the finger's offset since
 * the press began.
 *
 * @param dx  Leftward travel in px (positive = toward the discard affordance).
 *            Callers in an RTL layout pass the mirrored value.
 * @param dy  Vertical travel in px (absolute magnitude is what matters).
 */
export function resolveDragIntent(dx: number, dy: number): VoiceDragIntent {
  const safe_dx = Number.isFinite(dx) ? dx : 0;
  const safe_dy = Number.isFinite(dy) ? dy : 0;
  // A mostly-vertical excursion is not a slide-to-cancel — see
  // CANCEL_SLIDE_MAX_DY. Treat it as "still sending" so a thumb that drifts up
  // the screen never silently eats a real recording.
  if (Math.abs(safe_dy) > CANCEL_SLIDE_MAX_DY) return 'send';
  return safe_dx >= CANCEL_SLIDE_DX ? 'cancel' : 'send';
}

/**
 * How far through the slide-to-cancel gesture the finger is, 0..1. Drives the
 * overlay's fade/slide so the affordance is continuous rather than a binary
 * snap at the threshold.
 */
export function cancelProgress(dx: number): number {
  const safe = Number.isFinite(dx) && dx > 0 ? dx : 0;
  return Math.min(1, safe / CANCEL_SLIDE_DX);
}

/**
 * Should a release at this duration produce a message at all? Below
 * `MIN_RECORDING_MS` the press was a misfire and is discarded silently.
 */
export function isSendableDuration(elapsed_ms: number): boolean {
  return Number.isFinite(elapsed_ms) && elapsed_ms >= MIN_RECORDING_MS;
}

/** Has capture hit the hard cap and needs to auto-stop? */
export function shouldAutoStop(elapsed_ms: number): boolean {
  return Number.isFinite(elapsed_ms) && elapsed_ms >= MAX_RECORDING_MS;
}

/**
 * Canonical MIME for a recorded clip's file extension.
 *
 * Returns `null` for anything the gateway's chat-upload whitelist does not
 * accept, which the hook treats as a hard stop — better a clear local error
 * than a 415 from the server after a full upload.
 */
export function mimeForRecordingUri(uri: string): string | null {
  const path = uri.split('?')[0] ?? uri;
  const lower = path.toLowerCase();
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.aac')) {
    return 'audio/mp4';
  }
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return null;
}

/**
 * Filename for the multipart part. Content-addressed server-side, so this is
 * cosmetic — but the extension is NOT: the gateway derives nothing from it,
 * while OpenAI's transcription endpoint routes on the filename extension
 * (`gateway/transcription/openai-transcription.ts:56-74`). Keeping a real
 * extension here keeps the whole chain honest.
 *
 * Carries no timestamp, user id, or any other identifying detail.
 */
export function voiceNoteFileName(uri: string): string {
  const path = uri.split('?')[0] ?? uri;
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : 'm4a';
  return `voice-note.${/^[a-z0-9]{1,5}$/.test(ext) ? ext : 'm4a'}`;
}
