import { randomUUID, createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HerdrError, verifyHerdrProtocol, type HerdrRpc } from './herdr-client.ts'
import { HERDR_PROTOCOL_VERSION, type HerdrLayoutApply, type HerdrLayoutPaneNode, type HerdrProjectLayoutParams, type HerdrPaneRetirementIdentity } from './herdr-protocol.ts'
import { withFlockSync } from './registry-lock.ts'
import { readProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import { inspectIdleRelicShell, type RelicProcReader } from './relic-shell-census.ts'

/** Null is General; the literal project id "general" is a different scope. */
export interface ProjectPanePlacement {
  instanceId: string
  projectId: string | null
  projectLabel: string
  role: 'chat' | 'worker'
  /** A useful role/task name, e.g. "Review · authentication". Required for workers. */
  taskLabel?: string
  /** Durable per-dispatch identity, reused on retry. Required for workers. */
  operationId?: string
}

export interface QuarantinedChatIdentity {
  operationId: string
  sessionId: string
  childGeneration: string
  pid: number
  processIdentity: ProcessIdentity
  pane: string
  channelName: string
}

interface ChatSlot { tab: string; pane: string; placeholderArgv?: string[]; retirementIdentity?: HerdrPaneRetirementIdentity | undefined }

/**
 * A READ-ONLY sample of a scope's Chat slot (#1226 sleep). `live`: an owned,
 * placed real Chat pane is running. `gone`: the slot's pane is positively gone
 * (`pane_not_found`) — the next Chat placement already treats that as an empty slot.
 * `placeholder`: the verified inert asleep placeholder. `relics`: no current Chat,
 * but recorded dead-owner panes remain to reconcile. `none`: no active claim.
 * `refused`: anything unverified or foreign (a changed
 * workspace token, a moved pane, a modified placeholder, a pending/invalid record,
 * any other error). Refused never licenses a close.
 */
export type ChatInspection =
  | { status: 'live' | 'gone' | 'placeholder' | 'none' | 'relics'; workspace?: string; pane?: string; revision?: string }
  | { status: 'refused'; reason: string }
export type WorkspaceRetirement = { status: 'retired' | 'unsupported' } | { status: 'refused' | 'unknown'; reason: string }
interface WorkerOperation {
  digest: string
  state: 'pending' | 'ambiguous' | 'completed'
  pane?: string
  tab?: string
}
interface WorkspaceRecord {
  version: 1
  revision: string
  scope: [string, string | null]
  token: string
  state: 'pending' | 'ready' | 'retiring' | 'retired'
  workspace?: string
  chat?: ChatSlot
  /** Old shell panes retained after authenticated death of their native owner. */
  relinquishedChats?: ChatSlot[]
  /** Live quarantined history. Never eligible for dead-shell relic cleanup. */
  quarantinedChats?: Array<ChatSlot & { quarantine: QuarantinedChatIdentity }>
  workers?: Record<string, WorkerOperation>
  retirement?: { operationId: string; revision: string;
    relic?: { pane: string; holdToken: string; inputEpoch?: number; issued?: boolean; releasing?: boolean } }
}

const TOKEN = 'neutron_project_owner'
const SOURCE = 'neutron-project-workspaces'
const PLACEHOLDER = 'console.log("Chat is asleep. Open this project in Neutron to resume."); setInterval(() => {}, 3600000)'
const PANE_CLOSE_WAIT_MS = 3_000
const PANE_CLOSE_POLL_MS = 25

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value)
}

function creationIdentity(applied: HerdrLayoutApply): HerdrPaneRetirementIdentity | undefined {
  const identity = applied.layout.root.retirement_identity
  return identity && nonempty(identity.terminal_id) && nonempty(identity.runtime_generation)
    ? { terminal_id: identity.terminal_id, runtime_generation: identity.runtime_generation } : undefined
}

function scopeOf(placement: ProjectPanePlacement): [string, string | null] {
  if (!nonempty(placement.instanceId) || !(placement.projectId === null || nonempty(placement.projectId))
    || !nonempty(placement.projectLabel) || !['chat', 'worker'].includes(placement.role)
    || placement.role === 'worker' && (!nonempty(placement.taskLabel) || !nonempty(placement.operationId))) {
    throw new Error('project-workspaces: invalid explicit scope or task label')
  }
  return [placement.instanceId, placement.projectId]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project-workspaces: malformed response')
  return value as Record<string, unknown>
}
function handle(value: unknown): string {
  if (!nonempty(value)) throw new Error('project-workspaces: missing handle')
  return value
}
function layout(value: unknown, workspace: string): HerdrLayoutApply {
  const result = object(value)
  const applied = object(result.layout)
  const root = object(applied.root)
  if (applied.workspace_id !== workspace) throw new Error('project-workspaces: layout belongs to another workspace')
  handle(applied.tab_id); handle(root.pane_id)
  return value as HerdrLayoutApply
}

/** A private journal: reserve before external mutation; never reclaim uncertain work
 * on a timeout. The lock is held only during synchronous compare/write operations. */
class WorkspaceJournal {
  constructor(private readonly path: string) {}

  update<T>(fn: (rows: Record<string, WorkspaceRecord>) => T): T {
    return this.locked(fn, true)
  }

  /** A read under the same lock and file checks that writes NOTHING (#1226 sleep's
   * read-only Chat sample). */
  read<T>(fn: (rows: Readonly<Record<string, WorkspaceRecord>>) => T): T {
    return this.locked(fn, false)
  }

