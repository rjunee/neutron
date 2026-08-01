/**
 * @neutronai/app — a sent voice note must be PLAYABLE, not a filename.
 *
 * THE DEFECT. A voice message arrived in the transcript as `🎵 <storage hash>`,
 * truncated. No play button, no length, no progress — the clip was unlistenable
 * from the app that had just recorded it. The attachment renderer already
 * DETECTED audio and picked the 🎵 glyph; only the rendering stopped short of a
 * control.
 *
 * WHY THESE ASSERTIONS AND NOT "IT RENDERS". A node in the view hierarchy is not
 * a working player — that exact confusion produced a false bug report the night
 * voice messages shipped. So every claim here is end-of-chain: the control is
 * pressed through the same accessibility label a thumb reaches for, and what is
 * asserted afterwards is what the PLAYER was told to do and what the progress
 * track then paints. The four failure modes this kind of component dies of —
 * two clips sounding at once, a session held after the row is gone, a bearer
 * that never reaches the player, and a dead control on a clip that cannot load —
 * each get their own case.
 *
 * WHAT IT STILL CANNOT SEE, and why a device check is not optional: real audio,
 * real decoding, the iOS audio session, and whether anything is audible. Those
 * are verified on a phone (see the PR body); the harness boundary is documented
 * in `support/native-harness.ts`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { mountScreen } = await import('./support/mount');
const { AuthedAttachmentImage } = await import('../components/AuthedAttachmentImage');
const { harnessPlayers, resetHarnessAudio, setHarnessPlayback } = await import(
  './support/stubs/expo-audio'
);
const { __resetVoicePlaybackForTests, activeVoicePlayback } = await import('../lib/voice-playback');

/** A content-addressed clip URL of the shape the gateway hands back. Synthetic. */
const CLIP_HASH = 'a1b2c3d4'.repeat(8);
const CLIP_URL = `/api/app/upload/harness-owner/${CLIP_HASH}.m4a`;
const OTHER_URL = `/api/app/upload/harness-owner/${'b2c3d4e5'.repeat(8)}.m4a`;
const AUTH = { base_url: 'https://harness.example.test', token: 'harness-token' };
const RESOLVED_CLIP = `${AUTH.base_url}${CLIP_URL}`;

/** The bubble, mounted the way the transcript mounts it. */
function bubble(url: string) {
  return createElement(AuthedAttachmentImage, { url, auth: AUTH });
}

beforeEach(() => {
  resetHarnessAudio();
  __resetVoicePlaybackForTests();
  setHarnessPlatform('android');
});

afterAll(() => {
  resetHarnessGlobals();
});

/** Report a status change from the native player, inside React's act window. */
async function reportStatus(
  index: number,
  next: Parameters<typeof setHarnessPlayback>[1],
): Promise<void> {
  await act(async () => {
    setHarnessPlayback(index, next);
  });
}

describe('a sent voice note renders as a playback control', () => {
  it('shows a play control and the clip length — never the storage hash', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    // The clip's metadata lands a moment after the source does.
    await reportStatus(0, { is_loaded: true, duration: 7.4 });
    await screen.settle();

    expect(screen.byTestId('voice-note-player')).not.toBeNull();
    // The crux of the defect: the bubble no longer prints the attachment's
    // filename at the owner, it prints how long the message is.
    expect(screen.text()).toContain('0:07');
    expect(screen.text()).not.toContain(CLIP_HASH);
    // …and it is reachable as a control, by the label a screen reader announces.
    await screen.press('Play 0:07 voice message');
    expect(harnessPlayers()[0]?.play_calls).toBe(1);

    screen.unmount();
  });

  it('says the length is unknown rather than claiming 0:00 before the clip loads', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    // No status yet — duration 0, nothing loaded. `0:00` here would read as an
    // empty recording; the honest answer is that nobody knows yet.
    expect(screen.text()).toContain('--:--');
    expect(screen.text()).not.toContain('0:00');
    screen.unmount();
  });

  it('hands the player the resolved URL WITH the bearer, so the authed GET does not 401', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    const player = harnessPlayers()[0];
    expect(player?.source_uri).toBe(RESOLVED_CLIP);
    expect(player?.source_headers).toEqual({ Authorization: `Bearer ${AUTH.token}` });
    screen.unmount();
  });
});

