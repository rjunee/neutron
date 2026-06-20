# @neutron/app — Neutron mobile + web app (P5)

Expo (managed workflow) app shell for Neutron. iOS, Android, and Web from a
single React Native + React Native Web codebase, navigated via Expo Router.

Authoritative spec: `docs/plans/P5.0-app-scaffolding-sprint-brief.md` (Atlas,
2026-05-17). Subsequent surfaces shipped per
`SPEC.md § Phases→Steps` (P5.1 chat, P5.2 project view,
P5.3 launcher, P5.4 tasks + reminders, P5.5 focus, P5.6 push, P5.7 admin,
P7.0–P7.5 docs interface).

## Architecture (locked per the P5.0 brief)

- **Expo managed workflow.** No `ios/` or `android/` native projects in the
  repo — EAS generates them at build time.
- **Expo Router 6.** File-based navigation under `app/`. Typed-routes on.
- **React Native Web 0.21.** Same codebase boots in the browser via Metro
  static export. Paths-not-fragments, deep-linkable URLs.
- **State.** React Context only. `AuthSessionProvider` (token + user, persisted
  via `lib/token-storage.ts`); `WsConnectionProvider` (optional, for the chat
  connection indicator). No Zustand / Redux / Jotai — each sprint earns its
  own deps.
- **WebSocket.** Native global `WebSocket`, single per-project client primitive
  in `lib/ws-client.ts` with reconnect + capped exponential backoff.
- **Auth.**
  - **Real OAuth.** `signInWithGoogle()` / `signInWithApple()` open
    `expo-web-browser`'s `openAuthSessionAsync` against
    `<auth-base>/oauth/<provider>/start` with PKCE
    `code_challenge` + `state`; callback comes back via
    `neutron://oauth/callback?token=...&state=...`. The install-token is
    exchanged at `POST {auth_base_url}/api/v1/install-token/exchange` for a
    multi-aud JWT.
  - **Dev-token lane.** `signInWithDevToken({ token })` accepts a
    `dev:<user_id>` opaque token OR an HS256 JWT (gateway-signed). Used
    while the auth service is bring-up and during local-gateway dev
    (`NEUTRON_APP_WS_BYPASS=1` / `NEUTRON_APP_WS_DEV_SECRET=...`).
- **Token storage.** `@react-native-async-storage/async-storage` on native;
  `window.localStorage` on web. Two keys: `neutron.session.token` and
  `neutron.session.user`. `expo-secure-store` is the upgrade path when
  refresh-token rotation lands.
- **Theme.** Locked minimal dark palette + P5.1 design tokens in `lib/theme.ts`
  (`TYPOGRAPHY` h1–h4 + body + mono, `SPACING` 8-pt rhythm, `MOTION` fast /
  base / slow / pulse, `DENSITY` bubble / chip / composer radii). Every
  component reads tokens from theme.ts — no inline magic numbers.
- **Deep-link scheme.** `neutron://`. Root `_layout.tsx` subscribes to
  `Linking.getInitialURL()` + `Linking.addEventListener('url', …)` for the
  OAuth callback path AND for `neutron://docs/...` (P7.3).
- **Build targets.** iOS, Android, Web from one workspace. `eas.json`
  declares `development` / `preview` / `production` profiles; EAS account
  binding is an operator step (`eas login` + `eas project:init`).

## Layout

