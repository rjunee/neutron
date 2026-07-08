# Subsystem map: mobile-app (`app/`)

Audit date: 2026-07-02. All paths relative to `/Users/ryan/repos/neutron-open` unless noted.

## 1. Purpose & responsibilities

`app/` is the Expo (React Native + react-native-web) client — the primary product surface for a Neutron Open install. It renders login/OAuth handoff, a Focus screen, the projects list, per-project tabs (Chat, Apps/launcher, Tasks, Reminders, Docs, Work Board, Backups, Settings, Core webviews), global Settings/Integrations, and an Admin console (persona editor, gateway restart, memory, cores, project backup, Max-account reauth). It consumes the gateway exclusively over `/api/app/*` HTTP + `/ws/app/chat` WS; the chat transport/sync engine is the shared `@neutronai/chat-core` workspace package ("share logic, not views" — `app/lib/chat-core/mobile-session.ts:1-34`).

## 2. Module inventory

Total: ~46.3k lines of TS/TSX (`wc -l` over non-node_modules), of which ~10.5k is `__tests__/` (58 files).

### Routes (`app/app/`, expo-router file routes)
| file | lines | role |
|---|---|---|
| `app/projects/[id]/docs.tsx` | 2,426 | docs tab: tree + editor + preview + history + comments + binaries + deep-link anchors |
| `app/admin.tsx` | 2,188 | admin console; SIX panes inline |
| `app/projects/[id]/backups.tsx` | 1,269 | snapshot list, preview modal, diff view, restore + undo |
| `app/projects/[id]/settings.tsx` | 676 | per-project settings tab |
| `app/projects/index.tsx` | 636 | project rail/cards |
| `app/integrations.tsx` | 482 | connectors list |
| `app/cores/[slug].tsx` | 477 | global core webview |
| `app/projects/[id]/_layout.tsx` | 430 | project shell: ProjectStateProvider + registry-driven tab bar + last-tab persistence |
| `app/projects/[id]/cores/dtc-analytics.tsx` | 420 | **dead**: hardcoded staging-core dashboard (see §6.5) |
| `app/projects/[id]/launcher.tsx` | 351 | apps grid |
| `app/projects/[id]/workboard.tsx` | 330 | work board |
| `app/settings.tsx` / `login.tsx` / `focus.tsx` / `tasks.tsx` / `reminders.tsx` | 267/180/158/182/180 | thin: mount a provider + list components |
| `app/projects/[id]/chat.tsx` | 32 | thin wrapper over `ChatSyncSurface` |
| `app/_layout.tsx` | 102 | root: AuthSessionProvider + doc-link + push-tap deep-link routing |

### Components (`app/components/`, 30 files)
Big ones: `ProjectSettingsDrawer.tsx` 1,298 (settings sections + Connect members + invite + segmented controls); `CommentsSidePane.tsx` 993; `ChatSyncSurface.tsx` 885 (the single chat surface post 2026-06-29 chat-collapse — `app/app/projects/[id]/chat.tsx:8-10`); `InputComposer.tsx` 474; `UploadModal.tsx` 417. The rest are per-feature row/list/modal triplets (Task*, Reminder*, Focus*, Launcher*).

