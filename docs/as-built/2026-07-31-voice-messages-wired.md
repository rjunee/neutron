## 2026-07-31 — the voice recorder is WIRED: mic → recorder → upload → message

### What was actually wrong

Voice messages had shipped as five modules and zero reachable feature. PR #24 landed
`app/lib/voice-recording.ts`, `app/lib/voice-send.ts`, `app/lib/use-voice-recorder.ts`,
`app/components/VoiceMicButton.tsx` and `app/components/VoiceRecorderOverlay.tsx`, all with
passing unit tests. PR #26 landed local Whisper so a keyless self-hoster still gets a
transcript. The gateway had accepted `audio/mp4` on `/api/app/upload` since M2 task 5.

Nothing called any of it. `ChatSyncSurface` — the one chat screen — rendered
`<InputComposer>` with none of its four voice callbacks, so `handleVoiceTap` /
`handleVoiceHoldStart` took the `undefined` branch and put up `VOICE_UNAVAILABLE_NOTICE`
("Voice messages are not available yet."). `useVoiceRecorder`, `VoiceMicButton` and
`VoiceRecorderOverlay` appeared nowhere outside their own files and their own tests.

The composer's own honesty test even pinned the gap in place: `composer-action-swap.test.tsx`
asserted that pressing the mic SHOWS the not-available notice. Every gate in the repo was
green over a feature the owner could not use. This is the same shape as the persona-gen
incident — built, tested, never wired — and the reason "done" here means served and
reachable, not merged.

### What changed

**`app/lib/voice-composer-handlers.ts` (new).** The join, as a pure function of the recorder
value. The composer speaks gestures (`onVoiceTap` / `onVoiceHoldStart` / `onVoiceHoldMove` /
`onVoiceHoldEnd`); the recorder speaks lifecycle (`start` / `latch` / `updateDrag` / `finish` /
`cancel` / `stopForReview`). Keeping the translation pure is what makes the wiring assertable
call-for-call without a device.

Three edges are decisions, not plumbing:

- **A tap latches immediately after `start()`, without awaiting it.** The finger is already
  gone on a tap, so nothing else will ever stop that recording; latching is what grows the
  overlay's ■ stop control. `latch()` already tolerates arriving mid-start, and awaiting would
  leave a window with a live mic and no visible way to stop it.
- **A tap during `review` / `uploading` / `error` does nothing.** Those phases belong to the
  overlay, which has its own play / discard / send / dismiss controls. Starting a fresh capture
  from there would silently destroy a clip the owner recorded and had not sent.
- **The slide verdict is restated in the recorder's units.** The composer applies its own
  threshold in points and reports a boolean; feeding `CANCEL_SLIDE_DX` itself (rather than an
  arbitrary large number) makes `resolveDragIntent` reach the same conclusion the button drew,
  so the overlay's glyph, hint and cancel progress agree with the button's fill.

**`app/components/ChatSyncSurface.tsx`.** Calls `useVoiceRecorder` with the SAME handoff an
image upload takes (`onSend` → `send('', [url])`), spreads the handlers onto the composer, and
renders `<VoiceRecorderOverlay>` immediately above the composer bar. The mic button stays
mounted beneath the overlay deliberately: in long-press mode the finger is still on it and the
release is the send. `onPermissionBlocked` → `Linking.openSettings()`, because a permanently
denied microphone has no other route back and the hook stays out of `Linking` by design.

**`app/components/VoiceMicButton.tsx` — DELETED.** It was a second mic control that no screen
rendered. It could not be the one that ships: it draws a 🎙 emoji inside a filled resting
circle, and the composer's in-field slot draws `MicGlyph` from views on a bare background,
which is the iMessage arrangement PR #32 had just landed and the owner had just asked for. Two
mic buttons is exactly the dual code path this repo forbids, so the losing one went rather than
sitting there looking available.

### Verification

**On a device.** See the device section below — a cloud Genymotion Pixel 9 (Android 14), not
the owner's phone and not the local emulator.

**In the harness.** `app/__tests__/voice-message-end-to-end.test.tsx` (new) drives the real
mounted `ChatSyncSurface`, the real composer, the real recorder hook, the real upload client
and the real send queue, pressing controls by accessibility label. It asserts the whole chain
ends where it is supposed to: a `user_message` frame on the socket with an empty body and the
uploaded URL in `attachments` — the identical envelope an image produces. Also pinned: a
refused microphone SAYS so and leaves no capture running; a 500 on upload is visible rather
than silent; a sub-`MIN_RECORDING_MS` misfire is dropped without an error banner; unmounting
mid-recording stops the recorder.

**The gate was mutation-tested.** Removing `{...voiceHandlers}` from the composer turns 8 tests
red across the two files. A gate that cannot fail is what let this ship unreachable the first
time, so it was proven to fail before being trusted.

`app/__tests__/voice-composer-handlers.test.ts` (new) asserts the mapping call-for-call,
including a type-level assertion that the handlers still satisfy `InputComposerProps` — if the
composer renames a callback, that stops compiling instead of quietly unwiring the mic again.

### Two things found on the way

**`expo-audio` was never missing — it was never installed.** The earlier note that
`use-voice-recorder.ts` "does not currently typecheck locally" was an artefact of a stale
`app/node_modules`. After `bun install`, `tsc --noEmit` is clean. A missing dependency is not a
broken module.

**The harness had no `expo-audio` stub**, so the moment the chat surface gained a recorder,
`composer-action-swap.test.tsx` died on an import: the real package pulls `expo`'s side-effect
entry, which reaches for Metro's `ErrorUtils` global. `app/__tests__/support/stubs/expo-audio.ts`
(new) stands in. Unlike the inert stubs beside it, it is deliberately OBSERVABLE — counting its
calls and driveable into a permission refusal — because "did the press reach a recorder at all"
is the exact question an inert stub cannot answer, and it is the question this whole change
exists to keep answered.

### Not covered

- The long-press gesture as a finger performs it. The composer starts hold-mode capture on
  RN's `onLongPress` (`delayLongPress={250}`), so a hold loses its first ~250ms; a press
  shorter than `MIN_RECORDING_MS` is discarded anyway, so this shows up as a slightly clipped
  opening syllable, not a lost message. Restructuring the composer's gesture model to start on
  press-in was left alone deliberately — it would rework a component that had just landed.
- iOS. Nothing here is platform-specific, but it has not been run on an iPhone.
- Real audio content. The harness recorder produces a URI, never bytes, so "the clip contains
  what was said" is a device claim.
