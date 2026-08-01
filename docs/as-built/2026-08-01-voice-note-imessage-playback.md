## 2026-08-01 — the voice-note player copies iMessage (no more box in a box)

PR #39 (`a81f4d09`) made a sent voice note playable. It shipped drawing its own filled,
rounded panel, so the control appeared as a box nested inside the message bubble — which
already has an edge and a radius of its own. The owner: *"The voice note playback UX is
kinda ugly. Its a box in a box, the play button is a really small tap target... can you make
it look like imessage?"*

This is the restyle. **No playback behaviour changed** — the four things PR #39 got right
(one clip at a time, the session released on unmount and on finish, the bearer reaching the
player, and `--:--` rather than a fabricated `0:00`) are untouched and their tests are still
green.

### The reference

**Apple's own asset**, pixel-measured — the method the composer rework
(`2026-07-31-composer-imessage-affordances.md`) used, not a description from memory.

| | |
|---|---|
| Primary | `help.apple.com/assets/69F8EBBDF3B89A4F6E0C704C/69F8EBC43862495245036393/en_US/8d5297e97af5bc312625c6e5859061df.png` — Apple's alt text: *"A Messages conversation with an audio message."* Linked from `support.apple.com/guide/iphone/send-and-receive-audio-messages-iph2e42d3117/ios` |
| Cross-check 1 | Apple's standalone play-button glyph asset from the same guide page (60x60) |
| Cross-check 2 | An iOS 12-era audio bubble captured at a known 3x on a 375pt screen — a bubble with NO transcript line, which is where the tight vertical padding is readable |

All three agree on the arrangement: **disc at the leading edge, the waveform spanning the
middle, the length at the trailing edge, and no container between them and the bubble.**
Apple's prose never states any of this; every number below is off the pixels.

Scale calibration for the primary asset: the screen glass measures 453px for a 393pt
device = **1.153 px/pt**. Independently validated two ways — the bubble's corner radius
comes out at 17.3pt against the 18pt this codebase already uses (`BUBBLE_RADIUS_PT`), and
the disc comes out at 28.7pt against 29.0pt measured on the 3x reference.

### The measured numbers

Ratios are expressed against the disc DIAMETER so they hold at any size, and the code
derives from them rather than hardcoding a point size.

| | Measured (Apple) | Implemented |
|---|---|---|
| Play disc | 33px = **28.7pt**; 87px/3x = **29.0pt** | `CONTROL_DIAMETER_PT = 30` |
| Play triangle W | 11px of 33 = **0.333 D** (glyph asset: 0.350) | `GLYPH_WIDTH_RATIO` |
| Play triangle H | 13px of 33 = **0.394 D** (glyph asset: 0.400) | `GLYPH_HEIGHT_RATIO` |
| Triangle optical nudge | +1px of 33 = 0.030 D (glyph asset: 0.042) | `GLYPH_NUDGE_RATIO = 0.035` |
| Disc → waveform gap | 14px = **12.1pt** | `SPACING.md` (12) |
| Waveform → length gap | 18px = **15.6pt** | `SPACING.lg` (16) |
| Length type size | 12px digit height ⇒ ≈14pt font | `TYPOGRAPHY.body_small` (13) |
| Length opacity | **0.70** of the foreground (waveform beside it is 1.0) | `TIME_OPACITY = 0.7` |
| Bubble padding L/R | 18px / 17px = ~15.5pt | unchanged app value (`BUBBLE_PADDING_H_PT` 12) |

**The gaps are asymmetric and that is deliberate.** 12 on the left, 16 on the right.
Copying them symmetric is one of the things that makes a clone read as "close, but off".

### What changed, element by element

