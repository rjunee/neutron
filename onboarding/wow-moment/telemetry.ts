/**
 * @neutronai/onboarding/wow-moment — telemetry sink.
 *
 * Per docs/plans/P2-onboarding.md § 2.5. Each fired action emits two
 * events:
 *
 *   - `onboarding.wow_action_fired` on attempt
 *   - `onboarding.wow_action_engaged` when the user taps the follow-up
 *     button-prompt (or for action 1 / 7, when the substrate ack /
 *     overnight cron actually delivers).
 *
 * Both shapes land in the `wow_events` SQLite table (migration 0013).
 * Optional structured-log mirror via the `eventLogger` hook so the
 * gateway logger can surface to journald in production.
 *
 * Privacy: action 5 + 6 carry hashed identifiers (recipient_hash,
 * reminder_phrase_hash) — never raw email/text content. Action 4
 * carries a redacted task title (truncated + first-line only).
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export type WowActionId =
  | '01-first-week-brief'
  | '02-lifestyle-reminders'
  | '03-project-shells'
  | '04-overdue-task'
  | '05-followup-email-draft'
  | '06-interest-check-in'
  | '07-overnight-pass'

export const ALL_WOW_ACTION_IDS: ReadonlyArray<WowActionId> = [
  '01-first-week-brief',
  '02-lifestyle-reminders',
  '03-project-shells',
  '04-overdue-task',
  '05-followup-email-draft',
  '06-interest-check-in',
  '07-overnight-pass',
]

export type WowEngagement =
  | 'read'
  | 'scrolled'
  | 'idle'
  | 'kept'
  | 'tweaked'
  | 'skipped'
  | 'will_handle'
  | 'snoozed'
  | 'dropped'
  | 'opened'
  | 'sent'
  | 'discarded'

export interface WowFiredEvent {
  project_slug: string
  action_id: WowActionId
  fired_at: number
  success: boolean
  /** Short tag — 'ok' | 'no_trigger' | 'substrate_error' | 'scope_missing' | 'rollback' | etc. */
  success_reason: string
  /** Action-specific redacted payload — counts, hashes, NEVER raw user data. */
  redacted_payload?: Record<string, unknown>
}

export interface WowEngagedEvent {
  project_slug: string
  action_id: WowActionId
  engagement: WowEngagement
  occurred_at: number
}

export interface WowEventRow {
  id: string
  project_slug: string
  action_id: WowActionId
  fired_at: number
  success: boolean
  success_reason: string | null
  engagement: WowEngagement | null
  redacted_payload: Record<string, unknown>
}

interface WowEventDbRow {
  id: string
  project_slug: string
  action_id: string
  fired_at: number
  success: number
  success_reason: string | null
  engagement: string | null
  redacted_payload_json: string
}

/**
 * Production wires `gateway/logger.ts` (sync writer); the P2 S6
 * `bridgeWowEventLogger` returns a function that fires an async
 * `OnboardingTelemetry.emit(...)` and resolves when the persistence row
 * has landed. The interface accepts both shapes — sync writers return
 * `void`, async bridges return a Promise the wow telemetry awaits.
 */
export interface EventLogger {
  (input: { event: string; payload: Record<string, unknown> }): void | Promise<void>
}

export interface WowTelemetryDeps {
  db: ProjectDb
  /** Optional structured-log sink. Production wires `gateway/logger.ts`. */
  eventLogger?: EventLogger
  /** Test seam for deterministic ids + clock. */
  uuid?: () => string
  now?: () => number
}

/**
 * `WowTelemetry` is the action-runner's outbound surface. The runner
 * emits via this; persistence + structured logs are the runner's
 * single concern (the actions themselves stay focused on the side-
 * effect they're producing).
 */
export class WowTelemetry {
  private readonly db: ProjectDb
  private readonly eventLogger?: EventLogger
  private readonly uuid: () => string
  private readonly now: () => number

  constructor(deps: WowTelemetryDeps) {
    this.db = deps.db
    if (deps.eventLogger !== undefined) this.eventLogger = deps.eventLogger
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** Record a fired event + return the persisted row id. */
  async recordFired(input: WowFiredEvent): Promise<{ id: string }> {
    const id = this.uuid()
    await this.db.run(
      `INSERT INTO wow_events
         (id, project_slug, action_id, fired_at, success, success_reason,
          engagement, redacted_payload_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        id,
        input.project_slug,
        input.action_id,
        input.fired_at,
        input.success ? 1 : 0,
        input.success_reason,
        JSON.stringify(input.redacted_payload ?? {}),
      ],
    )
    if (this.eventLogger !== undefined) {
      await this.eventLogger({
        event: 'onboarding.wow_action_fired',
        payload: {
          project_slug: input.project_slug,
          action_id: input.action_id,
          fired_at: input.fired_at,
          success: input.success,
          success_reason: input.success_reason,
          ...(input.redacted_payload ?? {}),
        },
      })
    }
    return { id }
  }

  /**
   * Record engagement on the most-recently-fired event for (owner,
   * action). If no fired event exists, the engagement is stored on a
   * fresh synthetic row (engagement-only) so the analytics view never
   * misses a tap. The synthetic-row path is a safety net for callbacks
   * that race ahead of the runner's persistence; it should not happen
   * in production.
   */
  async recordEngaged(input: WowEngagedEvent): Promise<void> {
    // P2 (raw() sweep): this WRITE used to ride `raw().query(...).get()` only
    // to learn whether a row matched; `runSync` reports the same fact via
    // `changes` (query text byte-identical, RETURNING clause kept).
    const updated = this.db.runSync<[string, string, string]>(
      `UPDATE wow_events
            SET engagement = ?
          WHERE id = (
            SELECT id FROM wow_events
             WHERE project_slug = ? AND action_id = ? AND engagement IS NULL
             ORDER BY fired_at DESC LIMIT 1
          )
          RETURNING id`,
      [input.engagement, input.project_slug, input.action_id],
    )
    if (updated.changes === 0) {
      const id = this.uuid()
      await this.db.run(
        `INSERT INTO wow_events
           (id, project_slug, action_id, fired_at, success, success_reason,
            engagement, redacted_payload_json)
         VALUES (?, ?, ?, ?, 0, 'engagement_only', ?, '{}')`,
        [id, input.project_slug, input.action_id, input.occurred_at, input.engagement],
      )
    }
    if (this.eventLogger !== undefined) {
      await this.eventLogger({
        event: 'onboarding.wow_action_engaged',
        payload: {
          project_slug: input.project_slug,
          action_id: input.action_id,
          engagement: input.engagement,
          occurred_at: input.occurred_at,
        },
      })
    }
  }

  /**
   * Snapshot — returns every event for an instance in fired_at order, with
   * `rowid ASC` as the deterministic tiebreaker (so simultaneous fires
   * surface in insertion order, which matches dispatch order — the
   * dispatcher calls actions sequentially).
   */
  list(project_slug: string): WowEventRow[] {
    const rows = this.db
      .all<WowEventDbRow, [string]>(
        `SELECT id, project_slug, action_id, fired_at, success, success_reason,
                engagement, redacted_payload_json
           FROM wow_events
          WHERE project_slug = ?
          ORDER BY fired_at ASC, rowid ASC`,
        [project_slug],
      )
    return rows.map((r) => ({
      id: r.id,
      project_slug: r.project_slug,
      action_id: r.action_id as WowActionId,
      fired_at: r.fired_at,
      success: r.success === 1,
      success_reason: r.success_reason,
      engagement: r.engagement as WowEngagement | null,
      redacted_payload: JSON.parse(r.redacted_payload_json) as Record<string, unknown>,
    }))
  }
}
