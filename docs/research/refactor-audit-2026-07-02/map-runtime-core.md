# Subsystem map: runtime-core (`runtime/` excluding `adapters/`)

Audited 2026-07-02 against `/Users/ryan/repos/neutron-open` @ `d30280c` (main). All 575 unit tests in scope pass (`bun test runtime/{*.test.ts,__tests__,subagent}` — 27 files, 6.2s, 0 fail).

## 1. Purpose & responsibilities

`@neutronai/runtime` is nominally the substrate layer: the locked `Substrate.start(spec) → SessionHandle` contract that makes every LLM backend (Claude Code REPL, Codex CLI, OpenAI Responses API) interchangeable, plus the shared primitives adapters and callers need (credential pool, event union, model registry). Its `AGENTS.md` (runtime/AGENTS.md:3) says "This module owns the substrate dispatcher."

In practice it has accreted three additional, unrelated roles:

1. **Open/Managed platform seam** — `PlatformAdapter` (platform-adapter.ts, 872 lines) plus a constellation of structural-type files lifted out of the proprietary Managed tree during the 2026-05 OSS split (connect-handlers.ts, start-token-types.ts, pending-redirect-types.ts, slug-picker-types.ts, internal-signature.ts, oauth-pkce.ts, return-url-validator.ts, consumed-tokens-in-memory.ts, slug-grammar.ts).
2. **Entity persistence gate** — `entity-writer.ts` (768 lines): the single transactional, path-contained writer for `entities/<kind>/<slug>.md` pages, plus `auto-link.ts` (501 lines) typed-link extraction.
3. **Subagent supervision** — `subagent/` (~1,100 lines non-test): registry, spawn guard, control, watchdog, lifecycle, announce, turn-progress.

Plus a grab-bag of shared leaves: models.ts / model-pricing.ts, doc-links.ts (918 lines of channel URL rendering), system-prompt.ts, platform-hints.ts, tool-loop-detection.ts, atomic-write.ts, constant-time-equal.ts, entity-slug.ts, env-flag-tokens.ts, onboarding-conversational-flag.ts.

## 2. Module inventory (non-test, wc -l)

| Cluster | File | LOC | Notes |
|---|---|---|---|
| Substrate contract | substrate.ts | 135 | `Substrate`, `AgentSpec`, `Message`. "Locked 2026-04-25, VERBATIM per engineering-plan §B.P1" |
| | session-handle.ts | 34 | `SessionHandle` (events / respondToTool / cancel / tool_resolution) |
| | events.ts | 56 | `Event` tagged union + `TokenUsage` |
| Credentials | credential-pool.ts | 254 | 4 strategies, cooldown TTLs, pure-ish functions over a mutable pool |
| Models | models.ts | 164 | model aliases + `getBestModel()` dynamic accessor (module-local mutable override) |
| | model-pricing.ts | 171 | $/MTok registry |
| Entity gate | entity-writer.ts | 768 | transactional write + frontmatter schema + YAML emitter + timeline merge + sync hook |
| | auto-link.ts | 501 | typed-link (Triple) extraction |
| | entity-slug.ts | 46 | slug grammar leaf |
| Platform seam | platform-adapter.ts | 872 | `PlatformAdapter` interface, 20+ methods, 12 capability flags |
| | platform-adapter-local.ts | 553 | Open concrete (`LocalPlatformAdapter`) |
| | connect-handlers.ts | 185 | structural aliases for dormant Connect API |
| | internal-signature.ts | 131 | HMAC sign/verify for identity↔gateway handoff |
| | oauth-pkce.ts, return-url-validator.ts, start-token-types.ts, pending-redirect-types.ts, slug-picker-types.ts, consumed-tokens-in-memory.ts, slug-grammar.ts | ~700 combined | Managed-split shrapnel (structural types + pure helpers) |
| Prompt assembly | system-prompt.ts | 196 | persona + context files + hints assembler |
| | platform-hints.ts | 146 | per-channel prompt fragments |
| Guards/utils | tool-loop-detection.ts | 193 | repeat/ping-pong/cooldown detector |
| | atomic-write.ts | 161 | "the ONE crash-safe file-write leaf" |
| | constant-time-equal.ts | ~30 | consolidated timing-safe compare (P3-10 audit) |
| | env-flag-tokens.ts / onboarding-conversational-flag.ts | 127 | env-flag parsing |
| Doc links | doc-links.ts | 918 | docs:/ marker → per-channel URL; mirrored in app/lib/doc-links.ts (493 LOC) with parity test |
| Subagent | subagent/registry.ts | 172 | in-memory `SubagentRegistry`, caps (depth 1 / 5 children / 8 concurrent) |
| | subagent/spawn.ts | 216 | spawn validator + double-spawn guard + delegation-token check |
| | subagent/control.ts | 139 | cancelRun/failRun/waitForCompletion (poll-based) |
| | subagent/watchdog.ts | 219 | agent-aware reaper (process_dead / stuck via JSONL turn-progress) |
| | subagent/turn-progress.ts | 204 | JSONL-tail "real turn event" prober |
| | subagent/lifecycle.ts | 73 | tick = watchdog then prune |
| | subagent/announce.ts | 72 | pure completion formatter |