### Lib (`app/lib/`, 60 files)
- **15 HTTP client classes**, one per gateway surface: `admin-client.ts`, `admin-personality-client.ts`, `backups-client.ts`, `connect-members-client.ts`, `cores-client.ts`, `devices-client.ts`, `docs-client.ts` (867), `focus-client.ts`, `launcher-client.ts`, `project-credentials-client.ts`, `projects-client.ts`, `reminders-client.ts`, `tabs-client.ts`, `tasks-client.ts`, `work-board-client.ts`, plus `upload-client.ts` (517).
- **State triplets** per feature: `X-client.ts` + pure `X-state-reducer.ts` + React `X-state.tsx` provider — tasks, reminders, launcher, focus, project, comments (e.g. `lib/task-state.tsx:1-35`, `lib/task-state-reducer.ts:1-24`).
- **chat-core glue** (`lib/chat-core/`): `mobile-session.ts` (420, composes ChatWsClient + SendQueue + SyncEngine + Store), `use-mobile-chat.ts` (280, React seam + AppState bridge), `sqlite-store.ts` (584) + `op-sqlite-store.ts` (82, on-device durable transcript), `chat-render-model.ts` (215, durable+streaming row merge), `deep-link-dispatch.ts`.
- **Mirrors of server modules** (see §6.3): `ws-envelope.ts` (237), `doc-links.ts` (493), `composer-constants.ts`, plus mirrored literal unions inside `tabs-client.ts`, `projects-client.ts`, `focus-client.ts`.
- Cross-cutting: `config.ts` (env→base URLs), `session.tsx` (auth context, storage-hydrated), `token-storage.ts`, `theme.ts` (tokens), `markdown-render.tsx` (908, hand-rolled MD renderer), `push.ts` (359) + `push-deep-link-dispatch.ts` + `push-tap-dedupe-store.ts`, `work-board-live.ts` (171, second WS).

## 3. Public seams / contracts

**Nothing in the repo imports `app/`** — it is a leaf consumer. The seams it *consumes* are the real contracts:

1. **Gateway `/api/app/*` HTTP surface** (bearer token from login). Endpoints observed in `lib/*-client.ts`: `/api/app/projects[/<id>/{settings,tabs,tasks,reminders,launcher,docs/*,work-board*,backups,restore,invite,credentials*,connect-members*,connect-invites}]`, `/api/app/{focus,focus/current}`, `/api/app/admin/{connectors,memory,gateway/restart,project-backup/*,max-oauth/mint-reauth-token}`, `/api/app/persona/*`, `/api/app/devices/{register,unregister}`, `/api/app/upload*`, `/api/app/chat/send`.
2. **`/ws/app/chat`** per-user topic `app:<user_id>` (`components/ChatSyncSurface.tsx:117`), frame shapes mirrored in `lib/ws-envelope.ts` ← `channels/adapters/app-ws/envelope.ts` (parity test `app/__tests__/ws-envelope-parity.test.ts`).
3. **Tabs resolver**: `GET /api/app/projects/<id>/tabs` — the engine (`tabs/registry.ts` + `gateway/http/app-tabs-surface.ts`) is declared the single source of truth; `lib/tabs-client.ts:8-24` re-declares its wire types "byte-for-byte"; `lib/project-tabs.ts` maps descriptors → expo-router routes; hardcoded `PROJECT_TABS` survives only as pre-fetch fallback (`lib/project-tabs.ts:37-51`).
4. **`@neutronai/chat-core`** — the ONLY workspace dependency (`app/package.json:16`), consumed as raw TS source via `allowImportingTsExtensions` (`app/tsconfig.json`) + metro monorepo wiring (`app/metro.config.js`).
5. **Deep-link scheme** `neutron://docs/<project_id>/<path>?line=N|range=N-M` + web `/projects/<id>/docs?path=…` — producer is `runtime/doc-links.ts`, consumer is `app/_layout.tsx:36-59` via the mirror `lib/doc-links.ts` (parity test lives gateway-side: `gateway/__tests__/doc-links-parity.test.ts` per `lib/doc-links.ts:7-10`).
6. **Push payloads** (`expo-notifications`) → `lib/push-deep-link-dispatch.ts` route mapping; device registration via `/api/app/devices/*`.

## 4. Workspace dependencies

- **Out (package.json)**: `@neutronai/chat-core` only. Everything else is Expo/RN ecosystem.
- **Out (actual imports)**: same, PLUS a test-only cross-workspace reach: `app/__tests__/ws-envelope-parity.test.ts:25` and `app/__tests__/chat-retry-reupload-attachments.test.ts` import `../../channels/adapters/app-ws/envelope` directly (works only because bun test runs from the repo root; the app *bundle* stays clean).
- **In**: none (no other workspace imports `app/`). `landing/chat-react` is a *sibling* re-implementation, not a consumer (§6.2).

