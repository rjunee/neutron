# AS_BUILT

Running log of what shipped, newest first. One entry per merged change.

## 2026-06-30 — REPL/live-agent model is ALWAYS the latest (never a hardcoded stale id)

**P0 onboarding hang fix.** A fresh Open box spawned the live-agent / onboarding
REPL with `--model claude-opus-4-7` (the hardcoded `BEST_MODEL` default in
`runtime/models.ts`). Once `opus-4-7` stopped serving, the model call hung → the
turn produced ZERO tokens → the persistent-REPL 180s per-turn timeout fired →
the user got the failure bubble / an indefinite "Setting things up…" loader.
Repro: a clean instance on the default hung 180s + failed; pinned to
`claude-opus-4-8` it delivered the welcome in ~32s.

**Root cause.** `runtime/models.ts` already exposes a dynamic accessor
`getBestModel()` (the model-update watchdog flips its override via
`setBestModelOverride` when a newer top-tier model ships), but the gateway-level
spawn/dispatch sites read the **frozen `BEST_MODEL` constant** instead — so the
watchdog's adopted id never reached new/cold spawns, and the stale literal rotted
into a hang the moment the pinned model was retired.

**Fix (no flags, no dual paths).**
- **Seed bump:** `BEST_MODEL` default `claude-opus-4-7` → `claude-opus-4-8` (the
  fresh-install, pre-first-watchdog-tick seed) + a doc note that this is a SEED,
  not the live value. Added the matching `claude-opus-4-8` row to
  `runtime/model-pricing.ts` (same Opus $5/$25 rates) so
  `resolvePricingFor(getBestModel())` doesn't throw at import-build.
- **Dynamic resolution at every live spawn/dispatch site**, resolved as late as
  feasible (per-turn / per-call, never captured when a runner is built once at
  boot): `open/composer.ts` `prewarmSubstrate` (the warm-pool spawn that heats
  the onboarding REPL — THE confirmed-bug site), `build-live-agent-turn.ts`
  (resolved inside the per-turn body), `build-llm-router.ts`,
  `build-project-opening-message.ts`, `build-project-doc-composer.ts`,
  `build-phase-spec-resolver.ts` (`buildAnthropicLlmCall` model now optional →
  `getBestModel()` per-call), `build-agent-watcher-llm-call.ts`,
  `gateway/cores/mount-open-cores.ts` (one-shot Core LLM + email model), the
  onboarding suggesters (`agent-name-suggester.ts`,
  `personality-character-suggester.ts`) + `post-turn-extractor.ts`,
  `onboarding/synthesis/synthesis-session.ts`,
  `onboarding/history-import/substrate-callers.ts` + `job-runner.ts`,
  `scribe/extract.ts`, `reflection/detector.ts`. `agent-dispatch/service.ts`
  `default_model` now accepts a `string | (() => string)` thunk, and the Open
  composer passes the `getBestModel` accessor so each dispatch resolves live.
  Trident keeps the dynamic `--model opus` CLI alias (already always-latest);
  reminders/research keep their intentional `FAST_MODEL`/`SONNET_MODEL` picks.
- After this change there are **no remaining runtime references to the frozen
  `BEST_MODEL` constant** outside `runtime/models.ts` (the seed) and
  `runtime/model-pricing.ts` (doc text) — verified by grep.

**Tests.** New `build-live-agent-turn-model-resolution.test.ts`: a runner built
WITHOUT an explicit model spawns `getBestModel()`; a `setBestModelOverride` flip
AFTER the runner is built reaches the NEXT turn on the SAME runner (proves
per-turn, not per-build, resolution); an explicit `input.model` still wins. New
`prewarmSubstrate` model-resolution test (in `onboarding-warm-conversational`):
the pre-warm spawn uses `getBestModel()` and tracks a watchdog flip. Updated the
`models.ts` default assertion (4.7→4.8), the watchdog-wiring oldModel/no-downgrade
assertions (assert against `BEST_MODEL` not a literal), and the import
substrate-caller default assertions. tsc clean (root + trident); leak-gate
SILENT; models/substrate/onboarding/cores/realmode-composer suites green.

