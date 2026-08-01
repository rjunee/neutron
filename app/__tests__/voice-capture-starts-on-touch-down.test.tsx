/**
 * @neutronai/app — a held voice message must not lose its opening.
 *
 * THE DEFECT. Capture used to begin on `onLongPress`, and the mic carries
 * `delayLongPress={250}` — so for the first quarter-second of every hold the
 * gesture recogniser was deciding "tap or hold?" while the microphone was still
 * shut. People start talking as they press, not after, so a held message opened
 * mid-syllable. Tap mode never had the problem, which is what made it look like
 * a recorder bug rather than a gesture bug.
 *
 * THE FIX these cases pin: capture starts on TOUCH-DOWN and the recogniser's
 * verdict decides what happens TO the recording, not whether it exists.
 *
 * MEASURED, NOT ASSERTED. Every case below reports real milliseconds — the gap
 * between the finger landing and the microphone opening, and the gap between how
 * long the control was held and how much audio came back. Both are printed, so a
 * regression shows up as a number rather than as a red assertion with no scale.
 * The clock is real (`Date.now()`), the gesture is the real react-native-web
 * `Pressable` with the real 250 ms classification delay — the harness reproduces
 * `in@54 / long@305 / out@906` for a held press — and the recorder, composer and
 * chat surface are all the real ones. Only the microphone itself is a stub, and
 * it timestamps `record()` / `stop()` precisely so this file can do arithmetic.
 *
 * WHAT IT STILL CANNOT SEE: real audio. A stub cannot prove the first syllable
 * is audible, only that the recorder was running when it was spoken.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { act } = await import('react');
const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { harnessAudioState, resetHarnessAudio, setHarnessAudio } = await import(
  './support/stubs/expo-audio'
);

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

/**
 * The classification delay on the mic control. Not imported — it is private to
 * the composer — but it is the size of the hole this file exists to close, so a
 * budget below it is what makes these cases meaningful rather than decorative.
 */
const LONG_PRESS_MS = 250;

/**
 * The most audio a touch-down is allowed to lose before capture opens.
 *
 * Generous on purpose: it covers the permission check, the audio-session switch
 * and the native prepare, all of which are awaited between the finger landing
 * and `record()`. What it does NOT cover is waiting for the tap-versus-hold
 * verdict, which is the regression it is sized to catch — anything at or above
 * `LONG_PRESS_MS` means capture went back to starting on the long-press edge.
 */
const LEAD_IN_BUDGET_MS = 120;

beforeAll(() => {
  installNativeHarness();
});

afterAll(() => {
  resetHarnessGlobals();
});

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
  resetHarnessAudio();
});

async function mountChat() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId: 'harness-project' }),
    ),
  );
  const socket = FakeChatSocket.current();
  await screen.settle();
  socket.onopen?.();
  await screen.settle();
  return { screen, socket };
}

function control(host: HTMLElement, label: string): HTMLElement {
  const el = Array.from(host.querySelectorAll('*')).find(
    (node) => node.getAttribute('aria-label') === label,
  ) as HTMLElement | undefined;
  if (el === undefined) throw new Error(`no control labelled "${label}" is in the tree`);
  return el;
}

/**
 * Hold the mic for `hold_ms` of REAL time and report what the microphone did.
 *
 * `mountScreen.press()` cannot express this: it fires down, up and click in one
 * act(), so the press is over before the recogniser has classified it and
 * `onLongPress` never runs. A hold has to be three separate events with real
 * wall-clock between them, which is also the only way the numbers mean anything.
 */