```
app/
├── app/                              # Expo Router routes (file-based navigation)
│   ├── _layout.tsx                   # Root Stack + AuthSessionProvider + deep-link routing
│   ├── index.tsx                     # Session-redirect root (→ /login or → /projects)
│   ├── login.tsx                     # OAuth + dev-token entry
│   ├── focus.tsx                     # Global cross-project Focus view (P5.6) — production refactor
│   ├── settings.tsx                  # Current-user card + Sign out (P5.0)
│   ├── admin.tsx                     # Admin tab (P5.7 — personality / gateway / Cores)
│   ├── cores/[slug].tsx              # Per-Core setup screen (Cores admin)
│   └── projects/
│       ├── index.tsx                 # Unified project list (P5.2)
│       └── [id]/
│           ├── _layout.tsx           # 5-tab navigator + project settings drawer (P5.2)
│           ├── chat.tsx              # Chat surface (P5.1)
│           ├── launcher.tsx          # Launcher with DnD reorder (P5.3)
│           ├── tasks.tsx             # Project tasks tab (P5.4)
│           ├── reminders.tsx         # Project reminders tab (P5.4)
│           ├── notes.tsx             # Per-project notes
│           ├── docs.tsx              # Docs file-explorer + markdown reader (P7.0/P7.1)
│           └── cores/
│               └── dtc-analytics.tsx # DTC Analytics dashboard (per-project Core)
├── __tests__/                        # Bun-runnable unit tests (no RN bridge)
│   ├── token-storage.test.ts
│   ├── auth-helpers.test.ts
│   ├── theme.test.ts
│   ├── chat-streaming.test.ts        # P5.1 reducer
│   ├── upload-client.test.ts         # P5.1 multipart upload
│   ├── ws-envelope-parity.test.ts    # P5.1 envelope mirror parity
│   ├── markdown-render-parse.test.ts # P5.1 block-parse + URL allow-list
│   ├── citation-chip-row.test.ts     # P5.1 chip helpers
│   ├── project-state-reducer.test.ts # P5.2 project-state reducer
│   ├── projects-client.test.ts       # P5.2 projects API client
│   ├── last-tab-storage.test.ts      # P5.2 per-project last-tab persistence
│   ├── launcher-state-reducer.test.ts # P5.3 launcher reducer
│   ├── launcher-grid-layout.test.ts   # P5.3 adaptive-grid math (4/5/6/7 cols)
│   ├── launcher-client.test.ts        # P5.3 launcher client incl. sendBuildMePrompt
│   ├── task-state-reducer.test.ts     # P5.4 tasks reducer (LOAD/SET_FILTER/MUTATE/DISMISS_ERROR)
│   ├── tasks-client.test.ts           # P5.4 tasks client (incl. ?order=focus_score opt-in)
│   ├── task-row-helpers.test.ts       # P5.4 due-date / today-bucket / focus-score formatters
│   ├── task-create-modal-helpers.test.ts # P5.4 normalizeDueDate
│   ├── focus-state-reducer.test.ts    # P5.6 focus-state reducer + bucketizeSections
│   ├── focus-row-formatters.test.ts   # P5.6 pure row formatters (relative-time, chip kinds)
│   └── focus-client.test.ts           # P5.6 focus client (incl. ?order=focus_score opt-in)
├── components/                       # P5.x components (chat / shell / launcher)
│   ├── MessageItem.tsx               # P5.1 — Pure single-message renderer
│   ├── InputComposer.tsx             # P5.1 — Multiline composer + attach + Cmd-Enter
│   ├── ConnectionBanner.tsx          # P5.1 — Sticky banner for WS state
│   ├── ProjectHeader.tsx             # P5.2 — Back + title + settings gear
│   ├── ProjectTabBar.tsx             # P5.2 — Locked 5-tab bar
│   ├── ProjectSettingsDrawer.tsx     # P5.2 — Right-aligned project settings sheet
│   ├── LauncherGrid.tsx              # P5.3 — Adaptive iPhone-style grid + HTML5 DnD
│   ├── LauncherItem.tsx              # P5.3 — Single tile (emoji + label + long-press)
│   ├── LauncherBuildMeTile.tsx       # P5.3 — Dashed-border "Build me…" tile
│   ├── LauncherItemMenu.tsx          # P5.3 — Centered Modal action sheet
│   ├── LauncherRenameModal.tsx       # P5.3 — Rename prompt
│   ├── LauncherBuildMeModal.tsx      # P5.3 — Build-me prompt with spinner
│   ├── TaskHeader.tsx                # P5.4 — Tasks title + + New task button
│   ├── TaskFilterChips.tsx           # P5.4 — Open / Done / All chips
│   ├── TaskList.tsx                  # P5.4 — Pure container + 720px content-cap
│   ├── TaskRow.tsx                   # P5.4 — Checkbox + title + meta-row chips
│   ├── TaskCreateModal.tsx           # P5.4 — Centered modal create form
│   ├── TaskEditModal.tsx             # P5.4 — Edit form + separated destructive row
│   ├── FocusHeader.tsx               # P5.6 — Today overline + Focus title + Refresh / Projects / Sign-out
│   ├── FocusList.tsx                 # P5.6 — Pure container + RefreshControl + 720px content-cap
│   ├── FocusBucketSection.tsx        # P5.6 — Bucket overline + section rows
│   └── FocusRow.tsx                  # P5.6 — Dot + title + Kind/Project/Priority/Due chips + chevron
├── lib/                              # Shared client lib
│   ├── auth.ts                       # Real OAuth + dev-token + signOut
│   ├── auth-helpers.ts               # Pure helpers (URL build, callback parse, base64url)
│   ├── session.tsx                   # AuthSessionProvider (hydrate + persist)
│   ├── token-storage.ts              # AsyncStorage + localStorage abstraction
│   ├── config.ts                     # auth_base_url / gateway_base_url / ws_base_url
│   ├── theme.ts                      # Dark palette + TYPOGRAPHY / SPACING / MOTION / DENSITY
│   ├── composer-constants.ts         # MAX_USER_MESSAGE_LEN_CLIENT + theme barrel
│   ├── placeholder-tab.tsx           # <PlaceholderTab name=… landsIn=… />
│   ├── ws-client.ts                  # WS connection primitive (chat surface)
│   ├── ws-connection-provider.tsx    # Optional Context for chat-tab indicator
│   ├── ws-envelope.ts                # Wire envelope types (incl. P5.1 agent_message_partial)
│   ├── chat-state.tsx                # P5.1 ChatStateProvider + useChatState
│   ├── chat-streaming.ts             # P5.1 pure reducer: appendPartial / finalize / reconcile
│   ├── markdown-render.tsx           # P5.1 extended markdown subset (was markdown.tsx)
│   ├── button-primitives.tsx         # P5.1 <ButtonOptionRow /> + <ImageGalleryRow />
│   ├── citation-chip-row.tsx         # P5.1 horizontal pill row for citations
│   ├── upload-client.ts              # P5.1 multipart upload for image attachments
│   ├── projects.ts                   # Dev-stub project list
│   ├── focus-client.ts               # /api/app/focus (P5.5)
│   ├── tasks-client.ts               # /api/app/tasks (P5.4)
│   ├── reminders-client.ts           # /api/app/reminders (P5.4)
│   ├── docs-client.ts                # /api/app/docs (P7.0 / P7.1)
│   ├── doc-links.ts                  # neutron://docs/… resolver (P7.3)
│   ├── project-state.tsx             # P5.2 — <ProjectStateProvider> + useProjectState()
│   ├── project-state-reducer.ts      # P5.2 — pure reducer for the project tab shell
│   ├── projects-client.ts            # P5.2 — typed /api/app/projects/<id>/settings
│   ├── last-tab-storage.ts           # P5.2 — per-project last-tab persistence
│   ├── launcher-client.ts            # /api/app/launcher + chat-send build-me (P5.3)
│   ├── launcher-state.tsx            # P5.3 — <LauncherStateProvider> + useLauncherState()
│   ├── launcher-state-reducer.ts     # P5.3 — pure reducer (LOAD/MUTATE/BUILD_ME)
│   ├── launcher-grid-layout.ts       # P5.3 — pure columnsForWidth + tileSizeFor
│   ├── task-state.tsx                # P5.4 — <TaskStateProvider> + useTaskState()
│   ├── task-state-reducer.ts         # P5.4 — pure reducer (LOAD/SET_FILTER/MUTATE)
│   ├── task-row-formatters.ts       # P5.4 — pure due-date / focus-score / chip-kind helpers
│   ├── task-formatters.ts            # P5.4 — normalizeDueDate helper
│   ├── admin-client.ts               # /api/app/admin (P5.7)
│   ├── cores-client.ts               # /api/cores + OAuth surfaces
│   ├── devices-client.ts             # Device push registry (P5.6)
│   └── push.ts                       # Expo Push registration (P5.6)
├── assets/images/                    # Icon + splash + adaptive icon set
├── app.json                          # Expo config (managed workflow, scheme=neutron)
├── eas.json                          # EAS Build profiles (dev / preview / production)
├── eslint.config.js                  # Flat config — eslint-config-expo
├── package.json
└── tsconfig.json
```

