# Vajra → Neutron Feature-Parity Deep Scan (evidence-based)

**Date:** 2026-06-25
**Author:** Atlas (Vajra fleet)
**Method:** Every PRESENT / PARTIAL / MISSING verdict cites a file path (and line) actually read across `~/vajra`, `~/repos/neutron-open`, `~/repos/neutron-managed`. NO inference from "category." Box checks (`ssh neutron-prod`) are tagged `[BOX]` and held distinct from `[CODE]` checks.

**Framing under test:** Neutron = single-owner agent harness / faithful Vajra port. Neutron **Open** = the primary single-owner product (NO multi-tenant notion). Neutron **Managed** = a hidden hosted overlay running MANY **isolated** single-owner instances (per-tenant systemd unit + subdomain + bot). Canonical wording: `~/repos/neutron-managed/CLAUDE.md:5` + `SPEC.md` Decisions Log 2026-06-25.

---

## 0. HEADLINE VERDICT

**Neutron Open is a largely faithful port of Vajra's daily-driver core, and the scribe is genuinely wired and firing on every chat turn.** The earlier "Neutron has no scribe" / "scribe is unwired/Managed-only" claims are **FALSE** — they came from surveying only the DI module graph (`gateway/composition.ts`) and missing the Open composer (`open/composer.ts`), which is where the realmode daily-driver layer (scribe, reflection, doc-search, GBrain, reminders) is actually wired. See §2 and the **METHOD WARNING** below.

> **METHOD WARNING (the trap that produced the wrong mental model).** Neutron has **two composition paths**:
> 1. `gateway/composition.ts` — the DI module graph (channels, onboarding-telemetry, reminders module, tasks, watchdog, trident, cron).
> 2. `open/composer.ts` (`buildOpenGraphComposer`, booted by `open/server.ts:31`) — the **realmode/landing-stack** composer that wires the conversational daily-driver layer: scribe, reflection, GBrain, doc-search, reminder dispatcher, live-agent turn.
>
> A survey of only #1 reports scribe/reflection/doc-search/typing as "unwired / Managed-only." That is the exact error the orchestrator and the first mapping pass made. The Open product boot path is `open/server.ts → buildOpenGraphComposer → boot()` (`open/server.ts:12-31`), and it wires all of them. **This document's verdicts are from direct reads of both paths.**

**Genuine gaps** (verified, §5): phase-2 Cores→scribe fan-out is built-but-unwired; Calendar/Email/Google-Workspace Cores are not composed into Open (Managed-side only); travel and IG/X scraping are absent; the Vajra multi-agent Forge/Atlas/Sentinel/Argus family is collapsed into the single Trident dispatch loop.

**Doc-drift:** ~10 lines across 4 files still call Neutron "a multi-tenant agent platform / productization … refactored for multi-tenant deployment." Itemized in §4.

---

## 1. SCRIBE — WIRED-AND-RUNNING VERIFICATION (priority) ✅ TRUE TODAY

Ryan's requirement: *"constantly scanning the chats and automatically saving things to gbrain."* **This is TRUE in Open today, at the code level, with the binary present on the box.** Trace:

### 1.1 Construction (per-instance, at composer boot) — `[CODE]`
- `open/composer.ts:410-423` builds a dedicated `cc-scribe-<handle>` LLM substrate (ephemeral, isolated from the chat REPL), **gated on `llmPool !== null`**.
- `open/composer.ts:433-448` builds GBrain memory (`buildGBrainMemory`) and constructs the scribe: `createScribe({ substrate, syncHook: gbrain.syncHook, ownerDataDir, project_slug, budget })`.
- `open/composer.ts:485-486` defines `scribeOnUserTurn = (input) => scribe.handleUserTurn(input)`.
- `open/composer.ts:689` threads `scribeOnUserTurn` into `buildLandingStack` → the chat-bridge.

