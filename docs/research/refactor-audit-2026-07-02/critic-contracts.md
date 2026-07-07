# Contracts Critic — Neutron Open Architecture Audit

Dimension: **contracts** — are the load-bearing seams honored, bypassed, minimal, or leaky?
All claims verified directly in code under /Users/ryan/repos/neutron-open (file:line cited).

Charter seams audited: Substrate/Event, Core SDK manifest + capability gate, ButtonPrompt
envelope, channel adapter interface, tabs resolver, entity-writer privacy gate, chat-core
client contract. Plus contract-shaped gaps discovered while verifying (stringly-typed error
events, contract types homed in implementations).

---

## Executive summary

The codebase has an unusually explicit contract *culture* — locked headers, VERBATIM
notices, "MUST" doc-comments — but several of the most load-bearing contracts are
**ceremonial**: enforced by comment, honored by only some parties, or wired to enforcement
machinery that production never activates.

Recurring pattern (the meta-finding): **a contract is declared in one place, enforced in
another, and production wiring connects neither.** Concrete instances:

1. The capability gate + approval policy exist as types + a gate hook + an ApprovalManager,
   but production passes no gate and no dispatch path consults approvals (§2).
2. The Substrate Event contract is typed for shapes but the *semantics* that drive
   credential-pool health live in regexes over error message prose (§1b).
3. The ChannelAdapter/ChannelRouter seam is documented as the architecture and wired into
   the module graph — with zero adapters registered, so its one production consumer
   (trident delivery) can never send (§4).
4. ButtonPrompt/app_chat dual-persist the same agent reply at different fidelity; which
   store you hydrate from determines whether buttons exist (§3).
5. The entity-writer "privacy gate" no longer gates anything; its read-side codec is
   re-implemented by hand in scribe (§6).

For a NO-FUNCTIONALITY-CHANGE refactor these are exactly the seams where a well-meaning
cleanup silently changes behavior — each section lists the load-bearing subtleties.

---

## 1. Substrate / Event contract (`runtime/substrate.ts`, `session-handle.ts`, `events.ts`)

### 1a. Honored on the write path, violated by the flagship adapter on cancellation

The contract is explicit:

- `events.ts:10-11`: "Cancellation: `iterator.return()` propagates to the adapter's `cancel()`."
- `session-handle.ts:13-15`: "Adapters MUST also cancel from inside the events iterator's
  `finally` so `iterator.return()` is enough."

**The production CC adapter violates this.** Its `SessionHandle.events` is an `EventChannel`
(`persistent-repl-substrate.ts:2704, 3005`) whose async iterator
(`event-channel.ts:45-59`) has **no `finally` and no cancel hookup** — a consumer that
`break`s out of `for await` leaves the turn running on the warm REPL. The two dormant
adapters DO conform (`gpt-5-5-api/index.ts:172-178` — generator `finally { ac.abort() }`;
codex-cli likewise).

Consumers have grown **compensating conventions** instead:
- `onboarding/history-import/substrate-callers.ts:481+` — drain deliberately does NOT
  `break` on the completion event ("adapter teardown depends on the iterator finishing").
- `trident/inner-loop.ts:375`, `agent-dispatch/substrate-turn.ts:93`,
  `scribe/extract.ts:141`, `build-llm-call-substrate.ts:508` — all drain to exhaustion.

