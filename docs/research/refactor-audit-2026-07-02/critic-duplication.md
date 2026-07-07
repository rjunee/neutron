# Duplication critic — Neutron Open full-architecture audit

Date: 2026-07-02. Repo: /Users/ryan/repos/neutron-open. All file:line refs verified in code this session unless marked "(per map, spot-checked)".

Charter: cross-cutting duplication — (a) the three chat surfaces, (b) multiple composers/boot paths, (c) three AS-BUILT changelogs, (d) copy-paste across cores/free/*, (e) repeated hand-rolled patterns. Quantified; extraction targets + order at the end.

---

## 0. Executive summary

Neutron Open's duplication is not accidental sloppiness — most of it is **deliberate mirroring across enforced boundaries** (browser bundles must not import node-only server packages; the Managed composer lives in a private repo; Cores pretend to be third-party npm packages). But the mirrors have outgrown their guardrails: of ~20 identified duplication families, only 3 have parity tests, 2 are "kept in sync" by comment alone, and several have **already drifted with user-visible consequences** (PR #105 dual-registry delivery bug; degraded WS-resume transcript vs HTTP history; only 1 of 4 sidecar resolvers has the path-traversal guard; the 31-term `hasAnyChainedSurface` gate already missing 3 mapped surfaces).

Measured totals (verbatim or near-verbatim duplicated lines, conservative):

| Family | Approx. duplicated LOC | Copies |
|---|---|---|
| Gateway HTTP surface boilerplate (resolveBearer/jsonError/readJsonBody/interfaces) | ~1,000 | 19/15/12/21 |
| App↔web fetch-client + renderer twins | ~2,600 (each side of ~6 twin pairs + 908-line MD renderer) | 2 fronts × 6+ clients |
| Wire-model mirrors (envelope/options/doc-links/topic-id/tabs/engagement) | ~1,300 | 3–5 per shape |
| Dual durable transcript (button_prompts inert-turn writes + app_chat_* quadruplet) | ~930 store LOC + dual writes | 2 models |
| Substrate drain-to-text loops | ~600 | 11 files |
| cores/free template copy-paste (manifest/sidecar/filter/tests) | ~1,200 | 9/4/3/6 |
| Open-vs-Managed composer forks (auth gate, cred resolver, topics surface, stubs) | ~800 | 2 each |
| AS-BUILT changelogs | 10,728 doc lines | 3 files |
| Infra primitives (gitExec, keyed mutex, withTimeout, init-dedup) | ~500 | 2–6 each |
| trident/code-gen prompt + grammar forks | ~700 | 3/2 |

---

## 1. (a) The three chat surfaces — repeated message-model / render / delivery logic

### 1.1 The wire model exists 3–5 times per shape

The app-ws frame union is defined once on the server and re-derived twice on clients, with a third independent decoder layer:

- Server truth: `channels/adapters/app-ws/envelope.ts` (931 lines; `AppWsOutboundAgentMessageOption` at :181, agent_message at :223).
- Expo mirror: `app/lib/ws-envelope.ts` (237 lines; same option interface verbatim at :98-107, agent_message at :136-142). Parity test exists (`app/__tests__/ws-envelope-parity.test.ts`).
- chat-core duck-typed decoders: `chat-core/types.ts:429-703` (~275 lines re-parsing the same JSON — `normalizeInbound`, `parseOptions`, `parseDocRefs`), no shared schema with the server; consumed by BOTH web (landing/chat-react) and mobile.
- **Five near-identical option shapes** (verified): `ButtonOption` (`channels/button-primitive.ts:59-68`), `AppWsOutboundAgentMessageOption` (`envelope.ts:181`), the app mirror (`app/lib/ws-envelope.ts:98`), `ChatMessageOption` (`chat-core/types.ts:22`), `InlineChoice` (`channels/types.ts:131-136`) — with lossy hand mappings (`adapter.ts:696-801`, `optionsToInlineChoices` :865-872) whose "label must carry display text" contract exists only as comments and a Codex-P2 scar.
- Topic-id derivation mirrored a 4th time: `landing/chat-react/config.ts:120-136` (`appWsTopicId`/`appWsProjectTopicId` — "kept inline so the browser bundle doesn't pull in the channels package").
- `runtime/doc-links.ts` (918) ↔ `app/lib/doc-links.ts` (493) byte-parity twin (header at app/lib/doc-links.ts:1-10; parity test gateway-side).
- Comment-only mirrors with **no** parity test: `TabDescriptor` in `app/lib/tabs-client.ts:16-24` ("byte-for-byte"), `AgentEngagementMode` in `app/lib/projects-client.ts:24-29` ("must stay in lockstep" with `connect/agent-engagement.ts`).

Why the mirrors exist is legitimate: metro bundles whatever you import and `channels/` → `node:sqlite` bricks the RN build (`app/lib/ws-envelope.ts:4-7`). But `chat-core/` (zero-dep, consumed by app + web + server tests) **proves a node-free shared leaf package works** in this workspace. The mirrors are therefore an unforced ongoing tax: every frame change is a 3–4 file edit where 2 of the files fail silently on drift.

### 1.2 The API clients + renderers exist twice (app vs web)

Verified line counts of the twin pairs (`wc -l`):

| Surface | app/lib | landing/chat-react |
|---|---|---|
| docs-client | 867 | 532 |
| work-board-client | 207 | 311 (header: "The web twin of the mobile `app/lib/work-board-client.ts`") |
| tabs-client | 115 | 180 |
| project-credentials-client | 150 | 178 |
| markdown renderer | `markdown-render.tsx` 908 (hand-rolled) | `Markdown.tsx` 118 (react-markdown) |
| ws frame → view model | `chat-render-model.ts` 215 | `controller.ts` handleFrame ~200-line switch |

Plus web-only `integrations-client.ts` (169), `codex-credential-client.ts` (147) that overlap app's cores/admin clients. Both fronts also duplicate `config.ts`, `theme.ts`. **16** `class *Error extends Error` in `app/lib/*-client.ts` and **8** in `landing/chat-react/*.ts` (grep-verified). Every gateway surface change is now a 3-way edit (gateway + app + web) with compiler help only inside each leaf.

The two renderers are not even the same algorithm class (a 908-line hand-rolled state machine vs react-markdown + rehype-sanitize) — so the SAME agent markdown renders differently on phone vs browser today. That is drift-as-shipped, not just drift risk.

### 1.3 The durable transcript exists twice, written twice per reply

- Every live agent reply on the app-ws path is persisted twice: `gateway/realmode-composer/build-live-agent-turn.ts:975-996` (`buttonStore.emit(replyPrompt…)`) AND `channels/adapters/app-ws/adapter.ts:174-196` (`chat_log.append`).
- The two records disagree in fidelity: `button_prompts.body` has `[[OPTIONS]]` stripped (options in `options_json`, `button-store.ts:780-789`) while the app_chat replay envelope (`adapter.ts:809-841`) carries body/seq/ts only — **no options, prompt_id, citations, doc_refs**. A cold-syncing device gets a degraded transcript relative to HTTP history.
- `button_prompts` moonlights as a message log via `persistInertAgentTurn`/`persistInertUserTurn` (`button-store.ts:289, 334` — user messages stored as empty-body pre-resolved prompts), forcing compensating hacks (COALESCE preview subquery :891-901, rowid-DESC tiebreak :736-778).
- The app-chat side is itself a 4× copy-paste: `persistence/app-chat-{store,edits,reactions,receipts}.ts` = 222+255+244+211 = **932 lines** of the same append-idempotent / per-topic-seq / replay-after_seq / aggregate shape.

### 1.4 Delivery registries and per-turn chat policy exist twice

- `InMemoryWebChatSenderRegistry` (`gateway/http/chat-bridge.ts:185-205`) vs `InMemoryAppWsSessionRegistry` (`channels/adapters/app-ws/session-registry.ts`, header :5-9 admits "Mirrors the WebChatSenderRegistry shape … so a future consolidation can fold both"). Already caused a real delivery bug class: timer-fired messages posted to the `web:` registry never reached live app-ws clients (PR #105; reroute documented at `open/composer.ts:1905-1911`).
- **Semantics differ and are load-bearing on both sides**: chat-bridge's registry must PROPAGATE sender throws (engine converts to `send_failed`, delivered_at stays NULL → reconnect re-emit), while app-ws fan-out must EVICT throwing senders and continue (one dead laptop socket must not starve the phone). Consolidation must be policy-parameterized, not naive.
- Chat command filter execution + scribe fan-out duplicated across the two inbound stacks: `ChatCommandFilter` type lives in `gateway/http/app-ws-surface.ts` and is imported sideways by `chat-bridge.ts:1009`; the scribe fire-and-forget try/catch is pasted 4× inside `chat-bridge.ts` handleInbound (:1748, :1811, :1896, :1949 — grep-verified identical `scribe_hook_threw` blocks).
- Telegram render is a third render path (`channels/adapters/telegram/index.ts:136-243` MarkdownV2 composer) — but that one is legitimately channel-specific; the defect there is it's reachable only via the never-constructed `TelegramAdapter` class (router-fiction, another critic's lane).

---

## 2. (b) Multiple composers / boot paths

The Open and Managed composers share `gateway/realmode-composer/` (13k LOC — genuinely shared, good), but four responsibilities are forked instead of shared:

1. **Two HTTP auth gates.** The tested, generic one: `landing/auth-gate.ts` (655) consumed via `composition.auth_gate` → `gateway/http/compose.ts:880-948` (evaluate + Set-Cookie stitch) — which **no production Open code sets**. The live Open gate is a bespoke closure inside the 3.7k-line composer: `open/composer.ts:1655-1760` (openFetch), which itself contains **two verbatim copies of the claim-start-token → mint-cookie block** (SPA route :1713-1726 and /chat route :1738-1749 — "identical to the /chat `?start=` gate below" per its own comment).
2. **Two LLM credential resolvers.** `open/composer.ts:290-316 resolveOpenLlmPool` mirrors `gateway/realmode-composer/resolve-llm-credentials.ts` (309 LOC) — the doc comment says "mirroring the Managed resolver's precedence"; the `ambient` kind exists only in the Open copy. Sync-by-comment on the credential path that every LLM call flows through.
3. **Forked topics surface.** `open/chat-topics-surface.ts` re-implements `gateway/http/chat-topics-surface.ts` with the same wire shape, different data source (projects table vs button_prompts) — headers of both verified. Same route, two implementations, selected by boot path.
4. **Adding one surface = 4–5 bookkeeping edits, and the lists already disagree.** `gateway/http/compose.ts` has **21 structurally identical `{handler(req) => Promise<Response|null>}` interfaces** (:37-261, grep-verified) + the 40-field input bag + the hand-rolled precedence ladder; `gateway/composition.ts:137-259` re-maps field-by-field; `composition.ts:264-295` `hasAnyChainedSurface` is a 31-term boolean that has **already diverged** (`chat_history_surface`, `chat_topics_surface`, `import_resume_handler` mapped but absent from the gate); `LANDING_PATHS` (compose.ts:722-752) is a manual allowlist with a 3-incident comment log.
5. Duplicated ignition: `open/server.ts:93-98` vs `gateway/index.ts:589-603` main blocks; Telegram-shaped no-op stubs to satisfy required CompositionInput fields (`open/composer.ts:3434-3436`).

The pattern: the CompositionInput seam was designed for two composers, but the *implementations* behind it forked instead of the *inputs*. Every fork is on a security-relevant path (auth gate, credentials) or a route-reachability path (surface lists), which is the worst place for sync-by-comment.

---

## 3. (c) Three AS-BUILT changelogs

Verified: root `AS-BUILT.md` = 7,441 lines; `docs/AS-BUILT.md` = 1,469 (abandoned at PR #148); `docs/AS_BUILT.md` = 1,818 (leak-gate-blessed). Total 10,728 lines across three files, no single complete record (recent PRs wrote inconsistently: #177 both, #173/#174 docs-only, #162/#165 root-only, #168/#176 neither — per vision-docs mapper, spot-checked).

Root cause is itself a duplication defect in the **agent prompts**: `trident/prompts.ts:113,116,163,199` and `trident/inner-workflow.mjs:361` hardcode root `AS-BUILT.md` (hyphen), while `cores/free/code-gen/src/prompts/forge-system.ts:7` uses `AS_BUILT.md` (underscore) — two machine-writer conventions collided and nobody reconciled. Fix order matters: **writer prompts first**, then file consolidation, then move the leak-gate allowlist entries (`scripts/ci/leak-gate-allowlist.txt:69-80` keys on the literal `docs/AS_BUILT.md` path — renaming without moving entries re-arms tenant-vocab rules and fails CI). Root AS-BUILT prose is the only anchored record of several behavioral invariants — archive, don't delete.

---

## 4. (d) Copy-paste across cores/free/*

1. **`loadManifest` boilerplate ×9** — every `src/manifest.ts` repeats the same ~25-line read/parse/extract/parseManifest block (verified: `cores/free/tasks/src/manifest.ts:64-87`; all nine files have the same 6 signature hits), which also re-implements `cores/runtime/loader.ts:87-164 readCorePackage`. ~225 duplicated lines.
2. **Per-project sidecar resolver ×4, security-divergent** — the handle-cache + init-promise-dedup (`pending map` set/await/finally-delete) + `*SidecarMismatchError` + `closeAll()` pattern is verbatim-parallel in `research/src/store-resolver.ts:186-200`, `email/src/cache.ts:285-325`, `code-gen/src/sidecar/store.ts:353-435`, `gateway/cores/calendar-wiring.ts:148-159` (~600 lines). **Only research has `safeResolveProjectRoot`** (:128-159) rejecting `../`/NUL/absolute `project_id`; email/code-gen/calendar do a bare `join(owner_home,'Projects',project_id)` on tool/chat-supplied input. Duplication that forked a security control.
3. **ChatCommandFilter contract re-declared ×3 in-core** (`email/src/chat-bridge.ts:23-44`, `scraping/src/chat-bridge.ts:23-43`, `research/src/chat-bridge.ts:22-44` — grep-verified identical Input/Result/Filter/Options quadruple) against a canonical type that lives, absurdly, in an HTTP surface file (`gateway/http/app-ws-surface.ts`, imported via inline `import()` types 6× in `gateway/boot-helpers.ts:520-703`). Two more gateway-side filter builder patterns (reminders :555, calendar :694) + a tasks router wrapper = four integration patterns for one concept.
4. **install-lifecycle.test.ts copy-pasted ×6** (calendar, code-gen, email, reminders, research, tasks — ls-verified).
5. Duplicated error/secrets logic in the platform: `CapabilityDeniedError` ×2 (`cores/sdk/secrets.ts:63` vs `cores/runtime/errors.ts:56`), `persistOrRotate` ×2 (`cores/runtime/lifecycle.ts:441-482` vs `cores/sdk/secrets.ts:246-320`), **two parallel manifest validators** (`core-sdk/validator.ts` 650-line hand validator + JSON-schema mirror, zero prod callers, vs `cores/sdk/manifest.ts` Zod — the prod path).
6. NL date/time parsing duplicated reminders vs calendar (`reminders/src/chat-commands.ts:377-649` vs `calendar/src/chat-commands.ts:93-338`) — behavior-divergent grammars; unify only with golden tests or defer (per cores-free mapper; agree).

---

## 5. (e) Repeated hand-rolled patterns

### 5.1 Gateway HTTP surface kit (the single cheapest win)

- `resolveBearer` — **19 verbatim copies** (grep-verified list; three diffed byte-identical): app-docs :1638, cores-integrations :223, app-backups :279, work-board :322, app-projects :1139, app-focus :498, app-launcher :226, codex-credential :121, admin-personality :557, cores-surface :504, app-focus-current :216, app-upload :352, app-reminders :577, app-admin :730, project-credentials :179, cores-oauth :662, app-devices :176, app-tabs :193, app-tasks :415. ≈13 lines × 19 ≈ 250 lines; a bearer-parsing security fix currently needs 19 synchronized edits.
- `jsonError` — 15 files (incl. `open/chat-topics-surface.ts`, both upload handlers); `readJsonBody` — 12 files; per-surface `ResolvedAuth`/`AuthFailure` interface pairs ride along.
- The shared module that SHOULD absorb the identity compare already exists (`gateway/http/auth-helpers.ts:96 ownerIdentityMismatch`, "Call sites MUST use this") but ~10 surfaces still raw-compare — half-adopted because there is no shared resolveBearer to put it in.
- `gateway/http/compose.ts`: 21 duplicate handler interfaces (see §2).

### 5.2 Substrate drain-to-text loop ×11

`for await (const ev of handle.events)` token-accumulate loops (grep census): `build-llm-call-substrate.ts` (×2 — home of the blessed `collectTokensToString`, imported by 9 production files), `build-import-substrate.ts`, `onboarding/history-import/substrate-callers.ts`, `cores/free/email/src/substrate-llm.ts`, `scribe/extract.ts:141-153`, `reflection/detector.ts:166-178` (byte-parallel to scribe's), `agent-dispatch/substrate-turn.ts:93-105`, `cores/free/code-gen/src/tool-handlers.ts`, `trident/substrate-dispatch.ts` (dead), `trident/inner-loop.ts` (legitimately different — checkpoint streaming), `persistent-repl-substrate.ts` (the adapter itself). ~8 independent copies of the same drain+classify contract, each with its own error/timeout/429 handling:
- 429 detectors duplicated and sync-by-comment: `substrate-callers.ts:387-406 is429ErrorMessage` — "Same regexes as `job-runner.is429RetryableError`; kept in sync".
- `withTimeout`/`TimeoutError` ×3: `phase-spec-resolver.ts:1970-1996`, `gbrain-doctor.ts:482`, `wow-moment/llm-selector.ts:329`.
- Colliding export names in onboarding: `buildSystemPrompt`/`buildUserPrompt` exported by BOTH `llm-router.ts:744,815` and `phase-spec-resolver.ts:1628,1656`.
Load-bearing divergences to preserve: email's stub-throws-by-design; scribe/reflection watchdog-abort; substrate-callers must NOT break on the completion event (adapter teardown depends on iterator finishing, `substrate-callers.ts:486-510`).

### 5.3 Infra primitives

- **git exec plumbing ×2**: `gateway/git/doc-version-store.ts` (`execFileAsync` :68, `gitExec` :885, `git --version` probe :361, GIT_EXEC_TIMEOUT_MS) duplicated in `project-backup-store.ts` (:93, :1794, :465) — plus `comments/anchor-walker.ts:301-304` ("Mirrors DocVersionStore's withCommitLock").
- **Keyed promise-chain mutex ×3**: `doc-version-store.ts:831 withCommitLock` + per-project `commitMutexes`/`initLocks` maps (:421-425), `project-backup-store.ts` inFlight/inFlightRestore maps (:423-437), and the generic `gateway/http/keyed-mutex.ts:8` whose own header says it generalizes withCommitLock — the generic exists and the originals never adopted it.
- **Init-promise-dedup pattern ~6×**: the 4 core sidecar resolvers + DocVersionStore initLocks + engine suggester memoize+pending-map (`engine.ts:8565-8727`, per map).
- **App-side long tail**: `formatError` ×3 (docs.tsx:2062, admin.tsx:1224, backups.tsx:921), `formatBytes` ×2, `httpToWs` ×2 (`lib/config.ts:85`, `lib/work-board-live.ts:31` — second copy deliberately inlined to dodge an import chain, i.e. evidence the pure-utils leaf is missing), 6× client/reducer/provider state triplets (~600-700 lines each, self-declared mirrors: `task-state-reducer.ts:8-24`).

### 5.4 trident / code-gen forks

- `/code` grammar duplicated verbatim: `trident/code-command.ts:57-70` ("same grammar as the Code-Gen Core's `parseCodeCommand`") vs `cores/free/code-gen/src/chat-commands.ts:109`.
- Forge/Argus prompt text ×3: `trident/prompts.ts` (490 — render/parse half dead, only ARGUS_DIFF_LINE_LIMIT live), inline prompts in `trident/inner-workflow.mjs` (771, the live copy), `cores/free/code-gen/src/prompts/{forge,argus}-system.ts` (185, prod-dead fork). Plus `prompts/forge.md`/`argus.md` disk sources.
- Board-binding dispatch rules ×2: `trident/board-dispatch.ts:118-144` vs `agent-dispatch/service.ts:283-295` (same three rules, independently maintained codes/messages, per map — consistent with grep).
Most of this resolves by **deletion** (the v1 trident stack and code-gen's retired pipeline are production-dead), not extraction.

### 5.5 Already-consolidated exemplars (do more of this)

- `slugifyProjectId`: gateway's `defaultProjectIdSlugifier` now **re-exports** the wow-moment function (`build-onboarding-handoff.ts:861-875`) + drift-guard test — the correct end-state pattern.
- `collectTokensToString` in build-llm-call-substrate with 9 importers — the drain helper half-extracted; finish the job.
- `gateway/http/auth-helpers.ts` — the canonical compare exists; adoption incomplete.
- `chat-core/` — proof that a zero-dep shared leaf works across server, Expo, and browser.

---

## 6. What becomes shared, where, and in what order

New/receiving workspaces:

1. **`wire-types/` (new zero-dep leaf, `@neutronai/wire-types`)** — app-ws envelope union + the ONE canonical option shape + topic-id derivation + doc-link build/parse + TabDescriptor + AgentEngagementMode + message caps. Imported by channels, gateway, chat-core, app, landing/chat-react. Constraint: node-free (the chat-core precedent). Deletes `app/lib/ws-envelope.ts`, `app/lib/doc-links.ts`, config.ts topic mirrors, tabs/engagement comment-mirrors (~1,000 lines) and collapses 5 option shapes to 1 + explicit render projections.
2. **`gateway/http/surface-kit.ts`** (stays in gateway) — resolveBearer (with ownerIdentityMismatch folded in), jsonError/jsonOk, readJsonBody, ResolvedAuth/AuthFailure, path matchers, one `HandlerSlot` type replacing the 21 interfaces. Byte-identical wire output.
3. **`client-core/` (new leaf, or a `wire-types/clients` sub-export)** — GatewayHttpClient base (auth header, status→code map, single GatewayClientError{code,status}, injectable fetch) + per-surface modules shared by app and web. Collapses 16+8 error classes and the 6 twin client pairs.
4. **`runtime/substrate-text.ts`** (runtime, beside credential-pool) — drainToText with policy hooks (onAbort, treatErrorAs, keepAliveExempt) + the single 429/exhaustion classifier; both gateway substrate builders and the 6 product callers adopt.
5. **`cores/sdk` + `cores/runtime` helpers** — `loadManifestFromPackageDir`, `ProjectSidecarResolver<H>` (with research's traversal guard as default), exported `CoreChatCommandFilter` type, one error module, one shared install-lifecycle test harness.
6. **`gateway/wiring` convergence** — one credential resolver with mode flags (allowAmbient), one auth-gate implementation (Open supplies a local-owner verifier to the compose.ts gate seam), one topics surface with injected listTopics, table-driven surface registry generating the mapping + gate + ladder entry.
7. **Transcript unification** — app_chat_messages becomes the single durable transcript (schema widened with options/prompt_id/citations/doc_refs), button_prompts shrinks to prompt lifecycle; the 4 app-chat stores collapse onto one generic per-topic event-log core behind the existing interfaces.
8. **Docs** — one changelog (`docs/AS_BUILT.md`), writer prompts updated first, allowlist entries moved, root archived.

Extraction order (dependency- and risk-ordered):

| Step | What | Why this order |
|---|---|---|
| 0 | Write the missing parity/conformance tests (hydration parity HTTP-history vs WS-resume vs live; tabs + engagement-mode mirrors; two-registry delivery parity) | Insurance before touching anything; catches today's drift |
| 1 | surface-kit (S) + AS-BUILT convergence (S) + trident/code-gen dead-fork deletion (M, mostly deletes) | Zero-behavior-change, immediately shrinks the edit surface |
| 2 | wire-types leaf; server re-exports from it first, clients cut over one file at a time; delete mirrors last | Unblocks steps 3 and 7; parity tests from step 0 police the cutover |
| 3 | drainToText + 429 classifier in runtime | Small, self-contained; preserves documented per-caller divergences via flags |
| 4 | client-core shared by app + web; renderers decision (adopt one markdown pipeline) explicitly scheduled as a behavior-affecting change | Needs wire-types |
| 5 | cores-sdk/runtime helpers (manifest, sidecar resolver, filter type); traversal-guard adoption flagged as a deliberate security fix, not silent | Independent; coordinate with cores contract work |
| 6 | Composer convergence (credential resolver → auth gate → surface registry) | Biggest blast radius; do after the cheap wins prove the test harness |
| 7 | Transcript unification | Most behavior-sensitive; last, gated on step 0's hydration-parity test |

---

## 7. Load-bearing subtleties any dedup must preserve (collected)

- `{ok:false, code, message}` wire bytes + stable code strings — Expo client branches on them (surface-kit must be byte-identical).
- Sender-registry semantics DIFFER by design: chat-bridge send must propagate throws; app-ws fan-out must evict + continue. One registry needs a policy parameter, not one behavior.
- `button_prompts.body` has `[[OPTIONS]]` stripped — consumers must use `latestPromptByTopic`; any transcript unification must keep options in structured columns.
- AppWsAdapter.send ordering: persist-first → stampDelivered → fan-out; persist failure degrades to no-seq live emit, never drops (adapter.ts:174-199). buttonStore.emit failure likewise must not eat the live reply (build-live-agent-turn.ts:988-994).
- Drain loops: email triage stub throws by design; substrate-callers must not break on the completion event; scribe/reflection abort checks precede buffer append.
- Sidecar resolvers: mismatch error codes are per-core contracts; init-dedup finally-clears the pending map; adding traversal guards to email/code-gen/calendar is a behavior change to schedule explicitly.
- Compose ladder orderings are semantic (chunked-upload before legacy; focusCurrent before focus; per-project children before appProjects; SPA catch-all last); LANDING_PATHS completeness is a recurring 404 factory.
- Open start-tokens are single-use JTI; cookie minted only on first claim; both copies of that block must converge on ONE implementation with the same claim semantics.
- Credential resolver precedence: env OAuth > API key > ambient (Open-only); 'ambient' threads NO token (child uses Keychain).
- leak-gate allowlist is keyed to the literal `docs/AS_BUILT.md` path; Ralph prompts will recreate root AS-BUILT.md unless updated first.
- app/ bundle purity: the shared wire-types package must never import node-only modules or it bricks the metro build — this constraint, not laziness, created the mirrors.
- `chat-core` merge laws (receipts union-monotonic, edits rev-LWW, seq ordering) must not be "harmonized" with server-side projections.

## 8. Explicit non-findings / corrections

- `slugifyProjectId` duplication (flagged by two mappers) is **already fixed** — gateway re-exports the wow-moment function (`build-onboarding-handoff.ts:874-875`) with a drift-guard test.
- Boolean env-flag parsing is NOT a significant duplication family (1 hand-rolled `=== '1'` site outside the shared `runtime/env-flag-tokens.ts`).
- Telegram's MarkdownV2 render path is channel-specific, not chat-surface duplication; its problem is reachability (router fiction), which belongs to the chat-transport/layering critics.
- The reminders/calendar NL time parsers and research's frozen model constants are duplication but **behavior-divergent** — unification is a functional change; do not fold into the no-change refactor silently.
