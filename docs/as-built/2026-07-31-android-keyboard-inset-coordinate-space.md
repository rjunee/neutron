## 2026-07-31 — the Android keyboard inset was a cross-coordinate-space subtraction

The composer was still behind the keyboard on Android after the 2026-07-29 fix. Owner,
with a screenshot: *"Text entry window and send button still not visible when keyboard is
showing"* — "still" being the operative word, because this is the second attempt.

### What was actually wrong

`2026-07-29-mobile-send-webcrypto-and-keyboard-inset.md` replaced `KeyboardAvoidingView`
with a window-space subtraction — the container's bottom from `measureInWindow`, minus the
keyboard's `endCoordinates.screenY` — and asserted in `lib/keyboard-inset.ts` that it
"degrades correctly on Android". It does not, and the assertion was never checked against
a device or against RN's source. **The two terms are in different coordinate spaces on
Android**, read this session out of the installed `react-native@0.81.5`:

| term | value | source |
| --- | --- | --- |
| `endCoordinates.screenY` | `mVisibleViewArea.bottom` — a raw SCREEN y | `ReactAndroid/.../ReactRootView.java:891,913` |
| `measureInWindow().y` | shadow-tree frame + viewport offset, where the Android offset is `locationOnScreen.y - visibleWindowFrame.top` — screen y MINUS THE STATUS BAR | `.../runtime/ReactSurfaceView.kt:93-105`, consumed via `ReactCommon/react/renderer/dom/DOM.cpp:508` |

So the container's bottom was reported one status-bar-height above where the keyboard's
`screenY` lived, and the subtraction came out short by exactly that.

### Measured on the device, before any code changed

Android 14 emulator, 320x640 mdpi, status bar 24px. With the keyboard up in a project's
Chat tab, `adb shell dumpsys window displays` reports the IME frame at `[0,405][320,640]`
(height 235), and `uiautomator dump` reports `composer-bar` at `[72,332][320,429]`.

- padding applied: `640 - 429 = 211`
- padding required: `640 - 405 = 235`
- shortfall: **24px — the status-bar height**, and `composer-bar` ran 24px past the
  keyboard's top edge with the send control in that strip.

The same measurement in the General project came out at `[72,356][320,453]` — 48px behind
the keyboard, with the text field itself clipped in half. `getWindowVisibleDisplayFrame()`
is sampled inside `onGlobalLayout` and is not stable across the IME animation, so the
shortfall is at least the status bar and sometimes worse. It is never zero.

Why edge-to-edge is what exposed this: `adjustResize` stopped resizing the window once the
app went edge-to-edge (`app/app.json` android `edgeToEdgeEnabled: true`; targetSdk 36 makes
it non-optional regardless), so nothing shrinks on the app's behalf any more.

### The fix

Android stops subtracting and adds inside one coordinate space instead
(`app/lib/keyboard-inset.ts` `androidKeyboardInset`):

```
inset = endCoordinates.height + useSafeAreaInsets().bottom
```

RN reports the Android keyboard NET of the navigation bar it draws over —
`height = imeInsets.bottom - barInsets.bottom` (`ReactRootView.java:902-904`) — and
safe-area-context's bottom inset is that same `systemBars().bottom`, deliberately excluding
the IME (`react-native-safe-area-context/android/.../SafeAreaUtils.kt:13-25`). Adding them
back together reconstructs `imeInsets.bottom` exactly. Both come from `WindowInsets` on the
same window, so the mistake above is not available here.

iOS is untouched: the measured window-space overlap is correct there and is what shipped.
`app/lib/use-keyboard-inset.ts` now picks the strategy by platform, with the platform as an
injectable seam so both paths are testable off-device.

**Precondition, now stated in the code:** the surface's bottom edge is the window's bottom
edge. Verified on device — with the keyboard down `chat-keyboard-inset` measures
`[72,151][320,640]` on a 640px screen. It is structural (the project shell applies a top
inset only, and chat is its bottom-most child), and if bottom chrome is ever added the
failure mode is a visible dead band rather than a hidden composer.

### Also in this change

The composer's duplicate hint is gone. `ChatSyncSurface` rendered
*"Or type a response to the prompt above."* as a permanent extra line directly above the
keyboard while the placeholder two lines away already said *"Or type a response…"* — the
same instruction twice, in the region with the least room. Owner: *"Unnecessary"*. The
`hint` prop stays for the upload affordance, which says something the placeholder does not.

### Tests

`app/__tests__/chat-keyboard-avoidance-android.test.tsx` (new, 8 cases) drives the real
keyboard subscription on `Platform.OS === 'android'`. The discriminating case feeds a
deliberately absurd `screenY` and asserts the inset does not move — under the old
implementation that reports 852 instead of 360. Mutation-tested: forcing the window-space
branch back on fails 4 of the 8. `app/__tests__/keyboard-inset.test.ts` gains 5 pure cases
for the arithmetic, including the no-navigation-bar device where the two numbers coincide
(which is why the emulator hides half of the defect).

### NOT covered

The harness fakes every element's layout rect, so no JS test proves the visual result.
"The composer is visible above the keyboard" is a DEVICE claim and is settled with
`uiautomator` bounds, not here.

### Delivery

JS only — no `app.json`, manifest, or native-module change. Over-the-air deliverable.
