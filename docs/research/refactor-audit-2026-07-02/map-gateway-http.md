# Subsystem map: gateway-http (`gateway/http/`)

Auditor: subsystem mapper (full-architecture audit of Neutron Open), 2026-07-02.
All paths relative to `/Users/ryan/repos/neutron-open` unless absolute.

---

## 1. Purpose & responsibilities

`gateway/http/` is the per-instance gateway's HTTP + WebSocket surface layer. It:

1. **Composes** every route the single Bun process serves into one `{ fetch, websocket }` pair for `Bun.serve` (`compose.ts:833 composeHttpHandler`), with an explicit first-match-wins precedence chain and an optional browser auth gate evaluated before dispatch.
2. **Bridges chat**: `chat-bridge.ts` is the production `ChatBridge` that connects the WS chat surface to the onboarding `InterviewEngine`, the live-agent turn runner, the per-project "group chat" engagement gate, the Cores slash-command filter, and the scribe knowledge-extraction hook. It also owns the in-memory topic→socket sender registry that every outbound emit routes through.
3. **Serves the Expo/web app API**: ~20 `app-*-surface.ts` modules, one per product feature (tasks, reminders, docs, projects, focus, admin, devices, tabs, work-board, credentials, backups, upload, launcher, persona, connect-auth), all sharing one handler contract: `(req) => Promise<Response | null>` where `null` means "not my path, fall through".
4. **Stores things it probably shouldn't**: `doc-store.ts` (a full filesystem markdown document store with path-containment security, optimistic concurrency, versioning hooks), `project-launcher-store.ts` (in-memory launcher tiles), `recovered-reply-store.ts` (crash-recovery reply buffer), `keyed-mutex.ts` (generic per-key mutex).

## 2. Module inventory

39 source files, 20,136 lines total (`wc -l`). Big files:

| file | lines | role |
|---|---|---|
| `chat-bridge.ts` | 3,113 | ChatBridge factory + sender registry + JWT slug shim + routed senders + project-topic inbound engine + (dead) slug-picker hook |
| `app-docs-surface.ts` | 1,858 | docs CRUD + history/revert/diff + binary upload + comments + escalate-to-chat |
| `doc-store.ts` | 1,605 | filesystem DocStore (path safety, tree walk, atomic writes, 409s) |
| `compose.ts` | 1,405 | route composition; ~700 of those lines are doc comments on ~30 optional handler slots |
| `app-projects-surface.ts` | 1,181 | project list/settings/archive/restore + members + invite delegation + shared-projects merge |
| `app-ws-surface.ts` | 866 | `/ws/app/chat` upgrade + `/api/app/chat/send`; wraps `AppWsAdapter` |
| `app-admin-surface.ts` | 771 | `/api/app/admin/*` (personality, restart, GBrain browse, connectors, backups, max-reauth) |
| `cores-oauth-surface.ts` | 723 | Google OAuth start/ingest/status/disconnect for Cores |
| `app-reminders-surface.ts` | 668 | reminders CRUD + convert |
| `admin-personality-surface.ts` | 610 | `/api/app/persona/*` 3-file editor + restart-from-scratch |
| others | 100–530 | one file per feature surface; small utility leaves (`web-topic-id.ts` 22, `auth-helpers.ts` 99, `cookie-user-claim.ts` 109, `keyed-mutex.ts` 104) |

## 3. Public seams / contracts consumed by other subsystems