**Undocumented superset**: the CC handle adds `isAlive()` ("SUPERSET of the locked
`SessionHandle` contract", `persistent-repl-substrate.ts:2998-3020`) and the synthesis
drain consumes it by structural duck-typing with casts
(`onboarding/synthesis/synthesis-session.ts:566-581`). This is a real cross-subsystem
contract (the 2026-06-18 false-wedge fix depends on it) that exists only as a cast.

**Refactor hazard**: naively "fixing" EventChannel to conform (finally → cancel) is a
behavior change — `cancel()` on an unsettled turn POISONS the warm session
(`persistent-repl-substrate.ts:3021-3041`), so early-`break` consumers would start
poisoning sessions. Either wrap deliberately (with the poison semantics understood and
pinned by test) or amend the contract doc with the CC exception. Promote `isAlive` to an
optional documented member.

### 1b. The error Event is stringly-typed; credential-pool health decisions parse prose

`Event` error variant carries only `{ message, retryable, retry_after_ms }`
(`events.ts:55`) — **no machine-readable class**. The gateway's credential-rotating
decorator therefore classifies failures by regex over adapter message text:

- `gateway/realmode-composer/build-llm-call-substrate.ts:611-617` `parseHttpStatusFromMessage`
  (leading `HTTP <N>:` token), `:628-643` `mapStatusForPoolCooldown`,
  `:687-693` `detectBinaryNotFound` (four ENOENT phrasings), `:720-726` `detectChannelWedged`
  (matches `spawn failed (channel-wedged|no-channel-ready|no-http-health|dead-child` —
  literal substrings of messages composed 3 layers down in the CC adapter),
  `:742-744` `detectTurnTimeout` (`/persistent-repl:\s*turn timeout/i`).
- Duplicated in `build-import-substrate.ts:409-416`.

The docstrings themselves record **three production incidents** caused by this seam
(2026-06-17 ENOENT→"all credentials in cooldown"; the dev-channel bind P0 laundered into
a quota lie; the 2026-06-26 turn-timeout→pool-cooldown cascade). Each fix added another
regex. A refactor that rewords `persistent-repl: turn timeout` — or the enforce-reply
message wording — silently reverts a P0 fix by changing credential-pool behavior.

**Proposal**: additive `code?: SubstrateErrorClass` on the error Event
(`binary_not_found | channel_wedged | turn_timeout | http_status(n) | ...`), stamped at
the adapter throw sites; classifiers read the code first, keep regex as fallback for one
release; port the existing classifier tests to assert code/regex agreement.

### 1c. AgentSpec is "locked" against a spec that isn't in the repo, and has become a dialect union

- The lock header cites `docs/engineering-plan.md § B.P1` (`substrate.ts:4-6`) —
  **that file does not exist in this repo** (verified). The contract's authority is
  unavailable to anyone (human or agent) working here.
- `turn_timeout_ms` / `turn_absolute_ceiling_ms`: "Read by the persistent CC REPL adapter
  only" (`substrate.ts:110-120`) — adapter-private knobs in the locked shape.
- `session`: "No caller passes `spec.session` today" on the shipped adapter
  (`substrate.ts:52-58`) — continuity is pool-key + registry, and *fixing* an adapter to
  honor `session.id` would break warm pooling.
- `metering_context` moonlights as a warm-pool project-key fallback (`substrate.ts:93-101`,
  `build-llm-call-substrate.ts:480`).
- Usage semantics differ per adapter: CC completions carry `ZERO_USAGE` by design
  (`persistent-repl-substrate.ts:186,1322`) while gpt-5-5-api reports real usage — a
  consumer cannot meter uniformly across "interchangeable" substrates.

**Proposal**: re-home the contract's authority in-repo; add an explicit per-adapter
dialect table (which fields are honored, usage semantics) in `substrate.ts`; move
adapter-only knobs to adapter options or formally version the spec. The three-adapter
conformance suite (`tests/integration/adapter-equivalence.test.ts`) is the natural place
to pin the dialect table.

Positive note: the *boundary* itself is honored — `tests/integration/
no-direct-anthropic-api.test.ts` structurally forbids bypassing Substrate for LLM calls,
and I found no direct-API bypass.

---

## 2. Core SDK manifest + capability gate

### 2a. The capability gate and the entire HITL approval system are inert at dispatch (P0)

The **only** dispatch chokepoint for agent tools is `McpServer.dispatch`
(`mcp/server.ts:67-84`). Its gate:

- defaults to always-allow: `this.capability_gate = options.capability_gate ?? (() => true)`
  (`mcp/server.ts:42`);
- production passes none: `new McpServer({ project_slug, registry: tools })`
  (`gateway/composition/build-core-modules.ts:253`);
- `dispatch()` never reads `reg.approval_policy`; `ApprovalManager.requestApproval`
  (`tools/approval.ts:97`) has **zero dispatch-path callers** — the manager is constructed
  as a graph module (`build-core-modules.ts:232-235`) and then never consulted.

Consequences, all verified:
- Tools declaring `approval_policy: 'prompt-user'` execute ungated:
  `agent-dispatch/tool.ts:97`, `trident/work-board-build-tool.ts:117`,
  `trident/codex-credential-tool.ts:92`, `skill-forge/tool.ts:163`.
- Capability enforcement is **voluntary**: each bundled Core wraps its own handlers in a
  `CapabilityGuard` built from its own manifest (e.g. `cores/free/tasks/src/tools.ts:127`).
  A third-party Core that skips the wrapper gets un-gated, un-audited dispatch — on a
  platform whose published SDK advertises capability-gated tools.
- The manifest cannot even *express* approval: `ToolDefSchema` (`cores/sdk/manifest.ts:103-110`)
  has no approval field, and install hardcodes `DEFAULT_APPROVAL_POLICY: 'auto'` for every
  Core tool (`gateway/cores/install-bundled.ts:936, 975, 953`). So HITL is unreachable for
  Cores by construction on three independent grounds.

**Proposal**: make `McpServer.dispatch` the single enforcement chokepoint — capability
check keyed off installation records + approval-policy consult — preserving the
`secret_audit_log` row shapes. Making 'prompt-user' actually prompt is a *deliberate*
behavior change to be decided, not silently shipped; a log-only enforcement mode first
de-risks the open-capability-string inventory.

### 2b. The real Core module contract is gateway duck-typing with silent degradation (ISSUE #330 class)

The documented SDK contract (defineable entry points) does not exist; the real contract is:

- dynamic import + `typeof mod.buildTools !== 'function'` checks of **undeclared** barrel
  exports (`install-bundled.ts:751-800`), optional `buildExtraTools`, `LAUNCHER_ICON`;
- backend injection via a hardcoded per-slug key table `BACKEND_KEY_BY_SLUG`
  (`install-bundled.ts:1024-1035`, including a `dtc_analytics` entry for a Core not in
  the repo);
- manifest tools with no handler become **throw-stubs with a log line**
  (`install-bundled.ts:886-905`, `manifest_tool_unimplemented`) — install stays `ok`,
  which is exactly how the notes Core shipped 4 silently-broken tools;
- `capability_required: def.capability_required as NeutronCapability` casts
  (`install-bundled.ts:935, 974`) defeat the closed union;
- `wrapHandler` drops `ToolCallContext` — Core handlers get args only
  (`install-bundled.ts:957-964`), so Cores can never be topic/speaker-aware while
  first-party tools can. That asymmetry is nowhere declared.

**Proposal**: a typed `BundledCoreModule` / `defineCore` entry point in cores/sdk (one
factory + declared backend key), install-bundled typed against it; manifest.tools ⊄
handlers becomes a hard install failure or a *surfaced* degraded state (visible in
/api/cores), not a log line; a conformance test asserting all 9 bundled barrels satisfy
the type.

### 2c. Dual manifest contracts — the published one is the fake one

- `core-sdk/validator.ts:164` `validateNeutronManifest` (650-line hand validator + JSON
  schema mirror, on npm): **zero production callers** (verified).
- Production validates via Zod `parseManifest` (`cores/runtime/loader.ts:179`,
  `cores/sdk/manifest.ts:305+`), whose `CapabilitySchema` is an open `<verb>:<resource>`
  regex (`manifest.ts:62-65`) — deliberately broader than core-sdk's closed
  `NeutronCapability` union (`core-sdk/types.ts:139-161`).
- The two are kept "shape-compatible" by comment discipline (`cores/sdk/manifest.ts:17-31`).

Every Core with a custom capability string (`read:tasks_core.db`, etc.) is only
dispatchable *because* the casts defeat the closed union. Collapse to one Zod source of
truth; retype `ToolRegistration.capability_required` as the validated open string plus an
explicit known-platform set consulted by the (newly real) gate; delete or generate the
hand validator. Do this **before** third-party authors arrive — it's public API debt after.

---

## 3. ButtonPrompt envelope + the durable chat transcript

### The dual-source-of-truth is worse than "options stripped from body"

One agent reply on the live path is persisted **twice at different fidelity**
(`gateway/realmode-composer/build-live-agent-turn.ts:970-1016`):

1. `buttonStore.emit(...)` (`:986`) → `button_prompts` row: body with `[[OPTIONS]]`
   STRIPPED, options preserved in `options_json` (`channels/button-store.ts:780-789`
   documents this and exists — `latestPromptByTopic` — precisely because consumers must
   never re-parse `body`; Codex P1 PR#144).
2. The live envelope goes through `AppWsAdapter.send` → `chat_log.append` persists
   **body only** (`channels/adapters/app-ws/adapter.ts:173-199`).

Hydration then splits by transport:
- HTTP history: `button_prompts` via `listHistoryByTopic`
  (`gateway/http/chat-history-surface.ts:182`) — buttons present.
- WS `resume` replay: `app_chat_messages` via `appChatRowToEnvelope`
  (`adapter.ts:806-841`) — agent rows rebuild with **no options, no prompt_id, no
  citations, no doc_refs**. A reconnecting client replays a button prompt as plain text.

There is no hydration-parity test across the two stores (chat-transport mapper confirms).

Additional envelope leak: `channels/adapters/app-ws/envelope.ts` has become the app-wide
frame dumping ground (work-board items `:457`, run progress, import progress) and there
are ≥5 near-identical option shapes bridged by lossy hand-mappings:
`ButtonOption` (`button-primitive.ts:59`), `InlineChoice` (`channels/types.ts:131`),
`AppWsOutboundAgentMessageOption` (`envelope.ts:181`), the inline literal in
`ChatOutbound` (`landing/server.ts:232-240`), the mobile mirror
(`app/lib/ws-envelope.ts:98`), plus the app-socket render shape. One more hand-mapping
lives in the Open composer receiver (`open/composer.ts:2725-2731`).

**Proposal** (concurring with the chat-transport mapper, with contract emphasis): declare
`app_chat_messages` the single durable transcript, widen its schema to carry agent
metadata (options/prompt_id/citations/doc_refs JSON columns), shrink `button_prompts` to
prompt *lifecycle*. **First deliverable is the hydration-parity test** — it is the
contract, and today it would fail, which is the finding.

Load-bearing subtleties a refactor must not break: `latestTurnByTopic` tiebreak is
`rowid DESC` not `prompt_id DESC` (`button-store.ts:768-777`); first history page is
inclusive `<=`, later pages strict tuple; `__timeout__`/`__cancel__` resolutions render
as UNRESOLVED never user bubbles; `EmitResult.was_delivered` re-render rule.

---

## 4. Channel adapter interface — a documented architecture that production bypasses

`channels/types.ts:1-12` declares the architecture: "adding a platform requires
implementing `ChannelAdapter` (one file) plus a single `registerChannelAdapter(adapter)`
call at boot. The 9 surfaces ... derive by reflection from the manifest." **None of this
exists**: the function is `registerAdapter`, there are no reflected surfaces, and
`registerAdapter` has **zero production call sites** (grep: tests only —
`gateway/__tests__/*-production-composer.test.ts`, `channels/router.test.ts`).

Production reality:
- Telegram: `buildWebhookHandler` mounted directly (`build-telegram-webhook.ts:136`),
  `TelegramAdapter` class never instantiated outside tests.
- App-ws: `AppWsAdapter` constructed directly (`open/composer.ts:3206`), driven by a
  bespoke receiver and direct `adapter.send` calls (`open/composer.ts:2731` etc.), never
  registered on any router.

Meanwhile the module graph **does** build a `ChannelRouter`
(`build-core-modules.ts:238-245`; `input.channel_router` is never set by Open) and wires
it as the **outbound sink for trident terminal delivery**
(`build-core-modules.ts:341-342` `buildTridentDelivery({ sink: router })`). With zero
adapters, `router.send` throws `no channel adapter registered for kind='...'`
(`channels/router.ts:143-151`). The tick loop would swallow this into a logged error
(`trident/tick.ts:169-179`) — i.e. **silent delivery loss by construction**.

Today this is masked because no Open path sets `run.chat_id`:
- `work_board_dispatch_build` passes no chat_id (`trident/work-board-build-tool.ts:118-133`);
- the `/code` chat filter (`gateway/boot-helpers.ts:602`) has **no production call site**
  in this repo — Open's chat filter chain is cores + skill-forge only
  (`open/composer.ts:1208-1211`).

So Open stamps `channel_kind: 'app_socket'` onto runs (`open/composer.ts:3563`) whose
delivery can never fire, through a sink that could never send. The seam is
triple-fictional: documented machinery absent, declared registration unused, and the one
wired consumer unreachable-or-throwing.

Vocabulary forks compound it: `ChannelKind` is `'telegram'|'app_socket'|'webhook'|'cli'`
(`types.ts:12` — 'webhook'/'cli' have no adapters) while `ChannelKindForButton` is
`'telegram'|'app-socket'|'webhook'` (`button-primitive.ts:57` — hyphen, no 'web'); the web
surface stamps resolutions as `'app-socket'` (`chat-bridge.ts:1653`) or the `'webhook'`
system sentinel (`button-store.ts:307,950`).

**Proposal**: decide the seam. Either (a) make it real — register AppWs + Telegram
adapters on the graph router, route trident delivery + proactive through it, add a
composition test that the router serving delivery has an adapter for every ChannelKind a
run can carry; or (b) delete the router-as-sink wiring + the ABC and declare direct
composition the architecture. (b) is behavior-preserving today; (a) *activates dormant
sends* and must be done under test. Fix the `types.ts` fiction header either way, and
merge the ChannelKind vocabularies.

---

## 5. Tabs resolver + client type mirrors — the drift-alarm pattern applied inconsistently

The repo already invented the right pattern: `app/__tests__/ws-envelope-parity.test.ts`
imports the SERVER envelope types (test-only — bundle purity preserved) as a deliberate
drift alarm for the hand-mirrored `app/lib/ws-envelope.ts`. Same for doc-links
(`runtime/__tests__/doc-links-parity.test.ts`).

The tabs resolver contract has **three** declarations and **zero** alarms:
- source of truth `tabs/registry.ts:67`;
- `app/lib/tabs-client.ts:40-52` — "Mirrors ... byte-for-byte" by comment only;
- `landing/chat-react/tabs-client.ts:42-58` — same.

No test in `app/__tests__/` or `landing/chat-react/__tests__/` imports `tabs/registry`
(verified). Same unguarded class: `AgentEngagementMode` in `app/lib/projects-client.ts:24-29`
("must stay in lockstep" with `connect/agent-engagement.ts`, comment-only).

**Proposal**: parity tests for every declared mirror (S effort, do before any refactor
near these files); longer-term a node-free wire-types leaf package (chat-core already
proves both bundles can import a shared workspace package, so the "can't import across
the boundary" rationale in the mirror comments is only true for node-tainted modules).

---

## 6. Entity-writer "privacy gate" — the gate is gone; the format codec is split

The quarantine that made this a privacy *gate* was removed with the content-sync mesh
(`runtime/entity-writer.ts:56-61`). What remains is ceremonial:
- `originInstance` / `receivingInstanceSlug` are REQUIRED at ~13 call sites but "no longer
  gate persistence" (`entity-writer.ts:117-138`);
- `allowPersistOrigins` — "VESTIGIAL ... nothing reads this now" (`:140-145`).

The write path IS honored — all entity page writes go through `writeEntity` (scribe,
project-materializer, entity-populator, project-page-indexer; verified by grep). But the
**read path bypasses the writer's private format**: scribe hand-implements the inverse
codec — "Replicates the entity-writer's `extractCompiledTruth`"
(`scribe/write-to-gbrain.ts:440`), "inverse of `entity-writer.ts:renderYamlFrontmatter`"
(`:461, :484`) — and the kind↔directory map is triplicated
(`write-to-gbrain.ts:331-338`, `gbrain-memory/GBrainSyncHook.ts:47-54` "duplicated by
design"). These parsers guard *data loss* (append-only merge, frontmatter preservation),
so silent drift is the failure mode, and nothing pins them to the renderer.

**Proposal**: export the page codec (render + parse + KIND_TO_DIR) from an entity-format
leaf in runtime; golden round-trip test (render→parse→render byte-stable); delete the
mirrors; remove the vestigial attribution params in one mechanical sweep (keep
`originInstance` only if multi-author attribution is still wanted — it is written into
frontmatter).

---

## 7. Contract types homed inside implementations (inverted/sideways edges)

Contract interfaces repeatedly live inside the god-file that implements one side,
forcing every other party to import the implementation:

- **Chat wire protocol**: `ChatOutbound`/`ChatBridge`/`PendingChatClaim` defined in
  `landing/server.ts:203-699` (an edge package), imported by gateway
  (`chat-bridge.ts:45`, `recovered-reply-store.ts:51`, `build-live-agent-turn.ts:67`,
  `proactive/button-store-sink.ts:36`), reminders (`outbound.ts:24`), open composer
  (`:214`). The ChatBridge JSDoc is the ONLY spec for jti-claim atomicity and
  seed-reemit races — relocate, never delete.
- **Tool resolver**: `mcp/server.ts:15` imports `McpToolResolver` from the *dormant*
  `gpt-5-5-api` adapter — the platform tool server depends upward on an adapter nobody
  constructs.
- **ChatCommandFilter**: defined in `gateway/http/app-ws-surface.ts`, imported sideways
  by `chat-bridge.ts`, and structurally re-cloned by three Cores
  (`cores/free/research/src/chat-bridge.ts:22-58`, email, scraping) because they can't
  import the gateway.
- **ImportJobRunnerHook**: defined inside `onboarding/interview/engine-internals.ts`
  (the 10k-line engine's friend interface), imported by
  `gateway/realmode-composer/build-synthesis-import-runner.ts:54-55` — the engine split
  is blocked backwards by its own hook contract.
- **OutboundSink**: declared twice (`trident/delivery.ts:46`, `gateway/proactive/sink.ts`).

**Proposal**: zero-dep contract leaf modules (chat-protocol, tool-resolver,
chat-command-filter, import-runner-hook), old paths re-export during transition. This is
a *prerequisite* for the declared god-file splits (engine.ts, chat-bridge.ts,
open/composer.ts) — do it first and those splits stop being cross-package events.

---

## 8. chat-core client contract — the healthy example (with one caveat)

`chat-core` is the best-behaved seam in the audit: zero-dependency leaf, defensive
duck-typed decoders that drop malformed frames (`chat-core/types.ts:429+`), explicit
merge laws (receipts union-monotonic, reactions/edits rev-LWW, seq-ordering), shared by
both the Expo app and the React web client — disproving the "can't share across the
workspace" rationale used elsewhere. Its contract risks are inherited, not intrinsic:
it normalizes frames whose authoritative shape lives in `channels/adapters/app-ws/envelope.ts`
and (for agent metadata) in whatever the resume replay reconstructs (§3) — so the §3
transcript unification and §5 wire-types extraction are what protect it.

---

## Cross-cutting recommendations (ordered)

1. **Write the missing conformance/parity tests first** — they ARE the contracts:
   hydration parity (button_prompts vs app_chat vs live), three-adapter SessionHandle
   conformance (incl. iterator.return semantics), tabs/engagement mirror parity,
   entity-format golden round-trip, install-time manifest⊆handlers.
2. **Make dispatch the enforcement chokepoint** for capabilities/approvals (log-only
   mode first; enabling prompt-user is a flagged behavior change).
3. **Type the error Event** (additive `code`), then de-duplicate the two gateway
   classifiers against it.
4. **Extract contract leaf modules** (chat protocol, tool resolver, chat-command filter,
   import hook) before the god-file splits.
5. **Decide the ChannelRouter seam** (make real or delete) — do not leave the
   adapterless-router-as-sink wiring in place.
6. **Unify the manifest contract** into one Zod source before publishing SDK guidance
   to third parties.

## Findings index (see StructuredOutput for full statements)

| # | Title | Sev | Effort |
|---|-------|-----|--------|
| 1 | Capability gate + HITL approvals inert at the only dispatch chokepoint | P0 | M |
| 2 | Substrate error contract stringly-typed; pool health parses prose | P1 | M |
| 3 | Core→gateway module contract is duck-typing w/ silent throw-stub degradation | P1 | M |
| 4 | Dual manifest contracts; published SDK validator + closed union are fiction | P1 | M |
| 5 | Chat transcript dual source of truth (options_json vs body; lossy resume) | P1 | L |
| 6 | ChannelAdapter/Router seam fictional; wired consumer can't send | P1 | M |
| 7 | SessionHandle cancel deviation + duck-typed isAlive superset | P2 | M |
| 8 | AgentSpec lock anchored to a nonexistent doc; adapter-dialect drift | P2 | S |
| 9 | Contract types homed inside implementations (inverted edges) | P2 | M |
| 10 | Type mirrors without drift alarms (tabs, engagement mode) | P2 | S |
| 11 | Entity-writer gate ceremonial; page codec split across writer/scribe | P2 | M |
| 12 | ChannelKind / topic-id vocabulary forks at the button seam | P3 | M |