## 5. Internal layering (as-built, and it is fairly clean)

```
routes (app/app/*)  →  components/  →  lib/*-state.tsx (providers)
                                     →  lib/*-state-reducer.ts (pure)
                                     →  lib/*-client.ts (fetch wrappers)
                                     →  lib/chat-core/* → @neutronai/chat-core
cross-cutting: lib/{config,session,theme,token-storage,push,doc-links,ws-envelope}
```
Conventions are explicit and mostly honored: reducers/helpers are React-free and RN-free for bun-testability (`lib/project-tabs.ts:4-8`); clients take `{base_url, token}` at construction and are server-authoritative; providers own cancellation. The big exception is the monster routes, which inline all four layers (§6.1).

## 6. Architectural debt

### 6.1 God screens with 5–8 responsibility clusters each — **P1**
- **`app/app/projects/[id]/docs.tsx` (2,426)**. Clusters: (a) tree pane + fetch (`:261-341`), (b) editor/preview/mode + save w/ 409 conflict (`:777-825`), (c) P7.4 history pane + version preview + revert (`:655-775`, `:1357-1452`), (d) P7.2 comments-pane wiring ×3 mount points (`:1183-1197`, `:1291-1304`, `:1455+`), (e) P7.5 binary upload/preview/delete incl. web drag-drop + caret splice (`:567-653`, `:1570-1730`), (f) P7.3 deep-link line/range anchor scroll + highlight overlay math (`:355-521`), (g) six inline modals (`:1879-2060`), (h) four `RequestGate` instances hand-threaded through every handler (`:190-192`, `:247`). The file is a fossil record of 7 review rounds (comments cite Round-5/6/7 BLOCKING fixes at `:186-189`, `:783-786`, `:842-845`) — each fix re-threads the same gate discipline by hand.
- **`app/app/admin.tsx` (2,188)**: six fully independent panes inline — `PersonalityPane` (`:279`), `GatewayPane` (`:814`), `MemoryPane` (`:904`), `CoresPane` (`:983`), `BackupPane` + `ConnectRemoteModal` (`:1275`, `:1552`), `MaxAccountPane` (`:1781`) — sharing only the pane-switcher shell (`:100-208`) and one `styles` object. Natural file-per-pane split; zero coupling between panes.
- **`app/app/projects/[id]/backups.tsx` (1,269)**: snapshot rows (`:350`), preview modal + per-file diff renderer (`:392`, `:642`), restore confirm (`:670`), undo banner (`:747`).
- **`components/ProjectSettingsDrawer.tsx` (1,298)**: settings sections (`:373`), an embedded `useConnectMembers` data hook (`:121-199`), the whole Connect invite/revoke UI (`:516`), and two segmented-control widgets (`:785`, `:830`).
Severity P1: these four files are where feature work happens, and each change re-litigates concurrency and state discipline inline.

### 6.2 App ↔ web-client duplication (two front ends, drifting) — **P1**
`landing/chat-react/` re-implements the same gateway consumers with different code: `docs-client.ts` (app 867 vs web 532 lines, diff ≈1,282 lines), `tabs-client.ts` (115 vs 180), `work-board-client.ts` (207 vs 311), `project-credentials-client.ts` (150 vs 178), plus separate `config.ts`, `theme.ts`, and a separate markdown renderer (`app/lib/markdown-render.tsx` 908 lines hand-rolled state machine vs `landing/chat-react/Markdown.tsx` 118 lines). Both consume the identical wire contracts. Only chat *transport* is shared (chat-core). Every gateway surface change now needs three edits (gateway + app + web) with no compiler help between the last two.

