import type { TaskStore } from '@neutronai/tasks/store.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import type { PersonaPromptLoader } from '../../wiring/persona-loader.ts'
import type { NudgeRater, ProactiveTopicCandidate } from '../../proactive/idle-nudge-sweep.ts'
import type { OutboundSink } from '../../proactive/sink.ts'

export interface TasksCompositionInput {
  /**
   * P6 — task system overhaul opt-ins. When supplied, the composer
   * wires a `TaskStore` module + the post-P6.0 surfaces:
   *
   *   - The 4-hourly per-instance `tasks.focus_score_recompute` cron
   *     that re-stamps `focus_score` on every open task.
   *   - The reminder ↔ task auto-link subscriber so tasks with a
   *     `due_date` synchronously create + cascade-cancel reminders.
   *   - The STATUS.md / ACTIONS.md projection writer, when
   *     `projection.resolveProjectDir` is supplied — debounced 500ms
   *     per (instance, project), marked-block STATUS.md rewrite +
   *     whole-file ACTIONS.md regeneration with atomic writes.
   *
   * Optional — when omitted the canonical TaskStore is still
   * available via `graph.get('tasks').store` but no cron / projection
   * / reminder-link side effects fire. Tests + bespoke composers
   * leave it unset.
   *
   * `open/composer.ts` — the ONLY production composer — sets `store` plus all
   * FIVE side-effect fields (`enable_focus_score_cron`,
   * `enable_task_prioritize_cron`, `enable_reminder_link`,
   * `enable_nudge_engine_cron`, `projection`).
   *
   * That sentence used to read "production wires all three" and was false for
   * every one of them: no composer set ANY of these fields, so a declared
   * capability shipped as a guaranteed no-op and the comment is what stopped
   * anyone noticing. If you add a field here, wire it in `open/composer.ts` in
   * the SAME change and assert it against the composer's real output in
   * `open/__tests__/` — a hand-built config literal in a test proves the gate
   * works, never that anything reaches it. (ISSUES #439 / #440.)
   *
   * Per docs/plans/P6-task-system-overhaul-sprint-brief.md.
   */
  tasks?: {
    /**
     * Pre-built canonical `TaskStore`. When provided, `tasksModule.init`
     * attaches subscribers to THIS instance and exposes it via
     * `graph.get('tasks').store`. The composer also threads the same
     * instance into the HTTP surfaces (`app_tasks_surface`,
     * `app_focus_surface`) and the Tasks-Core adapter so a single
     * canonical store is shared across every production path —
     * mutations through any surface fire the projection writer +
     * reminder-link subscribers attached by this module.
     *
     * Without this seam each surface would call `new TaskStore(db)`
     * and get an instance with no subscribers — mutations would
     * bypass the projection / reminder-link wiring entirely. Tests +
     * bespoke composers may still omit this field; the module falls
     * back to constructing one internally, but no subscribers fire
     * on writes through other surfaces.
     */
    store?: TaskStore
    /** When true, register the focus-score recompute cron. */
    enable_focus_score_cron?: boolean
    /** Override the 4h tick (testing seam). */
    focus_score_interval_ms?: number
    /**
     * WAVE 3 PR-7 — register the LLM-primary prioritization cron. Each
     * tick hands the open backlog to `task_prioritizer.llm` and stamps
     * `llm_rank` / `llm_reason` / `prioritized_by` on the rows; the
     * `focus_score` order then renders LLM-rank-first. When
     * `task_prioritizer.llm` is null (no credential) the pass runs the
     * deterministic focus-score fallback every tick — registering the
     * cron before a credential exists is harmless.
     */
    enable_task_prioritize_cron?: boolean
    /** Override the 6h tick (testing seam). */
    task_prioritize_interval_ms?: number
    /**
     * WAVE 3 PR-7 — the LLM call + knobs for the prioritization cron.
     * Production passes the same Anthropic-Messages `LlmCallFn` that
     * powers the nudge engine / phase-spec resolver; tests inject a
     * deterministic stub (or `null` to exercise the fallback).
     */
    task_prioritizer?: {
      llm: LlmCallFn | null
      model?: string
      timeout_ms?: number
      limit?: number
    }
    /**
     * P6.1 — register the daily nudge engine cron (LLM "do this next"
     * pick + staleness pass). Requires `nudge_engine.llm` set;
     * without an LLM credential the handler no-ops every tick.
     */
    enable_nudge_engine_cron?: boolean
    /** Override the 24h tick (testing seam). */
    nudge_engine_interval_ms?: number
    /**
     * P6.1 — additional handler deps for the nudge engine. Production
     * passes the same `LlmCallFn` + `PersonaPromptLoader` instance
     * that wire the phase-spec resolver (so the persona mtime cache
     * is shared one-per-instance).
     */
    nudge_engine?: {
      llm: LlmCallFn | null
      personaLoader?: PersonaPromptLoader | null
      timezone?: string
      /** Override Date.now (test seam). Production uses the real clock. */
      now?: () => number
      timeout_ms?: number
      model?: string
    }
    /** When true, wire the reminder-link subscriber. */
    enable_reminder_link?: boolean
    /** Projection writer wiring. When omitted, no STATUS.md projection happens. */
    projection?: {
      resolveProjectDir: (input: {
        project_slug: string
        project_id: string
      }) => { dir: string; name?: string } | null
      /** Override the 500ms coalesce window. */
      debounce_ms?: number
    }
    /**
     * P0-5 — proactive messaging (gap-audit WAVE 2 Track A). When supplied,
     * the composer wires the daily morning brief and/or the idle-topic
     * nudge sweep onto the shared cron registry, posting through the
     * production `ChannelRouter`. Both reuse the existing cron infra + the
     * P6 nudge ranker (`current_focus_pick`); this block only supplies the
     * production-specific seams (which topic to post to, how to enumerate
     * idle topics, optional extra context sources).
     *
     * Optional — when omitted neither cron registers (unchanged Open
     * default). Each half is independently gated:
     *   • The morning brief registers only when `resolveGeneralTopic` is
     *     set and returns a topic; absent → no brief.
     *   • The idle-nudge sweep registers only when `listIdleTopics` is set;
     *     absent → no sweep (Neutron has no generic last-activity index yet,
     *     so the host supplies the enumeration).
     */
    proactive?: {
      /**
       * Resolve the General/main topic's `channel_topic_id` the brief posts
       * to (`<chat_id>[:<thread_id>]` for Telegram). Return null to disable
       * the brief for this instance (e.g. onboarding not yet complete).
       */
      resolveGeneralTopic?: () => string | null
      // NOTE (ISSUES #504): `sources` (calendar / entity-delta / project-STATUS
      // brief providers), `composeBrief`, `brief_hour` and `brief_interval_ms` used
      // to configure a SECOND morning brief from here. All four are gone with it.
      // No production composer ever set `sources`, so the brief's calendar provider
      // was supplied by nothing but its own test and the digest had to admit it had
      // not checked the calendar. The morning brief is now the RITUAL, scheduled as
      // an ordinary reminder onto the owner's own session.
      /**
       * Enumerate the active project-bound topics + their last-activity
       * watermark for the idle sweep. Required to enable the sweep.
       */
      listIdleTopics?: () => ProactiveTopicCandidate[] | Promise<ProactiveTopicCandidate[]>
      /**
       * Override the outbound sink the idle sweep posts through. Absent →
       * the core `ChannelRouter` (Telegram instances). Open supplies a DURABLE
       * web sink (`buildButtonStoreProactiveSink`) because its `app_socket`
       * topics fire from a timer with no guaranteed live socket — a router
       * post via the live-only `AppWsAdapter` would silently drop the message.
       */
      sink?: OutboundSink
      /**
       * Optional dual-rating ≥7 quality gate for the idle-nudge sweep (the legacy harness
       * parity). When supplied, a candidate that clears idle/dedupe is also
       * rated on leverage + gratitude and only posts when both ≥7. Production
       * wires `buildLlmNudgeRater`; absent → no quality gate (the sweep would
       * nudge on every idle topic, so production MUST supply it).
       */
      rateNudge?: NudgeRater
      /** Owner IANA timezone (defaults to America/Los_Angeles). */
      timezone?: string
      /** Override the idle threshold (default 4h). */
      idle_threshold_ms?: number
      /** Override the sweep cadence (default hourly). */
      sweep_interval_ms?: number
    }
  }
}
