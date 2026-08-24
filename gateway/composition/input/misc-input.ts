import type { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { LoopRegistry } from '@neutronai/loop'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface MiscCompositionInput {
  db: ProjectDb
  project_slug: string
  /**
   * True when {@link project_slug} is the bare FALLBACK — nothing configured it,
   * so the process does not actually know who it is.
   *
   * It travels WITH the slug rather than being re-derived downstream because a
   * fallback `'dev'` and a configured `'dev'` are the same string and opposite
   * situations; only the resolver can tell them apart, and only at boot. The
   * credential surfaces refuse to move rows onto an unnamed process, which is a
   * decision they cannot make from the handle alone.
   *
   * OPTIONAL, and ABSENT MEANS FALLBACK. "This composition did not say where its
   * handle came from" and "this process does not know who it is" are the same
   * statement, so the wiring reads `undefined` as anonymous and the credential
   * surfaces refuse. That keeps a composer that forgets it FAIL-CLOSED — loudly
   * unable to migrate — instead of silently doing the unguarded thing, which is
   * the failure this whole guard exists for. It also spares every composition
   * test from asserting a provenance it does not care about.
   */
  slug_is_fallback?: boolean
  // LOOKING FOR `push_dispatcher`? It was DELETED on 2026-08-09, along with the
  // `ReminderTickLoop.on_fired` hook it fed. It composed a native notification
  // from the reminder ROW, and the row is the wrong source — a ritual's stored
  // `message` is the dispatch token `ritual:<id>`, which is literally what the
  // owner's phone displayed. The notification for a chat message is now composed
  // by the ONE out-of-turn delivery seam (`gateway/http/deliver.ts` → its `notify`
  // sink → `gateway/push/chat-message-push.ts`), which is the only place that
  // knows the posted text AND its durable row id AND is shared by every producer
  // — a fired reminder, a ritual, the morning brief, the idle nudge, a system
  // notice. The Expo transport itself (`gateway/push/dispatcher.ts`) is unchanged
  // and still built by the composer.
  /**
   * P1.5 / Sprint 21 — wiring cleanup callbacks. The realmode
   * composer opens auxiliary DB handles (e.g. RW registry/identity for
   * the slug-picker hook) that are NOT owned by the module graph but
   * must be closed on gateway shutdown. The boot loop runs these
   * callbacks after `graph.shutdown()` and before `db.close()`.
   *
   * Safe to omit; defaults to a no-op.
   */
  realmode_cleanups?: Array<() => void | Promise<void>>
  /**
   * F4 — the gateway's periodic-tick hook. The boot shell invokes this INSIDE
   * its `WATCHDOG=1` `setInterval` (`gateway/index.ts`), the one process-level
   * liveness loop, on every tick. The Open composer wires it to pulse the
   * supervision watchdog's `HeartbeatPulse` (the real `heartbeat_tracker` source),
   * so the heartbeat goes STALE when the tick loop stops advancing the pulse
   * (timer cleared / scheduler died) — replacing the never-stale `() => Date.now()`
   * stub. (It does NOT catch a synchronous event-loop wedge — see
   * `watchdog/heartbeat.ts`; systemd `WatchdogSec` is the out-of-process teeth for
   * that.) Failure-safe: the boot shell guards the call so a hook throw never
   * aborts the tick. Safe to omit (dev/test paths that don't drive a heartbeat).
   */
  on_gateway_tick?: () => void
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
     * #335 wiring — the terminal-build WAKE observer. Runs in the tick loop's
     * composeTerminalHook chain for EVERY terminal run, after board reconcile +
     * on_run_terminal. The composer wires buildTerminalBuildWakeObserver here —
     * the SAME value it registers at both terminate() chokepoints — so a
     * loop-reaped, a cancelled, and a codegen-cancelled build all wake the agent
     * through one chain (§F6a). Claim-first (`agent_waked_at` single writer), so
     * a second site observing the same row composes no duplicate turn.
     */
    on_terminal_wake?: (run: import('@neutronai/trident/store.ts').TridentRun) => Promise<void>
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
    /** Owner data dir (the `SecretsStore` keyfile's home) the inner loop's
     *  credentialed-`gh` runner resolves the instance GitHub token from, per
     *  command — the READ-side sibling of `run_host`'s credential. */
    gh_data_dir?: string
    /** Frozen `owner_handle` the GitHub token is filed under; a handle, never a
     *  secret (these values transit the launcher prompt as workflow args). */
    gh_owner_handle?: string
    /**
     * Is a Kimi K3 key configured? Called PER LAUNCH (not captured at boot) so a
     * key added later is honoured on the next run rather than the next restart.
     * Absent → the Kimi cross-model panelist never runs, which is graceful and
     * never blocks a merge.
     */
    resolve_kimi_configured?: () => boolean
    /**
     * The owner's per-phase model/effort overrides, resolved per launch.
     *
     * Absent → every phase keeps its default. This resolver is the PRODUCER the
     * per-phase config was missing: the vocabulary, the workflow argument and the
     * router all existed and were correct while nothing ever supplied a value.
     */
    resolve_phase_models?: () => Record<string, { model?: string; effort?: string }> | null
    /**
     * RB2 (b) — resolve the owner's recent reflection corrections/diary block for a
     * launching run. The composer wires this to the SAME `reflection` instance the
     * live-agent chat turn reads (`reflection.loadContext()`), so owner corrections
     * reach the FORGE BUILDER (forge:build + fix rounds) — NOT the independent argus
     * review gate (trust boundary — verified in `trident/inner-workflow-assembly.test.ts`). Reflection
     * was chat-only before RB2. Returns null when nothing is learned → a clean no-op.
     */
    resolve_reflection_context?: (
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
    /**
     * Wake-on-change watcher cadence, in ms (`TridentTickOptions.watch_interval_ms`;
     * default 2_000, `<= 0` disables it). The watcher runs ONE cheap
     * `changeSignature()` query per cadence and wakes the 90 s sweep only when a run
     * actually advanced, so an out-of-process checkpoint is picked up in seconds.
     *
     * Plumbed here because "2 s default, CONFIGURABLE" is only true if a production
     * composition can set it (Argus r3): a knob that exists on the options type and
     * nowhere on the wiring is a knob no operator has. Absent → the 2 s default.
     */
    watch_interval_ms?: number
    /**
     * PULL half of launcher-death detection: an EXTERNAL per-run probe of
     * whether the recorded launcher generation (`workflow_run_id`) is still a
     * live process. Three-valued (`alive`/`dead`/`unknown`): only positive
     * `dead` evidence acts. Absent means no `trident-liveness` loop and preserves
     * prior behaviour byte-for-byte. The trident module owns the durable latch.
     */
    probe_launcher_alive?: import('@neutronai/trident/tick.ts').TridentLivenessProbe
  }
  /**
   * T2 r3 (2026-05-13) — Argus BLOCKING #1: pre-constructed
   * `CronJobRegistry` shared with the wiring's
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
   * §F2 — the SINGLE loop inventory shared across the whole composition
   * boundary. A composer that starts long-lived loops OUTSIDE
   * `composeProductionGraph` (the Open composer starts the
   * `ChunkedUploadSweeper` before this graph composes) creates the registry,
   * registers those loops into it, and threads it here; `composeProductionGraph`
   * then registers ITS loops (reminders, trident, cron, watchdog) into the SAME
   * instance so the ONE boot inventory line + the composer test see the COMPLETE
   * running set. Omitted (Managed / direct composer-test callers) →
   * `composeProductionGraph` creates a fresh registry holding just its own loops.
   */
  loop_registry?: LoopRegistry
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
   * Memory recall (P0-2 — `memory_search`) — when supplied, the `tools`
   * module registers the `memory_search` agent tool backed by this owner's
   * `MemoryStore`, so the live chat agent can recall the entity pages
   * (people/companies/projects/meetings/concepts/originals) + scribe-extracted
   * facts that the WRITE path persists every turn. Closes the write→read
   * asymmetry: scribe writes to memory on every turn, this tool reads it back.
   * Distinct corpus from doc_search (project files) + message_search (chat
   * history) — the vault-wide / fast-fact recall surface. The store is
   * constructed by the production composer (which owns the backing memory
   * client); omitting it leaves the surface unregistered (unchanged pre-recall
   * behaviour). Backend-neutral (RA5 / invariant I2): only the `MemoryStore`
   * interface crosses this seam.
   */
  memory_search?: {
    store: import('@neutronai/gbrain-memory/memory-store.ts').MemoryStore
  }
  /**
   * Agent-dispatch family (parity gap #3 — the named-specialist + ad-hoc
   * background-agent surface that mirrors the legacy harness's `spawn-agent.sh`). When
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
    /**
     * Surface-supplied resolver (F4 round-13) that stamps the ORIGINATING app-ws
     * binding onto an agent-initiated dispatch, so its later stuck-alert routes to
     * exactly the surface it came from (never fanned to sibling projects). The
     * composer supplies it because the `channel_topic_id` derivation is Open-
     * specific; omitting it leaves dispatches origin-less (system-scoped).
     */
    resolve_delivery_target?: import('@neutronai/agent-dispatch/tool.ts').DispatchToolSurfaceOptions['resolve_delivery_target']
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
    /**
     * #429 task 4 — deterministic chat ack. When supplied, an agent
     * `work_board_add` success + an inline_active false→true `work_board_update`
     * post a short confirmation to the originating chat immediately (durable+live
     * via the composer's app-ws seam), so a chat-dispatched board mutation is not
     * silent until the turn's single reply() lands. Omitted → no post.
     */
    chat_ack?: import('@neutronai/work-board/chat-ack.ts').WorkBoardChatAck
    /**
     * Derived-inline-activity batch dep for `work_board_list` — mirrors the HTTP
     * surface's `derive_inline_active` dep (T3), so the agent reads the SAME
     * evidence truth the clients do. Display-only: ONE O(1) evidence read per
     * call, never a write, and it never gates, denies or delays a tool call.
     * Omitted ⇒ raw stored-flag passthrough (unchanged behaviour).
     */
    derive_inline_active?: (
      items: import('@neutronai/work-board/store.ts').WorkBoardItem[],
      project_id: string,
    ) => import('@neutronai/work-board/store.ts').WorkBoardItem[]
    /**
     * The composer-built card-removal chokepoint (cancel a live bound run →
     * dispose the card's `plans/` doc by reason → hard-delete the row) — the
     * SAME instance the HTTP DELETE behind the UI's X uses. When supplied, the
     * `work_board_remove` agent tool registers, so an agent removal and a human
     * removal share one path. Omitted → the tool is absent (legacy boots
     * unchanged).
     */
    removal?: import('@neutronai/work-board/removal.ts').WorkBoardRemovalService
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
    /**
     * The merge-mode PROBE, REQUIRED. The composer owns the GitHub credential,
     * so it owns this. Optional here once meant the tool surface fell through to
     * an uncredentialed `gh auth status` probe (`trident/board-dispatch.ts`).
     *
     * A probe rather than a `(repo_path) => MergeMode` function on purpose: the
     * probe carries `publisher`, so which credential this seam closes over is
     * assertable at the boot-wiring test instead of merely being a function.
     */
    merge_mode_probe: import('@neutronai/trident/git-mode.ts').GitModeProbe
    /**
     * The ALREADY-LANDED probe. Like `merge_mode_probe` this is the composer's
     * to own, because it shells out through the credentialed host runner: it
     * asks GitHub whether this card's branch already merged, so a lane refuses
     * to rebuild work that is already on main.
     */
    landed_probe?: import('@neutronai/trident/board-dispatch.ts').DispatchLandedProbe
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
    /**
     * #429 task 4 — deterministic chat ack. When supplied, a SUCCESSFUL
     * board-bound dispatch/start (`work_board_dispatch_build` / `work_board_start`)
     * posts a short `build_dispatched` confirmation to the chat immediately.
     * Rejected dispatches post nothing. Omitted → no post.
     */
    chat_ack?: import('@neutronai/work-board/chat-ack.ts').WorkBoardChatAck
    /**
     * EXECUTOR LIVENESS PREFLIGHT. When supplied, it runs BEFORE the chokepoint
     * and a refusal means NO RUN ROW IS CREATED and the reason is returned to the
     * agent verbatim.
     *
     * Wired to `codexDispatchPreflight`, which refuses only when the owner's
     * BUILD phase actually dispatches to codex AND every connected seat has been
     * positively probed and refused by the ChatGPT backend — a lane launched onto
     * a revoked seat otherwise spends ~15 minutes assembling a brief for a build
     * that cannot start, and blames the CLI. Omitted → unchanged behaviour.
     */
    preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>
    /**
     * The dispatch hold queue. Forwarded to the chokepoint, where the declared-
     * blocker and file-contention gates live. Omitted → those two gates fail
     * OPEN for this entry, which is the failure mode that does not announce
     * itself: builds still start, they just stop respecting dependencies.
     */
    holds?: import('@neutronai/trident/dispatch-holds.ts').DispatchHoldStore
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
    service: import('../../../gateway/wiring/create-project-tool.ts').CreateProjectToolService
  }
  /**
   * Owner-approved host deploy — when supplied, the `tools` module registers the
   * `host_deploy_request` + `host_deploy_status` agent tools, and the `approval`
   * module hands the freshly-built `ApprovalManager` to `install`.
   *
   * TWO FIELDS, ONE REASON: the `tools` module initializes BEFORE `approval`
   * (`approval` declares `deps:['tools']`), but the service needs the graph's
   * `ApprovalManager` — the same instance whose rows the owner's button tap
   * resolves. So the tool registers against a LATE-BOUND `service` getter and
   * `install` fills it in from the approval module's init. Identical shape to
   * the composer's existing late-bound `ritualRegistration` getter; `null`
   * until installed, which reads as "not wired on this instance" rather than
   * throwing.
   *
   * The instance holds no deploy capability either way: the service only ASKS.
   */
  host_deploy?: {
    service: () =>
      | import('../../../gateway/wiring/host-deploy-tool.ts').HostDeployToolService
      | null
    install: (deps: { approvals: import('@neutronai/tools/approval.ts').ApprovalManager }) => void
    /**
     * Where an approval prompt goes when the CALL carried no topic. A warm-REPL
     * agent has no bound `TopicContext` (`mcp/server.ts:279`), so its tool calls
     * arrive `topic_id: null` and the button would land in General — the owner
     * told to tap in a conversation he is not in. `project_id` does survive that
     * path, so the composer supplies the resolver that turns one into a topic.
     * Omitted = the previous install-default fallback, unchanged.
     */
    resolveProjectTopic?: import('../../../gateway/wiring/host-deploy-tool.ts').ResolveProjectTopic
  }
}