## Chat surface (P5.1)

The per-project chat tab at `/projects/[id]/chat` is the production
conversation surface. Module split per
`docs/plans/P5.1-chat-surface-sprint-brief.md` § 4.9:

- **`app/projects/[id]/chat.tsx`** — thin composition shell (≤130 LOC).
  Wires `<ChatStateProvider>` around `<ConnectionBanner>` + the message
  `<FlatList>` + `<InputComposer>`.
- **`lib/chat-state.tsx`** — `<ChatStateProvider>` + `useChatState()`.
  Owns the `AppWsClient` lifecycle, the reducer dispatch, and a 10s echo-
  timeout watchdog that flips un-echoed pending bubbles to failed.
- **`lib/chat-streaming.ts`** — pure-function reducer: `appendPartial`,
  `finalizeMessage`, `reconcileEcho`, `addOptimisticUserMessage`,
  `markSendFailed` / `markSendRetrying`, `recordChoice`, plus the typed
  `ChatAction` discriminated union.
- **`lib/markdown-render.tsx`** — extended markdown subset for chat
  (renamed from `markdown.tsx`). Handles H1–H4 + fenced code with
  copy-button + inline code + bold + italic (`*` AND `_`) +
  strikethrough + bullet / numbered / task-list / one-level nested lists
  + blockquotes + horizontal rules + tables (capped 6×20 in chat) +
  links + images. URL allow-list rejects `javascript:` / `mailto:` /
  unknown schemes.
