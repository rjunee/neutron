import type { ProjectDb } from '@neutronai/persistence/index.ts';
import { ProjectAdmissionStore } from './project-admission-store.ts';
import type {
  AdmissionLease, AdmissionReason, MaintenancePhase, ProjectAdmissionScope,
} from './project-admission-store.ts';

/** A participating producer's admission. `release` binds the exact lease
 * (scope + generation + token) and is idempotent: only the first call reports true. */
export interface AdmittedWork {
  status: 'admitted';
  lease: AdmissionLease;
  generation: number;
  release(): Promise<boolean>;
}
/** `phase` is read after the refused admission committed; null when the fence
 * was already lifted by then (the refusal still stands for this work). */
export type AdmissionRefusal = { status: 'fenced'; phase: MaintenancePhase | null } | { status: 'unknown' };
export type AdmissionOutcome = AdmittedWork | AdmissionRefusal;

/** Producer kinds. The service stamps the boot id onto each (`chat:<bootId>`) so
 * a later reconciler can tell a dead gateway's durable leases from live ones. */
export type AdmissionProducer = 'chat' | 'acting-turn' | 'work-board' | 'hold-drain' | 'wakeup' | 'native-child';

export interface ProjectAdmissionOptions {
  db: ProjectDb;
  /** The immutable instance owner boundary of every scope this service admits. */
  ownerHandle: string;
  /** Unique per gateway process. */
  bootId: string;
}

/**
 * Production admission over the durable {@link ProjectAdmissionStore}. Every
 * producer that touches a project conversation admits here BEFORE it queues or
 * delivers, holds the lease for the life of the work, and releases it on every
 * unwind. A fenced or unknown scope is refused; nothing is queued.
 *
 * Scope rule: `null`/`undefined` is General. Any string is a NAMED project and is
 * passed through unchanged, so a real project whose id is literally `general`
 * stays its own scope. General is never derived from a display name or slug.
 *
 * Registration is existence-verified: General always registers; a named project
 * registers only while a live (`deleted_at IS NULL`) `projects` row exists.
 * Otherwise the admission is `unknown` and nothing is written.
 *
 * Restart does not expire or release anything: leases and fences persist (the
 * store's contract). This service performs no replacement and no census.
 */
export class ProjectAdmission {
  private readonly store: ProjectAdmissionStore;
  private readonly db: ProjectDb;
  /** Scope keys already registered by this process (registration is idempotent;
   * this only spares a write per admission). Existence is re-verified every time. */
  private readonly registered = new Set<string>();
  readonly ownerHandle: string;
  readonly bootId: string;

  constructor(options: ProjectAdmissionOptions) {
    if (!options.ownerHandle.trim()) throw new Error('Explicit owner identity required');
    if (!options.bootId.trim()) throw new Error('Boot identity required');
    this.db = options.db;
    this.store = new ProjectAdmissionStore(options.db);
    this.ownerHandle = options.ownerHandle;
    this.bootId = options.bootId;
  }

  scopeFor(projectId: string | null | undefined): ProjectAdmissionScope {
    return { ownerHandle: this.ownerHandle, projectId: projectId ?? null };
  }

  /** The producer string persisted on a lease: `<kind>:<bootId>`. */
  producerFor(producer: AdmissionProducer): string {
    return `${producer}:${this.bootId}`;
  }

  async admit(
    projectId: string | null | undefined,
    reason: AdmissionReason,
    producer: AdmissionProducer,
    workRef: string,
  ): Promise<AdmissionOutcome> {
    const scope = this.scopeFor(projectId);
    if (!(await this.registerIfLive(scope))) return { status: 'unknown' };
    const admitted = await this.store.admit(scope, reason, this.producerFor(producer), workRef);
    if (admitted.status !== 'admitted') {
      if (admitted.status === 'unknown') return { status: 'unknown' };
      const phase = this.store.inspect(scope)?.phase;
      return { status: 'fenced', phase: phase === undefined || phase === 'open' ? null : phase };
    }
    const lease = admitted.lease;
    let releasing = false;
    return {
      status: 'admitted',
      lease,
      generation: lease.generation,
      release: async () => {
        if (releasing) return false;
        releasing = true;
        return this.store.release(lease);
      },
    };
  }

  /** Admit, run `fn` only when admitted, and release in `finally` on every
   * unwind. A refusal is returned untouched and `fn` never runs. */
  async withLease<T>(
    projectId: string | null | undefined,
    reason: AdmissionReason,
    producer: AdmissionProducer,
    workRef: string,
    fn: (work: AdmittedWork) => Promise<T>,
  ): Promise<{ status: 'admitted'; value: T } | AdmissionRefusal> {
    const admitted = await this.admit(projectId, reason, producer, workRef);
    if (admitted.status !== 'admitted') return admitted;
    try {
      return { status: 'admitted', value: await fn(admitted) };
    } finally {
      await admitted.release();
    }
  }

  inspect(projectId: string | null | undefined): ReturnType<ProjectAdmissionStore['inspect']> {
    return this.store.inspect(this.scopeFor(projectId));
  }

  /** The underlying store, for maintenance owners (fence, advance, resume, abandon). */
  get maintenance(): ProjectAdmissionStore {
    return this.store;
  }

  private async registerIfLive(scope: ProjectAdmissionScope): Promise<boolean> {
    if (scope.projectId !== null) {
      const live = this.db.get<{ one: number }>(
        'SELECT 1 AS one FROM projects WHERE id = ? AND deleted_at IS NULL', [scope.projectId]);
      if (!live) return false;
    }
    const key = JSON.stringify([scope.ownerHandle, scope.projectId]);
    if (!this.registered.has(key)) {
      await this.store.register(scope);
      this.registered.add(key);
    }
    return true;
  }
}
