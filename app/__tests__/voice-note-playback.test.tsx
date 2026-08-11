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

/**
 * THE SECOND DEFECT, closed a day after the first. The player shipped drawing
 * its own filled, rounded panel, so a voice note appeared as a box nested inside
 * the message bubble — which already has an edge and a radius. The owner: *"The
 * voice note playback UX is kinda ugly. Its a box in a box, the play button is a
 * really small tap target... can you make it look like imessage?"*
 *
 * These cases pin the ARRANGEMENT that fixed it, which is the thing a future
 * restyle breaks first. They are DOM and arithmetic facts under the
 * react-native-web harness, not pixel facts, so they are honestly testable —
 * whether it LOOKS like iMessage is a screenshot's job and a device's job, and
 * the PR body says which of those actually happened.
 */
describe('the player is the bubble content, not a panel inside it', () => {
  it('draws no container of its own — no fill, no radius, no border', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 6 });
    await screen.settle();

    const root = screen.byTestId('voice-note-player');
    expect(root).not.toBeNull();
    // react-native-web compiles static styles to atomic classes named after the
    // property, so "this node paints no surface" is directly observable. The
    // BUBBLE around it in the real transcript carries exactly these — that is
    // the point: one container, and it is not this one.
    const painted = (root?.className ?? '')
      .split(/\s+/)
      .filter((c) => /^r-(backgroundColor|borderRadius|borderWidth)-/.test(c));
    expect(painted).toEqual([]);
    // Dynamic styles land inline, so a fill added that way has to be caught too.
    expect(root?.style.backgroundColor ?? '').toBe('');
    expect(root?.style.borderRadius ?? '').toBe('');

    screen.unmount();
  });

  it('paints every mark in the colours of the bubble it was given', async () => {
    const { userBubbleTone, agentBubbleTone } = await import('../lib/chat-bubble-metrics');
    const { DARK_THEME } = await import('../lib/theme');
    const USER_BUBBLE_TONE = userBubbleTone(DARK_THEME);
    const AGENT_BUBBLE_TONE = agentBubbleTone(DARK_THEME);

    // The owner's own bubble is a light accent capsule, so the disc is DARK with
    // a light triangle knocked out of it. Getting this from a fixed palette
    // entry instead is what forced the old version to draw its own panel.
    const mine = await mountScreen(
      createElement(AuthedAttachmentImage, { url: CLIP_URL, auth: AUTH, tone: USER_BUBBLE_TONE }),
    );
    await mine.settle();
    expect(rgb(mine.byTestId('voice-note-toggle')?.style.backgroundColor)).toBe(
      USER_BUBBLE_TONE.ink,
    );
    expect(rgb(mine.byTestId('voice-note-play-mark')?.style.borderLeftColor)).toBe(
      USER_BUBBLE_TONE.ground,
    );
    mine.unmount();

    // The agent's bubble is a dark surface, so the same two colours swap.
    const theirs = await mountScreen(
      createElement(AuthedAttachmentImage, { url: CLIP_URL, auth: AUTH, tone: AGENT_BUBBLE_TONE }),
    );
    await theirs.settle();
    expect(rgb(theirs.byTestId('voice-note-toggle')?.style.backgroundColor)).toBe(
      AGENT_BUBBLE_TONE.ink,
    );
    expect(rgb(theirs.byTestId('voice-note-play-mark')?.style.borderLeftColor)).toBe(
      AGENT_BUBBLE_TONE.ground,
    );
    theirs.unmount();
  });

  it('draws the play mark instead of typing it, so its size is not a font decision', async () => {
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 6 });
    await screen.settle();

    // A `▶` in a <Text> takes its size, weight and vertical position from the
    // system font — which is how a 13pt mark ended up adrift in a 32pt circle
    // and got read as "a really small tap target".
    expect(screen.byTestId('voice-note-play-mark')).not.toBeNull();
    expect(screen.text()).not.toContain('▶');

    await screen.press('Play 0:06 voice message');
    await reportStatus(0, { playing: true, current_time: 1 });
    await screen.settle();
    expect(screen.byTestId('voice-note-pause-mark')).not.toBeNull();
    expect(screen.text()).not.toContain('⏸');

    screen.unmount();
  });

  it('plays ONCE — a finished clip is PAUSED, not merely rewound', async () => {
    // THE REGRESSION THIS PINS. `didJustFinish` does not leave the player
    // paused; it is still in a playing state. Rewinding to 0 without pausing
    // therefore hands it a fresh position to play FROM, and the clip loops
    // forever. That shipped, and the owner reported it within the hour: "the
    // playback of the voice note loops. can you have it just play once".
    //
    // Asserting the seek alone would NOT catch it — the buggy build seeks too.
    // The pause is the whole fix, so the pause is what is asserted.
    const screen = await mountScreen(bubble(CLIP_URL));
    await reportStatus(0, { is_loaded: true, duration: 7.4 });
    await screen.settle();
    await screen.press('Play 0:07 voice message');
    expect(harnessPlayers()[0]?.play_calls).toBe(1);

    const pauses_before = harnessPlayers()[0]?.pause_calls ?? 0;
    await reportStatus(0, { did_just_finish: true, playing: false, current_time: 7.4 });
    await screen.settle();

    const player = harnessPlayers()[0];
    expect(player?.pause_calls ?? 0).toBeGreaterThan(pauses_before);
    // Still rewound, so the next tap replays from the top rather than sitting
    // dead at the end — the behaviour the original handler was reaching for.
    expect(player?.seeks).toContain(0);

    screen.unmount();
  });

  it('reaches 44pt even though it paints the reference 30', async () => {
    const { CONTROL_DIAMETER_PT, CONTROL_HIT_SLOP_PT, TAP_TARGET_PT } = await import(
      '../components/VoiceNoteBubble'
    );
    // Apple's disc measures ~29pt; the platform's comfortable target is 44. The
    // two are reconciled with slop rather than by inflating the paint, which
    // would push the bubble taller than the reference.
    expect(CONTROL_DIAMETER_PT).toBe(30);
    expect(TAP_TARGET_PT).toBe(44);
    expect(CONTROL_DIAMETER_PT + 2 * CONTROL_HIT_SLOP_PT).toBe(TAP_TARGET_PT);
    // NOT verified here: that React Native honours the slop. `hitSlop` leaves no
    // trace in the DOM, so it is a device fact. This pins the arithmetic only.
  });
});

/** `rgba(10, 10, 10, 1.00)` as react-native-web writes it → `#0a0a0a`. */
function rgb(value: string | undefined): string | undefined {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value ?? '');
  if (m === null) return value;
  return `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}`;
}
