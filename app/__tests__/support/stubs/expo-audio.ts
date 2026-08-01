/**
 * @neutronai/app — harness stub for `expo-audio`.
 *
 * The real package is a native module. Loading it under bun pulls in `expo`'s
 * side-effect entry (`expo/src/Expo.fx.tsx`), which reaches for Metro's
 * `ErrorUtils` global and throws before a single component renders — so without
 * this stub, ANY harness test that mounts the chat surface dies the moment the
 * surface gained a recorder. That is exactly how the wiring change announced
 * itself: `composer-action-swap.test.tsx` went red on an import, not an
 * assertion.
 *
 * DELIBERATELY OBSERVABLE, unlike the inert stubs beside it. The recorder is not
 * a leaf the surface merely holds a reference to — the whole question this stub
 * exists to answer is "did pressing the mic actually reach a recorder?", and an
 * inert stub cannot tell you. So it counts its calls and lets a test drive the
 * two outcomes that change what the owner sees: permission refused, and a clip
 * that records normally.
 *
 * It is NOT a simulation. No audio, no timers, no real elapsed clock — the
 * duration a test wants is the duration it sets.
 *
 * The PLAYBACK half (further down) is observable for the same reason: a voice
 * note that renders a play button but never reaches a player, or whose progress
 * track ignores the position the player reports, looks identical to a working
 * one in any test that only queries the view hierarchy.
 */

/** Everything the harness saw, for assertions. Reset per test. */
export interface VoiceHarnessState {
  permission_checks: number;
  permission_requests: number;
  prepare_calls: number;
  record_calls: number;
  stop_calls: number;
  audio_mode_calls: number;
  /** True between `record()` and `stop()` — a hot mic is a leak if it outlives a test. */
  recording: boolean;
  /**
   * `Date.now()` when the microphone actually opened, and when it closed.
   *
   * Here so the head of a recording can be MEASURED rather than reasoned about:
   * subtract the moment the finger landed and you have the audio a held message
   * loses before capture begins. That number was the defect
   * (`voice-capture-starts-on-touch-down.test.tsx`), so it is observable.
   */
  record_at_ms: number | null;
  stop_at_ms: number | null;
}

interface VoiceHarnessConfig {
  /** Whether the OS grants microphone access. */
  granted: boolean;
  /** Whether the OS would prompt again after a refusal (false = permanently denied). */
  can_ask_again: boolean;
  /** The clip URI `recorder.uri` reports once stopped. */
  uri: string | null;
}

const DEFAULT_CONFIG: VoiceHarnessConfig = {
  granted: true,
  can_ask_again: true,
  uri: 'file:///harness/voice-note.m4a',
};

let config: VoiceHarnessConfig = { ...DEFAULT_CONFIG };
let state: VoiceHarnessState = freshState();

function freshState(): VoiceHarnessState {
  return {
    permission_checks: 0,
    permission_requests: 0,
    prepare_calls: 0,
    record_calls: 0,
    stop_calls: 0,
    audio_mode_calls: 0,
    recording: false,
    record_at_ms: null,
    stop_at_ms: null,
  };
}

/** What the harness recorded. */
export function harnessAudioState(): VoiceHarnessState {
  return { ...state };
}

/** Drive a different OS outcome (denied permission, a different clip URI). */
export function setHarnessAudio(next: Partial<VoiceHarnessConfig>): void {
  config = { ...config, ...next };
}

/** Back to "permission granted, a clip records fine", with no players handed
 *  out. Call in `beforeEach`. */
export function resetHarnessAudio(): void {
  config = { ...DEFAULT_CONFIG };
  state = freshState();
  resetHarnessPlayback();
}

interface HarnessRecorder {
  uri: string | null;
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
}

const recorder: HarnessRecorder = {
  get uri(): string | null {
    return config.uri;
  },
  prepareToRecordAsync: async (): Promise<void> => {
    state.prepare_calls += 1;
  },
  record: (): void => {
    state.record_calls += 1;
    state.recording = true;
    state.record_at_ms = Date.now();
  },
  stop: async (): Promise<void> => {
    state.stop_calls += 1;
    if (state.recording) state.stop_at_ms = Date.now();
    state.recording = false;
  },
};

export function useAudioRecorder(): HarnessRecorder {
  return recorder;
}

export async function getRecordingPermissionsAsync(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  state.permission_checks += 1;
  return { granted: config.granted, canAskAgain: config.can_ask_again };
}

export async function requestRecordingPermissionsAsync(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
}> {
  state.permission_requests += 1;
  return { granted: config.granted, canAskAgain: config.can_ask_again };
}

export async function setAudioModeAsync(): Promise<void> {
  state.audio_mode_calls += 1;
}