### 6.3 Hand-mirrored wire types, parity-guarded only in spots — **P2 (P1 trajectory)**
The convention "re-declare wire shapes rather than import across the workspace boundary" (`lib/tabs-client.ts:16-19`) exists for a real reason: server packages drag in `node:sqlite` (`lib/ws-envelope.ts:4-7`). But enforcement is uneven:
- Guarded: `ws-envelope.ts` (app-side parity test), `doc-links.ts` (gateway-side parity test), `MAX_USER_MESSAGE_LEN` (`lib/composer-constants.ts:8-9` lock test).
- Unguarded: `TabDescriptor` et al. in `tabs-client.ts` ("byte-for-byte" claim, no parity test found in `tabs/__tests__/` or `app/__tests__/`); `AgentEngagementMode` in `projects-client.ts:24-29` ("must stay in lockstep" with `connect/agent-engagement.ts` + migration 0088 — comment-only contract); `focus-client.ts` mirrors.
Drift here fails silently at runtime (fields dropped / defaulted), not at compile time.

### 6.4 Sixteen bespoke HTTP clients, sixteen bespoke error classes, zero shared base — **P1**
Every `lib/*-client.ts` re-implements: options interface `{base_url, token}`, inline `fetch` + header assembly, status→code mapping, and its own `XxxClientError extends Error` (16 of them — `lib/admin-client.ts:306`, `lib/docs-client.ts:834`, `lib/tabs-client.ts:59`, etc.; grep shows 14 files with raw `await fetch(`). Consequences visible today: three copies of `formatError` (`docs.tsx:2062`, `admin.tsx:1224`, `backups.tsx:921`), two of `formatBytes` (`admin.tsx:1230`, `docs.tsx:1610`), two of `httpToWs` (`lib/config.ts:85`, `lib/work-board-live.ts:31` — the second deliberately inlined to dodge the `expo-constants` import chain, i.e. evidence a pure-utils module is missing). Retry, auth-expiry handling, and telemetry can't be added in one place.

### 6.5 Dead / legacy code — **P2**
- **`app/app/projects/[id]/cores/dtc-analytics.tsx` (420 lines)**: header says it must stay in sync with `cores/paid-staging/dtc-analytics/src/csv.ts` — **that directory does not exist** (`ls cores/` shows only `free/`, `runtime/`, `sdk/`). The screen renders only client-side pasted CSV ("does NOT yet wire to a live backend", `:23-31`; "smoke-testing by Sam", `:20`). `cores/[slug].tsx:11` still special-cases it. Delete candidate.
- `'notes'` in `NON_TAB_SUBROUTES` (`lib/project-tabs.ts:70`) — no `notes.tsx` route exists under `app/app/projects/[id]/`.
- `config.ts` carries the "legacy single `base_url`" alias alongside `gateway_base_url` forever-equal (`lib/config.ts:10-14`, `:31-36`) — P3, but every new client keeps choosing one arbitrarily.
- Comment archaeology throughout (sprint-brief citations, Round-N BLOCKING logs) is valuable history but belongs in docs, not 90-line file headers — P3.

