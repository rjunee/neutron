# Subsystem map: web-client (`landing/`)

Audit date: 2026-07-02. All paths relative to `/Users/ryan/repos/neutron-open`.

## 1. Purpose & responsibilities

`landing/` is four different things wearing one package name (`@neutronai/landing`):

1. **The web chat client** — `landing/chat-react/` — a React 19 + assistant-ui SPA served at `GET /chat`, talking to the gateway's `/ws/app/chat` socket via the shared `@neutronai/chat-core` sync engine. This is the primary product surface for an Open self-host install (tabbed shell: Chat / Plan / Documents / Admin / Core webviews).
2. **The landing HTTP server** — `landing/server.ts` (`createLandingServer`) — a `{fetch, websocket}` pair composed into the gateway process. Serves the SPA shell, lazily bundles the client with `Bun.build`, plus `/start` token rewrite, `/mobile`, brand assets, sign-up redirect, invite routes, the Claude-auth gate page.
3. **An auth library** — `session-cookie.ts` (HMAC 30-day session cookie), `auth-gate.ts` (HTTP auth gate decision tree), `spa-routes.ts` — consumed by `gateway/http/compose.ts`, `gateway/http/cookie-user-claim.ts`, and `open/composer.ts`.
4. **The de-facto chat wire-protocol type home** — `ChatOutbound` / `ChatBridge` / `PendingChatClaim` in `server.ts` are imported by 7 non-test production files across `gateway/`, `reminders/`, `open/`, `channels/` even though the landing server itself no longer runs any WebSocket.

Key historical fact (verified, not just repeated from the brief): **the vanilla `chat.html`/`chat.ts` client and the `NEUTRON_WEB_CHAT_CLIENT` flag were DELETED** ("P0b 2026-06-26", `server.ts:1158-1169`). React is the only web client; `grep NEUTRON_WEB_CHAT_CLIENT` matches only a comment in `server.ts`, `AS-BUILT.md`, and two docs. The audit brief's "React client behind NEUTRON_WEB_CHAT_CLIENT flag" is stale. The deletion stranded a large amount of code and metadata (see § 6).

## 2. Module inventory

### Package root (`landing/`)

| File | LOC | Status |
|---|---|---|
| `server.ts` | 1,516 | LIVE (route table) + ~900 lines of legacy WS types/machinery, part dead, part load-bearing contract docs |
| `auth-gate.ts` | 655 | LIVE — consumed by gateway compose chain |
| `upload-client.ts` | 590 | LIVE — chunked import-ZIP upload, used by `chat-react/uploads.ts` |
| `connect-relay.ts` | 351 | **DEAD** — zero importers (consumers were `chat.ts`/`invite.ts`, both gone) |
| `boot.ts` | 319 | DORMANT in Open — Managed platform signup process entrypoint (`bun run landing/boot.ts` under a Managed systemd unit); only server of `index.html`/`og/`/`logo.svg` |
| `connect-accept.ts` | 239 | **DEAD** — nothing imports it and nothing serves `connect-accept.html` (grep: no code references) |
| `connect-disclosure.ts` | 163 | **DEAD** — only importer is dead `connect-accept.ts` |
| `session-cookie.ts` | 141 | LIVE — gateway + open composer |
| `markdown.ts` | 128 | ~DEAD — the chat-bubble renderer lost its consumer (`chat.ts`); only `escapeHtml` is still imported (`mobile-install-config.ts:18`) |
| `start-token-topic-id.ts` | 124 | **DEAD** — zero non-test importers; its documented consumer `landing/chat.ts:resolveUploadTopicId` is deleted |
| `mobile-install-config.ts` | 83 | LIVE — `/mobile` page store links (all constants empty = "coming soon") |
| `spa-routes.ts` | 31 | LIVE — SPA deep-link predicate shared with gateway compose |
| `chat-react.html` | 903 | LIVE — SPA shell: entire design system as one inline `<style>`, pre-paint theme script, token/debug bootstrap script |
| `index.html` | 393 | DORMANT in Open — marketing page served only by `boot.ts` |
| `mobile.html`, `onboarding-telegram.html`, `connect-accept.html` | — | `/mobile` live; telegram page Managed-flow; connect-accept dead |

