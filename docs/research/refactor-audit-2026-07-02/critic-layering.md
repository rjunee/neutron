# Layering Critic — Neutron Open Architecture Audit

Dimension: **layering / dependency structure**. Date: 2026-07-02.
Method: a custom scanner (`depgraph.ts`, in this directory) walked all 1,745 non-`node_modules` TS/TSX/MJS source files, extracted every import/export-from/dynamic-import/require specifier, resolved relative specifiers to their target top-level module and package specifiers via each workspace's `package.json` name, and emitted a module-level edge list (`edge-table.md`, per-file detail in `edges-perfile.json`). "Module" = each of the 40 declared workspaces plus the floating source dirs (`open/`, `tabs/`, `work-board/`, `project-credentials/`, `tests/`, `scripts/`). Test files (`__tests__/`, `*.test.ts`, `tests/`, fixtures) are excluded from all production numbers below. Every load-bearing claim was then re-verified by reading the cited file.

Caveat on labels: the scanner's `type-only` classification is a heuristic on the import statement text; every edge used as evidence below was eyeballed in source (one known scanner mislabel is corrected inline: `gateway → open` is a **value** import).

---

## 1. Headline numbers

| Metric | Value |
|---|---|
| Production cross-module import statements | **910** |
| … via relative paths that escape the workspace (`../<other-workspace>/…`) | **795 (87%)** |
| … via package specifiers (`@neutronai/*`, `@neutron/*`) | 115 (13%) |
| Distinct module→module production edges | 175 |
| Modules in the single largest strongly-connected component | **28 of ~44** |
| Module-edges whose removal turns the whole graph into a DAG | **11** |
| dependency-cruiser configs / invocations in repo | **0 / 0** (devDep `dependency-cruiser@17.4.3` at package.json:57 is dead) |
| Source dirs consumed cross-module with **no package.json at all** | 4 (`open/`, `work-board/`, `tabs/`, `project-credentials/`) |

The architecture documentation (README.md:241-266) describes five layers. The measured graph contains **no layering at all**: one giant cycle containing the substrate, the composition root, the product surfaces, the memory layer, the plugin platform, most bundled Cores, and the dormant federation package.

---

## 2. The strongly-connected component (the "no layers" proof)

Tarjan SCC over the 175 production edges yields ONE non-trivial component of 28 modules:

> agent-dispatch, auth, channels, connect, cores/free/{agent-settings, calendar, code-gen, email, google-workspace, reminders, research, scraping, tasks}, cores/runtime, gateway, gbrain-memory, landing, mcp, migrations, onboarding, open, reflection, reminders, runtime, scribe, tasks, trident, watchdog

Direct mutual (2-cycle) pairs: `gateway ↔ onboarding`, `gateway ↔ open`, `gateway ↔ reminders`, `onboarding ↔ runtime`, `onboarding ↔ tasks` (type-level), plus the 3-cycles through `migrations → open → gateway → migrations` and `landing → onboarding → gateway → landing`.

Everything outside the SCC is a leaf or near-leaf: `persistence`, `chat-core`, `core-sdk`, `cores/sdk`, `jwt-validator`, `prompts`, `tools`, `cron`, `doc-search`, `message-search`, `skill-forge`, `work-board`, `project-credentials`, `tabs`, `app`.

### 2.1 The feedback edge set — 11 edges, ~15 files, and the tangle is gone

Cutting exactly these edges (verified by re-running SCC: **zero cycles remain**):

