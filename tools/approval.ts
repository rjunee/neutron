/**
 * @neutronai/tools — HITL approval surface.
 *
 * HITL approval surface. Stores pending approval
 * requests in `tool_approvals` (migration 0004), and surfaces them via the
 * channel adapter (Telegram inline-keyboard for prompt-user; admin channel
 * for prompt-admin).
 *
 * State machine:
 *
 *   pending  --approve--> approved
 *   pending  --deny----->  denied
 *   pending  --expire-->  expired   (post-TTL sweep)
 *
 * The runtime calls `requestApproval(req)`; it persists the row, asks the
 * notifier to surface the prompt, then returns a Promise that resolves with
 * the decision (or rejects on expire). `respondApproval(id, decision, by)`
 * is invoked by the channel adapter when the user / admin makes a decision.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ApprovalPolicy } from './registry.ts'

export type ApprovalDecision = 'approved' | 'denied' | 'expired'

export interface ApprovalRequest {
  /** Caller-supplied id. UUID-shaped; the registry generates if absent. */
  id?: string
  project_slug: string
  topic_id: string | null
  tool_name: string
  args: unknown
  /** Routing hint — `auto` SHORT-CIRCUITS to approved without persisting. */
  policy: ApprovalPolicy
}

export interface ApprovalRow {
  id: string
  project_slug: string
  topic_id: string | null
  tool_name: string
  args_json: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  requested_at: number
  decided_at: number | null
  decided_by: string | null
}

export interface ApprovalNotifier {
  /**
   * Surface the approval prompt to the user (Telegram inline keyboard,
   * admin channel, etc.). The notifier is responsible for the channel
   * delivery; this module is responsible for state.
   */
  notify(row: ApprovalRow): Promise<void>
}

/**
 * Default TTL — pending approvals beyond this become eligible for the
 * expire sweep. Matches the OpenClaw 5-minute approval window per the
 * lifted exec-approval pattern.
 */
export const APPROVAL_DEFAULT_TTL_MS = 5 * 60_000

export interface ApprovalManagerOptions {
  ttl_ms?: number
  /**
   * Injectable clock for tests. Defaults to `Date.now`. The expire sweep
   * uses this so a test can roll the clock without sleeping.
   */
  now?: () => number
}

export class ApprovalManager {
  private readonly ttl_ms: number
  private readonly now: () => number
  /** call_id → resolver. The Promise returned by `requestApproval`. */
  private readonly pending = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; reject: (err: Error) => void }
  >()

  constructor(
    private readonly db: ProjectDb,
    private readonly notifier: ApprovalNotifier,
    options: ApprovalManagerOptions = {},
  ) {
    this.ttl_ms = options.ttl_ms ?? APPROVAL_DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Submit an approval request. For policy=auto, returns immediately with
   * 'approved' (no persistence). For prompt-user / prompt-admin, persists
   * a row and returns a Promise that resolves on respondApproval / expire.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    if (req.policy === 'auto') {
      return 'approved'
    }
    const id = req.id ?? crypto.randomUUID()
    const requested_at = this.now() / 1000
    const args_json = JSON.stringify(req.args ?? null)

    await this.db.run(
      `INSERT INTO tool_approvals
         (id, project_slug, topic_id, tool_name, args_json, status, requested_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [id, req.project_slug, req.topic_id, req.tool_name, args_json, requested_at],
    )

    const row: ApprovalRow = {
      id,
      project_slug: req.project_slug,
      topic_id: req.topic_id,
      tool_name: req.tool_name,
      args_json,
      status: 'pending',
      requested_at,
      decided_at: null,
      decided_by: null,
    }

    // Notifier failures must not crash the request — the row is persisted
    // and the expire sweep will eventually clear it. Surface the failure
    // through the result promise so callers can see it but keep the lock
    // discipline straightforward.
    void this.notifier.notify(row).catch((err) => {
      console.error('approval notifier failed:', err)
    })

    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /**
   * Apply a decision. Called by the channel adapter when the user clicks
   * approve/deny. Idempotent: a second decision on the same id no-ops.
   */
  async respondApproval(
    id: string,
    decision: 'approved' | 'denied',
    decided_by: string,
  ): Promise<void> {
    const decided_at = this.now() / 1000
    await this.db.run(
      `UPDATE tool_approvals
         SET status = ?, decided_at = ?, decided_by = ?
       WHERE id = ? AND status = 'pending'`,
      [decision, decided_at, decided_by, id],
    )
    const waiter = this.pending.get(id)
    if (waiter) {
      this.pending.delete(id)
      waiter.resolve(decision)
    }
  }

  /**
   * Expire pending requests older than ttl_ms. Returns the count expired.
   * Called by the watchdog tick or a periodic sweep.
   */
  async expireStale(): Promise<number> {
    const cutoff = (this.now() - this.ttl_ms) / 1000
    const stale = this.db
      .prepare<{ id: string }, [number]>(
        `SELECT id FROM tool_approvals WHERE status = 'pending' AND requested_at < ?`,
      )
      .all(cutoff)

    if (stale.length === 0) return 0

    await this.db.transaction(async (tx) => {
      const updateAt = this.now() / 1000
      for (const { id } of stale) {
        await tx.run(
          `UPDATE tool_approvals SET status = 'expired', decided_at = ? WHERE id = ?`,
          [updateAt, id],
        )
      }
    })
    for (const { id } of stale) {
      const waiter = this.pending.get(id)
      if (waiter) {
        this.pending.delete(id)
        waiter.resolve('expired')
      }
    }
    return stale.length
  }

  /**
   * Look up a row by id. Used by the channel adapter when rendering a
   * decision-confirmation reply ("you approved tool X").
   */
  get(id: string): ApprovalRow | null {
    const row = this.db
      .prepare<ApprovalRow, [string]>(
        `SELECT id, project_slug, topic_id, tool_name, args_json, status,
                requested_at, decided_at, decided_by
           FROM tool_approvals WHERE id = ?`,
      )
      .get(id)
    return row ?? null
  }

  /**
   * Snapshot of all pending approvals for an instance. Used by the gateway
   * during graceful drain to decide whether to wait or expire.
   */
  listPending(project_slug: string): ApprovalRow[] {
    return this.db
      .prepare<ApprovalRow, [string]>(
        `SELECT id, project_slug, topic_id, tool_name, args_json, status,
                requested_at, decided_at, decided_by
           FROM tool_approvals
          WHERE project_slug = ? AND status = 'pending'
          ORDER BY requested_at ASC`,
      )
      .all(project_slug)
  }
}
