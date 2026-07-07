# Subsystem map: cores-platform

Paths: `core-sdk/`, `cores/sdk/`, `cores/runtime/`, `mcp/`, `tools/` (+ the bundled Cores in `cores/free/` and, as the primary consumer, `gateway/cores/install-bundled.ts`, cited where the contract is actually enforced).

All file:line references are relative to `/Users/ryan/repos/neutron-open`.

---

## 1. Purpose & responsibilities

This subsystem is Neutron's plugin ("Core") platform:

- **Manifest contract** — the `"neutron"` block in a Core's `package.json`: capabilities, tools, UI surfaces, secrets, billing, linked sources (`core-sdk/types.ts`, `cores/sdk/manifest.ts`).
- **Install lifecycle** — load/validate a Core dir, allocate its data namespace (shared-DB table prefix or sidecar SQLite), drive secret prompts, record installation, upgrade with capability-escalation consent, uninstall with cleanup (`cores/runtime/lifecycle.ts`, `loader.ts`, `data-namespace.ts`, `installations-store.ts`).
- **Capability gating + audit** — `CapabilityGuard` (`cores/runtime/capability-guard.ts`), the capability-gated `SecretsAccessor` (`cores/sdk/secrets.ts`), and the `secret_audit_log` writer (`cores/runtime/secret-audit.ts`).
- **Tool runtime** — the single per-process `ToolRegistry` + HITL `ApprovalManager` + `ProcessRegistry` (`tools/`), fronted by the per-instance `McpServer` (`mcp/server.ts`), which is exposed to the spawned `claude` REPL through the stdio `tools-bridge` (`runtime/adapters/claude-code/persistent/tools-bridge.ts`).
- **9 bundled free Cores** (`cores/free/`: research, scraping, tasks, calendar, agent-settings, google-workspace, reminders, email, code-gen) discovered at boot by `cores/runtime/bundled-registry.ts` and installed by `gateway/cores/install-bundled.ts`.

## 2. Module inventory (wc -l)

| File | LOC | Role |
|---|---|---|
| `cores/runtime/lifecycle.ts` | 751 | install/upgrade/uninstall + secrets driver |
| `core-sdk/validator.ts` | 650 | hand-written manifest validator (**prod-dead**, see §6.2) |
| `cores/sdk/auth.ts` | 472 | platform-JWT validator for external Cores (**prod-dead**) |
| `cores/sdk/secrets.ts` | 439 | capability-gated SecretsAccessor (live) |
| `cores/runtime/secret-audit.ts` | 382 | audit log + audited-store wrapper (live) |
| `cores/runtime/installations-store.ts` | 377 | `core_installations` + global installs (live) |
| `cores/runtime/data-namespace.ts` | 377 | table-prefix / sidecar allocator (live; `runScopedSql`/`checkSqlNamespace` test-only) |
| `cores/sdk/manifest.ts` | 363 | Zod manifest schema — the **actual** production validator |
| `cores/runtime/bundled-registry.ts` | 304 | multi-root bundled-Core discovery |
| `cores/runtime/loader.ts` | 268 | dir → validated `LoadedCore` |
| `core-sdk/types.ts` | 240 | closed `NeutronCapability` union + manifest types |
| `tools/approval.ts` | 223 | HITL approval state machine (**never invoked from dispatch**, §6.1) |
| `cores/sdk/route.ts` | 222 | Hono `mountCoreRoutes` (**prod-dead**) |
| `cores/runtime/capability-guard.ts` | 178 | per-dispatch guard + audit (used only *inside* Cores) |
| `cores/sdk/reconcile.ts` | 166 | reconciliation guard (**prod-dead**) |
| `core-sdk/_schema-runner.ts` | 148 | mini JSON-Schema runner, test-only by design |
| `cores/sdk/connector.ts` | 145 | Connector interface (**prod-dead**) |
| `mcp/server.ts` | 136 | per-instance tool multiplexer/dispatcher |
| `tools/process-registry.ts` | 134 | subprocess bookkeeping (consumed by `watchdog/`) |
| `cores/sdk/index.ts` | 122 | barrel |
| `tools/registry.ts` | 112 | the one-per-process `ToolRegistry` |
| `mcp/surfaces/channel-tools.ts` | 100 | channel_send/ack tools (**never registered in prod**) |
| `mcp/surfaces/neutron-tools.ts` | 80 | 13 Hermes-lift stubs, all `agent_hidden`, handlers永-stub |
| `mcp/surfaces/core-tools.ts` | 50 | `<core_id>:` prefixed registration helper (**never called**) |
| `mcp/topic-context.ts` | 45 | AsyncLocalStorage topic frame |
| Bundled cores | ~90–260 each (barrels) + `src/` | e.g. research `src/` has 20 files |

