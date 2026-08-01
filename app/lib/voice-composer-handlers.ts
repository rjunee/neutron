/**
 * @neutronai/app — THE JOIN between the composer's mic button and the recorder.
 *
 * Two halves shipped without a seam between them. `InputComposer` owns the
 * BUTTON: it draws the mic in the field's trailing slot and reports what the
 * finger did through four callbacks (`onVoiceTap`, `onVoiceHoldStart`,
 * `onVoiceHoldMove`, `onVoiceHoldEnd`). `useVoiceRecorder` owns the RECORDER:
 * permission, capture, the elapsed clock, upload. Neither knows about the
 * other, and until this module existed nothing translated between them — the
 * button reported gestures to nobody and answered every press with "Voice
 * messages are not available yet."
 *
 * This is that translation, kept as a PURE function of the recorder value so
 * the mapping can be asserted call-for-call without a device, a microphone, or
 * a mounted chat surface. The chat surface's only job is to call it and spread
 * the result onto the composer.
 *
 * CAPTURE STARTS ON TOUCH-DOWN. It used to start on the long-press edge, a
 * quarter of a second later, which is how a held message lost its opening
 * syllable: the recogniser spends that time deciding tap-versus-hold while the
 * owner is already talking. Nothing about opening the microphone depends on that
 * verdict, so `press in` starts the recorder and the verdict now decides what
 * happens TO the recording rather than whether it exists.
 *
 * That inverts the tap edge. By the time a tap is reported, capture is already
 * running, so the tap does not START anything — it decides whether this press
 * OPENED the take (latch it, and the audio caught before the release is a head
 * start) or ENDED it (the second tap of tap-mode). `latched` is what tells the
 * two apart: it is false for exactly as long as the recording is the one this
 * press just opened.
 *
 * THE MAPPING, and why each edge is the one it is:
 *
 *   press in (idle)   start()             — touch-down; capture begins here and
 *                                           nowhere else
 *   press in (else)   nothing             — a press landing on a live recording,
 *                                           a clip awaiting review or an upload
 *                                           must not open a second capture over
 *                                           the top of it
 *   tap (recording,   latch()             — this press opened the take and the
 *    not latched)                          finger has gone; latching is what
 *                                           grows the overlay's ■ stop control,
 *                                           without which nothing on screen
 *                                           stops the recording
 *   tap (requesting)  latch()             — same intent, arriving while start()
 *                                           is still awaiting permission; the
 *                                           recorder defers it until capture is
 *                                           live. Skipping it is the hot-mic
 *                                           race: the recorder comes up with no
 *                                           finger down and no stop control
 *   tap (latched)     stopForReview()     — the second tap of tap-mode: capture
 *                                           ends and the clip is held for
 *                                           play / discard / send
 *   tap (idle)        start() + latch()   — no touch-down reached us at all, so
 *                                           this is a screen reader activating
 *                                           the button; open the take here
 *   tap (otherwise)   nothing             — review, uploading and error are the
 *                                           overlay's phases and it owns their
 *                                           controls; starting a fresh capture
 *                                           from here would silently destroy a
 *                                           clip the owner has not sent yet
 *   hold start        nothing to do       — capture is already running; the edge
 *                                           only claims the press for hold
 *                                           semantics. It still calls start(),
 *                                           which is idempotent, so a host that
 *                                           reports no touch-down is not left
 *                                           without a recorder
 *   hold move         updateDrag(…)       — the composer already applied its own
 *                                           slide threshold, so its verdict is
 *                                           restated in the recorder's units
 *                                           and the overlay's glyph, hint and
 *                                           cancel progress agree with the
 *                                           button's fill colour
 *   hold end 'send'   finish()            — uploads and hands the URL back
 *   hold end 'cancel' cancel()            — discards; nothing is uploaded. The
 *                                           composer also routes an ABANDONED
 *                                           press here (touch-down, drift off
 *                                           the button, release without ever
 *                                           becoming a hold), because that press
 *                                           opened a recording too
 */

