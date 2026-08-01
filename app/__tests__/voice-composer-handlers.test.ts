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

function fakeRecorder(phase: VoicePhase): { voice: VoiceRecorderValue; calls: CallLog } {
  const calls: CallLog = [];
  const voice: VoiceRecorderValue = {
    phase,
    active: phase !== 'idle',
    elapsed_ms: 0,
    elapsed_label: '0:00',
    intent: 'send',
    cancel_progress: 0,
    latched: false,
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
        'onVoiceTap' | 'onVoiceHoldStart' | 'onVoiceHoldMove' | 'onVoiceHoldEnd'
      >
    > = voiceComposerHandlers(voice);
    expect(typeof props.onVoiceTap).toBe('function');
    expect(typeof props.onVoiceHoldStart).toBe('function');
    expect(typeof props.onVoiceHoldMove).toBe('function');
    expect(typeof props.onVoiceHoldEnd).toBe('function');
  });
});

describe('voiceComposerHandlers — tap mode', () => {
  it('a tap at rest starts capture AND latches it, in that order', () => {
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoiceTap();
    // Latching second is what grows the overlay's stop control. Without it the
    // finger is gone with a live recording and nothing on screen stops it.
    expect(calls).toEqual(['start', 'latch']);
  });

  it('a second tap while recording stops for review rather than starting again', () => {
    const { voice, calls } = fakeRecorder('recording');
    voiceComposerHandlers(voice).onVoiceTap();
    expect(calls).toEqual(['stopForReview']);
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

  it('a tap while the permission sheet is up does not start a second capture', () => {
    const { voice, calls } = fakeRecorder('requesting');
    voiceComposerHandlers(voice).onVoiceTap();
    expect(calls).toEqual([]);
  });
});

describe('voiceComposerHandlers — long-press mode', () => {
  it('a hold at rest starts capture', () => {
    const { voice, calls } = fakeRecorder('idle');
    voiceComposerHandlers(voice).onVoiceHoldStart();
    expect(calls).toEqual(['start']);
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