- **`lib/button-primitives.tsx`** — `<ButtonOptionRow />` + `<ImageGalleryRow />`
  with proper post-back: tap → emits a `user_message` envelope whose
  body is `option.value` (NOT label); the gateway's outstanding-prompt
  store maps the value back to the canonical `ButtonChoice`.
- **`lib/citation-chip-row.tsx`** — horizontal scrollable pill row with
  Google s2 favicons + 🔗 fallback.
- **`lib/upload-client.ts`** — `uploadAttachment({uri, token, base_url, onProgress})`
  multipart POST to `/api/app/upload`.
- **`components/MessageItem.tsx`** — pure single-message renderer.
  Streaming cursor: `Animated.Value` pulse 0.3↔1.0 at `MOTION.pulse` = 600ms.
- **`components/InputComposer.tsx`** — multiline `TextInput` (1 line auto-
  growing to 140px max), web paperclip → hidden `<input type=file>`,
  Cmd/Ctrl-Enter send on web, char counter at 90% / 100% of the 16k cap.
- **`components/ConnectionBanner.tsx`** — yellow `Reconnecting…` after
  2s stall threshold; red `Auth failed` with Sign out + `__DEV__` hint.

Streaming uses the `agent_message_partial` envelope (`{v, type,
message_id, body_delta, ts, project_id?}`) — successive partials
concatenate into a growing buffer, the canonical `agent_message`
finalizes the buffer with metadata. The substrate dispatcher doesn't
emit partials yet; the client primitive lands inert at P5.1 and is
exercised entirely by tests. Image attachments ride on
`AppWsInboundUserMessage.attachments?: string[]` (capped at 8 entries
/ 512 chars per URL via the gateway's allow-list).

## Launcher (P5.3)

The per-project Apps launcher at `/projects/[id]/launcher` is the production
iPhone-style home-screen grid. Module split per
`docs/plans/P5.3-launcher-sprint-brief.md` § 5.1:

- **`app/projects/[id]/launcher.tsx`** — thin route composition (~250 LOC).
  Wires `<LauncherStateProvider>` around `<LauncherGrid>` + the three modals
  (`<LauncherItemMenu>`, `<LauncherRenameModal>`, `<LauncherBuildMeModal>`).
- **`lib/launcher-state.tsx`** — `<LauncherStateProvider>` +
  `useLauncherState()` exposes `{entries, loading, error, mutating,
  building_me, reorder, rename, uninstall, sendBuildMe, refresh,
  dismissError}`. Server-authoritative: every mutation REPLACES state with
  the gateway's post-mutation ordered list (no optimistic reorder flip — per
  brief § 4.5 the gateway is the single source of truth across users on the
  same instance).
- **`lib/launcher-state-reducer.ts`** — pure-function reducer covering
  LOAD / MUTATE / BUILD_ME / DISMISS_ERROR. 100% unit-testable via
  `app/__tests__/launcher-state-reducer.test.ts`.
- **`lib/launcher-grid-layout.ts`** — pure adaptive-grid math.
  `columnsForWidth(width, platformIsWeb)` returns 4 on native always
  (iPhone paradigm locked) and 4 / 5 / 6 / 7 across the four web bands
  (≤480 / 481–`BREAKPOINTS.narrow_max` / 800–1280 / 1281+).
  `tileSizeFor(cols, container_width)` derives the square edge length
  from container width via flex-basis arithmetic, clamped to
  `[TILE_MIN, TILE_MAX]`.
- **`lib/launcher-client.ts`** — typed REST wrapper for the four launcher
  routes (`list` / `reorder` / `uninstall` / `rename`) PLUS the new
  `sendBuildMePrompt({project_id, prompt})` method that POSTs the canonical
  body to `/api/app/chat/send`. The build-me path lives in this typed
  client so the production-composer-reachability guard test reaches it.