### 6.6 Hand-threaded request-sequencing (`RequestGate` / `cancelRef`) — **P2, load-bearing**
The cross-project stale-write bug class (project A's async op resolving after switch to B) was fixed *four separate times* in docs.tsx alone (save → create → rename → delete; `docs.tsx:186-192`, `:783-786`, `:842-845`, `:900-903`, `:943-947`), and the same idea reappears as `cancelRef` in every state provider (`lib/task-state.tsx:28-31`) and as `setFetchedTabs(null)` in the project layout (`_layout.tsx:113-118`). The discipline is correct but manual at every call site; nothing structurally prevents the next handler from forgetting it.

### 6.7 Per-feature state boilerplate — **P3**
The client/reducer/provider triplet is applied 6× with near-identical load/mutate/dismiss lifecycles (`lib/task-state-reducer.ts:8-24` explicitly says it mirrors `launcher-state-reducer.ts`). Highly testable, but each new tab costs ~600-700 lines of pattern-copying. A generic `createResourceState<T>` factory would collapse most of it — low priority because the copies are at least consistent.

### 6.8 One-socket-per-surface WS growth — **P2**
`lib/work-board-live.ts:5-11` documents that there is "no shared frame bus across screens": the work-board screen opens a second WebSocket to the *same* `app:<user>` topic that `MobileChatSession` already holds, just to hear `work_board_changed`. Each future live surface adds another socket + reconnect loop. A shared frame-bus seam (one socket, typed frame subscriptions) is the obvious consolidation — but note the resume/replay semantics of the chat socket must not be disturbed (§8).

### 6.9 Theme-token import inconsistency — **P3**
Some files import tokens from `lib/theme.ts` (docs.tsx:61), others through the `lib/composer-constants.ts` barrel (project `_layout.tsx:44`), whose header says the re-export is "for ergonomics" of `components/` only. Also raw hex literals bypass the theme in places (`admin.tsx` ActivityIndicator `#cfcfcf`, docs.tsx placeholder `#5a5a5a`).

## 7. Test posture

- 58 bun test files under `app/__tests__/` (~10.5k lines), run as part of root CI discovery (`scripts/run-tests.sh`, `.github/workflows/ci.yml:55` — coverage cross-checked against bun's own discovery).
- **Character**: pure-logic only. The suite's stated convention: "does NOT mount React Native components — `react-native` is not loaded in the test runtime and `@testing-library/react-native` is not a dependency. Render-level coverage is provided by the agent-browser smoke pass" (`__tests__/comments-side-pane.test.tsx:4-9`). Reducers, clients (stubbed fetch), formatters, route mappers, chat-core session (fake socket), sqlite store — all well covered.
- **Untested**: all JSX + hook orchestration in the monster screens. docs.tsx's four-gate concurrency choreography — the very thing seven review rounds kept breaking — is exercised only indirectly (helpers like `freshEditorState`/`RequestGate` are unit-tested via `docs-client.ts`; the *wiring* in the component is not). Same for admin panes and backups restore/undo flows.
- **Flake risk**: low (no network, no native modules in tests). One structural hazard: parity tests import `channels/` source directly, so a channels refactor that moves `envelope.ts` breaks app tests — that is by design (drift alarm) but should be known.
- Typecheck: `app/tsconfig.json` is its own strict project (`bun run typecheck` = `tsc --noEmit`); root-level tsc does not cover it.

## 8. Load-bearing subtleties a refactor MUST NOT break

1. **RequestGate token ordering**: acquire *before* the first `await`; check `isLatest` before *every* setState after an await; `mutateGate` must keep covering save AND create/rename/delete (`docs.tsx:186-192`). Regression = silent cross-project file writes.
2. **Project-switch reset ordering** in docs.tsx (`:305-341`): reset gates → reset all per-file state → reset tree → then `fetchTree()`. Tree must clear *before* refetch (Round-7 BLOCKING #2, `:336-339`), and error paths clear the tree too (`:270-276`).
3. **Fallback tabs are a loading default, not an alt path**: `PROJECT_TABS` shows only pre-fetch/on-error; `setFetchedTabs(null)` on project switch prevents stale-id routes (`_layout.tsx:108-118`). Active-tab detection must use `usePathname()` concrete segments, never `useSegments()` tokens (`_layout.tsx:91-95`).
4. **One-shot latches**: `autosendDispatched` ref fires `?autosend=` exactly once *after* socket open (`ChatSyncSurface.tsx:140-148`); `chosenByPrompt` latches button prompts so a tap can't double-fire (`:160-171`); button rows send `value` not `label` (`lib/button-primitives.tsx:9-14`). Options must come from structured `options_json`/prompt metadata — persisted bodies have `[[OPTIONS]]` stripped (known gateway invariant).
5. **Resume protocol**: on every `session_ready` the client sends `{type:'resume', after_seq:N}` from the local durable cursor (`lib/ws-envelope.ts:43-56`); `catchUp()` is foreground-only by design (`lib/chat-core/use-mobile-chat.ts:18-21`). Changing store/session construction order (store per (user, project), torn down on change) breaks gap-free reconnect.
6. **Empty-body attachment sends**: an image upload becomes `send('', [url])`; the gateway echo reconciles (`ChatSyncSurface.tsx:190-196`). Cap invariants: 8 attachments / 512-char URLs / 16,384-char body mirrored client-side (`lib/ws-envelope.ts:26-28`, `composer-constants.ts`).
7. **409 conflict UX**: `expected_modified_at` rides every docs PUT *and* revert (`docs.tsx:735-739`); conflict keeps the local draft and offers Reload — never auto-overwrites.
8. **Deep-link anchor scroll heuristic** is arithmetically coupled to theme tokens (`y = SPACING.lg + (line-1) * TYPOGRAPHY.body.lineHeight`, `docs.tsx:88-89`, `:427-438`); malformed `line`/`range` params must degrade to no-scroll, `line` wins over `range` (`:139-157`).
9. **Session persistence is fire-and-forget** (`lib/session.tsx:110-127`): `setUser` updates memory synchronously and persists async; the `status==='hydrating'` gate is what prevents a login flash — routes gate on `authStatus === 'ready'` (`_layout.tsx:66-77`).
10. **Mirror files**: any edit to `lib/ws-envelope.ts`, `lib/doc-links.ts`, `lib/tabs-client.ts` types, `AgentEngagementMode`, or `MAX_USER_MESSAGE_LEN_CLIENT` must land in the server twin in the same change; only some have tests that will catch you (§6.3).
11. **Bundle purity**: no server workspace may be imported from `app/` source (only tests may) — metro will bundle whatever you import, and `@neutronai/channels`→`node:sqlite` breaks the RN bundle. This is *why* the mirrors exist; a refactor that "deduplicates" by importing server modules directly will brick the app build.
12. **Binary vs markdown tree nodes**: phantom binary-origin folders must delete via `deleteBinariesUnderPrefix`, never `deleteFolder` (ENOENT) (`docs.tsx:910-917`).

## 9. What the refactor should do here

1. **Extract a `wire-types` (or extend `chat-core`-style) pure workspace package** holding the app-ws envelope, tab descriptors, doc-link helpers, project-settings unions, and message caps — importable by gateway, app, and web client alike (it must stay free of node-only imports, exactly like chat-core already proves is possible). This deletes the mirror files and their comment-contract enforcement.
2. **One `GatewayHttpClient` base** (auth header, error mapping to a single `GatewayClientError{code,status}`, JSON envelope unwrap) + thin per-surface modules; share it with `landing/chat-react` via the same package or a sibling `client-core`. Collapses 16 error classes and 3× `formatError`.
3. **Split the four god files along their existing internal seams** — they already have clean function boundaries (admin panes, docs history/comments/binary clusters, backups modals). Pure mechanical extraction to `app/features/<x>/` files; no behavior change; keep testIDs stable (the agent-browser smoke pass keys on them).
4. **Institutionalize the gate pattern**: a `useProjectScopedAsync(project_id)` hook that owns acquire/isLatest/reset-on-switch, so the Round-5/6/7 bug class becomes impossible to reintroduce by omission. Port docs.tsx handlers onto it one at a time with the existing behavior as the spec.
5. **Decide the two-front-end question at the architecture level**: either commit to react-native-web as the single web client (retiring `landing/chat-react` duplication) or fund the shared client-core; the current state (three consumers of one API, two hand-synced) is the largest ongoing tax.
6. Delete `dtc-analytics.tsx` + its `[slug].tsx` special case and the `'notes'` NON_TAB_SUBROUTES entry; fold `composer-constants` theme re-exports into one canonical import path.
7. **Add the missing parity tests first** (tabs descriptor shape, `AgentEngagementMode`) before touching anything near the mirrors — cheap insurance for the whole refactor.