package.json (runtime/package.json): name `@neutronai/runtime`, sole dependency `@modelcontextprotocol/sdk`.

## 3. Public seams other subsystems consume

- **`Substrate` / `AgentSpec` / `SessionHandle` / `Event`** — the big one: 71 external import sites of `runtime/substrate.ts`, 56 of `session-handle.ts`, 55 of `events.ts` (grep, excluding runtime/ itself). Consumed by gateway/realmode-composer (all `build-*` substrate wrappers), agent-dispatch, onboarding (interview engine, history-import, synthesis), open/composer.ts, cores (research, email), channels.
- **`credential-pool.ts`** — 18 external import sites. Producers: `gateway/realmode-composer/resolve-llm-credentials.ts` (4-tier resolution: DB Max OAuth → env OAuth → BYO ApiKeyStore → per-instance env → shared env), `auth/byo-api-key-fallback.ts`, `auth/max-oauth.ts`. Consumers: `build-llm-call-substrate.ts` / `build-import-substrate.ts` (select→dispatch→reportSuccess/Failure), `memoize-credential-pool.ts` (`hasUsableCredential`).
- **`models.ts`** — 33 external import sites; single source of truth for model ids, including the mutable `getBestModel()` runtime override used by the model-update watchdog (models.ts:110-120).
- **`writeEntity` (entity-writer.ts)** — ~14 non-test consumers: scribe/, gbrain-memory/GBrainSyncHook.ts, onboarding history-import + wow-moment, 7 gateway/realmode-composer builders, reflection/diary-store.ts.
- **`PlatformAdapter`** — 18 external import sites; threaded through `gateway/composition/input/platform-input.ts` into chat-bridge, boot-helpers, cores-oauth-surface, project-backup-store.
- **`subagent/`** — consumed by agent-dispatch/ (service.ts, watchdog-report.ts, prompts.ts), open/composer.ts:666 (constructs the one live `SubagentRegistry` + `newControlState`), trident/ (AgentKind vocabulary), cores/free/code-gen (runtime-runner uses `waitForCompletion`).
- **`doc-links.ts`** — Telegram adapter + app-ws adapter render through it; the Expo app keeps a byte-parity mirror (runtime/__tests__/doc-links-parity.test.ts).
- **`assembleSystemPrompt`** — gateway/realmode-composer/build-live-agent-turn.ts, gateway/http/admin-personality-surface.ts, and the CC adapter's build-repl-argv.ts.

## 4. Workspace dependencies

**Declared (package.json):** only `@modelcontextprotocol/sdk`. No workspace deps declared.

**Actual outbound imports (grep, excluding adapters/):**
- `../core-sdk/types.ts` — `ToolDef` (substrate.ts:21). Type-only, reasonable (tools contract).
- `../jwt-validator/index.ts` — `JwksCache` type (connect-handlers.ts:21). Type-only.
- `../onboarding/interview/phase.ts` — **a layering inversion**: platform-adapter.ts:53 and platform-adapter-local.ts:65 (type-only), and onboarding-conversational-flag.ts:24 imports `ALL_PHASES` as a **value**. The bottom layer imports from a top-layer product surface.

**Inbound:** effectively everything (gateway, channels, onboarding, agent-dispatch, trident, open, cores, scribe, gbrain-memory, auth, landing, mcp). Crucially, almost all inbound edges are **relative paths** (`../../runtime/...`), not the `@neutronai/runtime` package name: only 4 non-test files use the package specifier (channels/adapters/app-ws/adapter.ts, channels/adapters/telegram/index.ts, cores/free/email/src/substrate-llm.ts, tests/integration helper). `gateway/package.json` does not declare `@neutronai/runtime` at all despite ~40 gateway files importing it relatively. The Bun-workspace package boundary is a fiction.