| # | Back-edge | Files (verified) | Kind | Fix shape |
|---|---|---|---|---|
| 1 | runtime → onboarding | `runtime/onboarding-conversational-flag.ts:24` (**value**: `ALL_PHASES`), `runtime/platform-adapter.ts:53`, `runtime/platform-adapter-local.ts:65` (type: `OnboardingPhase`) | value | Move the conversational-flag parser + `OnboardingPhase` into onboarding (or a leaf `phases` module); the flag's only consumer is `platform-adapter-local.ts:64` |
| 2 | onboarding → gateway | `onboarding/wow-moment/actions/03-project-shells.ts:55` (`defaultProjectEmoji`) | value | Move `gateway/projects/default-emoji.ts` to a leaf (it's a pure lookup) |
| 3 | reminders → gateway | `reminders/dispatcher.ts:28` (**value**: `collectTokensToString` from realmode-composer), `reminders/outbound.ts:25` (type: `WebChatSenderRegistry`) | value | Move `collectTokensToString` to a leaf substrate-util; move `outbound.ts` delivery up into gateway (data-memory mapper's proposal) or type the sender registry in a chat-protocol leaf |
| 4 | reminders → landing | `reminders/outbound.ts:24` (type: `ChatOutbound`) | type | Falls out of the chat-protocol extraction (§5) |
| 5 | migrations → open | `migrations/runner.ts:6` (**value**: `resolveOpenDbPath`) | value | Move `resolveOpenDbPath` out of `open/owner-identity.ts` into migrations or a tiny paths leaf |
| 6 | gateway → open | `gateway/cores/mount-open-cores.ts:48` (**value**: `buildOpenAgentProfileBackend`) — scanner mislabeled type-only; it is a value import | value | Inject the agent-profile backend as a parameter from `open/composer.ts:110` (boot-composition mapper agrees) |
| 7 | landing → onboarding | `landing/server.ts:41` (re-export of `MOBILE_APP_URL` from `onboarding/interview/final-handoff-config.ts`) | value | Move the constant to a leaf config module; keep a deprecated re-export during transition |
| 8 | connect → onboarding | `connect/trusted-accept-handler.ts:54` (`issueInviteToken` from `onboarding/api/invite-link-generate.ts`) | value | Move invite-JWT issuance into connect (it is federation code that only accidentally lives in onboarding) |
| 9 | cores/free/agent-settings → onboarding | `cores/free/agent-settings/src/backend.ts:42` (`TELEGRAM_BIND_TOKEN_TTL_MS`) | value | Inject via ToolDeps (the core already injects `AgentProfileBackend`) |
| 10 | tasks → onboarding | `tasks/prioritize-llm.ts:43` (type `LlmCallFn` from `onboarding/interview/phase-spec-resolver.ts`), `tasks/history-import-seeder.ts:18` (types) | type | Move `LlmCallFn` + import-result types to a neutral contracts leaf (also unblocks the engine.ts split) |
| 11 | mcp → runtime | `mcp/server.ts:15` (type `McpToolResolver` from `runtime/adapters/gpt-5-5-api/mcp-shim.ts`) | type | Move `McpToolResolver` into mcp; the adapter imports it downward (runtime-core mapper agrees) |

Edges 10–11 are compile-graph-only (type-erased at runtime) but must go for any package-level build/typecheck ordering to exist. Edges 1, 3, 5, 6, 7, 8, 9 are **value** imports: real runtime coupling.

Every one of these cuts is a constant/type/function *relocation or injection* — no control flow changes. This is the single highest-leverage, lowest-risk move in the whole refactor: ~15 files to edit and the 28-module tangle becomes a clean DAG.

### 2.2 The DAG that emerges (measured, not aspirational)

Longest-path topo levels after the 11 cuts (L0 = imports nothing cross-module):

```
L7  open/                                  ← the real composition root
L6  gateway
L5  onboarding, cores/free/{reminders,tasks}
L4  agent-dispatch, tasks, cores/free/{agent-settings,calendar,code-gen,email,google-workspace,research,scraping}
L3  connect, cores/runtime, mcp, reminders, trident
L2  auth, channels, doc-search, gbrain-memory, landing, message-search, reflection, scribe, skill-forge, watchdog, work-board
L1  app, cron, project-credentials, runtime, tools
L0  chat-core, core-sdk, cores/sdk, jwt-validator, migrations, persistence, prompts, tabs
```

This is the **target layer model**, normalized to five named bands:

1. **Contracts & leaves** — persistence, migrations, chat-core, core-sdk/cores-sdk, jwt-validator, prompts, tabs, *(new)* `contracts/` (chat wire protocol, phases, engagement policy, llm-call types).
2. **Platform** — runtime (substrate + CC adapter + credential pool), cron, tools, channels, auth.
3. **Services & memory** — scribe, gbrain-memory, reflection, doc-search, message-search, reminders, tasks, work-board, trident, agent-dispatch, skill-forge, watchdog, landing (HTTP shell only, after protocol extraction), connect (quarantined behind the dynamic-import seam), cores/runtime, mcp.
4. **Product surfaces** — onboarding, cores/free/*, app (client; depends only on chat-core + contracts).
5. **Composition** — gateway (composition + HTTP surface), open/ (the Open entrypoint). Only this band may import everything.

Note what this says about the README: **gateway is not a "substrate" module — it is the top of the stack** (39 distinct outgoing module deps, including `gateway → onboarding` at 103 import statements, the single fattest edge in the repo). Any layer model that puts gateway mid-stack will be violated by construction.

---

## 3. The full production edge list

(from `edge-table.md`; count = import statements; classification heuristic, see caveat)

| from | to | stmts | kind |
|---|---|---|---|
| agent-dispatch | core-sdk | 1 | type-only |
| agent-dispatch | runtime | 9 | value |
| agent-dispatch | tools | 1 | type-only |
| agent-dispatch | trident | 1 | type-only |
| agent-dispatch | work-board | 1 | value |
| app | chat-core | 8 | value |
| auth | persistence | 2 | type-only |
| auth | runtime | 2 | value |
| channels | persistence | 4 | value |
| channels | runtime | 2 | type-only |
| connect | channels | 3 | type-only |
| connect | gbrain-memory | 1 | value |
| connect | jwt-validator | 5 | type-only |
| connect | onboarding | 1 | value |
| connect | persistence | 9 | type-only |
| connect | runtime | 1 | value |
| cores/free/agent-settings | connect | 2 | value (backend.ts:43 imports `DEFAULT_AGENT_ENGAGEMENT_MODE`, `isAgentEngagementMode`) |
| cores/free/agent-settings | cores/runtime | 1 | type-only |
| cores/free/agent-settings | cores/sdk | 2 | value |
| cores/free/agent-settings | onboarding | 1 | value |
| cores/free/agent-settings | persistence | 1 | type-only |
| cores/free/calendar | cores/runtime | 2 | type-only |
| cores/free/calendar | cores/sdk | 3 | value |
| cores/free/calendar | migrations | 1 | value |
| cores/free/code-gen | cores/runtime | 1 | type-only |
| cores/free/code-gen | cores/sdk | 2 | value |
| cores/free/code-gen | migrations | 1 | value |
| cores/free/email | cores/runtime | 1 | type-only |
| cores/free/email | cores/sdk | 2 | value |
| cores/free/email | migrations | 1 | value |
| cores/free/email | runtime | 2 | type-only |
| cores/free/google-workspace | cores/runtime | 1 | type-only |
| cores/free/google-workspace | cores/sdk | 2 | value |
| cores/free/reminders | cores/runtime | 2 | type-only |
| cores/free/reminders | cores/sdk | 3 | value |
| cores/free/reminders | cron | 1 | value |
| cores/free/reminders | persistence | 1 | type-only |
| cores/free/reminders | reminders | 2 | value |
| cores/free/reminders | tasks | 1 | type-only |
| cores/free/research | cores/runtime | 2 | type-only |
| cores/free/research | cores/sdk | 7 | value |
| cores/free/research | migrations | 1 | value |
| cores/free/research | persistence | 1 | type-only |
| cores/free/research | runtime | 3 | value |
| cores/free/scraping | cores/runtime | 1 | type-only |
| cores/free/scraping | cores/sdk | 3 | value |
| cores/free/tasks | cores/runtime | 2 | type-only |
| cores/free/tasks | cores/sdk | 3 | value |
| cores/free/tasks | persistence | 1 | type-only |
| cores/free/tasks | tasks | 1 | type-only |
| cores/runtime | auth | 1 | type-only |
| cores/runtime | cores/sdk | 5 | value |
| cores/runtime | persistence | 4 | value |
| cron | persistence | 2 | type-only |
| doc-search | core-sdk | 1 | type-only |
| doc-search | tools | 1 | type-only |
| gateway | agent-dispatch | 2 | value |
| gateway | auth | 16 | value |
| gateway | channels | 75 | value |
| gateway | chat-core | 1 | type-only |
| gateway | connect | 10 | value |
| gateway | core-sdk | 3 | type-only |
| gateway | cores/free/agent-settings | 6 | value |
| gateway | cores/free/calendar | 10 | value |
| gateway | cores/free/code-gen | 2 | value |
| gateway | cores/free/email | 10 | value |
| gateway | cores/free/google-workspace | 1 | value |
| gateway | cores/free/reminders | 5 | value |
| gateway | cores/free/research | 5 | value |
| gateway | cores/free/scraping | 1 | value |
| gateway | cores/free/tasks | 3 | value |
| gateway | cores/runtime | 19 | value |
| gateway | cores/sdk | 1 | value |
| gateway | cron | 20 | value |
| gateway | doc-search | 2 | value |
| gateway | gbrain-memory | 4 | value |
| gateway | jwt-validator | 4 | value |
| gateway | landing | 10 | value |
| gateway | mcp | 2 | value |
| gateway | message-search | 3 | value |
| gateway | migrations | 2 | value |
| gateway | onboarding | **103** | value |
| gateway | open | 1 | **value** (scanner mislabel; mount-open-cores.ts:48) |
| gateway | persistence | 34 | value |
| gateway | project-credentials | 3 | value |
| gateway | reminders | 8 | value |
| gateway | runtime | 61 | value |
| gateway | scribe | 3 | type-only |
| gateway | skill-forge | 2 | value |
| gateway | tabs | 1 | value |
| gateway | tasks | 15 | value |
| gateway | tools | 10 | value |
| gateway | trident | 26 | value |
| gateway | watchdog | 5 | value |
| gateway | work-board | 3 | value |
| gbrain-memory | core-sdk | 1 | type-only |
| gbrain-memory | runtime | 2 | type-only |
| gbrain-memory | tools | 1 | type-only |
| landing | chat-core | 4 | value |
| landing | onboarding | 1 | value |
| landing | runtime | 2 | value |
| mcp | channels | 2 | type-only |
| mcp | core-sdk | 1 | type-only |
| mcp | runtime | 1 | type-only |
| mcp | tools | 5 | type-only |
| message-search | chat-core | 1 | value |
| message-search | core-sdk | 1 | type-only |
| message-search | tools | 1 | type-only |
| migrations | open | 1 | value |
| onboarding | channels | 17 | value |
| onboarding | cron | 10 | type-only |
| onboarding | gateway | 1 | value |
| onboarding | persistence | 21 | value |
| onboarding | reminders | 4 | type-only |
| onboarding | runtime | 30 | value |
| onboarding | tasks | 2 | type-only |
| onboarding | trident | 1 | value |
| open | agent-dispatch | 1 | value |
| open | auth | 1 | value |
| open | channels | 11 | value |
| open | cores/free/agent-settings | 1 | type-only |
| open | cron | 1 | value |
| open | doc-search | 3 | value |
| open | gateway | **52** | value |
| open | jwt-validator | 1 | value |
| open | landing | 4 | value |
| open | onboarding | 9 | value |
| open | persistence | 3 | type-only |
| open | project-credentials | 2 | value |
| open | reflection | 1 | value |
| open | reminders | 1 | value |
| open | runtime | 13 | value |
| open | scribe | 2 | value |
| open | skill-forge | 1 | value |
| open | tasks | 1 | value |
| open | trident | 6 | value |
| open | work-board | 2 | value |
| project-credentials | persistence | 1 | type-only |
| reflection | runtime | 5 | type-only |
| reminders | channels | 3 | type-only |
| reminders | core-sdk | 1 | type-only |
| reminders | cron | 1 | value |
| reminders | gateway | 2 | value |
| reminders | landing | 1 | type-only |
| reminders | persistence | 1 | type-only |
| reminders | runtime | 2 | type-only |
| runtime | core-sdk | 1 | type-only |
| runtime | jwt-validator | 1 | type-only |
| runtime | onboarding | 3 | value (1 value + 2 type) |
| scribe | runtime | 10 | value |
| skill-forge | core-sdk | 1 | type-only |
| skill-forge | persistence | 1 | type-only |
| skill-forge | tools | 1 | type-only |
| tasks | cron | 4 | value |
| tasks | onboarding | 2 | type-only |
| tasks | persistence | 4 | type-only |
| tasks | reminders | 1 | type-only |
| tasks | runtime | 1 | value |
| tools | core-sdk | 1 | type-only |
| tools | persistence | 1 | type-only |
| trident | channels | 5 | type-only |
| trident | core-sdk | 2 | type-only |
| trident | persistence | 1 | type-only |
| trident | project-credentials | 2 | type-only |
| trident | prompts | 2 | value |
| trident | runtime | 8 | value |
| trident | tools | 2 | type-only |
| trident | work-board | 1 | value |
| watchdog | cron | 2 | type-only |
| watchdog | persistence | 1 | type-only |
| watchdog | runtime | 1 | value |
| watchdog | tools | 1 | type-only |
| work-board | core-sdk | 1 | type-only |
| work-board | persistence | 1 | type-only |
| work-board | tools | 1 | type-only |

---

## 4. Declared vs actual: the manifests are fiction

87% of cross-module imports (795/910) are relative paths (`../<other-workspace>/…`) that Bun happily resolves because the whole repo is one filesystem. `package.json` dependency blocks are therefore decorative. Highlights (full delta computed by `depgraph.ts`):

- **gateway/package.json** declares 12 workspace deps (all Cores + gbrain-memory + jose) but actually imports **39 modules** — 26+ undeclared, including `runtime` (61 stmts), `channels` (75), `onboarding` (103), `persistence` (34), `trident` (26). The declared ones exist only because `install-bundled.ts` dynamic-imports Cores by package name.
- **onboarding/package.json** declares channels+persistence+jose; actually also imports runtime (30), cron (10), gateway, reminders, tasks, trident.
- **runtime/package.json** declares only `@modelcontextprotocol/sdk`; actually imports core-sdk, jwt-validator, **onboarding**.
- **reminders** declares cron+persistence; actually imports channels, core-sdk, **gateway**, **landing**, runtime.
- **`open/`, `work-board/`, `tabs/`, `project-credentials/` have no package.json at all** and are absent from the root `workspaces` list (package.json:5-46), yet: `open/` is the production composition root (96 relative cross-imports out; imported back by gateway and migrations); `work-board/` is imported by 6+ modules (gateway, trident, agent-dispatch, open, app, landing); `tabs/registry.ts` is the tab source of truth consumed by `gateway/http/app-tabs-surface.ts`. These live implicitly in the *root* package, whose own dependency block (package.json:62-80) is also wrong (missing doc-search, reflection, scribe, tasks, skill-forge that `open/composer.ts` imports).
- Inverse rot exists too: `cores/free/calendar` and `google-workspace` declare `@neutronai/runtime` and never import it.
- Naming drift: `chat-core` is `@neutron/chat-core` (not `@neutronai/`); `agent-settings` lacks the `-core` suffix all other Cores carry.

Consequences: (a) no tool can compute a real build/typecheck order; (b) extracting ANY package to npm (the stated plan for core-sdk) or into another repo silently breaks; (c) the CI typecheck gap (root tsc include list) is partially *caused* by this — there is no per-package tsc because packages aren't real.

The one healthy counterexample proves the pattern works when enforced: `chat-core` (zero deps, true leaf) is consumed by app, landing, gateway, and message-search **only** via its package name — because the Expo/metro bundler forces honesty (`app/` must never transitively pull `node:sqlite`).

---

## 5. Stranded contract types: the generator of most back-edges

Almost every upward edge exists because a shared contract type/constant lives inside the feature package that first needed it, instead of in a leaf:

| Contract | Current home | Wrong-direction consumers (verified) |
|---|---|---|
| `ChatOutbound` / `ChatBridge` / `PendingChatClaim` (the chat wire protocol) | `landing/server.ts:203-699` (edge package) | `gateway/http/chat-bridge.ts:45`, `gateway/http/recovered-reply-store.ts:51`, `gateway/proactive/button-store-sink.ts:36`, `gateway/realmode-composer/build-live-agent-turn.ts:67`, `reminders/outbound.ts:24`, `open/composer.ts:214` |
| `OnboardingPhase` / `ALL_PHASES` | `onboarding/interview/phase.ts` | `runtime/onboarding-conversational-flag.ts:24` (value!), `runtime/platform-adapter.ts:53`, `platform-adapter-local.ts:65` |
| `AgentEngagementMode` + defaults (pure chat policy, not federation) | `connect/agent-engagement.ts` | `gateway/http/chat-bridge.ts:2749` gate, `gateway/projects/sqlite-store.ts:41`, `cores/free/agent-settings/src/backend.ts:43` (value) & `tools.ts:38`, plus a comment-enforced hand-mirror in `app/lib/projects-client.ts:24-29` |
| `MOBILE_APP_URL`, `TELEGRAM_BIND_TOKEN_TTL_MS` | `onboarding/interview/final-handoff-config.ts` | `landing/server.ts:41` (re-export), `cores/free/agent-settings/src/backend.ts:42` |
| `LlmCallFn` | `onboarding/interview/phase-spec-resolver.ts` (a 10k-line god file's satellite) | `tasks/prioritize-llm.ts:43`, `onboarding/wow-moment/dispatcher.ts:49` (intra-pkg but couples flows to the engine) |
| `McpToolResolver` | `runtime/adapters/gpt-5-5-api/mcp-shim.ts` (a *dormant adapter's* internals) | `mcp/server.ts:15` — the plugin platform depends on a specific (unused!) adapter |
| `ChatCommandFilter` | `gateway/http/app-ws-surface.ts` | `gateway/http/chat-bridge.ts:1009` sideways, plus the in-core filter factories structurally copying it (email/research/scraping chat-bridge.ts) |
| `ImportJobRunnerHook` | `onboarding/interview/engine-internals.ts` (inside the god engine) | `gateway/realmode-composer/build-synthesis-import-runner.ts:56-58` |
| Wire envelopes (`AppWsOutbound` etc.) | `channels/adapters/app-ws/envelope.ts` | hand-mirrored (not imported) in `app/lib/ws-envelope.ts` and partially re-declared in `chat-core/types.ts` — held together by parity tests only |

**Proposal:** one or two new L0 leaf packages — `@neutronai/chat-protocol` (ChatOutbound/ChatInbound/ChatBridge JSDoc contract + AppWs envelope types + option shapes) and `@neutronai/contracts` (phases, engagement mode, llm-call fn, import-runner hook, handoff constants). Node-free so `app/` and `chat-core` can import them (this is the constraint that forced the hand-mirrors; chat-core proves a node-free leaf works under metro). Old locations keep `export … from` shims for one transition PR each. This single move eliminates back-edges 1, 4, 7, 9, 10, 11 from §2.1 and retires three parity-test hand-mirrors.

---

## 6. The composition root is smeared (and that's why gateway looks like a god node)

Production boot composes in FOUR places that mutually import:

- `open/server.ts` → `open/composer.ts` (3,732 lines; 96 outgoing cross-module imports; not a package)
- `gateway/composition.ts` + `gateway/composition/` (module graph, input mapping)
- `gateway/realmode-composer/` (~13k LOC "builder library" used by both Open and the private Managed composer)
- `gateway/boot-helpers.ts` (1,695 lines, also the undeclared cross-repo ABI for the Managed composer via `NEUTRON_GRAPH_COMPOSER_MODULE`, gateway/index.ts:540)

Cycles this creates:
- `open ↔ gateway` (open→gateway x52 value; gateway→open x1 value at `gateway/cores/mount-open-cores.ts:48`)
- Intra-gateway directory cycle: `gateway/http/chat-bridge.ts:116` imports `../realmode-composer/build-onboarding-handoff.ts` while `gateway/realmode-composer/build-landing-stack.ts:44` imports `../http/chat-bridge.ts` (plus 4 more realmode-composer files importing `../http/*`)
- `migrations → open` (runner.ts:6) makes even the schema layer depend on the composition root.

`gateway`'s 39 outgoing deps and the 103-statement `gateway → onboarding` edge are not "substrate imports product" bugs to be individually removed — they are composition wiring living in a package that ALSO owns platform primitives (`gateway/http/doc-store.ts`, keyed-mutex) and 8 product-domain services (git/comments/upload/storage/proactive/push — per the gateway-services mapper). The layering fix is to **name the composition band and make it real**: promote `open/` to a workspace (`@neutronai/open-composer`), cut the 3 root-inversion edges (§2.1 #2/#5/#6), and rule that only `open/` + `gateway/composition*` + `realmode-composer` may import product surfaces. The domain services then migrate out of gateway on the gateway-services mapper's schedule; the dependency rules below make each extraction permanent.

**Cross-repo caution:** gateway's export surface (boot-helpers, index.ts re-export shim gateway/index.ts:32-63, realmode-composer) is consumed by the out-of-repo Managed composer through the env seam. Any module move that changes those import paths needs a private-repo audit first — this is a *stated invariant*, not a guess (boot-helpers.ts:6-20 documents the TLA cycle ban; the mapper verified 8 exports with zero in-repo consumers).

---

## 7. README five-layer diagram vs reality

README.md:241-266 declares five layers bottom-up (EDGE/TRANSPORT → SUBSTRATE/RUNTIME → MEMORY → CORES → PRODUCT SURFACES). Scoring the measured graph against it:

- **12 modules are unplaced**: agent-dispatch, chat-core, doc-search, jwt-validator, message-search, **open**, project-credentials, reflection, skill-forge, tabs, **trident**, work-board. The entire autonomous-work subsystem and the actual composition root have no home in the declared architecture.
- **landing/ is listed in TWO layers at once** (README.md:245 product surfaces AND :262 edge/transport) — accurate as a symptom (it is both an HTTP shell and the protocol home) but incoherent as a model.
- Of the 112 edges among *placed* modules, **33 edges (212 import statements) point upward** (violating), 34 point down, 45 are same-layer. A model violated by half the graph predicts nothing.
- The two biggest "violations" — `gateway → onboarding` x103 and `gateway → cores/*` x~60 — are really the model misplacing gateway (see §6). `prompts/` as a "product surface" is wrong too: it is a leaf library consumed by trident/agent-dispatch/scribe/reminders/gateway (trident/prompts.ts loads from it at runtime).
- Under the same reading, `channels → persistence` (button-store.ts:21), `auth → runtime` (max-oauth.ts imports `runtime/models.ts`), `landing → runtime`, `connect → runtime/persistence/gbrain-memory` are all "edge imports substrate" violations — but they are *reasonable* edges; it's the diagram that's inverted about where transport adapters sit relative to storage.

**Proposal:** replace the README diagram with the measured model from §2.2, and generate it: `depcruise --output-type archi` (or the scanner in this directory) so the diagram is a build artifact that cannot rot. The vision-docs critic's SYSTEM-OVERVIEW findings compound this: today there are *two* wrong diagrams.

---

## 8. Cores: the third-party fiction (layering view)

The Cores platform's entire value proposition is a boundary ("a Core compiles against the published SDK"). Measured: every bundled Core violates it, in two classes:

1. **Downward seam bypass** — sidecar migrations: `cores/free/{calendar/migrations/runner.ts:19, email/src/cache.ts:23, code-gen/src/sidecar/store.ts:18, research/src/store-resolver.ts:22}` all relatively import `migrations/runner.ts`; `cores/free/research/src/{backend.ts:45-47, research-orchestrator.ts:17, substrate-runtime.ts}` import `runtime/models.ts` (value).
2. **Upward product coupling** — `cores/free/agent-settings/src/backend.ts:42-47` imports onboarding (value) and connect (value: `DEFAULT_AGENT_ENGAGEMENT_MODE`, `isAgentEngagementMode`); `tools.ts:38` imports connect types.

Fixes are all injection-shaped and already have precedent in the codebase (email gets `emailModel: getBestModel` injected at `gateway/cores/mount-open-cores.ts:288`): export a project-scoped migrations applier from cores-runtime; inject model accessors into research (NOTE: research currently freezes model ids at module load — making it live is a *deliberate behavior change*, flag it, don't slip it in); move engagement policy to the contracts leaf (§5). Then make "cores/free/* may import only cores/sdk + cores/runtime + declared npm deps" a hard dependency rule — the living contract test the cores-platform mapper asked for.

---

## 9. Mechanical enforcement (the missing piece)

Current state, verified:
- `dependency-cruiser@17.4.3` in root devDependencies (package.json:57). **No `.dependency-cruiser.*` config anywhere; no invocation in package.json scripts, CI (.github/workflows/ci.yml), or scripts/**.
- No eslint at repo level (only `app/eslint.config.js` for the Expo app).
- The only architecture fences that exist: `tests/integration/no-direct-anthropic-api.test.ts` (a grep-walk over gateway/runtime/onboarding for the Anthropic URL) and `scripts/ci/leak-gate.sh` (vocabulary/structure, not imports).

### 9.1 Proposed `.dependency-cruiser.cjs` (concrete sketch)

```js
/** Layer bands; a module may import its own band or lower. */
const L = {
  contracts: ['^persistence', '^migrations', '^chat-core', '^core-sdk', '^cores/sdk',
              '^jwt-validator', '^prompts', '^tabs', '^contracts'],
  platform:  ['^runtime', '^cron', '^tools', '^channels', '^auth'],
  services:  ['^scribe', '^gbrain-memory', '^reflection', '^doc-search', '^message-search',
              '^reminders', '^tasks', '^work-board', '^trident', '^agent-dispatch',
              '^skill-forge', '^watchdog', '^landing', '^connect', '^cores/runtime',
              '^mcp', '^project-credentials'],
  product:   ['^onboarding', '^cores/free', '^app'],
  composition: ['^gateway', '^open'],
};
module.exports = {
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^(gateway|runtime|scribe|reflection|gbrain-memory|reminders|trident|agent-dispatch|tasks|skill-forge|cron|doc-search|message-search|cores|prompts|mcp|tools|migrations|persistence|core-sdk|jwt-validator|channels|chat-core|connect|watchdog|auth|onboarding|landing|app|open|tabs|work-board|project-credentials)/',
    exclude: { path: '(__tests__|\\.test\\.|^tests/)' },
    tsConfig: { fileName: 'tsconfig.base.json' },
  },
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'contracts-are-leaves', severity: 'error',
      from: { path: L.contracts }, to: { path: [...L.platform, ...L.services, ...L.product, ...L.composition] } },
    { name: 'platform-stays-low', severity: 'error',
      from: { path: L.platform }, to: { path: [...L.services, ...L.product, ...L.composition] } },
    { name: 'services-below-product', severity: 'error',
      from: { path: L.services }, to: { path: [...L.product, ...L.composition] } },
    { name: 'only-composition-imports-product-surfaces', severity: 'error',
      from: { path: L.product, pathNot: '^onboarding' }, to: { path: '^onboarding' } },
    { name: 'nobody-imports-composition', severity: 'error',
      from: { pathNot: ['^open', '^gateway'] }, to: { path: ['^gateway', '^open'] } },
    { name: 'cores-use-sdk-only', severity: 'error',
      from: { path: '^cores/free' },
      to: { path: '^(gateway|open|onboarding|connect|runtime|migrations|auth|landing|channels)/' } },
    { name: 'connect-is-dynamic-only', severity: 'error',
      from: { pathNot: '^(connect|gateway/composition)' }, to: { path: '^connect/api/' } },
    { name: 'app-bundle-purity', severity: 'error',
      from: { path: '^app/' },
      to: { path: '^(gateway|runtime|persistence|migrations|onboarding|channels|auth|connect)/' } },
  ],
};
```

Rollout without blocking the world: `bunx depcruise --config .dependency-cruiser.cjs --output-type baseline > .dependency-cruiser-known-violations.json` once (grandfathers all 175 current edges' violations), then CI runs `bunx depcruise --config … --ignore-known .dependency-cruiser-known-violations.json <module dirs>` — **new** violations fail immediately; the baseline burns down as §2.1 edges get cut. Add as step 5 in `.github/workflows/ci.yml` after the leak-gate (runtime ~seconds; it parses imports, doesn't typecheck).

### 9.2 The relative-bypass rule

dependency-cruiser sees resolved paths, so it enforces *which* module you import but not *how you spell it*. To kill the 795 relative escapes, add flat eslint at the repo root with exactly one plugin rule: `import/no-relative-packages` (eslint-plugin-import) — it autofixes `../channels/button-store.ts` → `@neutronai/channels/button-store.ts`. Precondition: every module has a package.json with `exports` (or at least `main`) — i.e., finding 3 (manifests) lands first for `open/`, `work-board/`, `tabs/`, `project-credentials/`. Alternative if eslint adoption is unwanted: a 30-line bun script in scripts/ci/ greping `from '\.\./` where the resolved target crosses a workspace boundary — the leak-gate already establishes the shell-gate pattern.