Related but outside the declared paths: `gateway/cores/install-bundled.ts` (1,044 LOC) — the install/registration orchestrator where most of the real contract enforcement (and its gaps) lives; `runtime/adapters/claude-code/persistent/tools-bridge.ts` (202 LOC) — the stdio MCP transport.

## 3. Public seams / contracts consumed by other subsystems

1. **`ToolRegistry` + `ToolRegistration`** (`tools/registry.ts:52-112`) — THE tool seam. One instance per gateway boot (`gateway/composition/build-core-modules.ts`), registered into by at least 8 non-Core packages: `work-board/agent-tool.ts`, `gbrain-memory/agent-tool.ts`, `doc-search/tool.ts`, `message-search/tool.ts`, `skill-forge/tool.ts`, `agent-dispatch/tool.ts`, `trident/codex-credential-tool.ts`, `reminders/dispatcher.ts`.
2. **`McpServer`** (`mcp/server.ts:34`) — `dispatch()` (invocation) + `listToolSchemas()` (discovery). Constructed once at `gateway/composition/build-core-modules.ts:253`; handed to the persistent REPL substrate as the process-global `ReplToolBridge` (`persistent-repl-substrate.ts:917-929`, set by the `repl-tool-bridge` module at build-core-modules.ts:265-280).
3. **Manifest schema** — `parseManifest`/`NeutronManifestSchema` (`cores/sdk/manifest.ts:305-363`), consumed by `cores/runtime/loader.ts:179` and by every bundled Core's own `src/manifest.ts`.
4. **`NeutronCapability`** closed union (`core-sdk/types.ts:139-161`) — the *type* of `ToolRegistration.capability_required` (`tools/registry.ts:57`), imported by every tool-registering package.
5. **Install lifecycle** — `installCore` / `upgradeCore` / `uninstallCore` (`cores/runtime/lifecycle.ts:133,647,518`), consumed by `gateway/cores/install-bundled.ts:175`.
6. **`CapabilityGuard`** (`cores/runtime/capability-guard.ts:63`) — consumed by all 9 bundled Cores inside their own `buildTools` (e.g. `cores/free/tasks/src/tools.ts:127`).
7. **`SecretsAccessor`** (`cores/sdk/secrets.ts:87,229`) — capability-gated secret reads; built at install time (`lifecycle.ts:209`) and again by the gateway (`install-bundled.ts:710`).
8. **Implicit, undocumented-in-SDK seam:** every bundled Core's barrel must export `buildTools(deps)` and optionally `buildExtraTools(deps)`; the gateway dynamic-imports `package.json#main` and duck-types these (`install-bundled.ts:765-802`). **This convention appears in no SDK type** — see §6.3.
9. **stdio transport contract** — the per-session tools manifest file (`TOOLS_MANIFEST_PATH`, snapshot of `listToolSchemas()`) + `/tool-call` POST to the reply sink (`tools-bridge.ts:29-41`, `persistent-repl-substrate.ts:1600-1645`).

## 4. Workspace dependencies

**Declared (package.json):**
- `tools` → `@neutronai/core-sdk`, `@neutronai/persistence`
- `mcp` → `@neutronai/core-sdk`, `@neutronai/tools`, `@neutronai/channels`, `@neutronai/runtime`
- `cores/runtime` → `@neutronai/cores-sdk`, `zod`
- `cores/sdk` → `hono`, `jose`, `zod` (no workspace deps)
- `core-sdk` → none

