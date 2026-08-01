/**
 * @neutronai/app — the composer↔recorder join.
 *
 * These cases exist because the two halves of voice messaging shipped without
 * anything between them: the composer reported gestures to nobody and the
 * recorder had no call site outside its own tests, so every unit test passed
 * while the feature was unreachable. Asserting the MAPPING is what makes that
 * failure impossible to repeat — a handler that stops calling the recorder
 * fails here rather than going quiet on a device.
 *
 * `voiceComposerHandlers` is a pure function of the recorder value, so the whole
 * join runs with no microphone, no `expo-audio`, and no mounted surface: the
 * recorder is a spy that records the order it was called in.
 */

import { describe, expect, it } from 'bun:test';

import { voiceComposerHandlers } from '../lib/voice-composer-handlers';
import type { VoiceRecorderValue } from '../lib/use-voice-recorder';
import { CANCEL_SLIDE_DX, resolveDragIntent, type VoicePhase } from '../lib/voice-recording';
import type { InputComposerProps } from '../components/InputComposer';

/** Every recorder call, in order, as `name` or `name(args)`. */
type CallLog = string[];

function fakeRecorder(
  phase: VoicePhase,
  latched = false,
): { voice: VoiceRecorderValue; calls: CallLog } {
  const calls: CallLog = [];
  const voice: VoiceRecorderValue = {
    phase,
    active: phase !== 'idle',
    elapsed_ms: 0,
    elapsed_label: '0:00',
    intent: 'send',
    cancel_progress: 0,
    latched,
    preview_uri: null,
    error_message: null,
    error_reason: null,
    start: async () => {
      calls.push('start');
    },
    updateDrag: (dx, dy) => {
      calls.push(`updateDrag(${dx},${dy})`);
    },
    finish: async () => {
      calls.push('finish');
    },
    latch: () => {
      calls.push('latch');
    },
    stopForReview: async () => {
      calls.push('stopForReview');
    },
    send: async () => {
      calls.push('send');
    },
    cancel: async () => {
      calls.push('cancel');
    },
    reset: () => {
      calls.push('reset');
    },
  };
  return { voice, calls };
}

describe('voiceComposerHandlers — it fits the composer', () => {
  it('supplies exactly the props InputComposer declares for voice', () => {
    const { voice } = fakeRecorder('idle');
    // A TYPE-LEVEL assertion, and the one that actually prevents the gap this
    // module closes: if the composer renames or re-signs a callback, this stops
    // compiling instead of silently leaving the mic unwired again.
    const props: Required<
      Pick<
        InputComposerProps,
        | 'onVoiceTap'
        | 'onVoicePressIn'
        | 'onVoiceHoldStart'
        | 'onVoiceHoldMove'
        | 'onVoiceHoldEnd'
      >
    > = voiceComposerHandlers(voice);
    expect(typeof props.onVoiceTap).toBe('function');
    expect(typeof props.onVoicePressIn).toBe('function');
    expect(typeof props.onVoiceHoldStart).toBe('function');
    expect(typeof props.onVoiceHoldMove).toBe('function');
    expect(typeof props.onVoiceHoldEnd).toBe('function');
  });
});

describe('voiceComposerHandlers — capture opens on touch-down', () => {
  it('a press at rest starts capture immediately, without waiting for the verdict', () => {
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoicePressIn();
    // THE FIX. If this edge stops starting the recorder, capture falls back to
    // the long-press edge a quarter-second later and every held message loses
    // its opening syllable again.
    expect(calls).toEqual(['start']);
  });

  it('a press landing on a live take, a review clip or an upload opens nothing', () => {
    for (const phase of ['requesting', 'recording', 'review', 'uploading', 'error'] as const) {
      const { voice, calls } = fakeRecorder(phase);
      voiceComposerHandlers(voice).onVoicePressIn();
      expect(calls).toEqual([]);
    }
  });
});

