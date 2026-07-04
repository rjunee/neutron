# Neutron Open — Invariants Inventory

Compiled 2026-07-03 for refactor unit **G10** (`docs/plans/2026-07-02-world-class-refactor-plan.md`
§G10). This is the checklist Fable synthesis runs per merge: every load-bearing subtlety named in
the **11 critic reports** (`docs/research/refactor-audit-2026-07-02/critic-*.md`), one line each,
with a concrete `file:line` anchor and the refactor unit (or existing test) that protects it. An
invariant tagged **unprotected — covered by review only** has no automated guard today; a unit
touching that area must add one or an Argus/Codex reviewer must explicitly re-verify it by hand.

> **On the count.** The plan (§G10) says "all 12 critic reports"; there are in fact **11**
> `critic-*.md` files in the audit directory. `critic-security-config.md` has no dedicated
> "load-bearing subtleties" section (its charter is config/secrets/auth-gate posture), so its
> preserve-verbatim items are folded into §11 below. Everything in this doc is keyed to the 11
> files that exist; the "12" in the plan is the pre-audit estimate, reconciled here.

Anchor convention: every invariant carries a `file:line` (or `file:line-range`) pointing at the
governing code site. Where an invariant is genuinely cross-cutting (many near-identical copies, or
a proposed consolidation target that does not exist yet), the anchor names the **representative**
site — the canonical producer, the file the audit cites, or the test that pins it — so each line is
verifiable from the doc; a `~` prefix marks an approximate line from the audit not re-pinned to HEAD.

Source reports are untracked working docs (`docs/research/refactor-audit-2026-07-02/`, see plan
§1.4) — this file is the durable, tracked distillation. Grouped by the critic dimension that
surfaced each item; a subtlety repeated across reports is listed once under its primary dimension
with cross-references noted inline.

---

## 1. Composition & boot order (`critic-composition.md`)

1. `open/server.ts` mutates `process.env` as its DI mechanism BEFORE `boot()` re-reads it
   independently for DB path/slug/host/port. `open/server.ts:58-73`, `gateway/index.ts:118-157`.
   Protects: **C1** (Typed BootConfig) — must thread both sides in lockstep.
2. Module registration order: `replToolBridge` mounted after `mcp`; `cron.scheduler.start()` only
   after `graph.compose()`; overlays applied before `buildComposedHttpFromComposition`;
   same-object-reference mutation of the composition. `gateway/composition.ts:336-434`.
   Protects: **C8** (Evict product orchestration from the composition layer).
3. Shutdown order including `shutdownAllPersistentRepls`; init-failure teardown exists in both
   `boot()` and `composeProductionGraph`. `gateway/index.ts:236-255,385-458`.
   Protects: **C1**/**C8**.
4. Compose ladder semantics: authGate first with Set-Cookie stitch; chunked-upload before legacy;
   per-project children mounted before appProjects; landing path-set before connect; operator
   routes bypass the gate. `open/composer.ts:894-1072`.
   Protects: **C4** (Data-driven surface registry / RouteSlot), **C5** (One auth-gate seam +
   landing route manifest).
5. Open gate: single-use `?start=` JTI claim; cookie minted only on first claim; stale-cookie-over-
   wiped-DB cold-start path; React bootstrap injected by exact-string replace on the
   `/chat-react.js` tag. `open/composer.ts:1616-1748`.
   Protects: **S1** (Per-install owner credential).
6. Prewarm promise never rejects and is not awaited at boot; `prewarmSettled` elevates cold-window
   timeouts. `open/composer.ts:3661-3684,508-521`.
   Protects: **D1**/**D2** (PoolRuntime reification / Substrate banner split) — flag/promise pair
   must move together.
