# Subsystem map: chat-transport (`channels/`, `chat-core/`, `message-search/`)

Audit date: 2026-07-02. All paths relative to `/Users/ryan/repos/neutron-open`.

## 1. Purpose & responsibilities

The chat-transport subsystem is the edge messaging layer of Neutron Open:

- **`channels/`** — server-side channel plumbing: the channel-agnostic contract (`ChannelAdapter`, `ChannelRouter`, `IncomingEvent`/`OutgoingMessage`), the Telegram adapter family (webhook server, long-poll, MarkdownV2 composer, UTF-16 truncation, self-echo filter, inline keyboards, callback routing), the app-ws (Expo + React-web) WebSocket adapter family (wire envelopes, session registry, auth resolver, durable chat-log integration), and the cross-channel **ButtonPrompt** primitive with its DB-backed registry (`button-store.ts`, table `button_prompts`, migration 0010).
- **`chat-core/`** — the *client-side*, transport-agnostic chat-sync library (research-doc §5/§7 design): append-only message model ordered by server `seq`, idempotent identity-keyed UPSERT store, reconnecting WS client, offline send-queue, sync engine with resume/gap-fill + stale-server reset detection, receipts (union-monotonic), reactions/edits (rev-LWW), and an FTS-parity message search. Consumed by `app/` (Expo, op-sqlite store) and `landing/chat-react` (React web, OPFS store).
- **`message-search/`** — a thin agent-tool surface (`message_search`) over the chat-core `Store` search contract, with a server-side variant that hydrates an ephemeral in-memory index from `ButtonStore` history per topic.

## 2. Module inventory (prod code, `wc -l`)

| Area | File | LOC |
|---|---|---|
| channels core | `channels/button-store.ts` | 1172 |
| | `channels/button-primitive.ts` | 431 |
| | `channels/button-routing.ts` | 198 |
| | `channels/router.ts` | 185 |
| | `channels/types.ts` | 175 |
| | `channels/index.ts` (barrel) | 173 |
| | `channels/topic-id.ts` | 83 |
| app-ws adapter | `channels/adapters/app-ws/envelope.ts` | 931 |
| | `channels/adapters/app-ws/adapter.ts` | 923 |
| | `channels/adapters/app-ws/session-registry.ts` | 184 |
| | `channels/adapters/app-ws/auth.ts` | 171 |
| telegram adapter | `channels/adapters/telegram/index.ts` | 478 |
| | `channels/adapters/telegram/webhook-server.ts` | 394 |
| | `render-button-prompt.ts` 220, `client.ts` 159, `utf16-truncation.ts` 155, `decoration-emoji.ts` 128, `callback-router.ts` 125, `sync-message-filter.ts` 113, `long-poll.ts` 104, `forum-topics.ts` 69, `inline-keyboards.ts` 69 | |
| app-socket (legacy) | `channels/adapters/app-socket/render-button-prompt.ts` 248, `socket-server.ts` (test mock) | |
| chat-core | `types.ts` 722, `store.ts` 471, `web-session.ts` 357, `search.ts` 282, `sync-engine.ts` 262, `ws-client.ts` 221, `stores/opfs-store.ts` 204, `send-queue.ts` 159 | |
| message-search | `tool.ts` 123, `runtime.ts` 119, `index.ts` 22 | |

Totals (excl. tests): channels ≈ 6,975; chat-core ≈ 2,774; message-search ≈ 264. Tests: ≈ 7,934 LOC across 43 test files.

## 3. Public seams / contracts other subsystems consume