describe('the progress track follows playback', () => {
  it('advances with the position the player reports, and the readout counts up', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 10 });
    await screen.settle();

    // At rest: an empty track and the clip's total length.
    expect(widthPercent(screen.byTestId('voice-note-progress'))).toBe(0);
    expect(screen.text()).toContain('0:10');

    await screen.press('Play 0:10 voice message');
    await reportStatus(0, { playing: true, current_time: 3.5 });
    await screen.settle();

    // The track reflects POSITION — this is what separates a control from a
    // decorative waveform.
    expect(widthPercent(screen.byTestId('voice-note-progress'))).toBe(35);
    expect(screen.text()).toContain('0:03');
    // And the control now offers the opposite action.
    expect(screen.byTestId('voice-note-toggle')?.getAttribute('aria-label')).toBe(
      'Pause 0:10 voice message',
    );

    screen.unmount();
  });

  it('pausing stops the player and gives the speaker back', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 10 });
    await screen.press('Play 0:10 voice message');
    await reportStatus(0, { playing: true, current_time: 1 });
    await screen.press('Pause 0:10 voice message');

    expect(harnessPlayers()[0]?.pause_calls).toBe(1);
    expect(activeVoicePlayback()).toBeNull();
    screen.unmount();
  });

  it('rewinds and releases the speaker when the clip finishes', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 4 });
    await screen.press('Play 0:04 voice message');
    await reportStatus(0, { playing: false, current_time: 4, did_just_finish: true });
    await screen.settle();

    // Seeked back to the top, so the next tap replays instead of sitting dead
    // at the end…
    expect(harnessPlayers()[0]?.seeks).toEqual([0]);
    // …and the speaker is free for the next clip.
    expect(activeVoicePlayback()).toBeNull();
    screen.unmount();
  });
});

describe('one clip at a time', () => {
  it('starting a second voice note pauses the first', async () => {
    const screen = await mountScreen(
      createElement('div' as never, null, bubble(CLIP_URL), bubble(OTHER_URL)),
    );
    await reportStatus(0, { is_loaded: true, duration: 6 });
    await reportStatus(1, { is_loaded: true, duration: 9 });
    await screen.settle();

    await screen.press('Play 0:06 voice message');
    await reportStatus(0, { playing: true, current_time: 1 });
    expect(harnessPlayers()[0]?.play_calls).toBe(1);
    expect(harnessPlayers()[0]?.pause_calls).toBe(0);

    await screen.press('Play 0:09 voice message');

    // The first clip was silenced by the second one claiming the speaker —
    // two voice notes sounding at once is the bug users notice immediately.
    expect(harnessPlayers()[0]?.pause_calls).toBe(1);
    expect(harnessPlayers()[1]?.play_calls).toBe(1);

    screen.unmount();
  });
});

describe('the audio session does not outlive the bubble', () => {
  it('unmounting a playing clip pauses it and releases the player', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 6 });
    await screen.press('Play 0:06 voice message');
    await reportStatus(0, { playing: true, current_time: 2 });

    act(() => {
      screen.unmount();
    });

    // A chat list recycles rows; a player left sounding (or holding a session)
    // after its row is gone is the mirror of the hot-microphone leak.
    expect(harnessPlayers()[0]?.pause_calls).toBeGreaterThanOrEqual(1);
    expect(harnessPlayers()[0]?.released).toBe(true);
    expect(activeVoicePlayback()).toBeNull();
  });
});

describe('a clip that cannot load says so', () => {
  it('surfaces the failure and offers a retry — never a control that does nothing', async () => {
    setHarnessPlatform('web');
    const restore = failingFetch();
    try {
      const screen = await mountScreen(bubble(CLIP_URL));
      await screen.settle();

      // On web the bytes must be fetched with the bearer (an <audio> element
      // carries no headers). A refused fetch is a clip that will never play,
      // and the owner is told so instead of tapping a silent button forever.
      expect(screen.text()).toContain('Voice message unavailable');
      expect(restore.calls).toBe(1);

      await screen.press('Voice message unavailable, tap to retry');
      await screen.settle();
      expect(restore.calls).toBe(2);

      screen.unmount();
    } finally {
      restore.undo();
    }
  });
});

/** The rendered width of the progress fill, as a whole percent. */
function widthPercent(el: HTMLElement | null): number {
  const raw = el?.style.width ?? '';
  const match = /^([\d.]+)%$/.exec(raw);
  return match === null ? Number.NaN : Math.round(Number(match[1]));
}

/** Replace `fetch` with one that always refuses, counting attempts. */
function failingFetch(): { calls: number; undo: () => void } {
  const real = globalThis.fetch;
  const record = {
    calls: 0,
    undo: () => {
      globalThis.fetch = real;
    },
  };
  globalThis.fetch = (async () => {
    record.calls += 1;
    throw new Error('refused');
  }) as unknown as typeof globalThis.fetch;
  return record;
}