  private locked<T>(fn: (rows: Record<string, WorkspaceRecord>) => T, write: boolean): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const directory = lstatSync(dirname(this.path))
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
      throw new Error('project-workspaces: journal directory must be private and owned')
    }
    let held = false
    return withFlockSync(`${this.path}.lock`, () => {
      if (!held) throw new Error('project-workspaces: journal lock unavailable')
      let rows: Record<string, WorkspaceRecord> = {}
      let fd: number | undefined
      try {
        fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
          throw new Error('project-workspaces: invalid journal file')
        }
        rows = object(JSON.parse(readFileSync(fd, 'utf8'))) as Record<string, WorkspaceRecord>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally { if (fd !== undefined) closeSync(fd) }
      const result = fn(rows)
      if (!write) return result
      const temporary = `${this.path}.${randomUUID()}.tmp`
      const out = openSync(temporary, 'wx', 0o600)
      try { writeFileSync(out, JSON.stringify(rows)); fsyncSync(out) } finally { closeSync(out) }
      renameSync(temporary, this.path)
      const parent = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(parent) } finally { closeSync(parent) }
      return result
    }, acquired => { held = acquired })
  }
}

/**
 * A placement refused by the journal's own precondition, BEFORE any Herdr RPC: nothing
 * was created, so a caller holding a launch reservation for this placement may unwind
 * it (#1226: the durable Codex owner's exclusive launch file).
 */
export class ProjectWorkspaceRefusal extends Error {
  override readonly name = 'ProjectWorkspaceRefusal'
}

/** The close may have crossed a server restart or lost its observation channel.
 * The newly created pane cannot be safely cleaned up through that client. */
class PendingPaneCloseUncertain extends Error {
  override readonly name = 'PendingPaneCloseUncertain'
}

/** Library boundary only: composition supplies the real scope; lifecycle code will
 * own provider retirement. Empty workspace removal requires the separately advertised
 * atomic server guard. A saved marker correlates identity, not a secret credential. */
export class ProjectWorkspaceManager {
  private readonly journal: WorkspaceJournal
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(journalPath: string, private readonly relicProc?: RelicProcReader) { this.journal = new WorkspaceJournal(journalPath) }

