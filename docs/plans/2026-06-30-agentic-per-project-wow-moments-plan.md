# Agentic Per-Project "Wow Moments" — Design + Engineering Plan

> **Status:** DESIGN (Atlas, 2026-06-30). Plan-only — NO feature code, NO feature flags.
> **Authority:** implements SPEC.md Decisions Log 2026-06-30 ("agentic per-project wow moments") + the WAVE 3 queued Phases→Steps entry.
> **Ryan's intent (verbatim):** *"work on the wow moments in each project topic — instead of just a one-liner 'want to X?', pick some more detailed meaty work and start on it, and present a draft document, or ask if you want to schedule reminders for upcoming tasks/deadlines… more agentic wow things rather than just being like a chat interface."*
> Every claim tagged **[verified]** is read from code with file:line cited. **[design]** is a proposal to confirm in the PR.

---

## 0. Headline finding — the substrate already exists; this is orchestration + a new catalogue, not greenfield

The primitives Ryan wants are **already built and load-bearing** in Open. The work is (a) a *new per-project dispatcher* that reuses the existing action/runner/telemetry contract, (b) a *new catalogue* of genuinely-agentic actions (draft-a-doc, offer-reminders, start-meaty-work), (c) *generalizing* the onboarding LLM selector so a second caller can reuse it, and (d) *one new backend signal* so "entering a project" can trigger a refresh.

| Ryan wants | Already in code | Net new work |
|---|---|---|
| A per-project opening richer than "want me to X?" | **[verified]** `build-onboarding-handoff.ts:buildDeterministicProjectOpening` (`:584`) already summarizes STATUS.md + emits ONE next-move. But it fires **once**, at onboarding completion, and never refreshes. | New dispatcher that re-stages a *meatier* opening on cadence/enter. |
| "Present a draft document" | **[verified]** Documents tab reads the **filesystem** (`DocumentsTab.tsx:9-13`, no DB table); the materializer already LLM-composes real markdown and `writeDocIfMissing`s it under `Projects/<slug>/docs/` (`project-materializer.ts:275-292,755-765`); `ProjectDocComposer` is the reusable synth (`build-project-doc-composer.ts`). | A `draft-doc` action that composes → writes a file → posts a chat pointer. |
| Chat pointer to that doc | **[verified]** `runtime/doc-links.ts` is fully built (P7.3): agent writes `[Label](docs:/<id>/<path>)`, adapters `rewriteDocRefsInBody` linkify to `neutron://docs/…` / web URL (`doc-links.ts:16-24,191,741`; `channels/adapters/app-ws/adapter.ts:712`). | Just *use* it. (Web line-scroll anchor is the one gap — see Risk R5.) |
| "Schedule reminders for upcoming tasks/deadlines" | **[verified]** `reminders_create` MCP tool → `ReminderStore.create/createRecurring` → 30s `ReminderTickLoop` → Haiku composes at fire (`cores/free/reminders/src/tools.ts:103`, `backend.ts:322`, `reminders/tick.ts:65`, `dispatcher.ts:178`). Tasks carry `due_date` (`tasks/store.ts:125`). | A `deadlines` action that reads due tasks + offers → on accept, `reminders_create`. |
| "Pick meaty work and START it" | **[verified]** The wow action contract (`triggerCondition`/`run`, `action-types.ts:196-204`) + `ActionRunner` (telemetry, 60s hang-timeout, retry, never-throws, `action-runner.ts:86`) + `pickWowActions` LLM selector (`llm-selector.ts:125`) are all reusable. | A per-project selector + 2-3 new action modules. |
| "More agentic, less chat interface" | **[verified]** Live agent turn is warm-CC-per-(instance,topic) (`build-live-agent-turn.ts`). Agentic moves stage as unread bubbles exactly like the onboarding handoff (`build-onboarding-handoff.ts:emitProjectSeeds`, `:265`). | Orchestration + guardrails. |