/* ── Playback ──────────────────────────────────────────────────────────────
 * ALSO deliberately observable, and for the same reason the recorder is: the
 * claim a voice-note bubble has to keep proving is "tapping play reaches a
 * player, and the position it reports moves the pixels". An inert player answers
 * neither. So each `useAudioPlayer` call gets its OWN stub player with its own
 * counters and its own status, and a test drives that status directly — there is
 * no audio, no clock and no decoding anywhere in here.
 *
 * It is NOT a simulation. `play()` does not make time pass; a test that wants
 * the clip to be three seconds in says so with `setHarnessPlayback`.
 */

export interface HarnessPlaybackState {
  /** The source the component handed the player (its `uri`, or null). */
  source_uri: string | null;
  /**
   * The headers that rode along with the source. A bearer-authed clip that
   * arrives here WITHOUT one is a clip the device will 401 on, and the bubble
   * would show an eternal spinner with no way to tell why — so it is observable.
   */
  source_headers: Record<string, string> | null;
  play_calls: number;
  pause_calls: number;
  /** Every position seeked to, in seconds, in order. */
  seeks: number[];
  /** True once the component's unmount released this player. */
  released: boolean;
  playing: boolean;
  current_time: number;
  duration: number;
  did_just_finish: boolean;
  is_loaded: boolean;
}

type Listener = () => void;

class HarnessPlayer {
  readonly state: HarnessPlaybackState;
  private readonly listeners = new Set<Listener>();

  constructor(source_uri: string | null, source_headers: Record<string, string> | null) {
    this.state = {
      source_uri,
      source_headers,
      play_calls: 0,
      pause_calls: 0,
      seeks: [],
      released: false,
      playing: false,
      current_time: 0,
      duration: 0,
      did_just_finish: false,
      is_loaded: false,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  play(): void {
    this.state.play_calls += 1;
  }

  pause(): void {
    this.state.pause_calls += 1;
  }

  async seekTo(seconds: number): Promise<void> {
    this.state.seeks.push(seconds);
  }

  replace(source: unknown): void {
    this.state.source_uri = readSourceUri(source);
    this.state.source_headers = readSourceHeaders(source);
  }
}

let players: HarnessPlayer[] = [];

function readSourceUri(source: unknown): string | null {
  if (typeof source === 'string') return source;
  if (source !== null && typeof source === 'object' && 'uri' in source) {
    const uri = (source as { uri?: unknown }).uri;
    return typeof uri === 'string' ? uri : null;
  }
  return null;
}

function readSourceHeaders(source: unknown): Record<string, string> | null {
  if (source === null || typeof source !== 'object') return null;
  const headers = (source as { headers?: unknown }).headers;
  return headers !== null && typeof headers === 'object'
    ? (headers as Record<string, string>)
    : null;
}

/** Every player the harness handed out this test, in mount order. */
export function harnessPlayers(): HarnessPlaybackState[] {
  return players.map((p) => p.state);
}

/** Back to zero players. Call in `beforeEach` alongside `resetHarnessAudio`. */
export function resetHarnessPlayback(): void {
  players = [];
}

/**
 * Drive what the Nth player reports, then re-render every subscriber — the
 * harness's stand-in for "three seconds of audio just came out of the speaker".
 */
export function setHarnessPlayback(index: number, next: Partial<HarnessPlaybackState>): void {
  const player = players[index];
  if (player === undefined) throw new Error(`no harness player at index ${index}`);
  Object.assign(player.state, next);
  player.emit();
}

interface HookRuntime {
  useState: <T>(initial: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useMemo: <T>(fn: () => T, deps?: unknown[]) => T;
}

/**
 * React is imported lazily so this stub stays loadable in the non-harness unit
 * tests that only want the recorder half (they never render anything).
 */
function react(): HookRuntime {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react') as HookRuntime;
}

export function useAudioPlayer(source?: unknown): HarnessPlayer {
  const { useMemo, useEffect } = react();
  const uri = readSourceUri(source ?? null);
  const headers = readSourceHeaders(source ?? null);
  // Keyed on the uri exactly like the real hook (which keys a releasing shared
  // object on `JSON.stringify(source)`), so a source swap really does hand the
  // component a NEW player rather than mutating the old one.
  const player = useMemo(() => {
    const created = new HarnessPlayer(uri, headers);
    players.push(created);
    return created;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);
  useEffect(
    () => () => {
      player.state.released = true;
    },
    [player],
  );
  return player;
}

export function useAudioPlayerStatus(player: HarnessPlayer): {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
  isLoaded: boolean;
} {
  const { useState, useEffect } = react();
  const [, bump] = useState(0);
  useEffect(() => player.subscribe(() => bump((n) => n + 1)), [player]);
  return {
    playing: player.state.playing,
    currentTime: player.state.current_time,
    duration: player.state.duration,
    didJustFinish: player.state.did_just_finish,
    isLoaded: player.state.is_loaded,
  };
}

/** Present so the real module's shape is matched; the recorder ignores it. */
export const RecordingPresets = {
  HIGH_QUALITY: {},
  LOW_QUALITY: {},
} as const;
