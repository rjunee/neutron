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

/** Back to "permission granted, a clip records fine". Call in `beforeEach`. */
export function resetHarnessAudio(): void {
  config = { ...DEFAULT_CONFIG };
  state = freshState();
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
  },
  stop: async (): Promise<void> => {
    state.stop_calls += 1;
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

/** Preview playback — inert. Nothing in the harness can hear anything. */
export function useAudioPlayer(): {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => Promise<void>;
} {
  return {
    play: () => undefined,
    pause: () => undefined,
    seekTo: async () => undefined,
  };
}

export function useAudioPlayerStatus(): {
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
} {
  return { playing: false, currentTime: 0, duration: 0, didJustFinish: false };
}

/** Present so the real module's shape is matched; the recorder ignores it. */
export const RecordingPresets = {
  HIGH_QUALITY: {},
  LOW_QUALITY: {},
} as const;
