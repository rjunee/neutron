/**
 * @neutronai/app — `VoiceMicButton` gesture disambiguation.
 *
 * One button serves both iMessage recording modes, and which one happened is
 * decided on release from how long the press lasted. These cases drive the
 * real handlers against a stub `VoiceRecorderValue` and assert the calls the
 * button makes — a hold ends in `finish()`, a tap ends in `latch()`, and a
 * slide reports LEFTWARD travel as positive so `resolveDragIntent` sees it.
 *
 * Convention (mirrors `authed-attachment-file-open.test.tsx`): the app's
 * bun:test runtime ships no React Native, so `react-native` is module-mocked.
 * `react` is deliberately NOT module-mocked — bun mocks are process-global and
 * a react mock corrupts every later file in the same process. Instead a
 * minimal PERSISTENT hook dispatcher is installed on react's dispatcher slot
 * for the synchronous duration of each render, so `useRef` keeps its identity
 * across the press-in / press-out pair the way it does on device.
 */

import { describe, expect, it, mock } from 'bun:test';
import * as React from 'react';

mock.module('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  Animated: { Value: class {}, timing: () => ({ start: () => {} }) },
  Easing: { inOut: () => undefined, quad: undefined },
}));

const { VoiceMicButton, LONG_PRESS_MS } = await import('../components/VoiceMicButton');
const { CANCEL_SLIDE_DX } = await import('../lib/voice-recording');
import type { VoiceRecorderValue } from '../lib/use-voice-recorder';

const reactInternals = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * A hook dispatcher whose `useRef` slots PERSIST between renders — the button
 * stores the press timestamp and touch origin in refs, so a dispatcher that
 * handed back a fresh object each render would make every press look like the
 * first one.
 */
function makeDispatcher(): { dispatcher: object; reset: () => void } {
  const slots: { current: unknown }[] = [];
  let index = 0;
  const dispatcher = {
    useState: (initial: unknown) => [
      typeof initial === 'function' ? (initial as () => unknown)() : initial,
      () => {},
    ],
    useEffect: () => {},
    useRef: (v: unknown) => {
      const slot = slots[index] ?? { current: v };
      slots[index] = slot;
      index += 1;
      return slot;
    },
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useContext: () => undefined,
  };
  return { dispatcher, reset: () => (index = 0) };
}

interface Recorded {
  calls: string[];
  drags: { dx: number; dy: number }[];
}

function stubVoice(overrides: Partial<VoiceRecorderValue> = {}): {
  voice: VoiceRecorderValue;
  recorded: Recorded;
} {
  const recorded: Recorded = { calls: [], drags: [] };
  const voice: VoiceRecorderValue = {
    phase: 'recording',
    active: true,
    elapsed_ms: 3_000,
    elapsed_label: '0:03',
    intent: 'send',
    cancel_progress: 0,
    latched: false,
    preview_uri: null,
    error_message: null,
    error_reason: null,
    start: async () => {
      recorded.calls.push('start');
    },
    updateDrag: (dx, dy) => {
      recorded.calls.push('updateDrag');
      recorded.drags.push({ dx, dy });
    },
    finish: async () => {
      recorded.calls.push('finish');
    },
    latch: () => {
      recorded.calls.push('latch');
    },
    stopForReview: async () => {
      recorded.calls.push('stopForReview');
    },
    send: async () => {
      recorded.calls.push('send');
    },
    cancel: async () => {
      recorded.calls.push('cancel');
    },
    reset: () => {
      recorded.calls.push('reset');
    },
    ...overrides,
  };
  return { voice, recorded };
}

interface Handlers {
  onPressIn: (e: { nativeEvent: { pageX: number; pageY: number } }) => void;
  onPressOut: () => void;
  onTouchMove: (e: { nativeEvent: { pageX: number; pageY: number } }) => void;
  glyph: string;
}