**Actual imports (what matters):**
- Almost all cross-package imports are **relative paths**, not package specifiers: `tools/registry.ts:34` imports `../core-sdk/types.ts`; `mcp/server.ts:13-15` imports `../tools/registry.ts` and — a layering inversion — `../runtime/adapters/gpt-5-5-api/mcp-shim.ts` (type-only); `mcp/surfaces/channel-tools.ts:11` imports `../../channels/router.ts`; `cores/runtime/lifecycle.ts:48-49` imports `../../auth/secrets-store.ts` and `../../persistence/index.ts` (neither declared in its package.json).
- Bundled Cores reach far outside the plugin sandbox via 4-deep relative imports: `cores/free/agent-settings/src/backend.ts:42` → `onboarding/interview/final-handoff-config.ts`; `agent-settings/src/tools.ts:38` and `backend.ts:47` → `connect/agent-engagement.ts` (the dormant federation layer); research/tasks/reminders → `persistence/`, `runtime/models.ts`, `migrations/runner.ts`; tasks → `@neutronai/tasks` substrate.

**Consumers of this subsystem:** `gateway/composition/*`, `gateway/cores/*` (1,044-line orchestrator + OAuth wiring), `runtime/adapters/claude-code/persistent/*` (tools-bridge + ReplToolBridge), `watchdog/detectors.ts` (ProcessRegistry), the 8 tool-registering packages listed in §3.1.

## 5. Internal layering (as-built)

```
core-sdk (types + prod-dead validator)      cores/sdk (Zod manifest + secrets accessor + prod-dead auth/route/reconcile/connector)
        \                                        |
         \                              cores/runtime (loader, lifecycle, namespace, guard, audit, bundled-registry)
          \                                      |
   tools (ToolRegistry, Approval, ProcessReg)    |            cores/free/* (9 Cores; self-guarded buildTools)
            \                                    |                     |
             mcp (McpServer + 3 surfaces) <──────┴── gateway/cores/install-bundled.ts (dyn-import buildTools → registry.register)
              |
   runtime persistent REPL substrate (ReplToolBridge global + spawn-time manifest snapshot + /tool-call sink)
              |
   tools-bridge.ts child process (stdio MCP) → spawned `claude` sees mcp__neutron__<tool>
```

Tool flow to the agent (the native-MCP transport): at REPL spawn, if `enableToolBridge` and the global `ReplToolBridge` is set and ≥1 tool is visible, the substrate snapshots `listToolSchemas()` (minus `agent_hidden`) to a JSON manifest file and adds a second `mcpServers` entry running `tools-bridge.ts` (`persistent-repl-substrate.ts:1614-1645`). The bridge serves ListTools from the file snapshot and forwards CallTool as a single un-retried POST to the sink's `/tool-call` (`tools-bridge.ts:110-154,159-178`), which dispatches on the in-process `McpServer` (`persistent-repl-substrate.ts:1040-1060`).

## 6. Architectural debt

### 6.1 [P1] The platform-level capability gate and the entire HITL approval system are inert at dispatch time

The advertised contract ("capability gate on every tool call", `SDK-CONTRACT.md` "The platform refuses to dispatch a tool whose capability_required isn't in capabilities[]") is **not enforced by the platform**:

- `McpServer.capability_gate` defaults to always-allow (`mcp/server.ts:42`: `?? (() => true)`), and production constructs it **without** a gate (`gateway/composition/build-core-modules.ts:253`). The dispatch check at `mcp/server.ts:72` therefore never denies anything.
- `ApprovalManager` is built as a graph module (`build-core-modules.ts:232-236`) but **no dispatch path ever calls `requestApproval`** (grep: only `tools/approval.ts` + its test). `McpServer.dispatch` (`mcp/server.ts:67-84`) never reads `approval_policy`. Consequently `agent-dispatch/tool.ts:97`, `skill-forge/tool.ts:163`, and `trident/codex-credential-tool.ts:92` declare `approval_policy: 'prompt-user'` and are executed with no human in the loop, identically to `'auto'`.
- Actual capability enforcement is **voluntary self-policing**: each bundled Core wraps its own handlers in a `CapabilityGuard` built from *its own* manifest (all 9 do — e.g. `cores/free/tasks/src/tools.ts:127`). A third-party Core that skips the wrapper gets un-gated, un-audited dispatch. `CapabilityGuard` has zero call sites in `gateway/` or `mcp/`.
- The one live protection is coarse: `agent_hidden` filtering on discovery (`mcp/server.ts:99-104`) and the spawn-time `--tools` surface (`persistent-repl-substrate.ts:1650+`) — but `dispatch()` will happily execute an `agent_hidden` tool if named.