## 5. Internal layering

Rough internal DAG (clean, no cycles observed):
```
leaves: constant-time-equal, atomic-write, entity-slug, slug-grammar, env-flag-tokens, events
  ├── credential-pool (standalone)
  ├── substrate ← session-handle ← events; ToolDef from core-sdk
  ├── entity-writer ← auto-link, entity-slug
  ├── system-prompt ← platform-hints
  ├── platform-adapter ← slug-grammar, start-token-types, connect-handlers, internal-signature, onboarding/phase (!)
  │     └── platform-adapter-local ← onboarding-conversational-flag
  └── subagent/: registry ← control ← watchdog ← lifecycle; spawn ← registry; turn-progress standalone
```
`index.ts` barrel exports only a subset (substrate types, credential pool, tool-loop, platform-hints, system-prompt, doc-links) — it omits entity-writer, models, platform-adapter, subagent, and even credential-pool's `hasUsableCredential`/`soonestCooldownUntil` that gateway consumes (gateway/realmode-composer/memoize-credential-pool.ts:106). The barrel is stale and mostly bypassed.

## 6. Is the Substrate seam real and minimal? What leaks?

**The contract itself is real, small, and well-tested.** `Substrate` is one method (substrate.ts:133-135); `SessionHandle` is four members; `Event` is a 7-variant tagged union with an explicit coalescing rule (events.ts:8-11). `tests/integration/adapter-equivalence.test.ts` exercises multiple adapters against the same contract, and `tests/integration/no-direct-anthropic-api.test.ts` enforces "all LLM calls go through a Substrate."

**But the seam leaks in four ways:**

1. **CC-adapter-specific fields in the generic spec.** `AgentSpec.turn_timeout_ms` and `turn_absolute_ceiling_ms` are documented as "Read by the persistent CC REPL adapter only... other substrates ignore it" (substrate.ts:110-120), and `metering_context.project_id` is double-dutied as a warm-pool project-keying fallback specific to the CC adapter (substrate.ts:93-101). The lowest-common-denominator contract now encodes one adapter's PTY-idle-watchdog semantics.
2. **Continuity is out-of-band.** `AgentSpec.session` is dead on the shipped adapter — "the persistent-REPL CC adapter does NOT consume `spec.session`... No caller passes `spec.session` today" (substrate.ts:52-58). Real continuity is the adapter's pool key (`substrate_instance_id, user_id, project_id, credential_identity`), i.e. it lives in adapter **constructor options**, not the spec. Any refactor that treats `AgentSpec` as the whole per-turn input will break cross-turn continuity.
3. **The "dispatcher" doesn't live here.** AGENTS.md claims runtime owns the dispatcher, but the actual per-call orchestration — resolve live pool → `selectCredential` → OAuth refresh → scrub env → dispatch → `reportSuccess/Failure` cooldown feedback — lives in gateway: `build-llm-call-substrate.ts` (851 LOC) and its older sibling `build-import-substrate.ts` (476 LOC), which share extracted classification helpers but remain two parallel wrapping substrates (build-llm-call-substrate.ts:33-38 admits the refactor). Credential threading crosses the seam via **environment variables layered into the spawned child** rather than via the Substrate contract.
4. **Two of the three promised adapters are production-dormant.** substrate.ts:9-13 declares three concrete implementations; no production composition (gateway/, open/, onboarding/, agent-dispatch/) constructs the gpt-5-5-api or gpt-5-5-codex-cli substrates — only tests and type-only imports (mcp/server.ts:15 imports the gpt mcp-shim resolver *type*). The seam's polymorphism is exercised by tests, not by the product.

**Credential threading verdict:** the pool primitive is clean (pure-ish, unit-tested, cooldown semantics documented per Hermes port, credential-pool.ts:1-26). The threading is where it gets messy: pool resolution has 5 precedence tiers with env fallbacks and deployment-mode gating (resolve-llm-credentials.ts:5-50), memoization with all-cooldown invalidation lives in another file, per-call selection + env-scrubbing + cooldown reporting live in two parallel gateway wrappers, and the `'ambient'` credential kind (credential-pool.ts:30-36) means "no secret at all — let the child's Keychain auth win," a special case each consumer must know about. Nothing enforces the header's own invariant that "the caller is responsible for never mixing owners" (credential-pool.ts:25-26).

## 7. entity-writer privacy gate

