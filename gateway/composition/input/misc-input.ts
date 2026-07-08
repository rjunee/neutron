import type { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface MiscCompositionInput {
  db: ProjectDb
  project_slug: string
  /**
   * P5.6 — optional reminder-fired push hook. When supplied, the
   * reminders module wires this hook into `ReminderTickLoop.on_fired`
   * so an Expo Push notification fans out at the same instant the
   * substrate dispatcher fires the Telegram message.
   *
   * `push_dispatcher.onFired(reminder)` is called AFTER the tick
   * loop has advanced the row (markFired for one-shot, advanceRecurrence
   * for recurring). Failure-safe: thrown errors are caught and logged
   * but never block the tick from advancing to the next reminder.
   *
   * Production wires `createPushDispatcher(...)` (`gateway/push/dispatcher.ts`)
   * which calls `pushReminder` here. Test/dev paths leave this unset
   * so the existing reminder tick behaviour is unchanged.
   */
  push_dispatcher?: {
    onFired(reminder: import('@neutronai/reminders/store.ts').Reminder): Promise<void>
  }
  /**
   * P1.5 / Sprint 21 — realmode-composer cleanup callbacks. The realmode
   * composer opens auxiliary DB handles (e.g. RW registry/identity for
   * the slug-picker hook) that are NOT owned by the module graph but
   * must be closed on gateway shutdown. The boot loop runs these
   * callbacks after `graph.shutdown()` and before `db.close()`.
   *
   * Safe to omit; defaults to a no-op.
   */
  realmode_cleanups?: Array<() => void>
  /**
   * Trident v2 (Work Board Phase 2a exec-model) — drive the foundational
   * Forge→Argus→merge loop live. When `fire_inner_workflow` is supplied, the
   * `trident` module wires the REAL orchestrator `step`
   * (`buildTridentOrchestrator` + `buildWorkflowFirer`) so every non-terminal
   * `code_trident_runs` row (created by `/code <task>` or a governed Ralph run)
   * is advanced end-to-end by the tick loop: FIRE the inner CC Dynamic Workflow
   * (Forge build → parallel Argus review → synthesis → bounded fix loop) → on a
   * server-gated APPROVE merge (per git-mode) → done. When omitted, the module
   * falls back to `stubAdvanceDeps` (classify always "running") so the loop is
   * live + restart-safe but advances nothing — the unchanged Open dev/default
   * behaviour.
   *
   * `fire_inner_workflow(input)` invokes the `Workflow` tool on a WARM substrate
   * and SETTLES the launching turn immediately (the production composer passes
   * `buildSubstrateWorkflowFire` over a non-ephemeral `cc-trident-fire-*`
   * substrate on the per-instance Max-OAuth pool). It is billing-exempt — NOT a
   * per-build `claude -p`. The workflow then runs DETACHED in the background and
   * persists its TYPED terminal result to `code_trident_runs.inner_result`, which
   * the durable tick loop HARVESTS by runId (the fire seam carries NO build
   * result). `run_host` runs the git/gh host commands (defaults to a `Bun.spawn`
   * runner).
   */
  trident?: {
    fire_inner_workflow: import('@neutronai/trident/inner-loop.ts').FireInnerWorkflow
    run_host?: import('@neutronai/trident/merge.ts').RunHostCommand
    on_orphaned_session?: 'redispatch' | 'wait' | 'fail'
    /**
     * Skill-forge trigger (parity gap #5) — an OPTIONAL observer the trident
     * module fires for EVERY terminal run (done OR failed), AFTER the terminal
     * row is persisted and the result delivered. The composer wires this to
     * Skill Forge's auto-skillify audit (`skillForge.onWorkflowCompleted` over
     * `completedWorkflowFromTridentRun`); the audit itself drops non-`done`
     * runs, so the hook stays generic. Failure-safe: the trident module wraps
     * the call in try/catch so a hook error never un-terminates a finished run.
     */
    on_run_terminal?: (run: import('@neutronai/trident/store.ts').TridentRun) => Promise<void>
    /**
     * M1 UX REDESIGN — the LIVE-PROGRESS observer (see
     * `trident/tick.ts` `TridentTransitionHook`). Fired once per tick for every
     * run whose observable progress advanced (a checkpoint crossing
     * building→reviewing→fixing→merging, a launch, or a terminal transition). The
     * composer wires this to fan the bound Work item's `work_board_changed` frame
     * + the project rail's `projects_changed` frame, so the redesign UI updates
     * live instead of on the client's 15 s poll fallback. Failure-safe: the tick
     * loop wraps the call so a fan outage never blocks the tick.
     */
    on_run_transition?: (run: import('@neutronai/trident/store.ts').TridentRun) => Promise<void>
    /**
     * Per-owner CODEX_HOME dir for the OPTIONAL cross-model review (Part B).
     * When set, the trident loop threads it into the inner workflow so the codex
     * reviewer runs `trident/codex-review.sh` with this CODEX_HOME. The composer
     * resolves it via `resolveCodexHome({ owner_home })` — the SAME path the
     * admin-panel "Connect Codex" flow materializes `auth.json` into — so the
     * loop and the credential store can never disagree. Falls back to the
     * `NEUTRON_CODEX_HOME` env when absent (legacy / manual dev override).
     * Ignored when `resolve_codex_home` is supplied.
     */
    codex_home?: string
    /**
     * Per-run CODEX_HOME resolver (preferred over `codex_home`). The composer
     * wires this to `CodexCredentialService.resolveActiveCodexHome`, so the
     * trident review resolves the credential through the #149 store resolver
     * (project override → global → unset) with self-healing materialization,
     * rather than a raw static dir.
     */
    resolve_codex_home?: (
      run: import('@neutronai/trident/store.ts').TridentRun,
    ) => string | null
    /**
     * Bounded Forge merge-conflict resolver (#342). Threaded into the trident
     * orchestrator's merge deps so a LOCAL-mode merge that hits a rebase conflict
     * (a 2nd/3rd parallel same-project build replaying onto a sibling's merge) is
     * auto-resolved by a fresh Forge in the conflicted tree rather than
     * hard-failing. The composer wires this to `buildForgeConflictResolver` over
     * the ephemeral substrate factory. Absent → a conflict escalates to chat.
     */
    resolve_conflict?: import('@neutronai/trident/merge.ts').MergeConflictResolver
    /**
     * Terminal-result delivery sink (#339). The trident module posts each run's
     * terminal completion message ("✅ done, merged" / "❌ failed: <reason>")
     * through this sink instead of the bare `ChannelRouter` — which on Open has
     * NO app_socket adapter registered, so a completion message was silently
     * dropped (walstore completed but the chat stayed silent). Open wires this to
     * the durable app-ws adapter (`AppWsAdapter.send`: persists to the chat log +
     * fans live to any open socket). Absent → the module falls back to the router.
     */
    delivery_sink?: import('@neutronai/trident/delivery.ts').OutboundSink
  }
  /**
   * T2 r3 (2026-05-13) — Argus BLOCKING #1: pre-constructed
   * `CronJobRegistry` shared with the realmode-composer's
   * `buildLandingStack` → `buildWowDispatcherHook` path. When supplied,
   * the `cron` module reuses THIS instance instead of constructing a
   * fresh one, so the wow-moment action 07 (overnight-pass) registers
   * its job in the SAME registry the production `CronScheduler` reads
   * from. Without it the registration goes into a dead local registry,
   * `cron_state` records "scheduled", and the scheduler's timer never
   * fires — silently dropping the next morning's overnight brief.
   *
   * Optional for back-compat: when omitted, the module constructs its
   * own registry as before (the pre-r3 behaviour).
   */
  cron_jobs?: CronJobRegistry
  /**
   * Doc-search (QMD-equivalent) — when supplied, the `tools` module
   * registers the `doc_search` + `doc_read` agent tools backed by this
   * runtime, so the live chat agent can keyword/BM25-search the owner's
   * project docs mid-conversation ("research before asking"). The
   * runtime is constructed by the production composer (which owns
   * `owner_home` + the index DB path); omitting it leaves the surface
   * unregistered (the unchanged pre-doc-search behaviour).
   */
  doc_search?: {
    runtime: import('@neutronai/doc-search/runtime.ts').DocSearchRuntime
  }
  /**
   * Message-search (chat-history twin of doc-search) — when supplied, the
   * `tools` module registers the `message_search` agent tool backed by this
   * runtime, so the live chat agent can full-text-search the CHAT HISTORY
   * mid-conversation ("where did we land on X earlier?"). The runtime is
   * constructed by the production composer (which owns the per-topic history
   * source); omitting it leaves the surface unregistered.
   */
  message_search?: {
    runtime: import('@neutronai/message-search/runtime.ts').MessageSearchRuntime
  }
  /**
   * Memory recall (P0-2 — `gbrain_search`) — when supplied, the `tools`
   * module registers the `gbrain_search` agent tool backed by this owner's
   * `GBrainMemoryStore`, so the live chat agent can recall the entity pages
   * (people/companies/projects/meetings/concepts/originals) + scribe-extracted
   * facts that the WRITE path persists every turn. Closes the write→read
   * asymmetry: scribe writes to GBrain on every turn, this tool reads it back.
   * Distinct corpus from doc_search (project files) + message_search (chat
   * history) — the vault-wide / fast-fact recall surface. The store is
   * constructed by the production composer (which owns the GBrain client);
   * omitting it leaves the surface unregistered (unchanged pre-recall
   * behaviour).
   */
  gbrain_search?: {
    store: import('@neutronai/gbrain-memory/memory-store.ts').MemoryStore
  }
  /**
   * Agent-dispatch family (parity gap #3 — the named-specialist + ad-hoc
   * background-agent surface that mirrors Vajra's `spawn-agent.sh`). When
   * supplied, the `tools` module registers the `dispatch_agent` agent tool
   * backed by this service, so the live chat agent can dispatch a research
   * (Atlas) / review (Sentinel) / ad-hoc background agent that registers in the
   * shared `SubagentRegistry`, spawns via the substrate, is supervised by the
   * watchdog, and reports its result back to chat. The service is constructed
   * by the production composer (which owns the substrate dispatch closure +
   * the report-back sink); omitting it leaves the surface unregistered.
   */
  agent_dispatch?: {
    service: import('@neutronai/agent-dispatch/service.ts').DispatchService
  }
  /**
   * Skill-forge (auto-skillify, parity gap #5) — when supplied, the `tools`
   * module registers the `skill_forge_list` + `skill_forge_decide` agent tools
   * backed by this shared backend, so the live chat agent can list / approve /
   * decline Skill Forge proposals (agent-native parity with the `/skills` chat
   * command, which shares the SAME backend). The backend is constructed by the
   * production composer (which owns the proposals store + the `SkillForge`
   * orchestrator + the skills dir); omitting it leaves the surface
   * unregistered (and the auto-propose TRIGGER is wired separately via
   * `trident.on_run_terminal`).
   */
  skill_forge?: {
    backend: import('@neutronai/skill-forge/backend.ts').SkillForgeBackend
  }
  /**
   * Work Board (Phase 1a) — when supplied, the `tools` module registers the
   * `work_board_*` agent tools (list/add/update/complete/reorder) backed by
   * this SHARED `WorkBoardStore`. The store is the SAME instance the HTTP
   * surface + the per-turn injection use (the production composer constructs it
   * with the `work_board_changed` push hook), so an agent mutation and a human
   * HTTP write share one code path + one live-push. Omitting it leaves the
   * surface unregistered (unchanged pre-Work-Board behaviour). `project_slug`
   * is taken from the server-injected `ToolCallContext`, never an agent arg.
   */
  work_board?: {
    store: import('@neutronai/work-board/store.ts').WorkBoardStore
    /**
     * M1 on-disk spec — when supplied, `work_board_add` persists a non-trivial
     * `spec` to a per-project `plans/` doc and links the card's `design_doc_ref`
     * at it. Omitted → title-only adds (unchanged behaviour).
     */
    spec_doc?: import('@neutronai/work-board/spec-doc-service.ts').WorkBoardSpecDocService
  }
  /**
   * Work Board Phase 2b — when supplied, the `tools` module registers the
   * agent-native `work_board_dispatch_build` tool: the orchestrator's handle on
   * the trident loop, starting an autonomous Forge→Argus→merge build BOUND to a
   * Plan item (agent-native parity with `/code --item`). It enforces the
   * required-board_item_id + ask-before-acting chokepoint
   * (`dispatchBoardBoundBuild`) and writes a `code_trident_runs` row the durable
   * `TridentTickLoop` then fires + harvests. The `store` here is a thin
   * `TridentRunStore` over the SAME `db` the loop reads; `work_board` is the
   * shared board store (existence + ask-gate lookups + the run binding).
   */
  trident_build_dispatch?: {
    store: import('@neutronai/trident/store.ts').TridentRunStore
    work_board: import('@neutronai/trident/board-dispatch.ts').TridentBoardBinder
    /** Owner HOME base — the chokepoint resolves each project's own
     *  `<home>/Projects/<slug>/code` workspace under it (see `board-dispatch.ts`). */
    repo_path: string
    resolveBuildRepo?: (owner_home: string, project_slug: string) => Promise<string>
    resolveMergeMode?: () => Promise<import('@neutronai/trident/store.ts').MergeMode>
    resolveRalph?: () => Promise<boolean>
    channel_kind?: import('@neutronai/channels/types.ts').Topic['channel_kind']
    max_rounds?: number
    max_ralph_rounds?: number
    /**
     * M1 ▶ play button (agent-native) — resolves a board item's SAVED spec (its
     * design_doc_ref doc, else its title) so `work_board_start` builds from the
     * on-disk spec. Wired to the work-board spec-doc service.
     */
    resolve_task?: (
      project_slug: string,
      item: { title: string; design_doc_ref: string | null },
    ) => Promise<string>
    /**
     * #339 — resolve the originating chat topic (from the tool call's project_id)
     * so a board-dispatched build's terminal result announces back to chat.
     */
    resolve_delivery?: (
      project_id: string | null,
    ) => { chat_id: string | null; thread_id: string | null }
  }
  /**
   * Codex connect/status agent tools (Part B) — when supplied, the `tools`
   * module registers `codex_connect` + `codex_status`, agent-native parity with
   * the admin-panel Connect Codex flow. Both dispatch the SAME
   * `CodexCredentialService` (subscription-only validation, metered key rejected,
   * store in the #149 credential store, materialize to the per-project CODEX_HOME).
   */
  codex_credential?: {
    service: import('@neutronai/trident/codex-credential.ts').CodexCredentialService
  }
  /**
   * Create-project capability — when supplied, the `tools` module registers the
   * `create_project` agent tool (agent-native parity with the project-rail
   * "Create Project" button). The bound service runs the SAME owner-scoped
   * `createProjectRow` + materialize + live-rail-refresh path the HTTP surface
   * (`POST /api/app/projects`) uses, so an agent-created and a human-created
   * project share one code path. `project_slug` / `speaker_user_id` come from
   * the server-injected `ToolCallContext`, never an agent arg.
   */
  create_project?: {
    service: import('../../../gateway/realmode-composer/create-project-tool.ts').CreateProjectToolService
  }
}
