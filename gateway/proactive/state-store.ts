/**
 * @neutronai/gateway/proactive — bookkeeping store.
 *
 * Thin typed wrapper over the two tables in migration 0080:
 *
 *   • `proactive_brief_log`   — once-per-owner-local-day morning-brief guard.
 *   • `proactive_topic_state` — per-topic idle-nudge dedupe ledger.
 *
 * All writes go through `ProjectDb.run` (busy-retry-wrapped); reads use
 * prepared statements. Kept deliberately dumb — the policy (when to brief,
 * when to nudge) lives in `morning-brief.ts` / `idle-nudge-sweep.ts`; this
 * module only persists/reads the watermarks those policies consult.
 */

import type { ProjectDb } from '../../persistence/index.ts'

export interface ProactiveTopicState {
  topic_id: string
  project_slug: string
  last_nudged_at: string | null
  last_nudged_task_id: string | null
  last_activity_at_ms: number | null
}

interface BriefLogRow {
  posted_at: string
}

interface TopicStateRow {
  topic_id: string
  project_slug: string
  last_nudged_at: string | null
  last_nudged_task_id: string | null
  last_activity_at_ms: string | null
}

export class ProactiveStateStore {
  constructor(private readonly db: ProjectDb) {}

  /** True when a morning brief has already been posted for `day` (local YYYY-MM-DD). */
  hasBriefForDay(day: string): boolean {
    const row = this.db
      .prepare<BriefLogRow, [string]>(
        `SELECT posted_at FROM proactive_brief_log WHERE day = ? LIMIT 1`,
      )
      .get(day)
    return row !== undefined && row !== null
  }

  /**
   * Record that the brief for `day` was posted. Idempotent: a racing second
   * tick's INSERT collides on the PK and is swallowed (the first write wins).
   */
  async recordBriefForDay(day: string, postedAtIso: string, topicId: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO proactive_brief_log (day, posted_at, topic_id)
       VALUES (?, ?, ?)
       ON CONFLICT(day) DO NOTHING`,
      [day, postedAtIso, topicId],
    )
  }

  /** Read a topic's nudge ledger row, or null when never nudged. */
  getTopicState(topicId: string): ProactiveTopicState | null {
    const row = this.db
      .prepare<TopicStateRow, [string]>(
        `SELECT topic_id, project_slug, last_nudged_at, last_nudged_task_id,
                last_activity_at_ms
           FROM proactive_topic_state WHERE topic_id = ? LIMIT 1`,
      )
      .get(topicId)
    if (row === undefined || row === null) return null
    return {
      topic_id: row.topic_id,
      project_slug: row.project_slug,
      last_nudged_at: row.last_nudged_at,
      last_nudged_task_id: row.last_nudged_task_id,
      last_activity_at_ms:
        row.last_activity_at_ms === null ? null : Number(row.last_activity_at_ms),
    }
  }

  /** Upsert a topic's nudge ledger after a successful post. */
  async recordNudge(input: {
    topic_id: string
    project_slug: string
    task_id: string
    nudged_at_iso: string
    last_activity_at_ms: number | null
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO proactive_topic_state
         (topic_id, project_slug, last_nudged_at, last_nudged_task_id,
          last_activity_at_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_id) DO UPDATE SET
         project_slug        = excluded.project_slug,
         last_nudged_at      = excluded.last_nudged_at,
         last_nudged_task_id = excluded.last_nudged_task_id,
         last_activity_at_ms = excluded.last_activity_at_ms,
         updated_at          = excluded.updated_at`,
      [
        input.topic_id,
        input.project_slug,
        input.nudged_at_iso,
        input.task_id,
        input.last_activity_at_ms === null ? null : String(input.last_activity_at_ms),
        input.nudged_at_iso,
      ],
    )
  }
}