The "privacy gate" today = (a) path containment under `<ownerDataDir>/entities/` via resolved-path prefix check (entity-writer.ts:258-263, 715-720), (b) symlink rejection at file/dir/root (entity-writer.ts:269-271), (c) kind allow-list + slug grammar + frontmatter schema (entity-writer.ts:392-464), (d) atomic tmp+rename with 0600 mode (entity-writer.ts:331-343). The original cross-instance quarantine chain (`assertPersistable`) was **removed** with the Connect content-sync mesh (entity-writer.ts:56-63) — so `originInstance` / `receivingInstanceSlug` are attribution-only, and `allowPersistOrigins` is explicitly vestigial: "nothing reads this now. Kept... to avoid churning the ~13 writeEntity call sites" (entity-writer.ts:139-145). Note: entity-writer rolls its own tmp+rename (no fsync) instead of using the sibling `atomic-write.ts` ("the ONE crash-safe file-write leaf", atomic-write.ts:2-7) — two atomic-write idioms in one package, with different durability guarantees.

Known-and-documented drift risk: the post-commit `syncHook` (MemoryStore + GBrain KG) fires only on `changed: true`, so a hook failure after a committed write is unrecoverable by re-running (entity-writer.ts:184-197). That's accepted debt with logging, not a bug.

## 8. subagent/ supervision

Design is genuinely good: single-owner liveness transitions (watchdog is "the SOLE owner of live→terminal transitions"; lifecycle composes rather than duplicates it, watchdog.ts:47-53, lifecycle.ts:55-60), race-safe `failRun` re-checks status after the canceller await (control.ts:88-101), JSONL turn-progress as authoritative anti-heartbeat-masking signal (watchdog.ts:30-41), and a TOCTOU-free double-spawn guard whose ordering (authorize → guard → caps) is explicitly reasoned (spawn.ts:103-175).

Caveats:
- The registry is **in-memory only**; the promised SQLite persistence "S4" never landed (registry.ts:5-7, control.ts:119 "S4 swaps for an event-emitter-driven wait"). A gateway restart orphans children with no reap path.
- The **delegation-token machinery is production-dead**: `MAX_SPAWN_DEPTH = 1` (registry.ts:14) and the only production verifier is `REJECT_DELEGATION`, which unconditionally throws ("top-level dispatch never carries a delegation token", agent-dispatch/service.ts:246-249). `DelegationClaims`/`DelegationVerifier`/claims-matching in spawn.ts:47-65,121-152 and `delegation_claims` on the record exist solely for tests; the referenced production verifier "@neutronai/jwt-validator (lands in S2)" (spawn.ts:62-64) was never wired.
- `waitForCompletion` is a 100ms poll loop (control.ts:121-135) with exactly one consumer (cores/free/code-gen/src/runtime-runner.ts).

## 9. Architectural debt (ranked)

### P1 — `runtime/` is three subsystems + a util junk drawer wearing one package name
Evidence: §1-2 inventory. Substrate contract (~500 LOC) vs Open/Managed platform seam (~2,500 LOC) vs entity persistence (~1,300 LOC) vs subagent supervision (~1,100 LOC) vs channel URL rendering (doc-links.ts, 918 LOC) share no cohesion; doc-links is a *channels* concern, entity-writer is a *memory* concern, platform-adapter is a *composition/boot* concern. New shared leaves default to landing here (constant-time-equal.ts header: consolidated from four other subsystems). This is the root cause of runtime's 250+ inbound import edges and makes "what is the substrate layer" unanswerable.

### P1 — Workspace package boundary is a fiction; the barrel is stale
Evidence: only 4 non-test files import `@neutronai/runtime`; everything else deep-imports by relative path (71 sites for substrate.ts alone); gateway/package.json declares 13 workspace deps but not runtime; index.ts omits entity-writer, models, subagent, platform-adapter, and functions gateway actually uses (`hasUsableCredential`, memoize-credential-pool.ts:106). Consequence: no tool can see or enforce the dependency graph; any file can reach any other file.

### P1 — Layering inversion: runtime imports onboarding
Evidence: platform-adapter.ts:53, platform-adapter-local.ts:65 (type), onboarding-conversational-flag.ts:24 (**value** import of `ALL_PHASES`). The substrate layer depends on the interview engine's phase ontology because two feature-flag accessors (`getOnboardingConversational*`, platform-adapter.ts:600-615) were parked on `PlatformAdapter`. Inverting this (move the flag parser + phase type into onboarding, or make the adapter generic over a string phase) is a small, behavior-preserving cut.