**Refactor sketch:** move `CapabilityGuard.assertOrDeny` + approval-policy consultation into `McpServer.dispatch` (single choke point), keyed by a `calling_core_id`/installation lookup, and delete the per-Core self-wrapping (or keep it as defense-in-depth but stop treating it as the enforcement layer). This must preserve the audit-row shapes (`op='tool_call'`, outcomes `ok|error|capability_denied`) that `secret_audit_log` consumers expect.

### 6.2 [P1] Two parallel manifest contracts; the closed capability union is a fiction

- `core-sdk/` (types + 650-line hand validator + `manifest.schema.json` + `_schema-runner.ts`) and `cores/sdk/manifest.ts` (Zod) define the same manifest **twice**, kept "shape-compatible" only by comment discipline (`cores/sdk/manifest.ts:17-31`, "The two MUST stay shape-compatible") and by mirrored-comment edits in 4 places (`core-sdk/types.ts:121-128`).
- `validateNeutronManifest` has **zero production call sites** — only `core-sdk/validator.test.ts` (grep §evidence). The install pipeline it was written for uses the Zod schema exclusively (`cores/runtime/loader.ts:179`). ~1,400 LOC (validator + schema + runner + tests) exist to validate against an enum the runtime doesn't check.
- The closed `NeutronCapability` union is defeated where it matters: `gateway/cores/install-bundled.ts:935` and `:974` cast arbitrary manifest strings (`read:tasks_core.db`, `read:calendar_core.events`) `as NeutronCapability` because "the ToolRegistry gates on string equality, not on the union" (comment at 926-934). So the type on `tools/registry.ts:57` documents an invariant no runtime path enforces.

**Refactor sketch:** collapse to ONE manifest module (the Zod one) exporting both the schema and inferred types; keep a *derived* JSON-schema artifact if npm-side tooling needs it (generated, not hand-mirrored); replace `NeutronCapability` on `ToolRegistration` with the validated `Capability` string type + an explicit known-platform-capabilities set used by the (newly real) dispatch gate.

### 6.3 [P1] The Core→runtime tool-handler contract is implicit duck-typing in the gateway, and its failure mode is silent

This is the enforcement gap behind STATUS.md ISSUE #330 (notes Core: manifest declared 8 tools, install ran only `buildTools` (4), the other 4 fell to `not_implemented` stubs — logged, booted green, broken at first use):

