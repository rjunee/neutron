## 2026-07-29 — Mobile chat had NEVER sent a message: `crypto.randomUUID()` on a runtime with no `crypto`; plus the keyboard covering the composer; plus the harness that would have caught it

Ryan, from the phone: *"the mobile keyboard just covers the text entry box. You can't see it at all."* And separately: a sent message never leaves the device. Three OTAs had shipped that evening, all green on unit tests, typecheck and lint. He has been the integration test three times in one night and said plainly that is unacceptable — so the third deliverable here is the test harness, not a fix.

### Defect 1 — every mobile send was destroyed before it existed

**`chat-core/send-queue.ts:49`** (pre-fix):

```ts
this.generateId = opts.generateId ?? (() => crypto.randomUUID())
```

`crypto` IS NOT A GLOBAL ON THE DEVICE. React Native 0.81 installs none, and Expo SDK 54's WinterCG shim installs `TextDecoder`, `TextDecoderStream`, `URL`, `URLSearchParams` and `structuredClone` and stops there (`expo/src/winter/runtime.native.ts` — read it; there is no crypto line). So that expression was a `TypeError`, thrown from `SendQueue.enqueue()` **before** `store.upsert()` wrote the optimistic row.

`app/lib/chat-core/use-mobile-chat.ts:276` (pre-fix) then swallowed it:

```ts
void sessionRef.current?.send(trimmed, opts);
```

`void` on a rejecting promise, behind an optional chain. Net effect for the owner: no bubble, no outbound frame, no server row, no log line, no error. An app that looked like it was working.

**The diagnosis was NOT the one the symptoms suggested.** The prior narrowing (healthy websocket, clean `session_open`/`session_close` pairs, zero message frames) pointed at a stale socket captured across a project switch, or a send that was never wired. Both were wrong: the transport, the topic derivation, the session cache and the composer wiring are all correct, and a mounted surface sends fine under Bun. The bug lived entirely in the difference between Bun's runtime and the phone's.

**Production proof, before any code was changed.** `app_chat_receipts.device_id` on the live tenant contains two populations:

- `dev-59a129bb-19c5-4772-b001-5f2c9ca23cfe` (UUID) — the browser, where `crypto.randomUUID` exists;
- `dev-f8dmlj`, `dev-6ml5wl`, `dev-afcfa1`, … ~50 distinct short base-36 ids — the **fallback** branch of `makeDeviceId()`, which is only reached when `crypto?.randomUUID === undefined`.

The device ids are themselves the measurement: the mobile runtime demonstrably has no WebCrypto. And `app_chat_messages` holds 9 `role='user'` rows, every one with a UUID `client_msg_id` — i.e. every user message ever persisted came from the web client. **Mobile had never delivered one, at any point in the life of the surface.** The newest is from 2026-07-23; nothing since.

**Fix.** One generator, `chat-core/ids.ts` `randomId()` / `prefixedRandomId()`: `crypto.randomUUID` → `crypto.getRandomValues` → `Math.random`, never throwing. `SendQueue` uses it as its default.

**Why one shared generator and not a seventh guard.** Six client call sites had already hand-rolled `const c = globalThis.crypto; c?.randomUUID !== undefined ? … : Math.random()` — chat-core's `web-session`, the app's `mobile-session`, `use-mobile-chat`, the project layout's rail id, the workboard's, and the web chat's config. Every one of them knew. `SendQueue` — the one on the send path, and the one shared with the browser where the bug is invisible — did not. A guard copy-pasted six times gets missed at the seventh, so `chat-core/__tests__/no-direct-webcrypto.test.ts` now fails the build on any direct `crypto.randomUUID` / `getRandomValues` / `subtle` in `chat-core/`, `app/lib`, `app/app`, `app/components` or `landing/chat-react`. It asserts its own reach (>50 files scanned) and its own regex (matches a real call, does not match the guarded indirection) so it cannot rot into a permanently-green no-op — the #388 lesson.