- **`composeHttpHandler(input) → { fetch, websocket }`** (`compose.ts:833`) — consumed by `gateway/composition.ts:297` (module-graph boot) and `gateway/boot-helpers.ts`. The `ComposeHttpHandlerInput` slot list *is* the route table of the whole product.
- **`buildWebChatBridge(opts) → ChatBridge`** (`chat-bridge.ts:1052`) — consumed by `gateway/realmode-composer/build-landing-stack.ts` and `open/composer.ts`. The `ChatBridge` interface itself is defined in `landing/server.ts` (the landing package owns the type; http implements it — an inverted but load-bearing seam).
- **`WebChatSenderRegistry`** (`chat-bridge.ts:162`) — the process-wide topic→socket send map. Consumed by `reminders/outbound.ts`, `gateway/proactive/button-store-sink.ts`, `gateway/realmode-composer/build-wow-dispatcher.ts`, `gateway/comments/agent-watcher.ts`, `open/composer.ts`. Anything that wants to push to a live web socket goes through this.
- **`renderButtonPromptForWeb`** (`chat-bridge.ts:421`) — ButtonPrompt→ChatOutbound converter reused by proactive/wow/comment-watcher emitters.
- **`webTopicId(user_id)`** (`web-topic-id.ts`) — canonical `web:<uid>` topic shape; extracted leaf to break an http↔realmode-composer cycle (`chat-bridge.ts:226-232`), re-exported from chat-bridge for compat.
- **`DocStore`** (`doc-store.ts:404`) — consumed outside HTTP by `open/composer.ts:157`, workboard spec-persist (PR #178), doc-search. It is a storage engine, not an HTTP concern.
- **Per-surface factories `createXxxSurface(opts) → { handler }`** — consumed by the three composition roots (below). The uniform disclaim-with-null contract is the subsystem's one genuinely good, consistent idea.
- **`buildCookieUserClaim`** (`cookie-user-claim.ts:70`) — cookie→claim resolver shared by WS upgrade, chat-history, chat-topics, connect-auth.
- **`ProjectSettingsStore`** interface (`app-projects-surface.ts:203`) — implemented by `gateway/projects/sqlite-store.ts` for production; the in-memory class here is test/legacy.

## 4. Dependencies

**In (who consumes this subsystem):** `gateway/composition.ts` + `gateway/boot-helpers.ts` (boot), `gateway/realmode-composer/*` (Managed-heritage landing stack, live-agent turn, wow dispatcher), `open/composer.ts` (12 direct imports — the Open boot path), `reminders/outbound.ts`, `gateway/comments/agent-watcher.ts`, `gateway/proactive/button-store-sink.ts`, `gateway/projects/shared-projects-resolver.ts`, `open/chat-topics-surface.ts` (type reuse), scribe/tests.

**Out (what this subsystem imports):** by relative-import count: `channels/adapters/app-ws` (22× `auth.ts`, 12× `envelope.ts` — the bearer resolver + wire envelope are the de-facto shared kernel), `runtime/` (11: platform-adapter, start-token-types, pending-redirect-types, constant-time-equal), `persistence/` (9), `trident/` (7: store, codex-credential), `cores/` + `gateway/cores/` (13), `landing/` (5: server types, auth-gate, spa-routes, session-cookie), `onboarding/interview` (engine + state-store types), `connect/agent-engagement.ts`, `tasks/`, `work-board/`, `project-credentials/`, `auth/secrets-store.ts`, `migrations/runner.ts`, gateway siblings `../git`, `../storage`, `../comments`, `../projects`, `../push`, `../connect`, `../realmode-composer`.

**Package.json is decorative:** `gateway/package.json` declares only cores/* + gbrain-memory + jose; everything else (landing, onboarding, channels, persistence, runtime…) is reached by bare relative path across workspace boundaries. The workspace seam is bypassed wholesale — true across the repo, but this directory is one of the heaviest offenders.

**Cycle (re-introduced):** `chat-bridge.ts:116` imports `../realmode-composer/build-onboarding-handoff.ts` (for one string constant `ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE`) while `realmode-composer/build-wow-dispatcher.ts:89-90` and `build-landing-stack.ts:177,716,908` import `../http/chat-bridge.ts`. A previous audit (R5/P1-2) extracted `web-topic-id.ts` to kill exactly this cycle class; the constant import re-created it.

## 5. Internal layering (as-built)

```
compose.ts                          ← route composition + auth-gate stitch + WS multiplex
  ├─ ~30 optional handler slots     ← one interface per surface, all identical shape
  ├─ app-*-surface.ts (×20)         ← parse path → resolveBearer → validate → store call → json
  │    └─ stores: TaskStore, ReminderStore, DocStore, WorkBoardStore, ProjectSettingsStore,
  │              CommentStore, BinaryStore, DocVersionStore, SecretsStore, TridentStore…
  ├─ chat-bridge.ts                 ← ChatBridge impl + sender registry (chat is NOT a surface;
  │                                    it plugs into landing/server.ts's WS handler)
  ├─ app-ws-surface.ts              ← the OTHER chat path (Expo `app:` topics via AppWsAdapter)
  └─ leaves: auth-helpers, cookie-user-claim, web-topic-id, keyed-mutex
```

Notable: there are **two parallel chat WS stacks** — the landing-server-hosted `web:` topic path driven through `ChatBridge` (chat-bridge.ts) and the `app:` topic path in `app-ws-surface.ts` over `AppWsAdapter`. They share the envelope/auth modules in `channels/adapters/app-ws/` but duplicate policy (slash-command filter exists in both: `app-ws-surface.ts:122 ChatCommandFilter` and `chat-bridge.ts:1706` which imports the type *from app-ws-surface*).

There are **three composition roots** wiring these surfaces: `gateway/composition.ts` (module graph → `composeHttpHandler`), `gateway/realmode-composer/build-landing-stack.ts` (Managed-heritage landing/chat stack, called from `gateway/index.ts`), and `open/composer.ts` (the Open self-host path, 12 direct imports of http modules). Which surfaces exist at runtime depends on which root you booted through — e.g. `open/composer.ts` never mounts the launcher surface, and it mounts its own fork of chat-topics (see debt #7).

## 6. Architectural debt

### D1 — `chat-bridge.ts` is a god file with ≥9 responsibility clusters — **P1**
Evidence (line-ranged clusters):
1. Sender/session registries: `chat-bridge.ts:162-292` (`WebChatSenderRegistry`, `WebChatSessionProjectRegistry`).
2. Live-agent turn contract + eligibility gate + typing bracket: `:294-420`.
3. Wire rendering: `renderButtonPromptForWeb` `:421`, `normalizeUploadAffordance` `:473`, `renderSlugRenameConfirmationForWeb` `:498`.
4. Routed senders for engine emits: `buildRoutedSendButtonPrompt` `:694`, `buildRoutedSendImportProgress` `:664`.
5. JWT slug-history shim + owner-registry lookup: `:521-838` (`InMemorySlugHistoryCache`, `buildSlugHistoryShimFromRegistry`).
6. The `ChatBridge` factory proper (4 entry points: `validateStartToken` `:1069`, `startSession` `:1224`, `resumeCookieSession` `:1462`, `handleInbound` `:1544`) — itself a 950-line closure containing token auth, topic-switch protocol, sentinel rejection, command filter, scribe fan-out, live-agent gating, engine dispatch.
7. Slug-picker engine hook: `:2027-2511` — **dead in this repo** (see D6).
8. A second, distinct inbound dispatch engine for project topics: `handleProjectTopicInbound` `:2664-3044` + `persistProjectUserTurnOnly` `:2545` + `persistProjectStubTurn` `:2601` — engagement-mode gating, tag-to-delegate, stub persistence.
9. Seed-prompt re-emit policy: `reEmitActiveSeedPromptIfAny` `:3044+`, invoked from three entry points that must stay in lockstep (`:1473-1477` documents this).
Sketch: split into `sender-registry.ts`, `render-outbound.ts`, `start-token-validate.ts`, `bridge-sessions.ts` (start/resume/close), `bridge-inbound.ts` (General dispatch), `project-topic-inbound.ts`, `seed-reemit.ts`; delete cluster 7. The 10 existing chat-bridge test files already partition along these lines, so the split is test-guided.

### D2 — 19 verbatim copies of `resolveBearer` + 12 of `jsonError` + N of `readJsonBody` — **P1**
`resolveBearer` is byte-identical (md5-verified for tasks/reminders/launcher/work-board; a trivial variant in tabs) in 19 files: `app-tasks-surface.ts:415`, `app-launcher-surface.ts:226`, `app-reminders-surface.ts:577`, `app-docs-surface.ts:1638`, `app-projects-surface.ts:1139`, `app-backups-surface.ts:279`, `admin-personality-surface.ts:557`, `app-admin-surface.ts:730`, `app-focus-surface.ts:498`, `app-devices-surface.ts:176`, `app-focus-current-surface.ts:216`, `cores-oauth-surface.ts:662`, `app-tabs-surface.ts:193`, `app-upload-surface.ts:352`, `codex-credential-surface.ts:121`, `cores-surface.ts:504`, `cores-integrations-surface.ts:223`, `work-board-surface.ts:322`, `project-credentials-surface.ts:179`. `function jsonError` (identical `{ok:false, code, message}` body) in 12 files (grep count). Each copy also re-declares private `ResolvedAuth`/`AuthFailure` interfaces. A security fix to bearer parsing currently requires 19 synchronized edits. Sketch: one `surface-kit.ts` (or promote `auth-helpers.ts`) exporting `resolveBearer`, `jsonError`, `jsonOk`, `readJsonBody`, and a `matchProjectPath(prefix, re)` helper; mechanical per-file substitution, zero behavior change (the JSON error shape is a client contract — keep bytes identical).

### D3 — `compose.ts`: hand-rolled 30-branch precedence chain + 30 duplicate interface declarations — **P1**
`compose.ts:49-263` declares ~20 interfaces that are all literally `{ handler: (req) => Promise<Response | null> }` (`AppWsHandler` is the one real exception — it carries `websocket`). `ComposeHttpHandlerInput` (`:265-682`) has ~40 optional fields; the dispatch function (`:950-1298`) is a 350-line ladder of `if (x !== undefined) { const r = await x.handler(req); if (r !== null) return r }` repeated ~25 times, plus special-cased exact-path branches for cache-invalidate/slug-check/avatar/candidate/import-upload. Adding a surface today means: new interface + new input field + new destructure entry (`:834-872`) + new dispatch branch + possibly a `LANDING_PATHS` entry — 5 edit sites, each a chance to get ordering wrong. Sketch: one `HandlerSlot = { handler }` type; composition roots pass an **ordered array** of named slots (order stays explicit and testable — `compose.test.ts` already asserts precedence); keep the auth-gate wrapper and WS multiplex as-is. Only genuine ordering constraints (chunked-before-legacy-upload `:1047-1072`, focusCurrent-before-focus `:1184-1195`, coresOAuth/integrations-before-cores `:1245-1266`, per-project children before `appProjects` `:1125-1168`) need to be encoded; most surfaces disclaim correctly and are order-independent.

### D4 — `LANDING_PATHS` manual allowlist is a recurring production-404 factory — **P2**
`compose.ts:722-752`. The comments themselves document three separate production incidents caused by forgetting an entry: `/start` (ISSUES #59, `:717-720`), `/api/v1/chat/history` (`:731-735`), `/mobile` + PWA assets (ISSUES #208, `:740-747`), plus the `oauth/max/install-token` prefix special case bolted onto `isLandingRoute` (`:762`). The landing server knows its own routes; the gateway re-declares them by hand and drifts. Sketch: have `createLandingServer` export its route predicate/manifest and consume it here (behavior-preserving if the generated set equals the current literal set — assert equality in a test during transition).

### D5 — auth identity-comparison invariant violated by 10 surfaces — **P2**
`auth-helpers.ts:84-88` declares: "Call sites MUST use `ownerIdentityMismatch` — never a raw `!==` / `ownerSlugMismatch` on a claim's project_slug vs a gateway-bound slug" (the 2026-06-10 slug-rename P0: url_slug vs frozen internal_handle divergence 401'd every cookie-authed request). Only `cookie-user-claim.ts:86`, `chat-history-surface.ts`, `chat-topics-surface.ts`, `app-connect-auth.ts` comply. Ten files still raw-compare via `ownerSlugMismatch`: `app-docs-surface.ts:187,237`, `cores-oauth-surface.ts:228,518`, `admin-personality-surface.ts`, `app-admin-surface.ts`, `app-backups-surface.ts`, `app-reminders-surface.ts`, `app-tasks-surface.ts:397`, `app-upload-surface.ts`, `cores-integrations-surface.ts`, `chat-bridge.ts`. Mitigations: bearer-path resolvers verify the signed slug earlier, and Open single-owner installs don't rename slugs — so this is latent, not live. But it is the exact bug class that already caused a P0, half-fixed. Fixing it during the refactor (route all surface auth through one shared resolver that does the canonical compare once) collapses D2 and D5 together.

### D6 — dead / dormant code — **P2**
- **`buildSlugPickerEngineHook` + `ProcessSlugPickerReplyFn` + `renderSlugRenameConfirmationForWeb`** (`chat-bridge.ts:2027-2511` + `:498-520`, ~490 lines): exported, zero importers anywhere in the repo (repo-wide grep). `build-landing-stack.ts:170` accepts an *injected* `slugPicker` and nothing in this repo constructs one — this is a Managed-only artifact stranded by the C2 OSS split. Includes its own NODE_ENV=test write-guard machinery (`:2391`).
- **`project-launcher-store.ts` (431 lines) + `app-launcher-surface.ts` (265 lines)**: `createAppLauncherSurface` has no production construction site in this repo — only tests and the optional `composition.app_launcher_surface` slot (`gateway/composition.ts:185-186`) which no composer populates; `open/composer.ts` has zero "launcher" references. The store's own header says the in-memory implementation was to be "replaced next sprint" by `cores/runtime/installations-store.ts` (`project-launcher-store.ts:23-28`) — the replacement (tabs surface) shipped, the old surface was never removed.
- **`InMemoryProjectSettingsStore`** (`app-projects-surface.ts:278-368`): superseded in production by `gateway/projects/sqlite-store.ts` (its header says so, `sqlite-store.ts:10`); retained for tests but living in the production surface file.
- **`internalCacheInvalidateHandler` / slug-history shim / `ownerRegistry` lookup** (`compose.ts:295-299`, `chat-bridge.ts:749-838`): rename-orchestration machinery for the multi-instance Managed fleet; in a single-owner Open install these paths are configured-never-fired. Candidates for the Connect/Managed disentanglement track rather than deletion.

### D7 — Open-vs-Managed forked surface: two chat-topics implementations — **P2**
`open/chat-topics-surface.ts` reimplements `gateway/http/chat-topics-surface.ts` with the same wire shape but a different data source (projects table vs button_prompts enumeration) because the http one rendered an empty sidebar on Open (its own header, `open/chat-topics-surface.ts:8-17`). Two implementations of one route contract, selected by boot path, drift-prone. The refactor should make the data source injectable (a `listTopics` seam) and keep one surface.

### D8 — `app-docs-surface.ts` second god file + storage classes living in the HTTP layer — **P2**
`app-docs-surface.ts` mixes five products: docs CRUD (`:349-506`), version history/revert/diff (`:508-736`, git-backed), binary attachment storage (`:737-934`), a full comments subsystem router (`:935-1589`, 6 handlers), and an escalate-to-chat side-channel that mutates the chat session registry (`:1422`, coupling docs→chat via `WebChatSessionProjectRegistry` imported from chat-bridge `:44`). Meanwhile `doc-store.ts` (1,605 lines), `recovered-reply-store.ts`, `project-launcher-store.ts`, and `keyed-mutex.ts` are not HTTP at all — they are storage/concurrency primitives consumed by other subsystems (`open/composer.ts:157` imports DocStore directly). Sketch: move stores to `gateway/storage/` (or a docs package) and split the docs surface into docs/versions/binary/comments routers composed under one path owner.

### D9 — duplicated chat-command-filter + scribe fan-out between the two chat stacks — **P2/P3**
The slash-command filter runs in `app-ws-surface.ts` (`:658-666` per its own cross-reference) and again in `chat-bridge.ts:1706-1768`, with chat-bridge importing the filter *type* from app-ws-surface (`chat-bridge.ts:1009`) — a sideways type dependency between peer surfaces. The scribe fire-and-forget try/catch block is pasted 4× inside `handleInbound` alone (`chat-bridge.ts:1748-1765, 1811-1829, 1896-1914, 1949-1967`). Mechanical extraction (`fireScribe(opts, input)`), zero behavior change.

### D10 — test placement is three-way inconsistent — **P3**
22 files in `gateway/http/__tests__/`, 4 colocated (`work-board-surface.test.ts`, `codex-credential-surface.test.ts`, `app-connect-auth.test.ts`, `app-connect-auth-session-gate.test.ts`), and ~50 surface tests two levels up in `gateway/__tests__/` (`app-tasks-surface.test.ts`, `app-docs-surface*.test.ts`, `compose-*`, production-composer tests…). Grep-ability and per-surface refactor confidence suffer; pick one convention (`__tests__/` beside the code) and move files.

## 7. Test posture

Strong where it matters most: chat-bridge has 10 dedicated behavior-level test files (`gateway/http/__tests__/chat-bridge*.test.ts`, `replay-redelivery.test.ts`, `owner-slug-timing-safe.test.ts`; `chat-bridge.test.ts` alone has 56 cases) covering the topic-switch protocol, seed re-emit races, typing brackets, JWT shim, engagement mode, command filter. `compose.test.ts` (26 cases) + `compose-start-route.test.ts` + `auth-gate-dispatch.test.ts` pin routing precedence and gate stitching. Every app surface has request-level tests in `gateway/__tests__/`, plus "production-composer" tests asserting the wiring exists (a real strength — they catch unmounted-route regressions like the historical Argus BLOCKING #1 upload 404). Race/TOCTOU tests exist for admin-personality.
Gaps: no tests for `multiplexWebsocket`'s drain path; `project-launcher-store` is tested but unmounted in production (tests assert dead code works); duplication means each `resolveBearer` copy is tested only via whichever surfaces have 401 cases; the two chat stacks (`ChatBridge` vs `AppWsAdapter`) have no shared conformance suite, so parity fixes (e.g. the command filter) land twice. Flake risk is low here (in-memory stores, injected clocks `now?: () => number` everywhere); the known repo flake (PGLite boot) is outside this subsystem.

## 8. Load-bearing subtleties a behavior-preserving refactor MUST keep

1. **Registry `send` must throw, not catch** — `InMemoryWebChatSenderRegistry.send` deliberately propagates sender throws (`chat-bridge.ts:202-219`): the engine converts them to `InterviewError('send_failed')`, leaves `delivered_at` NULL, and reconnect re-emit recovers. Wrapping in try/catch silently kills crash recovery.
2. **Identity-aware unregister (compare-and-delete)** — `chat-bridge.ts:192-200`, `closeSession :1523-1542`, topic-switch `:1598-1603`: an old socket's close must not delete a newer registration. Any registry rewrite must preserve reference-equality semantics of the per-socket send lambda.
3. **`engine.start` BEFORE jti claim** in `startSession` (`:1229`, `:1261-1263`): claim-first would burn the single-use token on a transient engine failure. Duplicate jti claim → `return false` (not an error) so the losing socket downgrades gracefully (`:1391-1403`).
4. **Topic-switch ordering**: seed re-emit BEFORE the `topic_switched` ack (`:1610-1646`) — the client renders the prompt while still in pendingTopicSwitch; the ack releases hydration. Mid-await supersede detection reads live `getActiveTopicId` (`:1627-1635`).
5. **Recovered-reply drain gated on `wire_topic_id === topic_id`** (`:1450`, `:1512`): draining General-keyed rows into a project-topic socket = cross-topic bleed + false markDelivered (Argus r6 BLOCKER).
6. **`recordInboundReceived` BEFORE `engine.advance`** (`:1918-1929`): the marker suppresses stale prompt re-emit if a reconnect lands mid-advance.
7. **Typing bracket**: `agent_typing_start` before every engine/live-agent dispatch, `agent_typing_end` in `finally` (`:1940-1945`, `:1994-1999`, `:2717-2741`). Server-deterministic; clients rely on it.
8. **Sentinel rejection at the boundary**: `FORBIDDEN_INBOUND_VALUES` check on inbound `button_choice` (`:1685-1695`) prevents a prompt-TTL lockout class; it protects *all* resolve branches including future ones — must stay ahead of any dispatch.
9. **Live-agent eligibility is `phase==completed` only** — General deliberately ignores a stuck `final_handoff_active` (2026-06-20 GO-LIVE P0, `:1847-1853`); re-adding that condition re-silences General.
10. **Scribe + command filter + engagement hooks are fail-soft**: every one is try/caught so a hook throw degrades to normal dispatch (`:1729-1736` etc.). `tag_gated` no-mention posts still persist the transcript and send a no-render `agent_ack` to clear typing dots (`:2767-2790`).
11. **Compose ordering that is semantic, not stylistic**: chunked upload before legacy `POST /api/upload/<source>` (`compose.ts:1047-1072`); `appFocusCurrent` before `appFocus`; per-project children (tabs/work-board/credentials/codex-auth/launcher/tasks/reminders) before `appProjects`; landing matched by explicit path set so a landing 404 can't shadow the connect API (`:1272-1276`); SPA catch-all LAST among landing dispatch (`:1286-1288`); `adminRespawn`/`internal/*` run before the auth gate's path set so operator routes bypass it (`:786-805`).
12. **Auth-gate cookie stitching**: `allow`-with-cookie AND `authenticated` decisions append `set-cookie` onto the downstream response by rebuilding it (`:934-948`) — sliding 30-day refresh; a refactor that returns the downstream Response unmodified silently expires sessions.
13. **WS multiplex discriminator**: `ws.data.surface === 'app_ws'` (`:1332-1335`) set at upgrade time; landing socket data never sets it. Both chat stacks share one `Bun.serve` websocket option.
14. **DocStore security invariants**: reject `..`/hidden/absolute segments, realpath containment after join, `.md` **and** `.markdown` accepted (a previous refactor dropped `.markdown` and it was reinstated as a regression fix — `doc-store.ts:74-83`), temp-file+rename atomic writes, `expected_modified_at` → 409.
15. **`jsonError` wire shape** `{ ok:false, code, message }` with stable `code` strings — Expo client renders on these; consolidating helpers must keep bytes identical.
16. **Auth-gate JSON pass-through**: `Accept: application/json` requests pass the gate un-401'd and the surface self-verifies (`compose.ts:996-1001`) — moving auth "up" into the gate would break mobile bearer flows.

## 9. What the refactor should do here

Ordered, behavior-preserving plan:

1. **Extract `surface-kit.ts`** (resolveBearer, jsonError/jsonOk, readJsonBody, project-path matcher, canonical owner-identity check) and mechanically de-duplicate the 19/12 copies (D2), fixing D5 in the same pass behind a single call site. Pure consolidation; existing per-surface tests are the safety net.
2. **Split `chat-bridge.ts`** along its 9 clusters (D1), deleting the dead slug-picker hook (~490 lines) and the sideways `ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE` / `ChatCommandFilter` imports (move both to neutral leaves, killing the http↔realmode-composer cycle).
3. **Replace `ComposeHttpHandlerInput`'s 40 fields with an ordered slot array** (D3) and derive the landing predicate from the landing server (D4); keep `compose.test.ts` precedence assertions as the contract.
4. **Relocate non-HTTP modules** (`doc-store`, `project-launcher-store`, `recovered-reply-store`, `keyed-mutex`) out of `http/` (D8); split app-docs-surface into per-concern routers.
5. **Unify the forked chat-topics surfaces** behind an injectable topic-lister (D7) and delete the unmounted launcher surface/store after confirming the Managed sibling doesn't consume them (D6).
6. **Converge the two chat stacks' shared policy** (command filter, scribe fan-out) into one module consumed by both (D9); a shared conformance test suite for ChatBridge vs AppWsAdapter behavior would lock parity.
7. Normalize test placement (D10) last — pure file moves.

Steps 1–3 are the highest leverage: they touch every future surface added to the product and are where the copy-paste tax and ordering bugs compound.
