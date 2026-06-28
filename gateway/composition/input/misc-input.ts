import type { CronJobRegistry } from '../../../cron/jobs.ts'
import type { ProjectDb } from '../../../persistence/index.ts'

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
    onFired(reminder: import('../../../reminders/store.ts').Reminder): Promise<void>
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
   * Trident v2 (Phase 2 hard cutover) — drive the foundational
   * Forge→Argus→merge loop live. When `build_substrate` is supplied, the
   * `trident` module wires the REAL orchestrator `step`
   * (`buildTridentOrchestrator` + `buildWorkflowInnerLoop`) so every
   * non-terminal `code_trident_runs` row (created by `/code <task>` or a
   * governed Ralph run) is advanced end-to-end by the tick loop: launch the
   * inner CC Dynamic Workflow (Forge build → parallel Argus review → synthesis
   * → bounded fix loop) → on APPROVE merge (per git-mode) → done. When omitted,
   * the module falls back to `stubAdvanceDeps` (classify always "running") so
   * the loop is live + restart-safe but advances nothing — the unchanged Open
   * dev/default behaviour.
   *
   * `build_substrate(cwd)` builds a FRESH disposable substrate rooted at the
   * run's worktree; the inner-loop launcher runs ONE turn on it that invokes the
   * `Workflow` tool on `trident/inner-workflow.mjs` (the production composer
   * passes the per-instance Anthropic `cc-trident-*` factory). `run_host` runs
   * the git/gh host commands (defaults to a `Bun.spawn` runner).
   */
  trident?: {
    build_substrate: (cwd: string) => import('../../../runtime/substrate.ts').Substrate
    run_host?: import('../../../trident/merge.ts').RunHostCommand
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
    on_run_terminal?: (run: import('../../../trident/store.ts').TridentRun) => Promise<void>
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
    runtime: import('../../../doc-search/runtime.ts').DocSearchRuntime
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
    runtime: import('../../../message-search/runtime.ts').MessageSearchRuntime
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
    store: import('../../../gbrain-memory/memory-store.ts').MemoryStore
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
    service: import('../../../agent-dispatch/service.ts').DispatchService
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
    backend: import('../../../skill-forge/backend.ts').SkillForgeBackend
  }
}
