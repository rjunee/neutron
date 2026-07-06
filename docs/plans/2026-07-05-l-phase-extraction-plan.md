# L-Phase (Layering) Extraction Plan — concrete, anchored at HEAD `fd814d9`

**Date:** 2026-07-05. **Author:** Fable planning pass (read-only; no code touched).
**Inputs:** plan §5 (`docs/plans/2026-07-02-world-class-refactor-plan.md` L1–L7),
audit `docs/research/fable-refactor-audit-2026-07-05.md` §3 items 2/4 + §4,
layering critic `docs/research/refactor-audit-2026-07-02/critic-layering.md` §2.1/§2.2/§9,
live config `.dependency-cruiser.cjs` + `.dependency-cruiser-known-violations.json` (21 entries)
+ `scripts/ci/depcruise.sh`.
**Every anchor below re-verified by `git grep` against `fd814d9` on 2026-07-05.**

> Committing this doc requires its leak-gate allowlist entry in the same PR
> (§1.4 / D-11 — the #196/#198 lesson).

---

## 0. Ground truth at HEAD (what changed under the plan's L-briefs)

Verified live state that corrects or sharpens the 07-02 briefs:

1. **All 11 SCC cut-list edges are still present at `fd814d9`** (each re-grepped; file:line
   in the unit specs below). PR #184's mcp/runtime churn did NOT remove cut #11
   (`mcp/server.ts:15` still imports `McpToolResolver` from the gpt-5-5-api mcp-shim).
   But K11 (unmerged, wave-1 remainder) rewrites landing/server.ts + chat-bridge.ts
   territory, so the cut list MUST be re-derived post-K11 (gate L0 below).
2. **The audit scanner is gone.** `critic-layering.md` §11 cites `depgraph.ts` /
   `depgraph.json` / `edges-perfile.json` "in this directory" — none exist on disk
   (`docs/research/refactor-audit-2026-07-02/` has only the .md files +
   `verified-findings.json`). The "re-run SCC vs HEAD" gate therefore needs the tool
   **rebuilt** (sub-unit L0).
3. **depcruise is blind to every type-only cut.** `.dependency-cruiser.cjs` does not set
   `tsPreCompilationDeps`, so `import type` edges are invisible: the live baseline (21
   entries) contains **only the value edges**. Cuts #4 (`ChatOutbound`), #10 (`LlmCallFn`),
   #11 (`McpToolResolver`), and the `WebChatSenderRegistry` type import can only be
   verified by grep + the rebuilt scanner — this is the general form of the audit's
   "L1 in-package staging is depcruise-unverifiable" finding. Per-unit accepts below say
   exactly which baseline entries disappear vs which are grep-enforced.
4. **`/ws/chat` is already removed at HEAD** (`landing/server.ts:16`,
   `gateway/http/chat-bridge.ts:7`, `gateway/http/compose.ts:13`). The protocol block L1
   moves verbatim (`ChatInbound`/`ChatBridge`/`PendingChatClaim`) is partly the *contract
   of a removed socket*; K11 shrinks it further. L1's export list is derived from
   post-K11 HEAD, not from the 07-02 brief.
5. **Stale L-brief items** (full list §8): ImportJobRunnerHook already extracted by K3;
   the landing `MOBILE_APP_URL` re-export has zero external importers (edge #7 is a
   one-line delete, not a relocation); `WebChatSenderRegistry` is at chat-bridge.ts:149
   (not :162) and moves again in K11a; L3(b)'s "move reminders/outbound.ts into gateway"
   is unnecessary once L1/L2 land (only `collectTokensToString` needs relocating);
   envelope.ts is 951 lines (not 931); `resolveOpenDbPath` has *partial* test coverage
   (runner-CLI precedence only — the boot-side agreement pin is still missing).

**The five bands** (`.dependency-cruiser.cjs` `L`): contracts < platform < services <
product < composition. New homes introduced by this phase: `contracts/` (L2, contracts
band) and `wire-types/` (L6, contracts band). Both must be added to the config's band
map + `includeOnly` in the unit that creates them.

---

## 1. L0 — SCC/anchor refresh gate (NEW sub-unit, prerequisite for L2/L3)

*`sonnet` · S · lane none (tooling only) · dep: **K11 merged***

The audit's §3.4 hard gate, made executable:

- **Rebuild the scanner** as `scripts/refactor/depgraph.ts` (walk all non-node_modules
  TS/TSX/MJS, extract import/export-from/dynamic-import/require incl. `import type`,
  resolve to top-level module, emit edge list + Tarjan SCC). ~200 lines; the critic doc
  §1/§3 is the spec and the expected-output oracle (175 edges / 28-module SCC at 07-02,
  minus whatever waves −1..1 already cut).
- **Re-run vs post-K11 HEAD** and emit `docs/research/l-phase-scc-<date>.md`: the surviving
  cut list with fresh file:line. Expected: the 11 edges of §2.1 minus any K11 casualties
  (K11 deletes `build-llm-router.ts` consumers, trims chat-bridge, may delete
  `PendingChatClaim`/`ChatBridge` halves).
- **Re-grep every anchor in this plan** (§3.5 of the audit makes anchor-refresh a
  per-unit MANDATORY gate; K11 shifts every engine.ts/chat-bridge/landing range cited
  here). Park-and-flag on mismatch.
- **Accept:** scanner committed + its SCC output committed as the L2/L3 work order;
  every L1–L3 anchor below confirmed-or-corrected. No production code changes.

**Why after K11:** K11 (§17 wave-1 remainder, "highest-risk remaining unit") touches
engine/bridge/trident/transport — exactly the files L1/L2 extract from. STATUS.md already
pins: "Do NOT start wave 2 (L1 chat-protocol extraction) until K11 lands — L1 must not
extract code K11 removes." That pin is inherited here as the phase-entry gate, and per
the 07-05 audit it means **merged, not parked**.

---

## 2. L1 — Chat-protocol leaf module · `sonnet` · M · lane transport

**Dep: K11 merged, L0 done. Transport-lane order: S0 → W3a → W5 → L1 → L6 (audit §3.3) —
S0/W3a/W5 are behavior fixes that must not queue behind this mechanical extraction; if
they are still unmerged when L1 is ready, L1 waits (same lane).**

### What moves

Extract as an **in-package leaf module** `landing/chat-protocol.ts` — zero build churn;
promote to a workspace package only if L6 ends up needing it (it shouldn't: L6's
wire-types owns the app-ws envelope, not this legacy web-topic protocol).

Move **verbatim, JSDoc included** (the JSDoc is the only written spec of jti-claim
atomicity / identity-unregister / seed-reemit):

| Symbol | Current source (verified at `fd814d9`) |
|---|---|
| `ChatInbound` | `landing/server.ts:170` |
| `ChatOutbound` (discriminated union + frame interfaces) | `landing/server.ts:203–~537` |
| `PendingChatClaim` | `landing/server.ts:539` |
| `ChatBridge` | `landing/server.ts:555–708` (block ends :708; `LandingServerOptions` begins :710) |

(The 07-02 brief said 170–699; current end is ~708 — drift from post-plan PRs. L0
re-confirms.) **K11 caveat:** `/ws/chat` is already gone; K11 excises the engine-drive
halves of `buildWebChatBridge`. After K11, re-derive which of
`ChatInbound`/`PendingChatClaim`/`ChatBridge` still have live consumers — move ONLY
surviving symbols; anything K11 orphaned gets deleted (with a served-by-path check per
[[refactor-deletion-served-by-path-trap]]), not extracted. `ChatOutbound` is definitely
live (persisted `button_prompts` frames + reminders + recovered replies render it).

`landing/server.ts` keeps `export … from './chat-protocol.ts'` re-export shims during
the transition PR. Do NOT touch the value re-export at `landing/server.ts:41`
(`MOBILE_APP_URL`) — **L2 owns that** (edge #4/#7 assignment: audit §3.2 requires
`reminders/outbound.ts` assigned to exactly one unit — it is assigned to **L1** for its
`ChatOutbound` import; its `WebChatSenderRegistry` import is **L2's**).

### Importers to repoint (production; all verified)

| File:line | Imports |
|---|---|
| `gateway/http/chat-bridge.ts:44` | `ChatBridge`, `ChatOutbound`, `PendingChatClaim` (type) |
| `gateway/http/recovered-reply-store.ts:51` | `ChatOutbound` (type) |
| `gateway/proactive/button-store-sink.ts:36` | `ChatOutbound` (type) |
| `gateway/realmode-composer/build-live-agent-turn.ts:67` | `ChatOutbound` (type) |
| `open/composer.ts:231` | `ChatOutbound` (type) — brief said :214, drifted |
| `reminders/outbound.ts:24` | `ChatOutbound` (type) |

NOT repointed: `gateway/realmode-composer/build-landing-stack.ts:78` imports
`createLandingServer` + `LandingServer` (values — the server itself, correctly from
`landing/server.ts`). **21 test files** also import from `landing/server.ts` (list via
`git grep -l "landing/server" -- '**/__tests__/**' '*test*'`); flip them in the same PR
(mechanical) or leave them on the shim — either is acceptable, but the accept-grep below
must then exclude test paths.

### Depcruise expectation + the grep-enforced accept

**Band-neutral — no baseline entry is removed.** All six importer edges are
composition→services or services→services(same-band), and all are `import type`
(invisible to depcruise anyway). This is the audit §3.4 finding verbatim: L1's
in-package staging is mechanically unverifiable by the ratchet. Enforce instead:

- **Grep gate (CI-able one-liner):**
  `git grep -l "from '.*landing/server" -- '*.ts' '*.tsx' ':!*test*' ':!*__tests__*'`
  returns exactly ONE file: `gateway/realmode-composer/build-landing-stack.ts`.
- **Leaf purity:** `grep "^import" landing/chat-protocol.ts` → zero cross-module imports
  (type-only imports of other landing files acceptable; ideally none).
- **JSDoc byte-identity:** `git diff` of the moved block shows pure relocation
  (`--color-moved=zebra` clean).
- **Optional hard rule** (recommended, cheap): add a depcruise rule
  `landing-server-is-composition-only` — `from: { pathNot: '^(landing|gateway/realmode-composer/build-landing-stack)' }`
  `to: { path: '^landing/server\\.ts' }`, severity error, zero baseline entries needed
  once the six flips land. This converts the grep gate into a permanent ratchet.

### Tests

Stay green (no moves): the 10 `gateway/http/__tests__/chat-bridge-*.test.ts`, the ~11
`build-live-agent-turn-*.test.ts`, `replay-redelivery.test.ts`,
`compose-start-route.test.ts`, reminders `dispatcher`/`message-shape` suites,
`open/__tests__/open-boot-shell.test.ts`, full `typecheck-all.sh` matrix (G5), depcruise
ratchet (no growth — G8 guard). No test moves.

---

## 3. L2 — Contracts leaf · `sonnet` · M · **lane is NOT "none"**

**Deps: K11 merged, L0 done, L1 merged (same-file edit on `landing/server.ts:41`).**
Audit §3.2: the 07-02 "lane none" label lies — this unit edits files in the engine
(`onboarding/interview/*`), bridge (`chat-bridge.ts:113`), transport
(`build-landing-stack.ts:28`), cores (`agent-settings`), runtime, tasks, mcp, trident
lanes. Treat as an **exclusive multi-lane unit**: no engine/bridge/cores/composer unit
runs concurrently.

### New home

Create top-level **`contracts/`** — a directory of node-free leaf modules (no
package.json yet; L4 promotes it to `@neutronai/contracts`). In-package staging cannot
work here: the point of these cuts is to move symbols **down a band**, so a new
contracts-band home is required. Same-PR config change: add `'^contracts'` to
`L.contracts` and to `includeOnly` in `.dependency-cruiser.cjs` (adds zero violations;
G8 ratchet-growth guard unaffected — baseline only shrinks).
**Metro constraint:** node-free, dependency-free files only (chat-core proves the
pattern under metro).

### Item-by-item (all with `export … from` shims at the old site for one transition PR)

| # | Symbol(s) | From (verified) | To | Importers to repoint | Cuts |
|---|---|---|---|---|---|
| 1 | `OnboardingPhase`, `ALL_PHASES`, `LEGAL_TRANSITIONS`, `TERMINAL_PHASES`, `isLegalTransition` | `onboarding/interview/phase.ts` (180 lines, **zero imports — whole file moves**) | `contracts/onboarding-phase.ts` | `runtime/onboarding-conversational-flag.ts:24` (**value** `ALL_PHASES` — the only value consumer), `runtime/platform-adapter.ts:53`, `runtime/platform-adapter-local.ts:65`, `gateway/realmode-composer/resolve-onboarding-phase.ts:37`, `tests/integration/m2-walkthrough-test-helpers.ts:30`; `onboarding/index.ts:42-48` re-export stays as the shim | **SCC cut #1**; removes baseline entry `platform-stays-low: runtime/onboarding-conversational-flag.ts → onboarding/interview/phase.ts` |
| 2 | `AgentEngagementMode`, `DEFAULT_AGENT_ENGAGEMENT_MODE`, `isAgentEngagementMode` | `connect/agent-engagement.ts` (264 lines, **zero imports — whole file moves**) | `contracts/agent-engagement.ts` | `cores/free/agent-settings/src/backend.ts:47` (value), `cores/free/agent-settings/src/tools.ts:38`, `gateway/http/app-projects-surface.ts:48`, `gateway/http/chat-bridge.ts:113` (brief's :2749 anchor is stale — K2 shifted it; gate now at :1753), `gateway/projects/sqlite-store.ts:41`, `gateway/realmode-composer/build-landing-stack.ts:28` | removes baseline entry `cores-use-sdk-only: agent-settings/backend.ts → connect/agent-engagement.ts` |
| 3 | `MOBILE_APP_URL`, `TELEGRAM_BIND_TOKEN_TTL_MS` (+ siblings `buildTelegramBindDeepLink`, `resolveTelegramBotUsername` if leaf-clean) | `onboarding/interview/final-handoff-config.ts` | `contracts/handoff-config.ts` | `cores/free/agent-settings/src/backend.ts:42` (value TTL), `onboarding/interview/engine.ts:142`, `onboarding/interview/final-handoff-prompts.ts:39`; **`landing/server.ts:41` re-export: DELETE, don't repoint — zero external importers of `MOBILE_APP_URL` from landing (verified), so edge #7 is a one-line removal** | **SCC cuts #7, #9**; removes baseline entries `services-below-product: landing/server.ts → final-handoff-config`, `cores-use-sdk-only: agent-settings/backend.ts → final-handoff-config`, `only-composition-imports-product-surfaces: agent-settings/backend.ts → final-handoff-config` |
| 4 | `LlmCallFn` | `onboarding/interview/phase-spec-resolver.ts` | `contracts/llm-call.ts` | `tasks/prioritize-llm.ts:43`, `gateway/composition/input/tasks-input.ts:2`, `gateway/realmode-composer/build-wow-dispatcher.ts:111`, `gateway/tasks/p6/nudge-engine.ts:35`, `onboarding/wow-moment/dispatcher.ts:49`, `onboarding/wow-moment/llm-selector.ts:29` | **SCC cut #10** (type-only → grep-enforced, invisible to depcruise) |
| 5 | `McpToolResolver` | `runtime/adapters/gpt-5-5-api/mcp-shim.ts:34` (a dormant adapter's internals) | `contracts/mcp-tool-resolver.ts` | `mcp/server.ts:15`, `runtime/adapters/gpt-5-5-api/mcp-shim.ts` + `index.ts:30` re-import it downward | **SCC cut #11** (type-only → grep-enforced). NOTE: the critic's per-edge suggestion "move into mcp" is superseded — runtime(platform)→mcp(services) would itself be a band violation; the contracts leaf is the correct home |
| 6 | `WebChatSenderRegistry` (interface only; `InMemoryWebChatSenderRegistry` impl stays in gateway) | `gateway/http/chat-bridge.ts:149` (brief's :162 stale) — **or wherever K11a's mandatory sender-registry extraction homed it** (audit §2 item 1 pulls it to "a neutral module FIRST") | `contracts/web-chat-sender.ts` | `reminders/outbound.ts:25` (the type half of SCC cut #3), `gateway/realmode-composer/build-landing-stack.ts:43`, chat-bridge internal uses via shim | type-only → grep-enforced. **Coordinate with K11a:** if K11a already created a gateway-internal module, L2 lifts only the interface to contracts and leaves the impl module re-exporting it |
| 7 | `OutboundSink`, `OutgoingMessage` (declared twice, structurally identical — verify before merge) | `trident/delivery.ts:46` AND `gateway/proactive/sink.ts:21` | `contracts/outbound-sink.ts`; both old sites re-export | `gateway/composition/input/misc-input.ts:122`, `gateway/composition/input/tasks-input.ts:6`, `gateway/proactive/{button-store-sink.ts:38, idle-nudge-sweep.ts:30, morning-brief.ts:32}`, `trident/delivery.ts:58` | band-neutral (all current edges are legal directions) — this is vocabulary dedup, not an edge cut |
| 8 | `ChatCommandFilter`, `ChatCommandFilterResult` | `gateway/http/app-ws-surface.ts:122/:132` | `contracts/chat-command-filter.ts` (optional) | `gateway/http/chat-bridge.ts:967/:1669` (inline `import('./app-ws-surface.ts')` types — sideways same-package); the cores' filter factories (email/research/scraping `chat-bridge.ts`) are **structural clones, not imports** — they MAY now import the contract type properly (cores→contracts is band-legal and outside the `cores-use-sdk-only` forbidden list) | band-neutral; unification value only. Defensible to defer to L6/X-phase — include only if cheap |
| 9 | ~~`ImportJobRunnerHook`~~ | **STALE — already done.** K3 extracted it to `onboarding/interview/import-runner-hook.ts` (engine-internals.ts:40-43 comment; :688 re-export). Its only cross-module consumer is `gateway/realmode-composer/build-landing-stack.ts:47` — composition→product, band-legal | — | drop from L2 scope (optional 1-line repoint of build-landing-stack to the leaf file) |

### Depcruise expectation

Baseline shrinks by **5 entries** (items 1–3): re-run
`scripts/ci/depcruise-refresh-baseline.sh` on the clean merged tree; the G8 guard
verifies shrink-only. Items 4–6 are type-erased: **grep-enforced accepts** —
`git grep "onboarding/interview/phase" -- runtime/` → 0;
`git grep "connect/agent-engagement" -- cores/ gateway/` → 0;
`git grep "final-handoff-config" -- cores/ landing/` → 0;
`git grep "phase-spec-resolver" -- tasks/ gateway/` → 0;
`git grep "gpt-5-5-api/mcp-shim" -- mcp/` → 0;
`git grep "gateway/http/chat-bridge" -- reminders/` → 0.
Plus the rebuilt `scripts/refactor/depgraph.ts` shows cuts #1/#7/#9/#10/#11 gone.

### Care

- `final-handoff-config.ts:46` reads `process.env.NEUTRON_WEB_APP_BASE` **at module
  load** (critic §10.6). The re-export shim keeps first-import timing equivalent (the
  value is frozen before `startOpenServer()` runs either way, via the composer's static
  import chain), but do NOT also convert the const to a lazy getter "while here".
- Node-free check per file: `contracts/` must import nothing (not even `node:` builtins).
- `app/lib/projects-client.ts:24-29` hand-mirrors AgentEngagementMode by comment — the
  mirror STAYS until L6 (G3's `agent-engagement-mode-mirror-parity.test.ts` keeps
  pinning it; L2 must keep that test green, now against `contracts/agent-engagement.ts`
  through the shim).

### Tests

Stay green: `app/__tests__/agent-engagement-mode-mirror-parity.test.ts`,
`gateway/http/__tests__/chat-bridge-engagement-mode.test.ts` +
`chat-bridge-cores-command-filter.test.ts`, `open-mode-phase-walk.test.ts`,
agent-settings core suites, `tasks` suites, reminders suites, `mcp` tests, full
typecheck matrix. No test moves (shims hold old paths for the transition PR; flip test
imports in the shim-removal follow-up).

---

## 4. L3 — Remaining DAG edge cuts (injection-shaped) · `opus` · M · lanes composer+data

**Deps: K11, L0, L2 merged (L2 removes the type halves; L3 removes the value halves).
L3c additionally hard-gates C1 (audit §3.2 pin: K11 → L1 → L2 → L3 → C1).**

Sub-units (independently dispatchable; a/b/d/e are `sonnet`-grade mechanical, c and the
final flip are the `opus` judgment):

### L3a — gateway → open injection (SCC cut #6) · lane composer

`gateway/cores/mount-open-cores.ts:48` value-imports `buildOpenAgentProfileBackend` from
`open/agent-profile-backend.ts` (used at :300 to build `agentSettingsProfile`). Inject:
add an `agentSettingsProfile` (or a `buildAgentProfileBackend` factory) field to
`mountOpenCores`'s options; the single caller `open/composer.ts:1032` (import at :110)
passes it. **Depcruise: band-neutral** (gateway↔open are both composition) — grep-enforced:
`git grep "from '.*open/" -- gateway/` → 0. Package-SCC: the rebuilt scanner shows
gateway→open gone. Tests green: `open/__tests__/open-boot-shell.test.ts`, G1 route
matrix, mount-open-cores/agent-settings suites.

### L3b — collectTokensToString → runtime leaf (value half of SCC cut #3) · lane composer

`reminders/dispatcher.ts:28` value-imports `collectTokensToString` from
`gateway/realmode-composer/build-llm-call-substrate.ts:796` (fn drains a runtime
`SessionHandle` — it has no business in a composer file). Move to
**`runtime/substrate-text.ts`** (exactly where O8's `drainToText` consolidation later
lands — this pre-stages O8's home); `build-llm-call-substrate.ts` keeps a re-export shim
(its 6 gateway-internal consumers + `open/composer.ts:72` +
`gateway/boot-helpers.ts:1324` dynamic import can stay on the shim; repoint
opportunistically). Repoint `reminders/dispatcher.ts:28` to runtime.
**Depcruise: removes 2 baseline entries** (`nobody-imports-composition` +
`services-below-product`, both `reminders/dispatcher.ts → build-llm-call-substrate.ts`).
**Simplification vs the 07-02 brief:** "move `reminders/outbound.ts` delivery up into
gateway composition" is NOT needed — after L1 (ChatOutbound) + L2 (WebChatSenderRegistry)
+ L3b, `reminders/` has zero gateway/landing imports and `outbound.ts` stays put; the
`ReminderOutbound` seam (`dispatcher.ts:42`, injected at `open/composer.ts:2003`) already
exists and is untouched. Tests green: `reminders/dispatcher.test.ts`,
`dispatcher.integration.test.ts`, `outbound` coverage, gateway substrate suites
(`build-llm-router-cc-substrate.test.ts` — also a K11a move target; coordinate),
FIX #347 first-token behavior (`onFirstToken` param moves verbatim).

### L3c — resolveOpenDbPath out of open/ (SCC cut #5) · lane data · **BEFORE C1 · live-data hazard**

`migrations/runner.ts:6` value-imports `resolveOpenDbPath` from
`open/owner-identity.ts:61` (used at runner.ts:180 as the no-arg CLI default). This is
the schema layer depending on the composition root — and the resolution order decides
**which SQLite file gets migrated vs booted** on every Open install.

- Move `resolveOpenDbPath` **and its dependency `resolveNeutronHome`**
  (`owner-identity.ts:40` — the fallback chain runs through it) to
  **`migrations/db-path.ts`** (migrations is contracts band — the lowest; `open/` and
  anything else may import it downward). `open/owner-identity.ts` re-exports both
  (shim), keeping `open/server.ts:33` import working unchanged.
- **Preserve the EXACT resolution order for both entrypoints** (verified today):
  `NEUTRON_DB_PATH` verbatim → `<NEUTRON_HOME>/project.db` → `<OWNER_HOME>/project.db`
  → `~/neutron/project.db`; and the `open/server.ts:56-63` env-mutation contract
  (OWNER_HOME defaulted from resolveNeutronHome BEFORE NEUTRON_DB_PATH is derived,
  all before `boot()` re-reads env).
- **Audit flag, sharpened:** coverage is *partial*, not absent —
  `migrations/runner.test.ts:333-365` pins the CLI precedence (NEUTRON_HOME default,
  NEUTRON_DB_PATH pin, explicit arg). **Missing and REQUIRED in this unit:** a
  boot-vs-runner **agreement test** pinning that `open/server.ts`'s env mutation writes
  exactly `resolveOpenDbPath(env)` and that runner-default and boot-resolved paths are
  identical for the same env (incl. the OWNER_HOME-only and empty-env cases). Write it
  BEFORE the move (red-green against a deliberate order swap), keep it forever — C1's
  BootConfig later re-plumbs this exact path and needs the pin to refactor against.
- **Depcruise: removes 2 baseline entries** (`contracts-are-leaves` +
  `nobody-imports-composition`, both `migrations/runner.ts → open/owner-identity.ts`).

### L3d — issueInviteToken → connect (SCC cut #8) · lane none

`connect/trusted-accept-handler.ts:54` value-imports `issueInviteToken` from
`onboarding/api/invite-link-generate.ts:102` (federation code stranded in onboarding;
imports only node:crypto + jose + a persistence type — connect already depends on both).
Move the issuance half to **`connect/invite-token.ts`** — **NOT under `connect/api/`**:
`gateway/http/app-connect-invite.ts:37` and `gateway/http/app-project-invite.ts:36`
import it **statically**, and the `connect-is-dynamic-only` depcruise rule forbids any
static import into `connect/api/*` (INVARIANTS §76). Old site re-exports (shim); repoint
the 3 importers. **Depcruise: removes 1 baseline entry** (`services-below-product:
connect/trusted-accept-handler.ts → onboarding/api/invite-link-generate.ts`). Tests
green: trusted-accept suites, `app-connect-invite`/`app-project-invite` surface tests.
Care: verify the token *verification* half used by dynamic-only `connect/api/` keeps its
existing import direction (connect-internal after the move — an improvement).

### L3e — defaultProjectEmoji → leaf (SCC cut #2) · lane none

`onboarding/wow-moment/actions/03-project-shells.ts:55` value-imports
`defaultProjectEmoji` from `gateway/projects/default-emoji.ts` (231 lines, zero imports
— pure lookup; whole file moves) → **`contracts/project-emoji.ts`** (or
`tabs/project-emoji.ts` if a less generic contracts surface is preferred — owner's
naming call, band-identical either way). Old site re-exports; repoint 6 importers
(`gateway/http/app-projects-surface.ts:49`, `gateway/projects/sqlite-store.ts:53`,
`gateway/realmode-composer/project-create.ts:44`, `03-project-shells.ts:55`,
`open/composer.ts:162`, + shim). **Depcruise: removes 1 baseline entry**
(`nobody-imports-composition: 03-project-shells.ts → gateway/projects/default-emoji.ts`).

### L3f — intra-package file-cycle breaks · lane none · `haiku`

The `no-cycles` hard flip (L3g) also requires the 2 baselined FILE-level cycles gone:

- `gbrain-memory/ensure-brain-init.ts:41` ↔ `gbrain-doctor.ts:565` (doctor side is
  already a dynamic import commented as cycle-avoidance — depcruise counts it anyway).
  Fix: extract `CommandRunner` + `bunCommandRunner` to `gbrain-memory/command-runner.ts`;
  both import downward; keep the dynamic import (it becomes acyclic).
- `trident/board-dispatch.ts:50` (`slugifyTask` from code-command) ↔
  `trident/code-command.ts:27` (`dispatchBoardBoundBuild` from board-dispatch).
  Fix: extract `slugifyTask` (`code-command.ts:112`) to `trident/task-slug.ts`;
  code-command + board-dispatch + `trident/index.ts:130` re-export repointed.
  Care: trident verifies via `tsc -p trident/tsconfig.json` (root tsc misses errors).

### L3g — the hard-error flip · orchestrator-managed accept for the whole L3 unit

After a–f: re-run `scripts/ci/depcruise-refresh-baseline.sh` (clean tree). Expected
baseline: **21 → 10 entries** — L2 removes 5, L3 removes 6 (incl. both no-cycles
entries). The 10 survivors are all owned by OTHER phases (verified assignment:
`connect-is-dynamic-only: gateway/projects/shared-projects-resolver.ts` → S/C-phase;
`cores-use-sdk-only` ×4 sidecar-migrations → X-phase cores-runtime applier;
`cores-use-sdk-only` ×3 research→runtime/models → X-phase, **deliberate-behavior
change, do not slip in** per critic §10.10). With zero `no-cycles` entries left,
that rule is effectively hard-error — no config change needed.
**Package-level SCC = ∅ is NOT depcruise-verifiable** (type edges invisible; depcruise
cycles are file-level): the accept is `scripts/refactor/depgraph.ts` (from L0) printing
**zero non-trivial SCCs including `import type` edges** — add it as a CI step or a
`tests/integration/` guard here so it can't regress. (Deliberately NOT flipping
`tsPreCompilationDeps: true` in the depcruise config: it would surface hundreds of new
type-edge violations and grow the baseline, which the G8 shrink-only guard forbids;
the scanner assert gives the same protection additively.)

---

## 5. L4 — Manifest honesty + workspace promotion · `sonnet` · M · lane ci

**Deps: L2 (contracts/ exists to be promoted). May run parallel with L3 (file
intersection ≈ ∅: L4 edits package.json/tsconfig only) — but its declared-deps snapshot
is taken AFTER L3 merges (L3 changes real deps: reminders drops gateway+landing, etc.).**

- Add `package.json` (+ leaf tsconfig where missing, per the G5 matrix convention) for:
  `open/` (**suggest `@neutronai/open-composer`** per critic §6 — owner naming call),
  `tabs/`, `work-board/`, `project-credentials/`, **`contracts/`** (new from L2).
  Verified importer sets that make these real packages worth having: work-board ← 8
  modules (`agent-dispatch/{service,tool}.ts`, `gateway/composition/*`,
  `gateway/http/work-board-surface.ts`, `open/composer.ts`, `trident/{board-dispatch,
  work-board-build-tool}.ts`); project-credentials ← 7; tabs ←
  `gateway/http/app-tabs-surface.ts`; open ← (post-L3a) nothing but the root scripts.
- Add all five to root `workspaces` (`package.json:5-46` currently lists 41).
- Declare REAL deps in every workspace manifest. Verified rot at HEAD:
  `gateway/package.json` declares 12 Cores-ish deps + jose but imports ~39 modules;
  `runtime/package.json` declares ONLY `@modelcontextprotocol/sdk`; inverse rot in
  calendar/google-workspace (declare `@neutronai/runtime`, never import it). Fix the
  root package's own dep block (missing doc-search/reflection/scribe/tasks/skill-forge
  that `open/composer.ts` imports).
- **Tooling for the accept:** extend `scripts/refactor/depgraph.ts` (L0) to emit the
  declared-vs-actual delta (the critic's `depgraph.json` capability, rebuilt).
  **Accept: delta = 0**, `bun install` clean, typecheck-all matrix green, depcruise
  output unchanged (manifests don't alter the import graph — **band-neutral, zero
  baseline change**), leak-gate green.
- **Care:** `bun install` after merge before trusting tsc (workspace symlinks change).
  Cross-repo ABI: the Managed composer consumes gateway via the
  `NEUTRON_GRAPH_COMPOSER_MODULE` env seam (file paths, not npm) — adding manifest deps
  is ABI-safe; do NOT rename any gateway file here.

---

## 6. L5 — Relative-import autofix sweeps · `haiku` · M (batched per package) · **repo-wide-write lane (EXCLUSIVE)**

**Deps: L4 merged (needs real manifests to resolve `@neutronai/*` specifiers).**
Audit §3.2: "lane none" lies — every batch is a repo-wide write; **nothing else runs
concurrently with an L5 batch** (including L7 — both rewrite import specifiers).

- Root flat eslint config with exactly `import/no-relative-packages`; autofix
  `../<workspace>/…` → `@neutronai/<workspace>/…` **one package-batch per PR**, suite
  green each. Scale check at HEAD: audit counted 795 production escapes; raw grep incl.
  tests shows ~3,900 relative `from '../` lines of which cross-workspace clusters:
  persistence ~369, channels ~335, runtime ~323, migrations ~294, onboarding ~156,
  gateway ~78 (rest smaller). Batch order: leaf targets first (persistence, migrations,
  chat-core-consumers, channels, runtime), composition last.
- **Care (critic §10.6):** pure-rename diffs must not reorder module-load side effects —
  modules reading env at load (`runtime/models.ts`, research constants,
  `final-handoff-config.ts` post-L2) keep their import positions. Keep each batch
  `git diff --color-moved` reviewable.
- **Depcruise expectation: band-neutral and GRAPH-IDENTICAL** — depcruise resolves
  specifiers, so violations/baseline must be byte-identical before/after each batch
  (that identity IS the per-batch accept, alongside the full suite + typecheck matrix).
  Final accept: cross-workspace relative imports = 0; the eslint rule runs in CI so the
  count can't regress.

---

## 7. L7 — chat-core scope rename · `sonnet` · S · lane clients+transport

**Deps: W5 merged (audit §3.2/§3.3 pin W5 → L7: W5 rewrites `chat-core/ws-client.ts`,
`web-session.ts`, `types.ts`, `store.ts` internals — the live half-open-socket fix must
not rebase over a rename). Exclusive vs L5 batches (both rewrite specifiers).**

`@neutron/chat-core` → `@neutronai/chat-core` (the one scope outlier among the
workspaces). Verified blast radius at HEAD: **52 files** reference the specifier
(`git grep -l "@neutron/chat-core"`), spanning `chat-core/package.json` (name),
consumers' manifests (`app/package.json`, `landing/package.json`,
`message-search/package.json`), `app/metro.config.js` (watch/symlink doc + resolution),
`app/tsconfig.json`, `gateway/composition/message-search-wiring.ts`,
`landing/chat-react/*` (ChatApp/config/controller/main + 9 test files),
`app/lib/chat-core/*` + `app/components/ChatSyncSurface.tsx` + 5 app test files,
chat-core's own internals + tests, `message-search/*`.
**Accept:** one scope repo-wide (`git grep "@neutron/chat-core"` → 0); `bun install`
regenerates the workspace symlink; **Expo bundle exports + web chat bundle build**
(bundler-graph accept — grep alone misses metro resolution,
[[refactor-deletion-served-by-path-trap]] class); chat-core + message-search + app +
chat-react suites green. **Depcruise: band-neutral** (config matches path `chat-core/`,
not the npm scope). Memory note [[neutron-open-app-chat-core-wiring]]: metro monorepo
config is load-bearing — verify an actual `expo export` (or the repo's equivalent), not
just tsc.

---

## 8. L6 — `@neutronai/wire-types` leaf + option-shape unification · `opus` · L · lane transport+clients

**Deps: L2 (AgentEngagementMode in contracts), L4 (workspace-promotion mechanics
proven), L7 (scope settled — the new package imports/re-exports chat-core-adjacent
types under the final scope), W5 (transport-lane order S0→W3a→W5→L1→L6). LAST L-unit.
W4 (Expo shell) is gated on L6, not vice versa.**

One node-free leaf workspace `wire-types/` (`@neutronai/wire-types`, contracts band —
add `'^wire-types'` to `L.contracts` + `includeOnly` same-PR) owning:

| What | Current sources (verified) | Action |
|---|---|---|
| app-ws envelope union | `channels/adapters/app-ws/envelope.ts` (**951** lines now; brief said 931) | move types; envelope.ts becomes a re-export barrel (channels-internal value helpers stay) |
| THE canonical option shape (5 near-identical today) | `ButtonOption` `channels/button-primitive.ts:59`; `AppWsOutboundAgentMessageOption` `envelope.ts:181`; app mirror `app/lib/ws-envelope.ts:98`; `ChatMessageOption` `chat-core/types.ts:22`; `InlineChoice` `channels/types.ts:131` | one wire shape + explicit render projections where semantics differ (do NOT flatten lossy mappings silently) |
| topic-id derivation | server `appWsTopicId`/`appWsProjectTopicId` `channels/adapters/app-ws/envelope.ts:927/:942` ↔ browser mirror `landing/chat-react/config.ts:133/:145` (brief's 120-136 drifted) | single source in wire-types; delete the config.ts inline mirror (it exists only to keep the browser bundle channels-free — wire-types being node-free removes the reason) |
| doc-link build/parse | `runtime/doc-links.ts` (918) ↔ `app/lib/doc-links.ts` (493) byte-twin | shared core in wire-types; delete the app mirror |
| `TabDescriptor` | canonical `tabs/registry.ts:67` + mirrors `app/lib/tabs-client.ts:41`, `landing/chat-react/tabs-client.ts:43` | type into wire-types (or re-export from tabs — both contracts band); delete both mirrors |
| `AgentEngagementMode` | `contracts/agent-engagement.ts` (post-L2) | re-export only — do not duplicate |

Delete the hand mirrors (`app/lib/ws-envelope.ts`, `app/lib/doc-links.ts`, both
`tabs-client.ts` mirror types, `app/lib/projects-client.ts:24-29` engagement mirror)
**only after** the G3 parity tests pass against the shared package — then convert each
parity test into a plain import-and-use test (they stop being drift guards and become
contract tests; keep, don't delete).

**Care:** the "label must carry display text" contract on InlineChoice mappings —
`channels/adapters/app-ws/adapter.ts:731` and `:870` (brief's 865-872 confirmed ~exact);
options for a live agent reply are STRIPPED from persisted body
([[neutron-open-liveagent-options-stripped-from-body]]) — the unification must not
change what rides in `options_json` vs body. Lossy mappings preserved explicitly with a
projection function per surface.

**Accept (incl. audit §3.10's added lines):** ~1,300 mirrored lines deleted; G3 parity
tests import one source; **bundler-graph accepts: metro/Expo bundle exports clean
(app-bundle-purity depcruise rule must show wire-types as a legal reach — node-free
verified by the rule's reachability check) AND the web chat bundle builds**;
`typecheck-all.sh` green. **Depcruise: band-neutral-to-improving** — new edges
app→wire-types / chat-core→wire-types / channels→wire-types / landing→wire-types are
all downward; zero baseline growth (G8 guard enforces).

Tests staying green: `app/__tests__/ws-envelope-parity.test.ts`,
`tab-descriptor-mirror-parity.test.ts`, `agent-engagement-mode-mirror-parity.test.ts`,
`runtime/__tests__/doc-links-parity.test.ts` + `doc-links.test.ts`,
`channels/adapters/app-ws/__tests__/*` (attachments/edits/cross-channel-parity),
telegram `doc-refs.test.ts`, chat-react suite, chat-core suite. Tests that MOVE: the
parity tests' import targets flip to wire-types (same assertions).

---

## 9. The extraction ORDER (dependency-gated sequence)

```
            [K11 MERGED]  ← phase-entry hard gate (not parked; STATUS pin + audit §3.2)
                 │
                L0   SCC/anchor refresh (rebuild scanner, re-derive cut list vs HEAD)
                 │
   (transport lane: S0 → W3a → W5 must not queue behind L1 — audit §3.3)
                 │
                L1   chat-protocol leaf            (lane transport)
                 │
                L2   contracts leaf                (EXCLUSIVE multi-lane)
                 │
        ┌────────┴────────┐
        L3 (a→f, then g)   L4  manifests           (parallel OK — disjoint files;
        │   composer+data  │   lane ci              L4 dep-snapshot re-run post-L3)
        │                  │
        │                  L5  autofix batches     (EXCLUSIVE repo-wide; after L4)
        │                  │
   [C1 UNBLOCKED           │        [W5 merged]
    only after L3c]        │            │
                           └──→ L7  scope rename   (after W5 AND after L5 batches;
                                    │               exclusive vs L5)
                                    L6  wire-types (LAST; needs L2+L4+L7+W5)
```

Hard gates, restated with their reasons:

1. **K11 merged → L-phase entry.** L1 extracts from `landing/server.ts` and L2 edits
   `chat-bridge.ts` — both are K11a/K11b surgery sites (audit §2 items 1–5); K11 also
   shrinks/deletes protocol symbols L1 would otherwise move. "Merged, not parked."
2. **L0 before L2/L3** — the 11-edge cut list predates #178–#224; all 11 verified alive
   at `fd814d9` (this doc), but K11 invalidates that verification, and the audit's
   scanner artifact no longer exists to re-run. L0 rebuilds it; it then becomes L3g's
   and L4's accept tooling.
3. **L1 → L2** — same-file ordering on `landing/server.ts` (L1 moves the protocol
   block; L2 deletes the `:41` MOBILE_APP_URL re-export); and edge #4
   (`reminders/outbound.ts`) is split L1(ChatOutbound)/L2(WebChatSenderRegistry) —
   audit §3.2's "exactly one owner" is satisfied per-import, documented here.
4. **L2 → L3** — L3g's flip counts on L2's 5 baseline removals; L3a-e repoint against
   contracts/ homes L2 creates.
5. **L3c before C1** — resolveOpenDbPath is a live-data hazard (which DB gets migrated
   vs booted); its **boot-vs-runner agreement test does not exist today and must be
   written in L3c** (runner-CLI precedence tests exist; the cross-entrypoint pin does
   not). C1's BootConfig work rebuilds this exact plumbing.
6. **L4 → L5** — the autofix target specifiers don't resolve without manifests.
7. **W5 → L7 → L6** — W5 edits chat-core internals (live socket fixes first); L7
   renames the scope those edits sit under; L6 builds the wire-types package under the
   final scope. L7 must also not run concurrent with any L5 batch (both are
   specifier-rewrite sweeps).
8. **Trident-lane self-surgery rule does NOT apply** (no L-unit modifies the
   orchestration machinery) except L3f's `trident/task-slug.ts` extraction — apply the
   audit §3.6 post-merge no-op canary to that one PR.

### Dispatch table

| Sub-unit | Model | Lane | Deps | Size | Accept (headline) |
|---|---|---|---|---|---|
| L0 scanner+refresh | sonnet | none | K11 | S | scanner committed; cut list re-derived; anchors confirmed |
| L1 chat-protocol | sonnet | transport | K11, L0, (S0/W3a/W5 not queued) | M | grep: only build-landing-stack imports landing/server; JSDoc byte-identical; optional new depcruise rule |
| L2 contracts | sonnet | EXCLUSIVE (engine+bridge+cores+transport files) | L0, L1 | M | baseline 21→16; 6 grep-zeros; parity tests green; contracts/ node-free |
| L3a open-injection | sonnet | composer | L2 | S | grep: gateway imports zero open/ files; boot tests green |
| L3b substrate-text | sonnet | composer | L2 | S | baseline −2; reminders suites green; FIX #347 param intact |
| L3c db-path | **opus** | data | L2 | S | baseline −2; NEW boot-vs-runner agreement test; resolution order byte-equal |
| L3d invite-token | sonnet | none | L2 | S | baseline −1; NOT under connect/api/; invite surface tests green |
| L3e project-emoji | haiku | none | L2 | S | baseline −1; 6 importers repointed |
| L3f cycle breaks | haiku | none (trident canary) | — | S | both no-cycles baseline entries deletable; `tsc -p trident/tsconfig.json` |
| L3g flip | orchestrator | — | L3a-f | S | baseline = 10, all survivors owner-assigned to other phases; scanner SCC=∅ (type edges incl.) added to CI |
| L4 manifests | sonnet | ci | L2 (snapshot post-L3) | M | declared-vs-actual delta 0; depcruise byte-identical; bun install clean |
| L5 batches | haiku | EXCLUSIVE repo-wide | L4 | M×N | per-batch: suite green + depcruise byte-identical; final: relative escapes 0 + CI rule |
| L7 scope | sonnet | clients+transport | W5, no live L5 batch | S | grep 0; expo export + web bundle build |
| L6 wire-types | **opus** | transport+clients | L2, L4, L7, W5 | L | ~1,300 mirror lines deleted; parity tests one-source; metro+web bundler-graph accepts |

---

## 10. Staleness / owner flags (decision queue additions)

1. **[STALE-BRIEF] L2/ImportJobRunnerHook** — K3 already extracted it
   (`onboarding/interview/import-runner-hook.ts`); consumer edge is band-legal. Dropped
   from L2 scope (optional 1-line repoint).
2. **[STALE-BRIEF] edge #7** — `landing/server.ts:41`'s `MOBILE_APP_URL` re-export has
   zero external importers at HEAD: delete, don't relocate-and-shim.
3. **[STALE-BRIEF] L3(b)** — moving `reminders/outbound.ts` into gateway is unnecessary
   post-L1/L2; only `collectTokensToString` relocates. Less churn, same DAG.
4. **[STALE-EVIDENCE] audit artifacts** — `depgraph.ts`/`edge-table` source data not on
   disk; L0 rebuilds (this is a small scope ADD vs the 07-02 plan).
5. **[NEEDS-TEST — flagged per task] L3c** — no boot-vs-runner db-path agreement test
   exists (runner-CLI precedence tests at `migrations/runner.test.ts:333-365` are the
   only coverage). L3c writes it before moving code.
6. **[OWNER] naming** — `@neutronai/open-composer` vs `@neutronai/open` (L4);
   `contracts/` as the leaf-dir name (L2 — alternative: fold the emoji lookup into
   `tabs/` instead of contracts, L3e).
7. **[OWNER/ORCH] tsPreCompilationDeps** — deliberately NOT flipped (would grow the
   baseline, forbidden by G8's shrink-only guard). Type-edge regression protection comes
   from the L0 scanner as a CI assert at L3g. If Ryan prefers depcruise-native type-edge
   enforcement instead, it needs a one-time governed re-baseline — decision row, not a
   default.
8. **[COORDINATION] K11a ↔ L2 item 6** — `WebChatSenderRegistry`'s neutral-module home
   is being created by K11a (audit §2 mandatory extraction 1); L2 lifts the interface to
   contracts from wherever K11a put it. The L2 build agent must read K11's merged diff
   first.
9. **[SEQUENCING — inherited pins, restated]** K11 → L0 → L1 → L2 → L3 → C1;
   L3c before C1; W5 → L7 → L6; L5 exclusive; L2 exclusive. Anchor re-grep is per-unit
   mandatory (audit §3.5) — every file:line in this doc was verified at `fd814d9` and
   must be re-verified post-K11 by L0.