**Codex cross-model review follow-up.** Making the import default dynamic meant
that, after the watchdog adopts a brand-new top-tier id with no pricing row yet,
`resolvePricingFor(getBestModel())` (eager, at `buildPass{1,2}SubstrateCaller`
construction) would throw and break onboarding/imports. Fixed by splitting the
resolver: an EXPLICIT operator `model_preference`/`fallback_model_preference`
keeps the strict loud-fail (typo protection), while the DYNAMIC always-latest
default degrades to a $0 estimate (`dollars_billed` is telemetry-only) with a
one-time warn — the import runs on the latest model regardless. Regression test
added (`buildPass1/Pass2SubstrateCaller` construct + run on an unpriced
watchdog-adopted model, billing $0).

**Codex review round 2 — per-call resolution.** The import callers + onboarding
suggesters + post-turn-extractor are constructed ONCE at gateway/composer boot,
so a builder-scope `getBestModel()` capture would pin the boot model and miss a
later watchdog flip. Moved the dynamic-default model (+ its pricing, for the
import callers) resolution INSIDE each returned closure (per-call), so a
post-boot adoption reaches the next import / suggestion / extraction. Explicit
operator model picks still resolve + price ONCE at build (loud-fail on typo).
Test added: a `setBestModelOverride` flip between two calls on the SAME import
caller reaches the second dispatch.

**Codex review round 3 — env-pin keeps strict pricing.** `getBestModel()` returns
`runtimeBestModel ?? BEST_MODEL`, so an operator's `NEUTRON_BEST_MODEL` pin
(surfaced as `BEST_MODEL`) was being silently billed at $0 when unpriced —
regressing the typo loud-fail. Now ONLY a watchdog-adopted override (model !==
`BEST_MODEL`) degrades; the env/default base keeps the strict `resolvePricingFor`
loud-fail.

