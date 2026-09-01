# IMPLEMENTATION_PLAN.md — re-activation scroll restore (owner-confirmed 2026-09-01)

Card: switching into a kept-alive conversation lands ~100 messages back. `.car-conv[hidden]` is
`display:none`, which destroys the scroll box; nothing restores it on re-activation, and
assistant-ui's auto-scroll is `isAtBottom`-gated so it deliberately declines to act at scrollTop 0.
Owner-specified behaviour: land at the BOTTOM, or at the last unread message. Base MUST be
`origin/main` @ `e651cc3e` (local `main` at 187a9209 predates #481 and has no windowing symbols).

- [x] Transcript window (#481): `TRANSCRIPT_WINDOW_MESSAGES = 100`, `olderAnchorId` pinning +
      switch-away reset, `LoadOlderMessages` scroll anchoring keyed on the runtime's rendered
      count — all present on origin/main and pinned by `transcript-window.test.tsx` +
      `switch-render-cost.test.tsx`. DO NOT touch the window size or `.car-conv[hidden]` CSS.
- [x] **Re-activation scroll restore (bottom default + deliberate-scroll-back position).** New
      `ViewportActivationRestore` component inside `ThreadPrimitive.Viewport` (beside
      `LoadOlderMessages`): a passive scroll listener captures `{scrollTop, atBottom, count}` into
      a ref while ACTIVE (capture-on-the-way-out — by switch-away the DOM already reads 0); a
      `useLayoutEffect` keyed on `[active, renderedCount, windowLength]` arms a pending target on
      the `false → true` edge (position when a valid non-bottom capture exists over unchanged
      content, else bottom) and applies it pre-paint; bottom stays armed until the runtime count
      settles to the live windowed length so the adapter's one-commit-late apply re-pins it, then
      clears so later arrivals never yank a reading user. Fix BOTH prose sites that claim scroll
      already survives (`MountedConversationImpl` docblock "hidden when inactive, so its scroll
      position + composer draft survive"; ChatApp FIX #343 comment "keeps per-project scroll +
      draft"). New test `activation-scroll-restore.test.tsx` with the required MUST-FAIL control
      (bottom on switch-back) and the must-pass scrolled-back sibling; `switch-render-cost.test.tsx`
      and `transcript-window.test.tsx` must stay green unmodified. AS_BUILT entry.
- [ ] **Unread anchoring (precedence 2).** The unread count is per-project only
      (`ProjectTab.unread`, config.ts) and `controller.setProject` zeroes it SYNCHRONOUSLY before
      publishing — so it must be captured from the PREVIOUS frame, not read at activation: in
      ChatApp's render body keep a ref map `convId → last unread seen while NOT active` (render-phase
      ref write, same sanctioned pattern as `cacheRef`; skip the entry for the current `convId` so
      the switch frame cannot overwrite the pre-clear value; covers surfaces not yet mounted, which
      an in-surface edge capture cannot). Pass the STABLE ref through `MountedConversation` →
      `ChatSurface` → `ViewportActivationRestore` (stable identity — no memo bust, no new renders
      on a switch). Add a pending target `{kind:'unread', n}` chosen at the edge when there is no
      deliberate scroll-back capture and captured `n ≥ 1`: apply BOTTOM at the activation commit
      (the unread rows are, by the badge's own meaning, absent from the cached transcript), then on
      the settle commit anchor the n-th-from-last non-typing `.car-row` (exclude the row containing
      `.car-typing`; one `MessagePrimitive.Root` per message, 1:1) at the viewport top via
      rect-delta math; `n` outside `1..rows.length` → bottom; clear pending after resolving.
      Tests: boot the controller with `projects: [{id:'alpha', …, unread: N}]`, prove the trap (live
      `vm.projects` reads 0 after `setProject`) and that the anchor still lands; rect stubs supply
      geometry (happy-dom has none).

After the top task, 1 task remains (unread anchoring).