**Also fixed: the silence itself.** Even with the id generator correct, ANY enqueue fault used to vanish. `useMobileChat.send` now returns `Promise<boolean>`, catches, and sets `sendError`, which `StatusStrip` renders ABOVE the connection label. Two consequences: a null session reports "Still connecting — message not sent" instead of no-oping, and the composer's `if (ok)` contract — which `ChatSyncSurface.handleSend` satisfied with a hardcoded `return true` — is now truthful, so a send that could not be queued **leaves the owner's text in the box** instead of deleting it along with the message.

### Defect 2 — `KeyboardAvoidingView` cannot avoid a keyboard from inside nested chrome

`ChatSyncSurface` wrapped itself in `<KeyboardAvoidingView behavior="padding">`. That component measures itself with `onLayout`, whose `nativeEvent.layout.y` is **parent-relative**, and pads by `frame.y + frame.height - keyboardScreenY`. That identity only holds for a full-screen root. This surface is not one: it sits under the project shell's `paddingTop: SPACING.xxl + SPACING.lg`, the `ProjectHeader`, and the `ProjectTabBar`.

With ~150pt of chrome on an 852pt screen and a 336pt keyboard, it computed `(0 + 702) - 516 = 186pt` instead of 336pt — 150pt short, which is more than the composer's own height. Hence "you can't see it at all". Broken since the screen was built; it only became unmissable once the app started opening directly into chat.

**Fix.** `app/lib/keyboard-inset.ts` (`keyboardOverlap`, pure) + `app/lib/use-keyboard-inset.ts` (the RN wiring). The container's bottom is read with `measureInWindow` — **window** coordinates, the same space as the keyboard's `endCoordinates.screenY` — so the subtraction is correct at any nesting depth. The measured view is deliberately the OUTER one and the padding goes on an inner child, or the padding would move the edge that produced it.

Two properties worth recording. It **self-corrects on Android**: with `adjustResize`/edge-to-edge the OS shrinks the window first, so the measured bottom is already above the keyboard, the overlap is ≤ 0, and nothing is added — no platform branch in the arithmetic. And it uses `keyboardWillChangeFrame` on iOS, which covers show, hide, height changes (autocomplete bar, emoji switch) and interactive dismissal in one subscription, and fires before the animation so the lift is in step rather than a frame behind.

The list also follows the newest message when the viewport shrinks (`listRef.scrollToEnd` on a rising inset). `maintainVisibleContentPosition` holds position through CONTENT changes, which is not the same thing.

**No new native dependency**, deliberately: `Keyboard` and `measureInWindow` are already in the shipped binary, so this is OTA-deliverable. `react-native-keyboard-controller` would be the more polished answer and requires a new native build.

### Defect 3 — the mobile app could not mount a single component, and now can

The convention note at the top of `app/__tests__/comments-side-pane.test.tsx` stated the gap outright: *"the Neutron app's bun:test suite does NOT mount React Native components."* 1,200-odd app tests covered pure helpers and HTTP clients. The entire React wiring layer — where all three of tonight's defects lived, and where the rolled-back `ProjectShell` spinner regression lived — had no coverage at all. That is why "unit tests, typecheck and lint are green" kept coexisting with an unusable app.