/** Render the button under the persistent dispatcher and pull its handlers. */
function render(voice: VoiceRecorderValue, ctx: ReturnType<typeof makeDispatcher>): Handlers {
  const prev = reactInternals.H;
  reactInternals.H = ctx.dispatcher;
  ctx.reset();
  try {
    const el = VoiceMicButton({ voice }) as unknown as {
      props: Record<string, unknown> & { children: { props: { children: string } } };
    };
    return {
      onPressIn: el.props.onPressIn as Handlers['onPressIn'],
      onPressOut: el.props.onPressOut as Handlers['onPressOut'],
      onTouchMove: el.props.onTouchMove as Handlers['onTouchMove'],
      glyph: el.props.children.props.children,
    };
  } finally {
    reactInternals.H = prev;
  }
}

const touch = (pageX: number, pageY: number) => ({ nativeEvent: { pageX, pageY } });

/** Advance the clock the button reads via Date.now(), without real waiting. */
function withClock<T>(times: number[], run: () => T): T {
  const real = Date.now;
  let i = 0;
  Date.now = () => times[Math.min(i++, times.length - 1)] ?? 0;
  try {
    return run();
  } finally {
    Date.now = real;
  }
}

describe('VoiceMicButton — press-in always starts capture', () => {
  it('starts recording on press-in so the first syllable is not clipped', () => {
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice();
    const h = render(voice, ctx);
    withClock([1_000], () => h.onPressIn(touch(300, 700)));
    expect(recorded.calls).toEqual(['start']);
  });
});

describe('VoiceMicButton — hold vs tap on release', () => {
  it('a HOLD ends in finish() — release over the button sends', () => {
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice();
    const h = render(voice, ctx);
    withClock([1_000, 1_000 + LONG_PRESS_MS + 50], () => {
      h.onPressIn(touch(300, 700));
      h.onPressOut();
    });
    expect(recorded.calls).toEqual(['start', 'finish']);
    expect(recorded.calls).not.toContain('latch');
  });

  it('a TAP latches instead, leaving capture running with no finger down', () => {
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice();
    const h = render(voice, ctx);
    withClock([1_000, 1_000 + LONG_PRESS_MS - 100], () => {
      h.onPressIn(touch(300, 700));
      h.onPressOut();
    });
    expect(recorded.calls).toEqual(['start', 'latch']);
    expect(recorded.calls).not.toContain('finish');
  });

  it('a release on an ALREADY-latched recording does not stop it', () => {
    // Otherwise the press that taps the stop button would also end the take.
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice({ latched: true });
    const h = render(voice, ctx);
    withClock([1_000, 9_000], () => {
      h.onPressIn(touch(300, 700));
      h.onPressOut();
    });
    expect(recorded.calls).toEqual(['start']);
  });
});

describe('VoiceMicButton — slide to cancel', () => {
  it('reports LEFTWARD travel as positive dx, past the cancel threshold', () => {
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice();
    const h = render(voice, ctx);
    withClock([1_000], () => h.onPressIn(touch(300, 700)));
    h.onTouchMove(touch(300 - (CANCEL_SLIDE_DX + 10), 704));

    expect(recorded.drags).toHaveLength(1);
    expect(recorded.drags[0]?.dx).toBe(CANCEL_SLIDE_DX + 10);
    expect(recorded.drags[0]?.dy).toBe(4);
  });

  it('ignores finger movement once the recording is latched', () => {
    const ctx = makeDispatcher();
    const { voice, recorded } = stubVoice({ latched: true });
    const h = render(voice, ctx);
    withClock([1_000], () => h.onPressIn(touch(300, 700)));
    h.onTouchMove(touch(100, 700));
    expect(recorded.drags).toHaveLength(0);
  });
});

describe('VoiceMicButton — the glyph tracks what a release would do', () => {
  it('is a mic at rest, a send arrow while held, and ✕ past the threshold', () => {
    const ctx = makeDispatcher();
    expect(render(stubVoice({ phase: 'idle', active: false }).voice, ctx).glyph).toBe('🎙');
    expect(render(stubVoice({ phase: 'recording' }).voice, ctx).glyph).toBe('➤');
    expect(render(stubVoice({ phase: 'recording', intent: 'cancel' }).voice, ctx).glyph).toBe(
      '✕',
    );
  });

  it('keeps the send arrow when latched, whatever stale drag remains', () => {
    const ctx = makeDispatcher();
    const latched = stubVoice({ phase: 'recording', latched: true, intent: 'cancel' }).voice;
    expect(render(latched, ctx).glyph).toBe('➤');
  });
});
