import type { ProjectDb } from '@neutronai/persistence/index.ts';

export interface ProjectAdmissionScope { ownerHandle: string; projectId: string | null }
export type AdmissionReason = 'conversation' | 'queuedDispatch' | 'build' | 'approval' | 'liveChild';
export type MaintenancePhase = 'draining' | 'quiesced' | 'replacing' | 'attesting';
export interface AdmissionLease { scope: ProjectAdmissionScope; generation: number; token: string }
export interface MaintenanceFence extends AdmissionLease { phase: MaintenancePhase }
export interface OperatorMaintenanceHold extends MaintenanceFence { operationId: string; createdAt: number }
/** One durable lease row, its scope decoded. `workRef` is the producer's work id. */
export interface AdmissionLeaseRow extends AdmissionLease { reason: AdmissionReason; producer: string; workRef: string }
export interface NativeHostTerminationRow { operationId: string; scope: ProjectAdmissionScope; preparation: string; termination: string | null }
interface FenceRow { generation: number; phase: 'open' | MaintenancePhase; maintenance_token: string | null }
interface LeaseDbRow { token: string; scope_key: string; generation: number; reason: AdmissionReason; producer: string; work_ref: string }

/** Inverse of {@link scopeKey}; null for a row this encoding did not write. */
function parseScopeKey(key: string): ProjectAdmissionScope | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ownerHandle, projectId] = parsed as unknown[];
    if (typeof ownerHandle !== 'string' || (projectId !== null && typeof projectId !== 'string')) return null;
    return { ownerHandle, projectId };
  } catch {
    return null;
  }
}

function scopeKey(scope: ProjectAdmissionScope): string {
  if (!scope.ownerHandle.trim() || (scope.projectId !== null && !scope.projectId.trim())) {
    throw new Error('Explicit owner and project identity required');
  }
  // General is null, never a display-name sentinel. JSON tuple encoding prevents
  // delimiter collisions and keeps the immutable owner boundary explicit.
  return JSON.stringify([scope.ownerHandle, scope.projectId]);
}

/** Durable admission mechanics, NOT a native-child census or permission to
 * replace a parent. Production producers must all participate before maintenance
 * can be safe. No lease expiry, crash recovery, or quiet prompt implies idle.
 */
export class ProjectAdmissionStore {
  constructor(private readonly db: ProjectDb) {}

  readNativeContinuation(lease: AdmissionLeaseRow): string | undefined {
    return this.db.get<{ preparation: string }>('SELECT preparation FROM claude_native_continuations WHERE lease_token = ? ORDER BY rowid DESC LIMIT 1', [lease.token])?.preparation;
  }

  /** Recheck the original authorization epoch before capacity and parent input. */
  nativeContinuationCurrent(lease: AdmissionLeaseRow): boolean {
    const key = scopeKey(lease.scope);
    if (this.hasPreparedHostTermination(lease.scope)) return false;
    return Boolean(this.db.get(`SELECT 1 FROM project_admission_leases l
      JOIN project_admission_fences f ON f.scope_key = l.scope_key
      WHERE l.token = ? AND l.scope_key = ? AND l.generation = ? AND l.reason = 'liveChild'
        AND l.producer = ? AND l.work_ref = ? AND f.phase = 'open' AND f.generation = l.generation`,
    [lease.token, key, lease.generation, lease.producer, lease.workRef]));
  }