**The single load-bearing reframe:** today's per-project opening is a *static, compose-once* artifact (`emitProjectSeeds` runs on the `wow_fired → completed` engine transition and never again). Making it *agentic* means (1) a recurring pass that regenerates a candidate move when project state materially changes, and (2) surfacing that staged move when the user enters the topic. **Do not** synchronously block project-open on an LLM call — pre-stage the move (mirrors how `emitProjectSeeds` eagerly pre-composes to avoid a first-open spinner, `build-onboarding-handoff.ts:55-61`).

---

## 1. Current-state map (verified)

### 1.1 What a "wow action" IS today  **[verified]**
- One declarative module shape, `WowActionModule` (`onboarding/wow-moment/action-types.ts:196-204`): `action_id`, `triggerCondition(ctx): boolean` (pure predicate — false skips silently), `run(ctx): Promise<WowActionResult>` (side-effecting), optional `decodeEngagement`.
- `WowActionContext` (`action-types.ts:120-179`) is the single-shot context every action reads: `project_slug`, `topic_id`, `owner_home`, `interview`, `import_result`, `rituals`, `captured_projects`, `reminders: ReminderStore`, `task_store?: TaskStore`, `cron_jobs`, `cron_state`, `db: ProjectDb`, `channel: WowChannelAdapter` (`emitPrompt`/`sendText`, `:83-88`), `gmail`, `substrate?`, `materializer?`, `now()`, `uuid()`.
- `WowActionResult` (`action-types.ts:185-193`): `{ fired, reason, redacted_payload?, follow_up_prompt_id? }` — the runner persists telemetry off this shape; NEVER raw user data in payloads.