### 1.2 Per-turn firing (NOT built-but-unwired) — `[CODE]`
The chat-bridge fires `scribeOnUserTurn` on **every** real user message, across all three inbound paths:
- `gateway/http/chat-bridge.ts:1604-1622` — project-topic stub turn.
- `gateway/http/chat-bridge.ts:1689-1707` — live-agent turn (post-onboarding chat).
- `gateway/http/chat-bridge.ts:1742-1759` — onboarding-engine turn.

All three are fire-and-forget + try/guarded ("extraction must never block the chat path"), author-stamped `{id:'owner', display:'owner'}`. The hook is invoked **unconditionally** when `opts.scribeOnUserTurn !== undefined` — and it is defined whenever `llmPool` exists. So on any LLM-enabled box, **every user turn triggers an extract attempt.**

### 1.3 Extract → GBrain persistence — `[CODE]`
- `scribe/index.ts:182-242` `extractAndWrite`: pre-filter → budget gate → `runExtraction` (LLM) → `writeExtractionToGBrain`.
- `scribe/write-to-gbrain.ts:1-17` — fans each extracted entity through the **real** `runtime/entity-writer.ts:writeEntity`; the writer's `syncHook` (per-instance `GBrainSyncHook`) calls GBrain `put_page` (page body) + `add_link` (typed edges from `[[wikilink]]` predicates). **"This is the SAME path admin Memory + onboarding use — scribe does not invent a second write boundary."**
- Append-only safety: `write-to-gbrain.ts:19-41` — existing pages are read, compiled-truth preserved verbatim, new facts appended to the timeline; frontmatter merged (no data loss / no edge retraction).

### 1.4 GBrain wiring + health — `[CODE]` + `[BOX]`
- `[CODE]` `gateway/realmode-composer/build-gbrain-memory.ts:102-130` — `buildGBrainMemory` spawns `gbrain serve` **lazily** per-instance, scoped to `<owner_home>/gbrain/` via `GBRAIN_HOME`. **Fail-soft:** if the `gbrain` binary is absent it logs ONE boot warning and degrades to a latched failure (entity pages still land on disk; only GBrain fan-out no-ops) — never crashes a turn (`build-gbrain-memory.ts:26-31, 119-125`).
- `[BOX]` `ssh neutron-prod` → `gbrain` present at `/usr/local/bin/gbrain`, version **0.42.40.0**. The prod box runs **neutron-managed** (`/opt/neutron-managed/src/index.ts`), the hosted overlay, with **13 real** (`/home/neutron-t-*`) + **81 test** isolated per-tenant homes — confirming the "many isolated single-owner instances" framing.
- `[BOX — BLOCKED]` Could NOT read tenant-home `entities/` or `gbrain/*.db` contents to prove on-disk extraction output: tenant homes are owned by per-tenant Unix users (0700) and the SSH user has no passwordless sudo. **On-disk proof is unverified; the code path and binary presence are verified.** To close this, run a read as a tenant user or with sudo: `sudo ls ~neutron-t-<id>/gbrain && sudo find ~neutron-t-<id> -path '*entities*' -name '*.md' | head`.

### 1.5 Cadence / budget governor — `[CODE]`
`scribe/scribe-budget.ts`: token bucket cap **10**, refill **6/min**, max **3** concurrent extracts (excess dropped, not queued), daily cap **500**, circuit breaker after **5** consecutive failures (10-min cooldown), per-instance state at `<owner_home>/.scribe-budget.json`. Pre-filters (`scribe/index.ts:174-180`): skip turns < **80 chars**, slash commands, `SYSTEM:` sentinels. Watchdog: **300 s** abort via `AbortSignal` (`scribe-budget.ts:73`).

**Scribe verdict: PRESENT-WIRED, firing per chat turn, persisting to GBrain via the production entity-writer path. Binary healthy on the box. The only unproven link is on-disk output (box-perms blocked), not the wiring.**

---