import { CANCEL_SLIDE_DX } from './voice-recording';
// TYPE-ONLY, and it has to stay that way: `use-voice-recorder` imports
// `expo-audio`, a native module with no presence in a plain unit-test process.
// `import type` is erased outright, so this module — and the tests that assert
// the mapping — load with nothing native in the graph.
import type { VoiceRecorderValue } from './use-voice-recorder';

/** Exactly the voice-note half of `InputComposerProps`. */
export interface VoiceComposerHandlers {
  onVoiceTap: () => void;
  onVoicePressIn: () => void;
  onVoiceHoldStart: () => void;
  onVoiceHoldMove: (state: { cancelling: boolean }) => void;
  onVoiceHoldEnd: (intent: 'send' | 'cancel') => void;
}

/**
 * Build the composer's four voice callbacks from a recorder value.
 *
 * Every handler is synchronous and returns void, because that is the shape the
 * composer's gesture responder calls. The recorder's promises are deliberately
 * floated: a gesture callback that awaited would hold the responder open, and
 * every failure the recorder can have is already surfaced through its own
 * `error` phase rather than a rejection.
 */
export function voiceComposerHandlers(voice: VoiceRecorderValue): VoiceComposerHandlers {
  return {
    onVoicePressIn: () => {
      // A press landing on a clip awaiting review, an upload, or a recording
      // that is already running must not open a second capture over the top of
      // it. Only rest starts one.
      if (voice.phase !== 'idle') return;
      void voice.start();
    },

    onVoiceTap: () => {
      if (voice.phase === 'idle') {
        // Touch-down never reached us — a screen reader activates the button
        // through `onPress` alone — so this edge opens the take after all.
        void voice.start();
        // Called straight after `start()` and NOT awaited on purpose — `latch()`
        // handles arriving while start is still in flight (it defers until the
        // recorder is live). Awaiting here would leave a window in which the
        // recording is running un-latched and the overlay shows no way to stop it.
        voice.latch();
        return;
      }
      if (voice.phase === 'requesting' || voice.phase === 'recording') {
        // `latched` is false for exactly as long as the live recording is the
        // one THIS press opened on touch-down. So an un-latched recording means
        // the finger has just come off the press that started it: latch, and the
        // audio captured before the release is kept as a head start.
        //
        // Latching during 'requesting' is not optional. Capture is mid-start
        // with the finger already gone; without the latch the recorder comes up
        // running, un-latched, with no stop control anywhere — the hot mic.
        if (!voice.latched) {
          voice.latch();
          return;
        }
        // Latched and live: this is the second tap of tap-mode.
        if (voice.phase === 'recording') void voice.stopForReview();
        return;
      }
      // 'review', 'uploading' and 'error' are the overlay's phases; it owns
      // their controls and a tap here must not destroy an unsent clip.
    },

    onVoiceHoldStart: () => {
      // Capture is already running — touch-down started it — so this is a no-op
      // in the ordinary case. It stays a `start()` rather than nothing because
      // the call is idempotent (the recorder refuses a second one while a take
      // is live) and it keeps the hold path whole for any host that reports a
      // long press without a touch-down.
      //
      // A hold that begins on top of a clip awaiting review would throw that clip
      // away without asking. The overlay's ✕ is how you get rid of one.
      if (voice.phase !== 'idle') return;
      void voice.start();
    },

    onVoiceHoldMove: ({ cancelling }) => {
      // The composer reports a BOOLEAN verdict (it applied its own threshold in
      // its own points); the recorder reasons in pixels of leftward travel. Feed
      // it the threshold value itself, so `intent` flips exactly when the button
      // says it flipped and `cancel_progress` reads a full 1 rather than a
      // fraction that never arrives.
      voice.updateDrag(cancelling ? CANCEL_SLIDE_DX : 0, 0);
    },

    onVoiceHoldEnd: (intent) => {
      if (intent === 'cancel') {
        void voice.cancel();
        return;
      }
      void voice.finish();
    },
  };
}