1. **`ButtonStore` over `button_prompts`** (`channels/button-store.ts`) — THE central durable-chat contract. Consumers: `onboarding/interview/engine.ts` (emit/peek/rebindTopicId/resolve — e.g. engine.ts:1308), `gateway/realmode-composer/build-live-agent-turn.ts` (emit at :986, `latestPromptByTopic` at :666, `persistInertUserTurn` at :1124, `listHistoryByTopic` at :1402), `gateway/http/chat-history-surface.ts` + `chat-topics-surface.ts` (`GET /api/v1/chat/history`, `/api/v1/chat/topics`), `gateway/composition/message-search-wiring.ts`, `gateway/http/chat-bridge.ts`.
2. **`ButtonPrompt` primitive + wire caps** (`channels/button-primitive.ts`) — `buildButtonPrompt`/`validateButtonPrompt`/`deriveIdempotencyKey`, the 37-byte value cap, and the reserved sentinels `__freeform__/__timeout__/__cancel__` (`:51-55`). Consumed by onboarding engine, chat-bridge (deep import at `gateway/http/chat-bridge.ts:68,73`), Telegram + app-socket renderers.
3. **`DefaultButtonRouter.routeChoice`** (`channels/button-routing.ts:76`) — single routing path for Telegram callback taps, app-socket `button_choice` frames, freeform fallbacks and sweep timeouts.
4. **`AppWsAdapter` + envelope union** (`channels/adapters/app-ws/adapter.ts`, `envelope.ts`) — the production chat surface seam. `open/composer.ts:3206` constructs it with all four durable logs (`AppChatStore`/`ReceiptStore`/`ReactionStore`/`EditStore` from `persistence/`, migrations 0079/0082/0083/0087); `gateway/http/app-ws-surface.ts` (866 LOC) drives `ingestUserMessage`/`replayAfter`/`recordReceipt`/`recordReaction`/`recordEdit`; agent replies flow via direct `appWsHolder.adapter.send(msg)` calls (`open/composer.ts:2731, 3011, 3041`).
5. **`AppWsSessionRegistry`** (`session-registry.ts:54`) — topic → live-device fan-out; also used directly by reminder/wow/proactive push paths in `open/composer.ts`.
6. **Telegram `buildWebhookHandler`** (`webhook-server.ts`) — mounted by `gateway/realmode-composer/build-telegram-webhook.ts:136` (NOT via the `TelegramAdapter` class; see §6.2).
7. **`parseAnyTopicId`** (`channels/topic-id.ts:57`) — the shared `app:`/`web:`/telegram topic-id parser; deep-imported by `gateway/upload/import-upload-handler.ts`, `open/chat-topics-surface.ts`, `onboarding/interview/engine-internals.ts`, `gateway/realmode-composer/build-onboarding-handoff.ts`. **Not exported from the barrel** (`channels/index.ts` has no `topic-id` export).
8. **chat-core `Store`/`SyncEngine`/`WebChatSession`** (`chat-core/index.ts`) — consumed by `app/lib/chat-core/*` (op-sqlite + mobile session) and `landing/chat-react/*` (controller + OPFS store); `landing/package.json` and `app/package.json` both declare `@neutronai/chat-core`.
9. **`message_search` tool** (`message-search/tool.ts:82` `registerMessageSearchToolSurface`) — registered into the shared ToolRegistry; server runtime built by `gateway/composition/message-search-wiring.ts:110` over ButtonStore history.

## 4. Workspace dependencies

**In (consumers):** gateway (http surfaces, realmode-composer, composition), open/composer, landing (server + chat-react), app (Expo), onboarding (interview engine), trident (delivery/board via gateway seams), tests/integration.

**Out (what this subsystem imports):**
- `channels/package.json` declares `@neutronai/persistence`, `@neutronai/runtime`. Actual imports are **relative** for persistence (`button-store.ts:21`, `router.ts:15` → `'../persistence/index.ts'`) and package-named for runtime (`adapters/app-ws/adapter.ts:30-35`, `adapters/telegram/index.ts:19-27` → doc-link helpers). The app-ws adapter also imports persistence types relatively (`adapter.ts:44-54`).
- `chat-core/package.json` declares **zero** dependencies — a true leaf. (Note the naming split: `@neutronai/chat-core` vs everything else `@neutronai/*`.)
- `message-search/package.json` declares `@neutronai/chat-core` (imported by name) plus `@neutronai/core-sdk` and `@neutronai/tools` — but imports those two **relatively** (`tool.ts:20-21` → `'../core-sdk/types.ts'`, `'../tools/registry.ts'`).

## 5. Internal layering (as designed vs as built)

Designed (per `channels/types.ts:2-9`): adapters implement `ChannelAdapter`, register once via `ChannelRouter.registerAdapter`, all ingress flows through `ChannelRouter.receive` → `TopicHandler`, all egress through `ChannelRouter.send`.

As built in production (`open/composer.ts`):
- Inbound app-ws: a **bespoke inline receiver** (`open/composer.ts:3082` `const appWsReceiver = { receive: ... }`), not `ChannelRouter.receive`.
- Outbound app-ws: **direct** `appWsHolder.adapter.send(msg)` (`open/composer.ts:2731, 3011, 3041`), not `ChannelRouter.send`.
- Telegram: composed by calling `buildWebhookHandler` directly (`gateway/realmode-composer/build-telegram-webhook.ts:136`); `new TelegramAdapter(...)` appears **nowhere outside tests** (verified: repo-wide grep for `new TelegramAdapter|registerAdapter` excluding tests hits only the `registerAdapter` definition at `router.ts:60`).
- A `ChannelRouter` *is* instantiated in the module graph (`gateway/composition/build-core-modules.ts:245`) but no adapter is ever registered on it in production, so `router.send()` would throw `no channel adapter registered` (`router.ts:145-149`).

