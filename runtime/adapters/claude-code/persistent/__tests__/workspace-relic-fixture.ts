import { isDeepStrictEqual } from 'node:util'
import { FakeHerdrWorkspaceServer } from './herdr-workspace-fake-server.ts'
import type { RelicProcReader } from '../relic-shell-census.ts'

export class RelicProcFixture implements RelicProcReader {
  readonly rows = new Map<number, { parent: number; session: number; tty: number; ticks: string }>()
  constructor() { this.add(process.pid, 1, process.pid, 0) }
  add(pid: number, parent = 1, session = pid, tty = pid): void { this.rows.set(pid, { parent, session, tty, ticks: '100' }) }
  list(_path: string): string[] { return [...this.rows.keys()].map(String) }
  uid(_path: string): number { return process.getuid!() }
  read(path: string): string {
    if (path === '/proc/sys/kernel/random/boot_id') return '11111111-2222-3333-4444-555555555555'
    const id = Number(path.split('/')[2]), row = this.rows.get(id)
    if (!row) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    const fields = ['S', String(row.parent), String(row.session), String(row.session), String(row.tty), ...Array(14).fill('0'), row.ticks]
    return `${id} (shell) ${fields.join(' ')}`
  }
}

/** Scripted birth/input protocol; never asserts a physical kernel retirement. */
export class RelicWorkspaceServer extends FakeHerdrWorkspaceServer {
  readonly births = new Map<string, { terminal_id: string; runtime_generation: string }>()
  readonly inputHolds = new Map<string, { token: unknown; epoch: number }>()
  beforeHeldRetirement?: () => void
  beforeInputCheck?: () => void
  lostRetirementReply = false
  lostReleaseReply = false
  inputEpoch = 1
  alteredHoldReply = false
  changedEpoch = false
  birthReceipts = true

  override async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === 'ping') return { ...await super.call(method, params), capabilities: {
      owned_empty_workspace_retirement: true, owned_pane_retirement: true, owned_pane_input_hold: true,
    } }
    if (method === 'layout.apply') {
      const response = await super.call(method, params)
      const layout = response.layout as { root: { pane_id: string; retirement_identity?: object } }
      const birth = { terminal_id: `terminal-${layout.root.pane_id}`, runtime_generation: `birth-${layout.root.pane_id}` }
      this.births.set(layout.root.pane_id, birth)
      if (this.birthReceipts) layout.root.retirement_identity = birth
      return response
    }
    if (!['pane.hold_owned_input', 'pane.check_owned_input', 'pane.release_owned_input', 'pane.retire_held_owned'].includes(method)) {
      return super.call(method, params)
    }
    this.calls.push({ method, params })
    const target = params.target as Record<string, unknown>, id = String(target.pane_id)
    if (method === 'pane.retire_held_owned') this.beforeHeldRetirement?.()
    const pane = this.panes.get(id), workspace = this.workspaces.get(String(target.workspace_id))
    const birth = this.births.get(id)
    const matches = !!pane && !!birth && target.tab_id === pane.tab_id && target.workspace_id === pane.workspace_id
      && target.workspace_token_key === 'neutron_project_owner'
      && workspace?.tokens.neutron_project_owner === target.workspace_token_value
      && isDeepStrictEqual(birth, { terminal_id: target.terminal_id, runtime_generation: target.runtime_generation })
    const hold = this.inputHolds.get(id)
    if (method === 'pane.check_owned_input') this.beforeInputCheck?.()
    if (method === 'pane.check_owned_input' && this.changedEpoch && hold) hold.epoch += 1
    if (method === 'pane.retire_held_owned') {
      const status = !pane ? 'gone' : matches && hold?.token === params.hold_token && hold?.epoch === params.input_epoch ? 'retired' : 'mismatch'
      if (status === 'retired') { this.panes.delete(id); this.inputHolds.delete(id) }
      if (this.lostRetirementReply) { this.lostRetirementReply = false; throw new Error('reply lost after mutation') }
      return { type: 'pane_retirement', pane_id: id, status }
    }
    let status = 'mismatch'
    if (matches) {
      if (method === 'pane.hold_owned_input' && (!hold || hold.token === params.hold_token)) {
        this.inputHolds.set(id, hold ?? { token: params.hold_token, epoch: this.inputEpoch }); status = 'held'
      } else if (hold?.token === params.hold_token && hold?.epoch === params.input_epoch) {
        status = method === 'pane.release_owned_input' ? 'released' : 'held'
        if (status === 'released') this.inputHolds.delete(id)
      }
    }
    if (status === 'released' && this.lostReleaseReply) { this.lostReleaseReply = false; throw new Error('release reply lost') }
    return { type: 'pane_owned_input', target, hold_token: this.alteredHoldReply ? 'foreign' : params.hold_token,
      input_epoch: this.inputHolds.get(id)?.epoch ?? hold?.epoch ?? null, status }
  }
}
