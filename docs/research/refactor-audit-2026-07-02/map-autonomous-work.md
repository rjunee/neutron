# Subsystem map: autonomous-work (trident/, agent-dispatch/, skill-forge/, work-board/, cron/, watchdog/)

Audit date: 2026-07-02. All paths relative to /Users/ryan/repos/neutron-open unless absolute.

## 1. Purpose & responsibilities

This subsystem is Neutron Open's autonomous-work machinery: the durable Forge→Argus→merge
build pipeline (trident), the general named-specialist background-agent dispatcher
(agent-dispatch: Atlas/Sentinel/ad-hoc), the propose-then-approve skill distiller
(skill-forge), the orchestrator's persistent external memory ("Plan" board, work-board),
the in-process cron scheduler with wall-clock catch-up (cron), and a six-detector
application-level watchdog (watchdog). Trident is the SQLite port of Vajra's `/trident`
skill; the others are ports/parity fills from the Vajra/Nova lineage
(docs/research/vajra-neutron-feature-parity-scan-2026-06-25.md).

## 2. Headline finding: the v2 rearchitecture is BUILT, and its predecessor was left in the tree

The audit brief says the trident v2 rearchitecture is "designed-not-built" and cites
`docs/research/trident-v2-rearchitecture-2026-06-29.md`. **That file does not exist on
disk** (it appears in the git-status snapshot as untracked but has since vanished; the
closest surviving doc is `docs/research/trident-v2-prototype2-2026-06-28.md`, verdict
GO-WITH-CHANGES, plus the reference script `trident-v2-proto2-workflow.prototype.mjs`).

**The v2 "Phase 2a exec-model" IS the production code path today:**

- The inner Forge→Argus→fix loop is ONE native CC Dynamic Workflow:
  `trident/inner-workflow.mjs` (771 lines) — Forge in an isolated worktree → parallel
  adversarial Argus review → asymmetric-gated synthesis → bounded fix loop, with per-phase
  SQLite checkpointing (`inner_checkpoint`) and a typed terminal result persisted to
  `code_trident_runs.inner_result` (header comment, inner-workflow.mjs:1-46).
- `trident/inner-loop.ts:326` (`buildSubstrateWorkflowFire`) fires it on ONE warm,
  non-ephemeral substrate whose launching turn settles in seconds; the workflow runs
  detached; N workflows share one warm REPL (inner-loop.ts:15-24).
- `trident/orchestrator.ts:186` (`buildTridentOrchestrator`) is the durable outer step:
  launch-if-needed, harvest `inner_result` from the DB by runId, server-gate the verdict,
  merge on APPROVE, orphan re-fire after restart, hang/stall reaping.
- Production wiring: `gateway/composition/build-core-modules.ts:382-416` builds
  `buildWorkflowFirer` + `buildTridentOrchestrator` + `TridentTickLoop` when
  `input.trident.fire_inner_workflow` is threaded; `open/composer.ts:592-642` builds the
  warm `cc-trident-fire-*` substrate and threads it.

