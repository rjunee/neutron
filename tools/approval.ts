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
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('approval')

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
 * expire sweep. Matches the Legacy-agent 5-minute approval window per the
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
    fireAndForget('approval.notify', this.notifier.notify(row), (err) => {
      log.error('notifier_failed', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    })

    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  /**
   * Apply a decision. Called by the channel adapter when the user clicks
   * approve/deny. Idempotent: a second decision on the same id no-ops.
   *
   * ATOMIC CLAIM. Returns TRUE only for the call that actually transitioned the
   * row out of 'pending', and FALSE when the row was already decided, expired or
   * absent. The `WHERE status = 'pending'` predicate and the affected-row count
   * are read inside ONE transaction, so of two callers racing the same id
   * exactly one is told `true`. A caller that DOES something on the strength of a
   * decision — dispatches a deploy, schedules a ritual — must gate that side
   * effect on this boolean; without it, two taps that interleave across an
   * `await` both believe they won, and an Approve can act after a concurrent Deny
   * has already settled the row (Argus r1 BLOCKER against the host-deploy caller,
   * `open/host-deploy.ts`). Callers that ignore the value keep their previous
   * behaviour exactly.
   */
  async respondApproval(
    id: string,
    decision: 'approved' | 'denied',
    decided_by: string,
  ): Promise<boolean> {
    const decided_at = this.now() / 1000
    // `runSync` inside `transaction` because only the sync form reports
    // `changes`; the transaction holds the per-instance mutex across the read of
    // that count, so the claim and its result cannot be split by another writer.
    const claimed = await this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE tool_approvals
           SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
        [decision, decided_at, decided_by, id],
      )
      return res.changes > 0
    })
    const waiter = this.pending.get(id)
    if (waiter) {
      this.pending.delete(id)
      waiter.resolve(decision)
    }
    return claimed
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
   * Record the id of the button prompt this grant was surfaced as, merged into
   * the row's `args_json` (every other stored argument is preserved).
   *
   * THE GRANT→PROMPT LINK. A host-deploy grant dies after its TTL, but the
   * `button_prompts` row it was rendered as does not (its `expires_at` is a
   * decade out), so the owner is left staring at a button that is still drawn,
   * still tappable and connected to nothing. The host-deploy expiry sweep
   * (`open/host-deploy.ts` → `sweepExpiredGrants`) uses this link to RETIRE that
   * prompt when it expires the grant. Written AFTER the emit rather than at
   * insert time because the prompt id does not exist until the prompt has been
   * delivered — the row must already be pending for the emit to reference it.
   *
   * No-op for an unknown id. A row whose `args_json` will not parse is replaced
   * with `{ prompt_id }` — the link is what this method owes the sweep, and
   * unparseable arguments were already unreadable to every other caller.
   */
  async recordPromptLink(id: string, prompt_id: string): Promise<void> {
    await this.mergeArgs(id, { prompt_id })
  }

  /**
   * Merge `patch` into a row's stored `args_json`, preserving every other key.
   *
   * The general form of `recordPromptLink`, extracted when a second caller
   * needed it: the standing deploy window records each deploy it authorised onto
   * its own grant row (`open/host-deploy.ts`), so "which permission authorised
   * this deploy, and what else did it authorise" has an answer after the fact.
   * A grant that cannot say what it was used for is not an audit trail.
   *
   * No-op for an unknown id. A row whose `args_json` will not parse is REPLACED
   * with the patch — those arguments were already unreadable to every caller.
   */
  async mergeArgs(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = this.get(id)
    if (row === null) return
    let args: Record<string, unknown>
    try {
      const parsed = JSON.parse(row.args_json) as unknown
      args = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      args = {}
    }
    // Async `run` — the same per-instance mutex path `cancelPending` uses, so
    // this write serializes behind the INSERT rather than racing it.
    await this.db.run(`UPDATE tool_approvals SET args_json = ? WHERE id = ?`, [
      JSON.stringify({ ...args, ...patch }),
      id,
    ])
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

  /**
   * Every APPROVED durable grant for `(project_slug, tool_name)`, oldest
   * decision first. Generic query — this platform module knows nothing about
   * rituals; the ritual layer (`reminders/ritual-approval.ts`, a legal
   * services→platform edge) namespaces `tool_name` (`ritual:<id>` /
   * `ritual-egress:<id>`) and content-hash-matches on `args_json`. Synchronous
   * prepare/all like `get`/`listPending`.
   */
  findApproved(project_slug: string, tool_name: string): ApprovalRow[] {
    return this.db
      .prepare<ApprovalRow, [string, string]>(
        `SELECT id, project_slug, topic_id, tool_name, args_json, status,
                requested_at, decided_at, decided_by
           FROM tool_approvals
          WHERE project_slug = ? AND tool_name = ? AND status = 'approved'
          ORDER BY decided_at ASC`,
      )
      .all(project_slug, tool_name)
  }

  /**
   * Every durable grant row for `(project_slug, tool_name)` regardless of status,
   * NEWEST decision first (undecided rows — no `decided_at` — sort last). Generic
   * query; the ritual layer uses it to report a DENIED grant in `rituals_status`
   * (`findApproved`/`listPending` alone can only see approved/pending, so a denied
   * ritual was mis-reported as 'none' — Argus r1 minor). Synchronous prepare/all.
   */
  findByToolName(project_slug: string, tool_name: string): ApprovalRow[] {
    return this.db
      .prepare<ApprovalRow, [string, string]>(
        `SELECT id, project_slug, topic_id, tool_name, args_json, status,
                requested_at, decided_at, decided_by
           FROM tool_approvals
          WHERE project_slug = ? AND tool_name = ?
          ORDER BY decided_at DESC, requested_at DESC`,
      )
      .all(project_slug, tool_name)
  }

  /**
   * Cancel a still-PENDING request: mark it 'expired' and resolve its waiter with
   * 'expired'. No-op if the row is already decided/expired/absent. Used to roll
   * back the approval rows minted for a ritual whose approval-prompt emission
   * later failed (Argus r1 MAJOR) so no orphan pending grant lingers until the TTL
   * sweep. Returns true iff a pending row was transitioned.
   */
  async cancelPending(id: string): Promise<boolean> {
    const decided_at = this.now() / 1000
    // Async `run` (not `runSync`): it routes through the per-instance mutex, so a
    // cancel issued right after a not-yet-awaited `requestApproval` serializes
    // AFTER that INSERT rather than racing it (the ritual rollback path fires both
    // in the same tick). `respondApproval` uses the same async path.
    await this.db.run(
      `UPDATE tool_approvals
         SET status = 'expired', decided_at = ?
       WHERE id = ? AND status = 'pending'`,
      [decided_at, id],
    )
    const waiter = this.pending.get(id)
    if (waiter) {
      this.pending.delete(id)
      waiter.resolve('expired')
    }
    return this.get(id)?.status === 'expired'
  }

  /**
   * REVOKE a grant the owner already APPROVED, before it would otherwise lapse.
   *
   * `cancelPending` cannot do this: its predicate is `status = 'pending'`, which
   * is exactly right for a prompt nobody answered and useless for a durable
   * grant that was answered YES and is still in force. The standing deploy
   * window (`open/host-deploy-window.ts`) is the first such grant — a permission
   * with hours left on its clock that the owner must be able to take back in one
   * move, without waiting for the clock.
   *
   * ATOMIC CLAIM, like `respondApproval`. The `WHERE status = 'approved'`
   * predicate and the affected-row count are read inside ONE transaction, so of
   * two racing revocations exactly one is told `true`. A caller that reports
   * "closed" to the owner must gate that sentence on this boolean, or two taps
   * both claim to have done it.
   *
   * The row lands on 'expired' rather than 'denied' deliberately: 'denied' is
   * the record of an owner who refused the grant when asked, and overwriting a
   * real YES with it would erase the fact that the permission WAS given and used.
   */
  async revokeApproved(id: string): Promise<boolean> {
    const decided_at = this.now() / 1000
    return await this.db.transaction((tx) => {
      const res = tx.runSync(
        `UPDATE tool_approvals
           SET status = 'expired', decided_at = ?
         WHERE id = ? AND status = 'approved'`,
        [decided_at, id],
      )
      return res.changes > 0
    })
  }
}
