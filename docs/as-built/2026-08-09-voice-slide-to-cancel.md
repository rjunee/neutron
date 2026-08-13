# Slide-to-cancel: the press was dying before the slide could arm

**Landed:** 2026-08-09 · **ISSUES:** #521 · **Surface:** `app/components/InputComposer.tsx`

## What the owner saw

> "'slide to cancel' on the voice note recorder doesn't work."

## Why — and the arithmetic was never the problem

`Pressable` releases a press once the touch leaves the button plus its retention
offset. RN's default retention is a couple of dozen points and the mic button is
44pt, while the gesture requires travelling `VOICE_CANCEL_SLIDE_PT` = **64pt** —
comfortably outside it.

So the press TERMINATED mid-slide. `onPressOut` fired while `holding.cancelling`
was still false, the release resolved as **'send'**, and the View stopped
receiving `onTouchMove` before the threshold could ever be crossed. Sliding away
didn't cancel the recording — **it sent it**, which is the worst possible reading
of "cancel": the thing the user was trying to destroy is the thing that got
delivered.

## The fix

`pressRetentionOffset={VOICE_PRESS_RETENTION_PT}`, derived from the slide
threshold rather than a loose literal — 2× vertically, 4× horizontally, with room
for the arc a one-handed thumb takes. Retention costs nothing until a press is
already in progress, and the failure it prevents is unrecoverable in the wrong
direction.

## Coverage, stated honestly

`app/__tests__/voice-slide-to-cancel.test.tsx` is **mostly source assertions, not a
driven gesture**, and its docblock says so. Two things make the real gesture
undrivable in this harness: RN-web's Pressable does not model the native
responder's retention region — so the very termination that caused the bug cannot
occur here, and a driven test would pass with the fix removed — and `holding` is
only entered through `onLongPress` after a delay the harness cannot cleanly elapse.

What is asserted: the mic control is mounted and reachable (driven); it carries a
retention offset derived from and larger than the slide threshold (source); the
threshold counts travel in either direction (source). Mutant: removing the
retention offset reds the retention assertion.

**The device claim — that a real thumb sliding 64pt cancels — is settled on
hardware, not here.** The first draft of that test file described itself as
behavioural when it was not; it was rewritten before merge rather than shipped as
an aspirational docblock.