### React client (`landing/chat-react/`)

| File | LOC | Role |
|---|---|---|
| `ChatApp.tsx` | 1,344 | God component: ~25 components (attachment image auth-fetch, text/markdown parts, reactions, edit/delete actions, button prompts + gallery, drop-zone, import status, typing indicator, connection banner, `TopicRail`, composer, `ChatSurface`, per-conversation runtime host) |
| `controller.ts` | 1,076 | `NeutronChatController` — framework-agnostic glue: chat-core session ↔ assistant-ui view-model; streaming partial accumulation; frame dispatch; import progress; work-board cache |
| `SettingsTab.tsx` | 742 | Admin/integrations/credentials settings surface |
| `DocumentsTab.tsx` | 737 | Doc tree + editor + comments |
| `WorkBoardTab.tsx` | 670 | Plan tab (Work Board) |
| `docs-client.ts` | 532 | Web docs API client (twin of `app/lib/docs-client.ts`, 867) |
| `IntegrationsTab.tsx` | 495 | Integrations UI |
| `ProjectShell.tsx` | 478 | Top-level layout: persistent TopicRail + TabBar + tab bodies; keeps ChatApp mounted across tabs |
| `uploads.ts` | 344 | Attachment/import upload glue (wraps `../upload-client.ts`) |
| `work-board-client.ts` | 311 | Twin of `app/lib/work-board-client.ts` (215) |
| `config.ts` | 259 | Bootstrap config from `window.__neutron_*` globals + JWT sub decode |
| `HtmlDoc.tsx` | 192 | Static HTML doc rendering |
| `tabs-client.ts` | 180 | Tab resolver client (twin: `app/lib/project-tabs.ts`) |
| `project-credentials-client.ts` | 178 | Twin of `app/lib/project-credentials-client.ts` |
| `integrations-client.ts` | 169 | Integrations API client |
| `useNeutronChat.ts` | 167 | React seam: controller vm → `useExternalStoreRuntime` |
| `useAttachmentDraft.ts` | 158 | Composer attachment drafts |
| `codex-credential-client.ts` | 147 | Codex credential client |
| `Markdown.tsx` | 118 | react-markdown + rehype-sanitize bubble renderer |
| `theme.ts` / `useTheme.ts` / `ThemeToggle.tsx` | 116/~60/~50 | Light/dark theme (mirrored by pre-paint script in shell) |
| `main.tsx` | 110 | Entry point: config → OPFS store → controller → ProjectShell |
| `doc-link-nav.ts` | 107 | `docs:` deep-link parse/nav |
| `message-adapter.ts` | 88 | `RenderMessage` → assistant-ui `ThreadMessageLike` |

Total `landing/` source ≈ 26k LOC including tests; non-test client ≈ 8.5k.

## 3. Public seams other subsystems consume

1. **`ChatOutbound` discriminated union** (`server.ts:203-516`) — THE chat envelope contract. Non-test importers: `gateway/http/chat-bridge.ts:45`, `gateway/http/recovered-reply-store.ts:51`, `gateway/proactive/button-store-sink.ts:36`, `gateway/realmode-composer/build-live-agent-turn.ts:67`, `reminders/outbound.ts:24`, `open/composer.ts:214`, plus `channels/adapters/app-ws/envelope.ts` + `adapter.ts` (translate to app-ws frames).
2. **`ChatBridge` interface** (`server.ts:546-699`) — implemented by `gateway/http/chat-bridge.ts` (`buildWebChatBridge`) and driven by the app-ws surface. Its JSDoc IS the behavioral spec: atomic jti claim in `startSession`, identity-aware sender unregister by send-lambda reference equality, `getActiveTopicId` re-read race guard, cookie-resume hook.
3. **`createLandingServer` / `LandingServer`** (`server.ts:935-938,1156`) — composed by `gateway/realmode-composer/build-landing-stack.ts:78` and threaded through `open/composer.ts`'s `openFetch` wrapper.
4. **`session-cookie.ts`** (`formatSetCookie`, `readSessionCookie`, `signSessionCookie`) — `open/composer.ts`, `gateway/http/cookie-user-claim.ts`, `auth-gate.ts`.
5. **`auth-gate.ts`** — `gateway/http/compose.ts`, `gateway/composition/input/auth-input.ts`.
6. **`isSpaClientRoute`** (`spa-routes.ts`) — `gateway/http/compose.ts`, `open/composer.ts`.
7. **`MOBILE_APP_URL`** — re-exported from `onboarding/interview/final-handoff-config.ts` at `server.ts:41`.
8. **Client-server bootstrap contract** — `window.__neutron_user_id`, `__neutron_projects`, `__neutron_active_project_id`, `__neutron_onboarding_active`, `__neutron_post_onboarding_claim_url`, `__neutron_app_ws_token`, `__neutron_app_ws_url`, `__neutron_start_token` (`chat-react/config.ts:108-118`), injected by `open/composer.ts:1555-1630` via string-replace on the shell HTML.

