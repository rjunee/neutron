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
 * THE MAPPING, and why each edge is the one it is:
 *
 *   tap (idle)        start() + latch()   — the finger is already gone, so
 *                                           nothing else will ever stop this
 *                                           recording; latching is what grows
 *                                           the overlay's ■ stop control
 *   tap (recording)   stopForReview()     — the second tap of tap-mode: capture
 *                                           ends and the clip is held for
 *                                           play / discard / send
 *   tap (otherwise)   nothing             — review, uploading and error are the
 *                                           overlay's phases and it owns their
 *                                           controls; starting a fresh capture
 *                                           from here would silently destroy a
 *                                           clip the owner has not sent yet
 *   hold start        start()             — long-press mode; the release is the
 *                                           stop
 *   hold move         updateDrag(…)       — the composer already applied its own
 *                                           slide threshold, so its verdict is
 *                                           restated in the recorder's units
 *                                           and the overlay's glyph, hint and
 *                                           cancel progress agree with the
 *                                           button's fill colour
 *   hold end 'send'   finish()            — uploads and hands the URL back
 *   hold end 'cancel' cancel()            — discards; nothing is uploaded
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
    onVoiceTap: () => {
      if (voice.phase === 'idle') {
        void voice.start();
        // Called straight after `start()` and NOT awaited on purpose — `latch()`
        // handles arriving while start is still in flight (it defers until the
        // recorder is live). Awaiting here would leave a window in which the
        // recording is running un-latched and the overlay shows no way to stop it.
        voice.latch();
        return;
      }
      if (voice.phase === 'recording') {
        void voice.stopForReview();
      }
      // 'requesting' deliberately falls through: capture has not begun, so there
      // is nothing to stop, and the OS permission sheet is what the owner is
      // looking at anyway.
    },

    onVoiceHoldStart: () => {
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