7. Substrate instance-id prefixes are pool keys; the trident fire substrate must stay warm
   per-repo-cwd; only `cc-agent-`-prefixed instances get `enableToolBridge`.
   `open/composer.ts:590-633,535-541`.
   Protects: **D1**/**D2**.
8. `Bun.serve` selects the chained fetch handler per-request inside the serve arrow so the live
   server ref reaches WS upgrades; `maxRequestBodySize` = import cap + 64MB.
   `gateway/index.ts:302-323`.
   Protects: unprotected — covered by review only (no unit targets the serve-arrow wiring
   directly; **C8** touches adjacent code and must not regress it).
9. Holder fill-before-first-dispatch timing. `open/composer.ts:654,1329,2183,2321`.
   Protects: **F8** (Re-arm-from-durable-state sweep).

## 2. Contracts & wire protocol (`critic-contracts.md`, `critic-duplication.md` §7)

10. `latestTurnByTopic` tiebreak is `rowid DESC`, not `prompt_id DESC`; history's first page is
    inclusive `<=`, later pages use a strict composite tuple. `button-store.ts:697-815`.
    Protects: **G2** (Hydration-parity characterization), **W3** (Transcript unification, gated on
    G2).
11. `__timeout__`/`__cancel__` prompt resolutions render as UNRESOLVED, never as user bubbles;
    `EmitResult.was_delivered` governs the re-render rule. `button-store.ts:1050-1069`
    (the `RESERVED_RESOLUTION_VALUES` sentinel-handling block).
    Protects: **G2**, **L1** (Chat-protocol leaf module).
12. `button_prompts.body` has `[[OPTIONS]]` stripped on persist — every consumer must read
    `latestPromptByTopic`/`options_json`, never re-parse `body` (PR#144 trap).
    `button-store.ts:289-368`.
    Protects: **L1**, **W3**.
13. `{ok:false, code, message}` wire bytes and stable code strings are load-bearing — the Expo
    client branches on them; a surface-kit consolidation must stay byte-identical. Representative
    producer `gateway/http/app-backups-surface.ts:338` (the shape is emitted from ~19 near-identical
    copies per `critic-duplication.md:116`; O7 folds them into a proposed `gateway/http/surface-kit.ts`).
    Protects: **O7** (Gateway surface-kit).
14. Compose ladder orderings are semantic and must be preserved 1:1 if lifted into a registry:
    chunked-upload before legacy; `focusCurrent` before `focus`; per-project children before
    appProjects; SPA catch-all last; `LANDING_PATHS` completeness is a recurring 404 factory.
    `gateway/http/compose.ts:722-752` (LANDING_PATHS), `:833-1320` (route ladder).
    Protects: **C4**.
15. `chat-core` merge laws — receipts are union-monotonic, edits are rev-LWW, seq ordering is
    strict — must not be "harmonized" with server-side projections during unification.
    `chat-core/store.ts:82-171`.
    Protects: **L7** (chat-core scope rename), **W1** (client-core shared package), **W3**.

## 3. Data layer & persistence (`critic-data-layer.md`)

16. `ProjectDb` mutex + AsyncLocalStorage re-entry; swallowing mutex-chain rebuild; `isBusyError`
    rejects the `BusyRetryExhaustedError` wrapper; busy-retry sleeps must stay **async** (sync
    sleeps starve the systemd `WATCHDOG=1` heartbeat). `db.ts:216-226`, `retry.ts:47-59`.
    Protects: **P1** (ProjectDb API widening).
17. Migration runner: PRAGMA preamble hoisted out of the per-migration transaction;
    `PRAGMA foreign_keys=ON` re-asserted in a `finally`; per-migration BEGIN/COMMIT atomicity;
    migration version numbers are never renumbered or backfilled. `migrations/runner.ts:89-126`.
    Protects: **P2** (raw() migration sweep restricts `raw()` to this file), existing schema
    snapshot test (`regen-snapshot.ts`).
18. Schema snapshot test is the refactor's data-layer safety net; regenerate only via
    `regen-snapshot.ts`, never hand-edit. `migrations/snapshot.test.ts:1` (the test),
    `migrations/regen-snapshot.ts:9-15` (writes `expected-schema.txt`).
    Protects: existing test asset (not a unit) — leaned on by **P1–P4**, **P8**, **P11**.
19. `sqlite-state-store` upsert is a read-merge-write inside **one** transaction; single-statement
    crash-atomicity claims in its header comment depend on this. `sqlite-state-store.ts:82-210`.
    Protects: **P3** (openSidecar() + shared store helpers).
20. Trident `fired`/`redispatched` in-memory sets are crash-unsafe **by design**
    (`orchestrator.ts:198-206`) — persisting them would break orphan recovery.
    Protects: **F1** (SupervisedLoop primitive), **P10** (Trident checkpoint hardening).
21. `GBrainSyncHook`: remove-before-add edge ordering, once-only binary-missing latch,
    deferred-drain on `pageLanded` — must stay fail-soft byte-identical while adding observability.
    `GBrainSyncHook.ts:130-256`.
    Protects: **P9** (GBrain sync observability).
22. Reminders: single-flight tick, claim-then-dispatch with only-if-unchanged reverts,
    persist-before-send outbound to the `app:` registry. `reminders/tick.ts:130-177`,
    `reminders/store.ts:234-293`, `reminders/outbound.ts:7-18`.
    Protects: **F1** (adopts `SupervisedLoop` in `reminders/tick.ts`).
23. Task↔reminder link writes share the task mutation's transaction. `tasks/reminder-link.ts:97`.
    Protects: unprotected — covered by review only.
24. App-chat: idempotency keyed on `(topic_id, client_msg_id)`; per-topic `MAX(seq)+1` computed
    inside the transaction; persist-first-then-fan-out in the adapter. `adapter.ts:174-199`.
    Protects: **P5** (app-chat store fold).
25. Import runner: honest-failure gate (`attempted>0 && succeeded==0 && projects==0` →
    `failed`, never a blank `completed`); fire-and-forget with swallowed escapes routes to a
    `failed` row; the cancel-set is checked before result publication.
    `build-synthesis-import-runner.ts:191-220`.
    Protects: **P6** (`[BEHAVIOR]` Import durability P0).
26. `button_prompts` ordering tiebreaks differ on purpose between history pagination (inclusive
    first page, strict composite later) and `latestPromptByTopic` (rowid-DESC).
    `button-store.ts:697-815`. (Duplicate of #10/#12, cross-referenced from the data-layer critic.)
    Protects: **G2**, **W3**.

## 4. Duplication / consolidation seams (`critic-duplication.md`)

27. Sender-registry semantics DIFFER by design: chat-bridge's send must **propagate** throws
    (engine converts to `send_failed`); app-ws fan-out must **evict** throwing senders and
    continue (one dead socket must not starve another device). A consolidation must be
    policy-parameterized, not naive. `chat-bridge.ts:202-219` vs `app-ws/adapter.ts`.
    Protects: **F5** (Delivery consolidation), **D3** (chat-bridge cluster split).
28. `AppWsAdapter.send` ordering: persist-first → stampDelivered → fan-out; persist failure
    degrades to a no-seq live emit, never drops. `buttonStore.emit` failure likewise must not eat
    the live reply. `adapter.ts:174-199`, `build-live-agent-turn.ts:988-994`.
    Protects: **F5**.
29. Drain loops: email triage stub throws by design; substrate-callers must not break on the
    completion event; scribe/reflection abort checks precede buffer append.
    `onboarding/history-import/substrate-callers.ts:486-510`, `scribe/extract.ts:141-153`,
    `reflection/detector.ts:166-178`.
    Protects: **O8** (drainToText consolidation), **D5** (email backend split).
30. Sidecar resolvers: mismatch error codes are per-core contracts; init-dedup finally-clears the
    pending map; adding traversal guards to email/code-gen/calendar is a scheduled behavior change,
    not an incidental one. `cores/free/research/src/store-resolver.ts:90-200` (the one with the
    `safeResolveProjectRoot` traversal guard), `cores/free/email/src/cache.ts:279-345`.
    Protects: **X2** (Typed Core module contract), **X4** (cores/runtime shared helpers).
31. Open start-tokens are single-use JTI; the cookie is minted only on first claim; the two
    existing copies of this block must converge on ONE implementation with the same claim
    semantics. `open/composer.ts:1655-1760` (verbatim copies at `:1713-1726` and `:1738-1749`).
    Protects: **S1** (Per-install owner credential).
32. Credential resolver precedence: env OAuth > API key > ambient (Open-only); the `'ambient'`
    tier threads NO token (the child process uses the OS Keychain).
    `gateway/cores/core-credential-resolver.ts:46-61`.
    Protects: **C6** (Credential-resolver unification).
33. leak-gate allowlist is keyed to the literal `docs/AS_BUILT.md` path; Ralph prompts will
    recreate a root `AS-BUILT.md` unless repointed first. `scripts/ci/leak-gate-allowlist.txt:69-80`.
    Protects: **K6** (Changelog consolidation), **K7** (Docs truth pass), **K10** (repoints
    prompts), **G7** (Leak-gate NUL tripwire).
34. `app/` bundle purity: the shared wire-types package must never import node-only modules or it
    bricks the Expo/Metro build — this constraint, not laziness, created the hand-written mirrors.
    `app/lib/ws-envelope.ts:4-7` (the `node:sqlite`-bricks-the-RN-bundle comment).
    Protects: **L6** (`@neutronai/wire-types` leaf).
35. Open composer's env-mutation-as-DI trick + `open/server.ts` process.env writes are duplicated
    across the two boot paths and must converge to one implementation. `open/server.ts:58-73`.
    (Cross-ref #1.)
    Protects: **C1**.

## 5. Errors & fail-soft/fail-open (`critic-errors-observability.md` §8)

36. Sender registry MUST propagate throws — catching a closed-socket throw here silently
    downgrades to `was_new=false`, `delivered_at` gets stamped wrongly, and reconnect re-emit
    recovery dies. `gateway/http/chat-bridge.ts:202-219`. (Cross-ref #27.)
    Protects: **F5**, **D3**.
37. AppWs persist-failure fails OPEN twice: agent reply falls back to no-seq live emit; user-message
    persist failure reports `was_new:true` on purpose so the turn still dispatches.
    `channels/adapters/app-ws/adapter.ts:184-196,300-356`.
    Protects: **F5**.
38. Substrate error taxonomy strings are API: `isFreezeTimeout` and the 429-regex family mean
    adapter error MESSAGES are contract — any wording change is a behavior change.
    `build-live-agent-turn.ts:1445-1447`.
    Protects: **O3** (Error taxonomy + typed substrate error codes).
39. Binary-ENOENT must stay non-retryable so it can't launder into a 429 cooldown; `all_cooldown`
    must stay `retryable:true`. `build-llm-call-substrate.ts:437-442,515-523`.
    Protects: **O3**.
40. Email triage LLM stub THROWS by design so triage renders its deterministic fallback;
    agent-settings fallbacks must report `available:false`, never fake success.
    `gateway/cores/mount-open-cores.ts:177-277`, `gateway/boot-helpers.ts:1163-1180`.
    Protects: **D5**, **X2**.
41. Reminder dispatcher degrades to `literalFallback` on ANY LLM failure so a reminder always
    delivers; outbound is persist-before-send with swallowed live-push throws.
    `reminders/dispatcher.ts:203,232,237`, `reminders/outbound.ts:7-18`. (Cross-ref #22.)
    Protects: **F1**.
42. Engagement gate fails soft to `all_messages` — a DB read error must never drop a chat turn.
    `gateway/http/chat-bridge.ts:2749-2791`.
    Protects: **D3**.
43. wow-push emitter fails CLOSED (skip + warn, never `pushAll`) for privacy, while calendar/email
    briefs intentionally DO `pushAll` — opposite policies, both correct.
    `gateway/wow-push-emitter.ts:105-171`.
    Protects: unprotected — covered by review only.
44. GBrain latch + remove-before-add + append-only merge is the fail-soft, exactly-once-logging
    contract; chat turns must never crash on memory writes.
    `GBrainSyncHook.ts:199-256`, `scribe/write-to-gbrain.ts:19-41`. (Cross-ref #21.)
    Protects: **P9**.
45. `InMemoryWebChatSenderRegistry` identity-guarded unregister, recovered-reply drain topic
    gating, and `recordInboundReceived`-before-`advance` are error/ordering invariants a "cleaner"
    async refactor could reorder. `gateway/http/chat-bridge.ts:185` (registry class).
    Protects: **F5**, **D3**.
46. Import honest-failure gate: `attempted>0 && succeeded==0 && projects==0` → `failed`, never a
    blank `completed` wow. `build-synthesis-import-runner.ts:203-220`. (Cross-ref #25.)
    Protects: **P6**.
47. 429 exhaustion routes to `rate_limit_paused` (resumable), never `failed`; the cooling-off
    overlay on `error_message` must be cleared on success. `job-runner.ts:1414-1427,1604-1619`.
    Protects: **O3**.
48. `drainSubstrateEvents` must NOT break on the completion event — adapter teardown depends on
    the iterator finishing; an "early-return on completion" cleanup breaks teardown.
    `substrate-callers.ts:486-510`.
    Protects: **O8**.
49. Cron missed-fire catch-up fires exactly once; unsupported grammar warns + skips — converting
    the warn+skip into a throw bricks boot for Managed-grammar jobs.
    `cron/scheduler.ts:166-234`.
    Protects: **F2** (LoopRegistry + boot inventory).

## 6. Extensibility / registries (`critic-extensibility.md` §6)

50. The `SERVICE_SCOPE` global carve-out for Gmail/Calendar credentials is a deliberate
    no-re-consent policy — per-project context threading must NOT flip those two services to
    per-project scoping. `core-credential-resolver.ts:47-51`.
    Protects: **X6** (`[BEHAVIOR]` Project context to the tool boundary) — explicitly preserves
    this via the kept `SERVICE_SCOPE` policy.
51. Kickoff's dedupe rides the `onboarding_opening:<project_id>` durable slot; a recurring
    dispatcher must keep one-time semantics for already-fired projects.
    `build-project-kickoff.ts:15-19`, `build-onboarding-finalize.ts:416-424`.
    Protects: **C8**.
52. `pickAgentMeta` is additive/incoming-wins (`chat-core/store.ts:147-171`); transcript
    unification must not let a metadata-less replay row clobber richer local state.
    Protects: **W3**.
53. Client stores differ by design: op-sqlite needs explicit columns; OPFS snapshots the whole
    `ChatMessage` as JSON (no columns needed) — "mirror the columns" plans are store-specific.
    `chat-core/stores/opfs-store.ts:23,33`.
    Protects: **W1**, **W3**.
54. Staged/timer-fired sends must target the `app:` registry (PR#105); the durable rail/badge path
    is read from `button_prompts` history regardless of the live registry.
    `channels/adapters/app-ws/adapter.ts:174-199` (app: registry fan-out).
    Protects: **F5**, **W5** (`[BEHAVIOR]` chat-core connection resilience).
55. `hasAnyChainedSurface` and its field mapping must move together — already diverged for 3+
    fields per the gateway-services map; a registry-based fix must encode current order/set as an
    explicit list with a transition test. `gateway/composition.ts:264`.
    Protects: **C4**.

## 7. God-module split safety (`critic-god-modules.md`)

56. `buttonStore.resolve`'s `was_new` idempotency barrier gates the router's `state_delta` merge —
    re-merging replays corrections. `engine.ts:~4111-4136`.
    Protects: **D9a–D9d** (Interview-engine decomposition).
57. `PENDING_INBOUND_WINDOW_MS` (`engine.ts:537`) and `recordInboundReceived` ordering with
    chat-bridge are a matched timing pair.
    Protects: **D9a–D9d**, **D3**.
58. `last_advanced_at` has dual semantics — stall-watchdog preservation vs. source-switch bump.
    `engine.ts:3950-3987`.
    Protects: **D9a–D9d**.
59. `walkAutoSkip` and the resolver's `AUTO_SKIP` null-return are a matched pair; splitting one
    without the other silently changes skip behavior. `engine.ts:~7813-7820`.
    Protects: **D9a–D9d**.
60. 83 test files pin engine.ts behavior; the dead `acceptChoice` path is itself tested, so test
    migration is part of its deletion, not optional. `onboarding/interview/engine.ts:1322`
    (acceptChoice path), pinned by `onboarding/interview/__tests__/`.
    Protects: **K4** (Engine dead surface: acceptChoice + slug flow).
61. `sink.register` runs BEFORE `ptyHost.spawn` in the persistent-repl substrate.
    `persistent-repl-substrate.ts:~1678-1694`.
    Protects: **D1** (PoolRuntime reification).
62. Identity-guarded eviction (unregisterIf / compare-delete) everywhere in the substrate — a
    respawn re-attaches the SAME `sessionId`; a split that "simplifies" to blind deletes
    reintroduces a P2/P3 resume race. `persistent-repl-substrate.ts:1005` (`ReplSink.unregisterIf`),
    `:1958` (call site).
    Protects: **D1**.
63. `pendingChildKills` consumption in `spawnResume` is one-owner-per-transcript.
    `persistent-repl-substrate.ts:1431` (decl), `:3288-3305` (consume in spawnResume).
    Protects: **D1**.
64. Ephemeral gate (`options.ephemeral && spec.session === undefined`) and the NEVER-enqueue-to-
    pending-respawns rule for ephemerals — a replayed internal prompt would otherwise land in the
    user's chat. `persistent-repl-substrate.ts:2861-2877`.
    Protects: **D1**, **F6** (Cancellation chokepoint).
65. Watchdog ticks scope the pool by owning `replRegistryPath`; the `rt` (runtime) threading must
    preserve that scoping or one instance respawns another's sessions.
    `persistent-repl-substrate.ts:~3553-3556`.
    Protects: **D1**, **D2** (Substrate banner split).
66. 48 test files under `persistent/__tests__` drive the REAL `ReplSink`/dev-channel seam — a
    split must not fork the sink into per-module instances.
    `persistent-repl-substrate.ts:1005` (the `ReplSink` seam the suites drive).
    Protects: **D1**, **D2**.
67. `open/server.ts:58-73` env mutation happens BEFORE `boot()` — untouched by the composer split
    but adjacent; config reads must not move out of the entrypoint. (Cross-ref #1.)
    Protects: **C1**.
68. Trident fire substrate must be WARM per-repo-cwd and only `cc-agent-` gets
    `enableToolBridge` — pool-key/instance-id prefixes are semantic.
    `open/composer.ts:590-633,535-541`. (Cross-ref #7.)
    Protects: **D1**, **D2**.
69. 30 `open/__tests__` wiring tests + gateway `*-production-composer` tests are the composer-split
    lock; a characterization test snapshotting which `CompositionInput` fields Open sets must be
    added BEFORE the split and asserted unchanged after. `open/composer.ts:396-3615` (the
    composition closure the wiring tests lock).
    Protects: **C3a–C3d** (Carve `open/composer.ts` into wiring modules).
70. Registry send must PROPAGATE throws; identity compare-and-delete unregister.
    `gateway/http/chat-bridge.ts:202-219,192-200,1523-1542`. (Cross-ref #27/#36.)
    Protects: **D3**, **F5**.
71. `startSession` runs `engine.start` BEFORE the JTI claim; a duplicate JTI returns `false`, not
    an error. `chat-bridge.ts:~1229-1400`.
    Protects: **D3**, **K11** (One onboarding flow purge).
72. `recordInboundReceived` runs BEFORE `engine.advance`; the typing bracket starts before dispatch
    and ends in a `finally` on every path; `FORBIDDEN_INBOUND_VALUES` rejection happens before any
    resolve branch; the live-agent gate is `phase==='completed'` ONLY (2026-06-20 P0 note).
    `chat-bridge.ts:~1919-2717`.
    Protects: **D3**.
73. `tag_gated` no-mention posts persist the transcript and send a no-render `agent_ack`.
    `gateway/realmode-composer/build-live-agent-turn.ts:1135`,
    `gateway/realmode-composer/build-landing-stack.ts:1473`.
    Protects: **D3**.
74. Backup/restore facade: `last_attempted` written BEFORE the snapshot fires (scheduler contract);
    SNAPSHOT caps constants; sha/path validation errors are typed classes the HTTP surface maps to
    status codes — keep the error classes exported from the same specifier.
    `gateway/git/project-backup-store.ts:410` (facade class), `:210-217` (SNAPSHOT caps),
    `:953-972` (last_attempted read/write).
    Protects: **D4** (project-backup-store split behind facade).
75. `docs.tsx`'s `mutateGate` covering ALL mutations (create/rename/delete/binary) in one gate is
    the invariant — it has been fixed 4 separate times per review history; splitting into
    per-cluster hooks must keep one shared gate. `app/app/projects/[id]/docs.tsx:207`.
    Protects: **D7** (docs.tsx hook extraction).

## 8. Layering / module graph (`critic-layering.md` §10)

76. `connect/api/server.ts` must never gain a static import edge from composition — it is
    dynamic-imported only when `composition.connect_api` is set; converting the shadow types in
    `runtime/connect-handlers.ts` from `import type` to a static `import` would make every Open
    boot load federation code. `gateway/composition.ts:119`, `runtime/platform-adapter-local.ts:140`.
    Protects: **L3** (Remaining DAG edge cuts) — encodes the `connect-is-dynamic-only` rule.
77. The Expo (`app/`) bundle must never transitively import server workspaces (`node:sqlite`
    bricks the RN bundle) — this is WHY `app/lib/ws-envelope.ts`, `doc-links.ts`, `tabs-client.ts`
    exist as hand mirrors. `app/lib/ws-envelope.ts:4-7` (the constraint comment). (Cross-ref #34.)
    Protects: **L6**, **W1**.
78. Gateway's export surface is a cross-repo ABI — the Managed deploy-gate keys on 8 literal
    surfaces in `neutron-managed/src/ops/open-contract.ts` (path+substring matched, NOT
    symbol-matched). Renaming/moving `gateway/boot-helpers.ts`, `gateway/index.ts`'s healthz
    handler, or splitting `open/composer.ts` breaks the gate even if every name survives.
    `gateway/index.ts:474-486` (healthz, one of the 8 pinned surfaces);
    contract at `neutron-managed/src/ops/open-contract.ts` (out-of-repo).
    Protects: **M1** (Contract-gate hardening + route-manifest adoption), **C7**
    (`realmode-composer/` → `gateway/wiring/` rename must ship a paired `open-contract.ts` update).
79. `boot-helpers.ts` must never import `gateway/index.ts` (TLA entry↔composer cycle);
    new "shared boot config" modules must sit below both. `boot-helpers.ts:6-20`.
    Protects: **L3**, **C2** (boot-helpers split).
80. `process.env` is the de-facto DI bus at boot; moving `resolveOpenDbPath` out of
    `open/owner-identity.ts` must preserve the exact DB-path/slug resolution order for both
    entrypoints. `open/owner-identity.ts:61`. (Cross-ref #1/#67.)
    Protects: **C1**.
81. Moving value constants changes module-init graphs (e.g. `collectTokensToString`,
    `TELEGRAM_BIND_TOKEN_TTL_MS`) — several modules read env at module-load time; relocation
    reorders those reads. Prefer re-export shims for one release.
    `gateway/realmode-composer/build-llm-call-substrate.ts:793` (`collectTokensToString`).
    Protects: **L5** (Relative-import autofix sweeps).
82. `slugifyProjectId` (`onboarding/wow-moment/project-identity.ts:41-44`) must stay byte-identical
    to gateway's `defaultProjectIdSlugifier` — already guarded by a drift test; keep the test until
    there is literally one function.
    Protects: **N1–N4** (Identity/vocab rename series) — noted already-fixed in
    `critic-duplication.md` §8.
83. `docs/AS_BUILT.md` leak-gate literal-path coupling — module renames that touch docs or
    allowlisted paths re-arm retired-vocab CI rules; move allowlist entries in the same PR as any
    rename. `scripts/ci/leak-gate-allowlist.txt:69-80`. (Cross-ref #33.)
    Protects: **K6**, **K7**, **G7**.
84. Type-only vs. value edges: two of the layering cuts (edges #10/#11) are type-erased (zero
    runtime risk); the rest move real values and each needs its consumer's existing test suite run.
    `runtime/connect-handlers.ts:1-8` (representative `import type`-only shadow edge; see
    `critic-layering.md:429`).
    Protects: **L3**.
85. `cores/free/research` frozen model constants must NOT be converted to `getBestModel()` thunks
    while "just fixing imports" — that flips runtime model selection, a deliberate, separately
    verified change. `cores/free/research/src/research-orchestrator.ts:177`
    (`DEFAULT_MODEL_PREFERENCE`, imported `SONNET_MODEL`/`FAST_MODEL`).
    Protects: **X4** (cores/runtime shared helpers).

## 9. Lifecycle & concurrency (`critic-lifecycle-concurrency.md` §5)

86. Exactly-once terminal delivery depends on `listNonTerminal`-only sweeps plus save-before-hook;
    any job-table generalization must preserve "changed→terminal implies fresh".
    `trident/tick.ts:154-186`.
    Protects: **F1**, **P10**.
87. Reminder claim-before-dispatch + compare-and-swap revert is the deliberate at-most-once-on-
    crash path. `reminders/tick.ts:130-177` (issue #319). (Cross-ref #22.)
    Protects: **F1**.
88. Orchestrator `fired`/`redispatched` sets are per-process ON PURPOSE — restart triggers orphan
    detection; persisting them changes crash semantics. `orchestrator.ts:198-205`. (Cross-ref #20.)
    Protects: **F1**, **P10**.
89. The warm fire substrate is a singleton; per-fire substrates would kill detached workflows on
    settle. `inner-loop.ts:296-311`. Any kill seam must target the workflow, not the substrate
    session.
    Protects: **D1**, **D2**, **F6**.
90. Cron's `started` flag prevents double-binding between the `start()` sweep and `onRegister`;
    catch-up fires once, never per missed occurrence. `scheduler.ts:87-266`. (Cross-ref #49.)
    Protects: **F2**.
91. Backup scheduler (when wired): `writeLastAttemptedAt` BEFORE the snapshot fires is the
    restart-loop guard. `project-backup-scheduler.ts:176-194`. (Cross-ref #74.)
    Protects: **D4**.
92. Ephemeral one-shots must never enter the pending-respawn queue — replayed internal prompts
    would be redelivered to the user's chat topic. `persistent-repl-substrate.ts:2861-2877`.
    (Cross-ref #64.)
    Protects: **D1**, **F6**.
93. The engine's import hard-timeout anchors on the durable `job.started_at`
    (`engine-import-routing.ts:998-1001`) — a boot orphan-sweep must not race it into
    double-failure UX.
    Protects: **P6**.

## 10. Naming & vocabulary (`critic-naming-vocab.md` §6)

94. `tenant:` prefix + a raw-NUL hash seed feed task-id determinism — fix the leak-gate-hiding byte,
    freeze the word itself (task IDs are persisted). `tasks/history-import-seeder.ts:63`.
    Protects: **G7** (Leak-gate NUL tripwire + retired-token cleanup).
95. `SecretsStore` identity: the frozen `internal_handle`, NOT `url_slug`; the SQL column keeps its
    old name (`project_slug`) by design. `auth/secrets-store.ts:10-27`.
    Protects: **N1** (Identity glossary + branded handle type), **N3** (internal_handle rename,
    ABI-facing files).
96. Cross-repo ABI property names (`internal_handle` option bags; `realmode-composer`/
    `boot-helpers` export names + paths) are reachable only via `NEUTRON_GRAPH_COMPOSER_MODULE` —
    invisible to in-repo grep. `gateway/index.ts:540` (the composer-module resolution seam).
    Protects: **M1**, **N3**.
97. `packageNameToSlug` couples core-package renames to already-installed data — a rename must
    ship a compat/migration path, not a pure rename. `cores/runtime/loader.ts:61-81`.
    Protects: **N4** (project_slug → owner_slug), **N5** (Directory/name hygiene).
98. `ChannelKind` strings are persisted row values — a rename is a data migration, not a
    find-and-replace. `channels/types.ts:12`.
    Protects: **N6** (`[BEHAVIOR]` ChannelKind persisted-value unification).
99. `docs/AS_BUILT.md` leak-gate exemptions are keyed to LITERAL paths — changelog consolidation
    must move allowlist entries in the same commit. `scripts/ci/leak-gate-allowlist.txt:69-80`.
    (Cross-ref #33/#83.)
    Protects: **K6**, **K7**, **G7**.
100. `prompts/*.md` loads are silent-fail-soft; the `KNOWN_PROMPTS`≡disk parity test pins dead
     files in place until deleted deliberately. `prompts/template.ts:140-147`.
     Protects: **K10** (Public in-repo SPEC.md + repoint agent prompts), **K6**.
101. Migration numbers and migration 0074's `tenant_provisioned` string are immutable — never
     renumber a migration file. `migrations/0074_rename_tenant_provisioned_phase.sql:40`.
     Protects: **P2**, **P3**.
102. `.url_slug` file precedence over `NEUTRON_INSTANCE_SLUG` env resolver.
     `gateway/index.ts:147-157`.
     Protects: **C1**, **N4**.
103. Healthz `project_slug` field, start-token dual claims, and JWT `slug` claim are wire contracts
     — renames there are cross-repo breaking changes. `gateway/index.ts:474-486` (healthz),
     `jwt-validator/claims.ts:26` (jwt `slug`).
     Protects: **M1**.
104. `KNOWN_PROMPTS` throws on unknown prompt names — the file and the registry entry must change
     together. `prompts/template.ts:140-147`.
     Protects: **K10**.
105. `deploymentMode`/`isLegalTransition` `'managed'` defaults are pinned by test matrices — rename
     the vocabulary token, do not change the default VALUES.
     `onboarding/engine.ts:573`, `phase.ts:146-158`.
     Protects: **N4**.

## 11. Security & config (`critic-security-config.md`)

106. `SecretsStore` encrypted-at-rest model: AES-256-GCM envelope `{v, iv_b64, ct_b64, tag_b64}`,
     keyfile at `<owner_home>/.neutron-aes-key` mode 0600, `expires_at` honored on read,
     `replaceAtomic` wraps delete+insert in one transaction.
     `auth/secrets-store.ts:8-27,208-210,257-302,448-471`.
     Protects: **S3** (Secrets-at-rest hygiene).
107. The `SecretsStore` SQL column is literally named `project_slug` but holds the FROZEN
     `internal_handle`; a caller passing `url_slug` silently loses all credentials — enforced by
     prose convention only. `auth/secrets-store.ts:10-27`. (Cross-ref #95.)
     Protects: **N1**, **S3** (branded-type fix belongs to security per the report).
108. Credential-pool threading into spawns explicitly UNSETS `ANTHROPIC_API_KEY`/
     `ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` before setting ONLY the selected credential;
     `cred_id` (never the secret) is what surfaces on completions. Already done right — preserve
     verbatim. `gateway/realmode-composer/build-llm-call-substrate.ts:184-207`.
     Protects: **C6**, **S1**.
109. Session cookie: HMAC-SHA256, 30-day sliding, `HttpOnly; SameSite=Lax; Path=/`, `Secure` only
     on https, constant-time HMAC compare. `landing/session-cookie.ts`, `open/composer.ts:3630`.
     Protects: **S1**, **C5**.
110. Start tokens are one-shot, single-use JTI, 15-min TTL, minted from the cookie secret.
     `open/composer.ts:1638-1653`. (Cross-ref #5/#31.)
     Protects: **S1**.
111. Bind-loopback-by-default is currently the ONLY real auth gate (app-ws auth is a hardcoded
     dev-bypass with the public constant `dev:owner`) — this must be preserved as the safety net
     until fail-closed auth ships; it is not itself something to "fix" incidentally.
     `gateway/index.ts:308`, `open/composer.ts:1978`.
     Protects: **S2** (WS origin + fail-closed guards) — the unit that replaces this gap, not an
     invariant to keep forever.

---

## Coverage summary

- **111 invariants** extracted from the 11 critic reports' load-bearing-subtleties /
  fail-soft-invariant / must-not-break sections (`critic-security-config.md` has no dedicated
  section; its "what exists and is fine" items are folded into §11 above).
- The vast majority cross-reference a specific refactor-plan unit (G/K/L/C/D/P/F/O/X/W/N/S/M
  series) that either builds a characterization test protecting the behavior or must
  demonstrably preserve it per the unit's own **Accept** criteria.
- Three items are explicitly **unprotected — covered by review only** (#8, #23, #43) — no unit
  in the current plan targets them directly; a build agent touching adjacent code must
  re-verify by hand and Argus/Codex review must call it out.
- `verified-findings.json` (the raw adversarial-verification workflow log) was consulted but not
  separately itemized — its 24/24 confirmed findings are already folded into the critic reports
  this file distills.

This file should be re-run/re-checked at Fable synthesis time for each merged unit: if a unit
closes an "unprotected" item by adding a test, update its line here to name that test.