**Codex review round 4 — model attribution / metadata (P3).** Two
non-dispatch sites that should NOT track the live accessor: (a)
`onboarding/history-import/job-runner.ts` stamps `synthesizer_model` for a
legacy/pre-S21 row that ALREADY completed — reverted to the stable `BEST_MODEL`
(attribution, not selection; a watchdog flip mustn't mislabel old results). (b)
The free-email `/email` chat-command filter's reported `model` was captured at
mount while `emailLlm` dispatches `getBestModel()` per call — the filter's
`model` option now accepts a thunk resolved per-call in `match`, so the reported
model stays aligned with the dispatch.

**Codex review round 5 — Email Core backend metadata (P3).** Same boot-capture
in the Email-Managed Core MCP-tool path: `buildTools` stamped a boot-time model
onto `email_triage` / `email_summarize` brief metadata while `llm` dispatched
`getBestModel()` per call. Threaded a `string | (() => string)` thunk through
`emailModel` (`mount-open-cores` → `boot-helpers` factory → `buildTools`),
resolved PER-CALL inside each tool handler, so the stamped model tracks a
watchdog flip. (Email Core is OAuth-gated / inert in default Open, but kept
consistent with the dispatch.)

NOTE: `open/__tests__/open-projects-changed-wiring.test.ts` (one live-refresh
timing test) fails on unmodified `origin/main` too — a pre-existing flake, not a
regression from this change.
## 2026-06-30 — Web-client rework: per-project chat + rail/tab layout + Plan rename + remove Tasks + markdown (P0)

The linchpin fix for the onboarding→project UX. Five linked changes, all in the
web client + tabs registry + the app-ws topic-binding seam. No feature flags.

**(1) Real per-project chat.** The `/ws/app/chat` surface previously bound EVERY
connection to the per-user topic `app:<user>` and treated `project_id` as a
cosmetic tag, so all projects shared one transcript and clicking a project showed
the same chat. Now a `platform=web` socket carrying a `project_id` binds the
PER-PROJECT topic `app:<user>:<project>` (`appWsProjectTopicId`,
`channels/adapters/app-ws/envelope.ts`); General omits `project_id` → bare
`app:<user>`. Persistence + seq + resume + fan-out key on the topic string
(independent transcripts, verified safe — the agent loop scopes off the
`project_id` field, not the topic), so each project has its own history. The
client `controller.setProject` RE-SCOPES: tears the socket down and stands up a
fresh one bound to the new topic, hydrating that topic's transcript from the
shared OPFS store (`main.tsx` `topicForProject`/`wsUrlFor`; `config.ts`). The
`turnTopicId` warm-session key was de-duped so the already-project-scoped web bind
isn't double-suffixed (`open/composer.ts`). **Gated on `platform === 'web'`** —
mobile keeps its single `app:<user>` socket + `project_id`-field model, unchanged.
Topic string is `app:<user>:<project>` (user-scoped, NOT `wow-shell-<id>`) so two
users opening the same project can never share a transcript — mirrors the proven
`landing/server.ts` `web:<user>:<project>` model. The 0→N `projects_changed`
auto-select was DROPPED: a mid-onboarding project appears in the rail but does NOT
yank the chat off General (which would drop still-arriving onboarding messages);
the user enters a project by tapping it. **Known behavior:** reminders/briefs still
fan to the bare `app:<user>` (General inbox) topic, so they surface in General, not
the per-project chats (durable rows always under `app:<user>`).

**(2) Persistent rail + tab layout.** `TopicRail` was nested INSIDE the Chat tab
body, so it vanished on other tabs, and the `TabBar` floated above everything only
in project views. Now `ProjectShell` is the app shell: a persistent `TopicRail`
left column + a content pane with the `TabBar` in BOTH General and project views.
**General** = Chat + Admin (global tabs); **project** = Chat / Plan / Documents
(NO Admin fold-in — the prior bug). `ChatApp` is now just the Chat-tab body
(`ChatSurface` + its bubble contexts); the create-project flow moved to the shell.

**(3) "Work Board" → "Plan"** user-facing label (`tabs/registry.ts`); internal
`work_board_*` tools / `cwb-` CSS / `work_board_changed` frame / DB table keep
their identifiers (no churny rename).

**(4) Tasks tab removed** from the engine (Ryan directive). The `tasks`
`BUILTIN_TABS` entry + `TasksTab.tsx` + `tasks-client.ts` + the `ProjectShell`
`target==='tasks'` branch + their tests were deleted; Tasks returns in WAVE 3 as a
Core-contributed webview tab via the existing `CoreTabContribution` path.

**(5) Markdown rendering.** Agent chat bodies (`ChatApp` `TextPart`, via
`useMessagePartText`) and the Documents viewer render sanitized GitHub-flavored
markdown through a shared `Markdown.tsx` (`react-markdown` + `remark-gfm` +
`rehype-sanitize`; links open `target=_blank rel=noopener`). User chat messages
stay plain. The Documents tab gains a Rendered↔Source toggle — Rendered is the
default; Source exposes the raw `<pre>` so comment anchors still map to RAW
character offsets. Deps added to `landing/package.json`; the lazy `Bun.build`
bundle stays ~0.91 MB.

Verification: root + chat-react-leaf + mobile `tsc` clean; chat-react 143 tests,
registry/app-tabs/app-ws-surface 46, app-ws adapter 107, composer/realmode 502 all
green; leak-gate SILENT. Files: `gateway/http/app-ws-surface.ts`,
`channels/adapters/app-ws/{envelope,adapter}.ts`, `open/composer.ts`,
`tabs/registry.ts`, `landing/chat-react/{ProjectShell,ChatApp,DocumentsTab,
controller,config,main,Markdown}.tsx?`, `landing/chat-react.html`,
`landing/package.json`.

## 2026-06-30 — M1 onboarding/UI cleanup batch (3 minor verify-pass fixes)

Three minor, non-architectural polish fixes surfaced during the M1
browser-verification passes. No feature flags, no migration, no new endpoint.

**(a) Import "Reading through…" status bubble floated to the chat bottom.** The
`import_running` `status` prompt ("Reading through your export now: entities,
topics, recurring threads…") was fanned ephemerally via `emitOnboardingPrompt`,
so it carried no chat_log `seq` and `compareForDisplay` (seq-less sorts to the
tail) pinned it BELOW every later real-seq message — it stayed at the bottom even
after the import completed and the analysis + later turns arrived. This is the
same ordering seam #130 fixed for the analysis body. **Fix** (`open/composer.ts`):
new pure, unit-tested `resolveImportRunningStatusDelivery` — the FIRST plain
buttonless status bubble is persisted through the durable adapter (chat_log
`seq` → chronological order), and the engine cron's RE-EMITS
(`import_running_attempt_count > 1`) are suppressed so they don't stack duplicate
durable bubbles (the live `import_progress` banner already shows ongoing
progress). Failure / rate-limit / resume prompts (real buttons) stay ephemeral.

**(b) Locked-in project set could include a project never shown to the user.**
The presentation caps the proposal at `MAX_ANALYSIS_PROJECTS` (7), but Pass-2 /
synthesis only caps via a prompt instruction (NOT enforced in code). A >7
synthesis therefore stamped the FULL list into `phase_state.import_result` AND
merged all N names into `primary_projects`, so the per-turn `onboardingContext`
seam, persona-gen, and finalize all locked in projects 8+ the user never saw and
could not drop. **Fix**: `capProposedProjects` (single source of truth in
`phase-prompts.ts`, used by the presentation too) is applied at the engine STAMP
chokepoint (`advanceFromImportRunningOnComplete` caps both `import_result` and
the `primary_projects` merge), so everything downstream agrees with the displayed
slice. `build-onboarding-finalize.resolveProjects` caps the IMPORT contribution to
the displayed set as a finalize-layer guard but TRUSTS `primary_projects` verbatim
(only displayed names + explicit adds, since the engine merge is capped) — it does
not filter primary against the overflow, which would wrongly drop an explicit add
whose name collides with an unshown overflow proposal (fixed per Codex review).
The GAP1 "no-narrowing" invariant is preserved (finalize = displayed − dropped +
adds).

**(c) Create Project used the native `window.prompt()`.** Replaced the blocking,
unstyleable native dialog (which also blocks E2E/CDP automation) at
`landing/chat-react/ChatApp.tsx` with an INLINE name input in the rail
(`.car-rail-input`), mirroring the mobile `app/app/projects` pattern: Enter
submits, Esc cancels, an empty name shows an inline error, and a failed POST
renders inline (no `window.alert`). Same `POST /api/app/projects` + bearer +
`controller.setProject(newId)` navigate-in flow; CSS in `landing/chat-react.html`.

**Tests.** New unit tests for `resolveImportRunningStatusDelivery`
(`open/__tests__/open-import-analysis-delivery.test.ts`), `capProposedProjects` +
the finalize >7 reconciliation (`gap1-project-no-narrowing.test.ts` +
`build-onboarding-finalize.test.ts`), and the inline create-project flow incl.
Enter/Esc/empty-name (`landing/chat-react/__tests__/component.test.tsx`). tsc
clean; leak-gate SILENT.

## 2026-06-29 — M1 CRITICAL: open-mode history import wouldn't START (#130 regression) — upload right after the name now seeds the row + starts the job

**Symptom.** On a fresh Open install, the reworked onboarding (#130) offers
history import right after the name. The owner uploads their ChatGPT/Claude
export and the server returns `job_id: null`; the client shows "Couldn't start
the import — no import job started." The import never runs (`import_jobs` empty,
`in_flight_imports=0` forever) behind a false success.

**Root cause.** `InterviewEngine.notifyImportUpload`
(`onboarding/interview/engine.ts`) reads the onboarding_state row and short-
circuits with `noop_no_state` when it's absent — **before** the open-mode
import-start gate. The open-mode live-agent onboarding never calls
`engine.start()` (managed mode's row-seeding entry); the row is created
**lazily + asynchronously** by the fire-and-forget post-turn extractor
(`post-turn-extractor.ts`), a multi-second background LLM call that only upserts
once it extracts a field. #130 moved the import offer to right after the name —
**earlier than the background extractor can create the row** — so the upload
races ahead of the row and lands at `state === null`.

**Fix (no flags, tenant-silent).** In `notifyImportUpload`'s `state === null`
branch, when the upload is a SOLICITED open-mode Path-1 upload (the SAME signal
the non-null gate uses: `deploymentMode === 'open'` AND `importAffordanceOffered`,
the exact condition the live-agent seam renders the 📎 affordance under), seed
the onboarding_state row at the `work_interview_gap_fill` conversational marker —
stamping `signup_via` so the import-running cron's channel-context invariant holds
on disk — then start the import via the existing
`startImportAndAdvanceToRunning`. A STRAY upload (affordance not offered, e.g. no
synthesis substrate) and managed mode both still `noop_no_state`. The #130
offer-first / live-progress / ordering / curation-context handoff are untouched.

**Concurrency guard (Codex r1 P2).** Two layers. (1) `notifyImportUpload` is now
serialized per `(project_slug, user_id)` via an in-process promise-chain tail
(mirrors the post-turn extractor's `chains` map). Single-owner Open is one
process, so this fully eliminates the upload-vs-upload race: two truly-
simultaneous fresh-install uploads run one-at-a-time, so the second observes the
first's `import_running` row and takes the `alreadyHasImportJob` guard — no
duplicate job, no downgrade. (2) Before seeding, the no-state branch also re-reads
the row and, if it now exists (e.g. the post-turn extractor — which is NOT under
this tail — created it), re-enters the locked body so all non-null guards apply.
Covered by added tests: sequential double-submit; a get-hooked store simulating
the concurrent window; and two truly-simultaneous `Promise.all` uploads → exactly
one job.

**Test (forbidden-pattern fixed).** The passing acceptance test
`tests/integration/nd2-real-export-path1-import-runs.test.ts` SQL-SEEDED an
onboarding_state row before uploading — manufacturing the precondition the live
flow never creates, so it could never catch this. It now seeds NO row and drives
the real no-state upload (verified end-to-end with Ryan's real 3.6MB / 184-convo
Claude export → job started). Added two engine-level repros in
`onboarding/interview/__tests__/path1-solicited-upload-starts-job.test.ts`
(no-state solicited → seeds row + starts; no-state affordance-off / managed →
no-op, no row manufactured). Negative control: reverting the engine fix fails
exactly these no-state tests.
## 2026-06-29 — Create Project affordance (project rail + create-project capability + agent tool)

A skip-import owner had no user-initiated way to create a project (projects only
materialized at onboarding finalize; reaching one otherwise needed the ≥3-project
gap-fill quota). Added a Create Project affordance across all surfaces, all
reusing ONE project-creation code path.

- **Shared primitives (`gateway/realmode-composer/project-create.ts`).** Extracted
  `ensureProjectRow` + `resolveBindTarget` (the `projects` row + cli wow-shell
  `topics` binding — idempotent, duplicate-safe, soft-delete-respecting) out of
  `build-onboarding-finalize.ts` into a shared module, plus `createProjectRow`
  (fast row-only half), `buildScaffoldMaterializer` + `materializeProjectScaffold`
  (on-disk docs + git + GBrain page). The finalizer now IMPORTS these — no second
  path. (Onboarding finalize tests unchanged + green.)
- **HTTP `POST /api/app/projects`** (`gateway/http/app-projects-surface.ts`,
  bearer-gated). `{ name }` → `{ project: { id, label }, created }` (201/200);
  optional `createProject` binding → `501 create_not_configured` where unwired.
- **Open wiring (`open/composer.ts`).** Mounts the whole app-projects surface
  (also gives mobile `fetchProjects` a real backend — previously unmounted in
  Open) + the `create_project` tool, both bound to one `createProjectAndRefresh`
  (row → fire-and-forget materialize → `emitProjectsChangedNow`, an unconditional
  `projects_changed` fan so a skip-import owner's first action refreshes the rail).
- **`create_project` agent tool** (`create-project-tool.ts`, registered in
  `build-core-modules.ts`; `auto` approval, `write:project_data`, non-hidden) —
  agent-native parity; `project_slug`/`speaker_user_id` server-injected.
- **Web rail** (`landing/chat-react/ChatApp.tsx` `TopicRail` + `chat-react.html`):
  `+ Create Project` pinned at the rail bottom (`margin-top:auto`), always visible;
  the rail now always mounts. Click → prompt → POST → `setProject` navigates in.
- **Mobile rail** (`app/app/projects/index.tsx` + `lib/projects.ts` `createProject`
  / `lib/projects-client.ts` `create`): bottom-pinned bar → inline name input →
  POST → `router.push('/projects/<id>')`.
- No migration (the `projects` table already exists, `0038`); Work Board tab is
  automatic per-project. tsc clean (root + chat-react + app); leak-gate SILENT.
  Tests: surface POST (`gateway/__tests__/app-projects-surface.test.ts`), shared
  primitives + tool (`gateway/realmode-composer/__tests__/project-create.test.ts`),
  web rail click (`landing/chat-react/__tests__/component.test.tsx`), mobile client
  (`app/__tests__/projects-client.test.ts`).

## 2026-06-29 — M1: onboarding import flow rework — offered FIRST + live progress + curation handoff + ordering

This is one coherent import-onboarding rework (PR #130). Two further bugs were
folded in after the initial offer-first + progress pass:

**Bug 3 — analysis → curation handoff was BROKEN (the killer).** The import-
analysis result (proposed-projects list) reached the client but was NOT in the
live-agent's conversation context. So when the owner replied to curate ("drop
the Family Home project, keep the rest"), the agent had no record of proposing
anything and answered "this is our first conversation, I haven't proposed any
projects" — the import was visible but un-actionable.

- Root cause: the analysis "wow moment" is delivered OUT OF BAND (ephemeral
  app-ws `agent_message`, never in the warm REPL transcript), and the onboarding
  `systemPreamble` is a static string spliced ONLY on the cold first turn — so a
  warm session post-import had no grounding on what it proposed.
- Fix (1) — context threading: new optional seam method
  `LiveAgentOnboardingSeam.onboardingContext(user_id)` (`build-live-agent-turn.ts`)
  re-injected on EVERY onboarding turn (warm AND cold), mirroring the Work Board
  block. `open/composer.ts` implements it: reads durable `phase_state.import_result`
  + `primary_projects` and calls the new `buildImportAnalysisContextFragment`
  (`onboarding-preamble.ts`) → an `<import_analysis>` block listing the proposed
  projects (with rationale + which were dropped) and telling the agent it already
  presented them + how to handle keep/drop/edit/add.
- Fix (2) — drop propagation: the Path-1 post-turn extractor never implemented the
  `removed_projects` channel that `ExtractedFields` has documented since GAP1
  (2026-06-09) and the legacy engine honors. Ported it: `parseExtractedFields`
  parses `removed_projects`; the extraction prompt asks for explicit drops;
  `buildPhaseStatePatch` subtracts them from the merged `primary_projects` AND
  accumulates them under `phase_state.dropped_projects`. `build-onboarding-finalize.ts`
  `resolveProjects` excludes `dropped_projects` from BOTH union sources (the import
  side re-pulls `proposed_projects`, so the `primary_projects` subtraction alone
  wasn't enough). Mirrors the legacy engine's `(prior ∪ adds) MINUS removals`. So
  a dropped project is never materialized; persona-gen (reads `primary_projects`)
  agrees. The additive no-narrowing rule is intact for non-removal turns.

**Bug 4 — import-delivered messages mis-ordered.** New user messages rendered
ABOVE the import-delivered analysis instead of newest-at-bottom. The successful
`import_analysis_presented` body was fanned via the ephemeral `emitOnboardingPrompt`
(no chat_log `seq`), and chat-core's `compareForDisplay` pins seq-less messages to
the tail — so a later real-seq user message sorted above it (and it vanished on
resume). Fix: that specific buttonless "wow moment" now persists through the
durable app-ws adapter (`open/composer.ts` button-prompt router → `adapter.send`
→ chat_log → monotonic `seq`, replayable). Every OTHER onboarding prompt (failure
/ rate-limit / resume — real buttons) stays ephemeral. Safe from double-render:
`on_session_open` never re-sends the body and the watcher resolves the phase so
the reconnect re-emit won't re-fire it.

Tests added: `onboarding-preamble.test.ts` (context fragment — lists proposed,
marks dropped, case-insensitive); `post-turn-extractor-removed-projects.test.ts`
(parse + subtract + accumulate `dropped_projects`, additive when no removals);
`build-onboarding-finalize.test.ts` (a dropped project is not materialized even
from the import union). tsc clean; leak-gate SILENT; onboarding-interview (957),
realmode-composer (379), app-ws (107), Open import/boot suites all green.

---

## 2026-06-29 — M1: onboarding import offered FIRST + real live import progress

**Problem (two live-test bugs).** Ryan hit two issues on a fresh M1 install:
1. The ChatGPT/Claude history import was **not offered early/explicitly**. After
   the #126 fix removed a premature always-on hint, the offer swung too far the
   other way — the agent only mentioned import after probing the user's work, so
   it felt buried. The intent (and the onboarding-experience spec) is: offer the
   import as the EXPLICIT first step right after the name, so the rest of the
   interview is informed by the analysis.
2. There was **no real import-progress indicator**. A large import (~8 min for
   173 conversations) showed only a one-shot "Export received — reading through
   your history now." line and then looked dead for minutes.

**Root cause.**
- Bug 1: Path-1 (Open) onboarding is prompt-driven — the engine runs only the
  import subsystem, so onboarding ordering lives entirely in the `<onboarding>`
  preamble (`onboarding/interview/onboarding-preamble.ts`). The import block sat
  after all five learning goals + was gated "after you have their name AND a
  sense of their work", biasing the model to defer it past the work-interview.
- Bug 2: the engine's `import-running-cron` already emits an `import_progress`
  event every ~5s and `buildRoutedSendImportProgress` already routes `app:<user>`
  topics to a composer holder — but that holder's `.send` was a documented NO-OP
  (`open/composer.ts`), so every progress frame was dropped. The React client
  (`controller.ts`) already consumed `import_progress` and rendered a spinner +
  per-pass line (`ChatApp.tsx` `ImportStatus`); only the server-side app-ws emit
  was missing.

**Fix (no flags, Option A in-chat for Bug 1).**
- `onboarding/interview/onboarding-preamble.ts` — moved the import-offer block to
  between goal #1 (name) and goal #2 (work) and reworded it to an EXPLICIT,
  prominent ask made RIGHT AFTER the name and BEFORE the work questions (mentions
  the drag-and-drop/📎 affordance + that it runs in the background with live
  progress; "only ask this once"). No new phase/modal — a pure preamble
  reposition. The managed-mode phase machine already routes import right after
  name, so it was untouched.
- `channels/adapters/app-ws/envelope.ts` — new `AppWsOutboundImportProgress`
  envelope (`{v,type:'import_progress',job_id,status,pass,pct,chunks_total_known,
  body?,ts}`) added to the `AppWsOutbound` union; mirrors `agent_typing` /
  `work_board_changed` (ephemeral, UI-only, not persisted, never replayed).
- `open/composer.ts` — filled the no-op `appWsImportProgressRouter.send` to fan
  the new frame via `appWsRegistry.send(app:<user>, env)` (best-effort; terminal
  frames clear the client spinner defensively, the analysis body still lands via
  the button-prompt path). Engine, cron, routing, and client render were already
  built.
- Tests: `onboarding/interview/__tests__/onboarding-preamble.test.ts` (pins the
  import offer present + positioned name→import→work, absent when not offered,
  asked once); `channels/adapters/app-ws/__tests__/import-progress.test.ts`
  (envelope is a union member, body optional, fans through `registry.send`).
- Docs: `docs/SYSTEM-OVERVIEW.md` updated (onboarding import-offer-first note +
  app-ws frame `#7 live import progress`).

**Why it's safe.** Additive: a server-only union member (the Expo subset union +
parity test are untouched and still green). The #126 fixes (import RESULT renders,
centered column, no reactions) are unaffected — the analysis body still lands via
the existing path; this only un-drops the intermediate progress frames. tsc clean
(root + chat-react leaf); app-ws (107) + onboarding-interview (912) suites green.

## 2026-06-29 — M1: stale-client-store auto-reset on server reinstall

**Problem.** A fresh Neutron Open server reinstall showed a STALE chat: the web
client's offline local store (`@neutron/chat-core` OPFS snapshot, origin-scoped
`neutron-chat-core.json`) — and the mobile op-sqlite store (`neutron-chat.db`) —
survive a server uninstall+reinstall behind the same origin/device. The server's
per-topic `seq` counter restarts at 1 on a fresh install, but the client resumed
forward from its OLD high local cursor (`resume after_seq=<high>`), so the
server's `replayAfter` returned nothing and the dead server's transcript
rendered forever. `session_ready.last_seen_seq` already carried the server's
high-water seq but NO client code read it.

**Fix (seq-regression reset detection, no flags).**
- `chat-core/types.ts` — new `parseSessionReadyMaxSeq(frame)`: extracts
  `last_seen_seq` from a `session_ready` frame, `null` when absent/malformed.
- `chat-core/sync-engine.ts` — new `SyncEngine.reconcileServerReset(topic, serverMaxSeq)`:
  when the server's reported seq is a known number **strictly lower** than a
  **non-zero** local cursor, the server regressed (was wiped/reinstalled) →
  `store.clear(topic)` so the following `resume` re-syncs from `after_seq=0`.
  Conservative: no-op when seq is absent (`null`), when server seq ≥ local
  cursor (normal reconnect/cold-open/first-connect), or when the local cursor
  is 0 (nothing cached).
- `chat-core/web-session.ts` + `app/lib/chat-core/mobile-session.ts` — both
  `session_ready` handlers call `reconcileServerReset(frame)` BEFORE
  `resumeAndFlush()`, and emit a UI change on a real reset so the stale messages
  drop immediately (before the replay lands). The detection lives in the SHARED
  `SyncEngine`, so web (OPFS) and mobile (op-sqlite) both benefit.
- `app/lib/ws-envelope.ts` — added `last_seen_seq?` to `AppWsOutboundSessionReady`
  for type parity with the server envelope (`channels/adapters/app-ws/envelope.ts`).

**Server change (Codex P1a).** `gateway/http/app-ws-surface.ts` now ALWAYS sends
`session_ready.last_seen_seq` when a durable log is wired, **including 0**.
Previously it omitted the field on 0, so a freshly reinstalled server whose log
was still empty at connect time (the welcome messages persist AFTER
`session_ready`) sent no signal → the stale client never reset on its first
post-reinstall load. A present `0` is now an affirmative "this server has nothing
for the topic" signal; the field stays ABSENT only when there is no durable log
at all (where `null` → never clear, protecting the only copy). `open/composer.ts`
wires the durable `AppChatStore` chat_log, so Open always reports the real value.

**No-data-loss on reset (Codex P1b + P2).** Added a `Store.clearAckedTranscript(topic)`
primitive (InMemory + OPFS + Sqlite) that drops only the ACKED (server-sequenced)
transcript in a SINGLE atomic store operation, preserving un-acked local sends
(status `queued`/`sent`, no server seq). `reconcileServerReset` calls it instead
of a read-clear-reinsert cycle, so a send that races the reset can't be lost in a
snapshot→clear window (it's either an already-kept non-acked row or arrives
after). The preserved sends are re-driven against the fresh server by the
following resume/flush (idempotent on `client_msg_id`).

**Not changed.** No new local-store namespace keyed on a server instance id (the
frame exposes no per-install id today; the seq-regression heuristic is the
pragmatic detector per the bug note).

**Tests.** `chat-core/__tests__/session-ready.test.ts` (parser edge cases),
`chat-core/__tests__/sync-engine.test.ts` (reconcile: clears on regression;
no-op on ≥, null, cursor-0, un-sequenced optimistic sends),
`chat-core/__tests__/web-session.test.ts` + `app/__tests__/chat-core-mobile-session.test.ts`
(end-to-end: stale transcript cleared + `resume after_seq=0` + fresh replay
renders clean; normal reconnect preserves; absent `last_seen_seq` never wipes).