## 4. Workspace dependencies

**Out (landing imports):**
- `../runtime/start-token-types.ts` (`auth-gate.ts:55`), `../runtime/constant-time-equal.ts` (`session-cookie.ts:30`)
- `../onboarding/interview/final-handoff-config.ts` (`server.ts:41`) — edge → product-surface, wrong direction
- `@neutronai/chat-core` (workspace) — session/sync/store for the React client
- npm: `@assistant-ui/react`, `react`/`react-dom` 19.1, `react-markdown`, `rehype-sanitize`, `remark-gfm`, `jose` (declared in `landing/package.json`; installed under `landing/node_modules`)

**In (who imports landing):** gateway (7+ files), open/composer, reminders, channels/app-ws, connect (comments only). The Expo app does NOT import landing (it has its own parallel clients — see § 6.3).

**`package.json` `"main": "./chat.ts"`** points at a deleted file (`landing/package.json:4`).

## 5. Internal layering (React client, actual and mostly clean)

```
main.tsx → config.ts (pure) → NeutronChatController (controller.ts, DI session factory)
        → ProjectShell.tsx (layout, tabs) → ChatApp.tsx (chat surface, assistant-ui primitives)
controller ← chat-core WebChatSession (onChange/onStatus/onFrame)
useNeutronChat.ts = React mirror; message-adapter.ts = pure mapping
per-domain *-client.ts = fetch wrappers (injectable fetchImpl, no DOM)
```
The DI-first, pure-function style makes the client highly unit-testable (see § 7). The server side of the package has no such layering: `server.ts` mixes route table, protocol types, an inline auth-gate HTML page + its 70-line inline JS (`CHAT_AUTH_GATE_SCRIPT`, `server.ts:964-1036`), CSP builders, and dead WS machinery in one file.

## 6. Architectural debt

### 6.1 [P1] `landing/server.ts` is the wire-protocol home for the whole chat system — inverted layering
Evidence: § 3 item 1-2; `server.ts:1497-1514` (websocket handler is a defensive close-stub), `server.ts:714-721` (`bridge` option "nothing in this module reads it anymore"). The gateway (substrate layer), reminders, channels, and the Open composer all import types UP into the edge package, and `landing/server.ts` in turn imports DOWN from `onboarding/` (`server.ts:41`). Any refactor of gateway/chat-bridge/app-ws must touch the landing package.
**Sketch:** extract `ChatOutbound` + members, `ChatInbound`, `ChatBridge`, `PendingChatClaim` into a leaf `chat-protocol/` package (types + JSDoc contracts only, zero deps); re-export from `landing/server.ts` during transition; move `MOBILE_APP_URL` re-export to wherever the landing routes actually need it.