`app/__tests__/support/native-harness.ts` mounts the real tree under Bun: `react-native` → `react-native-web` (RN primitives render to queryable DOM), a settable `Platform.OS` so `ios` branches actually execute, inert stubs for the expo modules with no JS implementation, a driveable `Keyboard` event bus (RNW's never emits, which would make every keyboard assertion vacuously green), a faked viewport rect (happy-dom reports 0×0, which would make every layout assertion vacuous), and — the load-bearing one — `withoutWebCrypto()`.

`app/__tests__/support/mount.tsx` gives the interaction vocabulary: `type()` through the prototype value setter so React sees it, `press(accessibilityLabel)` which **throws if the control is absent or disabled**, and `FakeChatSocket` recording every frame. Assertions go through the same affordances a thumb uses, so a control that renders but cannot be reached fails.

**It is not a device.** It cannot see native layout, a real keyboard, a gesture, Hermes semantics, or anything in the native binary. What it caught tonight it caught because the bug was reachable in JS.

- **Would have caught defect 1**: yes, directly, and it is the only thing here that could — the whole assertion is "submit produces an outbound frame AND a local bubble, with `globalThis.crypto` deleted".
- **Would have caught defect 2**: PARTLY, and this needs stating precisely. It asserts the surface subscribes to keyboard geometry and pads by the measured overlap, and `keyboard-inset.test.ts` pins the nested-chrome arithmetic including the wrong 186pt number. It does NOT prove the composer is visible: the layout rect is fictional. "The keyboard no longer covers the input" is a DEVICE claim and remains unverified until Ryan looks at it.
- **Would have caught the rolled-back `ProjectShell` spinner**: probably — a mount that asserts the transcript renders after a project switch fails on a permanent spinner. Not claimed as fact; nothing was re-run against that reverted commit.

**One landmine found while wiring it, worth knowing about.** Four existing app tests call `mock.module('react-native', () => ({ View, Text, … }))` with a three-export fake. Bun module mocks are process-global and permanent, and Bun runs many test FILES per process — so whichever loads first owns `react-native` for everything after it, and a real component tree fails to link on the first omitted export (`AppState`). Reproduced deterministically by running `authed-attachment-image-hooks.test.tsx` before `chat-keyboard-avoidance.test.tsx`. A module mock outranks an `onLoad` alias, and re-registering the mock either deadlocks (async factory) or loses (sync). The harness therefore does not contest the specifier: it rewrites `from 'react-native'` inside the app's own sources to the stub path, so its graph never asks the registry and those four tests keep the fake they want. `native-harness-selfcheck.test.tsx` asserts the harness has a DOM, a complete RN surface, a phone platform, a non-zero viewport and removable WebCrypto — so a degraded harness fails loudly instead of turning the device suites into no-ops.

### Measured

Mutation-tested every guard, because a guard whose removal reddens nothing is not a guard:

| Mutation | Result |
|---|---|
| restore `crypto.randomUUID()` in `SendQueue` | `send-queue-no-webcrypto` 3/6 fail; device suite 4/7 fail |
| restore `KeyboardAvoidingView` on the surface | keyboard suite 3/6 fail |
| restore `void session?.send(...)` + `return true` | device suite 2/7 fail |
| `keyboardOverlap` → always `0` | inset suite 3/7 fail; keyboard suite 3/6 fail |
| reintroduce a direct `crypto.randomUUID` in `app/lib` | WebCrypto guard 1/3 fail, naming the file:line |

Suites: `chat-core` 145 pass, `app/__tests__` 1,237 pass (was 1,218 + 19 new), typecheck matrix 51/51, lint 5/5 gates, leak gate SILENT.

### NOT covered

- **Nothing here is verified on a phone.** Both fixes are JS-only and OTA-deliverable, but "the keyboard no longer covers the composer" and "a typed message arrives" are device claims. Treat them as unverified until Ryan confirms on the handset.
- The harness sees no native layout, gestures, Hermes semantics, or native-module behaviour.
- The `crypto`-absent conclusion is inferred from production device ids + the absence of a polyfill in the Expo/RN source, not from a runtime probe on the handset. It is strongly evidenced, not directly observed.
- The remaining hand-rolled WebCrypto guards in `app/app/projects/[id]/_layout.tsx`, `workboard.tsx` and `landing/chat-react/` were left alone. They are correct; the new lint gate prevents the unguarded form recurring anywhere. Consolidating them is cleanup, not a fix.
- The four `mock.module('react-native')` fakes in existing tests are still there. Migrating them onto the harness would delete a real class of order-dependence, but it means rewriting their assertions, which is not a thing to do in the same change as a P0.
