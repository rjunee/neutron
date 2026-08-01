## 2026-07-31 — the chat composer spans the viewport instead of the rail's column

Branch `feat/app-full-width-composer`. New `app/lib/composer-dock.tsx`; the project
shell (`app/app/projects/[id]/_layout.tsx`) grows a full-width bottom band; the chat
surface (`app/components/ChatSyncSurface.tsx`) publishes its composer into it.

**The ask.** The owner: *"would it be possible to have the text entry box take the full
width of the screen instead of being shortened by the project rail?"* Every messaging
app this is measured against runs the composer edge to edge across the bottom. Ours did
not, and the reason was structural rather than cosmetic.

**Why it was narrow.** The mobile shell is a ROW — a 72pt project rail on the left, a
column of tab bar + content on the right — and the composer was the last child of the
chat surface, which lives inside that right-hand column. So the rail took 72pt off the
input's leading edge while the transcript above it kept the full width.

**Why not just move it left.** A negative margin (or a negative `left`) does escape the
parent's box in the paint, and then the escaped strip is DEAD on Android: a `ViewGroup`
does not dispatch touches to a child outside its own bounds. The left third of the field
would have drawn and refused to focus. A control that is visible and untappable is worse
than one that is merely narrow, and that failure mode is invisible to a hierarchy dump —
which is exactly the class of false verification this repo has been burned by.

**So the composer moves in the TREE.** The shell renders a band as the last child of its
full-width column, under BOTH the mobile rail row and the wide (web) layout — one
placement, no per-layout branch. The chat surface publishes into it through a small
context + store (`useComposerDock`). The rail row above stays `flex: 1`, so the band takes
its natural height OUT of the row rather than covering it: the rail's `ScrollView` simply
gets shorter and no rail entry can end up underneath the composer.

**A store, not `useState` in the shell.** The chat surface re-renders on every inbound
token; holding the published element in the shell's own state would re-render the rail
(animated rows) and the tab bar at that rate. The band subscribes to a mutable store via
`useSyncExternalStore`, so a republish re-renders exactly one component. Ownership is
token-keyed, because two chat surfaces can be mounted for a frame during a route
transition and the departing one must not blank a band the arriving one has claimed.

**No inline fallback.** A surface mounted with no band in scope throws. A second placement
would be the dual code path this repo bans, and the defect it would hide — a composer
drawn back inside the column — is the whole thing being fixed. The test harness supplies
the band the way the shell does (`app/__tests__/support/mount.tsx`), so existing
mounted-screen tests needed no edits.

### The keyboard lift moved WITH the composer, deliberately

This is the part that had to be got right rather than assumed: the lift has already
regressed twice and the owner reported it both times.

`useKeyboardInset` measures a container whose bottom edge IS the window's bottom edge —
iOS subtracts the keyboard's `screenY` from it, and Android's `androidKeyboardInset`
documents the same precondition. After this change the chat surface stops at the band's
top, so it is no longer that container. The measured/padded pair therefore rides along
INTO the band: an outer view that carries the ref and is never padded, and an inner view
that carries `paddingBottom`. The band grows by the inset, the `flex: 1` row above gives
up the space, and the transcript shrinks exactly as it did before. The voice recorder
overlay moved too — it renders directly above the composer bar and must span the same
width.

### Verified on a device

A cloud Genymotion Pixel 9 (Android 14, 1080×2424) — a clean instance, never pointed at
any production instance. An EAS development client running this branch's JS from Metro,
writing to a throwaway local Open instance over `adb reverse`. `uiautomator` bounds, with
a screenshot read at every step (a node in the hierarchy is not a visible, correctly
positioned control):

| State | `composer-bar` | `project-rail` | `composer-dock` |
|---|---|---|---|
| Keyboard down | `[0,2156][1080,2424]` | `[0,271][190,2156]` | `[0,2156][1080,2424]` |
| Keyboard up | `[0,1380][1080,1521]` | `[0,271][190,1380]` | `[0,1380][1080,2424]` |
| Keyboard up, 5-line draft | `[0,1155][1080,1521]` | `[0,271][190,1155]` | `[0,1155][1080,2424]` |

- **Full width**: the bar starts at `x=0` in every state — the leading `+` now sits to the
  LEFT of where the rail ends (`x=190`). Before this change the bar began at `x=190`.
- **The rail is never covered**: its bounds and the band's are disjoint and adjacent in
  every state — the rail ends at exactly the y the band begins. Its last entry
  (`rail-create`) was pressed and opened the create sheet.
- **The keyboard inset holds**: with the IME up the band grew by the lift and the bar's
  bottom (`y=1521`) sits clear above it, with the transcript shrinking to match. Screenshot
  confirms the bar and both its controls fully visible, not merely present.
- **Multi-line**: a five-line draft grew the field upward, the bar stayed clear of the IME,
  the send arrow stayed pinned to the last line and the leading `+` stayed bottom-aligned.
- **Send still works from the band**: the multi-line draft was sent to the local instance
  and rendered as a delivered user bubble; the control swapped back to the mic.
- **The usage meter is untouched**: it is the tab band's bottom seam at `y≈403`, ~1750px
  above the composer. No overlap and no second seam.

### In the harness

`app/__tests__/composer-full-width-dock.test.tsx` (new, 5 tests) asserts the placement as
a containment question about real nodes: the bar is NOT a descendant of the
rail-constrained column, IS a descendant of the band, and the band is a SIBLING of the
rail row. Plus: send works from the band, the padded keyboard-inset node is the one
living in the band, and a screen with no composer draws an empty band.

**Mutation-tested.** Rendering `<InputComposer>` inline again (the pre-change placement)
turns the two placement tests red; the existing
`chat-keyboard-avoidance{,-android}.test.tsx` (14 tests) pass unchanged through the
docked path, which is what proves the lift survived the move rather than being re-pinned
to something that no longer holds the input.

### Not covered

- **iOS.** The measured-overlap path is unchanged in arithmetic and its container now has
  a strictly better claim to being window-bottom-anchored, but it has not been run on an
  iPhone. The harness covers the wiring on both platforms; the visual result is a device
  claim on iOS.
- **A rail long enough to SCROLL.** Nine extra projects were created to force it, but the
  host had become too loaded for Metro to serve a manifest inside the dev client's socket
  timeout, and the reload could not be completed. What IS settled is the geometry the
  concern rests on: the rail is a flex child of the row, and its measured bounds end
  exactly where the band begins in every state above, so the band cannot overlap a rail
  entry regardless of list length — a longer list scrolls rather than being clipped.

### Scope

JS only — no `app.json`, manifest, native module or dependency change. Ships over the air;
no native rebuild.

**SYSTEM-OVERVIEW.md changes: none.** No new HTTP surface, lifecycle behaviour, deploy
step, Core tier mechanic, onboarding phase or env flag; the doc does not describe the
project shell's internal layout.