describe('voiceComposerHandlers — tap mode', () => {
  it('a tap latches the take its own touch-down already opened', () => {
    // The realistic sequence: press-in started capture, the finger came off
    // before the hold threshold, and the tap edge now decides its fate.
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoicePressIn();
    const live = fakeRecorder('recording', false);
    voiceComposerHandlers(live.voice).onVoiceTap();
    // Latching is what grows the overlay's stop control. Without it the finger
    // is gone with a live recording and nothing on screen stops it.
    expect(calls).toEqual(['start']);
    expect(live.calls).toEqual(['latch']);
    expect(live.calls).not.toContain('stopForReview');
  });

  it('a tap released while start() is still in flight still latches — no hot mic', () => {
    const { voice, calls } = fakeRecorder('requesting');
    voiceComposerHandlers(voice).onVoiceTap();
    // The recorder defers this until capture is live. Doing nothing here is the
    // race PR #24 closed: the recorder comes up running with no finger down.
    expect(calls).toEqual(['latch']);
    expect(calls).not.toContain('start');
  });

  it('a second tap, once the take is latched, stops for review rather than starting again', () => {
    const { voice, calls } = fakeRecorder('recording', true);
    voiceComposerHandlers(voice).onVoiceTap();
    expect(calls).toEqual(['stopForReview']);
  });

  it('a tap with nothing running at all opens the take — the screen-reader path', () => {
    // A screen reader activates the button through `onPress` alone, with no
    // touch-down behind it, so this edge has to be able to start from rest.
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoiceTap();
    expect(calls).toEqual(['start', 'latch']);
  });

  it('a tap on a clip awaiting review does NOTHING — it cannot destroy an unsent note', () => {
    const { voice, calls } = fakeRecorder('review');
    voiceComposerHandlers(voice).onVoiceTap();
    expect(calls).toEqual([]);
  });

  it('a tap while uploading or in error does nothing — those phases are the overlay’s', () => {
    for (const phase of ['uploading', 'error'] as const) {
      const { voice, calls } = fakeRecorder(phase);
      voiceComposerHandlers(voice).onVoiceTap();
      expect(calls).toEqual([]);
    }
  });
});

describe('voiceComposerHandlers — long-press mode', () => {
  it('a hold at rest starts capture', () => {
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoiceHoldStart();
    expect(calls).toEqual(['start']);
  });

  it('the hold verdict does not restart the take touch-down already opened', () => {
    // The realistic sequence on a device: press-in opened capture, and 250ms
    // later the recogniser calls it a hold. A second `start()` here would be a
    // no-op in the recorder, but the mapping should not be asking for one.
    const { voice, calls } = fakeRecorder('recording');
    voiceComposerHandlers(voice).onVoiceHoldStart();
    expect(calls).toEqual([]);
  });

  it('a hold that begins on a clip awaiting review is refused', () => {
    const { voice, calls } = fakeRecorder('review');
    voiceComposerHandlers(voice).onVoiceHoldStart();
    expect(calls).toEqual([]);
  });

  it('the slide verdict is restated in the recorder’s units, and it agrees', () => {
    const { voice, calls } = fakeRecorder('recording');
    const handlers = voiceComposerHandlers(voice);

    handlers.onVoiceHoldMove({ cancelling: true });
    handlers.onVoiceHoldMove({ cancelling: false });
    expect(calls).toEqual([`updateDrag(${CANCEL_SLIDE_DX},0)`, 'updateDrag(0,0)']);

    // The point of feeding the threshold value itself: the recorder's own
    // arithmetic must reach the SAME conclusion the button already drew.
    expect(resolveDragIntent(CANCEL_SLIDE_DX, 0)).toBe('cancel');
    expect(resolveDragIntent(0, 0)).toBe('send');
  });

  it('releasing over the button sends', () => {
    const { voice, calls } = fakeRecorder('recording');
    voiceComposerHandlers(voice).onVoiceHoldEnd('send');
    expect(calls).toEqual(['finish']);
  });

  it('releasing after sliding away discards, and uploads nothing', () => {
    const { voice, calls } = fakeRecorder('recording');
    voiceComposerHandlers(voice).onVoiceHoldEnd('cancel');
    expect(calls).toEqual(['cancel']);
    expect(calls).not.toContain('finish');
  });
});
