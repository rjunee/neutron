/**
 * @neutronai/app — `useVoiceRecorder`: a release that lands MID-START.
 *
 * Starting capture is asynchronous — a permission check, an audio-session
 * switch, then the native prepare — and a thumb can easily come off the mic
 * before all of that finishes. If the hook only handled releases that arrive
 * after capture is live, the finger would already be gone by the time the
 * recorder started and nothing would be left to stop it: the microphone stays
 * hot until the ten-minute cap, with no UI suggesting it is on.
 *
 * These cases hold that window closed. They run under the device harness
 * (real React, real effects) and drive the hook through a probe component,
 * with `expo-audio` replaced by a recorder whose `prepareToRecordAsync` hangs
 * on a promise the test resolves by hand — so "the release happened while
 * start() was still in flight" is deterministic rather than a timing hope.
 */

import { afterAll, describe, expect, it } from 'bun:test';

import { installNativeHarness } from './support/native-harness';
import {
  harnessAudioState,
  resetHarnessAudio,
  setHarnessRecorderPrepare,
} from './support/stubs/expo-audio';

installNativeHarness();

// ── Freeze the harness recorder mid-prepare ──────────────────────────────────

/** Resolved by the test to let `prepareToRecordAsync` return. */
let release_prepare: (() => void) | null = null;

function resetRecorder(): void {
  resetHarnessAudio();
  release_prepare = null;
  setHarnessRecorderPrepare(() =>
    new Promise<void>((resolve) => {
      release_prepare = resolve;
    }));
}

afterAll(() => {
  setHarnessRecorderPrepare(null);
});

const { act } = await import('react');
const { createElement } = await import('react');
const { mountScreen } = await import('./support/mount');
const { useVoiceRecorder } = await import('../lib/use-voice-recorder');
import type { VoiceRecorderValue } from '../lib/use-voice-recorder';

/** Mounts the real hook and hands each render's value back to the test. */
function mountProbe(sink: { value: VoiceRecorderValue | null }): Promise<{
  unmount: () => void;
  settle: () => Promise<void>;
}> {
  function Probe(): null {
    sink.value = useVoiceRecorder({
      base_url: 'http://gateway.example.com',
      token: 'tok',
      onSend: async () => undefined,
    });
    return null;
  }
  return mountScreen(createElement(Probe));
}

describe('useVoiceRecorder — release arrives while start() is still in flight', () => {
  it('a TAP mid-start latches once capture is live, instead of being dropped', async () => {
    resetRecorder();
    const sink: { value: VoiceRecorderValue | null } = { value: null };
    const screen = await mountProbe(sink);
    try {
      // Press in. `start()` parks inside prepareToRecordAsync.
      await act(async () => {
        void sink.value?.start();
      });
      expect(harnessAudioState().prepare_calls).toBe(1);
      expect(harnessAudioState().record_calls).toBe(0);

      // Thumb lifts BEFORE capture began — this is the whole race.
      await act(async () => {
        sink.value?.latch();
      });

      // Now the native prepare returns and recording actually starts.
      await act(async () => {
        release_prepare?.();
        await Promise.resolve();
      });
      await screen.settle();

      expect(harnessAudioState().record_calls).toBe(1);
      // The tap's intent survived the race: still capturing, now hands-free.
      expect(sink.value?.latched).toBe(true);
      expect(sink.value?.phase).toBe('recording');
      expect(harnessAudioState().recording).toBe(true);
    } finally {
      screen.unmount();
    }
  });

  it('a HOLD released mid-start tears the recorder back down — no hot mic', async () => {
    resetRecorder();
    const sink: { value: VoiceRecorderValue | null } = { value: null };
    const screen = await mountProbe(sink);
    try {
      await act(async () => {
        void sink.value?.start();
      });
      await act(async () => {
        void sink.value?.finish();
      });
      await act(async () => {
        release_prepare?.();
        await Promise.resolve();
      });
      await screen.settle();

      // Capture did begin (the native call was already committed), so the ONLY
      // acceptable outcome is that it was stopped again immediately.
      expect(harnessAudioState().stop_calls).toBeGreaterThanOrEqual(1);
      expect(harnessAudioState().recording).toBe(false);
      expect(sink.value?.phase).toBe('idle');
      expect(sink.value?.active).toBe(false);
    } finally {
      screen.unmount();
    }
  });

  it('cancel() mid-start also leaves the microphone off', async () => {
    resetRecorder();
    const sink: { value: VoiceRecorderValue | null } = { value: null };
    const screen = await mountProbe(sink);
    try {
      await act(async () => {
        void sink.value?.start();
      });
      await act(async () => {
        void sink.value?.cancel();
      });
      await act(async () => {
        release_prepare?.();
        await Promise.resolve();
      });
      await screen.settle();

      expect(harnessAudioState().recording).toBe(false);
      expect(sink.value?.phase).toBe('idle');
    } finally {
      screen.unmount();
    }
  });

  it('unmounting mid-recording never leaves the microphone hot', async () => {
    resetRecorder();
    const sink: { value: VoiceRecorderValue | null } = { value: null };
    const screen = await mountProbe(sink);
    await act(async () => {
      void sink.value?.start();
    });
    await act(async () => {
      release_prepare?.();
      await Promise.resolve();
    });
    await screen.settle();
    expect(harnessAudioState().recording).toBe(true);

    screen.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(harnessAudioState().recording).toBe(false);
  });
});
