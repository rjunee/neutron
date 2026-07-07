# Extensibility Critic — "Easy to Add Features" Audit

**Dimension:** extensibility · **Date:** 2026-07-02 · **Repo:** /Users/ryan/repos/neutron-open @ d30280c

## 0. Method — this audit is empirical, not projected

The charter asked me to case-study two "QUEUED" plans. Both plans in fact **substantially shipped** (with no status update in the plan files), which upgrades the audit from prediction to measurement: I can count the *actual* files each feature touched from git history, attribute each touch to an architectural cause, and compare against what a clean architecture would have required.

Shipping PRs located:

| Feature | PR(s) | Files touched | Insertions |
|---|---|---|---|
| Per-project Settings tab + credential store (plan Phases 1,2,4,5) | #149 `ca78517` | **33** | 3,293 |
| Cores credential resolution (plan Phase 3, partial) | #154 `6140b07` | **11** | 649 |
| Codex credential scope correction (follow-up) | #169 `3c252c6` | **19** | 1,005 |
| Agentic per-project kickoff (reduced wow-moments plan) | #151 `dbb2901` | **9** | 1,343 |
| Chat collapse → single Expo surface | #122 `a133b38` | **33** | +1,403 / −3,635 |

The plan files still say otherwise: `docs/plans/2026-06-30-per-project-settings-tab-credential-scoping-plan.md:5` — "PLAN-ONLY. No code written." (44+ files shipped across #149/#154). The wow-moments plan carries no record that #151 shipped its reduced core.

---

## 1. Case study A — Per-project Settings tab + credential scoping

### 1.1 Actual touch-points (PR #149, 33 files), attributed by cause

**(a) Declaring one new tab — 6 files, 3 of them hand-mirrors:**
- `tabs/registry.ts:131-136` (the legitimate registry descriptor)
- `tabs/__tests__/registry.test.ts`
- `app/lib/project-tabs.ts` (`PROJECT_TABS` pre-fetch loading-default mirror, `project-tabs.ts:44,119-126`)
- `app/lib/last-tab-storage.ts:27-35` (`LastTabValue` union + `LEGAL_TABS` allowlist — hand mirror of the registry)
- `app/__tests__/project-tabs.test.ts`, `gateway/__tests__/app-tabs-surface.test.ts` (assertion updates)

Plus per-platform view registration that the "registry-driven" claim doesn't cover: web `ProjectShell.tsx:204` (`if (tab.mount.target === 'settings')` — a hardcoded switch branch per builtin, alongside `:169` docs, `:181` workboard, `:193` admin), and a mobile expo route file whose filename must equal `mount.target`. A "registry-driven" tab still costs **7-8 touch points**.

**(b) The dual-frontend tax — 8 files, ~1,500 lines (≈45% of the PR):**
- `landing/chat-react/SettingsTab.tsx` (453 lines) + `app/app/projects/[id]/settings.tsx` (640 lines) — the same screen twice
- `landing/chat-react.html` (+59 — the inline design-system stylesheet)
- `landing/chat-react/project-credentials-client.ts` (178) + `app/lib/project-credentials-client.ts` (150) — the 17th/18th bespoke HTTP-client twins
- `landing/chat-react/ProjectShell.tsx`, `app/lib/projects-client.ts` (+14, containing the comment-lockstep type mirror: `app/lib/projects-client.ts:26` "this duplicate must stay in lockstep")
- client test files

**(c) HTTP surface bookkeeping — 5 files, ~7 distinct edit sites, zero feature logic:**
- `gateway/http/project-credentials-surface.ts` — the surface itself, containing verbatim copy N of `resolveBearer` (`:179`) and `jsonError` (`:226`); `grep -c 'function resolveBearer' gateway/http/*.ts` = **19**
- `gateway/http/compose.ts` — 4 edit sites: interface `:218`, input field `:579`, destructure `:862`, ladder step `:1139-1146` (with a hand-written precedence comment "Mounted BEFORE appProjects")
- `gateway/composition.ts` — 2 edit sites: field mapping `:228-230` AND the `hasAnyChainedSurface` gate `:290` (the dual-list the gateway-services mapper showed is already diverged for other fields; every field optional, so forgetting one compiles clean and 404s silently)
- `gateway/composition/input/app-surfaces-input.ts:276`
- `open/composer.ts` — construct store `:987`, construct surface `:2188`, return-literal wire `:3604` (+27 lines in the 3,732-line god closure)

**(d) Store + migration — 5 files:** `project-credentials/store.ts` (411 lines, in a **new floating root directory with no package.json**, not in the workspace list; `defaultUlid` copy-pasted from `work-board/store.ts:171` → `project-credentials/store.ts:131`, exactly as the plan instructed: "copy `defaultUlid`"), store test, `migrations/0092_project_credentials.sql`, `migrations/expected-schema.txt`, `migrations/runner.test.ts`.

**(e) Agent awareness — 3 files:** `project-credentials/fragment.ts` + test, and `gateway/realmode-composer/build-live-agent-turn.ts` (+52) which gained a bespoke optional callback `availableServicesSnapshot` (`build-live-agent-turn.ts:469-478`) with hand-managed cold-turn-vs-warm-turn splice semantics (`:738-746`) — the second such per-turn fragment after `workBoardSnapshot`; each new per-turn context block repeats this pattern.

**(f) Settings PATCH extension — 3 files** (`app-projects-surface.ts`, `gateway/projects/sqlite-store.ts` + test) — see §1.3 for the per-setting fan-out this implies.

### 1.2 Phase 3 (PR #154) — the architecture forced a half-feature

The plan's "meaty part" (Cores resolve from the active project) shipped with a structural carve-out. Because Core tool handlers receive **args only** — `wrapHandler` drops `ToolCallContext` (`gateway/cores/install-bundled.ts:957-964`) — there is no per-call project threading through tool dispatch. The fix bolted an `AsyncLocalStorage` frame at exactly one boundary (chat-bridge wraps chat-command `match()`; #154's chat-bridge.ts edit), and the resolver reads ambient state (`gateway/cores/core-credential-resolver.ts:33` imports `currentActiveProjectId`).