  /** Each episode remains spent forever, including after its successor is claimed. */
  async claimNativeContinuation(lease: AdmissionLeaseRow, episodeId: string, preparation: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(episodeId)) return false;
    return this.db.transaction(async tx => {
      const key = scopeKey(lease.scope);
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      if (this.hasPreparedHostTermination(lease.scope)) return false;
      const fence = tx.get<FenceRow>('SELECT generation, phase FROM project_admission_fences WHERE scope_key = ?', [key]);
      if (!fence || fence.phase !== 'open' || fence.generation !== lease.generation) return false;
      const exact = tx.get(`SELECT 1 FROM project_admission_leases WHERE token = ? AND scope_key = ?
        AND generation = ? AND reason = 'liveChild' AND producer = ? AND work_ref = ?`,
      [lease.token, key, lease.generation, lease.producer, lease.workRef]);
      if (!exact) return false;
      return tx.runSync('INSERT OR IGNORE INTO claude_native_continuations (lease_token, authenticated_episode_id, preparation) VALUES (?, ?, ?)',
        [lease.token, episodeId, preparation]).changes === 1;
    });
  }

  /** Explicit provisioning only; never resets a pre-existing maintenance fence. */
  async register(scope: ProjectAdmissionScope): Promise<void> {
    await this.db.run(`INSERT INTO project_admission_fences (scope_key, phase) VALUES (?, 'open')
      ON CONFLICT(scope_key) DO NOTHING`, [scopeKey(scope)]);
  }

  async admit(scope: ProjectAdmissionScope, reason: AdmissionReason, producer: string, workRef: string): Promise<
    { status: 'admitted'; lease: AdmissionLease } | { status: 'fenced' | 'unknown' }
  > {
    if (!producer.trim() || !workRef.trim()) throw new Error('Producer and work reference required');
    const key = scopeKey(scope);
    return this.db.transaction(async tx => {
      // Write first: BEGIN is deferred. This obtains SQLite's writer lock before
      // reading eligibility, including against another ProjectDb connection.
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      const row = tx.get<FenceRow>('SELECT generation, phase, maintenance_token FROM project_admission_fences WHERE scope_key = ?', [key]);
      if (!row) return { status: 'unknown' as const };
      if (this.hasPreparedHostTermination(scope)) return { status: 'fenced' as const };
      if (row.phase !== 'open') return { status: 'fenced' as const };
      const token = crypto.randomUUID();
      tx.runSync(`INSERT INTO project_admission_leases (token, scope_key, generation, reason, producer, work_ref)
        VALUES (?, ?, ?, ?, ?, ?)`, [token, key, row.generation, reason, producer, workRef]);
      return { status: 'admitted' as const, lease: { scope: { ...scope }, generation: row.generation, token } };
    });
  }

  /**
   * Admit a CHILD of already-admitted work (#1237): a native child a bounded
   * build step creates inside the project REPL. One transaction: the same
   * writer-lock UPDATE as {@link admit}, then the fence row (`unknown` when none),
   * then the PARENT lease — the first row of `parent.reason` naming
   * `parent.workRef` in this scope (`no-parent` when none) — then the child lease
   * under the PARENT'S generation, REGARDLESS of fence phase.
   *
   * A child of admitted work IS that work draining ({@link release}'s contract:
   * existing admitted work can drain after fencing). Refusing it would strand a
   * build the fence must wait for, while {@link transition} still refuses to leave
   * `draining` until the child row is gone, so quiescence stays exact.
   */
  async admitChild(
    scope: ProjectAdmissionScope,
    parent: { reason: AdmissionReason; workRef: string },
    reason: AdmissionReason,
    producer: string,
    workRef: string,
  ): Promise<{ status: 'admitted'; lease: AdmissionLease } | { status: 'no-parent' } | { status: 'unknown' }> {
    if (!producer.trim() || !workRef.trim() || !parent.workRef.trim()) throw new Error('Producer and work reference required');
    const key = scopeKey(scope);
    return this.db.transaction(async tx => {
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      const row = tx.get<FenceRow>('SELECT generation, phase, maintenance_token FROM project_admission_fences WHERE scope_key = ?', [key]);
      if (!row) return { status: 'unknown' as const };
      if (this.hasPreparedHostTermination(scope)) return { status: 'unknown' as const };
      const owner = tx.get<{ generation: number }>(`SELECT generation FROM project_admission_leases
        WHERE scope_key = ? AND reason = ? AND work_ref = ? ORDER BY rowid LIMIT 1`, [key, parent.reason, parent.workRef]);
      if (!owner) return { status: 'no-parent' as const };
      const token = crypto.randomUUID();
      tx.runSync(`INSERT INTO project_admission_leases (token, scope_key, generation, reason, producer, work_ref)
        VALUES (?, ?, ?, ?, ?, ?)`, [token, key, owner.generation, reason, producer, workRef]);
      return { status: 'admitted' as const, lease: { scope: { ...scope }, generation: owner.generation, token } };
    });
  }

  /** Existing admitted work can drain after fencing. A stale/foreign release
   * cannot remove another generation's durable activity. A prepared physical
   * recovery reserves its exact token for that authenticated consumer. */
  async release(lease: AdmissionLease): Promise<boolean> {
    return this.db.transaction(tx => tx.runSync(`DELETE FROM project_admission_leases
      WHERE scope_key = ? AND generation = ? AND token = ?
      AND NOT EXISTS (SELECT 1 FROM native_host_terminations
        WHERE lease_token = project_admission_leases.token AND termination IS NULL)`,
    [scopeKey(lease.scope), lease.generation, lease.token]).changes === 1);
  }

  /** Separate from maintenance replacement: this gate authorizes no parent
   * retirement and blocks even children joining previously admitted work. */
  hasPreparedHostTermination(scope: ProjectAdmissionScope): boolean {
    return !!this.db.get('SELECT 1 FROM native_host_terminations WHERE scope_key = ? AND termination IS NULL LIMIT 1', [scopeKey(scope)]);
  }

  listHostTerminations(): NativeHostTerminationRow[] {
    return this.db.all<{ operation_id: string; scope_key: string; preparation: string; termination: string | null }>(
      'SELECT operation_id, scope_key, preparation, termination FROM native_host_terminations ORDER BY rowid').map(row => {
      const scope = parseScopeKey(row.scope_key);
      if (!scope) throw new Error('Unreadable host termination scope');
      return { operationId: row.operation_id, scope, preparation: row.preparation, termination: row.termination };
    });
  }

  /** Only the authenticated recovery consumer calls this. Work eligibility is
   * rechecked under the writer lock; an existing operation is never rewritten. */
  async prepareHostTermination(operationId: string, lease: AdmissionLeaseRow, preparation: string, eligible: () => boolean): Promise<boolean> {
    return this.db.transaction(async tx => {
      const key = scopeKey(lease.scope);
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      if (lease.reason !== 'liveChild' || !eligible()) return false;
      const exact = tx.get(`SELECT 1 FROM project_admission_leases WHERE scope_key = ? AND generation = ? AND token = ?
        AND reason = ? AND producer = ? AND work_ref = ?`, [key, lease.generation, lease.token, lease.reason, lease.producer, lease.workRef]);
      if (!exact) return false;
      const previous = tx.get<{ preparation: string; termination: string | null }>(
        'SELECT preparation, termination FROM native_host_terminations WHERE operation_id = ?', [operationId]);
      if (previous) return previous.termination === null && previous.preparation === preparation;
      return tx.runSync(`INSERT OR IGNORE INTO native_host_terminations (operation_id, scope_key, lease_token, preparation)
        VALUES (?, ?, ?, ?)`, [operationId, key, lease.token, preparation]).changes === 1;
    });
  }

  /** Physical termination and exact lease deletion are one transaction. This
   * never updates the run, attempt, armed request, result, or publication. */
  async consumeHostTermination(operationId: string, lease: AdmissionLeaseRow, preparation: string, termination: string, eligible: () => boolean): Promise<boolean> {
    return this.db.transaction(async tx => {
      const key = scopeKey(lease.scope);
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      if (lease.reason !== 'liveChild' || !eligible()) return false;
      const pending = tx.get(`SELECT 1 FROM native_host_terminations WHERE operation_id = ? AND scope_key = ?
        AND lease_token = ? AND preparation = ? AND termination IS NULL`, [operationId, key, lease.token, preparation]);
      if (!pending) return false;
      const released = tx.runSync(`DELETE FROM project_admission_leases WHERE scope_key = ? AND generation = ? AND token = ?
        AND reason = ? AND producer = ? AND work_ref = ?`, [key, lease.generation, lease.token, lease.reason, lease.producer, lease.workRef]).changes;
      if (released !== 1) return false;
      const recorded = tx.runSync(`UPDATE native_host_terminations SET termination = ? WHERE operation_id = ?
        AND preparation = ? AND termination IS NULL`, [termination, operationId, preparation]).changes;
      if (recorded !== 1) throw new Error('Host termination evidence could not commit');
      return true;
    });
  }

  async beginMaintenance(scope: ProjectAdmissionScope): Promise<MaintenanceFence | null> {
    return this.db.transaction(tx => this.beginMaintenanceLocked(tx, scope));
  }

  private async beginMaintenanceLocked(tx: ProjectDb, scope: ProjectAdmissionScope): Promise<MaintenanceFence | null> {
    tx.assertInTransaction();
    const key = scopeKey(scope);
    await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
    const token = crypto.randomUUID();
    const changed = tx.runSync(`UPDATE project_admission_fences SET generation = generation + 1,
        phase = 'draining', maintenance_token = ? WHERE scope_key = ? AND phase = 'open'
        AND generation < 9007199254740991`, [token, key]).changes;
    if (changed !== 1) return null;
    const row = tx.get<FenceRow>('SELECT generation FROM project_admission_fences WHERE scope_key = ?', [key])!;
    return { scope: { ...scope }, generation: row.generation, token, phase: 'draining' as const };
  }

  /** Privileged deployment actuator only. The hold and the ordinary draining
   * fence commit together. Unknown/unregistered or already-held scopes refuse;
   * this never provisions a scope or consumes a work lease. */
  async holdOperatorMaintenance(scope: ProjectAdmissionScope, operationId: string): Promise<OperatorMaintenanceHold | null> {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('Invalid maintenance operation');
    return this.db.transaction(async tx => {
      const fence = await this.beginMaintenanceLocked(tx, scope);
      if (!fence) return null;
      const createdAt = Date.now();
      tx.runSync(`INSERT INTO project_operator_maintenance_holds
        (operation_id, scope_key, generation, maintenance_token, created_at) VALUES (?, ?, ?, ?, ?)`,
      [operationId, scopeKey(scope), fence.generation, fence.token, createdAt]);
      return { ...fence, operationId, createdAt };
    });
  }

  operatorMaintenanceCurrent(hold: OperatorMaintenanceHold): boolean {
    return hold.phase === 'draining' && Boolean(this.db.get(`SELECT 1 FROM project_operator_maintenance_holds h
      JOIN project_admission_fences f ON f.scope_key = h.scope_key
      WHERE h.operation_id = ? AND h.scope_key = ? AND h.generation = ? AND h.maintenance_token = ?
        AND f.generation = h.generation AND f.maintenance_token = h.maintenance_token AND f.phase = 'draining'`,
    [hold.operationId, scopeKey(hold.scope), hold.generation, hold.token]));
  }

  operatorMaintenanceFor(scope: ProjectAdmissionScope, operationId: string): OperatorMaintenanceHold | null {
    const row = this.db.get<{ generation: number; maintenance_token: string; created_at: number }>(
      'SELECT generation, maintenance_token, created_at FROM project_operator_maintenance_holds WHERE scope_key = ? AND operation_id = ?',
      [scopeKey(scope), operationId]);
    if (!row) return null;
    const hold: OperatorMaintenanceHold = { scope: { ...scope }, operationId, generation: row.generation,
      token: row.maintenance_token, createdAt: row.created_at, phase: 'draining' };
    return this.operatorMaintenanceCurrent(hold) ? hold : null;
  }

  /** Caller must independently establish deployed identity and canonical sleep.
   * Proof is rechecked inside the writer lock; failure leaves the hold intact.
   * No lease, cap, dispatch or completion row is ever changed here. */
  async releaseOperatorMaintenance(hold: OperatorMaintenanceHold, verified: () => boolean): Promise<boolean> {
    return this.db.transaction(async tx => {
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [scopeKey(hold.scope)]);
      if (!this.operatorMaintenanceCurrent(hold) || this.inspect(hold.scope)?.leases !== 0
        || this.hasPreparedHostTermination(hold.scope) || !verified()) return false;
      const removed = tx.runSync(`DELETE FROM project_operator_maintenance_holds
        WHERE operation_id = ? AND scope_key = ? AND generation = ? AND maintenance_token = ?`,
      [hold.operationId, scopeKey(hold.scope), hold.generation, hold.token]).changes;
      if (removed !== 1 || !this.abandonLocked(tx, hold)) throw new Error('Maintenance release did not commit');
      return true;
    });
  }

  /** Records a caller's independently verified stage, never performs its work.
   * Quiescence additionally requires authoritative parent/native-child evidence;
   * zero rows here proves only that participating producers released their leases.
   */
  async advance(fence: MaintenanceFence): Promise<MaintenanceFence | null> {
    const next = { draining: 'quiesced', quiesced: 'replacing', replacing: 'attesting', attesting: null } as const;
    const phase = next[fence.phase];
    if (!phase) return null;
    const changed = await this.transition(fence, phase);
    return changed ? { ...fence, scope: { ...fence.scope }, phase } : null;
  }

  /** Caller must attest actual replacement identity/profile before reopening.
   * Failure or restart does not invoke this automatically. */
  async reopen(fence: MaintenanceFence): Promise<boolean> {
    if (fence.phase !== 'attesting') return false;
    return this.transition(fence, 'open');
  }

  /** Restart continuity: recover the persisted maintenance ownership for a scope
   * whose acknowledgement was lost (crash between the fence commit and the caller
   * recording it). Read-only; returns null for an open or unregistered scope. */
  resume(scope: ProjectAdmissionScope): MaintenanceFence | null {
    const row = this.db.get<FenceRow>('SELECT generation, phase, maintenance_token FROM project_admission_fences WHERE scope_key = ?', [scopeKey(scope)]);
    if (!row || row.phase === 'open' || row.maintenance_token === null) return null;
    return { scope: { ...scope }, generation: row.generation, token: row.maintenance_token, phase: row.phase };
  }

  /** Give up maintenance BEFORE anything was replaced: draining|quiesced -> open.
   * Admitted work keeps draining, so no lease check applies. A replacing or
   * attesting generation is refused: once replacement began, only attestation
   * of the actual replacement may reopen admission. */
  async abandon(fence: MaintenanceFence): Promise<boolean> {
    return this.db.transaction(tx => this.abandonLocked(tx, fence));
  }

  private abandonLocked(tx: ProjectDb, fence: MaintenanceFence): boolean {
    tx.assertInTransaction();
    if (fence.phase !== 'draining' && fence.phase !== 'quiesced') return false;
    const key = scopeKey(fence.scope);
    return tx.runSync(`UPDATE project_admission_fences
      SET phase = 'open', maintenance_token = NULL WHERE scope_key = ? AND generation = ?
      AND maintenance_token = ? AND phase = ? AND phase IN ('draining', 'quiesced')`,
    [key, fence.generation, fence.token, fence.phase]).changes === 1;
  }

  /** Release every unreserved lease of ONE piece of work — by scope, reason and work
   * reference — whatever generation or token it was admitted under. This is not a
   * foreign release: it is bound to the work, and is for work whose activity has
   * provably ENDED in every generation (a terminal build run). Returns the count
   * removed; a second call removes 0. Pending host recovery owns its reserved token. */
  async releaseWork(scope: ProjectAdmissionScope, reason: AdmissionReason, workRef: string): Promise<number> {
    if (!workRef.trim()) throw new Error('Work reference required');
    const key = scopeKey(scope);
    return this.db.transaction(tx => tx.runSync(`DELETE FROM project_admission_leases
      WHERE scope_key = ? AND reason = ? AND work_ref = ?
      AND NOT EXISTS (SELECT 1 FROM native_host_terminations
        WHERE lease_token = project_admission_leases.token AND termination IS NULL)`, [key, reason, workRef]).changes);
  }

  /** Every durable lease (optionally of one reason), scope decoded. Read-only;
   * a row whose scope key this encoding did not write is skipped. */
  listLeases(reason?: AdmissionReason): AdmissionLeaseRow[] {
    const rows = reason === undefined
      ? this.db.all<LeaseDbRow>('SELECT token, scope_key, generation, reason, producer, work_ref FROM project_admission_leases ORDER BY rowid')
      : this.db.all<LeaseDbRow>('SELECT token, scope_key, generation, reason, producer, work_ref FROM project_admission_leases WHERE reason = ? ORDER BY rowid', [reason]);
    const out: AdmissionLeaseRow[] = [];
    for (const row of rows) {
      const scope = parseScopeKey(row.scope_key);
      if (scope === null) continue;
      out.push({ scope, generation: row.generation, token: row.token, reason: row.reason, producer: row.producer, workRef: row.work_ref });
    }
    return out;
  }

  /** Restart inspection never modifies state or assumes orphaned leases expired. */
  inspect(scope: ProjectAdmissionScope): { generation: number; phase: FenceRow['phase']; leases: number } | null {
    const key = scopeKey(scope);
    const row = this.db.get<FenceRow>('SELECT generation, phase FROM project_admission_fences WHERE scope_key = ?', [key]);
    if (!row) return null;
    const count = this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM project_admission_leases WHERE scope_key = ?', [key])!;
    return { generation: row.generation, phase: row.phase, leases: count.count };
  }

  private async transition(fence: MaintenanceFence, phase: FenceRow['phase']): Promise<boolean> {
    const key = scopeKey(fence.scope);
    return this.db.transaction(tx => tx.runSync(`UPDATE project_admission_fences
      SET phase = ?, maintenance_token = ? WHERE scope_key = ? AND generation = ?
      AND maintenance_token = ? AND phase = ?
      AND NOT EXISTS (SELECT 1 FROM project_admission_leases WHERE scope_key = ?)`,
    [phase, phase === 'open' ? null : fence.token, key, fence.generation, fence.token, fence.phase, key]).changes === 1);
  }
}