**What is therefore legacy v1 machinery retained in the tree (see §7 debt):** the
per-phase state machine (`state-machine.ts` — kept "intentionally … even though this prod
step no longer drives the per-phase graph", orchestrator.ts:43-46), the blocking
per-phase session manager (`session.ts`), the per-worktree substrate dispatch adapter
(`substrate-dispatch.ts`), and the Forge/Argus prompt render/parse contract
(`prompts.ts` render*/parse* functions) — all unreferenced by any production path.

## 3. Module inventory (wc -l, key files)

### trident/ (~55 files; the big ones)
| file | lines | status |
|---|---|---|
| inner-workflow.mjs | 771 | LIVE — the inner loop itself (CC Dynamic Workflow script) |
| orchestrator.ts | 497 | LIVE — outer step: fire/harvest/gate/merge/reap |
| prompts.ts | 490 | ~70% LEGACY — render/parse for v1 per-phase dispatch; only `ARGUS_DIFF_LINE_LIMIT` imported by prod (orchestrator.ts:56) |
| store.ts | 434 | LIVE — `code_trident_runs` CRUD (migration 0077, + 0091 inner_result) |
| inner-loop.ts | 406 | LIVE — workflow firer + fire seam + `parseInnerResult` |
| session.ts | 333 | LEGACY/DEAD — `TridentSessionManager`, no prod consumer (only barrel export trident/index.ts:79) |
| code-command.ts | 312 | LIVE — `/code` chat command (wired at gateway/boot-helpers.ts:633) |
| codex-auth.ts | 300 | LIVE — Codex subscription auth validate/materialize |
| state-machine.ts | 273 | MOSTLY LEGACY — `computeTransition` per-phase graph unused in prod; `isTerminalPhase`/`TERMINAL_PHASES` + `stubAdvanceDeps` fallback still live (build-core-modules.ts:59,418) |
| git-mode.ts | 217 | LIVE — merge-mode/ralph auto-detect + `spawnCapture` |
| codex-credential.ts | 208 | LIVE — encrypted credential service (consumed by gateway/http/codex-credential-surface.ts) |
| board-dispatch.ts | 198 | LIVE — THE dispatch chokepoint (board-bound builds) |
| substrate-dispatch.ts | 197 | LEGACY/DEAD — `buildSubstrateTridentDispatch`, no prod consumer |
| delivery.ts | 191 | LIVE — terminal result → originating chat topic |
| tick.ts | 201 | LIVE — 90s single-flight sweep loop |
| merge.ts | 155 | LIVE — pr/local merge + worktree-cleanup backstop |
| run-progress.ts | 156 | LIVE — phase+checkpoint → Plan-item live label |
| work-board-build-tool.ts | 150 | LIVE — `work_board_dispatch_build` agent tool |
| inner-loop-sim.ts | 143 | TEST-ONLY — sim firer used by 5 test files |
| agent-dispatch.ts / agent-prompts.ts | 118/163 | LIVE via agent-dispatch package (persona loading) |
| codex-review.sh | 7.2KB | LIVE — invoked by inner-workflow's codex reviewer step |
| vajra-fixes.test.ts | 470 | parity anchor (FIX 9 fleet premature-completion, vajra-fixes.test.ts:436) |

### agent-dispatch/ (live)
service.ts 552 (DispatchService on runtime/subagent registry), command.ts 234 (`/dispatch`),
tool.ts (`dispatch_agent`), substrate-turn.ts (cancellable per-turn substrate runner),
watchdog-report.ts (runtime/subagent watchdog → report sink; skips forge/argus,
watchdog-report.ts:24-26), persona.ts (only module-level trident link). Wired at
open/composer.ts:664.

### skill-forge/ (live)
forge.ts (propose→approve lifecycle; onWorkflowCompleted NEVER writes to disk),
detector.ts (worthiness heuristic), distiller.ts (deterministic, no LLM), registrar.ts
(writes a native `SKILL.md` pack under `<owner_home>/.claude/skills`, never overwrites),
signature.ts (dedupe hash), proposals-store.ts (migration 0086), backend.ts + tool.ts
(`skill_forge_list/decide`) + command.ts (`/skills`) share one backend,
trident-adapter.ts (TridentRun→CompletedWorkflow, structural — no trident import).
Wired at open/composer.ts:716-739 through trident's terminal observer.

### work-board/ (live; NOT a workspace package — see debt)
store.ts 597 (`work_board_items`, migration 0090; transactions around append/reorder;
onChange hook powers the `work_board_changed` app-ws push, store.ts:14-23),
agent-tool.ts 294 (5 `work_board_*` MCP tools; project_slug always server-injected,
agent-tool.ts:15-20), dispatch-readiness.ts (the deterministic ask-before-acting gate),
fragment.ts (per-turn `<work_board>` injection, XML-escaped, 40-item cap).

### cron/ (live)
scheduler.ts 373 (interval + oncalendar with missed-fire catch-up, timer chunking above
2^31-1ms, post-start registration via `jobs.onRegister`, scheduler.ts:103-115),
calendar.ts 509 (OnCalendar subset, DST-correct, no Date.now inside),
cron-standard.ts 310 (NET-NEW 2026-07-01, 5-field Vixie evaluator for reminder cadence —
deliberately separate grammar, cron-standard.ts:10-14), jobs.ts / handlers.ts / state.ts,
timer-emit.ts (systemd unit emission — NO consumers in this repo).
~10 production job registrations found (tasks/, onboarding/, gateway/proactive, wow-moment).

### watchdog/ (effectively DEAD in production — see debt)
detectors.ts 350 (6 detectors), supervisor.ts (30s tick), alert-store.ts
(`watchdog_alerts`), types.ts.

## 4. Public seams / contracts consumed by other subsystems

- `TridentRunStore` / `TridentRun` / `TridentPhase` — open/composer.ts:123,
  gateway/http/work-board-surface.ts:38, gateway/composition/build-core-modules.ts:57.
- `CompositionInput.trident` wiring shape — gateway/composition/input/misc-input.ts:56-227
  (fire_inner_workflow, run_host, on_run_terminal, resolve_codex_home, work_board binder).
- `buildSubstrateWorkflowFire` + `WORKFLOW_FIRE_TOOL_NAMES` — open/composer.ts:74,634.
- `/code` command: `parseAndExecuteCodeCommand` — gateway/boot-helpers.ts:633.
- `dispatchBoardBoundBuild` chokepoint — code-command.ts, work-board-build-tool.ts,
  open/__tests__/open-trident-prod-boot-wiring.test.ts:147.
- `runProgressForItem` — gateway/http/work-board-surface.ts:37 and open/composer.ts:124
  (two callers, one derivation — by design, run-progress.ts:8-10).
- Codex credential: `CodexCredentialService`, `resolveCodexHome` —
  gateway/http/codex-credential-surface.ts:35, open/composer.ts:188-189.
- Work Board: `WorkBoardStore` (composer + envelope + app/landing clients),
  `registerWorkBoardTools`, `formatWorkBoardFragment`
  (onboarding/interview/onboarding-preamble.ts), `assessDispatchReadiness`
  (agent-dispatch/service.ts:64).
- Cron: `CronJobRegistry`/`CronHandlerRegistry`/`CronScheduler` — build-core-modules.ts
  cron module (428-457), open/composer.ts:438 (shared registry with wow-dispatcher),
  cores/free/reminders/src/backend.ts, reminders/tick.ts.
- Skill-forge: `SkillForgeBackend` (tools + `/skills` filter, open/composer.ts:1210),
  `completedWorkflowFromTridentRun` (open/composer.ts:737).
- SQLite tables as contracts: `code_trident_runs` (0077/0091 — written by BOTH the TS
  outer loop and Bash steps inside inner-workflow.mjs), `work_board_items` (0090),
  `skill_forge_proposals` (0086), `cron_state` (0004), `watchdog_alerts` (0004).

## 5. Workspace dependencies (declared vs real)

Declared (package.json): trident → persistence; agent-dispatch → trident; skill-forge →
persistence; cron → persistence; watchdog → persistence+runtime+cron+tools. work-board has
**no package.json at all** and is absent from the root `workspaces` list (package.json:5-45).

Actual imports (all via RELATIVE paths, never the `@neutronai/*` names):
- trident → persistence, channels/types (type-only), runtime/substrate +
  runtime/session-handle + runtime/models, tools/registry, project-credentials/store,
  prompts/, core-sdk/types, work-board/dispatch-readiness (board-dispatch.ts:45-47).
- agent-dispatch → runtime/subagent/*, work-board/dispatch-readiness, trident/agent-prompts
  (persona.ts only), core-sdk, tools.
- work-board → persistence, core-sdk, tools.
- watchdog → cron, runtime/credential-pool, tools/process-registry, persistence.

The manifests are therefore decorative; the real dependency graph is only visible by
grepping imports. (Repo-wide pattern, but worth stating once here.)

## 6. Internal layering (as-built, production path)

```
/code chat cmd (code-command.ts)   work_board_dispatch_build tool     dispatch_agent tool / /dispatch
            \                       (work-board-build-tool.ts)          (agent-dispatch/*)
             \                            |                                   |
              └────> dispatchBoardBoundBuild (board-dispatch.ts) <── board binder (WorkBoardStore, structural)
                          | creates code_trident_runs row + attachRun
                          v
    TridentTickLoop (tick.ts, 90s) ──> orchestrator.step ──fire──> warm substrate turn ──> Workflow tool
                          |                (inner-loop.ts)             (cc-trident-fire-*)      |
                          |                                                     detached: inner-workflow.mjs
                          |<──harvest── code_trident_runs.inner_result/inner_checkpoint <──Bash steps──┘
                          v terminal
    on_terminal = withTerminalObserver(delivery, [boardReconcile, skillForge.onWorkflowCompleted])
                 (build-core-modules.ts:341-380)
```
cron and watchdog are peers composed in the same module builder; watchdog depends on cron
state for its overrun detector (never registered — §7).

## 7. Architectural debt

### P1 — Retained v1 inner-loop machinery creates a false dual control-flow story
Evidence: state-machine.ts:95-260 (`computeTransition`/`advanceTridentRun` per-phase
graph incl. ralph-plan/ralph-task), session.ts (333 lines, `TridentSessionManager` — only
consumer is the barrel export trident/index.ts:79), substrate-dispatch.ts:101
(`buildSubstrateTridentDispatch` — zero production callers; referenced only in comments,
e.g. agent-dispatch/service.ts:22 which *claims* production uses it but production
actually uses agent-dispatch/substrate-turn.ts), prompts.ts:128-470 (renderForgePrompt/
renderArgusPrompt/parseForgeOutput/parseArgusVerdict/parseRalphPlan — used only by dead
session.ts; the live prompts are inlined in inner-workflow.mjs), orchestrator.ts:141-166
(`computeDiffLineCount` "RETAINED as an exported helper"). The run-row phase enum still
carries `ralph-plan`/`ralph-task` (store.ts:28-36) though the prod orchestrator only ever
writes forge-init→done/failed/stopped; Ralph now lives inside inner-workflow.mjs:622-647.
Result: a reader (or refactorer) must discover which of TWO complete inner-loop
implementations is real. The revertibility rationale (orchestrator.ts:43-46) has been
overtaken — the exec model has since accreted hang-watchdog, codex review, model routing.
Sketch: delete session.ts + substrate-dispatch.ts + the render/parse half of prompts.ts +
the per-phase branches of state-machine.ts (keep `isTerminalPhase`/`TERMINAL_PHASES` +
`stubAdvanceDeps`), collapse `TridentPhase` to the states production writes (with a
migration mapping old rows), and port vajra-fixes.test.ts assertions onto the exec-model
seams before deleting. cores/free/code-gen holds a THIRD forge/argus implementation
(cores/free/code-gen/src/runtime-runner.ts:177,305; prompts/forge-system.ts:58) that
code-command.ts:4-18 says it retired — reconcile in the cores audit, but trident's
refactor should not leave prompts.ts as the "single source of truth" for parsers only
dead code calls.

### P1 — watchdog/ package is dead in production while claiming to supervise
Evidence chain: only 3 of 6 detectors are ever registered
(build-core-modules.ts:488-494: "wired in sprints S5/S6 … the live production wire-up is
incremental" — never happened); of those three, StuckAgent/CrashedAgent watch
`tools/process-registry.ts`, which has **zero production `register()` callers**
(grep over repo excluding tests: none) so they can never fire; HeartbeatDetector is fed
`heartbeat_tracker: { lastHeartbeatAt: () => Date.now() }` (open/composer.ts:3440) so it
can never be stale; and the notifier is a no-op
(`watchdog_notifier: { notify: async () => undefined }`, open/composer.ts:3436). Net: a
30s supervisor tick that can never detect or notify anything. Meanwhile the REAL
supervision lives elsewhere: runtime/subagent/watchdog.ts (agent-dispatch reaping) and
the orchestrator's own hang/stall reapers. Sketch: either delete the watchdog/ package
(and the always-empty tools/process-registry if nothing else needs it) or actually wire
it (real heartbeat, real notifier, register the remaining detectors). Do not leave a
decorative safety system — it reads as covered when it is not.

### P2 — Supervision thresholds and mechanisms are scattered and mutually stale
Three layers watch trident liveness: run-progress.ts:24-30 `STALLED_WARN_MS` = 10m
(display), orchestrator.ts:184 `NO_ADVANCE_HANG_MS` = 25m (reap), orchestrator.ts:168
`DEFAULT_MAX_INFLIGHT_MS` = 2h (backstop). run-progress.ts:28 documents the reap
threshold as "(15m)" — stale since the 25m change (PR #174). Plus tick-loop 90s cadence
and fire settle 3m (inner-loop.ts:138). None share a module; a future tuning change must
find all five by grep. Sketch: one `trident/liveness.ts` constants module with the
ordering invariant (warn < reap < ceiling) asserted in a test.

### P2 — The board-binding chokepoint is implemented twice
trident/board-dispatch.ts:118-144 and agent-dispatch/service.ts:283-295 each implement
the same three rules (required board_item_id → item exists → assessDispatchReadiness)
with separately-maintained copies of the rejection messages and codes. They bind
different run types (trident run row vs subagent registry record), but the gate logic and
wording will drift. Sketch: extract a shared `enforceBoardBinding(board, project_slug,
board_item_id)` in work-board/ returning `{item} | {code,message}`; both chokepoints
call it.

### P2 — Cancelling a run does not stop the detached build
`/trident X-cancel` and board-item delete stop a run by writing the row terminal
(gateway/http/work-board-surface.ts:285-305 sets `phase:'stopped'` via
`trident_runs.update`, deliberately "so the outer loop stops harvesting/advancing/merging
it"); code-command stop does the same. The detached inner workflow on the warm substrate
is NEVER killed — it keeps building/consuming tokens to completion and writes an
`inner_result` nobody harvests. Also note the surface writes phase directly through the
store, bypassing the orchestrator (no `subagent_status` update, no fired-set cleanup —
the in-memory `fired` set only self-heals on the next terminal no-op step,
orchestrator.ts:404-407). Acceptable for M1, but a refactor should add a best-effort
kill/abort seam on the fire substrate (the Workflow runtime has a runId) and route ALL
terminal writes through one function.

### P2 — work-board is a bare directory, not a workspace package
No package.json; absent from root `workspaces` (package.json:5-45); imported relatively
by 17 files across app/, landing/, channels/, gateway/, onboarding/, trident/,
agent-dispatch/, open/ (grep list in §5). It is one of the most-consumed seams in the
subsystem and the only one with no manifest at all. Sketch: give it a package.json like
its siblings, or — better, given manifests are decorative repo-wide — decide the
workspace-package story once, repo-wide, during the refactor (either make manifests real
or drop the pretense).

### P2 — trident/ has become a grab-bag package (9 responsibility clusters)
trident/ now contains: (1) run store/state, (2) tick loop, (3) exec-model orchestrator +
firer + workflow script, (4) legacy v1 dispatch stack, (5) git/merge/workspace helpers,
(6) `/code` command UX, (7) board dispatch/reconcile glue, (8) the Codex credential
subsystem (codex-auth.ts 300 + codex-credential.ts 208 + codex-credential-tool.ts +
codex-review.sh — consumed by gateway/http/codex-credential-surface.ts, a credentials
concern that happens to be *used by* trident), and (9) persona prompt loading for
agent-dispatch (agent-prompts.ts, whose only external consumer is
agent-dispatch/persona.ts:14). No single god-file, but the package boundary no longer
means anything. Sketch: after deleting the v1 stack, split codex-* into
project-credentials/ (or a codex/ sibling) and move agent-prompts.ts into agent-dispatch.

### P3 — Stale documentation that actively misleads
- trident/index.ts:9-11: barrel still says "PR-2 of ~5: the state machine + tick driver…"
  and exports the dead session/prompt surface as if current.
- skill-forge/trident-adapter.ts:8 says "THE LIVE SEAM (documented, not wired in this
  PR)" — it IS wired (open/composer.ts:737).
- agent-dispatch/service.ts:22 says production uses `buildSubstrateTridentDispatch`; it
  uses substrate-turn.ts.
- run-progress.ts:28 "(15m)" vs the real 25m (orchestrator.ts:184).
- The v2 rearchitecture doc referenced by planning material does not exist on disk.

### P3 — cron/timer-emit.ts has no consumers
`emitTimerUnits` is exported (cron/index.ts:36-40) but nothing in this repo imports it
(grep: no non-cron consumers); its header says disk-write happens in
`scripts/install/` — no such caller found. Managed-only residue in the Open repo. Keep or
delete deliberately.

### P3 — watchdog "gateway_heartbeat" kind contradiction
watchdog/types.ts:5-8 says the gateway heartbeat watchdog "is REPLACED by systemd's
WatchdogSec" yet `gateway_heartbeat` is still the first WatchdogKind and HeartbeatDetector
is one of the three registered detectors (with the always-fresh tracker). Symptom of the
same P1 above.

## 8. Test posture

Strong deterministic unit coverage, thin end-to-end coverage:
- Nearly every module has a colocated `.test.ts` (trident ~22 test files; work-board 4;
  agent-dispatch 5; skill-forge 3 + __tests__/; cron 5; watchdog 2). Clocks, probes,
  timers, substrates are injected everywhere, so the suites are deterministic.
- The orchestrator/restart/ralph/code-command/board-reconcile tests drive the REAL outer
  loop against `buildSimFirer` (trident/inner-loop-sim.ts) — good state-machine coverage
  of fire/harvest/orphan/hang paths without a live CC.
- `trident/vajra-fixes.test.ts` (470 lines) is the parity anchor for the Vajra battle
  fixes (e.g. FIX 9 fleet premature-completion, :436) — a refactor must keep these
  passing or consciously port them.
- **inner-workflow.mjs is verified only by SOURCE-STRING assertions**
  (inner-workflow.test.ts:1-10: "verified by asserting the load-bearing requirements are
  PRESENT in the script source, not by executing it") — the single highest-value artifact
  has no executable test; regressions in its logic (as opposed to its text) surface only
  in live runs (see the 2026-07-02 toolless-workers incident, inner-loop.ts:150-156).
- Integration: tests/integration/watchdog-six-modes.test.ts (proves detectors work in
  isolation — the gap is wiring, not logic), open/__tests__/open-trident-prod-boot-wiring
  + open-agent-dispatch-wiring, many cron-driven import/onboarding integration tests.
- Flake risk: low inside this subsystem (no wall clocks); the repo-known PGLite boot
  flake is elsewhere.
- Untested: the real fire→detached-build→harvest path end-to-end (needs live CC; covered
  by manual e2e rounds in docs/research/m1-e2e-round*.md), codex-review.sh only via
  codex-review.test.ts textual checks.

## 9. Load-bearing subtleties a NO-CHANGE refactor must preserve

1. **Exactly-once terminal delivery**: `listNonTerminal` only returns non-terminal rows,
   so a `changed` outcome landing on a terminal phase is BY CONSTRUCTION a fresh terminal
   transition; the hook fires once, AFTER persist, in its own try/catch
   (tick.ts:154-186). Reordering save/hook or re-listing terminal rows breaks it.
2. **Observer ordering + isolation**: delivery first, observers always run even if
   delivery throws, delivery error re-thrown afterward (terminal-observer.ts:24-45;
   build-core-modules.ts:341-380). A naive Promise.all or early-throw silently drops the
   skill-forge audit or the board reconcile.
3. **Orchestrator step ordering (1→1b→2→3→4)**: harvest-first means a workflow that
   finished before a restart is harvested, never re-fired → no double-merge; the hang
   watchdog runs BEFORE orphan recovery so a wedged orphan is reaped, not redispatched
   (orchestrator.ts:410-484).
4. **Provenance gate**: APPROVE merges only when `inner_checkpoint === 'argus-approved'`
   was written by the workflow's own Bash step; a self-asserted APPROVE fails
   (orchestrator.ts:336-380). Never trust the harvested verdict alone.
5. **paused ≠ finished**: a fire turn is `fired` ONLY on a `completion` event; stream
   close without completion, error, or settle-timeout are all `failed`
   (inner-loop.ts:374-405). Same discipline in v1 remnants and agent-dispatch.
6. **The warm fire substrate must be a singleton**: a per-fire `build_substrate` would
   dispose the session and kill every detached background workflow on settle
   (inner-loop.ts:296-311).
7. **`WORKFLOW_FIRE_TOOL_NAMES` must stay the full build surface AND constant across
   turns**: workflow `agent()` workers inherit the launcher's `--tools`; the warm-REPL
   reuse guard pins `--tools` constant (inner-loop.ts:143-169). Trimming it to
   `['Workflow']` shipped toolless workers once already.
8. **Workflow args must be passed as a structured object**, and the script normalizes a
   JSON-string form anyway (`normalizeWorkflowArgs`, inner-workflow.mjs ~:83; prompt
   instruction inner-loop.ts:230). Model ids MUST arrive via args — the script cannot
   import runtime/models (inner-loop.ts:198-206); note `getBestModel()` is called at
   fire time, deliberately not the frozen const.
9. **Worktree cleanup is explicit on EVERY path**: inner-workflow `finally{}` scans for
   the deterministic `trident/<slug>` branch; merge.ts is the outer best-effort backstop
   that must never throw after a landed merge (merge.ts:16-27).
10. **In-memory `fired`/`redispatched` sets are per-process on purpose** — losing them on
    restart is what makes prior-process dispatches orphans, and `redispatched` bounds
    recovery to one re-fire per process (orchestrator.ts:198-205). Persisting them would
    change crash semantics.
11. **Timestamps drive liveness**: `last_advanced_at` is re-stamped by the workflow's
    checkpoints; the hang reap measures from it. `elapsedSinceAdvance` is conservative on
    unparseable timestamps (returns 0, orchestrator.ts:393-401).
12. **Chokepoint rejects BEFORE any state**: a rejected dispatch writes zero rows
    (board-dispatch.ts:14-17); attachRun happens only after run creation succeeds
    (board-dispatch.ts:186-189).
13. **Build workspace needs a commit**: `ensureProjectBuildWorkspace` git-inits with an
    `--allow-empty` initial commit because `git worktree add` fails on a repo with no
    HEAD (build-workspace.ts:8-15).
14. **Cron**: pre-start registrations are picked up by the `start()` sweep, post-start
    ones by `onRegister` — the `started` flag prevents double-binding
    (scheduler.ts:87-115); missed-fire catch-up fires ONCE on (re)arm if the most recent
    scheduled instant is newer than last recorded run; calendar grammar outside the
    subset warns+skips rather than throwing at bind (scheduler.ts:1-27). OnCalendar and
    Vixie parsers are deliberately separate (dom/dow AND vs OR,
    cron-standard.ts:10-14) — do not "unify" them.
15. **Work-board writes that read-compute-write (append sort_order, reorder) must stay
    inside `db.transaction()`** (store.ts:14-18), and every mutation must keep firing the
    single shared `onChange` (the app push depends on one store instance).
16. **Fragment is data, not instructions**: `<work_board>` XML-escaping + caps
    (fragment.ts:9-14) is an injection boundary.
17. **agent-dispatch watchdog notifier skips forge/argus** to avoid double-reporting
    trident's agents (watchdog-report.ts:11-16,24-26).
18. **run-progress derives from phase + inner_checkpoint**, because the outer phase stays
    `forge-init` for the whole build in the exec model (run-progress.ts:11-19).
19. **Delivery no-ops when `chat_id` is null** (cron-seeded runs) rather than erroring
    (delivery.ts:23-27).

## 10. What the refactor should do here

1. **Finish the v2 cutover by deleting v1** (the single biggest win): remove session.ts,
   substrate-dispatch.ts, the render/parse half of prompts.ts, the per-phase transition
   graph, the ralph phases from the enum, `computeDiffLineCount`; port the still-relevant
   vajra-fixes/state tests to exec-model seams first. Update trident/index.ts to export
   only the live surface.
2. **Delete or genuinely wire watchdog/** (and tools/process-registry if it stays
   writer-less). A decorative supervisor is worse than none.
3. **Split trident/ by responsibility**: core loop (store/tick/orchestrator/inner-loop/
   inner-workflow/merge/git-mode/build-workspace), entry surfaces (code-command,
   work-board-build-tool, board-dispatch/reconcile, delivery, run-progress), and move
   codex-* out to the credentials layer, agent-prompts into agent-dispatch.
4. **Centralize liveness constants** (warn/reap/ceiling/settle/tick) with an ordering
   test; fix the stale 15m comment.
5. **Unify the board-binding gate** into one shared function used by both chokepoints.
6. **Give run-termination one code path** (stop/X-cancel/delete/reap all through a
   store-level `terminate(run, phase, reason)`), and add a best-effort detached-workflow
   kill seam.
7. **Add an executable harness for inner-workflow.mjs** (a stub Workflow runtime that
   injects agent/parallel/phase/log/budget fakes) so the 771-line centerpiece is tested
   by execution, not by grep.
8. **Regularize the package story** (work-board manifest; make declared deps match real
   imports or drop manifests) as part of the repo-wide decision.
9. Leave cron and work-board logic alone behaviorally — they are the healthiest modules
   here; cron only needs the timer-emit dead-code decision.
