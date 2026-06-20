import type { TaskStore } from '../../../tasks/store.ts'
import type { LlmCallFn } from '../../../onboarding/interview/phase-spec-resolver.ts'
import type { PersonaPromptLoader } from '../../realmode-composer/persona-loader.ts'

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
   * leave it unset; production wires all three.
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
  }
}