  async applyLayout(client: HerdrRpc, root: HerdrLayoutPaneNode, placement: ProjectPanePlacement): Promise<HerdrLayoutApply> {
    root = structuredClone(root)
    placement = { ...placement }
    const scope = scopeOf(placement)
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const prior = this.operations.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(() => this.apply(client, root, placement, scope, key))
    this.operations.set(key, operation)
    try { return await operation } finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  private async apply(client: HerdrRpc, root: HerdrLayoutPaneNode, placement: ProjectPanePlacement,
    scope: [string, string | null], key: string): Promise<HerdrLayoutApply> {
    const workerKey = placement.role === 'worker'
      ? createHash('sha256').update(placement.operationId!).digest('hex') : undefined
    // Store only the digest, not command/environment values in the journal.
    const digest = createHash('sha256').update(JSON.stringify({
      scope, root: { type: root.type, command: root.command, cwd: root.cwd,
        env: Object.entries(root.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), label: placement.taskLabel },
    })).digest('hex')
    // #1226 reconciliation: a PENDING record (an interrupted or failed placement) is
    // otherwise a permanent refusal. When it names a workspace, that workspace is
    // probed: only POSITIVE absence (`workspace_not_found`) proves nothing of it
    // survives, and the scope is then recreated. A surviving workspace, or a pending
    // record with no workspace (a creation whose reply may have been lost), still
    // refuses — uncertain work is never reclaimed.
    let probePendingAbsence = false
    let record = this.journal.update(rows => {
      const existing = rows[key]
      if (existing !== undefined) {
        // The worker reservations are checked for EVERY existing record, pending
        // included (spec :63-68): a same-ID retry must never reach the pending-absence
        // recreation below and be placed a second time, nor change its payload.
        if (existing.workers !== undefined) {
          for (const operation of Object.values(object(existing.workers))) {
            const saved = object(operation)
            if (!nonempty(saved.digest) || !['pending', 'ambiguous', 'completed'].includes(saved.state as string)) {
              throw new ProjectWorkspaceRefusal('project-workspaces: invalid worker operation reservation')
            }
          }
        }
        if (workerKey && existing.workers?.[workerKey]) {
          const operation = existing.workers[workerKey]!
          if (operation.digest !== digest) throw new ProjectWorkspaceRefusal('project-workspaces: worker operation payload changed')
          // Completed is not an adoption API. HerdrHost would treat the returned
          // handle as newly created and might close an already-owned pane.
          throw new ProjectWorkspaceRefusal(`project-workspaces: worker operation ${operation.state}; reconcile before retry`)
        }
        if (existing.version === 1 && JSON.stringify(existing.scope) === JSON.stringify(scope)
          && existing.state === 'retired' && nonempty(existing.token) && nonempty(existing.revision)) {
          const next: WorkspaceRecord = { version: 1, revision: randomUUID(), scope, token: randomUUID(),
            state: 'pending', workers: existing.workers ?? {} }
          rows[key] = next
          return next
        }
        if (existing.version === 1 && JSON.stringify(existing.scope) === JSON.stringify(scope) && nonempty(existing.token)
          && existing.state === 'pending' && nonempty(existing.workspace)) {
          probePendingAbsence = true
          return existing
        }
        if (existing.version !== 1 || JSON.stringify(existing.scope) !== JSON.stringify(scope)
          || !nonempty(existing.token) || existing.state !== 'ready' || !nonempty(existing.workspace)
          || (existing.chat ? !nonempty(existing.chat.tab) || !nonempty(existing.chat.pane) : !existing.relinquishedChats?.length && !existing.quarantinedChats?.length)) {
          throw new ProjectWorkspaceRefusal('project-workspaces: existing ownership is invalid or pending; reconcile before retry')
        }
        return existing
      }
      const reserved: WorkspaceRecord = { version: 1, revision: randomUUID(), scope, token: randomUUID(), state: 'pending' }
      rows[key] = reserved
      return reserved
    })

    if (record.workspace) {
      try {
        const found = object(object(await client.call('workspace.get', { workspace_id: record.workspace })).workspace)
        if (probePendingAbsence) {
          throw new ProjectWorkspaceRefusal('project-workspaces: existing ownership is invalid or pending; reconcile before retry')
        }
        if (found.workspace_id !== record.workspace || object(found.tokens)[TOKEN] !== record.token) {
          throw new Error('project-workspaces: live workspace ownership mismatch')
        }
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'workspace_not_found') throw error
        record = this.reserve(key, record, { version: 1, revision: randomUUID(), scope, token: randomUUID(), state: 'pending', workers: record.workers ?? {} })
      }
    }

    let initialPane: string | undefined
    if (!record.workspace) {
      const created = object(await client.call('workspace.create', { label: placement.projectId === null ? 'Neutron General' : placement.projectLabel, cwd: root.cwd, focus: false }))
      const workspace = handle(object(created.workspace).workspace_id)
      initialPane = handle(object(created.root_pane).pane_id)
      record = this.reserve(key, record, { ...record, workspace })
      await client.call('workspace.report_metadata', { workspace_id: workspace, source: SOURCE, tokens: { [TOKEN]: record.token } })
    }

    const workspace = record.workspace!
    if (placement.role === 'worker') {
      const live = record.chat ? await this.verifyChat(client, workspace, record.chat) : false
      record = this.reserve(key, record, { ...record, state: 'pending' })
      if (!live) {
        const argv = [process.execPath, '-e', PLACEHOLDER, record.token]
        const placeholder = layout(await client.call('layout.apply', {
          workspace_id: workspace, tab_label: 'Chat', focus: false,
          // Herdr merges env into its own environment. The env executable really
          // clears it before exec; identity probes observe the final Bun argv.
          root: { type: 'pane', cwd: root.cwd, command: ['/usr/bin/env', '-i', ...argv], label: 'Chat', env: {} },
        }), workspace)
        record = this.reserve(key, record, { ...record, chat: {
          tab: placeholder.layout.tab_id, pane: placeholder.layout.root.pane_id, placeholderArgv: argv,
          retirementIdentity: creationIdentity(placeholder),
        } })
        if (initialPane) {
          await this.closeOwnedPane(client, initialPane, record)
          initialPane = undefined
        }
      }
      // Workspace and Chat setup are now acknowledged. Reserve this worker
      // independently before dispatch so an unanswered worker RPC cannot poison
      // other operations, or be retried as a second worker after restart.
      const pending: WorkerOperation = { digest, state: 'pending' }
      record = this.reserve(key, record, { ...record, state: 'ready',
        workers: { ...record.workers, [workerKey!]: pending } })
      let applied: HerdrLayoutApply
      try {
        await client.call('tab.move', { tab_id: record.chat!.tab, insert_index: 0 })
        applied = layout(await client.call('layout.apply', {
          workspace_id: workspace, tab_label: placement.taskLabel!, focus: false,
          root: { ...root, label: placement.taskLabel! },
        } satisfies HerdrProjectLayoutParams), workspace)
      } catch (error) {
        // No server error code is assumed to prove absence. Keep the reservation
        // even for a typed rejection; only a DISTINCT operation may proceed.
        this.finishWorker(key, record, workerKey!, pending, { digest, state: 'ambiguous' })
        throw error
      }
      // A changed journal identity cannot authorize cleanup of this handle:
      // another server/workspace may now own it. Failure retains the reservation.
      this.finishWorker(key, record, workerKey!, pending, { digest, state: 'completed',
        pane: applied.layout.root.pane_id, tab: applied.layout.tab_id })
      return applied
    }
    let replacedPlaceholder: string | undefined
    if (placement.role === 'chat' && record.chat) {
      try {
        const pane = object(object(await client.call('pane.get', { pane_id: record.chat.pane })).pane)
        if (pane.pane_id !== record.chat.pane || pane.workspace_id !== workspace || pane.tab_id !== record.chat.tab) throw new Error('project-workspaces: Chat placement changed')
        if (!record.chat.placeholderArgv) throw new Error('project-workspaces: Chat already has a live owner; adopt it')
        const tab = object(object(await client.call('tab.get', { tab_id: record.chat.tab })).tab)
        if (tab.workspace_id !== workspace || tab.tab_id !== record.chat.tab || tab.pane_count !== 1) {
          throw new Error('project-workspaces: Chat placeholder tab is no longer exclusively owned')
        }
        const info = object(object(await client.call('pane.process_info', { pane_id: record.chat.pane })).process_info)
        const foreground = info.foreground_processes
        if (info.pane_id !== record.chat.pane || !Array.isArray(foreground) || foreground.length !== 1
          || JSON.stringify(object(foreground[0]).argv) !== JSON.stringify(record.chat.placeholderArgv)) {
          throw new Error('project-workspaces: Chat placeholder identity is not verified')
        }
        replacedPlaceholder = record.chat.pane
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'pane_not_found') throw error
      }
    }

