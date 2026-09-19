import { randomBytes } from 'node:crypto'
import type { ProjectControlBroker } from './project-control-broker.ts'
import type { ReviewPermissionLease } from './project-review-permissions.ts'
import type { Rpc } from './project-owner-helper-protocol.ts'

type RetainedReview = {
  token: string
  grant: string
  phase: 'preparing' | 'ready' | 'started' | 'restoring' | 'restored' | 'acknowledged' | 'abandoned'
  native?: ReviewPermissionLease
}

/** Private helper protocol only. Native owner RPC never receives lease tokens.
 * A response cannot prove its own delivery: even restored leases remain retained
 * until a subsequent request proves receipt of the explicit acknowledgement.
 */
export class OwnerHelperReview {
  private retained: RetainedReview | undefined
  private released: { token: string; grant: string } | undefined
  constructor(private broker: ProjectControlBroker, private assertOwner: () => void) {}
  assertAttachable() {
    if (this.retained) throw new Error('Unresolved owner review requires reconciliation')
  }
  acknowledge(raw: Rpc) {
    if (raw.restoredReview === undefined) return
    if (raw.restoredReview === this.released?.token && raw.grant === this.released.grant) return
    const lease = this.retained
    // A completed acknowledgement may be repeated by already in-flight reads.
    if (!lease || lease.phase !== 'acknowledged' || raw.restoredReview !== lease.token || raw.grant !== lease.grant) {
      throw new Error('Unacknowledged owner review restoration')
    }
    this.released = { token: lease.token, grant: lease.grant }
    this.retained = undefined
  }
  assertWriterAvailable() {
    if (this.retained) throw new Error('Owner review retains exclusive writer authority')
  }
  async handle(raw: Rpc): Promise<Rpc> {
    this.assertOwner()
    const fields = raw.operation === 'reviewPrepare' ? ['stageDir', 'network', 'epoch']
      : raw.operation === 'reviewStart' ? ['lease', 'input'] : ['lease']
    if (Object.keys(raw).some(key => !['operation', 'grant', 'restoredReview', ...fields].includes(key))) throw new Error('Unclassified private review field')
    if (raw.operation === 'reviewPrepare') {
      this.assertAttachable()
      if (typeof raw.stageDir !== 'string' || typeof raw.network !== 'boolean' || !Number.isSafeInteger(raw.epoch)
        || raw.epoch !== this.broker.state().epoch || typeof raw.grant !== 'string') throw new Error('Invalid private review preparation')
      if (!this.broker.reviewPermissions) throw new Error('Native review capability unsupported')
      const lease: RetainedReview = { token: randomBytes(32).toString('hex'), grant: raw.grant, phase: 'preparing' }
      this.retained = lease
      lease.native = await this.broker.reviewPermissions({ stageDir: raw.stageDir, network: raw.network }, raw.epoch as number)
      this.assertOwner()
      lease.phase = 'ready'
      return { lease: lease.token }
    }
    const lease = this.retained
    if (!lease || typeof raw.lease !== 'string' || raw.lease !== lease.token || raw.grant !== lease.grant) throw new Error('Foreign or expired review lease')
    if (raw.operation === 'reviewAbandon') {
      lease.phase = 'abandoned'
      lease.native?.abandon()
      this.broker.close()
      return { abandoned: true }
    }
    if (raw.operation === 'reviewStart') {
      if (lease.phase !== 'ready' || !Array.isArray(raw.input)) throw new Error('Review dispatch lease unavailable')
      lease.phase = 'started'
      const result = await lease.native!.start(raw.input)
      this.assertOwner()
      return result
    }
    if (raw.operation === 'reviewRestore') {
      if (lease.phase !== 'started') throw new Error('Review restoration lease unavailable')
      lease.phase = 'restoring'
      await lease.native!.restore()
      this.assertOwner()
      lease.phase = 'restored'
      return { restored: true }
    }
    if (raw.operation === 'reviewAcknowledge') {
      if (lease.phase !== 'restored') throw new Error('Review acknowledgement unavailable')
      lease.phase = 'acknowledged'
      return { acknowledged: true }
    }
    throw new Error('Unclassified private review operation')
  }
  destroy() {
    if (this.retained) { this.retained.native?.abandon(); this.broker.close() }
  }
}