- **`components/LauncherGrid.tsx`** — adaptive grid + HTML5 drag-drop on
  web (the `dragSlugRef` pattern). Reads `useWindowDimensions()` +
  `Platform.OS` to compute columns + tile size on every resize.
- **`components/LauncherItem.tsx`** — pure-props single tile. Emoji at
  `TYPOGRAPHY.h1 × 1.55` + label at `TYPOGRAPHY.body_small`. Long-press
  delay `MOTION.fast × 2` (300ms — inside Apple HIG's 250–500ms band).
- **`components/LauncherBuildMeTile.tsx`** — dashed-border "Build me…"
  tile rendered as the LAST item in the grid (the iPhone-paradigm
  install affordance).
- **`components/LauncherItemMenu.tsx`** — centered Modal action sheet.
  Rename / Edit (disabled — "Coming soon") / Update (disabled) / Move ← /
  Move → / Delete + Cancel. Disabled state via
  `accessibilityState={{disabled: true}}`. Destructive row tinted
  `THEME.danger` @ ~10% alpha.
- **`components/LauncherRenameModal.tsx`** — single-line TextInput +
  Cancel / Save.
- **`components/LauncherBuildMeModal.tsx`** — multiline TextInput +
  Cancel / Send with in-flight spinner.

Reorder behaviour:
- **Web** — HTML5 `draggable` + `onDragOver` + `onDrop` on each tile.
  The `dragSlugRef` ref carries the dragged slug across handlers
  (HTML5 DnD's dataTransfer is unreliable across RN-web).
- **Native** — no touch-drag-with-finger primitive at P5.3 (would
  require `react-native-draggable-flatlist` + prebuild). Long-press →
  action sheet → tap "Move ←" / "Move →" reorders by one slot per tap.

Build-me path: tap the "Build me…" tile → `<LauncherBuildMeModal>` →
type prompt → Send. The state-provider's `sendBuildMe(prompt)` calls
`LauncherClient.sendBuildMePrompt({project_id, prompt})` which POSTs
`{body: 'Build me a Core that ${prompt}', project_id}` to
`/api/app/chat/send`. On success the route replaces to the chat tab so
the user sees the agent's reply land in chat. The full Core-build
pipeline (agent scaffolds + hot-installs the new icon) is P9.

Theme tokens (per brief § 4.11 — every value sources from `lib/theme.ts`,
no new tokens added in P5.3): page bg → `THEME.background`; tile surface
→ `THEME.surface`; pressed → `THEME.surface_raised`; border →
`THEME.hairline`; build-me border → `THEME.text_muted` dashed; tile
radius → `DENSITY.bubble_radius + 4`; gutter → `SPACING.md`; edge padding
→ `SPACING.lg`; long-press delay → `MOTION.fast * 2`; press transition
opacity via `Pressable`'s `pressed` style state.

## Tasks tab (P5.4)

The per-project Tasks tab at `/projects/[id]/tasks` is the production
traditional-task-app surface. Module split per
`docs/plans/P5.4-task-tab-sprint-brief.md` § 5.1:

- **`app/projects/[id]/tasks.tsx`** — thin route composition (~170 LOC).
  Wires `<TaskStateProvider>` around `<TaskHeader>` + `<TaskFilterChips>`
  + `<TaskList>` + `<TaskCreateModal>` + `<TaskEditModal>`.
- **`lib/task-state.tsx`** — `<TaskStateProvider projectId>` +
  `useTaskState()` exposes `{tasks, loading, error, mutating, filter,
  setFilter, refresh, create, update, complete, cancel, delete,
  toggleDone, dismissError}`. Server-authoritative: every mutation
  re-fetches the filtered list and `MUTATE_OK` REPLACES tasks (no
  optimistic checkbox flip — per brief § 4.9 the round-trip cost is
  well within the acceptable feedback band and multi-user consistency
  + the post-complete focus-score re-sort make optimistic UI a
  footgun). Default sort is `?order=focus_score` (the P6 opt-in)
  so P6's focus_score column becomes user-visible without a UI
  gesture.
- **`lib/task-state-reducer.ts`** — pure reducer covering LOAD /
  SET_FILTER / MUTATE / DISMISS_ERROR. 100% unit-testable via
  `app/__tests__/task-state-reducer.test.ts`.
- **`lib/task-row-formatters.ts`** — pure helpers extracted from
  `<TaskRow>` so they stay importable under `bun test`:
  `formatDueDateLabel`, `localTodayString`, `computeDueKind`
  ('overdue' | 'today' | 'future' | null), `formatFocusScore`,
  `priorityChipKind` / `dueChipKind` (chip color ramp).
  `ALPHA_TINTS` carries the '38' / '22' / '5a' suffixes for the
  alpha-tinted chip backgrounds.
- **`lib/task-formatters.ts`** — `normalizeDueDate(raw)` shared
  between TaskCreateModal + TaskEditModal.
- **`lib/tasks-client.ts`** — extended in P5.4 with the optional
  `order?: TaskOrder` argument on `.list` so the typed client
  carries the `?order=focus_score` opt-in. `Task` adds optional
  `focus_score?: number | null`.
- **`components/TaskHeader.tsx`** — Tasks title + subtitle +
  primary-tinted `+ New task` button.
- **`components/TaskFilterChips.tsx`** — three-chip status filter
  (Open / Done / All) with `accessibilityRole="tab"` /
  `accessibilityState.selected` + inverted dark-on-light active
  treatment.
- **`components/TaskList.tsx`** — pure container. Owns error banner
  (tap-to-dismiss, danger-tinted), loading indicator, empty state,
  the mapped `<TaskRow>` children, AND the wide-web 720 CSS px
  content-cap centering (`Platform.OS === 'web'` AND `width >
  BREAKPOINTS.narrow_max`).
- **`components/TaskRow.tsx`** — pure-props single row. Left
  affordance is a 24×24 circle checkbox with a 44×44 hit target
  (Apple HIG). Status-aware: empty outline open / filled
  `THEME.text_primary` + `✓` done / muted outline + `×` cancelled
  (cancelled is read-only — disabled press). Tap-checkbox →
  `onToggleDone(task)`. Tap-elsewhere → `onPress(task)` opens edit
  modal. Title gets strikethrough+muted on done, italic+muted on
  cancelled, primary on open; two-line truncation. Sub-meta row
  (only when at least one of priority / due_date / focus_score is
  non-null): priority chip (P0 danger-tinted descending to P3
  muted), due chip (overdue→danger, today→warning, future→muted),
  focus-score chip `★ X.Y` (the only place P6's column becomes
  user-visible at P5.4). `mutating` prop fades the checkbox to
  0.6 opacity for round-trip feedback.
- **`components/TaskCreateModal.tsx`** — centered Modal-overlay
  create form (title autofocus required; description / due-date /
  priority optional). Cancel + Create with in-flight
  `ActivityIndicator` on Create when `submitting === true`.
- **`components/TaskEditModal.tsx`** — centered Modal-overlay edit
  form with TWO-row action layout: Close / Save in the neutral
  top row; Mark done / Cancel task / Delete in a visually-separated
  destructive bottom row with a hairline divider between. Delete
  uses `THEME.danger`-tinted background + border + text. Mark done
  hidden when status='done'; Cancel task hidden when
  status='cancelled'. Closes the MVP-era footgun where Delete sat
  at equal visual weight to Cancel-task.

Production-composer-reachability guard:
`gateway/__tests__/tasks-production-composer.test.ts` boots a full
`composeProductionGraph` against in-memory SQLite + dev-bypass
`AppWsAuthResolver` and asserts every tasks route is reachable
end-to-end via the same composer chain production uses (mirrors
P5.3's launcher-production-composer test).

## Run locally

From the repo root:

```bash
bun install
cd app
bun run web      # browser: http://localhost:8081
bun run ios      # requires Xcode + iOS Simulator
bun run android  # requires Android Studio + emulator
```

Dev-token lane against a local gateway:

```bash
# Boot a gateway with the dev-secret env set
NEUTRON_APP_WS_DEV_SECRET=devsecret bun --cwd gateway run dev

# In the app, paste `dev:sam` (or an HS256 JWT signed by devsecret) into
# the /login dev-token field
```

## Checks

```bash
cd app
bun run typecheck       # tsc --noEmit
bun run lint            # expo lint (eslint-config-expo)
bun run build:web       # expo export --platform web → dist/

# From repo root, run the app unit tests:
bun test app/__tests__/
```

## EAS

`eas.json` ships with `development` / `preview` / `production` build profiles.
EAS account binding (`eas login` + `eas project:init`) is deferred — the owner
runs this once before the first cloud build.
