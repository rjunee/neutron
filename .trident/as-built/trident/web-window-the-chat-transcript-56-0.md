## 2026-08-31 — Web: the chat transcript mounts a trailing window of 100 messages, not the whole history

The owner measured 56,096 DOM nodes on the live web app
(`document.getElementsByTagName('*').length`), with Layout at 1,584.9 ms /
27.2% self time while typing — the largest bottom-up entry — and single
conversation-switch frames of 2,618 ms and 2,284 ms. The active surface
mounted EVERY message in the transcript; a mounted bubble costs full price at
Layout, Recalculate Style and Hit Test even when it never re-renders, so the
fix is fewer mounted nodes, not another memoization pass (re-render counts
were already fixed 2026-08-17 and are pinned by
`landing/chat-react/__tests__/switch-render-cost.test.tsx`).

`MountedConversationImpl` (`landing/chat-react/ChatApp.tsx`) now hands
`ConversationRuntimeHost` a WINDOWED view-model: the trailing
`TRANSCRIPT_WINDOW_MESSAGES = 100` messages, the number in exactly one
exported constant. Windowing at the runtime seam bounds the DOM of every
surface — the active one AND the up-to-8 hidden keep-alive ones — without
touching assistant-ui, the keep-alive cache, or the
`.car-conv[hidden] { display: none; }` rule. A "Load older messages (N more)"
control above the transcript extends the window by another 100; once used,
the window start is pinned BY MESSAGE ID so live arrivals grow the rendered
list instead of re-pointing index-keyed bubbles. In trailing mode arrivals
slide the window forward and the newest message is always mounted. The window
resets to trailing-100 on the deactivation edge (switch-away) through a
bail-out-safe updater, so an already-trailing surface schedules no render.
When the transcript has 100 or fewer messages the windowed array IS
`vm.messages` (identity preserved) — load-bearing for the #354 notify-storm
guard's adapter memo and switch-render-cost's conversions=0. Scroll does not
jump on load-older: viewport `scrollHeight`/`scrollTop` are captured at click
and restored pre-paint in a `useLayoutEffect` keyed on the runtime's rendered
length.

The bounded-count assertion is the deliverable and it is exact:
`landing/chat-react/__tests__/transcript-window.test.tsx` mounts a synthetic
2,000-message transcript and asserts 100 rendered `.car-row` bubbles of 2,000
(`toBe`, not `toBeLessThan` — an empty query fails), newest message on
screen, one load-older click giving exactly 200 with the previously-first
message still mounted, a live arrival on a pinned window giving 201,
switch-away shrinking the hidden surface back to 100, switch-back landing on
trailing-100, and a trailing-mode arrival holding 100 with the new message
mounted.

No deep-link-to-message and no in-page transcript-search path exists in
`landing/chat-react/` (grep for `scrollIntoView|getElementById|location.hash`
finds only the root lookup in `main.tsx`), so nothing older than the window
became unreachable. Deferred pending the owner's re-measure: an
IntersectionObserver auto-extend (the explicit control is the card's
requirement) and any `MAX_MOUNTED_CONVERSATIONS` revisit. No virtualization
library was added.
