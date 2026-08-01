/**
 * @neutronai/app — voice-note PLAYBACK: the pure, platform-free half.
 *
 * The mirror of `voice-recording.ts`. Everything here is a plain function or a
 * plain module-level registry: no React, no React Native, no `expo-audio`. The
 * pixels and the native player live in `VoiceNoteBubble.tsx`, so the arithmetic
 * a progress bar depends on — and the rule that only one clip may sound at a
 * time — are unit-testable with no device, no speaker and no native module.
 *
 * WHY A PLAYBACK MODULE EXISTS AT ALL. A sent voice note rendered as a file
 * chip: a 🎵 glyph followed by the storage hash. The clip was unlistenable from
 * the app that recorded it — the detection (`isAudioAttachmentUrl`) was there
 * and the RENDERING stopped one step short of a control.
 */

/**
 * The length label a bubble shows when the clip's duration is not known yet.
 *
 * Deliberately NOT `0:00`. Duration arrives with the file's metadata, which is
 * a network round-trip away for a server-hosted clip, and `0:00` in that gap
 * reads as "an empty recording" — the owner would think the send failed. An
 * em-dash pair reads as "not known yet", which is the truth.
 */
export const UNKNOWN_LENGTH_LABEL = '--:--';

/**
 * Format a clip length in SECONDS as `M:SS` (`MM:SS` past ten minutes), or
 * {@link UNKNOWN_LENGTH_LABEL} when the length is not yet known.
 *
 * Seconds rather than milliseconds because that is the unit `expo-audio`'s
 * `AudioStatus` reports. Truncates rather than rounds, matching
 * `formatElapsed` in `voice-recording.ts`, so a 1.9s clip reads `0:01` in both
 * the recorder and the player instead of disagreeing by a second.
 *
 * A non-finite or non-positive duration is "unknown", not zero: `expo-audio`
 * reports `duration: 0` for a source it has not finished loading, and on the
 * web it can briefly report `Infinity` for a streamed body.
 */
export function formatClipLength(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return UNKNOWN_LENGTH_LABEL;
  if (!Number.isFinite(seconds) || seconds <= 0) return UNKNOWN_LENGTH_LABEL;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Format a playback POSITION in seconds as `M:SS`.
 *
 * Distinct from {@link formatClipLength} in exactly one place, and that place
 * is the point: at zero this reads `0:00`, because a clip parked at the start
 * genuinely IS at zero — whereas a clip whose LENGTH reads zero is a clip whose
 * length nobody knows yet, and printing `0:00` for that is a lie.
 */
export function formatPlaybackPosition(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * How far through the clip playback is, 0..1 — the width of the filled part of
 * the progress track.
 *
 * Returns 0 whenever the duration is unknown, so an unloaded clip shows an
 * empty track rather than a full one (dividing by a zero duration would give
 * `Infinity`, which clamps to a FULL bar — a bar that is full before a single
 * sample has played).
 */
export function playbackFraction(current_seconds: number, duration_seconds: number): number {
  if (!Number.isFinite(duration_seconds) || duration_seconds <= 0) return 0;
  if (!Number.isFinite(current_seconds) || current_seconds <= 0) return 0;
  return Math.min(1, current_seconds / duration_seconds);
}

/**
 * Where a tap at `x` px along a track `width` px wide lands, in seconds.
 *
 * Tap-to-seek is what makes the track a CONTROL rather than a decoration: it
 * reflects position AND accepts one. Returns null when the geometry or the
 * duration cannot support a seek (zero-width layout, unloaded clip), so the
 * caller can decline rather than seek to a nonsense position.
 */
export function seekSecondsForTap(
  x: number,
  width: number,
  duration_seconds: number,
): number | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(duration_seconds) || duration_seconds <= 0) return null;
  if (!Number.isFinite(x)) return null;
  const fraction = Math.min(1, Math.max(0, x / width));
  return fraction * duration_seconds;
}

/**
 * The accessibility label for the play/pause control, so a screen reader
 * announces the clip's length rather than "button".
 */
export function playbackControlLabel(playing: boolean, length_label: string): string {
  const what = length_label === UNKNOWN_LENGTH_LABEL ? 'voice message' : `${length_label} voice message`;
  return playing ? `Pause ${what}` : `Play ${what}`;
}

/**
 * The one thing an exclusive-playback registry needs from a player: the ability
 * to be silenced. Structural so the registry never imports `expo-audio` (and so
 * a test can register a plain object).
 */
export interface PausablePlayback {
  pause: () => void;
}

/**
 * THE ONE CLIP RULE — at most one voice note sounds at a time.
 *
 * Two overlapping voice notes is the first thing a user notices in a chat
 * client that got this wrong, and it cannot be enforced inside a component:
 * each bubble owns its own player and knows nothing about its siblings. A
 * module-level registry is the shared surface they can all reach, and it stays
 * here (in the pure half) so the rule is testable without mounting anything.
 *
 * Deliberately a single slot, not a set: "who is audible" has exactly one
 * answer.
 */
let active_playback: PausablePlayback | null = null;

/**
 * Claim the speaker for `handle`, pausing whoever held it. Call this
 * IMMEDIATELY BEFORE `play()`, never after — claiming after the fact leaves a
 * window where both clips are sounding.
 */
export function claimVoicePlayback(handle: PausablePlayback): void {
  const previous = active_playback;
  active_playback = handle;
  if (previous === null || previous === handle) return;
  try {
    previous.pause();
  } catch {
    // A player torn down between claiming and being displaced (its bubble
    // scrolled out of the list and unmounted) throws on `pause()`. It is
    // already silent, which is the whole point of pausing it — swallow it
    // rather than failing the NEW clip's play.
  }
}

/**
 * Give the speaker up — on pause, on finish, and on unmount. Idempotent, and a
 * no-op when someone else already holds the slot, so a bubble unmounting long
 * after being displaced cannot silence the clip currently playing.
 */
export function releaseVoicePlayback(handle: PausablePlayback): void {
  if (active_playback === handle) active_playback = null;
}

/** Who currently holds the speaker. Exists for the exclusivity test. */
export function activeVoicePlayback(): PausablePlayback | null {
  return active_playback;
}

/** Drop the registry back to empty. `beforeEach` hook for tests only. */
export function __resetVoicePlaybackForTests(): void {
  active_playback = null;
}