### 6.2 [P1] The React client (~8.5k LOC of TSX) has no typecheck gate in CI
Evidence: root `tsconfig.json:41-43` includes only `landing/server.ts`, the **deleted** `landing/chat.ts`, and `landing/__tests__` (auth-gate/session-cookie/spa-routes ride in transitively via gateway imports); CI runs only `bunx tsc --noEmit` + tests (`.github/workflows/ci.yml:51-55`). `landing/chat-react/tsconfig.json` is a manual leaf config (its own header says "typecheck with `bunx tsc -p landing/chat-react/tsconfig.json`" and still references the deleted `landing/web-chat-flag.ts`). Bun tests transpile without typechecking, so a type error in `ChatApp.tsx` ships silently and surfaces only when the runtime `Bun.build` succeeds anyway (it doesn't typecheck either).
**Sketch:** add `bunx tsc -p landing/chat-react/tsconfig.json --noEmit` (and the app's leaf config) as a CI step; remove the dead `landing/chat.ts` include.

### 6.3 [P1] Triple-declared wire types / duplicated API clients across web, mobile, gateway
Every project surface has three hand-maintained copies of its wire shapes: gateway store types, `landing/chat-react/*-client.ts`, `app/lib/*-client.ts`. Documented as deliberate ("re-declared … so the browser bundle stays free of a gateway dependency", `chat-react/work-board-client.ts:31-34`), but they have **already drifted**: web `work-board-client.ts` has `RunPhaseLabel`/`RunProgress` (`:70-92`); the app twin (215 LOC vs 311) doesn't. `docs-client` twins: app 867 LOC with `BinaryUploadResult`/`BinarySource`; web 532 LOC without. Also duplicated: `project-credentials-client`, `tabs-client`/`project-tabs`, upload clients (`landing/upload-client.ts` 590 vs `app/lib/upload-client.ts` 517), topic-id derivation (`chat-react/config.ts:120-136` mirrors `channels/adapters/app-ws/envelope.ts`), and the controller/render-model layer (`controller.ts` vs `app/lib/chat-core/chat-render-model.ts` + `use-mobile-chat.ts`). `@neutronai/chat-core` already proves a shared leaf package bundles fine into both browser and RN.
**Sketch:** grow chat-core (or a sibling `api-clients/` leaf) to own wire types + fetch clients with injectable `fetchImpl`; keep platform-specific UX glue local.

### 6.4 [P1] Dead/legacy code stranded by the vanilla-client deletion
- `connect-relay.ts` (351), `connect-accept.ts` (239) + `connect-accept.html`, `connect-disclosure.ts` (163): zero code importers/servers — the dormant-Connect entanglement, client-side edition.
- `start-token-topic-id.ts` (124): zero non-test importers.
- `markdown.ts` (128): renderer dead; only `escapeHtml` used.
- In `server.ts`: `validateActiveTopicId` (`:77-92`), `resolveRequestHost` (`:111-115`), `emitSessionReady` (`:124-134`) — defined, never called; `SocketState` (`:846-926`) referenced only by the type of the stubbed websocket handler; the `topic_switch` member of `ChatInbound` and several outbound members (`redirect`, `slug_renamed`, `topic_switched`, `session_ready`) describe the deleted `/ws/chat` flow — verify which are still emitted by gateway chat-bridge before deleting (the *types* are still imported wholesale via `ChatOutbound`).
- `boot.ts` (319) + `index.html` (393) + `og/`: Managed-only signup process, dormant in an Open install (nothing in Open runs `landing/boot.ts`).
- `landing/package.json:4` `"main": "./chat.ts"` dangling; root `tsconfig.json:42` includes deleted `landing/chat.ts`.
**Caution:** the ChatBridge/ChatOutbound JSDoc in `server.ts` is the only written spec for live gateway behavior (seed re-emit races, jti claim atomicity). Relocate, don't delete, that prose.

### 6.5 [P2] Brittle cross-package HTML string-replace bootstrap contract
`open/composer.ts:1610-1630` injects `window.__neutron_*` by replacing the exact literal `<script type="module" src="/chat-react.js"></script>` inside HTML produced by `landing/server.ts`. If `chat-react.html` reorders/renames that tag, injection silently no-ops and the client dies with `ChatBootstrapError` (`config.ts:212-216`). The shell-detection guard is a substring check for `/chat-react.js` (`composer.ts:1616`). Similarly the Open path relies on the client's `dev:<user_id>` fallback bearer (`config.ts:16-18,217`) — a "dev-bypass" shape that is actually the production Open credential, with a comment promising a "production EdDSA mint" that never landed.
**Sketch:** replace marker string-replace with an explicit template slot in the shell (e.g. `<!--NEUTRON_BOOTSTRAP-->`) or have `createLandingServer` accept a `bootstrapScript()` option so injection is a typed seam, not a cross-package regex.

### 6.6 [P2] God files with mixed responsibility clusters
- `server.ts` (1,516): protocol types (~500) + auth-gate page HTML/JS/CSP (~180) + route table (~370) + dead WS helpers. Clusters split cleanly: protocol → leaf package (6.1); auth-gate page → own module; routes stay.
- `ChatApp.tsx` (1,344): 25 components incl. `TopicRail` (exported and consumed by `ProjectShell.tsx` — the rail is not even chat-specific anymore). Clusters: attachment rendering (+ contexts), prompt buttons/gallery, reactions/edit/delete, import progress, rail, composer, runtime host.
- `chat-react.html` (903): full design-system stylesheet inline + a hand-mirrored pre-paint theme script that must stay in sync with `theme.ts` (comment at `chat-react.html:14-19` admits the mirror).
- `controller.ts` (1,076): fine overall, but `handleFrame` (`:566-775`) is a ~200-line stringly-typed switch over untyped frames — the frame schema exists server-side in `channels/adapters/app-ws/envelope.ts` and is re-parsed by hand here and again in the mobile client.

### 6.7 [P2] Runtime `Bun.build` of the client, failures swallowed
`server.ts:1243-1264`: first `GET /chat-react.js` triggers an in-process minified build of `main.tsx` (React + assistant-ui, ~0.6 MB), cached in memory forever; `catch { return null }` → a bare 404 "chat-react.js unavailable" with the build error discarded — a packaging/TS error becomes an undiagnosable blank page. No cache headers/ETag on the bundle either (re-downloaded every load) and prod must ship TSX sources + `landing/node_modules`.
**Sketch:** log the build failure; add a build-at-boot (fail-fast like the shell check at `server.ts:1170-1173`) or a prebuild step emitting `chat-react.js` + hash-versioned cache headers.

### 6.8 [P3] Stale comments/docs mislead maintainers
`main.tsx:4-7` ("served at /chat ONLY when the web-chat flag resolves to react. The vanilla client is otherwise untouched"), `config.ts:11-18` (vanilla `chat.html` narrative), `chat-react/tsconfig.json` (deleted `web-chat-flag.ts`), `upload-client.ts` + `start-token-topic-id.ts` docs referencing `landing/chat.ts`, `boot.ts` route list ("GET /chat → static chat.html"), AS-BUILT mentions of `NEUTRON_WEB_CHAT_CLIENT`. Given the refactor mandate, these actively point at the wrong architecture.

## 7. Test posture

Strong, fast, DI-driven unit coverage: `bun test landing` → **446 pass / 0 fail across 44 files in ~5s** (includes `gateway/realmode-composer/build-landing-stack*` tests that pattern-match). `landing/__tests__/` (18 files): auth-gate (811-line test), server routes, session cookie + OAuth redirect, chat auth gate, chat-react serving, spa-routes, chunked upload client, boot, start-token-topic-id (testing dead code). `chat-react/__tests__/` (27 files): controller (1,284 lines), component rendering (1,209 lines), rail stability, attachments, doc-link boot/open, per-client fetch fakes.

Gaps: no CI typecheck of the TSX (§ 6.2); no browser e2e (WS reconnect/OPFS/scroll behavior only simulated); the 903-line stylesheet + theme pre-paint script untested; runtime-bundling failure path untested; dead modules still carry passing tests, masking their deadness. Flake risk: low (no timers without injection, no network).

## 8. Load-bearing subtleties a refactor must not break

1. **`ChatBridge` semantics documented only in `server.ts` prose**: `startSession` = atomic jti claim + first emit (split from `validateStartToken` so a failed upgrade doesn't burn the token, `:519-592`); `closeSession` unregisters by **send-lambda reference equality** (`:656-663`); `getActiveTopicId` re-read at emit time to drop superseded seed re-emits (`:627-646`); cookie-fallback resume for spent-jti reconnects (`SocketState.cookie_fallback_claim`, `:896-915`).
2. **Auth-gate page contract**: `GET /chat` returns **503** (not 200) with the functional Max-OAuth handoff page; the inline script polls `/chat` for the 503→(restart)→200 transition and treats a 404'd `signup_id` as "store wiped by restart = success" (`server.ts:973-1005`). The script must stay **deterministic** (no interpolated values) because the CSP pins it by SHA-256 (`chatAuthGateCsp`, `:1136-1146`).
3. **Bootstrap injection marker**: exact-string replace of the module script tag (`open/composer.ts:1621-1625`); `<` escaped as `<` in injected JSON (`:1558`) — XSS guard for project names.
4. **Cold-start vs resume gate**: cookie-only `/chat` serves the shell ONLY when an `onboarding_state` row exists; otherwise cold-start redirect — prevents the "Setting things up…" forever-loader (`open/composer.ts:1453-1479, 1686-1690`); `hasResumableState` fails TOWARD cold-start.
5. **Controller streaming invariants** (`controller.ts:566-604`): empty first `body_delta` must NOT materialize a bubble (BUG 7); streaming bubble is superseded by the persisted row with no duplicate/flash; `awaitingReply` bracket cleared by `agent_message`, `agent_typing end`, `error`, and `chat_command_result` (slash commands get exactly ONE result frame and NO `agent_message` — clearing on it is what stops infinite dots).
6. **Foreign-project frame drop-guard**: `agent_typing` for a different `project_id` must not flip the active surface's indicator (`controller.ts:611`); `agent_message.topic_id` routes late replies to their own topic instead of the focused one (`server.ts:218-230`).
7. **Per-conversation runtime**: assistant-ui runtime is built per `convId` inside `ChatApp` (`ConversationRuntimeHost`) — NOT at the root — so a project switch mounts a fresh runtime (SEV1 stale-index fix, `main.tsx:40-45`); `ProjectShell` keeps `ChatApp` mounted across tab switches (hidden, not unmounted) so the session/scroll survive.
8. **One shared OPFS store** keyed internally by topic_id across per-project sessions (`main.tsx:68-74`).
9. **Theme pre-paint script** in `chat-react.html:12-33` is a hand-mirror of `theme.ts` (same key `neutron-theme`, same resolution rules) — change one, change both.
10. **`isSpaClientRoute` is deliberately narrow** (`GET /projects[/…]` only, `spa-routes.ts`): broadening it would mask real API 404s behind the SPA shell.
11. **Per-page-load `deviceId` is safe only** because web reports reads solely for agent messages (`config.ts:191-193`) — sharing read-receipt logic with mobile changes this calculus.
12. **CSP hash pinning** for `onboarding-telegram.html` matches only attribute-less `<script>`/`<style>` tags (`collectInlineHashes`, `server.ts:152-168`) — adding `type="module"` to that page's inline script silently breaks its CSP.
13. **`?start=` precedence over cookie** everywhere (gate + WS docs, `server.ts:817-821`), and `/start?token=` passes `debug`/`import` params through (`:1329-1332`).

## 9. What the refactor should do here

1. **Extract the chat protocol** (`ChatOutbound`/`ChatInbound`/`ChatBridge`/`PendingChatClaim` + their contract prose) into a leaf package; make `landing/server.ts` a pure HTTP route module; delete the websocket stub by letting the composer own the `Bun.serve` shape.
2. **Delete the dead files** (`connect-relay.ts`, `connect-accept.{ts,html}`, `connect-disclosure.ts`, `start-token-topic-id.ts`, `markdown.ts` minus `escapeHtml`, `server.ts` dead helpers) after confirming with the Connect-subsystem mapper that no revival is planned; fix `package.json.main` and root tsconfig includes; decide `boot.ts`/`index.html`'s fate in the Open repo (move Managed-only assets out or mark clearly).
3. **Gate the TSX in CI** (leaf tsconfig typecheck) and surface `Bun.build` failures; consider build-at-boot fail-fast to match the shell's existing packaging assertion.
4. **Unify the client layer with mobile**: shared wire-type/client package (extend chat-core's role); one frame-schema module used by server envelope, web controller, and mobile render model.
5. **Split `ChatApp.tsx`** along its natural clusters (rail already belongs to `ProjectShell`); extract the design system from `chat-react.html` into a served .css file (kills the 903-line shell and shrinks the injection surface).
6. **Replace the string-replace bootstrap** with an explicit injection seam in `createLandingServer`.
7. Preserve every behavior in § 8 with characterization tests before moving code — most are regression fixes with SEV/BLOCKER pedigrees.