## 6. Architectural debt

### 6.1 [P1] Three overlapping durable chat models; the transcript is dual-persisted with divergent fidelity
- **Model A — `button_prompts`** (turn-shaped: agent `body` + resolution columns doubling as the user turn; `channels/button-store.ts`). Serves HTTP history (`listHistoryByTopic` :650), the sidebar rail (`listTopicsByUser` :840), onboarding state recovery, reflection (`latestTurnByTopic`/`latestPromptByTopic` :753/:790), and server-side message search (`gateway/composition/message-search-wiring.ts:33-104`).
- **Model B — `app_chat_messages` (+receipts/reactions/edits)** (message-shaped, seq-ordered; migrations 0079/0082/0083/0087, `persistence/app-chat-*.ts`). Serves the app-ws live fan-out, `resume` replay, receipts/reactions/edits.
- **Model C — the chat-core client `Store`** (OPFS/op-sqlite mirror).

Every live agent reply on the app-ws surface is persisted **twice**: `buttonStore.emit(replyPrompt, ...)` at `gateway/realmode-composer/build-live-agent-turn.ts:986` AND `chat_log.append` inside `AppWsAdapter.send` (`adapter.ts:174-196`). The two records disagree in fidelity: `button_prompts` keeps `options_json` but strips `[[OPTIONS]]` from `body` (the memory-noted trap; documented at `button-store.ts:780-789`), while `appChatRowToEnvelope` (`adapter.ts:809-841`) rebuilds a replayed `agent_message` with **body/seq/ts/project_id only — no `options`, `prompt_id`, `citations`, `image_urls`, `doc_refs`** (the 0079 schema doesn't store them). So a fresh device cold-syncing via `resume` gets a degraded transcript relative to a client that was live, and relative to the HTTP history surface. Nothing reconciles A and B; correctness depends on each read path knowing which store to trust (memory note: "app-ws hydrates via chat_log resume not web history surface" — a Codex false-positive trap precisely because of this split).

**Refactor sketch:** pick Model B as the single durable transcript, widen `app_chat_messages` to carry the agent-message metadata (options/prompt_id/citations/doc_refs as JSON columns), make the HTTP history + sidebar + reflection reads project from it, and shrink `button_prompts` back to what its name says (outstanding-prompt lifecycle: emit/resolve/expire/idempotency), with the resolution write-through appending a user message to the log.

### 6.2 [P1] The declared adapter/router seam is fictional in production
Evidence in §5. The consequences: (a) `channels/types.ts`'s "single-registration ABC" doc is misleading to anyone extending the system; (b) `TelegramAdapter` (478 LOC incl. the MarkdownV2 composer) is production-relevant for `send` only if something constructs it — the doc-ref MarkdownV2 pipeline (`telegram/index.ts:136-243`) is reachable only through `adapter.send`, which never runs in prod (Telegram egress goes through `gateway/http/chat-bridge.ts`'s own Telegram sender, :577); (c) the `ChannelRouter` node in the production graph is a landmine (`send` throws). A no-behavior-change refactor must either wire production through the router (registering the app-ws + a Telegram adapter, replacing the bespoke receiver with `TopicHandler`) or delete the router/ABC layer and bless the direct composition — keeping both is the worst state.

### 6.3 [P1] `button-store.ts` is a god file whose table moonlights as a message log
Responsibility clusters inside the 1,172 lines: (1) prompt registry + idempotency + expired-replace matrix (`emit` :135-260); (2) resolution state machine + sweep (`resolve` :527, `sweepExpired` :930, `markResolved` :974); (3) chat-history pagination projection (`listHistoryByTopic` :650, `rowToHistoryTurn` :1038); (4) sidebar topic-rail aggregation (`listTopicsByUser` :840, `truncatePreview` :1125); (5) transcript writes that aren't prompts at all — `persistInertAgentTurn` :289 (agent statement stored as pre-resolved zero-option prompt with `resolution_value=''`, `channel_kind='webhook'`) and `persistInertUserTurn` :334 (user message stored as **empty body** + `resolution_freeform_text`). Cluster 5 is schema abuse that forces compensating hacks elsewhere (the `COALESCE` sidebar-preview subquery :891-901; the `rowid DESC` recency tiebreak :736-778). Clusters 3-5 are chat-history concerns, not button concerns; extract them.