### 1.2 How an action is SELECTED  **[verified]**
- `pickWowActions(input, deps)` (`llm-selector.ts:125`): builds a redacted payload (`WowSelectorCollectedData`, `:39-47` — never transcript/email), calls the substrate (Haiku 4.5) with the system prompt at `prompts/onboarding/wow-action-picker.md` (`:106`), parses `{"pick":[...],"explanations":{...}}` (tolerates ```json fences, `:205`), validates every id ∈ candidates and `2 ≤ pick ≤ 3` (`:233-252`).
- **Fallback is a true fallback:** on any LLM error / parse fail / invalid pick it runs the deterministic trigger predicates over the candidate set, capped at 3, catalogue order (`fallbackPick`, `:261-285`). Picker timeout is **20 s** (cold `claude -p` CC-spawn runs ~4.6 s to first token, `dispatcher.ts:56-70`).
- The selector is **pure** (no DB/channel side effects); the caller owns telemetry.

### 1.3 The catalogue + dispatch order  **[verified]**
- `catalogue.ts`: `ALWAYS_FIRE_FIRST = '07-overnight-pass'` (`:37`), `CANDIDATE_IDS = [02-lifestyle-reminders, 03-project-shells, 04-overdue-task, 05-followup-email-draft, 06-interest-check-in]` (`:46-52`), `ALWAYS_FIRE_LAST = '01-first-week-brief'` (`:40`). Registry keyed by `WowActionId` (`:54-62`). Adding a candidate = write module + add to imports + `CANDIDATE_IDS` + `WowActionId` union + picker prompt (`:16-18`).

### 1.4 The runner + dispatcher  **[verified]**
- `ActionRunner.run` (`action-runner.ts:103`): records `onboarding.wow_action_fired` on every path, retries ONCE (30 s backoff) only for `01`+`02` (`RETRY_ELIGIBLE`, `:81-84`), enforces a **60 s per-action hard timeout** (hang-resilience, hung `run()` → `reason:'timeout'`, never retried, `:57,192-202,233-249`), NEVER throws.
- `WowDispatcher.dispatch` (`dispatcher.ts:334`): fires 07 first → `pickWowActions` over candidates → fires each pick with inter-action pause + **prompt serialization** (waits for the button tap via `PromptResolutionProbe`, 30-min timeout, `:443-461,537`) so prompts don't stack (Sam's 2026-05-28 "several notifications appeared at once" complaint) → fires 01 last. Freeform-ack pauses + reschedule-on-kept-typing (`:595-606,571-587`). Telemetry: `onboarding.wow_action_selected` (`on_selection`, `:379-391`).

### 1.5 The per-project OPENING today  **[verified]**
- `build-onboarding-handoff.ts:buildOnboardingHandoffHook` (`:253`) → `emitProjectSeeds` (`:265`). Fires ONCE on the engine's `wow_fired → completed` transition. For each confirmed project it reads materialized docs (`ProjectOpeningDocs`: README + `docs/transcript-summary.md` + STATUS.md, `:133-148,313-319`), LLM-composes one opening (`composeProjectOpening`, Opus over CC substrate, bounded concurrency 4, `:225,336-361`), and emits ONE button-less bubble (`options:[]`, `allow_freeform:true`) under `web:<user_id>:<project_id>` (`:379-390`). Idempotency key `(project_slug, topic_id, 'onboarding_handoff_seed')` (`:383-387`).
- Shape (`:24-40`): a free-form paragraph (what the project IS) + **exactly ONE** next move — a suggested action, OR *an offer to set a reminder (offer only, never auto-created)*, OR "What would you like to do next?".
- Deterministic fallback (`buildDeterministicProjectOpening`, `:584`): leads with STATUS.md `one_liner` + `status`/`priority` (parsed by `parseStatusMd`, `:697`, extracting `open_threads` from "Open threads/Next steps/TODO" sections `:767`), an ask-for-corrections line, then a next-move ("Want to pick up `<open_thread>`?" → "Want me to dig into `<topic>`?" → "What do you want to push on first?").
- **This never refreshes.** It is the exact "one-liner want-to-X" surface Ryan wants to replace with meatier agentic moves.

### 1.6 The "entering a project" trigger surface — the gap  **[verified]**
- `on_session_open` (`gateway/http/app-ws-surface.ts:168-173`) fires **once per WS open** (the whole app connection; `channel_topic_id = app:<user>`), used to drive onboarding's first prompt. It is **not** per-project-topic-switch.
- Web project switching is **client-state-only** — `controller.projectId` (`landing/chat-react/controller.ts`), no backend per-project-open event. **[verified]** No `project_opened`/`topic_opened` backend signal exists.
- ⇒ To fire "when entering a project," we either add a lightweight WS `project_topic_open` frame + hook (v2 freshness), or **pre-stage on cadence and surface on enter** (v1, no new realtime event needed). This plan recommends the latter for v1 (§ 2.2).

### 1.7 Reminders — agent-facing path  **[verified]**
- Agent tool `reminders_create` (`cores/free/reminders/src/tools.ts:103`, guarded `write:reminders_core.db`): input `{ message, fire_at (unix sec), project_id?, recurrence? }` (`backend.ts:101`) → `ReminderStore.create` / `createRecurring` with `source='@neutronai/reminders-core'` (`backend.ts:86,322`) → row `status='pending'` → `ReminderTickLoop` (30 s, single-flight, claim-then-dispatch, `reminders/tick.ts:65,109`) → `buildReminderDispatcher` spawns a Haiku composition turn and posts (`reminders/dispatcher.ts:178`).
- Recurrence is **coarse**: `'weekly' | 'monthly' | 'occasional'` only (`store.ts:25`) — no cron/daily/weekday cadence at the store level.
- `reminders.listPendingByTopic` / `listPendingBySource` / `listPendingFiringBefore` (`store.ts:366,345,318`) let an action detect what's already scheduled (dedupe).

### 1.8 Tasks — deadline signal  **[verified]**
- `TaskStore` (`tasks/store.ts`): `Task.due_date: string|null` (`:125`), `list` orders open tasks `due_date ASC NULLS LAST` (`:453`) or by `focus_score` (`:415`). Overdue is baked into `computeFocusScore({priority,due_date,updated_at,now})` (`:338`, `tasks/focus-score.ts`). **No `listDueBefore(ts)` on tasks** — an action wanting "due within 7 days" filters `list()` in code. (Reminders has the firing-window query, tasks does not.)

### 1.9 Documents surface  **[verified]**
- Documents tab is a builtin project tab (`tabs/registry.ts:117-124`, `mount.target:'docs'`), rendered by `landing/chat-react/ProjectShell.tsx:149-158` → `DocumentsTab.tsx`. Reads over `WebDocsClient` → `/api/app/projects/<id>/docs/{tree,file,comments}` (`docs-client.ts:5-16`).
- **Source of truth = filesystem**, `<owner_home>/Projects/<project_id>/docs/` (`gateway/http/doc-store.ts:9-16`); **no `documents` DB table** (`DocumentsTab.tsx:9-13`). Writes: `PUT /docs/file` (atomic temp+rename, 5 MB cap, OCC, `doc-store.ts:70,31-40`) OR direct `writeFileSync` under the tree (materializer's `writeDocIfMissing`, `project-materializer.ts:755-765`, create-if-missing — never clobbers user edits).
- **A file written under `Projects/<id>/docs/` appears in the tab tree automatically** — no registration.
- Two parallel "project doc" notions: the filesystem `docs/` tree (what the tab shows) vs the GBrain entity page (`entities/projects/<slug>.md` + `put_page`, written by `build-project-page-indexer.ts:60-84`, what agent recall surfaces). A draft that must ALSO surface in recall needs the index step too.

---

## 2. Target design

### 2.1 Principle — reuse the contract, add a second orchestrator

Do **not** fork the action model. Keep:
- `WowActionModule` shape + `WowActionContext` + `WowActionResult` (extend the context, don't replace it).
- `ActionRunner` verbatim (telemetry, 60 s timeout, retry, never-throws) — it is orchestration-agnostic.
- The telemetry event vocabulary (`*.wow_action_fired`/`_engaged`/`_selected`), namespaced to a new source (`project_opening.*`) so the two flows are separable in reporting.
- `runtime/doc-links.ts` for every chat→doc pointer.
- `ReminderStore` + `reminders_create` for every reminder.

Add:
- **`ProjectOpeningDispatcher`** (`onboarding/wow-moment/project-opening/dispatcher.ts` [design]) — a second orchestrator with per-project semantics (no 07/01 always-fire baseline; a value-gate + cooldown instead).
- **A per-project catalogue** of agentic actions (§ 2.4).
- **A generalized selector** (§ 2.5).

### 2.2 Firing model — pre-stage on cadence, surface on enter (v1)

**[design]** Two-part, decoupled:

1. **Preparation (cadence, async, no user-facing latency):** a recurring "project agentic pass" runs per active project in the overnight/cron window (reuse `07-overnight-pass`'s cron infra + `cron_jobs`/`cron_state` already in `WowActionContext`). It runs the selector + the picked action's `run()`, which *drafts the doc / computes the deadline offer / prepares the meaty-work proposal* and **stages** the result as an unread opening bubble via the same `ButtonStore.emit` path `emitProjectSeeds` uses (`build-onboarding-handoff.ts:390`). This replaces the static seed with a fresh agentic one when state changed.
2. **Surfacing (on enter):** when the user opens the project topic they see the staged bubble (sidebar unread badge, exactly as today). No synchronous LLM call, no spinner.

**Why not fire synchronously on project-open in v1:** there is no per-project-open backend event today (§ 1.6); adding one is a real change to the WS surface + client, and a synchronous compose would reintroduce the first-open spinner the handoff redesign deliberately removed (`build-onboarding-handoff.ts:55-61`). Pre-staging gives the *feel* of "it did work while I was away" — which is more "agentic" than an on-open spinner, and matches Ryan's "start on it… present a draft."

**v2 freshness (deferred, architecture must accommodate):** add a WS `project_topic_open {project_id}` frame → new `on_project_topic_open` hook alongside `on_session_open` (`app-ws-surface.ts:168`) that, on a cooldown miss, kicks an async refresh pass (still non-blocking — the user reads the last staged bubble now, the fresh one lands on next enter). **Sign-off item S1.**

### 2.3 What "meaty high-signal work" means — the value gate

An agentic action fires only when its `triggerCondition` finds genuine signal in project context (else `no_trigger`, silent — existing runner semantics). Signal sources, all already on disk / in stores:
- **STATUS.md** — `parseStatusMd` (already exported, `build-onboarding-handoff.ts:697`) yields `one_liner`, `status`, `priority`, and `open_threads`. Non-empty `open_threads` = there is real work to pick up.
- **Docs tree** — `doc-store.ts` tree listing: a *missing* doc a project of this shape usually has (no launch plan, no research brief) = a draft opportunity.
- **Tasks** — `TaskStore.list` filtered for `due_date` within a window or overdue = a deadline opportunity.
- **Reminders already pending** — `reminders.listPendingByTopic` = suppress a duplicate offer.

### 2.4 The per-project agentic catalogue  **[design]**

New modules under `onboarding/wow-moment/project-opening/actions/` (or a new `project-opening/` sibling package). Each is a `WowActionModule` so the runner + telemetry work unchanged.

| id (proposed) | Trigger (fires when…) | `run()` does | Presentation |
|---|---|---|---|
| `p01-draft-doc` | STATUS `open_threads` non-empty AND the target doc is absent from the docs tree | Pick the highest-signal doc the project needs (launch plan / research brief / decision memo / competitive scan) from open threads; LLM-compose a **real** draft via the `ProjectDocComposer` pattern (`build-project-doc-composer.ts`); `writeDocIfMissing` under `Projects/<slug>/docs/<slug>.md` (never clobber); optionally index to GBrain (`page-indexer`) if it should surface in recall | Stage an opening bubble whose body is a 2-3 sentence "I drafted X — here's the gist" + a `[Draft: X](docs:/<id>/docs/<slug>.md)` pointer (linkified by `rewriteDocRefsInBody`). Free-form reply. |
| `p02-deadlines-offer-reminders` | `TaskStore.list` has ≥1 task due within N days or overdue, AND no pending reminder already covers it (`listPendingByTopic`) | Compose an offer naming the concrete deadline(s); on user accept → `reminders_create({ message, fire_at, project_id })` (never auto-create) | Button prompt `[A] Remind me [B] Not now` OR free-form; on `[A]` schedule + confirm. Serialized via the dispatcher's prompt-resolution probe. |
| `p03-propose-and-start-work` | STATUS `open_threads` non-empty AND `p01` didn't already claim the top thread | Take the top open thread and *do a first step* (draft an outline, run a scoped research pass into a `notes/` doc, produce a checklist) — not just "want me to X?" | Bubble: "I started on `<thread>` — <what landed>. Want me to keep going?" + optional doc pointer. |
| `p04-brief` (always-last analog) | always, when ≥1 prior action fired | Summarize what was staged this pass ("I drafted X and flagged 2 deadlines") | One consolidating bubble; this is the single surfaced opening when multiple actions fired, so the user sees ONE coherent message, not a pile. |

**Design note on "one bubble":** unlike onboarding (which fires several distinct prompts serialized over time), the per-project *surfaced* artifact should collapse to **one opening bubble per enter** (the `p04-brief` consolidation + at most one pending offer), to honor Ryan's "instead of just a one-liner… meaty work" without becoming a notification pile. The draft doc lives in the Documents tab; the bubble points to it.

### 2.5 Selector — generalize `pickWowActions`, don't clone it

**Answer to the task's question (reuse the wow llm-selector or new one?):** *generalize it.* The parse/validate/timeout/fallback machinery (`llm-selector.ts:201-285,329-343`) is caller-agnostic; only the payload-builder (`buildUserPayload`, `:299`) and the prompt path (`:106`) are onboarding-specific.

**[design]** Refactor `pickWowActions` into a reusable core:
- Extract a `pickActions(input, deps)` that takes `{ candidates, payload: object, system_prompt | prompt_path }` and returns `{ pick, explanations, is_fallback }` — the JSON envelope parse, `validatePick`, `withTimeout`, and predicate-fallback logic move here unchanged.
- Onboarding keeps its thin wrapper (`buildUserPayload` + `prompts/onboarding/wow-action-picker.md`).
- Per-project adds its own wrapper: a project-context payload (redacted STATUS fields, doc-tree summary, task due/overdue counts, pending-reminder count — **never** raw doc bodies or transcript) + a new prompt `prompts/project-opening/agentic-move-picker.md`.

This keeps ONE selection engine (DRY, one place to harden the JSON parsing) with two payload/prompt adapters. The deterministic predicate fallback (`fallback_ctx` + `candidate_modules`, `:261`) is reused verbatim — critical, because the cold CC-spawn picker can time out and the actions must still fire on their triggers.

### 2.6 Reminder-offer flow (detail)

1. `p02.triggerCondition`: `TaskStore.list({order:'default'})`, filter `due_date` ≤ now + window OR overdue; subtract anything already covered by `reminders.listPendingByTopic(topic_id)`. Empty → `no_trigger`.
2. `p02.run`: `channel.emitPrompt` an offer naming the deadline. `follow_up_prompt_id` returned so the dispatcher serializes.
3. On accept (`decodeEngagement` maps the choice): call `reminders_create` (via the Core backend, so capability-guard + `source` tagging apply) with `fire_at` derived from `due_date` minus a lead (e.g. 1 day prior at a sane hour), `project_id = <project>`. Confirm in-thread.
4. Never auto-create — matches the existing opening contract ("offer only, never auto-created," `build-onboarding-handoff.ts:31`).

### 2.7 Doc presentation (detail)

- Compose with the `ProjectDocComposer` seam (`build-project-doc-composer.ts`) — CC substrate only, never direct api.anthropic.com (hard rule, `:9-14`).
- Write with create-if-missing semantics (`writeDocIfMissing`) under `Projects/<slug>/docs/` so a user's later edits are never clobbered and the doc auto-appears in the tab (§ 1.9).
- Post the chat pointer as a `docs:/<project_id>/<path>` marker in the bubble body; the app-ws + telegram adapters linkify it (`doc-links.ts:741`, `adapter.ts:712`). No new pointer plumbing — this IS the "doc-reference-linkify" work, already shipped.
- If recall-visibility is wanted, additionally run the `page-indexer` step (`build-project-page-indexer.ts`) — **decision S2** (default: index research/decision docs, skip ephemeral drafts).

### 2.8 Guardrails (helpful-not-spammy)

| Guardrail | Mechanism |
|---|---|
| **Value gate** | Every action's `triggerCondition` must find real signal (§ 2.3); no signal → silent `no_trigger`. No "want me to X?" filler when there's nothing to point at. |
| **Cooldown / frequency** | Per-project `last_agentic_pass_at` (store in project `phase_state_json` or a small `project_opening_state` row). Cadence pass skips a project within N days of its last *surfaced* fire unless a material-change check trips (new open thread, newly-overdue task, newly-missing expected doc). **[design]** default N = 3-5 days; **S3**. |
| **Don't re-fire / dedupe** | Idempotency key `(project_slug, topic_id, 'agentic_opening', content_hash)` on the staged bubble (mirror `emitProjectSeeds` idempotency, `:383`). `draft-doc` is create-if-missing (won't re-draft an existing doc). `deadlines` subtracts pending reminders. |
| **One-at-a-time** | Reuse the dispatcher's `PromptResolutionProbe` serialization (`dispatcher.ts:443`); surface at most one offer + the `p04` brief per enter. |
| **Opt-out** | Per-project setting `agentic_openings: on \| digest \| off` — slots into the per-project Settings tab (`docs/plans/2026-06-30-per-project-settings-tab-credential-scoping-plan.md`). Global default `on`. `off` = never stage; `digest` = stage silently, no unread badge. **S4.** |
| **Quiet window** | Cadence pass runs in the overnight/cron window only; nothing is *sent* live at odd hours — it's staged for next enter. |
| **Never destructive** | Drafts never overwrite (`writeDocIfMissing`); reminders offered not created; "start work" produces reversible artifacts (a draft, an outline, a notes doc) — never sends email, never mutates external state, without an explicit tap. |
| **Never leak** | Selector payload is redacted (counts, STATUS fields, doc filenames) — never raw doc bodies, transcript, or email content (extends the existing `WowSelectorCollectedData` discipline, `llm-selector.ts:34-47`). |

---

## 3. Phases → Steps (acceptance criteria, all in `neutron-open`)

> No time estimates (house rule). Each step is PR-sized. Repo: **all Open** (`~/repos/neutron-open`).

### Phase A — Generalize the selector (no behavior change)
- **A1.** Extract `pickActions(input, deps)` core from `pickWowActions`; re-express the onboarding path as a thin wrapper. **Accept:** existing `llm-selector` tests pass unchanged; onboarding wow dispatch behaves identically (same picks for the same fixtures).
- **A2.** Add the project-opening payload builder + `prompts/project-opening/agentic-move-picker.md`. **Accept:** given a redacted project-context fixture, the selector returns a valid `{pick,explanations}` and falls back to predicates on LLM error.

### Phase B — Per-project catalogue + context
- **B1.** Extend `WowActionContext` with the read seams the new actions need (doc-tree lister, task-due filter helper) OR pass them via a `project_opening`-scoped context; keep onboarding context untouched. **Accept:** type-checks; onboarding actions unaffected.
- **B2.** `p01-draft-doc` module (compose via `ProjectDocComposer`, `writeDocIfMissing`, emit `docs:/…` pointer). **Accept:** integration test — trigger fires on a STATUS with open threads + missing target doc; `run()` writes exactly one file under `docs/`, never clobbers an existing one, returns a bubble body containing a valid doc-link marker.
- **B3.** `p02-deadlines-offer-reminders` module. **Accept:** with a task due in-window and no pending reminder, offers; on accept calls `reminders_create` with correct `fire_at`/`project_id`; with a pending reminder present, `no_trigger`.
- **B4.** `p03-propose-and-start-work` + `p04-brief`. **Accept:** `p03` produces a reversible artifact; `p04` consolidates fired actions into one bubble.

### Phase C — Dispatcher + cadence
- **C1.** `ProjectOpeningDispatcher` reusing `ActionRunner` + generalized selector + value-gate/cooldown. **Accept:** unit tests — value gate skips no-signal projects; cooldown suppresses within N days; prompt serialization holds (one offer at a time); telemetry emits under `project_opening.*`.
- **C2.** Cadence wiring: a per-active-project pass in the overnight/cron window that runs the dispatcher and stages the result via `ButtonStore.emit` (reuse the `emitProjectSeeds` staging path). **Accept:** given a project with new signal, a fresh opening bubble is staged with the correct idempotency key; re-run within cooldown stages nothing.
- **C3.** Surface: confirm the staged bubble renders on project enter via the existing sidebar/unread path (no client change for v1). **Accept:** e2e — staged bubble appears with unread badge; opening it renders body + working doc-link.

### Phase D — Guardrails + settings + telemetry
- **D1.** Cooldown/state persistence (`project_opening_state`), material-change detector. **Accept:** re-fires only on genuine change.
- **D2.** `agentic_openings` per-project setting (on/digest/off) wired to the Settings-tab plan. **Accept:** `off` stages nothing; `digest` stages without badge.
- **D3.** Telemetry dashboards: fired/engaged/selected under `project_opening.*`; a "staged-but-never-opened" rate to detect spam. **Accept:** events queryable; spam signal visible.

### Phase E (v2, deferred — architecture accommodates, do NOT build now)
- **E1.** WS `project_topic_open` frame + `on_project_topic_open` hook for on-enter freshness refresh (still async, non-blocking). Gated behind sign-off **S1**.

---

## 4. Risks

- **R1 — Spam / notification fatigue** (highest). If cooldown or the value gate is too loose, every project sprouts an unread badge daily and the feature reads as noise. *Mitigation:* strict value gate (real signal only), conservative default cooldown (S3), `digest`/`off` opt-out, and the D3 "staged-but-never-opened" metric as the kill-switch signal.
- **R2 — Bad drafts erode trust.** An LLM draft that's wrong/generic is worse than no draft. *Mitigation:* `ProjectDocComposer` is Opus-class over real project context (STATUS + docs), draft framed as a *draft* ("I drafted a starting point — edit freely"), create-if-missing so it never overwrites, and it lands in the Documents tab where the user reviews before it matters.
- **R3 — Cadence cost.** A per-project LLM pass across many projects × daily is real spend. *Mitigation:* value gate short-circuits BEFORE the LLM call (predicate is pure/cheap); only projects with new signal reach the selector; bounded concurrency (reuse `mapWithBoundedConcurrency`, `build-onboarding-handoff.ts:513`).
- **R4 — Cold-spawn picker timeouts.** The picker is a cold `claude -p` (~4.6 s first token); onboarding already raised its budget to 20 s (`dispatcher.ts:70`). *Mitigation:* same 20 s budget + the deterministic predicate fallback (actions still fire on triggers).
- **R5 — Web doc-link line anchors not wired.** `?line=N`/`?range=N-M` parse+build but the **web** `DocumentsTab` has no scroll-to-line handling (`doc-links.ts:117-121`; web viewer lacks it). *Impact:* pointers open the right doc but not the exact line on web. *Mitigation:* v1 pointers target whole docs (fine); line-anchor scroll is a separate small web task.
- **R6 — Two-doc-notion confusion.** Filesystem `docs/` (tab) vs GBrain entity page (recall) are distinct (§ 1.9). *Mitigation:* draft-doc writes the file (tab visibility guaranteed); index step is an explicit opt-in per S2.
- **R7 — `reminders_create` capability gating.** The tool is guarded (`write:reminders_core.db`); a project without the Reminders Core installed can't schedule. *Mitigation:* `p02.triggerCondition` checks Core availability (as `05-followup-email-draft` checks `gmail_scopes`, `action-types.ts:72-76`) and `no_trigger`s gracefully.

---

## 5. Sign-off items (need Ryan)

- **S1 — On-enter freshness (v2).** Ship v1 as pre-stage-on-cadence + surface-on-enter, and defer the realtime `project_topic_open` event? (Recommend: yes — v1 delivers the "it did work while I was away" feel without a new WS event; add E1 later.)
- **S2 — GBrain indexing of drafts.** Should agentic drafts also index into recall (`page-indexer`), or stay filesystem-only? (Recommend: index research/decision docs, skip ephemeral outlines.)
- **S3 — Default cooldown / cadence.** N days between surfaced fires per project (recommend 3-5) and cadence window (recommend overnight, reusing existing cron).
- **S4 — Opt-out granularity.** `on | digest | off` per project, global default `on`? Or global master switch too?
- **S5 — Catalogue scope for v1.** Ship all four actions (`p01`–`p04`), or land `p01-draft-doc` + `p02-deadlines` first (the two Ryan named verbatim) and add `p03-start-work` after? (Recommend: `p01` + `p02` + `p04-brief` in v1; `p03` in a fast-follow once the draft-doc quality bar is proven.)

---

## 6. What this reuses vs builds (summary)

**Reuses verbatim:** `WowActionModule`/`WowActionContext`/`WowActionResult` contract, `ActionRunner`, telemetry vocabulary, `pickActions` fallback machinery, `ReminderStore`/`reminders_create`/tick loop, `TaskStore`, `ProjectDocComposer`, `writeDocIfMissing`, `runtime/doc-links.ts` linkify, `ButtonStore.emit` staging, `parseStatusMd`, `mapWithBoundedConcurrency`.

**Builds new:** `ProjectOpeningDispatcher`, per-project catalogue (`p01`–`p04`), generalized `pickActions` core + project payload/prompt, value-gate + cooldown + `project_opening_state`, `agentic_openings` setting, `project_opening.*` telemetry. **Deferred (v2):** `project_topic_open` WS event.

**No feature flags** (per directive) — ship behind the per-project `agentic_openings` *setting* (a user preference, not a rollout flag) with global default `on`.