- `buildTools`/`buildExtraTools` are discovered by dynamic import + `typeof mod.buildTools !== 'function'` checks (`gateway/cores/install-bundled.ts:765-802`). Nothing in `cores/sdk` declares this export shape; the split into two factories exists only for construction-compat reasons (comment at 754-764, "Argus r1 BLOCKER #2").
- `deps` is an untyped `Record<string, unknown>` and the backend lands under a **per-slug key table hardcoded in the gateway** (`BACKEND_KEY_BY_SLUG`, `install-bundled.ts:1024-1035`, including `dtc_analytics` which doesn't exist in this repo) plus a heuristic `normalizeBackend` that sniffs for `backend|store|client|orchestrator|summarizer` keys (`:1005-1015`). Adding a Core requires editing the gateway — the abstraction leaks in the wrong direction.
- Manifest-declared tools with no handler register as throw-stubs and only *log* `manifest_tool_unimplemented` (`install-bundled.ts:892-905`); `registerNotImplementedStubs` **silently swallows** name collisions (`:982-985`). Install still reports `install_ok`, `/api/cores` advertises the tool, and the agent discovers a tool that always fails.

**Refactor sketch:** make the Core entry-point contract explicit in `cores/sdk` — e.g. `defineCore({ manifest, createTools(deps: TypedDeps): Record<ToolName, Handler> })` with a single factory, a typed deps bag, and a declared backend key. At install, `manifest.tools[] ⊆ keys(built)` becomes a hard install failure (or at minimum flips `install_state` to `degraded` surfaced in `/api/cores`), not a log line.

### 6.4 [P1] `uninstallCore` deletes secrets it does not own

`cores/runtime/lifecycle.ts:560-615`: the uninstall path lists **every** secret row for the project and deletes each row whose `kind` is one of the 4 managed kinds — there is **no per-Core label filter**, despite the comment at 561-567 claiming "we only delete rows whose (kind, label) match the snapshot we'd have audited". Uninstalling Core A deletes Core B's `oauth_token`/`byo_api_key` rows (and the owner-level ones written by `gateway/cores/oauth-token-manager.ts`). Not currently user-triggerable (no uninstall surface is wired in Open), which is why it hasn't bitten — but any refactor that wires uninstall will detonate it. Behavior-preserving refactor should still record this as a landmine and fix it as an explicit, tested behavior change.

### 6.5 [P2] Dead / speculative code (see also §8)

~1,000 LOC of `cores/sdk` (auth.ts 472, route.ts 222, reconcile.ts 166, connector.ts 145) has no consumer outside its own tests and barrel — built for a first-party "Topline dtc-analytics" Core that is not in this repo (`cores/sdk/manifest.ts:5-8`). `cores/sdk/auth.ts` additionally overlaps the live `jwt-validator/` workspace (both wrap jose + JWKS caching; `runtime/connect-handlers.ts:21` uses `jwt-validator`, nothing uses `cores/sdk/auth.ts`). `mcp/surfaces/neutron-tools.ts` registers 13 permanently-stubbed, `agent_hidden` Hermes tools at every boot (`build-core-modules.ts:156`); `mcp/surfaces/core-tools.ts` (`<core_id>:` prefixing — a namespacing convention `install-bundled.ts` does NOT use, registering unprefixed names instead) and `mcp/surfaces/channel-tools.ts` are exported but never called in production.

### 6.6 [P2] Package seams are decorative; `mcp` depends upward on `runtime`

Every package boundary is crossed by relative imports (§4), so `bun` workspace boundaries enforce nothing. Worst case: `mcp/server.ts:15` imports the `McpToolResolver` type from `runtime/adapters/gpt-5-5-api/mcp-shim.ts` — the tool layer depending on a specific substrate adapter (and `mcp/package.json` accordingly declares a dependency on all of `@neutronai/runtime`). The resolver type should live in `mcp` (or a shared contract package) with the adapter depending on it, not vice versa. Similarly `cores/runtime` silently depends on `auth/` and `persistence/` without declaring them.

### 6.7 [P2] Bundled Cores are not actually "third-party shaped"

`bundled-registry.ts:34-36` claims "the shape mirrors third-party Cores byte-for-byte", but Cores import `onboarding/`, `connect/`, `runtime/models.ts`, `persistence/`, `migrations/` via `../../../../` paths (§4). A real npm-installed Core cannot do any of that, so the bundled Cores do not exercise the contract third-party authors will face; the SDK's sufficiency is untested by its own flagship consumers.

### 6.8 [P2/P3] Assorted duplication

- Two distinct `CapabilityDeniedError` classes with different shapes: `cores/sdk/secrets.ts:63` (message + optional code) vs `cores/runtime/errors.ts:56` (code + core_id + tool context). Callers must know which layer threw.
- `persistOrRotate` list-then-rotate logic duplicated between `cores/runtime/lifecycle.ts:441-482` and `cores/sdk/secrets.ts` `put()` (:246-320), each with its own race handling.
- `installCore` is re-implemented (secrets-accessor build included) inside `gateway/cores/install-bundled.ts:700-724` alongside importing the lifecycle version.
- Three AS-BUILT changelogs referencing this subsystem (already-declared repo-wide debt).

## 7. Test posture

- `bun test core-sdk cores/sdk cores/runtime mcp tools` → **440 pass / 0 fail, 33 files, ~16.5s** (run 2026-07-02). Bundled Cores add 67 test files under `cores/free/*/__tests__`; `gateway/cores/__tests__` covers the orchestrator (10 files); integration coverage in `tests/integration/sprint-31-cores-runtime.test.ts` (guard + namespace) and `mcp/gbrain-search-bridge.test.ts` / `runtime/.../tool-bridge.test.ts` (discovery+dispatch seam).
- Character: strong, deterministic unit coverage of validators, lifecycle state machines, registry semantics; injectable clocks; no external services.
- Gaps: (1) nothing tests the **production wiring** of the capability gate — the only gate test injects one (`mcp/server.test.ts:62`); (2) no test spawns the actual `tools-bridge.ts` child process over stdio (tests stop at the `McpServer` seam); (3) no test asserts manifest-tools ⊆ built-handlers fails install (only that stubs get logged) — exactly the ISSUE #330 class; (4) approval flow tested in isolation but its dispatch integration cannot be tested because it doesn't exist; (5) `core-sdk/validator.test.ts` (622 lines) locks a three-source parity (TS union / KNOWN_CAPABILITIES / manifest.schema.json) for a validator production never runs. Flake risk: low in this subsystem (the known PGLite boot flake lives in gbrain tests, not here).

## 8. Dead / legacy code candidates (evidence)

1. `core-sdk/validator.ts` + `core-sdk/manifest.schema.json` + `core-sdk/_schema-runner.ts` — `validateNeutronManifest` has no callers outside `core-sdk/validator.test.ts`; production validation is `cores/runtime/loader.ts:179` → Zod.
2. `cores/sdk/auth.ts` (472) — no importer outside own test; live JWT path is `jwt-validator/` (`runtime/connect-handlers.ts:21`).
3. `cores/sdk/route.ts` (`mountCoreRoutes`) — callers: barrel + `cores/sdk/__tests__/route.test.ts` only; no Core ships a `route_mount` surface.
4. `cores/sdk/reconcile.ts`, `cores/sdk/connector.ts` — barrel + own tests only; built for the absent dtc-analytics Core.
5. `mcp/surfaces/core-tools.ts` (`registerCoreTool`/`unregisterCoreTools`) — exported from `mcp/index.ts:21-24`, called nowhere; its `<core_id>:` prefix convention conflicts with the unprefixed names `install-bundled.ts` actually registers.
6. `mcp/surfaces/channel-tools.ts` (`registerChannelToolsSurface`) — called only from `mcp/surfaces.test.ts`.
7. `mcp/surfaces/neutron-tools.ts` — 13 stubs registered at every boot (`build-core-modules.ts:156`), all `agent_hidden`, handlers deferred to a "P3" that shipped a different way (per-Core tools).
8. `cores/runtime/data-namespace.ts:228-339` (`checkSqlNamespace`, `runScopedSql`, `openSidecar` scoping) — exercised only by `tests/integration/sprint-31-cores-runtime.test.ts`; no production SQL path routes through the namespace check.
9. `install-bundled.ts:1033` `dtc_analytics` entry in `BACKEND_KEY_BY_SLUG` — Core not in repo.
10. Global-install scope (`installCoreGlobally`, `core_global_installations`, `lifecycle.ts:232-312`) — wired types + store, but verify UI/API consumers before deleting; likely partially-landed WAVE 3.

## 9. Load-bearing subtleties a refactor must NOT break

1. **Spawn-time tool-manifest snapshot** — the agent's tool list is frozen when the REPL spawns (`persistent-repl-substrate.ts:1628-1631`); tools registered later are invisible until respawn. The registry must be fully populated (all Cores installed) *before* the `repl-tool-bridge` module points the global at the McpServer (`build-core-modules.ts:265-280` deps ordering). Also: **zero visible tools ⇒ no bridge server at all** (`schemas.length > 0` gate, :1629).
2. **Single-POST, no-retry tool calls** — `tools-bridge.ts:159-167` deliberately diverges from the dev-channel's retried `/reply` because tool calls are non-idempotent; adding a "robust" retry would double-execute write tools.
3. **`agent_hidden` filters discovery only** — `listToolSchemas` (`mcp/server.ts:99-104`), not `dispatch`. Making dispatch reject hidden tools changes behavior (tests dispatch hidden stubs).
4. **`approval_policy: 'auto'` short-circuits without persistence** (`tools/approval.ts:97-99`); wiring approvals into dispatch must keep 'auto' zero-cost and must not suddenly enforce 'prompt-user' on `dispatch_agent`/`skill_forge` without a product decision — today those run ungated (§6.1).
5. **Required-secret Cores fail install BY DESIGN under the Noop prompter** — calendar/email/google-workspace land in `install_state:'failed'`/`manifest_invalid` and are later healed via the connectors UI + OAuth wiring (`install-bundled.ts:12-21`); "fixing" these boot failures alters product behavior. The >50% failure ratio hard-fail gate (`:23-28,117`) is likewise load-bearing.
6. **Boot idempotency via `duplicate_install` catch** — same-version reinstall on every boot is caught and the existing row reloaded (`install-bundled.ts:169-180`); a stricter lifecycle would brick restarts.
7. **`packageNameToSlug` normalization** (`loader.ts:61-81`) is a persistence contract: slugs key `core_installations`, sidecar filenames (`<dataDir>/cores/<slug>.db`), table prefixes, and the `BACKEND_KEY_BY_SLUG` map. Changing normalization orphans data.
8. **`decideDataLayout` exact-slug match** (`data-namespace.ts:55-70`) — `read:<other>.db` must NOT grant a sidecar; and layout change on upgrade is a hard reject (`lifecycle.ts:672-682`).
9. **Bundled-registry ordering + precedence** — cross-root duplicate: first root wins with buffered telemetry flush only on clean root walk; same-root duplicate: throw (`bundled-registry.ts:183-283`); one-level container recursion + full-path lexicographic sort (`loader.ts:231-268`) keep boot deterministic.
10. **`internal_handle === project_slug` assumption** — secrets rows are keyed on the frozen handle; the lifecycle passes `project_slug` and documents the equivalence for fresh installs (`lifecycle.ts:212-218`, `persistOrRotate` comment :443-450). Renames break silently if a refactor "cleans up" the naming without threading the frozen handle.
11. **Capability strings are open-shaped on purpose** — Cores declare `read:<slug>.db` etc. that the closed union doesn't contain; the `as NeutronCapability` casts (`install-bundled.ts:935,974`) are what make bundled Cores dispatchable. Tightening validation to the closed enum bricks every bundled Core.
12. **Topic context is fail-soft to system scope** — warm-REPL tool calls dispatch with `topic_id: null` (documented Codex r1 P2, `persistent-repl-substrate.ts:1023-1036`; `mcp/server.ts:117-136`); `call_id` from the bridge is `SESSION_ID:toolName`, NOT unique per call (`tools-bridge.ts:118`) — nothing may assume call_id uniqueness.
13. **`wrapHandler` drops `ToolCallContext`** for Core tools (`install-bundled.ts:957-964`) — Core handlers see only `args`. Threading ctx through is desirable but is an interface change to every Core's handler signature.
14. **ToolRegistry collision semantics differ by path**: direct `register` throws loud (`tools/registry.ts:83-88`); Core registration catches and drops the later tool with a log (`install-bundled.ts:939-949`); stub registration swallows silently (`:982-985`).
15. **Tool errors return HTTP 200 `ok:false`** through the sink so the model receives an `isError` tool_result rather than an HTTP fault (`persistent-repl-substrate.ts:1057-1062`); manifest-load failure in the bridge degrades to an empty tool list, never a crash (`tools-bridge.ts:63-80`).

## 10. What the refactor should do here

1. **Unify the manifest contract** (one Zod source of truth in `cores/sdk`; delete `core-sdk/validator.ts` + schema mirror + runner after confirming no external tooling reads `manifest.schema.json`; keep `core-sdk` as a thin re-export or fold it into `cores/sdk` entirely). This alone removes the "MUST stay shape-compatible" comment-discipline hazard.
2. **Make enforcement platform-side**: capability check + approval-policy consultation inside `McpServer.dispatch` as the single choke point, fed by installation records; keep audit-row shapes stable. Delete or demote per-Core self-guarding.
3. **Formalize the Core entry-point** (`defineCore` with a typed single factory + declared backend key), move `BACKEND_KEY_BY_SLUG`/`normalizeBackend` knowledge out of the gateway, and hard-fail (or surface as `degraded`) when manifest tools lack handlers.
4. **Excise dead SDK modules** (auth/route/reconcile/connector, core-tools/channel-tools surfaces, neutron-tools stubs) before third-party authors arrive — every dead export is API surface you'll have to deprecate publicly later.
5. **Make package boundaries real** for at least `cores/sdk` (the future npm package): no relative escapes, declared deps only, and a bundled Core (pick tasks or scraping) that compiles against the published SDK shape as a contract test.
6. **Fix the uninstall secret-deletion scoping** (§6.4) as a called-out, tested exception to "no functionality change".