    record = this.reserve(key, record, { ...record, state: 'pending' })
    const title = placement.role === 'chat' ? 'Chat' : placement.taskLabel!
    const params = {
      workspace_id: workspace,
      tab_label: title, focus: false, root: { ...root, label: title },
    } satisfies HerdrProjectLayoutParams
    let applied: HerdrLayoutApply
    applied = layout(await client.call('layout.apply', params), workspace)
    try {
      if (placement.role === 'chat') {
        await client.call('tab.move', { tab_id: applied.layout.tab_id, insert_index: 0 })
      }
      // Never replace the placeholder's entire tab. A split made after our
      // identity probe belongs to someone else and survives this pane-only close.
      if (replacedPlaceholder) {
        // Creation and ordering yield to the server. Their success is not proof
        // the former placeholder still has the identity sampled before them.
        await this.verifyPlaceholderRetirement(client, record)
        await this.closeOwnedPane(client, replacedPlaceholder, record, record.chat!.tab)
      }
      if (initialPane) await this.closeOwnedPane(client, initialPane, record)
      this.reserve(key, record, {
        ...record, state: 'ready',
        ...(placement.role === 'chat' ? { chat: { tab: applied.layout.tab_id, pane: applied.layout.root.pane_id,
          retirementIdentity: creationIdentity(applied) } } : {}),
      })
    } catch (error) {
      // The host has not received this pane yet and cannot discharge its normal
      // failed-spawn cleanup. Close only the pane this operation just created.
      // A failed close leaves the journal pending: no claim of retirement.
      if (error instanceof PendingPaneCloseUncertain) throw error
      try { await client.call('pane.close', { pane_id: applied.layout.root.pane_id }) } catch { /* remains pending */ }
      throw error
    }
    return applied
  }

  /**
   * Sample the scope's Chat slot without ANY mutation (#1226 sleep): no close, no
   * journal write, never `workspace.close`. The separate retirement operation needs
   * an explicitly advertised atomic server guard. Serialized with this scope's placements, so a Chat
   * being placed right now is observed after it settles.
   */
  async inspectChat(client: HerdrRpc, placement: Omit<ProjectPanePlacement, 'role' | 'taskLabel' | 'operationId'>): Promise<ChatInspection> {
    let scope: [string, string | null]
    try { scope = scopeOf({ ...placement, role: 'chat' }) } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) }
    }
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const prior = this.operations.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(() => this.inspect(client, scope, key))
    this.operations.set(key, operation)
    try { return await operation } finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  /** Relinquish only metadata, never a process. The callback commits the exact
   * authenticated dead registry row while the workspace journal is locked.
   * If the journal save fails afterwards, its retained Chat continues to block
   * placement and an identical reconciliation can finish the interrupted write. */
  async relinquishDeadChat(client: HerdrRpc, placement: ProjectPanePlacement, pane: string,
    commit: () => boolean): Promise<boolean> {
    const scope = scopeOf(placement)
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const prior = this.operations.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(async () => {
      try {
        const before = this.journal.read(rows => structuredClone(rows[key]))
        if (!before || before.state !== 'ready' || before.chat?.pane !== pane || before.chat.placeholderArgv) return false
        const inspected = await this.inspect(client, scope, key)
        if (inspected.status !== 'live' || inspected.pane !== pane || inspected.revision !== before.revision) return false
        const info = object(object(await client.call('pane.process_info', { pane_id: pane })).process_info)
        const processes = info.foreground_processes
        if (info.pane_id !== pane || !Array.isArray(processes) || processes.length !== 1) return false
        const foreground = object(processes[0])
        const argv = foreground.argv
        if (typeof info.shell_pid !== 'number' || foreground.pid !== info.shell_pid || !Array.isArray(argv)
          || argv.length !== 1 || typeof argv[0] !== 'string'
          || !/^(?:.*\/)?-?(?:bash|sh|zsh|fish|dash)$/.test(argv[0])) return false
        return this.journal.update(rows => {
          if (JSON.stringify(rows[key]) !== JSON.stringify(before) || !commit()) return false
          const { chat, ...retained } = before
          rows[key] = { ...retained, revision: randomUUID(), relinquishedChats: [...(before.relinquishedChats ?? []), chat!] }
          return true
        })
      } catch { return false }
    })
    this.operations.set(key, operation)
    try { return await operation } finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  /** Relinquish only the active Chat claim after completed native quarantine.
   * Historical panes stay live and distinct from dead-owner shell relics. */
  async relinquishQuarantinedChat(client: HerdrRpc, placement: ProjectPanePlacement,
    identity: QuarantinedChatIdentity, authorized: () => boolean): Promise<boolean> {
    const scope = scopeOf(placement), key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const prior = this.operations.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(async () => {
      try {
        const before = this.journal.read(rows => structuredClone(rows[key]))
        if (!before || before.state !== 'ready' || before.chat?.pane !== identity.pane || before.chat.placeholderArgv
          || !nonempty(identity.operationId) || !nonempty(identity.sessionId) || !nonempty(identity.childGeneration)
          || !nonempty(identity.channelName) || !authorized()) return false
        const inspected = await this.inspect(client, scope, key)
        if (inspected.status !== 'live' || inspected.pane !== identity.pane || inspected.revision !== before.revision) return false
        const pane = object(object(await client.call('pane.get', { pane_id: identity.pane })).pane)
        if (pane.pane_id !== identity.pane || pane.workspace_id !== before.workspace || pane.tab_id !== before.chat.tab
          || before.chat.retirementIdentity && !isDeepStrictEqual(pane.retirement_identity, before.chat.retirementIdentity)) return false
        const info = object(object(await client.call('pane.process_info', { pane_id: identity.pane })).process_info)
        const processes = info.foreground_processes
        if (info.pane_id !== identity.pane || !Array.isArray(processes)) return false
        const matches = processes.map(object).filter(p => p.pid === identity.pid)
        if (matches.length !== 1 || !Array.isArray(matches[0]!.argv)
          || !matches[0]!.argv.includes(identity.sessionId)
          || !matches[0]!.argv.some((arg: unknown) => typeof arg === 'string' && arg.includes(identity.channelName))) return false
        return this.journal.update(rows => {
          if (!isDeepStrictEqual(rows[key], before) || !authorized()
            || !isDeepStrictEqual(readProcessIdentity(identity.pid), identity.processIdentity)) return false
          const { chat, ...retained } = before
          rows[key] = { ...retained, revision: randomUUID(), quarantinedChats: [
            ...(before.quarantinedChats ?? []), { ...chat!, quarantine: structuredClone(identity) },
          ] }
          return true
        })
      } catch { return false }
    })
    this.operations.set(key, operation)
    try { return await operation } finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  /** Never substitute workspace.close or a sampled empty pane list for this RPC.
   * Reservation survives uncertain replies and excludes other processes' placement. */
  async retireEmptyWorkspace(client: HerdrRpc, placement: ProjectPanePlacement, expected: ChatInspection, canRetire?: () => boolean): Promise<WorkspaceRetirement> {
    let scope: [string, string | null]
    try { scope = scopeOf(placement) } catch (error) { return { status: 'refused', reason: String(error) } }
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    const prior = this.operations.get(key) ?? Promise.resolve()
    const operation = prior.catch(() => undefined).then(async (): Promise<WorkspaceRetirement> => {
      try {
        if (!['live', 'gone', 'relics'].includes(expected.status) || !('revision' in expected) || !nonempty(expected.revision)
          || !nonempty(expected.workspace) || !nonempty(expected.pane)) return { status: 'refused', reason: 'missing original Chat observation' }
        const pong = object(await client.call('ping', {}))
        if (pong.type !== 'pong' || pong.protocol !== HERDR_PROTOCOL_VERSION
          || object(pong.capabilities ?? {}).owned_empty_workspace_retirement !== true) return { status: 'unsupported' }
        if (this.journal.read(rows => !!rows[key]?.quarantinedChats?.length)) {
          return { status: 'refused', reason: 'quarantined Chat history is retained; automatic workspace retirement is not authorized' }
        }
        const hasRelics = this.journal.read(rows => !!rows[key]?.relinquishedChats?.length)
        if (hasRelics && (object(pong.capabilities ?? {}).owned_pane_input_hold !== true
          || object(pong.capabilities ?? {}).owned_pane_retirement !== true)) return { status: 'unsupported' }
        if (hasRelics && canRetire?.() !== true) return { status: 'refused', reason: 'relic scope is not admitted idle' }
        let record = this.journal.update(rows => {
          const current = rows[key]
          if (!current || current.version !== 1 || JSON.stringify(current.scope) !== JSON.stringify(scope)
            || current.workspace !== expected.workspace || (current.chat?.pane ?? current.relinquishedChats?.[0]?.pane) !== expected.pane
            || !nonempty(current.token) || !['ready', 'retiring'].includes(current.state)
            || (current.retirement?.revision ?? current.revision) !== expected.revision) {
            throw new Error('workspace retirement observation changed')
          }
          if (current.state === 'retiring' && (!current.retirement || !nonempty(current.retirement.operationId))) {
            throw new Error('workspace retirement reservation is invalid')
          }
          const next: WorkspaceRecord = { ...current, state: 'retiring',
            retirement: current.retirement ?? { operationId: randomUUID(), revision: current.revision } }
          rows[key] = next
          return structuredClone(next)
        })
        // A vanished current Chat can leave older, authenticated dead-owner shells.
        // Their original creation receipts are the only automatic close authority.
        // Legacy entries remain visible until separately authorized operator cleanup.
        if (record.relinquishedChats?.length) {
          record = await this.retireRelinquishedChats(client, key, record, canRetire)
        }
        const target = { workspace_id: record.workspace!, workspace_token_key: TOKEN,
          workspace_token_value: record.token, operation_id: record.retirement!.operationId }
        const reply = object(await client.call('workspace.retire_empty_owned', target))
        if (reply.type !== 'workspace_retirement' || Object.entries(target).some(([field, value]) => reply[field] !== value)) {
          throw new Error('workspace retirement acknowledgement does not match reservation')
        }
        if (reply.status !== 'retired' && reply.status !== 'gone') {
          if (reply.status === 'not_empty' || reply.status === 'mismatch') {
            // The contract guarantees these correlated refusals did not mutate.
            // Keep ownership, but allow a fresh verified placement/observation.
            this.journal.update(rows => {
              if (JSON.stringify(rows[key]) !== JSON.stringify(record)) throw new Error('workspace retirement journal changed')
              const { retirement: _completed, ...retained } = record
              rows[key] = { ...retained, state: 'ready', revision: randomUUID() }
            })
            return { status: 'refused', reason: `workspace retirement ${reply.status}` }
          }
          return { status: 'unknown', reason: `workspace retirement ${String(reply.status)}` }
        }
        this.journal.update(rows => {
          if (JSON.stringify(rows[key]) !== JSON.stringify(record)) throw new Error('workspace retirement journal changed')
          // Keep worker operation tombstones: sleep must never make an old dispatch
          // allocatable again. Only the workspace/Chat ownership claims are cleared.
          rows[key] = { version: 1, revision: randomUUID(), scope, token: record.token,
            state: 'retired', workers: record.workers ?? {} }
        })
        return { status: 'retired' }
      } catch (error) { return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) } }
    })
    this.operations.set(key, operation)
    try { return await operation } finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  private async inspect(client: HerdrRpc, scope: [string, string | null], key: string): Promise<ChatInspection> {
    try {
      // A read under the journal lock: nothing is written.
      const record = this.journal.read(rows => rows[key] === undefined ? undefined : structuredClone(rows[key]!))
      if (record === undefined) return { status: 'none' }
      if (record.version !== 1 || JSON.stringify(record.scope) !== JSON.stringify(scope)
        || !nonempty(record.token) || !nonempty(record.revision)) {
        return { status: 'refused', reason: 'workspace ownership is invalid' }
      }
      if (record.state === 'retired') return { status: 'none' }
      const slot = record.chat ?? record.relinquishedChats?.[0] ?? record.quarantinedChats?.[0]
      if (!['ready', 'retiring'].includes(record.state) || !nonempty(record.workspace) || !slot
        || !nonempty(slot.tab) || !nonempty(slot.pane)) {
        return { status: 'refused', reason: 'workspace ownership is invalid or pending' }
      }
      const workspace = record.workspace
      const revision = record.retirement?.revision ?? record.revision
      let found: Record<string, unknown>
      try { found = object(object(await client.call('workspace.get', { workspace_id: workspace })).workspace) }
      catch (error) {
        if (error instanceof HerdrError && error.code === 'workspace_not_found') return { status: 'gone', workspace, pane: slot.pane, revision }
        throw error
      }
      if (found.workspace_id !== workspace || object(found.tokens)[TOKEN] !== record.token) {
        return { status: 'refused', reason: 'live workspace ownership mismatch' }
      }
      if (!record.chat) return { status: record.relinquishedChats?.length ? 'relics' : 'none', workspace, pane: slot.pane, revision }
      const live = await this.verifyChat(client, workspace, record.chat)
      if (!live) return { status: 'gone', workspace, pane: record.chat.pane, revision }
      return { status: record.chat.placeholderArgv ? 'placeholder' : 'live', workspace, pane: record.chat.pane, revision }
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private async retireRelinquishedChats(client: HerdrRpc, key: string, initial: WorkspaceRecord, canRetire?: () => boolean): Promise<WorkspaceRecord> {
    let record = initial
    const save = (next: WorkspaceRecord) => {
      this.journal.update(rows => {
        if (JSON.stringify(rows[key]) !== JSON.stringify(record)) throw new Error('relic retirement journal changed')
        rows[key] = next
      })
      record = next
    }
    for (const chat of initial.relinquishedChats ?? []) {
      const workspace = record.workspace!
      // Revalidate the marker before accepting absence, including restart retries.
      let found: Record<string, unknown>
      try { found = object(object(await client.call('workspace.get', { workspace_id: workspace })).workspace) }
      catch (error) {
        if (error instanceof HerdrError && error.code === 'workspace_not_found') return record
        throw error
      }
      if (found.workspace_id !== workspace || object(found.tokens)[TOKEN] !== record.token) throw new Error('relic workspace ownership mismatch')
      try {
        const pane = object(object(await client.call('pane.get', { pane_id: chat.pane })).pane)
        if (pane.pane_id !== chat.pane || pane.workspace_id !== workspace || pane.tab_id !== chat.tab) throw new Error('relic placement changed')
      } catch (error) {
        if (error instanceof HerdrError && error.code === 'pane_not_found') continue
        throw error
      }
      const identity = chat.retirementIdentity
      if (!identity || !nonempty(identity.terminal_id) || !nonempty(identity.runtime_generation)) {
        // No hold/mutation was issued for this legacy pane. Any earlier relic in
        // this loop is positively gone; retain the obligation without blocking wake.
        const { retirement: _reservation, ...retained } = record
        save({ ...retained, state: 'ready', revision: randomUUID() })
        throw new Error('legacy relic requires independently authorized operator retirement')
      }
      const target = { pane_id: chat.pane, tab_id: chat.tab, workspace_id: workspace,
        terminal_id: identity.terminal_id, runtime_generation: identity.runtime_generation,
        workspace_token_key: TOKEN, workspace_token_value: record.token }
      if (record.retirement!.relic?.pane !== chat.pane) {
        save({ ...record, retirement: { ...record.retirement!, relic: { pane: chat.pane, holdToken: randomUUID() } } })
      }
      let held = record.retirement!.relic!
      {
        const reply = object(await client.call('pane.hold_owned_input', { target, hold_token: held.holdToken }))
        if (reply.type !== 'pane_owned_input' || !isDeepStrictEqual(reply.target, target)
          || reply.hold_token !== held.holdToken || reply.status !== 'held'
          || !Number.isSafeInteger(reply.input_epoch) || (reply.input_epoch as number) < 0) throw new Error('relic input hold unconfirmed')
        const changedHeldEpoch = held.inputEpoch !== undefined && held.inputEpoch !== reply.input_epoch && held.releasing !== true
        if (changedHeldEpoch && held.issued) throw new Error('issued relic input hold changed')
        // An acknowledged re-hold may observe input after an uncertain release,
        // but only before any retire RPC was issued. Re-prove idle from scratch.
        if (held.releasing && held.issued) throw new Error('relic release phase is invalid')
        held = { ...held, inputEpoch: reply.input_epoch as number, releasing: false }
        save({ ...record, retirement: { ...record.retirement!, relic: held } })
        const params = { target, hold_token: held.holdToken, input_epoch: held.inputEpoch! }
        const releaseUnissued = async () => {
          if (held.issued) throw new Error('previous relic retirement remains unconfirmed')
          held = { ...held, releasing: true }
          save({ ...record, retirement: { ...record.retirement!, relic: held } })
          const released = object(await client.call('pane.release_owned_input', {
            target, hold_token: held.holdToken, input_epoch: held.inputEpoch!,
          }))
          if (released.type !== 'pane_owned_input' || !isDeepStrictEqual(released.target, target)
            || released.hold_token !== held.holdToken || released.input_epoch !== held.inputEpoch || released.status !== 'released') {
            throw new Error('relic input release unconfirmed')
          }
          const { retirement: _reservation, ...retained } = record
          save({ ...retained, state: 'ready', revision: randomUUID() })
        }
        if (changedHeldEpoch) {
          await releaseUnissued()
          throw new Error('relic input epoch changed before retirement')
        }
        // The hold blocks new terminal input. Foreground identity alone is never
        // the lifetime authority: the host checks the original birth again below.
        const info = object(object(await client.call('pane.process_info', { pane_id: chat.pane })).process_info)
        const processes = info.foreground_processes
        const foreground = Array.isArray(processes) && processes.length === 1 ? object(processes[0]) : undefined
        const argv = foreground?.argv
        const shell = typeof info.shell_pid === 'number' ? inspectIdleRelicShell(info.shell_pid, this.relicProc) : undefined
        if (info.pane_id !== chat.pane || typeof info.shell_pid !== 'number' || foreground?.pid !== info.shell_pid
          || !Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== 'string'
          || !/^(?:.*\/)?-?(?:bash|sh|zsh|fish|dash)$/.test(argv[0]) || shell === undefined || canRetire?.() !== true) {
          await releaseUnissued()
          throw new Error('relic is not an idle shell')
        }
        const checked = object(await client.call('pane.check_owned_input', params))
        if (checked.type !== 'pane_owned_input' || !isDeepStrictEqual(checked.target, target)
          || checked.hold_token !== held.holdToken || checked.status !== 'held'
          || !Number.isSafeInteger(checked.input_epoch) || (checked.input_epoch as number) < 0) {
          throw new Error('relic input hold changed')
        }
        if (checked.input_epoch !== held.inputEpoch) {
          if (held.issued) throw new Error('issued relic input epoch changed')
          held = { ...held, inputEpoch: checked.input_epoch as number }
          await releaseUnissued()
          throw new Error('relic input epoch changed before retirement')
        }
        if (!isDeepStrictEqual(inspectIdleRelicShell(info.shell_pid, this.relicProc), shell)) {
          await releaseUnissued()
          throw new Error('relic shell census changed')
        }
        if (canRetire?.() !== true) {
          await releaseUnissued()
          throw new Error('relic scope is no longer idle')
        }
        held = { ...held, issued: true }
        save({ ...record, retirement: { ...record.retirement!, relic: held } })
      }
      const retired = object(await client.call('pane.retire_held_owned', {
        target, hold_token: held.holdToken, input_epoch: held.inputEpoch!,
      }))
      if (retired.type !== 'pane_retirement' || retired.pane_id !== chat.pane
        || !['retired', 'gone'].includes(String(retired.status))) throw new Error('relic retirement unconfirmed')
      // Preserve the original slot until workspace retirement commits. A retry can
      // positively observe its absence without manufacturing a new birth receipt.
    }
    return record
  }

  /** A failed observation is not absence. Only a positively gone pane licenses a
   * replacement slot; a moved pane or modified placeholder is left untouched. */
  private async verifyChat(client: HerdrRpc, workspace: string, chat: ChatSlot): Promise<boolean> {
    try {
      const pane = object(object(await client.call('pane.get', { pane_id: chat.pane })).pane)
      if (pane.pane_id !== chat.pane || pane.workspace_id !== workspace || pane.tab_id !== chat.tab) throw new Error('project-workspaces: Chat placement changed')
      const tab = object(object(await client.call('tab.get', { tab_id: chat.tab })).tab)
      if (tab.workspace_id !== workspace || tab.tab_id !== chat.tab) throw new Error('project-workspaces: Chat tab changed')
      if (chat.placeholderArgv) {
        if (tab.pane_count !== 1) throw new Error('project-workspaces: Chat placeholder tab is no longer exclusively owned')
        const info = object(object(await client.call('pane.process_info', { pane_id: chat.pane })).process_info)
        if (info.pane_id !== chat.pane || !Array.isArray(info.foreground_processes) || info.foreground_processes.length !== 1
          || JSON.stringify(object(info.foreground_processes[0]).argv) !== JSON.stringify(chat.placeholderArgv)) {
          throw new Error('project-workspaces: Chat placeholder identity is not verified')
        }
      }
      return true
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'pane_not_found') return false
      throw error
    }
  }

  private finishWorker(key: string, expected: WorkspaceRecord, workerKey: string,
    pending: WorkerOperation, result: WorkerOperation): void {
    this.journal.update(rows => {
      const current = rows[key]
      if (!current || current.token !== expected.token || current.workspace !== expected.workspace
        || JSON.stringify(current.scope) !== JSON.stringify(expected.scope)
        || JSON.stringify(current.workers?.[workerKey]) !== JSON.stringify(pending)) {
        throw new Error('project-workspaces: worker ownership changed concurrently')
      }
      // Merge only our operation: another manager can be preparing Chat or a
      // different worker while this RPC is in flight.
      rows[key] = { ...current, workers: { ...current.workers, [workerKey]: result } }
    })
  }

  /** Verify only the pane being retired: a foreign sibling never authorizes
   * closing its tab and does not invalidate our exact inert placeholder. This
   * is a fresh identity sample, not an atomic server-side compare-and-close. */
  private async verifyPlaceholderRetirement(client: HerdrRpc, record: WorkspaceRecord): Promise<void> {
    if (!record.workspace || !record.chat?.placeholderArgv) throw new Error('project-workspaces: missing placeholder ownership')
    const pane = object(object(await client.call('pane.get', { pane_id: record.chat.pane })).pane)
    if (pane.pane_id !== record.chat.pane || pane.tab_id !== record.chat.tab || pane.workspace_id !== record.workspace) {
      throw new Error('project-workspaces: Chat placement changed')
    }
    const found = object(object(await client.call('workspace.get', { workspace_id: record.workspace })).workspace)
    if (found.workspace_id !== record.workspace || object(found.tokens)[TOKEN] !== record.token) {
      throw new Error('project-workspaces: live workspace ownership mismatch')
    }
    const info = object(object(await client.call('pane.process_info', { pane_id: record.chat.pane })).process_info)
    if (info.pane_id !== record.chat.pane || !Array.isArray(info.foreground_processes) || info.foreground_processes.length !== 1
      || JSON.stringify(object(info.foreground_processes[0]).argv) !== JSON.stringify(record.chat.placeholderArgv)) {
      throw new Error('project-workspaces: Chat placeholder identity is not verified')
    }
  }

  /** Herdr may answer pane.close while its child is still exiting. Only the exact
   * typed pending result permits a bounded read-only wait; neither another close
   * attempt nor a transport failure proves the pane was retired. */
  private async closeOwnedPane(client: HerdrRpc, paneId: string, record: WorkspaceRecord, tabId?: string): Promise<void> {
    try {
      await client.call('pane.close', { pane_id: paneId })
      return
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== 'terminal_exit_pending') throw error
    }
    try {
      const deadline = Date.now() + PANE_CLOSE_WAIT_MS
      while (true) {
        try {
          const pane = object(object(await client.call('pane.get', { pane_id: paneId })).pane)
          if (pane.pane_id !== paneId || pane.workspace_id !== record.workspace
            || tabId !== undefined && pane.tab_id !== tabId) {
            throw new Error('project-workspaces: closing pane placement changed')
          }
        } catch (error) {
          if (!(error instanceof HerdrError) || error.code !== 'pane_not_found') throw error
          // A new server can also say this handle is absent. Corroborate the
          // recorded workspace on the same RPC client before publishing readiness.
          await verifyHerdrProtocol(client)
          const found = object(object(await client.call('workspace.get', { workspace_id: record.workspace! })).workspace)
          if (found.workspace_id !== record.workspace || object(found.tokens)[TOKEN] !== record.token) {
            throw new Error('project-workspaces: live workspace ownership mismatch')
          }
          return
        }
        if (Date.now() >= deadline) throw new Error('project-workspaces: terminal closure still pending')
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(PANE_CLOSE_POLL_MS, deadline - Date.now())))
      }
    } catch (error) {
      throw new PendingPaneCloseUncertain(error instanceof Error ? error.message : String(error))
    }
  }

  private reserve(key: string, expected: WorkspaceRecord, next: WorkspaceRecord): WorkspaceRecord {
    return this.journal.update(rows => {
      const current = rows[key]
      if (!current || JSON.stringify({ ...current, workers: undefined }) !== JSON.stringify({ ...expected, workers: undefined })) {
        throw new Error('project-workspaces: ownership changed concurrently')
      }
      const workers = { ...current.workers }
      for (const [operationKey, operation] of Object.entries(next.workers ?? {})) {
        if (JSON.stringify(operation) === JSON.stringify(expected.workers?.[operationKey])) continue
        if (JSON.stringify(current.workers?.[operationKey]) !== JSON.stringify(expected.workers?.[operationKey])) {
          throw new Error('project-workspaces: worker ownership changed concurrently')
        }
        workers[operationKey] = operation
      }
      const revised = { ...next, revision: randomUUID(), workers }
      rows[key] = revised
      return revised
    })
  }
}