| Element | Was (PR #39) | Now |
|---|---|---|
| Container | Filled `THEME.surface` panel, `borderRadius: 14`, its own padding | **None.** The row IS the bubble's content |
| Play control | 32pt `surface_raised` circle — `#1a1a1a` on `#121212`, i.e. invisible | 30pt disc filled in the bubble's FOREGROUND, triangle knocked out in the bubble's own fill |
| Play/pause mark | A `▶` / `⏸` CHARACTER in a `<Text>` | Drawn from views — a collapsed-box border triangle, two capped bars for pause |
| Tap target | 32pt paint + 8pt slop | 30pt paint + 7pt slop = **44pt reach** |
| Track | 4pt, `text_muted` base, `THEME.accent` fill | 6pt, bubble ink at 0.3 behind, bubble ink at full in front |
| Length readout | 11pt caption, fixed `text_secondary` | 13pt, bubble ink at 0.70, still trailing (the reference confirms trailing) |
| Colours | Fixed palette entries | The bubble's own `BubbleTone`, threaded from the transcript |

**The disc got SMALLER (32 → 30) and reads much bigger, which is the counter-intuitive part
of "really small tap target".** The disc was never the problem — its contrast was.
`surface_raised` on `surface` is invisible, so the only mark the eye could find was the 13pt
text glyph inside it. Apple's disc is a solid fill in the bubble's foreground with the
triangle knocked out, and that is what makes a 29pt control read as generous. The REACH was
then fixed separately and honestly, with `hitSlop` — the paint stays at the reference size
and the touch box goes to 44pt, because growing the paint to 44 would push the bubble taller
than iMessage's.

### `BubbleTone` — why a new concept

With no panel of its own, the player has no background it controls, so it has to be told
what it is sitting on. iMessage paints every mark in the bubble's foreground and knocks the
triangle out in the bubble's fill, so **both** colours are needed, not just the foreground.

`BubbleTone` (`app/lib/chat-bubble-metrics.ts`) is that pair, and it lives in the module that
is already the one home for a bubble's facts. `ChatSyncSurface` now paints `userBubble` /
`agentBubble` / `userText` FROM those constants, so the player's idea of what it is sitting
on cannot drift from what was actually drawn.

Also fixed while here: the attachment row's `marginTop: SPACING.sm` separates attachments
from the words above them, but a voice note has no words (`send('', [url])`), so on that
message it was dead space at the top of the bubble — the other half of why the player read
as a panel floating inside a box. It is now applied only when there is a body.

### The one deliberate departure: the track is not a waveform

Apple draws a **real amplitude envelope** — the silence at the head of the clip and the
speech in the middle are both visible. We have no amplitude to draw:

- `expo-audio` reports `metering` on a **recording** only. `AudioStatus`, the playback status
  the component reads, carries no level and no samples
  (`expo-audio/build/Audio.types.d.ts:137-169`, `:205`).
- The one PCM channel it does offer, `useAudioSampleListener`, is **real-time only** (nothing
  exists before the first play), is documented as *"not supported on all platforms"*, and
  *"requires RECORD_AUDIO permission on Android"*. Requesting the microphone in order to draw
  a decoration is not a defensible trade.

Bars whose heights came from anywhere else — a hash of the content-addressed URL, a fixed
pattern — would **look** like an amplitude envelope while carrying nothing about the audio.
That is a worse lie than an honest bar, and it is the exact failure mode the component's
original header named ("a painted waveform that ignores playback position is the thing this
component exists NOT to be"). So the waveform's SLOT, proportion and behaviour are Apple's;
what fills it is a progress track that means exactly what it shows.

`M:SS` was also kept over the reference's zero-padded `00:04`, on purpose: `formatClipLength`
is shared with the recorder's `formatElapsed`, and breaking their agreement so a 1.9s clip
reads `0:01` while recording and `00:01` on playback would cost more than the padding is
worth.

### The web client had the identical defect, and it was worse

`<audio controls>` was the right first move — a real player, keyboard-accessible, for free —
but Chrome draws its own filled rounded panel, so on the blue user bubble it was a light-grey
slab owning the whole message. It also rendered `0:00 / 0:00` before metadata (the exact
fabricated zero the mobile side avoids), plus a volume slider and an overflow menu that mean
nothing in a transcript.

`landing/chat-react/VoiceNotePlayer.tsx` **keeps the `<audio>` element as the transport** and
replaces only the chrome. So the browser still decodes, `preload="metadata"` still gets a
real duration up front, and the one-clip-at-a-time registry is still bound to the media
EVENTS rather than a click handler — which is what keeps the OS media keys covered. What was
lost with `controls` is given back explicitly: a real `<button>` and a real
`<input type="range">`, so the play control and the scrubber stay keyboard-operable.

**The two clients share a design, not code** — React Native has no `HTMLAudioElement` and the
browser has no `expo-audio`. That is the same split `audio-exclusivity.ts` and
`lib/voice-playback.ts` already have: one rule, two implementations. On web the colours come
through `currentColor` and a `--bubble-ground` custom property set on the bubble classes, so
the CSS names no palette entry and cannot drift either.

### Tests

`app/__tests__/voice-note-playback.test.tsx` — 9 existing cases untouched and green (the four
failure modes PR #39 pinned), plus 4 new cases pinning the ARRANGEMENT:

- the player root paints **no** fill, radius or border (react-native-web compiles static
  styles to atomic classes named after the property, so this is directly observable);
- every mark is painted in the tone it was handed — the disc in the bubble's ink and the
  triangle in the bubble's ground, and both **swap** between the user and agent tones;
- the play/pause mark is a drawn view, not a `▶` character;
- the control's reach arithmetic: 30pt paint + 2 x 7pt slop = 44pt.

`landing/chat-react/__tests__/attachments.test.tsx` — the voice-note case now pins both
halves: the browser's `controls` is gone AND everything it provided for free is still there
(a labelled play button, a keyboard scrubber, `--:--` instead of `0:00`).

**Mutation-tested, all seven pins.** Restoring the container, hardcoding the disc colour,
typing the glyph as text, shrinking the tap target, restoring `controls`, deleting the
keyboard scrubber, and restoring the fabricated `0:00` each fail exactly their own case and
leave the rest green. They are not false positives.

### What was verified, and what was not

**Verified visually.** The real component tree was rendered through react-native-web — the
same harness the tests use — serialised with its generated CSS and screenshotted in headless
Chromium at up to 5x, in five states (at rest, playing mid-clip, agent bubble, length not yet
known, and with body text above). The rendered geometry was then measured back out of the
PNG: disc 30px, bubble 42px tall, disc inset 11-12px from the bubble edge, track 6px, gap 12px
— matching the source. The web player was rendered the same way from the real CSS.

**NOT verified on a device or emulator.** A finished Android APK exists on EAS, but there is
no path to run THIS branch's JS on it without publishing an update to a channel the owner's
phone could pick up, and no Neutron instance with a voice note in its transcript was
available to point it at (PR #39 hit the same wall — its chat socket never connected in that
environment). So the following rest on the geometry in the source and on the harness render,
not on a phone:

- that React Native honours `hitSlop` at 7pt (well-established, but not observed here —
  `hitSlop` leaves no trace in the DOM, which the test says explicitly);
- that the collapsed-box border triangle rasterises cleanly on Android (the canonical RN
  technique, and it renders correctly under react-native-web);
- native layout rounding of the fractional glyph sizes (5.91 / 9.99 / 11.82pt).

These are the first things to check on the next device pass.

### Scope

**JS only** — no `app.json`, no `package.json`, no native module, no new dependency. This
ships over the air to a build whose fingerprint matches `main`; no reinstall.

**SYSTEM-OVERVIEW.md changes: none.** A visual restyle of an existing component plus a colour
pair threaded to it — no new module, HTTP surface, lifecycle behaviour, deploy step, Core tier
mechanic, onboarding phase, or env flag. The doc does not describe attachment rendering.
