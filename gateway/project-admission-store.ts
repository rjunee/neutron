import type { ProjectDb } from '@neutronai/persistence/index.ts';

export interface ProjectAdmissionScope { ownerHandle: string; projectId: string | null }
export type AdmissionReason = 'conversation' | 'queuedDispatch' | 'build' | 'approval' | 'liveChild';
export type MaintenancePhase = 'draining' | 'quiesced' | 'replacing' | 'attesting';
export interface AdmissionLease { scope: ProjectAdmissionScope; generation: number; token: string }
export interface MaintenanceFence extends AdmissionLease { phase: MaintenancePhase }
interface FenceRow { generation: number; phase: 'open' | MaintenancePhase; maintenance_token: string | null }

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
      if (row.phase !== 'open') return { status: 'fenced' as const };
      const token = crypto.randomUUID();
      tx.runSync(`INSERT INTO project_admission_leases (token, scope_key, generation, reason, producer, work_ref)
        VALUES (?, ?, ?, ?, ?, ?)`, [token, key, row.generation, reason, producer, workRef]);
      return { status: 'admitted' as const, lease: { scope: { ...scope }, generation: row.generation, token } };
    });
  }

  /** Existing admitted work can drain after fencing. A stale/foreign release
   * cannot remove another generation's durable activity. */
  async release(lease: AdmissionLease): Promise<boolean> {
    return this.db.transaction(tx => tx.runSync(`DELETE FROM project_admission_leases
      WHERE scope_key = ? AND generation = ? AND token = ?`,
    [scopeKey(lease.scope), lease.generation, lease.token]).changes === 1);
  }

  async beginMaintenance(scope: ProjectAdmissionScope): Promise<MaintenanceFence | null> {
    const key = scopeKey(scope);
    return this.db.transaction(async tx => {
      await tx.run('UPDATE project_admission_fences SET generation = generation WHERE scope_key = ?', [key]);
      const token = crypto.randomUUID();
      const changed = tx.runSync(`UPDATE project_admission_fences SET generation = generation + 1,
        phase = 'draining', maintenance_token = ? WHERE scope_key = ? AND phase = 'open'
        AND generation < 9007199254740991`, [token, key]).changes;
      if (changed !== 1) return null;
      const row = tx.get<FenceRow>('SELECT generation FROM project_admission_fences WHERE scope_key = ?', [key])!;
      return { scope: { ...scope }, generation: row.generation, token, phase: 'draining' as const };
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
    if (fence.phase !== 'draining' && fence.phase !== 'quiesced') return false;
    const key = scopeKey(fence.scope);
    return this.db.transaction(tx => tx.runSync(`UPDATE project_admission_fences
      SET phase = 'open', maintenance_token = NULL WHERE scope_key = ? AND generation = ?
      AND maintenance_token = ? AND phase = ? AND phase IN ('draining', 'quiesced')`,
    [key, fence.generation, fence.token, fence.phase]).changes === 1);
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
