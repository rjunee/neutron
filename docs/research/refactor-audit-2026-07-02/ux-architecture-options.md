# One UX across web + Expo app — architecture decision

Date: 2026-07-02 · Investigator: subagent (read-only audit)
Scope: `/Users/ryan/repos/neutron-open` (app/, landing/chat-react/, landing/server.ts, chat-core/, refactor plan)
All paths relative to repo root unless absolute. **[V]** = verified in code (file:line). **[I]** = inference / external knowledge, flagged.

---

## 0. Verdict (one paragraph)

**Recommendation: make the DOM client (`landing/chat-react`) the single canonical product UI, and convert the Expo app into a thin native shell (auth + push + deep-link routing) that hosts that same DOM UI — retiring the ~25–30k LOC of twin RN screens over time, with ONE deliberate carve-out decision (the native chat surface) gated on a small WebView-feel spike.** The native app is not published anywhere [V final-handoff-config.ts:49–53], today's mobile experience is already the web app added to the home screen [V landing/mobile.html:9], the M1 design investment and momentum are in chat-react (PRs #180–182), and the duplication tax is not hypothetical — PRs #178, #179 and #181 each landed the same feature twice, once per client [V git log below]. The refactor plan's W-phase should keep W1 (client-core dedup) as the no-regret first step, resolve W2/D-13 as **react-markdown** (with a shared-remark-AST + thin RN renderer fallback only if the native chat surface survives the spike), and add a new **W4 "Expo shell conversion"** unit sequenced after the current window.

---

## 1. Inventory — the two frontends

### 1.1 `app/` — the Expo client

- **Stack** [V app/package.json]: `expo ~54.0.33`, `expo-router ~6.0.23`, `react-native 0.81.5`, **`react-native-web ~0.21.0` already a dependency** (:36), `@op-engineering/op-sqlite 17.0.0` (:19), `@shopify/flash-list 2.3.2` (:21), `expo-notifications ~0.32.13` (:27), `expo-document-picker ~14.0.8` (:25), `expo-web-browser` (:31), `react-native-reanimated ~4.1.1` (:34), `@neutron/chat-core workspace:*` (:18).
- **Web output is already configured** [V]: `"build:web": "expo export --platform web"` (app/package.json:10) and `web: { bundler: "metro", output: "static" }` (app/app.json:19–22). The app was architected with a web target in mind: **20 source files carry `Platform.OS === 'web'` branches** [V grep], e.g. web file-input/drag-drop in the composer (app/components/InputComposer.tsx:120), localStorage token storage (app/lib/token-storage.ts), and the store fallback below.
- **Screens: 21 route files** [V find on app/app/]: `index`, `login`, `focus`, `settings`, `integrations`, `admin` (2,188 LOC), `cores/[slug]`, `projects/index`, and per-project `chat`, `docs` (2,426 LOC), `workboard`, `tasks`, `reminders`, `backups`, `launcher`, `settings`, `cores/[slug]`, `cores/dtc-analytics`, plus two `_layout`s.
- **Size: ~36,304 LOC** across app/app + app/components + app/lib [V wc].
- **Native-only modules and their web behavior** [V]:
  - `op-sqlite` is referenced in exactly ONE file, `app/lib/chat-core/op-sqlite-store.ts:1–16`, which documents **graceful degradation**: "op-sqlite is a native module — it is absent under RN-for-Web … silently falls back to chat-core's `InMemoryStore`". So on web the app *runs* but **loses chat durability** (web chat-react uses an OPFS store instead — landing/chat-react/main.tsx:11).
  - `expo-notifications` push is **explicitly excluded on web**: "Web is excluded — web push lands separately" (app/lib/push.ts:50–53); listeners are documented no-ops on web (push.ts:197–199).
  - `@shopify/flash-list` 2.3.2 lists `react-native-web` in its package metadata (app/node_modules/@shopify/flash-list/package.json:13) — **[I]** web support present but its v2 web path is the least battle-tested part of an Expo-web build; needs a runtime check.
