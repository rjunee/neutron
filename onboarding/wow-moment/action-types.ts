/**
 * @neutronai/onboarding/wow-moment — shared action types.
 *
 * One declarative module shape every action exports. Keeps the catalogue
 * + dispatcher + action-runner agnostic to the action's internals: each
 * action implements `triggerCondition` (a pure predicate over the
 * dispatch context) and `run` (the side-effecting implementation).
 *
 * Per docs/plans/P2-onboarding.md § 2.5 + § 4.
 */

import type { ButtonPrompt } from '../../channels/button-primitive.ts'
import type { ImportResult } from '../history-import/types.ts'
import type { ReminderStore } from '../../reminders/store.ts'
import type { TaskStore } from '../../tasks/store.ts'
import type { CronJobRegistry } from '../../cron/jobs.ts'
import type { CronStateStore } from '../../cron/state.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import type { ProjectMaterializer } from './project-materializer.ts'
import type { WowActionId, WowEngagement } from './telemetry.ts'

/**
 * Captured interview state. Wow-moment reads `phase_state_json` for
 * trigger predicates (rituals_captured for action 2, contemplative
 * keywords for action 6, captured-projects for action 3).
 */
export interface WowInterviewState {
  display_name?: string
  archetype_blend?: string[]
  /** Free-form keys captured during the interview phases. The dispatcher
   *  reads documented keys (`rituals_captured`, `contemplative_keywords`,
   *  `projects_captured`); unknown keys are ignored. */
  phase_state_json?: Record<string, unknown>
}

export interface RitualEntry {
  /** 'morning' | 'evening' | 'weekly' — required so action 2's trigger fires. */
  kind: 'morning' | 'evening' | 'weekly'
  /** Free-text label the user gave (e.g. "5-minute meditation"). */
  label: string
  /** Time-of-day in `HH:MM` (24h, local) when this ritual happens. */
  time_of_day: string
}

export interface CapturedProject {
  name: string
  rationale?: string
}

/**
 * Stalled email thread record — Pass-2 import surfaces these to action 5.
 * Email content is kept minimal so the action can decide whether to
 * draft without reading every message.
 */
export interface StalledEmailThread {
  thread_id: string
  recipient_email: string
  subject: string
  /** Most recent inbound timestamp (unix-ms). */
  last_inbound_at: number
  /** Most recent outbound (from user) timestamp (unix-ms). */
  last_outbound_at: number
  inbound_count: number
  /** Optional one-line preview the LLM extracted; for telemetry only — drafts pull full content from Gmail at fire time. */
  one_line_preview?: string
}

/**
 * Gmail OAuth scope state at fire time. Action 5 short-circuits if
 * `gmail.compose` is missing.
 */
export interface GmailScopeState {
  scopes: string[]
  /** Convenience computed flag — `true` iff `gmail.compose` is in `scopes`. */
  has_compose: boolean
}

/**
 * Adapter the action-runner injects into each action's `run`. Lets the
 * action send a button-prompt back to the user without coupling to the
 * channel layer.
 */
export interface WowChannelAdapter {
  /** Send a button-prompt; returns the resolved ButtonChoice OR null on timeout / no-tap. */
  emitPrompt(input: { prompt: ButtonPrompt; topic_id: string }): Promise<{ prompt_id: string }>
  /** Send plain text into the active topic (no button) — used by action 1's brief. */
  sendText(input: { topic_id: string; body: string }): Promise<{ message_id: string }>
}

/**
 * Gmail draft client. Action 5 calls `createDraft`; never `send`. The
 * action-runner asserts no `send` was called via test mocks; production
 * wires the real Gmail API.
 */
export interface GmailDraftClient {
  createDraft(input: {
    to: string
    subject: string
    body: string
  }): Promise<{ draft_id: string; gmail_open_url: string }>
}

/**
 * Substrate dispatch — used by action 1 to ask the LLM to compose the
 * first-week brief. Production wires the real Anthropic substrate;
 * tests inject a deterministic stub.
 */