### 6.4 [P2] Channel-kind and topic-id vocabulary forks
- `ChannelKind = 'telegram' | 'app_socket' | 'webhook' | 'cli'` (`types.ts:12`) vs `ChannelKindForButton = 'telegram' | 'app-socket' | 'webhook'` (`button-primitive.ts:57`) — underscore vs hyphen for the same concept, and the web surface has **no kind at all**: chat-bridge stamps web-chat resolutions as `'app-socket'` (`gateway/http/chat-bridge.ts:1653`), while sweep/inert writes stamp `'webhook'` (`button-store.ts:307, 950`). `button_prompts.resolution_channel_kind` is therefore unreliable as provenance.
- `topic_id` means two different keys: the `topics` table UUID in `Topic` (`types.ts:19-25`, router-created rows) vs the raw `channel_topic_id` string (`web:<u>`, `app:<u>`, `<chat>:<thread>`) in ButtonStore/engine/app-chat (`topic-id.ts:5-14`). Same identifier name, different keyspace — a classic refactor hazard.
- Two adapter directories for one conceptual channel: `adapters/app-socket/` (legacy P2 button envelopes, still live via `FORBIDDEN_INBOUND_VALUES` imported by chat-bridge :110) and `adapters/app-ws/` (the real surface).

### 6.5 [P2] `envelope.ts` is becoming the app-wide wire-protocol dumping ground
931 lines and growing: alongside chat frames it now defines Work Board rows + trident `AppWsRunProgress` (mirroring `trident/run-progress.ts`), `import_progress` (mirroring the import cron), the onboarding-claim signal, `projects_changed`, upload affordances. Every product feature edits this channels-package file. Related: **at least five near-identical option shapes** exist — `ButtonOption` (`button-primitive.ts:59`), `AppWsOutboundAgentMessageOption` (`envelope.ts:181`), `ChatMessageOption` (`chat-core/types.ts:22`), `AppSocketButtonPromptMessage.options` (`app-socket/render-button-prompt.ts:78`), `InlineChoice` (`types.ts:131`) — with lossy hand-written mappings between them (`outgoingToEnvelope` `adapter.ts:696-801`, `optionsToInlineChoices` :865-872, `parseOptions` `chat-core/types.ts:548`). The `InlineChoice.label`-must-carry-display-text contract (`adapter.ts:720-724`) exists only as comments and a Codex-P2 scar.

