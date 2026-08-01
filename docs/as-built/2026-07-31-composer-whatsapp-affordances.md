## 2026-07-31 — the composer copies WhatsApp-on-Android's affordances

The owner, on the send control: *"Is this up arrow for send how imessage does it? It looks
kinda ugly."* Then, after an iMessage pass: *"In that case we copy Whatsapp on Android"* —
he is on Android and wanted the platform-native pattern rather than an iOS one ported onto
it. He supplied a real WhatsApp dark-mode screenshot, which is what this was built against.

### What the reference actually shows

Read off the supplied frame, not from memory — two of these corrected the brief:

1. Capsule field, **filled** a shade lighter than the bar, radius = half height.
2. An emoji/sticker button inside the field's leading edge.
3. The caret tinted with the app's accent colour.
4. **A paperclip only** at the field's trailing edge — no camera.
5. **Outside** the capsule to its right, a filled circle containing a **paper plane**, not
   an up-arrow.
6. The circle vertically centred against a one-line field.

### What was built

- **The field** is now a capsule (`borderRadius` = half the resting height, so one line is a
  true pill and extra lines grow it into a rounded box), filled with `surface_raised`
  against the bar's `background`. The paperclip moved INSIDE it at the trailing edge.
- **Growth is real**: `minHeight` one line, `maxHeight` six lines
  (`FIELD_MAX_LINES`), past which the `TextInput` scrolls its own content and the bar stops
  rising. This is the affordance most often skipped.
- **The action button sits outside the capsule** and **swaps by content** — microphone while
  the field is empty, send once there is something to send. The row is bottom-aligned so
  both the button and the paperclip track the LAST line as the field grows; centring them
  against a grown field is the tell that a pattern was copied from a one-line screenshot.
- **The caret is accent-tinted** (`selectionColor` + Android's `cursorColor`).
- **Touch targets** are ≥44pt via `hitSlop`, without inflating the artwork.

### The glyphs are drawn, not typed

There is no icon set in the dependency tree — no `@expo/vector-icons`, no
`react-native-svg` — and this has to ship over the air, so a native font or SVG package was
not an option. Both marks are built from views:

- **Paper plane**: a right-pointing filled triangle via the zero-size-view border trick,
  plus a second triangle in the button's fill colour painted over the trailing edge to cut
  the notch that stops it reading as a "play" arrow. A right-pointing triangle carries its
  ink centroid a third of the way from base to apex, so it is nudged 2pt right to sit
  optically centred rather than geometrically.
- **Microphone**: a capsule head, a U-cradle (a box with a transparent top border and
  rounded bottom corners), and a stem.

This is also why the old send mark was wrong: it was a `Text` glyph (`↑`), so its position
came from the system font's ascent/descent and it sat low in its circle with whatever
weight the font happened to give it.

### The voice button is a real control with a seam, not a placeholder

Voice messages are being built as a separate module which owns capture, permissions and
upload. The composer owns only the BUTTON, and reports what the finger did through
`onVoiceTap` / `onVoiceHoldStart` / `onVoiceHoldMove` / `onVoiceHoldEnd`, covering both
interactions the recorder needs:

- **Hold**: long-press starts; sliding past `VOICE_CANCEL_SLIDE_PT` flips the control to a
  cancelling state (it turns `danger`-coloured and its accessibility label changes);
  releasing reports `'send'` or `'cancel'`.
- **Tap**: reported through `onVoiceTap` for the tap-to-start/tap-to-stop path.

Travel counts in EITHER direction. The reference slides left, but a one-handed thumb arcs,
and a gesture that only cancels one way strands whoever arcs the other.

**Until the recorder is wired, pressing the mic says so** — `VOICE_UNAVAILABLE_NOTICE`
renders under the bar for a few seconds. A control that looks live and silently does
nothing is exactly the failure this avoids, and there is a test for it.

### NOT ported, deliberately

The reference's **emoji/sticker button** at the field's leading edge. This app has no emoji
picker to open (no picker component, no such dependency), and a button that opens nothing is
the same defect as a microphone that records nothing. The leading edge is plain padding
until there is a picker behind it.

### Tests

`app/__tests__/composer-action-swap.test.tsx` (new, 5 cases): the mic is mounted while
empty, the send plane replaces it on the first character, the mic returns after a send, the
unwired mic admits it rather than pretending, and the paperclip survived the move inside the
capsule. The existing composer suites (`imessage-chat-ux`, `mobile-chat-send-on-device`)
stay green against the restructured tree.

**Honest boundary:** these assert WHICH CONTROL IS MOUNTED. The harness fakes every layout
rect, so capsule radius, last-line alignment and optical centring are DEVICE claims and are
settled with screenshots and `uiautomator` bounds, not here.

### Delivery

JS only — no `app.json`, manifest, or native-module change, so this ships over the air. The
voice RECORDER will need a native audio dependency and therefore a real build; keeping the
button and the recorder in separate changes is what lets this half ship ahead of it.