Consequence, documented in the code itself: `gateway/cores/active-project-context.ts:16` — "When NO frame is bound (the General topic, **or the CC-spawn MCP-tool path** …) → global scope." I.e. **any tool call made by the actual agent over the MCP tools-bridge resolves credentials at global scope** — the per-project feature works only for in-process slash-commands. The PR message calls per-project MCP threading "the documented next slice"; it has not shipped.

Then #169 (19 files) had to *correct the scope* of one credential (Codex: per-project → global-with-override), touching `trident/codex-credential.ts`, `trident/codex-auth.ts`, `trident/orchestrator.ts`, `gateway/http/codex-credential-surface.ts`, `gateway/http/compose.ts`, `gateway/composition/*`, `open/composer.ts`, `SettingsTab.tsx`, `IntegrationsTab.tsx`, clients — evidence that credential-scope policy is smeared across three stores (`auth/secrets-store`, `project-credentials/store`, trident codex) plus a hardcoded `SERVICE_SCOPE` table (`core-credential-resolver.ts:47-51`) rather than being one policy surface.

### 1.3 The per-setting fan-out (measured on the existing `agent_engagement_mode`)

One enum-valued per-project setting today lives in **9 production files** (grep, tests excluded): `migrations/0088_…`, `gateway/projects/sqlite-store.ts`, `gateway/http/app-projects-surface.ts` (PATCH validation), `gateway/http/chat-bridge.ts` (consumer), `gateway/realmode-composer/build-landing-stack.ts`, `app/lib/projects-client.ts` (comment-lockstep mirror), `cores/free/agent-settings/src/backend.ts`, `connect/agent-engagement.ts` (**the type is homed in the dormant federation package**), `migrations/0093` — plus UI in the mobile drawer only (web `SettingsTab.tsx` has no engagement control: settings UI has already drifted across the two frontends). The wow plan's `agentic_openings: on|digest|off` setting will pay this full fan-out.

### 1.4 Score

Actual: **44 files + a 19-file corrective PR + an architecturally-blocked remainder.** A clean architecture (declarative surface registry + shared client core + settings registry + context-threaded tool dispatch): ~10-12 files — the store, the migration, one surface module, one registry entry, one shared client, one UI component, one settings descriptor, one fragment provider. Roughly a **4x touch tax**, dominated by dual-frontend duplication, wiring bookkeeping, and hand mirrors.

---

## 2. Case study B — Agentic per-project wow moments