### 9.3 What NOT to enforce yet

- Do not turn on `no-orphans`/`not-to-unresolvable` until the dead-code findings from other critics land (they'd fire on hundreds of known-dead files).
- Do not add a rule banning `gateway → landing` or `gateway → onboarding`: under the corrected model those are legal composition edges.

---

## 10. Load-bearing subtleties a layering refactor could silently break

1. **`connect/api/server.ts` must never gain a static import edge from composition** — it is dynamic-imported only when `composition.connect_api` is set (gateway/composition.ts:119; runtime/platform-adapter-local.ts:140 sets `connect_api:false` for Open). Moving connect files or "fixing" the shadow types in `runtime/connect-handlers.ts` by converting them to static `import` (not `import type`) would make every Open boot load federation code. Use `import type` only, and encode rule `connect-is-dynamic-only` (§9.1).
2. **`app/` bundle purity** — the Expo bundle must never transitively import server workspaces (`node:sqlite` bricks the RN bundle; this is WHY `app/lib/ws-envelope.ts`, `doc-links.ts`, `tabs-client.ts` are hand mirrors). Any shared contracts package must be node-free; validate with the existing parity tests before deleting a mirror.
3. **Gateway's export surface is a cross-repo ABI** — the private Managed composer imports `gateway/boot-helpers.ts` et al. through `NEUTRON_GRAPH_COMPOSER_MODULE` (gateway/index.ts:540). Renaming/moving gateway files (e.g. `realmode-composer/` → `wiring/`) requires a Managed-repo audit + an export-name snapshot test first.
4. **`boot-helpers.ts` must never import `gateway/index.ts`** (TLA entry↔composer cycle, boot-helpers.ts:6-20). New "shared boot config" modules must sit below both.
5. **process.env is the de-facto DI bus at boot** — `open/server.ts:58-73` mutates env BEFORE `boot()` re-reads it (gateway/index.ts:118-157). Moving `resolveOpenDbPath` out of `open/owner-identity.ts` (cut #5) must preserve the exact DB-path/slug resolution order for both entrypoints.
6. **Moving value constants changes module-init graphs** — e.g. `collectTokensToString` (reminders cut #3) and `TELEGRAM_BIND_TOKEN_TTL_MS` (cut #9) are harmless pure values, but several modules read env at module load (research model constants, prepass.ts) — relocation reorders those reads. Prefer re-export shims in the old location for one release so init order shifts are observable in isolation.
7. **`slugifyProjectId` byte-parity** — `onboarding/wow-moment/project-identity.ts:41-44` must stay identical to gateway's `defaultProjectIdSlugifier` (drift-guard test). If the projects-fs extraction happens as part of layer moves, keep the drift test until there is literally one function.
8. **`docs/AS_BUILT.md` leak-gate literal-path coupling** — module renames that touch docs or allowlisted paths re-arm retired-vocab CI rules (leak-gate-allowlist.txt:69-80). Move allowlist entries in the same PR as any rename.
9. **Type-only vs value edges**: cuts #10/#11 are type-erased — zero runtime risk. Cuts #1/#3/#5/#6/#7/#8/#9 move real values; each needs its consumer's existing test suite run (all have coverage per the mappers: llm-router tests, reminders/tick+outbound tests, boot tests, landing route tests, agent-settings core tests).
10. **`cores/free/research` frozen model constants** — do NOT convert to `getBestModel()` thunks while "just fixing imports"; that flips runtime model selection (the cores-free mapper flags this as a deliberate, separately-verified change).

---

## 11. Suggested sequencing (all no-behavior-change except where flagged)

1. **Week 0**: land `.dependency-cruiser.cjs` + baseline + CI step (finding 2). Zero code moves; ratchet armed.
2. Land the §2.1 cut list as ~6 small PRs (contracts leaf first, then the injections). Each PR deletes its baseline entries. After this the graph is a DAG and `no-cycles` flips from baseline'd to hard.
3. Manifest honesty: package.json for open/work-board/tabs/project-credentials; declare real deps everywhere; enable `import/no-relative-packages` autofix module-by-module (mechanical, reviewable as pure-rename diffs).
4. Composition consolidation (gateway/open/realmode-composer) and gateway domain-service extractions proceed on the other critics' schedules — now guarded by the rules instead of re-tangling.

Artifacts in this directory: `depgraph.ts` (scanner), `depgraph.json` (full output incl. declared-vs-actual), `edges-perfile.json` (statement-level edge list), `edge-table.md` (the table in §3).
