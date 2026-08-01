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
 * MEASURED, NOT ASSERTED. Every case below reports milliseconds — the gap
 * between the finger landing and the microphone opening, and the gap between how
 * long the control was held and how much audio came back. Both are printed, so a
 * regression shows up as a number rather than as a red assertion with no scale.
 * The gesture is the real react-native-web `Pressable` with the real 250 ms
 * classification delay, and the recorder, composer and chat surface are all the
 * real ones. Only the microphone itself is a stub, and it timestamps `record()`
 * / `stop()` precisely so this file can do arithmetic.
 *
 * THE CLOCK IS LOGICAL, NOT WALL. It used to be `Date.now()`, and that made
 * every number here a statement about the machine: the same correct code
 * measured a 54 ms lead-in on a quiet box and 326 ms on a loaded one, so the
 * budget below held or missed depending on what else was running (ISSUES #436).
 * `support/harness-clock.ts` replaces that with one timeline the test moves by
 * hand — the recogniser's 250 ms deadline is queued on it rather than scheduled
 * on the OS, so "the finger has been down 250 ms" is now something this file
 * asserts rather than something it hopes the scheduler delivers. The interval
 * being measured is exactly as real as it was; the machine's speed is no longer
 * part of the reading. The wall clock is gone from this file entirely.
 *
 * WHAT IT STILL CANNOT SEE: real audio. A stub cannot prove the first syllable
 * is audible, only that the recorder was running when it was spoken. It also
 * does not model how long a real permission check or native prepare takes —
 * those are stubs that return instantly, so the wall-clock figure this replaced
 * was never device latency, only harness overhead.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  advanceHarnessClock,
  harnessClockNow,
  installHarnessClock,
  resetHarnessClock,
  uninstallHarnessClock,
} from './support/harness-clock';
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
 * Sized against the verdict, not against the machine: anything at or above
 * `LONG_PRESS_MS` means capture went back to starting on the long-press edge,
 * which is the regression this file exists to catch, and the headroom below it
 * covers any delay a future change might legitimately put in front of `record()`
 * without giving the recogniser time to rule first.
 *
 * What actually sits under it today is 50 ms, and it is not harness overhead —
 * react-native-web's press responder defers `onPressIn` by its own
 * `DEFAULT_PRESS_DELAY_MS` of 50, then schedules the long-press verdict 250 ms
 * after THAT. So the interaction really runs press-in@50 / verdict@300, and the
 * old wall-clock reading of ~54 ms was that fixed delay plus a few milliseconds
 * of work, not the permission check it was assumed to be. The logical clock is
 * what made the two separable.
 */
const LEAD_IN_BUDGET_MS = 120;

beforeAll(() => {
  installNativeHarness();
  installHarnessClock();
});

afterAll(() => {
  // Process-global, both of them: Bun runs ~100 test FILES per process, and a
  // frozen `Date.now()` left installed here lands in whatever runs next.
  uninstallHarnessClock();
  resetHarnessGlobals();
});

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
  resetHarnessAudio();
  resetHarnessClock();
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
 * Hold the mic for `hold_ms` of LOGICAL time and report what the microphone did.
 *
 * `mountScreen.press()` cannot express this: it fires down, up and click in one
 * act(), so the press is over before the recogniser has classified it and
 * `onLongPress` never runs. A hold has to be three separate events with time
 * between them — and that time is the harness clock's, so the recogniser's
 * 250 ms deadline lands where this function puts it rather than where the OS
 * scheduler happened to get to it.
 *
 * It also watches the two instants the file compares, on the SAME timeline: when
 * the microphone opened, and when the recogniser delivered its hold verdict. The
 * verdict announces itself through the control's own accessibility label — the
 * composer relabels the mic the moment `onLongPress` puts it in holding state —
 * so it is observed the way a thumb would notice it, not inferred from a
 * constant.
 */
async function holdMic(
  screen: { host: HTMLElement; settle: () => Promise<void> },
  hold_ms: number,
  options: { drift_px?: number } = {},
): Promise<{
  down_at: number;
  up_at: number;
  held_ms: number;
  /** Logical ms from touch-down to the recogniser calling this a hold; null if it never did. */
  verdict_at_ms: number | null;
}> {
  const mic = control(screen.host, 'Record voice message');
  let verdict_at_ms: number | null = null;

  /**
   * Run something React must see, let its consequences settle, then note the
   * verdict if it just landed. Edge-triggered, so it records the FIRST instant
   * the label changed rather than the last.
   */
  const step = async (run: () => void): Promise<void> => {
    await act(async () => {
      run();
    });
    await screen.settle();
    if (verdict_at_ms === null && mic.getAttribute('aria-label') !== 'Record voice message') {
      verdict_at_ms = harnessClockNow();
    }
  };

  const down_at = Date.now();
  await step(() => {
    mic.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
  });

  await advanceHarnessClock(hold_ms, step);

  const drift = options.drift_px ?? 0;
  if (drift !== 0) {
    // Two moves, because the composer takes the FIRST one as the origin the
    // travel is measured from — exactly as a finger produces them. `pageX` is
    // set on the DOM event itself: React hands that object through as
    // `nativeEvent`, which is where the composer reads the coordinate.
    for (const x of [0, drift]) {
      await step(() => {
        const ev = new Event('touchmove', { bubbles: true });
        Object.defineProperty(ev, 'pageX', { value: x });
        mic.dispatchEvent(ev);
      });
    }
  }
  const up_at = Date.now();
  await step(() => {
    mic.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    mic.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return { down_at, up_at, held_ms: up_at - down_at, verdict_at_ms };
}

describe('a held voice message keeps its opening', () => {
  it('opens the microphone on touch-down, not on the long-press verdict', async () => {
    const { screen } = await mountChat();
    try {
      const { down_at, verdict_at_ms } = await holdMic(screen, 900);

      const audio = harnessAudioState();
      expect(audio.record_calls).toBe(1);
      const lead_in_ms = (audio.record_at_ms ?? 0) - down_at;

      // The measurement, printed so a regression reads as a number.
      console.log(
        `[voice] lead-in from touch-down to microphone open: ${lead_in_ms}ms ` +
          `(budget ${LEAD_IN_BUDGET_MS}ms, hold verdict at ${verdict_at_ms ?? '—'}ms)`,
      );

      // THE ORDERING GUARD, stated without reference to any constant: the
      // recogniser really did rule during this hold, and the microphone was
      // already open when it did. Both instants are read off the same logical
      // timeline, so no amount of machine load can reorder them.
      expect(verdict_at_ms).not.toBeNull();
      expect(lead_in_ms).toBeLessThan(verdict_at_ms ?? 0);

      // THE MUTATION GUARD. Move `start()` back onto the long-press edge and
      // this lands on the verdict, above the budget, and fails.
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