## 2. VAJRA FEATURE INVENTORY → NEUTRON MAPPING

Grouped. `[O]` = verified in `~/repos/neutron-open`. Verdicts: **PRESENT-WIRED** (module + call site) / **PRESENT-UNWIRED** (code exists, nothing invokes it) / **PARTIAL** / **MISSING**.

### A. Chat / topic agents + gateway routing
- **PRESENT-WIRED.** `channels/router.ts` registered at `gateway/composition.ts` (channels module); Open boot via `open/server.ts:28-31` → `buildOpenGraphComposer` → `boot()`. Chat over WS at `/ws/chat` (`open/server.ts:12-17`). Live-agent turn wired at `open/composer.ts` (liveAgentTurn) → `chat-bridge.ts:1662`.

### B. Onboarding
- **PRESENT-WIRED.** `onboarding/interview/engine.ts` state machine; onboarding-telemetry module + resume cron registered (`gateway/composition/build-core-modules.ts:445`). History-import entity populator (`onboarding/history-import/entity-populator.ts`) is the original `writeEntity` caller scribe mirrors.

### C. Memory
- **Scribe (chat→GBrain): PRESENT-WIRED** — see §1.
- **GBrain (MemPalace/KG equivalent): PRESENT-WIRED** — `gbrain-memory/index.ts`; wired via `build-gbrain-memory.ts` into the entity-writer syncHook AND the admin Memory tab (`app-admin-surface.ts`). Binary live on box (§1.4).
- **Entities wiki (compiled-truth + timeline): PRESENT-WIRED** — `runtime/entity-writer.ts`, `runtime/entity-slug.ts`; written by both onboarding populator and scribe.
- **Reflection (diary + corrections-log): PRESENT-WIRED** `[O]` — `reflection/index.ts`; constructed `open/composer.ts:476` (`createReflection`) and threaded into the live-agent turn at `open/composer.ts:599`. *(The first mapping pass wrongly called this "Managed-only" — it is wired in the Open composer.)*

### D. Reminders (/remind)
- **PRESENT-WIRED** `[O]` — `reminders/index.ts`; dispatcher built at `open/composer.ts:957` (`buildReminderDispatcher` + `buildSubstrateReminderLlm` + button-store outbound). Reminders module + tick loop also in the DI graph (`reminders/tick.ts`, `gateway/composition.ts`). LLM-composed reminder bodies via the live substrate.

### E. Proactive nudges / morning brief
- **PRESENT-WIRED** — morning-brief cron `registerMorningBriefCron()` + idle-nudge sweep `registerIdleNudgeSweepCron()` (`gateway/composition/build-core-modules.ts:772, 800`).

### F. Agent dispatch (Forge / Atlas / Sentinel / Argus) + spawn
- **PARTIAL.** Vajra's 4-agent family is collapsed into **one** autonomous loop: **Trident** (`trident/orchestrator.ts`, `trident/agent-dispatch.ts`, `trident/prompts.ts`) — build → review → merge. Registered + started at `gateway/composition.ts` (trident module) + tick loop. Process registry at `tools/process-registry.ts`. **MISSING as distinct roles:** no standalone Atlas (research), Sentinel (QA), or ad-hoc Forge/Argus spawn equivalent to `spawn-agent.sh`; Trident is the only dispatch surface.

### G. Cron / scheduled jobs
- **PRESENT-WIRED.** `cron/scheduler.ts`; scheduler explicitly started post-compose (`gateway/composition.ts:363`; the S15 2026-05-17 "scheduler never started" fix is documented in the composition docblock). Jobs registered by each module's init.

### H. Task management
- **PRESENT-WIRED.** `tasks/store.ts` (+ `tasks/prioritize-llm.ts`, `tasks/focus-score.ts`); tasks module registered, projection writer wired (`gateway/composition.ts`).

