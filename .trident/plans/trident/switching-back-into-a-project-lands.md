# IMPLEMENTATION_PLAN.md — re-activation scroll restore (owner-confirmed 2026-09-01)

Card: switching into a kept-alive conversation lands ~100 messages back. `.car-conv[hidden]` is
`display:none`, which destroys the scroll box; nothing restored it on re-activation, and
assistant-ui's auto-scroll is `isAtBottom`-gated so it deliberately declines to act at scrollTop 0.
Owner-specified behaviour: land at the BOTTOM, or at the last unread message.

Resume state (round 4, Argus fix round 2): branch `trident/switching-back-into-a-project-lands`,
base `origin/main` @ `e651cc3e`, published as PR #497. Argus's first review returned five blockers,
four of them against the unread anchor that landed in `bad101e3`, plus a major against the position
restore's validity guard. This round takes the path Argus's own closing note names: **drop the
unread precedence to its own card and fix what the bottom-default restore got wrong.**

- [x] Transcript window (#481): `TRANSCRIPT_WINDOW_MESSAGES = 100`, `olderAnchorId` pinning +
      switch-away reset, `LoadOlderMessages` anchoring — all on origin/main, pinned by
      `transcript-window.test.tsx` + `switch-render-cost.test.tsx`. DO NOT touch the window size
      or `.car-conv[hidden]` CSS.
- [x] Re-activation scroll restore (bottom default + deliberate-scroll-back position):
      `ViewportActivationRestore` inside `ThreadPrimitive.Viewport` captures on the way out via a
      passive scroll listener and restores pre-paint on the `false → true` edge in a
      `useLayoutEffect` keyed on the RUNTIME's rendered count; both lying prose sites corrected.
- [x] **The position guard is by HEAD MESSAGE ID, not by rendered count.** At the window cap the
      count is 100 on both sides of a window movement, so it is blind exactly when the window is
      full — and it is blind to the card's own `olderAnchorId`-reset rule, where a loaded-older
      surface returns re-trimmed and the reader's offset points into a slice that no longer exists.
      Re-checked on every armed commit, because the runtime applies the trimmed list one commit
      late. Falls back to the BOTTOM, never to an arbitrary offset.
- [x] **A restore never spends itself on a viewport with no layout box.** `ProjectShell` resets the
      tab to Chat in a PASSIVE effect, so a cross-project switch made from another tab runs this
      LAYOUT effect while `.car-tabpanel[hidden]` still makes the viewport `display: none`
      (`scrollHeight` 0, `scrollTop` writes discarded). While a `[hidden]` ancestor is present the
      restore applies nothing and clears nothing, re-checking at frame cadence for up to a second.
- [x] Tests: four cases in `activation-scroll-restore.test.tsx`, all four assertion-level RED
      against `origin/main` @ `e651cc3e` — bottom control, scrolled-back sibling, cross-tab reveal,
      re-trimmed window → bottom. The harness wraps `ChatApp` in the same `.car-tabpanel`
      ProjectShell renders and the geometry stub reports ZERO under a `[hidden]` ancestor, which is
      what a browser does and what stops the cross-tab case passing vacuously.
      `switch-render-cost.test.tsx` and `transcript-window.test.tsx` stay green UNMODIFIED.
- [ ] **Unread anchoring (precedence 2) — DEFERRED to its own card, deliberately.** Reverted from
      this branch. Three things have to be settled before it can ship, and none of them belongs in
      a bottom-default fix: (a) the badge counts AGENT messages past the read receipt
      (`gateway/projects/sqlite-store.ts`) while any row-indexed anchor counts ALL rows, so at the
      cap the two disagree by however many user messages are in the window; (b) at the cap the
      unread rows are, by the badge's own meaning, not in the cached transcript the surface is
      still showing, so anchoring on the first settled commit anchors the STALE window; (c) the
      trap stands and is already written down — `controller.setProject` zeroes the count
      SYNCHRONOUSLY before publishing the switch frame, so it must be captured on the
      `false → true` edge, not read inside the activation effect. The card sanctions this split:
      "Ship bottom-by-default even if unread anchoring lands separately."
- [ ] **The late-slide residual — NOT guarded, on the record.** `setProject` paints the CACHED
      transcript first, so a switch into a project that received messages while the user was away
      can match the head at every armed commit and change only after the target has cleared. Every
      mechanism for it has to tell a slide during the switch from a slide while the reader reads,
      and the late one is exactly the one the component cannot see. Left unguarded rather than
      guarded by an untestable heuristic; `tests/e2e-browser` is where it belongs, because under
      happy-dom the outcome is indistinguishable (assistant-ui's auto-scroll takes an un-scrolled
      viewport to the bottom on the same commit — the masking Argus's reviewer B identified).