async function holdMic(
  screen: { host: HTMLElement; settle: () => Promise<void> },
  hold_ms: number,
  options: { drift_px?: number } = {},
): Promise<{ down_at: number; up_at: number; held_ms: number }> {
  const mic = control(screen.host, 'Record voice message');
  const down_at = Date.now();
  await act(async () => {
    mic.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, hold_ms));
  });
  const drift = options.drift_px ?? 0;
  if (drift !== 0) {
    // Two moves, because the composer takes the FIRST one as the origin the
    // travel is measured from — exactly as a finger produces them. `pageX` is
    // set on the DOM event itself: React hands that object through as
    // `nativeEvent`, which is where the composer reads the coordinate.
    for (const x of [0, drift]) {
      await act(async () => {
        const ev = new Event('touchmove', { bubbles: true });
        Object.defineProperty(ev, 'pageX', { value: x });
        mic.dispatchEvent(ev);
      });
    }
  }
  const up_at = Date.now();
  await act(async () => {
    mic.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    mic.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await screen.settle();
  return { down_at, up_at, held_ms: up_at - down_at };
}

describe('a held voice message keeps its opening', () => {
  it('opens the microphone on touch-down, not on the long-press verdict', async () => {
    const { screen } = await mountChat();
    try {
      const { down_at } = await holdMic(screen, 900);

      const audio = harnessAudioState();
      expect(audio.record_calls).toBe(1);
      const lead_in_ms = (audio.record_at_ms ?? 0) - down_at;

      // The measurement, printed so a regression reads as a number.
      console.log(
        `[voice] lead-in from touch-down to microphone open: ${lead_in_ms}ms ` +
          `(budget ${LEAD_IN_BUDGET_MS}ms, long-press verdict at ${LONG_PRESS_MS}ms)`,
      );

      // THE MUTATION GUARD. Move `start()` back onto the long-press edge and
      // this lands at ~250ms, above the budget, and fails.
      expect(lead_in_ms).toBeLessThan(LEAD_IN_BUDGET_MS);
      expect(lead_in_ms).toBeLessThan(LONG_PRESS_MS);
    } finally {
      screen.unmount();
    }
  });

  it('captures very nearly the whole time the control was held', async () => {
    const { screen } = await mountChat();
    try {
      const { held_ms } = await holdMic(screen, 900);

      const audio = harnessAudioState();
      expect(audio.record_at_ms).not.toBeNull();
      expect(audio.stop_at_ms).not.toBeNull();
      const captured_ms = (audio.stop_at_ms ?? 0) - (audio.record_at_ms ?? 0);
      const lost_ms = held_ms - captured_ms;

      console.log(
        `[voice] held ${held_ms}ms → captured ${captured_ms}ms → lost ${lost_ms}ms`,
      );

      // Held audio, not a fraction of it. The old wiring lost a quarter-second
      // of every take; the whole point of the fix is that this number is small.
      expect(lost_ms).toBeLessThan(LEAD_IN_BUDGET_MS);
      expect(captured_ms).toBeGreaterThan(held_ms - LONG_PRESS_MS);
    } finally {
      screen.unmount();
    }
  });

  it('a hold still ends as a hold — the release sends rather than latching', async () => {
    const { screen } = await mountChat();
    try {
      await holdMic(screen, 900);
      await screen.settle();

      // Starting earlier must not turn a hold into tap-mode. The release IS the
      // stop: the recorder is closed and there is no ■ control left behind.
      expect(harnessAudioState().recording).toBe(false);
      expect(screen.host.textContent ?? '').not.toContain('tap ■ to review');
    } finally {
      screen.unmount();
    }
  });
});

describe('starting earlier never leaves the microphone hot', () => {
  it('a press abandoned off the button discards the take it opened', async () => {
    const { screen } = await mountChat();
    try {
      // Down, drift away, release — WITHOUT ever crossing the long-press
      // threshold. `onPress` does not fire for a press that left the control, so
      // if the release edge did not resolve this, the recording touch-down
      // opened would run on with nothing on screen able to stop it.
      const { down_at } = await holdMic(screen, 80, { drift_px: 400 });

      const audio = harnessAudioState();
      expect(audio.record_at_ms).not.toBeNull();
      expect((audio.record_at_ms ?? 0) - down_at).toBeLessThan(LEAD_IN_BUDGET_MS);
      // Opened, then closed again. Both halves matter: capture really did start
      // early, and the abandoned gesture really did release the microphone.
      expect(audio.recording).toBe(false);
      expect(audio.stop_calls).toBeGreaterThanOrEqual(1);
    } finally {
      screen.unmount();
    }
  });

  it('a refused microphone leaves no recording UI behind, even though the press starts it', async () => {
    setHarnessAudio({ granted: false, can_ask_again: false });
    const { screen } = await mountChat();
    try {
      await holdMic(screen, 900);

      // Touch-down now asks for permission EARLIER in the interaction than the
      // long-press edge did. A refusal has to land as a refusal, not as a
      // half-open recorder.
      expect(screen.host.textContent ?? '').toContain('Microphone access is off');
      expect(harnessAudioState().record_calls).toBe(0);
      expect(harnessAudioState().recording).toBe(false);
    } finally {
      screen.unmount();
    }
  });

  it('a tap that opened its take on touch-down is latched, so a stop control exists', async () => {
    const { screen } = await mountChat();
    try {
      // A real tap: down and up inside the classification window, so the press
      // never becomes a hold and the finger is gone while capture is live.
      await holdMic(screen, 60);

      expect(harnessAudioState().recording).toBe(true);
      // Latched — the overlay owes the owner a way to stop what is running.
      expect(control(screen.host, 'Stop recording')).toBeDefined();
    } finally {
      screen.unmount();
    }
  });
});
