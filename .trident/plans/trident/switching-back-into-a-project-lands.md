# IMPLEMENTATION_PLAN.md — re-activation scroll restore (owner-confirmed 2026-09-01)

Card: switching into a kept-alive conversation lands ~100 messages back. `.car-conv[hidden]` is
`display:none`, which destroys the scroll box; nothing restored it on re-activation, and
assistant-ui's auto-scroll is `isAtBottom`-gated so it deliberately declines to act at scrollTop 0.
Owner-specified behaviour: land at the BOTTOM, or at the last unread message.

Resume state (round 3): branch `trident/switching-back-into-a-project-lands` @ `ed95b495`, exactly
one commit on top of `origin/main` @ `e651cc3e`, published as PR #497 (OPEN, MERGEABLE, 0 reviews).
Requirements 1/3/4 of the card shipped in that commit and MUST NOT be redone. Round-3 decision:
the run was relaunched with budget to finish the card, so the one unchecked task (unread anchoring,
precedence 2) builds NOW, as one more commit on the SAME branch/PR — this does not hold the merge
(Argus reviews the whole card this run) and it completes the owner's full ask ("at the bottom or at
least the last unread message"). Persist this plan to
`.trident/plans/trident/switching-back-into-a-project-lands.md` (NOT root IMPLEMENTATION_PLAN.md,
which carries the merged watchdog card's history on main).

- [x] Transcript window (#481): `TRANSCRIPT_WINDOW_MESSAGES = 100`, `olderAnchorId` pinning +
      switch-away reset, `LoadOlderMessages` anchoring — all on origin/main, pinned by
      `transcript-window.test.tsx` + `switch-render-cost.test.tsx`. DO NOT touch the window size
      or `.car-conv[hidden]` CSS.
- [x] Re-activation scroll restore (bottom default + deliberate-scroll-back position) — shipped in
      `ed95b495`: `ViewportActivationRestore` inside `ThreadPrimitive.Viewport` captures
      `{scrollTop, atBottom, count}` on the way out via a passive scroll listener and restores
      pre-paint on the `false → true` edge in a `useLayoutEffect` keyed on the RUNTIME's rendered
      count; both lying prose sites corrected; `activation-scroll-restore.test.tsx` carries the
      must-fail bottom control + the scrolled-back sibling; AS_BUILT entry staged.
- [x] **Unread anchoring (precedence 2) — THIS ITERATION.** The unread count is per-project only
      (`ProjectTab.unread`, config.ts) and `controller.setProject` zeroes it SYNCHRONOUSLY before
      publishing the switch frame, so the activating render already reads 0 — capture it from
      PRIOR frames: in ChatApp's render body keep `unreadRef: Map<convId, number>`, written every
      render for every project EXCEPT the currently-active convId (render-phase ref write, the
      same sanctioned pattern as `cacheRef`; the skip is what stops the switch frame overwriting
      the pre-clear value, and mirrors the rail's own `activeId === p.id ? 0` forcing). Thread the
      STABLE ref + the surface's `convId` through `MountedConversation` → `ChatSurface` →
      `ViewportActivationRestore` (stable identities — memo untouched, no new renders, no new aui
      subscriptions). Edge decision becomes: non-bottom capture → `position`; else captured
      `n ≥ 1` → `{kind:'unread', n}`; else `bottom` (so unread beats an at-bottom capture, and a
      deliberate scroll-back still beats unread). DECIDED resolve semantics: while
      `renderedCount !== windowLength || renderedCount === 0` apply bottom and STAY ARMED; at the
      first settled non-zero commit anchor the n-th-from-last non-typing `.car-row` (exclude rows
      containing `.car-typing`) at the viewport top via rect-delta, `n` outside `1..rows.length`
      → bottom, then CLEAR (no lingering target may ever yank a reader later). Anchoring at the
      settle commit is correct for a stale badge (current content IS the truth) and converges on
      the first unread for the at-cap kept-alive path (the trailing window drops as many rows off
      the front as it appends, shifting content up under the fixed scrollTop by the same height);
      the cold-path race with aui's initial auto-scroll degrades to bottom = the card's floor.
      Test: third case in `activation-scroll-restore.test.tsx` — kept-alive switch-back with a
      `projects_changed` frame fanned through the active session's `sinks.onFrame` while away,
      instance-level rect stubs, proof that the LIVE count reads 0 after `setProject` yet the
      anchor lands at exactly the n-th-from-last row. Must be RED (assertion-level, expecting 700
      and seeing the bottom) before the ChatApp edit and green after; cases 1–2,
      `switch-render-cost.test.tsx` and `transcript-window.test.tsx` stay green UNMODIFIED.
      Extend the existing 2026-09-01 AS_BUILT entry (one entry per merged change — same PR).
