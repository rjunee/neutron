## 2026-07-31 — the composer copies iMessage (replacing the WhatsApp pass)

Yesterday's change (`333ca1d7`, PR #29) rebuilt the composer to copy WhatsApp on Android.
That was the wrong target. The owner's standing instruction has been *"Copy the iMessage UI
affordances for text entry and send button exactly"*; WhatsApp was only ever offered as a
**fallback for affordances Android genuinely cannot do**, and no such blocker was ever
established. The owner, 2026-07-31: *"the design is supposed to be imessage. Whatsapp was
ONLY suggested if there's something in the imessage UX that just CANNOT be done on
android."*

So this converts `333ca1d7` to iMessage rather than layering a third style on top of it.
**Nothing in the iMessage composer turned out to be blocked on Android.** The only things
not reproducible are Apple's proprietary assets — SF Pro and the exact `arrow.up` outline —
which are approximated, as expected, and are not a capability blocker.

### The reference

No pixel reference was available. Working from:

- the owner's own description of the target (the four elements named in the brief);
- Stream's iOS Chat SDK guide to restyling its composer as iMessage
  (<https://getstream.io/chat/docs/sdk/ios/uikit/components/message-composer/>), which is a
  third party independently describing the same arrangement: *move the send button from the
  trailing container to the input container*, make it *aligned to bottom* inside that
  container, set the input's *corner radius to 18*, and keep the attachment button in the
  **leading** container. Its `cornerRadius = 18` against a ~36pt field is the same "radius =
  half the resting height" pill this implements, arrived at independently.

**This was NOT verified against a running iMessage instance or a screenshot**, and it was
not verified on a device — see "What is not verified" below. Anywhere the two sources above
were silent, the brief's wording was followed literally rather than filled in from memory.

### What changed, element by element

| Element | Was (WhatsApp pass) | Now (iMessage) |
|---|---|---|
| Text field | Filled `surface_raised` capsule, no stroke | **Outlined** pill — transparent fill, `StyleSheet.hairlineWidth` stroke in `THEME.hairline` |
| Send control | 40pt circle **outside** the field, to its right | 28pt filled circle **inside** the field at the trailing edge |
| Send glyph | Paper plane (filled triangle + notch) | **Upward arrow** — shaft + two-armed chevron |
| Leading side | Nothing | A single **`+`** in a filled circle, outside the field |
| Attachment | 📎 emoji inside the field's trailing edge | Folded into the leading `+` (same handler) |
| Mic (empty state) | 40pt circle outside the field | 28pt, in the same in-field slot the send arrow uses |

**The up-arrow stays.** The owner asked *"Is this up arrow for send how imessage does it? It
looks kinda ugly."* The honest answer is yes — that is the mark iMessage uses — and "copy it
exactly" means keeping it. What was actually ugly was the *rendering*: the pre-#29 code drew
a literal `↑` in a `<Text>`, so its size, weight and vertical position all came from the
system font's metrics, which is why it sat low in its circle. It is drawn from views now, so
its geometry is ours: a shaft plus two arms, each bar `borderRadius`-capped to give the round
caps and round apex join SF Symbols' arrows have. The arms are positioned by their centres,
derived through `Math.SQRT1_2` from the apex, so the head stays attached to the shaft if the
box is ever retuned.

There is still no icon set in the dependency tree — re-checked `app/package.json` this
change; `expo-audio` was the only dependency PR #24 added, and there is still no
`@expo/vector-icons` and no `react-native-svg`. This ships over the air, so a native font or
SVG package remains unavailable and every glyph is drawn from views.

**The paperclip became the `+` rather than sitting beside it.** iMessage has exactly one
control on the leading side, and its job is to open the attachment drawer — which is the job
the paperclip already did. Wiring the `+` to the existing `handleAttachPress` keeps the real
file picker behind it; a `+` that opened nothing would be the same no-op-control defect this
composer refuses to ship elsewhere.

**The tint is the app's own accent** (`THEME.accent`), not Apple's blue — for the send
circle's fill and for the caret, as before.

### What was preserved

- **The empty/typing swap.** Mic while empty, send arrow once there is something to send.
  Both press and long-press still dispatch; the hold still tracks the finger, so releasing
  over the button commits and sliding away past `VOICE_CANCEL_SLIDE_PT` cancels. The gesture
  code is untouched — only the button's size and its position in the tree changed.
- **The keyboard inset.** `styles.wrap`'s `paddingBottom: bottom_inset`, the
  `COMPOSER_RESTING_BOTTOM_PT` fallback, and `ChatSyncSurface`'s `composerBottomInset` call
  are all byte-identical — the diff touches none of them. `app/__tests__/imessage-chat-ux.test.tsx`
  (25 cases, which is where that regression is pinned) is green. The bar also got 4pt
  **shorter** — its height was previously driven by the 40pt outside button and is now
  driven by the 36pt field — so there is less of it to clip, not more.
- **Growth.** One line at rest, six lines maximum, past which the `TextInput` scrolls its own
  content and the bar stops rising. Both the leading `+` and the in-field action button are
  bottom-aligned, so they track the LAST line rather than centring against a grown field.

### Tests

`app/__tests__/composer-action-swap.test.tsx` — rewritten, 8 cases. Three are new and pin
the ARRANGEMENT, which is the thing this change is actually about and the thing a future
restyle will break first:

- the send arrow is a DESCENDANT of the field, not a sibling;
- the mic is too (it shares that slot);
- the `+` is NOT a descendant of the field.

These are DOM-containment facts under the react-native-web harness, not pixel facts, so they
are honestly testable. **Mutation-tested**: moving the action slot back outside the field —
the WhatsApp arrangement — fails exactly the first two and leaves the other six green. They
are not false positives.

### What is NOT verified

- **Nothing was verified on a device or emulator.** The Android emulator was taken out of use
  mid-change at the owner's request (it was loading his laptop), so there is no screenshot and
  no `uiautomator` bounds behind any of this. Everything visual here — the pill's radius, the
  stroke's visibility against `THEME.background`, the arrow's optical centring in its circle,
  the button staying pinned to the last line as the field grows — is an UNVERIFIED claim
  resting on the geometry in the source. It is the first thing to check on the next device pass.
- **The stroke's contrast is the specific risk.** `THEME.hairline` is `#1f1f1f` on a
  `#0a0a0a` background. That is a deliberate token choice (it is the theme's designated
  border colour, and inventing a new one would have contended with concurrent work in
  `theme.ts`), but it is a much darker stroke than iMessage's, and an outlined field that
  cannot be seen is worse than the filled capsule it replaced. If it does not read on device,
  the fix is a new theme token, not a local hex literal.
- **No reference screenshot of iMessage was used** — see "The reference" above.

### Adjacent gap found, NOT fixed here

**The voice recorder from PR #24 (`1bddf3df`) is built but not wired.** `ChatSyncSurface`
renders `<InputComposer>` with no `onVoiceTap` / `onVoiceHoldStart` / `onVoiceHoldMove` /
`onVoiceHoldEnd` props (`app/components/ChatSyncSurface.tsx:527-537`), and
`app/components/VoiceMicButton.tsx` — the component PR #24 added to carry those gestures —
has no call site anywhere outside its own test. So the mic still falls through to
`VOICE_UNAVAILABLE_NOTICE`. `expo-audio` is also absent from the installed
`app/node_modules`, so `use-voice-recorder.ts` does not currently typecheck locally.

That is a real "built but never wired" gap, but it is a FEATURE change with permissions,
capture and upload behind it — not a restyle — and it could not have been exercised here
anyway (recording on the owner's live tenant was out of bounds, and then the emulator was
withdrawn). It needs its own change and its own verification. Left untouched and reported
rather than half-wired.

### Scope

JS only — no `app.json`, manifest, or native-module change, so this ships over the air.

**SYSTEM-OVERVIEW.md changes: none.** This is a visual restyle of an existing component — no
new module, HTTP surface, tenant lifecycle behaviour, deploy step, Core tier mechanic,
onboarding phase, or env flag. The doc does not describe the input composer's appearance.
