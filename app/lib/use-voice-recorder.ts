/**
 * @neutronai/app — voice-message recorder hook. THE SEAM the chat composer
 * calls to get iMessage-style voice notes.
 *
 * The host component owns the mic button and the pixels; this hook owns
 * everything behind it — the microphone permission, the `expo-audio` recorder
 * lifecycle, the elapsed clock, the long-press slide-to-cancel arithmetic, and
 * the upload/send handoff. A host wires it in three lines:
 *
 * ```tsx
 * const voice = useVoiceRecorder({
 *   base_url: config.base_url,
 *   token: user?.token ?? null,
 *   onSend: async (url) => { await send('', [url]); },
 * });
 * ```
 *
 * and then drives it from the mic button's gesture responder:
 *
 *   BOTH         onPressIn → voice.start()              // touch-down, before
 *                                                       // tap-vs-hold is known
 *   LONG-PRESS   onMove    → voice.updateDrag(dx, dy)   // flips voice.intent
 *                onRelease → voice.finish()             // sends, or discards
 *                                                       // if intent==='cancel'
 *   TAP          onPress   → voice.latch()              // keeps the take the
 *                                                       // press already opened
 *                stop tap  → voice.stopForReview()      // phase → 'review'
 *                then      → voice.send() | voice.cancel()
 *
 * `start()` deliberately sits on touch-down for BOTH modes: the gesture
 * recogniser needs a quarter-second to classify the press, and a microphone that
 * waits for that verdict has already missed the first syllable. Both modes share
 * one recorder; they differ only in which transitions the host drives afterwards.
 * `VoiceRecorderOverlay` renders the standard UI for both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';

import { sendVoiceNote, type VoiceSendFailure } from './voice-send';
import {
  cancelProgress,
  ELAPSED_TICK_MS,
  formatElapsed,
  isSendableDuration,
  resolveDragIntent,
  shouldAutoStop,
  VOICE_RECORDING_OPTIONS,
  type VoiceDragIntent,
  type VoicePhase,
} from './voice-recording';

export interface UseVoiceRecorderInput {
  /** Gateway HTTP base, from `loadAppConfig().base_url`. */
  base_url: string;
  /** Bearer token, from `useAuthSession().user?.token ?? null`. */
  token: string | null;
  /**
   * Called once the clip is uploaded. The host turns this into a chat message
   * exactly the way it does for an image: `await send('', [url])`.
   */
  onSend: (url: string, mime_type: string, duration_ms: number) => Promise<void>;
  /**
   * Called when the owner has permanently denied microphone access (the OS
   * will not prompt again). The host should offer a jump to system settings —
   * this hook deliberately does not reach for `Linking` itself.
   */
  onPermissionBlocked?: () => void;
}

export interface VoiceRecorderValue {
  /** @see VoicePhase */
  phase: VoicePhase;
  /** True for every phase except `idle` — the composer keeps the mic active. */
  active: boolean;
  /** Milliseconds captured so far (or, in `review`, the final length). */
  elapsed_ms: number;
  /** `elapsed_ms` as `M:SS`, ready to render. */
  elapsed_label: string;
  /** What a long-press release would do right now: send, or discard. */
  intent: VoiceDragIntent;
  /** 0..1 through the slide-to-cancel gesture, for a continuous affordance. */
  cancel_progress: number;
  /**
   * True once a TAP (rather than a hold) has latched the recording: the finger
   * is gone, capture continues, and the UI owes the owner a stop control.
   * False for the whole of a long-press, where the release IS the stop.
   */
  latched: boolean;
  /** In `review`, the local clip URI so the host can preview-play it. */
  preview_uri: string | null;
  /** Present in `error`; a short sentence fit to show the owner verbatim. */
  error_message: string | null;
  /** Present in `error`; lets the host distinguish "too short" from a failure. */
  error_reason: VoiceSendFailure | 'permission_denied' | 'recorder_failed' | null;

  /** Begin capture. Requests mic permission on first use. Safe to call twice. */
  start: () => Promise<void>;
  /** Long-press finger tracking. `dx` is LEFTWARD travel in px. */
  updateDrag: (dx: number, dy: number) => void;
  /** Long-press release: sends, or discards when `intent === 'cancel'`. */
  finish: () => Promise<void>;
  /**
   * Convert an in-flight hold into a latched (tap-mode) recording: capture
   * keeps running with no finger down. Called when a press is released too
   * quickly to have been a deliberate hold.
   */
  latch: () => void;
  /** Tap mode: stop capture and hold the clip for review. */
  stopForReview: () => Promise<void>;
  /** Send the held clip (tap mode, after `stopForReview`). */
  send: () => Promise<void>;
  /** Discard from any phase and return to `idle`. */
  cancel: () => Promise<void>;
  /** Clear an `error` back to `idle` (host dismiss / retry affordance). */
  reset: () => void;
}

