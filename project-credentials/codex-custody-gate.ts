import { AsyncLocalStorage } from 'node:async_hooks'

/** Admission and draining for one credential service process.
 *
 * Every participating writer acquires admission BEFORE reading custody or
 * starting asynchronous work, and holds it until that work actually settles.
 * Closing admission is synchronous, so even a same-tick writer cannot start
 * behind a requested maintenance operation. Other owners remain independent.
 *
 * This does not fence another process or a native CLI. Its maintenance lease is
 * only the service half of reconciliation, never proof of native quiescence.
 */
export class CodexCustodyAdmissionError extends Error {
  readonly code = 'codex_custody_maintenance'

  constructor() {
    super('Codex credential maintenance has closed writer admission')
    this.name = 'CodexCustodyAdmissionError'
  }
}

export interface CodexCustodyWriterLease {
  /** Idempotent. Release only after the admitted operation has settled. */
  release(): void
}

export interface CodexCustodyMaintenanceLease {
  /** Refuses after release, including when a later maintenance lease exists. */
  assertHeld(): void
  /** Explicit release after a known-safe completion or clean refusal.
   * An uncertain native retirement/persistence result must keep admission closed.
   */
  release(): void
}

export interface CodexCustodyMaintenanceRequest {
  /** Resolves only after ALL previously admitted operations have settled.
   * There is no timeout that silently reopens admission or pronounces a drain.
   */
  readonly drained: Promise<CodexCustodyMaintenanceLease>
}

interface OwnerAdmission {
  writers: number
  maintenance?: { drain(): void }
}
interface WriterContext { state: OwnerAdmission; active: boolean }
interface AdmittedWriter extends CodexCustodyWriterLease { context: WriterContext }

export class CodexServiceCustodyGate {
  private readonly owners = new Map<string, OwnerAdmission>()
  private readonly context = new AsyncLocalStorage<ReadonlyMap<string, WriterContext>>()

  /** Use for synchronous file work or a lifetime whose actual completion is
   * observed separately. New work must not reuse an existing writer's lease.
   */
  admit(owner: string): CodexCustodyWriterLease {
    return this.acquire(owner)
  }

  private acquire(owner: string): AdmittedWriter {
    const state = this.state(owner)
    const parent = this.context.getStore()?.get(owner)
    // A queued operation admitted before closure must be able to finish its
    // nested store writes. A detached task whose parent settled has no authority.
    if (state.maintenance && !(parent?.active && parent.state === state)) throw new CodexCustodyAdmissionError()
    state.writers++
    let released = false
    const context = { state, active: true }
    return {
      context,
      release: () => {
        if (released) return
        released = true
        context.active = false
        state.writers--
        if (state.writers === 0) {
          if (state.maintenance) state.maintenance.drain()
          else if (this.owners.get(owner) === state) this.owners.delete(owner)
        }
      },
    }
  }

  /** Registers synchronously, including fire-and-forget work, before invoking
   * the callback. A rejected or synchronously throwing writer still drains.
   */
  run<T>(owner: string, action: () => T | PromiseLike<T>): Promise<T> {
    let lease: AdmittedWriter
    try { lease = this.acquire(owner) }
    catch (error) { return Promise.reject(error) }
    const contexts = new Map(this.context.getStore()); contexts.set(owner, lease.context)
    try { return Promise.resolve(this.context.run(contexts, action)).finally(() => lease.release()) }
    catch (error) { lease.release(); return Promise.reject(error) }
  }

  /** For synchronous resolver/status paths. Detached async writes must use run
   * before this callback returns; they then own an independently counted lease. */
  runSync<T>(owner: string, action: () => T): T {
    const lease = this.acquire(owner)
    const contexts = new Map(this.context.getStore()); contexts.set(owner, lease.context)
    try { return this.context.run(contexts, action) }
    finally { lease.release() }
  }

  /** Does not enter the ordinary writer queue: admission closes immediately,
   * then drains the already-admitted queue. A second request is a refusal.
   */
  beginMaintenance(owner: string): CodexCustodyMaintenanceRequest {
    if (this.context.getStore()?.get(owner)?.active) throw new Error('Cannot drain custody from an admitted writer')
    const state = this.state(owner)
    if (state.maintenance) throw new CodexCustodyAdmissionError()
    let resolve!: (lease: CodexCustodyMaintenanceLease) => void
    const drained = new Promise<CodexCustodyMaintenanceLease>(yes => { resolve = yes })
    let held = false
    let released = false
    const assertHeld = (): void => {
      if (!held || released || this.owners.get(owner) !== state || state.maintenance !== request) {
        throw new CodexCustodyAdmissionError()
      }
    }
    const lease: CodexCustodyMaintenanceLease = {
      assertHeld,
      release: () => {
        if (released) return
        assertHeld()
        released = true
        delete state.maintenance
        this.owners.delete(owner)
      },
    }
    const request = {
      drain: (): void => {
        if (held || state.writers !== 0) return
        held = true
        resolve(lease)
      },
    }
    state.maintenance = request
    request.drain()
    return { drained }
  }

  /** Stored process-local state only. This is never a native-health reading. */
  inspect(owner: string): { admission: 'open' | 'draining' | 'held'; writers: number } {
    const state = this.owners.get(owner)
    return { admission: state?.maintenance ? state.writers > 0 ? 'draining' : 'held' : 'open', writers: state?.writers ?? 0 }
  }

  private state(owner: string): OwnerAdmission {
    if (!owner) throw new TypeError('Codex credential owner is required')
    let state = this.owners.get(owner)
    if (!state) { state = { writers: 0 }; this.owners.set(owner, state) }
    return state
  }
}