### 6.6 [P2] Duplicated sender registries with known delivery bugs
`InMemoryAppWsSessionRegistry` (`session-registry.ts`) vs `WebChatSenderRegistry` in `gateway/http/chat-bridge.ts` — the duplication is admitted in the header (`session-registry.ts:5-9`: "Mirrors ... so a future consolidation can fold both"). It already caused a real class of bugs: timer-fired messages posted to the `web:` registry never reached the live app-ws client (PR #105), and `open/composer.ts:1905-1911` documents rerouting the daily brief off the `web:`+landing registry for the same reason. Consolidate to one registry keyed by parsed topic id.

### 6.7 [P2] Dual normalization pipelines with hand-maintained parity
The server defines the wire types (`envelope.ts`); chat-core independently re-parses the same JSON with duck-typed decoders (`normalizeInbound`, `parseOptions`, `parseDocRefs`, … `chat-core/types.ts:429-703`); the Expo app has a third copy (`app/lib/ws-envelope.ts`, kept honest by `app/__tests__/ws-envelope-parity.test.ts`). No shared schema; drift is caught only by parity tests (`channels/adapters/app-ws/__tests__/cross-channel-parity.test.ts`). Acceptable short-term (chat-core must stay dependency-free for the browser), but the envelope types could live in a leaf package both sides import.

### 6.8 [P2] Package-boundary fictions
Deep imports bypass the barrels everywhere: `gateway/http/chat-bridge.ts:68,73,110` imports `channels/button-primitive.ts` and the app-socket renderer directly; `gateway/composition/message-search-wiring.ts:16-22` imports `channels/button-store.ts`, `chat-core/types.ts`, `message-search/runtime.ts` by relative path; `message-search/tool.ts:20-21` crosses into `core-sdk` and `tools` relatively. Combined with the `@neutron/` vs `@neutronai/` naming split (chat-core), workspace `package.json` deps are documentation, not enforcement. Low urgency but it makes the "what depends on what" question unanswerable from manifests.

### 6.9 [P3] Dead / legacy code
See §8 list.

## 7. Load-bearing subtleties a refactor MUST NOT break

1. **`emit()` expired-row replace-vs-preserve matrix** (`button-store.ts:162-202`): expired+unresolved or sentinel-resolved rows are DELETED and re-inserted on re-emit; expired rows with a *real user* resolution are preserved as audit trail. Onboarding reconnect/crash-recovery depends on each branch.
2. **`EmitResult.was_delivered`** (`button-store.ts:58-72`): on `was_new:false` callers must re-render iff `was_delivered:false` (a row that persisted but never reached Telegram would otherwise stay invisible forever).
3. **Expiry clock = caller-observed time, `<=` at the exact deadline** (`get` :492-517, `resolve` :549-559). `sweepExpired` deliberately bypasses `resolve()` because its synthesized `chosen_at` is post-expiry by definition (:939-951). `get()` hides sentinel-resolved expired rows so a late Telegram tap can't replay a synthetic resolution (:512-517).
4. **History pagination cursor semantics** (`listHistoryByTopic` :697-714): first page is INCLUSIVE (`created_at <= before`) — switching to strict drops rows minted in the current ms ("N-1 turns after a phase transition" footgun); later pages use the strict composite tuple.
5. **Recency = `rowid DESC`, not `prompt_id DESC`** (`latestTurnByTopic`/`latestPromptByTopic` :736-815): unifying their ordering with `listHistoryByTopic`'s pagination tiebreak reintroduces the reflection blank-prior-reply bug when two rows share a `created_at` ms.
6. **Sentinel suppression in history projection** (`rowToHistoryTurn` :1062-1069): `__timeout__`/`__cancel__` without freeform text renders as *unresolved* (agent bubble only) — never as a user bubble.
7. **`AppWsAdapter.send` ordering**: persist FIRST (assign seq) → `stampDelivered` → fan-out; a persist failure falls back to a no-seq live emit rather than dropping the reply (`adapter.ts:174-196`). A refactor that makes persistence blocking-fatal changes user-visible behavior.
8. **`ingestUserMessage.was_new` is the double-dispatch guard** (`adapter.ts:300-356`): surfaces gate the agent turn + chat-command filter on it; a persist FAILURE reports `was_new:true` on purpose (dispatch rather than silently drop). This guard only became real when `chat_log` was wired (`open/composer.ts:3197-3213`) — the memory note "chat_log unwired / guard inert" is now FIXED.
9. **Registry fan-out**: snapshot-iterate, evict throwing senders, and NEVER abort the fan-out mid-loop (one dead laptop socket must not starve the phone) (`session-registry.ts:121-149`); unregister is reference-identity-aware so a stale close can't evict a reconnect (:108-119).
10. **Telegram anti-forge routing**: a Telegram callback must match a rendered option — reserved sentinels and freeform coercion are rejected for `channel_kind === 'telegram'` (`button-routing.ts:104-124`); app-socket decode rejects `__freeform__`/`__timeout__` but allows `__cancel__` (`app-socket/render-button-prompt.ts:64-67, 226-247`).
11. **MarkdownV2 is conditional**: bodies ship plain (preserving Telegram auto-linkify) unless doc-links forced MarkdownV2, in which case bare URLs get `[url](url)`-wrapped and truncation must be markdown-boundary-aware (`telegram/index.ts:137-167, 208-243, 317-388`).
12. **Router `receive` stamps author #0 only when absent** (`router.ts:127-140`) and must pass `origin_instance_slug` through untouched — the persistence privacy quarantine keys on it (`types.ts:84-95`).
13. **chat-core merge laws**: receipts union-monotonic; reactions and edits rev-LWW (`pickReactionState`/`pickEditState`, `store.ts:193-268`) — `pickEditState` OWNS the merged body so a re-delivered original never resurrects an edited/tombstoned one; order by `seq` never clock (`compareForDisplay` :81-91); `reconcileServerReset` wipes ONLY when server seq is a known number strictly below a non-zero local cursor, and `clearAckedTranscript` preserves queued/sent rows in a single store op (`sync-engine.ts:216-234`, `store.ts:437-446`).
14. **`optionsToInlineChoices` / `outgoingToEnvelope` display-text contract**: `InlineChoice.label` must be the display text (option `body`), not the "A"/"B" legend (`adapter.ts:720-729, 857-872`); the persisted `button_prompts.body` has `[[OPTIONS]]` stripped, so any consumer needing option values must use `latestPromptByTopic`, never re-parse the body (`button-store.ts:780-789`, `build-live-agent-turn.ts:653-676`).
15. **`sanitizeUploadAffordance` legacy-`'both'` normalization → `'chatgpt'`** (`adapter.ts:879-898`) — dropping it dead-ends a deploy-window replay.

## 8. Dead / legacy code candidates

- `runLongPoll` (`telegram/long-poll.ts`) and `forum-topics.ts` — exported from the barrel (`index.ts:164-173`) but zero production consumers (grep across `open/` + `gateway/` finds none; tests only).
- `TelegramAdapter` class + `acknowledgeChoice` + `webhookHandler()` (`telegram/index.ts:87-174`) — never instantiated outside tests; production composes `buildWebhookHandler` directly.
- `ChannelKind` members `'cli'` and `'webhook'` (`types.ts:12`, guarded at `router.ts:171-177`) — no adapter exists for either.
- `AppSocketRenderNotWiredError` (`app-socket/render-button-prompt.ts:115-125`) — explicitly retained only so old catch-sites type-check.
- `channels/adapters/app-socket/socket-server.ts` — mock socket server used only by `tests/integration/button-primitive-cross-channel.test.ts`.
- `AppWsAdapter.emitUserMessageEcho` + the no-`chat_log` legacy branch of `ingestUserMessage` (`adapter.ts:267-292, 325-328`) — production always wires `chat_log` (`open/composer.ts:3206`), so the legacy path runs only in tests.
- `AppWsInbound = AppWsInboundUserMessage` single-member alias (`envelope.ts:129`) — the other inbound frames never joined the union.

## 9. Test posture

43 test files, ~7.9k test LOC vs ~10k prod LOC — strong for pure logic. Covered: button-store lifecycle (580 LOC), primitive validation, routing incl. Telegram anti-forge, webhook server (timing-safe secret compare, `/start` dispatch), MarkdownV2 escaping, UTF-16 truncation, long-poll `/start`, app-ws adapter + edits/receipts/reactions/attachments/seq-resume/auth + cross-channel parity, telegram doc-refs; chat-core sync-engine/web-session/ws-client/send-queue/reactions/receipts/edits/buttons/search; message-search runtime + tool. Clocks and IDs are injected throughout → low flake risk (no timers/sockets in unit tests).

Gaps: `TelegramClient` retry-after/429 behavior is only shallowly tested (`channels/telegram-client.test.ts`); `forum-topics.ts` untested; `stores/opfs-store.ts` has no test (browser-API dependent); and — structurally — nothing tests that the *production composition* matches the `ChannelRouter` contract, because production doesn't use it (§6.2). The dual-persistence divergence (§6.1: resume replay dropping options/citations) has no test asserting parity between HTTP-history hydration and WS-resume hydration.

## 10. What the refactor should do here

1. **Unify the durable transcript** on `app_chat_messages` (extend the schema with agent-message metadata), demote `button_prompts` to prompt lifecycle only, and give HTTP history / sidebar / reflection / message-search one read model. This dissolves the dual-persist, the `[[OPTIONS]]`-strip trap, and the degraded-resume gap in one move.
2. **Resolve the router fiction**: either compose production through `ChannelRouter` (register app-ws + telegram adapters; the bespoke `appWsReceiver` becomes the `TopicHandler`) or delete the ABC layer and document direct composition as the architecture. Delete the unregistered router node in `build-core-modules.ts:245` either way.
3. **One vocabulary**: merge `ChannelKindForButton` into `ChannelKind` (add `'web'`, fix hyphen/underscore), and split the `topic_id` identifier into `topic_uuid` vs `channel_topic_id` at type level so the two keyspaces can't be confused.
4. **Split `button-store.ts`** into prompt-store / history-projection / topics-rail modules; split `envelope.ts` so product features (work board, trident progress, import progress) own their frame types.
5. **Consolidate the two sender registries** behind one interface keyed by parsed topic id.
6. **Fix package hygiene**: rename `@neutronai/chat-core` → `@neutronai/chat-core`, export `topic-id.ts` from the barrel, and move `message-search`'s cross-package imports to package names.
7. Add a **hydration-parity test** (HTTP history vs WS resume vs live delivery for the same turn) before any of the above — it is the invariant most likely to silently break.
