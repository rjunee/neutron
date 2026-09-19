import { randomBytes } from 'node:crypto'
import { ReviewPermissionBusy, type ProjectControlBroker } from './project-control-broker.ts'
import { MAX_REVIEW_SETTLEMENT_WAIT_MS, type ReviewPermissionLease } from './project-review-permissions.ts'
import type { Rpc } from './project-owner-helper-protocol.ts'

type RetainedReview = {
  token: string
  grant: string
  epoch: number
  phase: 'preparing' | 'ready' | 'started' | 'waiting' | 'settled' | 'restoring' | 'restored' | 'acknowledged' | 'releasing' | 'abandoned'
  native?: ReviewPermissionLease
}

/** Private helper protocol only. Native owner RPC never receives lease tokens.
 * A response cannot prove its own delivery: even restored leases remain retained
 * until a subsequent request proves receipt of the explicit acknowledgement.
 */
export class OwnerHelperReview {
  private retained: RetainedReview | undefined
  constructor(private broker: ProjectControlBroker, private assertOwner: () => void) {}
  assertAttachable() {
    if (this.retained) throw new Error('Unresolved owner review requires reconciliation')
  }
  assertWriterAvailable() {
    if (this.retained) throw new Error('Owner review retains exclusive writer authority')
  }
  async handle(raw: Rpc): Promise<Rpc> {
    this.assertOwner()
    const fields = raw.operation === 'reviewPrepare' ? ['stageDir', 'network', 'epoch']
      : raw.operation === 'reviewStart' ? ['lease', 'input'] : raw.operation === 'reviewWaitSettled' ? ['lease', 'timeoutMs'] : ['lease']
    if (Object.keys(raw).some(key => !['operation', 'grant', ...fields].includes(key))) throw new Error('Unclassified private review field')
    if (raw.operation === 'reviewPrepare') {
      this.assertAttachable()
      if (typeof raw.stageDir !== 'string' || typeof raw.network !== 'boolean' || !Number.isSafeInteger(raw.epoch)
        || raw.epoch !== this.broker.state().epoch || typeof raw.grant !== 'string') throw new Error('Invalid private review preparation')
      if (!this.broker.reviewPermissions) throw new Error('Native review capability unsupported')
      const lease: RetainedReview = { token: randomBytes(32).toString('hex'), grant: raw.grant, epoch: raw.epoch as number, phase: 'preparing' }
      this.retained = lease
      try { lease.native = await this.broker.reviewPermissions({ stageDir: raw.stageDir, network: raw.network }, raw.epoch as number) }
      catch (error) {
        // This branded refusal is emitted only before native journal reservation.
        // Generic errors may have provisioned permissions; retain those leases.
        if (!(error instanceof ReviewPermissionBusy)) throw error
        this.retained = undefined
        return { refused: 'busy' }
      }
      this.assertOwner()
      lease.epoch = this.broker.state().epoch
      lease.phase = 'ready'
      return { lease: lease.token }
    }
    const lease = this.retained
    if (!lease || typeof raw.lease !== 'string' || raw.lease !== lease.token || raw.grant !== lease.grant) throw new Error('Foreign or expired review lease')
    if (this.broker.state().epoch !== lease.epoch) throw new Error('Stale native review lease epoch')
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
      if (lease.phase !== 'started' && lease.phase !== 'settled') throw new Error('Review restoration lease unavailable')
      lease.phase = 'restoring'
      await lease.native!.restore()
      this.assertOwner()
      lease.phase = 'restored'
      return { restored: true }
    }
    if (raw.operation === 'reviewWaitSettled') {
      if (lease.phase !== 'started' || !Number.isSafeInteger(raw.timeoutMs) || Number(raw.timeoutMs) <= 0
        || Number(raw.timeoutMs) > MAX_REVIEW_SETTLEMENT_WAIT_MS) throw new Error('Invalid private review settlement wait')
      lease.phase = 'waiting'
      const settled = await lease.native!.waitSettled(raw.timeoutMs as number)
      this.assertOwner()
      if (!settled || this.broker.state().epoch !== lease.epoch) {
        lease.native!.abandon()
        throw new Error('Native review settlement unknown; reconciliation required')
      }
      lease.phase = 'settled'
      return { settled: true }
    }
    if (raw.operation === 'reviewAcknowledge') {
      if (lease.phase !== 'restored') throw new Error('Review acknowledgement unavailable')
      lease.phase = 'acknowledged'
      return { acknowledged: true }
    }
    if (raw.operation === 'reviewRelease') {
      if (lease.phase !== 'acknowledged') throw new Error('Review release unavailable')
      lease.phase = 'releasing'
      await lease.native!.release()
      this.assertOwner()
      this.retained = undefined
      return { released: true }
    }
    throw new Error('Unclassified private review operation')
  }
  destroy() {
    if (this.retained) { this.retained.native?.abandon(); this.broker.close() }
  }
}