### 2.1 What shipped (#151) — and the reuse that didn't happen

The plan's §2.1 principle was "Do **not** fork the action model… reuse `WowActionModule` + `ActionRunner` + generalize `pickWowActions`." What shipped:

- The feature landed as `gateway/realmode-composer/build-project-kickoff.ts` (459 lines) + `build-project-kickoff-composer.ts` — **product feature logic inside the gateway wiring library**, importing *upward* into `onboarding/history-import/types.ts` and `onboarding/wow-moment/{project-materializer,project-identity}.ts` (`build-project-kickoff.ts:53-58`).
- It **forked the contract instead of reusing it**: zero imports of `WowActionModule`/`ActionRunner`/`pickWowActions`; it defines its own `KickoffMatch`/`KickoffInput`/`KickoffResult`/`ProjectKickoff` (`build-project-kickoff.ts:74-142`). The header says why: "mirroring the wow `WowActionModule` trigger/run contract **without dragging in the button-prompt/cron `ActionRunner` that the one-time plain-emit finalize path has no channel adapter for**" (`:27-29`).
- Root cause is the context shape: `WowActionContext` (`onboarding/wow-moment/action-types.ts:132-179`) is a ~15-field onboarding-shaped bag — `interview`, `import_result`, `rituals`, `contemplative_keywords`, `stalled_threads`, `gmail_scopes`, `channel: WowChannelAdapter`, `cron_jobs`, `cron_state`, `db`, `gmail`, `materializer` — that a non-onboarding caller cannot honestly construct. The first real second consumer proved the "reusable contract" is not reusable. Plan Phase A (extract a `pickActions` core) was never executed (`grep pickActions onboarding/wow-moment/llm-selector.ts` → nothing).

So the wow subsystem now has **two parallel action stacks** (the onboarding wow catalogue + the kickoff mirror), and the still-queued recurring version would naturally become a third.

### 2.2 The queued remainder — projected touch list in today's architecture (~25-30 files)

Named, per the plan's own phases against today's code:

1. `onboarding/wow-moment/llm-selector.ts` — extract the selector core (A1)
2. New payload builder + `prompts/project-opening/agentic-move-picker.md` (A2)
3-7. Four action modules + registry — and per `catalogue.ts:16-18`'s own instructions, each candidate action costs **5 edit sites** (module, imports, `CANDIDATE_IDS`, `WowActionId` union in telemetry.ts, picker prompt)
8. `ProjectOpeningDispatcher` (new)
9. `action-types.ts` context extension — or, per the kickoff precedent, another fork
10-12. `project_opening_state`: migration + `expected-schema.txt` + another hand-rolled store class
13. Cron registration: hand edit in `gateway/composition/build-core-modules.ts` (the 999-line module where overnight `:53,623-624` and telemetry sinks `:536` already register)
14. `open/composer.ts` wiring (+~25 lines; #151 paid +25, #149 +27, #154 +19, #169 +38 — the composer grows on every feature)
15. Staging channel adapter — and here the plan is silent about a live landmine: the **duplicated sender registries** (`web:` chat-bridge registry vs `app:` appWsRegistry) already misrouted timer-fired sends once (PR #105, reminders had to be re-pointed at the `app:` registry); a cadence-staged bubble must pick correctly again
16. Telemetry namespace under `onboarding/telemetry` (a `project_opening.*` vocabulary inside the *onboarding* package)
17-24. The `agentic_openings` setting: the full §1.3 nine-file fan-out
25-31. v2 `project_topic_open` WS frame: `channels/adapters/app-ws/envelope.ts` + `adapter.ts` + the bespoke `appWsReceiver` in `open/composer.ts:3082` + `app/lib/ws-envelope.ts` hand mirror + parity test + web controller + client senders ×2

### 2.3 Score

Clean architecture (neutral agentic-actions package with narrow capability contexts, settings registry, cron self-registration from feature modules, one frame schema): **~10 files**. Today: ~25-30, spread across five packages, two god files, and one dormant-package type home — plus the demonstrated risk that the implementer rationally forks rather than reuses.

---

## 3. Case study C — Chat collapse → single surface

### 3.1 What #122 proved about the wire-model fan-out

Adding four fields (`image_urls`, `citations`, `doc_refs`, `deep_link`) to an agent message required coordinated edits at: `chat-core/types.ts` (model + `parseCitations`/`parseDocRefs` + `normalizeInbound`, `:222-225,497-503`), `chat-core/store.ts` (`pickAgentMeta` merge law, `:147-171`), `chat-core/sync-engine.ts` (`applyInbound`, `:87-93`), `app/lib/chat-core/sqlite-store.ts` (columns + `rowToMessage`), plus render surfaces. The shipping PR **missed the sync-engine copy site** — live-socket and resume paths silently dropped the new fields despite the new SQLite columns — and it was caught only by an external Codex review (P1 in the PR's own commit log). When a routine model extension requires 5+ synchronized copy sites and the author of a carefully-planned PR misses one, the architecture — not the author — is the defect.

### 3.2 The collapse is structurally incomplete — two gaps no client PR can close

1. **Resume replay drops ALL agent metadata.** `channels/adapters/app-ws/adapter.ts:831-840` (`appChatRowToEnvelope`, agent branch) reconstructs only `body/message_id/ts/seq/project_id` because `app_chat_messages` never persisted options/prompt_id/citations/image_urls/doc_refs/attachments — they live only in `button_prompts` (with `[[OPTIONS]]` stripped from body, options in `options_json`). A message first delivered via resume (client offline at send time) **permanently** lacks its option buttons and citations; `pickAgentMeta` can't resurrect what never arrived. The spec's "gap-free resume … FULL parity" is unachievable until the durable transcript is unified (the chat-transport mapper's P1).
2. **The repo still has a second chat frontend, already behind.** `grep -a citations|doc_refs landing/chat-react/*.ts*` → zero hits: the React web client renders neither citations chips nor doc-ref buttons that mobile now renders. "ONE surface" was achieved *within Expo*; repo-wide there remain two chat render stacks (three counting the server's `button_prompts` history projection), and they measurably diverged within days of the collapse.

### 3.3 Score

The collapse PR itself was a model consolidation (net −2,232 lines) — the payoff of deleting a duplicate stack. But the *next* chat feature still pays: server envelope + chat-core normalize + store merge + sync-engine + app sqlite + app render + web controller + web render ≈ **7-8 copy sites**, with the observed failure mode being a silently-missed site.

---

## 4. Where adding a feature hurts most (ranked, with the evidence)

1. **The dual-frontend tax** — every screen/feature ×2 UIs, ×2 HTTP clients, ×2 wire-type mirrors, inline CSS; ~45% of #149's volume; drift already observable (citations on mobile only, engagement UI on mobile only).
2. **The wire/durable-model fan-out** — 3 durable chat models + 5-8 copy sites per field/frame; missed-copy-site is the *demonstrated* failure mode (#122 Codex P1; PR#144 options-stripped trap; PR#105 registry split).
3. **HTTP surface bookkeeping** — 4 files/~7 edit sites of pure wiring per surface + the Nth `resolveBearer` copy (19); paid three times in three weeks (work-board #127, project-credentials #149, codex-credential #167/#169).
4. **No home for product features + god-file composition** — features land in `gateway/realmode-composer` (kickoff), floating root dirs (`project-credentials/`), or `onboarding/wow-moment`; `open/composer.ts` absorbs +19…+38 lines per feature as the single composition point.
5. **Un-reusable "reusable" contracts** — the wow action contract forked by its first second consumer; the selector generalization deferred and then skipped.
6. **Missing per-call context threading** — no `ToolCallContext` through tool dispatch ⇒ per-project behavior (credentials today; anything project-aware tomorrow) is ALS-bolted at one boundary and silently global elsewhere.
7. **Per-setting fan-out** — 9 files per project setting, type homed in dormant `connect/`.
8. **Registration-point sprawl** — cron jobs, telemetry sinks, prompt fragments each require hand edits to central files (`build-core-modules.ts`, `build-live-agent-turn.ts` bespoke optional callbacks).

## 5. Refactor requirements derived (what would make these three features cheap)

- **R1. Declarative surface registry + `surface-kit`** — one `{key, match, handler, gated, order}` entry per surface generating the compose interface/mapping/gate/ladder; shared `resolveBearer`/`jsonError`/`readJsonBody`. Locks: existing compose.test.ts precedence assertions; byte-identical `{ok:false,code,message}`.
- **R2. Shared client-core workspace package** (wire types + HTTP clients + view-models) consumed by both `app/` and `landing/chat-react` — chat-core already proves the bundler constraint is satisfiable (node-free leaf). Kills the client twins and the comment-lockstep mirrors.
- **R3. Single durable transcript**: widen `app_chat_messages` with agent-metadata columns; write options through; make resume replay carry them; shrink `button_prompts` to prompt lifecycle. Precondition: a hydration-parity test (HTTP history vs WS resume vs live). This is the *enabler* for the chat-collapse spec's own acceptance criteria.
- **R4. One frame-schema leaf module** shared by server envelope, chat-core decoders, and app mirror — replaces 3 hand-synced declarations + parity tests with imports.
- **R5. Feature-module composition**: decompose `open/composer.ts` into per-feature wiring modules with a narrow typed context; a new feature adds a module + one registration, not edits inside a 3.2k-line closure. (Matches the boot-composition mapper's P0; my data shows the *marginal* cost: every feature PR edits the closure.)
- **R6. Thread `ToolCallContext{project_id, topic_id}` through `McpServer.dispatch` → tools-bridge → Core handlers**; retire the ALS-at-one-boundary pattern; then per-project credentials work on the MCP path and every future project-aware tool is free.
- **R7. Extract the agentic-action contract** (module/runner/selector) from `onboarding/wow-moment` into a neutral package with capability-scoped context slices; re-home the kickoff onto it; the recurring wow feature becomes a catalogue + a dispatcher, not a third fork.
- **R8. Per-project settings registry** — a typed descriptor (key, type, default, validation, UI hint) driving the PATCH surface, both clients, and both UIs; move `AgentEngagementMode` out of `connect/`.
- **R9. One-touch tabs** — derive `LEGAL_TABS`/`PROJECT_TABS` from the registry (or the tabs payload); replace the `ProjectShell` target-switch with a client-side view registration map.
- **R10. Registration seams for cron/telemetry/prompt-fragments** — feature modules export descriptors; `build-core-modules.ts` and `build-live-agent-turn.ts` iterate collections instead of growing bespoke optional inputs.

## 6. Load-bearing subtleties a refactor must not break (from these paths)

- Compose ladder order is semantic (credentials mounted BEFORE appProjects, `compose.ts:1139`; chunked-before-legacy upload); a registry must encode today's order as an explicit list with a transition test asserting generated set/order == current literals.
- `hasAnyChainedSurface` and the field mapping must move together (already diverged for 3 fields per the gateway-services map).
- The `SERVICE_SCOPE` global carve-out for gmail/calendar (`core-credential-resolver.ts:47-51`) is deliberate no-re-consent policy — context threading must not flip those to per-project.
- Kickoff's dedupe rides the `onboarding_opening:<project_id>` durable slot (`build-project-kickoff.ts:15-19`); a recurring dispatcher must keep one-time semantics for already-fired projects.
- `pickAgentMeta` is additive/incoming-wins (`chat-core/store.ts:147-171`); transcript unification must not let a metadata-less replay row clobber richer local state.
- Client stores differ: op-sqlite needs explicit columns; OPFS snapshots whole `ChatMessage` JSON (`chat-core/stores/opfs-store.ts:23,33` — no columns needed). "Mirror the columns" plan steps are store-specific; the plan's Phase A step 4 was correctly (but silently) skipped.
- `button_prompts.body` has `[[OPTIONS]]` stripped — any consumer migration must read `options_json`/`latestPromptByTopic`, never re-parse body (PR#144 trap).
- Staged/timer-fired sends must target the `app:` registry (PR#105); the durable rail/badge path comes from `button_prompts` history regardless of live registry.

## 7. Cross-checks / corrections to the brief

- The chat-collapse doc is at `docs/plans/2026-06-29-chat-collapse-single-surface.md` (not `docs/specs/`).
- Both "queued" plans are substantially shipped (#149/#154/#151); the plan files carry stale status headers — an extensibility hazard in itself (an agent tasked with "build the queued plan" would re-build shipped work; this audit nearly analyzed fiction).
- `chat-core/types.ts` classifies as binary to BSD grep (UTF-8 punctuation triggers data classification); plain grep silently returns nothing — use `grep -a`. This cost the audit one false lead and could cost a refactorer a missed reference during the very consolidation work recommended here.