export interface BriefSubstrate {
  composeBrief(input: {
    project_slug: string
    interview: WowInterviewState
    import_result: ImportResult | null
  }): Promise<{ body: string; tokens_used: number }>
}

/**
 * Single-shot context handed to every action's `triggerCondition` +
 * `run`. The action-runner builds this from the dispatcher's signals.
 */
export interface WowActionContext {
  project_slug: string
  topic_id: string
  /** Per-instance home dir (where persona files + cron state live). */
  owner_home: string
  interview: WowInterviewState
  import_result: ImportResult | null
  rituals: RitualEntry[]
  captured_projects: CapturedProject[]
  /**
   * 2026-05-28 sprint — true iff the engine observed a `projects_proposed`
   * confirmation write (`primary_projects_confirmed` was set in
   * phase_state, including the deliberate `[]` from the zero-state
   * skip-ahead). Lets `03-project-shells` distinguish "user explicitly
   * confirmed zero projects" (skip the `import_result` fallback) from
   * "user never reached confirmation" (fall back to the import-derived
   * candidate set per the legacy contract). Optional + defaults to
   * false at the dispatcher so legacy callers stay at the pre-fix
   * behavior.
   */
  projects_confirmed?: boolean
  contemplative_keywords: string[]
  stalled_threads: StalledEmailThread[]
  gmail_scopes: GmailScopeState | null
  /** Reminder store (action 2 + 6). */
  reminders: ReminderStore
  /**
   * P6 — canonical task store. Optional for back-compat: legacy
   * dispatch contexts that haven't wired the seeder yet pass it
   * undefined and Action 4 falls back to `ctx.import_result.proposed_tasks`.
   * Production composition supplies it.
   */
  task_store?: TaskStore
  /** Cron registry (action 7). */
  cron_jobs: CronJobRegistry
  /** Cron state store (action 7). */
  cron_state: CronStateStore
  /** Project DB (action 3 — for inserting topics + projects rows). */
  db: ProjectDb
  /** Channel adapter for emit prompts + send text. */
  channel: WowChannelAdapter
  /** Gmail draft client (action 5). Null when no Gmail OAuth. */
  gmail: GmailDraftClient | null
  /** Substrate (action 1). Optional — action 1 falls back to a templated body if absent. */
  substrate?: BriefSubstrate
  /**
   * Item 4 (post-onboarding-experience spec § ITEM 4) — project
   * materializer used by action 3 to produce the on-disk project repo
   * (standard doc set + transcript slices + memory index). Optional:
   * when absent, action 3 default-builds a deterministic materializer
   * from `owner_home`/`db` (no LLM composer, no memory indexer) so
   * every dispatch path materializes the § 3 layout by construction.
   * Production wires an enriched instance (CC-substrate doc composer +
   * GBrain page indexer) via `build-wow-dispatcher.ts`.
   */
  materializer?: ProjectMaterializer
  /** Test seam for clock + uuid. */
  now(): number
  uuid(): string
}

/**
 * The result every action returns. The runner persists telemetry from
 * this shape.
 */
export interface WowActionResult {
  fired: boolean
  /** Short tag — 'ok' | 'no_trigger' | 'substrate_error' | 'scope_missing' | etc. */
  reason: string
  /** Action-specific redacted payload — counts, hashes, NEVER raw user data. */
  redacted_payload?: Record<string, unknown>
  /** Optional engagement-prompt id; the runner records the engagement when the user taps. */
  follow_up_prompt_id?: string
}

/** What every actions/0N-<slug>.ts default-exports. */
export interface WowActionModule {
  action_id: WowActionId
  /** Pure predicate. False → action skips silently. True → runner calls `run`. */
  triggerCondition(ctx: WowActionContext): boolean
  /** Side-effecting implementation. Throws → runner records failure per spec. */
  run(ctx: WowActionContext): Promise<WowActionResult>
  /** Optional engagement decoder — maps a ButtonChoice value to a WowEngagement tag. */
  decodeEngagement?(choice_value: string): WowEngagement | null
}