### I. Doc / vault search (QMD equivalent)
- **PRESENT-WIRED** `[O]` — `doc-search/` (BM25 over SQLite FTS5 across `<owner_home>/Projects/<id>/`). Built `open/composer.ts:377-389`, `doc_search`/`doc_read` agent tools registered `open/composer.ts:996`. Plus `message-search/` for chat history. *(Open ships its own local search; QMD's MCP collections are a Vajra-host detail.)*

### J. Google Workspace (gmail / cal / drive / sheets)
- **PARTIAL.** Core **packages** exist: `cores/free/calendar/`, and `gateway/boot-helpers.ts:181-270` `buildCoresBackendFactories({ calendarClient, googleOAuthAccessToken })` returns `calendar_core` + `google_workspace_core` factories. **But NOT composed into the Open composer** (grep of `open/composer.ts` for `calendar_core`/`google_workspace`/`installBundledCores` = empty) — these are wired on the Managed side. **In Open today: Google Workspace is not live.**

### K. Travel / flights / hotels
- **MISSING.** No SerpAPI / flight / hotel code anywhere in `neutron-open` (grep empty). Vajra owner-specific scripts; not ported.

### L. Scraping (Instagram / X / Apify)
- **MISSING.** No instagram/apify/twitter-scrape code (grep empty). Not ported.

### M. Watchdog / supervision family
- **PRESENT-WIRED.** `watchdog/supervisor.ts` registered + `supervisor.start()` (`gateway/composition.ts`); 3 detectors registered. Persistent-REPL host watchdogs under `runtime/adapters/claude-code/persistent/` (pty-ring, session-size, terminal-host). *(Open uses an in-process notifier stub at `open/composer.ts:988`; the full alert fan-out is Managed-side.)*

### N. reply / enforce-reply
- **PRESENT-WIRED.** `runtime/adapters/claude-code/persistent/hooks/enforce-reply.ts`; hook path injected via build-settings; persistent-REPL shutdown wired at `gateway/index.ts:432`. (Open's web chat is WS-native, so "reply" is the agent_message emit, not a Telegram reply tool — different-but-equivalent.)

### O. Typing indicators
- **PRESENT-WIRED** `[O]` — `emitTypingBracket(send, 'agent_typing_start'/'end', …)` brackets every Open chat turn at `chat-bridge.ts:1660, 1685, 1733` (server-deterministic, ISSUES #115). *(First mapping pass wrongly called this "Managed-only.")*

### P. Session resume / compaction
- **PARTIAL.** **Resume: PRESENT-WIRED** — cookie-only WS resume (`open/server.ts:43`), onboarding resume cron (`build-core-modules.ts:445`), reconnect-hydration in chat-bridge, inbound-received marker to avoid stale re-emit (`chat-bridge.ts:1711-1722`). **Compaction:** PTY-ring buffering exists (`runtime/adapters/claude-code/persistent/pty-ring.ts`); no verified equivalent of Vajra's 40k-warn/50k-auto-compact session-size policy surfaced in Open — **mark PARTIAL / needs-confirm.**

### Q. Trust pre-seed
- **PRESENT.** `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts` (pre-seeds Claude Code trust so the spawned REPL doesn't prompt). *(First mapping pass wrongly called this MISSING.)* Wiring depth into the persistent substrate boot is confirmed by `persistent-repl-substrate.ts` referencing it.

### R. Skill-forge
- **PRESENT-UNWIRED** `[O]` — `skill-forge/` package exists; no import from `open/composer.ts` or `gateway/composition*.ts` (grep empty). Built, not composed.

---

## 3. CORRECTIONS TO THE EARLIER MAPPING (trust-restoring)

The earlier module-graph-only pass produced these **false negatives**; corrected here with evidence:

| Feature | Wrong earlier claim | Verified reality |
|---|---|---|
| Scribe | "PRESENT-UNWIRED, Managed-only, optional hook" | **PRESENT-WIRED in Open**, fires every turn — `open/composer.ts:440/486/689` → `chat-bridge.ts:1604/1689/1742` |
| Reflection | "Managed-only" | **Wired in Open** — `open/composer.ts:476/599` |
| Typing indicators | "Managed-only feature" | **Wired in Open** — `chat-bridge.ts:1660/1685/1733` |
| Reminders | (graph-only view) | **Dispatcher wired in Open composer** — `open/composer.ts:957` |
| Doc-search | (graph-only view) | **Wired in Open composer** — `open/composer.ts:377/996` |
| Trust pre-seed | "MISSING" | **PRESENT** — `runtime/.../ensure-claude-trust.ts` |

Root cause: the daily-driver conversational layer is wired in `open/composer.ts` (realmode/landing-stack), **not** in the `gateway/composition.ts` DI graph. Any future parity check MUST read both.

---

## 4. DOC-DRIFT SWEEP (multi-tenant misframing)

Canonical correct wording is already in `~/repos/neutron-managed/CLAUDE.md:5` and `SPEC.md` (lines 30, 45, 307 / Decisions Log 2026-06-25). The following lines still mis-define Neutron as multi-tenant-first. **All line numbers verified by direct `grep -n`.**

### `~/repos/neutron-managed/docs/SYSTEM-OVERVIEW.md`
- **:19** — *"**Neutron is a multi-tenant agent platform** — the productization of Ryan's internal Vajra system."*
  → **Fix:** "Neutron is a single-owner agent harness — a faithful port of Ryan's Vajra. Neutron Open is the primary single-owner product (no multi-tenant notion); Neutron Managed is a hidden hosted overlay that runs many **isolated** single-owner instances (per-tenant gateway + subdomain + bot). 'Multi-tenant' describes only the Managed hosting layer."
- **:32** — *"A managed multi-tenant agent platform. Same Claude-Code-style operational agent runtime as Vajra …, refactored and expanded for multi-tenant deployment."*
  → **Fix:** "A managed hosting overlay running isolated single-owner harnesses. Each instance runs the same Claude-Code-style runtime as Vajra, with per-tenant Unix-user + systemd + subdomain isolation."
- *(SPEC.md:307 already flags these two as pending this sweep.)*

### `~/vajra/Projects/neutron/master-plan.md`
- **:12** — *"… refactored and expanded for **multi-tenant deployment**."* → drop "multi-tenant"; "Neutron Open is single-owner self-hostable; Managed provides hosted deployment via isolated instances."
- **:206 / :283 / :293 / :313** — "multi-tenant base platform" / "runs on the new multi-tenant platform" / "multi-tenant isolation (team-not-user schema)" / "multi-tenant base platform." These are PARA business/migration docs where the Managed overlay's isolation is legitimately multi-instance, but the **product-definition** lead ("base platform / multi-tenant") is the drift. → reframe lead as "single-owner harness; Ryan = Managed instance zero."

### `~/vajra/Projects/neutron/STATUS.md`
- **:27** — *"… refactored and expanded for **multi-tenant deployment**."* → same fix as master-plan:12.
- **:44** — *"Refactor Vajra to Neutron **base platform** (multi-tenant, …)."* → "single-owner harness; Managed adds isolated-instance hosting."

### `~/repos/neutron-managed/docs/archive/master-plan-snapshot.md`
- **:30** — *"a managed private agent platform … refactored … for multi-tenant deployment."* (archived; lowest priority — add a superseded header or fix in place.)

### Already-correct (sweep was thorough)
- `~/repos/neutron-open/README.md:3-9` — "self-hosted agent harness … you run it yourself … your own Claude subscription." ✅
- `~/repos/neutron-managed/SPEC.md:26-46, 129-133` — Open = "single-owner … NO tenant vocabulary." ✅
- `~/repos/neutron-managed/CLAUDE.md:5` — canonical. ✅
- `master-plan.md:10` ("managed private **agent harness**") + `:283` ("tenant zero" used correctly for Managed infra). ✅

**Drift count:** ~10 lines across **4 files** (SYSTEM-OVERVIEW ×2, master-plan ×5, STATUS ×2, snapshot ×1). 2 already SPEC-flagged; 8 not yet flagged.

---

## 5. PRIORITIZED GAP LIST (the next build queue)

Ranked by how core each is to daily-driving Vajra. Each tagged **genuinely-missing** / **present-but-unwired** / **different-but-equivalent**.

1. **Phase-2 Cores → scribe fan-out (calendar/email entity extraction)** — *present-but-unwired.* `gateway/cores/calendar-wiring.ts:208` + `email-managed-wiring.ts:106` accept a `scribeFanOut?` param and `gateway/cores/scribe-fan-out.ts` exists, but **nothing threads it** (only `__tests__` reference it). So calendar/email events never reach scribe. Chat extraction works; ambient calendar/email extraction is dead. **Port:** thread `scribe.extractFromCoresSource` into the Cores' `fire` callbacks from the composer that mounts Cores.

2. **Calendar / Email / Google-Workspace Cores in Open** — *present-but-unwired (Open).* Factories exist (`gateway/boot-helpers.ts:181-270`) but are not composed into `open/composer.ts`. A self-hosting owner gets no Gmail/Calendar. **Port:** compose `installBundledCores` + `buildCoresBackendFactories` into the Open composer behind owner OAuth.

3. **Multi-agent dispatch family (Atlas / Sentinel + ad-hoc Forge/Argus)** — *genuinely-missing (only Trident exists).* Vajra dispatches 4 specialized agents via `spawn-agent.sh`; Neutron has one autonomous build-loop (`trident/`). **Port:** generalize Trident's `agent-dispatch.ts` into a typed agent registry (research / QA / review roles) + an owner-facing "dispatch agent" tool.

4. **Session compaction policy** — *needs-confirm / likely-partial.* Resume is solid; the 40k-warn/50k-auto-compact size policy isn't confirmed in Open. **Port (if absent):** a session-size watchdog over the persistent REPL with compact-on-threshold.

5. **Skill-forge wiring** — *present-but-unwired.* `skill-forge/` built, never composed. **Port:** register it in a composer if the "skillify" capability is in scope for Open.

6. **Travel (flights/hotels) + IG/X scraping** — *genuinely-missing.* Vajra owner-specific tool scripts (SerpAPI, Apify). **Port: low priority** — package as optional Cores; not core to the harness.

7. **Full watchdog alert fan-out + reply-tool surface** — *different-but-equivalent.* Open uses a notifier stub (`open/composer.ts:988`) and WS-native `agent_message` instead of Telegram reply/enforce-reply. Equivalent for a web owner; revisit only if a Telegram channel is added to Open.

---

## 6. EVIDENCE INDEX (files read)

`neutron-open`: `scribe/{index,extract,write-to-gbrain,scribe-budget,compose-payload}.ts`; `open/{composer,server}.ts`; `gateway/http/chat-bridge.ts`; `gateway/realmode-composer/{build-gbrain-memory,build-landing-stack}.ts`; `gateway/cores/{calendar-wiring,email-managed-wiring,scribe-fan-out}.ts`; `gateway/composition.ts` + `gateway/composition/build-core-modules.ts`; `gateway/boot-helpers.ts`; `runtime/adapters/claude-code/persistent/ensure-claude-trust.ts`; `README.md`. `neutron-managed`: `CLAUDE.md`, `SPEC.md`, `docs/SYSTEM-OVERVIEW.md`, `docs/archive/master-plan-snapshot.md`. `vajra`: `Projects/neutron/{master-plan,STATUS}.md` + full capability inventory. **Box:** `ssh neutron-prod` — gbrain 0.42.40.0 present; managed overlay + 13 real / 81 test tenant homes (tenant contents unreadable, no sudo).
