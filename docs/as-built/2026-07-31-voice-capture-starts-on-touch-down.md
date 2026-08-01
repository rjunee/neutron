## 2026-07-31 — a held voice message no longer loses its opening

Branch `fix/voice-capture-on-press-in`. `app/components/InputComposer.tsx`,
`app/lib/voice-composer-handlers.ts`, `app/lib/use-voice-recorder.ts` (docs only),
`app/__tests__/voice-capture-starts-on-touch-down.test.tsx` (new).

**The defect was in the gesture, not the recorder.** PR #34 wired capture to
`onVoiceHoldStart`, which the composer fires from the mic's `onLongPress`, and the
mic carries `delayLongPress={250}` (`InputComposer.tsx`). So for the first quarter
of a second of every hold the recogniser was deciding "tap or hold?" while the
microphone was still shut. Nobody waits for that verdict before speaking — people
start talking as they press — so a held message opened mid-syllable. Tap mode was
unaffected, which is exactly why it read as a recorder bug.

**Measured, not inferred.** The prior "~250 ms" figure came from reading the
constant. The harness reproduces the real gesture — the real react-native-web
`Pressable`, the real Pressability classification delay (`in@54 / long@305 /
out@906` for a held press), a real `Date.now()` clock, the real composer, recorder
hook and chat surface, with only the microphone stubbed — and the stub now
timestamps `record()` and `stop()` so the head of a take is arithmetic rather than
argument:

| | held | captured | lost |
|---|---|---|---|
| before (start on `onLongPress`) | 904 ms | 599 ms | **305 ms** |
| after (start on `onPressIn`) | 905 ms | 853 ms | **52 ms** |

The residual 52 ms is the permission check, the audio-session switch and the
native prepare — work that has to happen before the microphone can open. It is not
a gesture delay, and there is nothing left to remove without lying about when
capture began.

**The fix is a reordering, not a tuning.** Audio capture and gesture recognition
were serialised for no reason: the recogniser needs 250 ms to decide and the
microphone does not depend on the decision. `InputComposer` gained a fifth voice
callback, `onVoicePressIn`, fired from the button's `onPressIn`; the verdict now
decides what happens TO the recording rather than whether it exists. A hold keeps
what touch-down already captured. A tap `latch()`es it — the early audio is a head
start, and latching is what grows the overlay's ■ stop control now that the finger
is gone. `onVoiceHoldStart` became a no-op in the ordinary case (it still calls the
idempotent `start()`, so a host that reports a long press without a touch-down is
not left without a recorder).

**Lowering `delayLongPress` was rejected.** It trades one broken thing for
another — deliberate taps start reading as holds — and it never reaches zero loss,
because the delay is only ever an upper bound on how long the recogniser waits.
The constant is now named `VOICE_LONG_PRESS_MS` with that reasoning attached, so
the next reader does not reach for it as a latency budget.

**Starting earlier creates a new hot-mic obligation, and it is discharged
structurally.** More paths now hold a recording nobody asked for. The sharp one:
`onPress` does NOT fire for a press that left the button, so a short press that
drifted away and released would have left capture running with nothing on screen
able to stop it. The release edge therefore resolves a short press itself rather
than waiting for `onPress` — and swallows the `onPress` that normally follows it,
via a flag cleared at the start of every press so an edge that never arrives cannot
leak into the next gesture. The resulting invariant: **every touch-down that opened
a capture reaches a terminal edge at `onPressOut`** — hold-end, cancel (drifted
past the composer's existing cancel threshold), or latch, which always comes with a
visible stop control. None of the three leaves a hot mic. `onPress` survives as the
screen-reader path, where the button is activated with no touch behind it at all.

**Permission moved earlier in the interaction** — the OS sheet can now appear on
touch-down rather than 250 ms in. A refusal still lands as a refusal: `start()`
sets the `error` phase before ever calling `record()`, so the UI shows "Microphone
access is off" with zero `record` calls and nothing running. Asserted.

**`MIN_RECORDING_MS` (700 ms) is strictly better off.** Every take is now ~250 ms
longer for the same gesture, so fewer real messages fall under the floor; a
genuine misfire is still a misfire and still dropped silently.

**Verification.** `app/__tests__/voice-capture-starts-on-touch-down.test.tsx` is
the new file, and it MUTATION-TESTED: reverting the early start (making
`onVoicePressIn` a no-op) moves the measured lead-in from 57 ms to 303 ms and
fails three of its six cases, including the two that report the numbers above. The
hot-mic race file from PR #24 (`voice-recorder-release-race.test.tsx`) is unchanged
and green, and the new file extends the guarantee to the early-start paths: an
abandoned press, and a tap that releases while `start()` is still in flight.
Also re-run green: `voice-composer-handlers.test.ts` (updated for the new mapping),
`voice-message-end-to-end.test.tsx`, `composer-action-swap.test.tsx`,
`input-composer-no-multiple.test.ts`.

**NOT covered.** No physical device and no real audio. The harness proves the
recorder was running when the syllable was spoken; it cannot prove the syllable is
audible in the file, and it runs react-native-web's Pressability rather than
Hermes + the native responder system. The numbers above are harness milliseconds,
honestly labelled — a device check with real speech is still the only thing that
closes that gap.