- **The native chat surface is the repo's "Telegram-grade" one** [V app/components/ChatSyncSurface.tsx:1–22]: FlashList v2, durable local store, optimistic/offline send, gap-free resume, per-message delivery ladder (🕓→✓→✓✓→read), read receipts, reactions, edit/delete, streaming bubble — 885 LOC, plus `use-mobile-chat.ts` (280) and `mobile-session.ts` (420).
- **Markdown**: hand-rolled 908-line state-machine renderer, `app/lib/markdown-render.tsx`, with an explicit anti-dependency guard: "no markdown-it, no remark, no mdast. The lib stays dependency-free so the Expo bundle doesn't grow" (:11–13). URL allow-list sanitization (:62 `URL_ALLOW`).
- **Distribution status**: eas.json has development/preview/production channels [V app/eas.json], **but no native app is published**: "Native apps are not published yet — the page gives honest Add-to-Home-Screen instructions and coming-soon store placeholders" [V onboarding/interview/final-handoff-config.ts:49–53]; store rows render "coming soon" when URLs are empty [V landing/mobile-install-config.ts:44–49]. `/mobile` (landing/mobile.html:9) tells users to **install the web app to their home screen**.
- Monorepo wiring: metro watches the workspace root to resolve `@neutron/chat-core` [V app/metro.config.js:1–30].

### 1.2 `landing/chat-react/` — the React-DOM client

- **Stack** [V landing/package.json:7–15]: `@assistant-ui/react ^0.14.23`, `react-markdown ^9.0.1`, `remark-gfm ^4`, `rehype-sanitize ^6`, `jose`, `@neutron/chat-core workspace:*`. Deps live in `landing/node_modules` (leaf install).
- **Size: ~11,163 LOC including its 27 test files** [V wc]; UI core is ChatApp.tsx 1,530 + ProjectShell.tsx 509 + WorkBoardTab 845 + DocumentsTab 737 + SettingsTab 742 + IntegrationsTab 495 + controller.ts 1,184.
- **assistant-ui coupling is shallow**: exactly 3 files import it [V grep] — `ChatApp.tsx:17–26` (Thread/Message/Composer/MessagePart *primitives*, not styled components), `useNeutronChat.ts:13` (`useExternalStoreRuntime`), `message-adapter.ts:14` (a type). All styling is plain CSS.
- **Design system is plain CSS in the shell page**: `landing/chat-react.html`, 1,060 lines, ~208 `car-*` class references [V wc/grep], with a mobile breakpoint `@media (max-width: 720px)` (chat-react.html:376) and a `useMediaQuery` hook (ChatApp.tsx:796–806). Mobile browser is a supported mode today, not an afterthought.
- **Serving** [V landing/server.ts:1164–1179, 1244–1260]: server serves `chat-react.html` shell; `/chat-react.js` is either prebuilt or **lazily bundled from `chat-react/main.tsx` by `Bun.build` on first request** — i.e. an agent edits a .tsx file and the next page load rebuilds; no build pipeline. Auth: the shell is served at `/chat` **only behind the Claude-auth gate** (server.ts:1338–1366, landing/auth-gate.ts). Deep links `/projects[/…]` client-route through the SPA shell [V landing/spa-routes.ts:28–31].
- **Transport**: `WebChatSession` from chat-core over the **same `/ws/app/chat` surface the Expo app uses** [V landing/chat-react/config.ts:6, main.tsx:17]. Durable local store = OPFS with in-memory fallback [V main.tsx:11].
- **Markdown**: `Markdown.tsx`, 118 lines — react-markdown + remark-gfm + rehype-sanitize (default GitHub schema), doc-link click interception, frontmatter strip [V Markdown.tsx:30–37].

### 1.3 What is already shared

- `@neutron/chat-core` (4,805 LOC, repo-root leaf package [V chat-core/package.json, wc]) is consumed by BOTH clients [V app/package.json:18, landing/package.json:9]. It owns store/sync/send-queue/ws-client/session types — the transport+state layer is already unified. This is the plan's "chat-core precedent" [V plan:1101].
- Both clients speak the same app-ws envelope, but through **hand-maintained mirrors** (`app/lib/ws-envelope.ts`, `app/lib/doc-links.ts` 493 ↔ `runtime/doc-links.ts` 918 "byte-twin") that plan unit L6 deletes [V plan:465–476].

### 1.4 What is duplicated (the disease, measured)