### P2 — `PlatformAdapter` is a kitchen-sink god interface
Evidence: platform-adapter.ts — 20+ methods and 12 capability flags spanning slug rename, install tokens, OAuth handoff, Caddy reload, sudoers, Telegram bot provisioning, connect fan-out, project backup (5 methods), onboarding feature flags, core roots. On Open, 6 methods throw and 7 optional hooks are undefined; the Managed concrete referenced in its own header (`runtime/platform-adapter-managed.ts`, platform-adapter.ts:20) **does not exist in this repo** — the doc is stale. The `OpenPlatformAdapter`/`ManagedPlatformExtension` derived types (platform-adapter.ts:794-829) already name the split; the refactor should make Open code depend on `OpenPlatformAdapter` only.

### P2 — Dispatcher logic duplicated in gateway, absent from runtime
Evidence: AGENTS.md:3 claims runtime owns the dispatcher; the real select-credential→scrub-env→dispatch→report loop lives twice in gateway (build-llm-call-substrate.ts 851 LOC + build-import-substrate.ts 476 LOC, the former's header documenting the partial extraction). A single credential-rotating `Substrate` decorator belongs beside credential-pool.ts in runtime.

### P2 — CC-adapter semantics leaked into the locked `AgentSpec`
Evidence: substrate.ts:110-121 (`turn_timeout_ms`/`turn_absolute_ceiling_ms` "Read by the persistent CC REPL adapter only"), substrate.ts:93-101 (metering_context double-duty), substrate.ts:52-58 (`session` field dead on the shipped adapter). The "VERBATIM / do not edit without amendment" header (substrate.ts:4-6) has already been amended repeatedly, so the lock is ceremonial.

### P2 — Speculative/dead machinery in subagent
Evidence: delegation tokens unreachable in production (agent-dispatch/service.ts:247, registry.ts:14 depth cap 1); registry SQLite persistence never landed (registry.ts:5-7); `STALE_THRESHOLD_MS` deprecated alias (lifecycle.ts:26-32). Either wire the verifier or delete the token path.

### P3 — Vestigial `allowPersistOrigins` + attribution fields on `EntityWriteInput`
Evidence: entity-writer.ts:139-145 ("nothing reads this now"), ~13 call sites still constructing it.

### P3 — Two atomic-write idioms
Evidence: atomic-write.ts:2-7 ("Every atomic file write... routes through this module") vs entity-writer.ts:331-343 hand-rolled tmp+rename without fsync.

### P3 — Stale docs/claims
Evidence: substrate.ts:12 lists 3 adapters "land in this codebase" but gpt adapters are production-unwired; platform-adapter.ts:20-25 references a nonexistent file; spawn.ts:62-64 references a never-landed S2; `tenant`-family vocabulary appears in runtime as `internal_handle` (platform-adapter.ts ×11, platform-adapter-local.ts ×3, slug-grammar.ts ×3, slug-picker-types.ts ×1) — the declared repo-wide rename lands here too.

### P3 — Barrel-exported but near-unconsumed modules
Evidence: `tool-loop-detection.ts` — exported from index.ts:33-41; only external reference is a *comment* in channels/adapters/telegram/sync-message-filter.ts:36. Actual consumer status: none in production paths found outside runtime (verify against adapters before deleting — adapters were out of scope here). `platform-hints` is consumed only via system-prompt.ts internally.

## 10. Test posture

Strong for pure logic: 575 tests / 27 files pass in 6.2s, hermetic (injected now/pid_alive/verify_delegation/sinks). Notable suites: subagent watchdog/spawn-guard/turn-progress (heavily scenario-tested, incident-derived), entity-writer roundtrip byte-stability, doc-links Expo-mirror parity, platform-adapter-split. Untested here: the actual credential threading end-to-end (lives in gateway tests), registry persistence across restart (feature doesn't exist), `LocalPlatformAdapter`'s OAuth handshake side effects (child-process execFile paths). No flake indicators in this slice (the known PGLite boot flake is gbrain-memory's, not runtime's).

## 11. Load-bearing subtleties a refactor must not break

1. **`selectCredential` mutates; `hasUsableCredential` must stay pure.** Probing availability via `selectCredential` inflates `use_count` and advances the round-robin cursor, corrupting `least_used`/`round_robin` fairness — the memoizer depends on the pure probe (credential-pool.ts:108-124).
2. **`reportSuccess` clears cooldown AND resets `consecutive_failures`** (credential-pool.ts:248-254); `retry_after_ms` overrides the 429 TTL (credential-pool.ts:227-229). Cooldown attribution (`cooldown_reason`) feeds observability.
3. **spawn.ts ordering is a security/concurrency invariant**: authorize → (single await) → guard read → synchronous create. Moving any `await` between the `liveByKey` read and `registry.create` reintroduces the double-spawn TOCTOU; moving the guard before authorization lets a replayed spawn_key coalesce onto a record it never proved it owns (spawn.ts:103-175). The child-cap check must stay AFTER the guard so a coalescing retry isn't cap-blocked (spawn.ts:148-152, 179-188).
4. **`failRun` re-reads status after awaiting the canceller** so a concurrent legitimate completion is never clobbered to `crashed` (control.ts:88-101). The watchdog relies on `failRun`'s `false` return to avoid double-surfacing (watchdog.ts:175-176).
5. **Watchdog precedence**: `process_dead` beats `stuck`; a JSONL turn-progress probe result is AUTHORITATIVE over `last_event_at` (heartbeats lie), but a `null` probe falls back rather than false-flagging (watchdog.ts:155-171). `registry.update` defaults `last_event_at` to now() unless explicitly patched (registry.ts:104-114) — which is exactly why the probe exists.
6. **entity-writer idempotence gate**: byte-identical re-render skips the write AND the syncHook ("0 add calls on byte-identical re-write" acceptance, entity-writer.ts:165-171, 318-327). Triples come from compiled-truth ONLY (not timeline) and `removedLinks` is diffed pre-commit — reordering the diff after the write makes it unreconstructible (entity-writer.ts:295-317, 349).
7. **Renderer determinism**: sorted YAML keys, exact separator bytes, newest-first timeline, `(ts,source,body)` dedupe (entity-writer.ts:505-525, 689-709) — downstream parity/roundtrip tests byte-compare.
8. **`Substrate.start` must return synchronously** (must not block on first byte, substrate.ts:127-131); only `token` events may be coalesced; `iterator.return()` must propagate to `cancel()` (events.ts:8-11, session-handle.ts:13-15).
9. **`BEST_MODEL` const is the fresh-install seed; live spawns must resolve `getBestModel()`** — the opus-4-7 retirement incident is encoded in models.ts:45-52; collapsing the accessor back to the const rots into a zero-token hang on model retirement.
10. **`turn_timeout_ms` is an inactivity window, not a wall clock** (substrate.ts:75-85; PR #164 memory). Renaming/renumbering it without preserving idle-reset semantics breaks long tool-heavy turns.
11. **doc-links has a byte-parity twin** in app/lib/doc-links.ts enforced by runtime/__tests__/doc-links-parity.test.ts — change both or the app's inbound deep-link parse diverges.
12. **`'ambient'` credential kind means thread NO token** so the spawned `claude` child uses its own Keychain auth (credential-pool.ts:30-36) — an env-threading "fix" that always exports a token breaks Open single-owner installs.

## 12. What the refactor should do here

1. **Split the package along its real fault lines**: `runtime-substrate` (substrate/session-handle/events/credential-pool/models/model-pricing + a new credential-rotating dispatcher decorator extracted from gateway's two wrappers), `platform` (platform-adapter* + Managed-split structural types + slug/token helpers), move entity-writer/auto-link/entity-slug to the memory layer (its only consumers), doc-links to a channels-shared leaf, subagent/ to sit beside agent-dispatch (its only real consumer). Keep tiny leaves (atomic-write, constant-time-equal) in a named `util` leaf rather than "runtime".
2. **Make package boundaries real**: declare workspace deps, import via package specifiers, regenerate barrels to match actual consumption, and add a lint (the planned check-open-purity style) that forbids `../<other-workspace>/` relative imports.
3. **Fix the one true inversion**: remove `onboarding/interview/phase.ts` from runtime's import graph (move the conversational-flag parser to onboarding or genericize the phase type).
4. **Shrink `PlatformAdapter`**: Open code depends on `OpenPlatformAdapter`; the Managed extension becomes a separate optional interface supplied by composition; delete stale references to the nonexistent managed adapter file.
5. **Delete or wire the dead paths** (no behavior change either way in production): delegation-token verification, `AgentSpec.session` on the CC path docs, `allowPersistOrigins`, `STALE_THRESHOLD_MS`, tool-loop-detection (after confirming adapters don't use it).
6. **Do NOT touch semantics** of: credential cooldown math, spawn-guard ordering, failRun/watchdog race handling, entity-writer render/diff/hook ordering, AgentSpec timeout semantics, getBestModel indirection — each is incident-derived (see §11).