export function useVoiceRecorder(input: UseVoiceRecorderInput): VoiceRecorderValue {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);

  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsed_ms, setElapsed] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [latched, setLatched] = useState(false);
  const [preview_uri, setPreviewUri] = useState<string | null>(null);
  const [error, setError] = useState<{
    message: string;
    reason: VoiceRecorderValue['error_reason'];
  } | null>(null);

  const started_at = useRef<number | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards a double-`start()` from a host that fires both onPressIn and
  // onLongPress, and stops a release racing an in-flight start.
  const busy = useRef(false);
  const unmounted = useRef(false);
  /**
   * A release that arrived while `start()` was still awaiting the permission
   * check and the native prepare. Without this the finger is already gone by
   * the time capture begins, nobody is left to stop it, and the microphone
   * stays hot until the 10-minute cap — the classic fast-tap leak.
   *
   *   'latch'  the press was a tap; keep capturing hands-free once started
   *   'finish' the press ended before capture began, so there is nothing to
   *            send — stop immediately and discard
   */
  const pending_release = useRef<null | 'latch' | 'finish'>(null);

  // `input` is a fresh object every render; hold the live callbacks in a ref so
  // the returned handlers stay referentially stable and a host can pass them
  // straight to a gesture responder without re-creating it each frame.
  const latest = useRef(input);
  latest.current = input;

  const stopTick = useCallback(() => {
    if (tick.current !== null) {
      clearInterval(tick.current);
      tick.current = null;
    }
  }, []);

  /** Stop the native recorder and return the clip URI + captured length. */
  const stopCapture = useCallback(async (): Promise<{
    uri: string | null;
    duration_ms: number;
  }> => {
    stopTick();
    const began = started_at.current;
    const duration_ms = began === null ? 0 : Date.now() - began;
    started_at.current = null;
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch (err) {
      console.warn('[voice] recorder.stop threw:', err);
    }
    return { uri, duration_ms };
  }, [recorder, stopTick]);

  const toIdle = useCallback(() => {
    setPhase('idle');
    setElapsed(0);
    setDrag({ dx: 0, dy: 0 });
    setLatched(false);
    setPreviewUri(null);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    // Re-entrancy from a host that fires more than one begin-gesture event.
    if (started_at.current !== null) return;
    busy.current = true;
    try {
      setError(null);
      setDrag({ dx: 0, dy: 0 });
      setElapsed(0);
      setLatched(false);
      setPreviewUri(null);
      pending_release.current = null;

      let granted = false;
      try {
        const current = await getRecordingPermissionsAsync();
        granted = current.granted;
        if (!granted && current.canAskAgain) {
          const asked = await requestRecordingPermissionsAsync();
          granted = asked.granted;
          if (!granted && !asked.canAskAgain) latest.current.onPermissionBlocked?.();
        } else if (!granted) {
          latest.current.onPermissionBlocked?.();
        }
      } catch (err) {
        console.warn('[voice] permission check threw:', err);
        granted = false;
      }
      if (unmounted.current) return;
      if (!granted) {
        setPhase('error');
        setError({
          message: 'Microphone access is off. Turn it on to send voice messages.',
          reason: 'permission_denied',
        });
        return;
      }

      // Show the recording UI only once permission is settled, so the first-run
      // OS sheet does not sit on top of a live-looking timer.
      setPhase('requesting');
      try {
        // iOS needs the session put into a recording category, and needs to be
        // allowed to run while the ringer switch is silenced.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (err) {
        console.warn('[voice] failed to start recording:', err);
        if (unmounted.current) return;
        setPhase('error');
        setError({ message: 'Could not start recording.', reason: 'recorder_failed' });
        return;
      }
      if (unmounted.current) {
        // Unmounted mid-start: do not leave the mic hot.
        void recorder.stop().catch(() => undefined);
        return;
      }
      started_at.current = Date.now();
      setPhase('recording');
      stopTick();
      tick.current = setInterval(() => {
        const began = started_at.current;
        if (began === null) return;
        setElapsed(Date.now() - began);
      }, ELAPSED_TICK_MS);

      // The finger left while we were still starting up. Apply what it asked
      // for now that there is finally a recording to apply it to.
      const pending = pending_release.current;
      pending_release.current = null;
      if (pending === 'latch') {
        setLatched(true);
      } else if (pending === 'finish') {
        // The whole press was shorter than the startup latency, so no speech
        // was captured — stop and drop it rather than sending a fragment.
        stopTick();
        started_at.current = null;
        void recorder.stop().catch(() => undefined);
        toIdle();
      }
    } finally {
      busy.current = false;
    }
  }, [recorder, stopTick, toIdle]);

  const updateDrag = useCallback((dx: number, dy: number): void => {
    setDrag({ dx, dy });
  }, []);

  const latch = useCallback((): void => {
    // Released before capture began — remember it, and `start()` will latch as
    // soon as the recorder is live.
    if (busy.current && started_at.current === null) {
      pending_release.current = 'latch';
      return;
    }
    // Only meaningful while capture is actually running; a latch request after
    // the recorder stopped would strand the UI showing a stop button.
    if (started_at.current === null) return;
    // The finger is gone, so any slide-to-cancel offset it left behind must not
    // keep colouring the UI red.
    setDrag({ dx: 0, dy: 0 });
    setLatched(true);
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    // An explicit discard outranks whatever the release was going to do.
    if (busy.current && started_at.current === null) pending_release.current = 'finish';
    if (started_at.current !== null) await stopCapture();
    else stopTick();
    if (unmounted.current) return;
    setError(null);
    toIdle();
  }, [stopCapture, stopTick, toIdle]);

  /** Upload + hand off. Shared by long-press finish and tap-mode send. */
  const deliver = useCallback(
    async (uri: string, duration_ms: number): Promise<void> => {
      setPhase('uploading');
      const outcome = await sendVoiceNote({
        uri,
        duration_ms,
        base_url: latest.current.base_url,
        token: latest.current.token,
      });
      if (unmounted.current) return;
      if (!outcome.ok) {
        // A misfire tap is not an error worth a banner — just fall back to idle.
        if (outcome.reason === 'too_short') {
          toIdle();
          return;
        }
        setPhase('error');
        setError({ message: outcome.message, reason: outcome.reason });
        return;
      }
      try {
        await latest.current.onSend(outcome.url, outcome.mime_type, outcome.duration_ms);
      } catch (err) {
        console.warn('[voice] onSend threw:', err);
      }
      if (unmounted.current) return;
      toIdle();
    },
    [toIdle],
  );

  const finish = useCallback(async (): Promise<void> => {
    if (started_at.current === null) {
      // Released before capture actually began (permission sheet, or a press
      // shorter than the native start). Leave a note so `start()` tears the
      // recorder straight back down instead of leaving the mic hot with no
      // finger on the button.
      if (busy.current) {
        pending_release.current = 'finish';
        return;
      }
      // Nothing captured and nothing starting — just clear any recording UI.
      if (phase === 'recording' || phase === 'requesting') toIdle();
      return;
    }
    const intent = resolveDragIntent(drag.dx, drag.dy);
    const { uri, duration_ms } = await stopCapture();
    if (unmounted.current) return;
    if (intent === 'cancel' || uri === null || !isSendableDuration(duration_ms)) {
      toIdle();
      return;
    }
    await deliver(uri, duration_ms);
  }, [deliver, drag.dx, drag.dy, phase, stopCapture, toIdle]);

  const stopForReview = useCallback(async (): Promise<void> => {
    if (started_at.current === null) return;
    const { uri, duration_ms } = await stopCapture();
    if (unmounted.current) return;
    setElapsed(duration_ms);
    if (uri === null || !isSendableDuration(duration_ms)) {
      toIdle();
      return;
    }
    setPreviewUri(uri);
    setPhase('review');
  }, [stopCapture, toIdle]);

  const send = useCallback(async (): Promise<void> => {
    // Tap mode after `stopForReview`; also tolerates a host calling send()
    // while still recording by stopping first.
    if (started_at.current !== null) {
      const { uri, duration_ms } = await stopCapture();
      if (unmounted.current) return;
      if (uri === null) {
        toIdle();
        return;
      }
      await deliver(uri, duration_ms);
      return;
    }
    const uri = preview_uri;
    if (uri === null) return;
    await deliver(uri, elapsed_ms);
  }, [deliver, elapsed_ms, preview_uri, stopCapture, toIdle]);

  const reset = useCallback((): void => {
    setError(null);
    toIdle();
  }, [toIdle]);

  // Hard cap — auto-stop a runaway recording into the normal send/review path
  // rather than discarding what the owner just said.
  useEffect(() => {
    if (phase !== 'recording' || !shouldAutoStop(elapsed_ms)) return;
    void stopForReview();
  }, [elapsed_ms, phase, stopForReview]);

  // Never leave the microphone hot across an unmount.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (tick.current !== null) clearInterval(tick.current);
      tick.current = null;
      if (started_at.current !== null) {
        started_at.current = null;
        void recorder.stop().catch(() => undefined);
      }
    };
  }, [recorder]);

  const intent = useMemo(() => resolveDragIntent(drag.dx, drag.dy), [drag.dx, drag.dy]);

  return {
    phase,
    active: phase !== 'idle',
    elapsed_ms,
    elapsed_label: formatElapsed(elapsed_ms),
    intent,
    cancel_progress: cancelProgress(drag.dx),
    latched,
    preview_uri,
    error_message: error?.message ?? null,
    error_reason: error?.reason ?? null,
    start,
    updateDrag,
    finish,
    latch,
    stopForReview,
    send,
    cancel,
    reset,
  };
}