- Twin HTTP clients: docs-client **867 ↔ 532**, work-board-client **381 ↔ 429**, tabs **115 ↔ 180**, project-credentials **150 ↔ 178**, plus overlapping integrations/codex-credential clients — plan W1 counts **~2,600 twin lines** and **16+8 duplicate error classes** [V plan:1094–1101; wc above confirms current sizes].
- Twin renderers: 908-line RN state machine vs 118-line react-markdown [V §1.1/§1.2] — the W2 problem.
- Twin *feature builds happening right now*: M1 commits `8e50f2c` (#178 play button), `d96c124` (#179 board bundle), `da0b308` (#181 work-list rows/chat formats) each touch **both** `app/` and `landing/chat-react/` [V `git log --oneline -- app/` ∩ `-- landing/chat-react/`]; `f04b3f6` (#182 rail + seated tabs) is chat-react-only. Every M1 UI feature is being paid for roughly twice, and #182 shows the web client pulling ahead — the drift the "one UX" ask is reacting to.

---

## 2. Options

### Option A — Expo universal app (react-native-web output replaces chat-react)

One codebase (`app/`), `expo export --platform web` produces a static bundle that `landing/server.ts` serves in place of `chat-react.html`/`chat-react.js`.

- **What already works for it** [V]: web target configured (app.json:19–22, build:web script), react-native-web already a dep (package.json:36), 20 files already branch for web, op-sqlite falls back gracefully (op-sqlite-store.ts:9–15), the feature set of app/ is a *superset* (reminders, tasks, focus, backups, launcher, admin — none exist as chat-react tabs [V ProjectShell tab list :22–23 shows Chat/Plan/Documents/Admin/cores only]).
- **What breaks / degrades**:
  - Chat durability on web regresses from OPFS to InMemory unless `createMobileStore` learns to use chat-core's `createWebStore` on web — small, since both implement the same `Store` interface [V op-sqlite-store.ts:9–15, main.tsx:17]. Cost: S.
  - `expo-notifications` has no web path (push.ts:50–53) — same as today (web push is deferred anyway), no regression.
  - assistant-ui (`useExternalStoreRuntime`, primitives) is DOM-only — the runtime adapter + thread composition must be replaced by the native surface's mechanics (which exist: ChatSyncSurface). Loss is small in code (3 files) but **the entire M1 redesign (#180–182: rail 2-line rows, seated tabs, work-list rows) is CSS in chat-react.html + DOM JSX and would be re-built in RN primitives** — re-doing work shipped days ago.
  - Desktop-grade information density (rail, hover states, text selection, keyboard shortcuts) in RN-web is achievable but consistently more expensive than CSS, and **[I]** LLM agents are markedly stronger at HTML/CSS than at RN styling for dense desktop layouts — a real velocity factor in an agent-built codebase.
- **Serving/deploy**: the lazy `Bun.build`-on-request loop (server.ts:1244–1260) dies; an `expo export` metro build step enters the deploy path. neutron-managed vendors the whole repo including `app/` [V ls vendor/neutron shows `app`] and today runs the landing server from source with zero client build pipeline — Managed's "deploy: vendor bump" flow would need to ship or produce a metro artifact. Cross-repo change is allowed now, but it's new machinery. **[I]** Bundle size: react-native-web + reanimated/worklets + FlashList web shims will exceed the current React+assistant-ui+react-markdown payload; unmeasured.
- **SSR/SEO: non-issue either way** — the product UI is auth-gated (server.ts:1338–1366); marketing SEO lives in the separate static `landing/index.html` [V ls landing/]. No SSR requirement exists.
- **Cost estimate**: XL — port ~4–5k LOC of DOM tab/rail UI to RN, re-verify every M1 behavior on 3 targets, new build pipeline in two repos, FlashList-web + keyboard QA. **4–8 weeks of agent runs with high regression risk to just-shipped M1 UI.** Payoff: true single codebase incl. future native apps.

### Option B — Shared headless core + two deliberately-thin platform UIs

Extend the chat-core precedent upward: W1 client-core (HTTP clients, one error type) + extract the view-model layer (chat-react's `controller.ts` is *already* platform-free by design: "fully unit-testable … without a DOM or a socket" [V controller.ts:16–26]; app's `use-mobile-chat`/state hooks are its twin). Keep RN JSX and DOM JSX as the only duplicated layer.

- **Pros**: no thrown-away investment on either side; keeps the genuinely-native chat feel (ChatSyncSurface) alive; every step is useful under any future decision (this is a strict subset of Options A *and* D).
- **Cons**: the duplication tax on the JSX/styles layer is permanent and *measured* (§1.4 — three of four M1 PRs built twice). "One UX" is approximated by discipline, not construction; the markdown-fidelity class of drift persists unless W2 also lands a shared pipeline. **[I]** For a single-owner, agent-built codebase, "keep two UIs in sync by convention" is exactly the kind of standing rule LLM builders erode over months.
- **Cost**: W1 as planned (L, ~2,600 lines deleted [V plan:1094–1101]) + vm extraction (M). Ongoing: every UI feature ≈ 1.6–2× cost (observed doubling in #178/#179/#181).

### Option C — Status quo + W1 only

Cheapest now; leaves twin renderers, twin screens, and the observed double-build in place. Rejected as a destination — it is Option B minus the parts that make Option B coherent.

### Option D — Web-canonical UI + Expo app as a thin native shell (**recommended**)

`landing/chat-react` becomes THE product UI for desktop web, mobile web, *and inside the app*: the Expo app keeps only what native is uniquely good at — login/auth handoff, `expo-notifications` push + deep-link routing (all already built: push.ts 359, push-deep-link-dispatch.ts, push-tap-dedupe-store.ts [V]), app-store presence — and hosts the DOM UI via a WebView (Expo DOM components, `'use dom'`, SDK 52+ **[I — verify against docs.expo.dev/versions/v54; app is SDK 54]**, or a plain `react-native-webview` screen).

- **Why it fits THIS codebase**:
  1. The native app is unpublished; the shipped mobile UX **is already the web app** on the phone (mobile.html:9 "add the web app to your home screen"). Option D regresses nothing that users have.
  2. The M1 design system (1,060-line CSS shell, PRs #180–182) is preserved, and "one UX" holds **by construction** — same DOM, same CSS, same bundle on all three surfaces.
  3. Agent velocity: one feature = one implementation, and the edit loop stays the lazy `Bun.build` reload (server.ts:1244–1260) — the simplest possible convention for LLM builders.
  4. Deletes the largest redundant surface in the repo: the twin RN screens (docs.tsx 2,426; admin 2,188; ProjectSettingsDrawer 1,298; backups 1,269; workboard/settings/integrations/… — ~25–30k of app/'s 36k LOC) once the shell hosts the DOM UI.
  5. chat-core keeps both worlds honest: if WebView chat feel is ever inadequate, the native ChatSyncSurface (which already exists and shares the same session/store layer) can be re-mounted as a native override for the one screen where native matters — a contained, reversible carve-out rather than a fork.
- **Honest risks**:
  - **Telegram-class bar**: a WebView chat won't match native keyboard/scroll feel. Mitigation: (i) it's identical to today's shipped mobile experience; (ii) gate the conversion on a 1–2-day spike — host `/chat` in an Expo WebView on a real iPhone, test keyboard insets, scroll at 1k messages, paste/file-picker; (iii) the carve-out above. **[I]** iOS WKWebView keyboard handling is the known weak spot; `visualViewport`-based composer pinning in chat-react is the standard fix and is needed for mobile Safari anyway.
  - Auth token handoff into the WebView (session cookie or `?start=` token — both mechanisms exist server-side [V landing/session-cookie.ts, server.ts gate]) and push-tap → SPA deep link mapping (the SPA already client-routes `/projects/...` [V spa-routes.ts:28–31]). Design work, not research work.
  - Web push for mobile-browser users stays deferred (as today, push.ts:52); the shell restores native push.
- **Cost estimate**: Spike **S** (1–2 days). Shell conversion **M** (~1–2 trident runs: WebView host screen, auth handoff, push deep-link remap, store-listing chrome). Twin-screen retirement: mechanical deletions in slices, **S each**, −25k LOC. Mobile-web polish pass on chat-react (keyboard/safe-area) **S–M**. **Total ≈ 1.5–3 weeks of agent runs**, mostly parallelizable, none of it blocking M1.

---

## 3. The markdown-fidelity problem specifically

- **Today**: the same agent body renders through a 908-line hand parser on RN (subset grammar, "anything outside the subset falls through as plain text", allow-list URL check — markdown-render.tsx:5–18) and through react-markdown + rehype-sanitize on web (full GFM, HAST sanitization — Markdown.tsx:30–37). Two grammars, two sanitizers ⇒ guaranteed divergence; that's plan W2/D-13 [V plan:1103–1108, 1275].
- **Under Option A**: converge on the RN pipeline; the web loses GFM completeness unless the hand parser grows — the wrong direction (it exists only to avoid remark in the Expo bundle, :11–13).
- **Under Option D**: converge on react-markdown; **delete markdown-render.tsx** when the RN chat surface retires. If the native-chat carve-out survives the spike, use the middle path below for that one surface.
- **Shared-AST middle path (exists, real)**: remark/mdast is platform-free — `react-markdown` is just unified(remark-parse → remark-gfm → hast + sanitize) plus a DOM component map. A thin RN renderer can walk the same **mdast** (or sanitized hast) and emit `Text`/`View`/`Pressable` — roughly the render-dispatch half of the current file (~300–400 lines) with the 500-line parser deleted and the grammar+sanitizer unified. **[I]** Bundle cost of micromark+mdast in the Expo bundle is tens of KB, not meaningful at this app's size; the original "no remark" guard was a P5.1 sprint rule, not a measured constraint. This is the correct W2 answer *whenever any RN markdown surface survives*; D-13's "react-markdown + RN-compatible port" recommendation [V plan:1275] is compatible with it.

---

## 4. Ranked recommendation

| Rank | Option | Verdict |
|---|---|---|
| **1** | **D — web-canonical UI + Expo thin shell** | One UX by construction; preserves M1 investment; biggest LOC deletion; agent-simplest convention; reversible carve-out for native chat. Gate on the WebView spike. |
| 2 | B — shared headless core, two thin UIs | The no-regret subset of D (and of A); becomes the destination ONLY if the spike fails hard on chat feel AND native feel is deemed launch-critical. Permanent 2× UI tax. |
| 3 | A — Expo universal via RN-web | Right answer only if native-first distribution becomes the pre-launch strategy; re-does the just-shipped web redesign, adds a metro artifact pipeline to both repos, XL cost, desktop-quality ceiling. |
| 4 | C — status quo + W1 | Not a destination. |

Decision points Ryan should still own (all cheap, sequenced): (1) spike verdict on WebView chat feel; (2) keep-or-retire ChatSyncSurface after the spike; (3) timing of W4 relative to native-app store submission.

## 5. What the refactor plan's W-phase should become

Current: W1 client-core (plan:1094), W2 markdown decision (:1103), W3a resume fidelity (:1110), W3 transcript unification (:1120).

- **W1 — keep, re-aim**: client-core shared package as scoped, but declare **web modules canonical** when collapsing each twin (the app imports from client-core; where the pair diverges, the chat-react behavior wins unless a test says otherwise). Add: extract the platform-free vm layer (controller.ts pattern) into the same package — under Option D this is what the shell-era app keeps using for any surviving native screen.
- **W2 — resolve D-13 now = react-markdown**; snapshot tests on web. Freeze `app/lib/markdown-render.tsx` (no new grammar) immediately; its fate is decided by the W4 spike — retired with the RN chat surface, or replaced by the shared remark-AST + ~300-line RN renderer (§3) if native chat survives.
- **W3a / W3 — unchanged** (transport fidelity benefits every client and the shell most of all).
- **Add W4 — Expo shell conversion** (new, after the current window or wave 9–10): (a) S spike: host `/chat` in an Expo WebView/DOM-component on device, QA keyboard+scroll+upload; (b) shell PR: auth handoff, push deep-link → SPA route map, retire expo-router twins slice-by-slice (−25–30k LOC); (c) chat-surface carve-out decision recorded as a D-row. Acceptance: one UI codebase renders on desktop web, mobile web, and in the app; `app/` contains only shell + push + (optionally) ChatSyncSurface.
- **Add one small clients-lane unit — mobile-web polish**: chat-react keyboard/visualViewport/safe-area pass (S–M); required for Option D's mobile bar and useful regardless.
- **L6/L7 interactions**: unchanged; note that `app/lib/doc-links.ts` and `ws-envelope.ts` mirrors (L6 deletions, plan:465–476) mostly die with the retired screens anyway — L6 should still land first so the shell period has one wire-type source.

---

## Appendix — key verified facts index

| Claim | Evidence |
|---|---|
| Native apps unpublished; mobile = A2HS web app | final-handoff-config.ts:49–53; mobile.html:9; mobile-install-config.ts:44–49 |
| Both clients share chat-core + `/ws/app/chat` | app/package.json:18; landing/package.json:9; chat-react/config.ts:6; main.tsx:17 |
| app/ web-ready scaffolding | app/package.json:10,36; app.json:19–22; op-sqlite-store.ts:9–15; 20 files w/ `Platform.OS === 'web'` |
| Web serving = lazy Bun.build, auth-gated SPA | landing/server.ts:1164–1179, 1244–1260, 1338–1366; spa-routes.ts:28–31 |
| Twin clients ~2,600 lines; twin renderers 908↔118 | plan:1094–1108; wc on both trees |
| M1 features built twice | commits 8e50f2c/#178, d96c124/#179, da0b308/#181 in both `git log -- app/` and `-- landing/chat-react/`; f04b3f6/#182 web-only |
| assistant-ui coupling = 3 files, unstyled primitives | ChatApp.tsx:17–26; useNeutronChat.ts:13; message-adapter.ts:14 |
| Native chat surface is the Telegram-grade one | ChatSyncSurface.tsx:1–22 |
| Managed vendors app/ too; no client build pipeline today | ls neutron-managed/vendor/neutron (contains `app`, `landing`, …) |
