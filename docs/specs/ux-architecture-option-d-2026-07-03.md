# UX architecture decision — Option D (single canonical web UI + thin native shell)

**Status:** DECIDED (2026-07-03, refactor decision D-13; Fable's delegated call).
This is unit **W0** of the world-class refactor — it RECORDS the decision and
scopes the follow-on W-units; it ships no product code. Execution detail (per-unit
acceptance, file anchors) lives in
[`docs/plans/2026-07-02-world-class-refactor-plan.md`](../plans/2026-07-02-world-class-refactor-plan.md)
§W0–§W6; this spec is the discoverable summary.

## Decision

`landing/chat-react` is the **single canonical product UI** — desktop web, mobile
web, AND inside the app via a WebView / Expo-DOM shell. The Expo app becomes a
**thin native shell**: auth-token handoff, `expo-notifications` push, and
deep-link → SPA route mapping. This retires ~25–30k LOC of twin React-Native
screens.

## Why it wins on THIS codebase

- The native app is **unpublished** — today's mobile UX is literally the web app
  added to the home screen (`landing/final-handoff-config.ts:49-53`).
- `react-native-web` is already a dependency and the web export is already
  configured.
- Transport/state is **already unified** on `@neutronai/chat-core` over one
  `/ws/app/chat` — there is no second sync engine to reconcile.
- Every UI feature currently ships **twice** (M1 PRs #178/#179/#181 each touched
  both `app/` and `landing/chat-react`). Option D collapses that tax.

## Rejected alternative

**Expo-universal via react-native-web** — would rebuild the just-shipped M1 CSS/DOM
redesign in RN primitives and replace the `Bun.build` serve loop with a metro
artifact pipeline in both repos. 4–8 weeks, XL risk. Rejected.

## Follow-on units (scoped in the plan)

- **W1** — client-core shared package (web-canonical): one `GatewayHttpClient` base
  + per-surface modules + the platform-free view-model layer; collapse each twin
  client pair toward the web module. (~2,600 twin lines deleted.)
- **W2** — converge markdown on react-markdown; freeze the 908-line hand RN
  renderer pending the W4 spike.
- **W5** — `[BEHAVIOR]` chat-core connection resilience (Telegram-bar hardening).
  **Pull early — independent of the shell**; repairs live socket-resilience for
  every surface at once.
- **W4** — `[BEHAVIOR]` Expo shell conversion (XL, LATE/post-window): host `/chat`
  in a WebView, retire the ~21 twin RN screens slice-by-slice. Gated on the spike.
- **W6** — `[BEHAVIOR]` native-shell ↔ WebView resilience bridge (**Architecture
  B**): the shell injects the phone-lifecycle signals a WKWebView cannot see
  (appState, reachability, push, a **shell-owned `device_id`**) over a tiny
  serializable `postMessage` bridge feeding the W5 hooks. One sync core, one socket
  either way.

## The WebView spike (scheduled by this unit; decides native-vs-WebView)

The spike must test the two things that actually decide the outcome:

1. **Chat feel** — keyboard insets, scroll performance at ~1k messages,
   paste / file-picker.
2. **Telegram-bar offline durability** — airplane-mode toggle mid-conversation,
   wifi↔cellular handoff, and a **cold WebView kill while a message sits queued
   offline**: does the OPFS transcript + the un-sent message survive an iOS
   WKWebView suspend/reload?

**Reversible carve-out:** if the spike shows WebView chat feel or cold-kill
durability is inadequate, the native `ChatSyncSurface` (885 LOC, Telegram-grade
delivery ladder) is kept as a native surface (W4c) — the SAME W6 bridge then feeds
a native-owned chat-core instead of the web-owned one. Record that as a new
decision row when the spike resolves.

## Acceptance (W0)

Decision recorded (here + plan §W0); spike scoped to chat-feel AND offline
durability; W1/W2/W4/W5/W6 scoped. No product code in this unit.
