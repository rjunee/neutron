/**
 * Voice-message recording — the pure half.
 *
 * Covers the gesture arithmetic and the duration rules that decide whether a
 * press becomes a message. No device, no microphone, no native module: this is
 * exactly why `voice-recording.ts` holds no React and no `expo-audio`.
 */

import { describe, expect, it } from 'bun:test';

import {
  CANCEL_SLIDE_DX,
  CANCEL_SLIDE_MAX_DY,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  VOICE_RECORDING_OPTIONS,
  cancelProgress,
  formatElapsed,
  isSendableDuration,
  mimeForRecordingUri,
  resolveDragIntent,
  shouldAutoStop,
  voiceNoteFileName,
} from '../lib/voice-recording';

describe('formatElapsed', () => {
  it('renders M:SS and truncates rather than rounds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(999)).toBe('0:00');
    expect(formatElapsed(1000)).toBe('0:01');
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(59_999)).toBe('0:59');
    expect(formatElapsed(60_000)).toBe('1:00');
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(725_000)).toBe('12:05');
  });

  it('never renders a negative or NaN clock', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('resolveDragIntent — iMessage slide-to-cancel', () => {
  it('sends while the finger stays near the mic', () => {
    expect(resolveDragIntent(0, 0)).toBe('send');
    expect(resolveDragIntent(CANCEL_SLIDE_DX - 1, 0)).toBe('send');
  });

  it('flips to cancel at the threshold and beyond', () => {
    expect(resolveDragIntent(CANCEL_SLIDE_DX, 0)).toBe('cancel');
    expect(resolveDragIntent(CANCEL_SLIDE_DX + 200, 4)).toBe('cancel');
  });

  it('does not cancel on a mostly-vertical excursion', () => {
    // A thumb sliding UP the screen must never silently eat a real recording.
    expect(resolveDragIntent(CANCEL_SLIDE_DX + 50, CANCEL_SLIDE_MAX_DY + 1)).toBe('send');
    expect(resolveDragIntent(CANCEL_SLIDE_DX + 50, -(CANCEL_SLIDE_MAX_DY + 1))).toBe('send');
  });

  it('treats rightward travel (away from the discard side) as send', () => {
    expect(resolveDragIntent(-300, 0)).toBe('send');
  });

  it('is defensive against non-finite gesture values', () => {
    expect(resolveDragIntent(Number.NaN, Number.NaN)).toBe('send');
  });
});

describe('cancelProgress', () => {
  it('ramps 0..1 across the threshold and clamps past it', () => {
    expect(cancelProgress(0)).toBe(0);
    expect(cancelProgress(-40)).toBe(0);
    expect(cancelProgress(CANCEL_SLIDE_DX / 2)).toBeCloseTo(0.5, 5);
    expect(cancelProgress(CANCEL_SLIDE_DX)).toBe(1);
    expect(cancelProgress(CANCEL_SLIDE_DX * 10)).toBe(1);
  });
});

describe('duration rules', () => {
  it('discards a press too short to hold speech', () => {
    expect(isSendableDuration(0)).toBe(false);
    expect(isSendableDuration(MIN_RECORDING_MS - 1)).toBe(false);
    expect(isSendableDuration(MIN_RECORDING_MS)).toBe(true);
    expect(isSendableDuration(30_000)).toBe(true);
  });

  it('auto-stops only at the hard cap', () => {
    expect(shouldAutoStop(MAX_RECORDING_MS - 1)).toBe(false);
    expect(shouldAutoStop(MAX_RECORDING_MS)).toBe(true);
  });

  it('keeps the cap inside the gateway 10 MiB attachment limit', () => {
    // 32 kbps mono AAC ⇒ 4 KB/s. A full-length note must not be able to 413.
    const bytes_at_cap = (VOICE_RECORDING_OPTIONS.bitRate / 8) * (MAX_RECORDING_MS / 1000);
    expect(bytes_at_cap).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('recording format', () => {
  it('records the one container the gateway whitelist already accepts', () => {
    // gateway/http/app-upload-surface.ts:72-81 accepts audio/mp4; .m4a is the
    // container both platforms record natively, so nothing transcodes.
    expect(VOICE_RECORDING_OPTIONS.extension).toBe('.m4a');
    expect(VOICE_RECORDING_OPTIONS.android.outputFormat).toBe('mpeg4');
    expect(VOICE_RECORDING_OPTIONS.android.audioEncoder).toBe('aac');
  });

  it('captures speech, not music — mono and low bitrate', () => {
    expect(VOICE_RECORDING_OPTIONS.numberOfChannels).toBe(1);
    expect(VOICE_RECORDING_OPTIONS.bitRate).toBeLessThanOrEqual(48_000);
  });
});

describe('mimeForRecordingUri', () => {
  it('maps the containers the chat-upload whitelist accepts', () => {
    expect(mimeForRecordingUri('file:///tmp/rec.m4a')).toBe('audio/mp4');
    expect(mimeForRecordingUri('file:///tmp/rec.M4A')).toBe('audio/mp4');
    expect(mimeForRecordingUri('file:///tmp/rec.mp3')).toBe('audio/mpeg');
    expect(mimeForRecordingUri('file:///tmp/rec.wav')).toBe('audio/wav');
  });

  it('ignores a query string on the recorder URI', () => {
    expect(mimeForRecordingUri('file:///tmp/rec.m4a?v=2')).toBe('audio/mp4');
  });

  it('returns null for a container the gateway would 415', () => {
    expect(mimeForRecordingUri('file:///tmp/rec.webm')).toBeNull();
    expect(mimeForRecordingUri('file:///tmp/rec.3gp')).toBeNull();
    expect(mimeForRecordingUri('file:///tmp/rec')).toBeNull();
  });
});

describe('voiceNoteFileName', () => {
  it('keeps a real extension — the ASR endpoint routes on it', () => {
    // gateway/transcription/openai-transcription.ts:56-74
    expect(voiceNoteFileName('file:///var/tmp/AV-1234.m4a')).toBe('voice-note.m4a');
    expect(voiceNoteFileName('file:///var/tmp/x.wav')).toBe('voice-note.wav');
  });

  it('carries nothing identifying from the local path', () => {
    const name = voiceNoteFileName('file:///data/user/0/some.app/cache/Audio/REC-2026.m4a');
    expect(name).toBe('voice-note.m4a');
    expect(name).not.toContain('2026');
    expect(name).not.toContain('data');
  });

  it('falls back to m4a for a junk extension', () => {
    expect(voiceNoteFileName('file:///tmp/rec')).toBe('voice-note.m4a');
    expect(voiceNoteFileName('file:///tmp/rec.averylongext')).toBe('voice-note.m4a');
  });
});
