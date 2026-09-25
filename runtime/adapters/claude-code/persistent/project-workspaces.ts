import { randomUUID, createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { HerdrError, type HerdrRpc } from './herdr-client.ts'
import type { HerdrLayoutApply, HerdrLayoutPaneNode, HerdrProjectLayoutParams } from './herdr-protocol.ts'
import { withFlockSync } from './registry-lock.ts'

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

interface ChatSlot { tab: string; pane: string; placeholderArgv?: string[] }

/**
 * A READ-ONLY sample of a scope's Chat slot (#1226 sleep). `live`: an owned,
 * placed real Chat pane is running. `gone`: the slot's pane is positively gone
 * (`pane_not_found`) — the next Chat placement already treats that as an empty slot.
 * `placeholder`: the verified inert asleep placeholder. `none`: this manager has no
 * record for the scope. `refused`: anything unverified or foreign (a changed
 * workspace token, a moved pane, a modified placeholder, a pending/invalid record,
 * any other error). Refused never licenses a close.
 */
export type ChatInspection =
  | { status: 'live' | 'gone' | 'placeholder' | 'none'; workspace?: string; pane?: string }
  | { status: 'refused'; reason: string }
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
  state: 'pending' | 'ready'
  workspace?: string
  chat?: ChatSlot
  workers?: Record<string, WorkerOperation>
}

const TOKEN = 'neutron_project_owner'
const SOURCE = 'neutron-project-workspaces'
const PLACEHOLDER = 'console.log("Chat is asleep. Open this project in Neutron to resume."); setInterval(() => {}, 3600000)'

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[\x00-\x1f\x7f]/.test(value)
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

/** Library boundary only: composition supplies the real scope; lifecycle code will
 * own sleep/retirement. This manager never closes an existing workspace or moves a
 * pane between workspaces. A saved marker correlates identity, not a secret credential. */
export class ProjectWorkspaceManager {
  private readonly journal: WorkspaceJournal
  private readonly operations = new Map<string, Promise<unknown>>()

  constructor(journalPath: string) { this.journal = new WorkspaceJournal(journalPath) }

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
        if (existing.version === 1 && JSON.stringify(existing.scope) === JSON.stringify(scope) && nonempty(existing.token)
          && existing.state === 'pending' && nonempty(existing.workspace)) {
          probePendingAbsence = true
          return existing
        }
        if (existing.version !== 1 || JSON.stringify(existing.scope) !== JSON.stringify(scope)
          || !nonempty(existing.token) || existing.state !== 'ready' || !nonempty(existing.workspace)
          || !existing.chat || !nonempty(existing.chat.tab) || !nonempty(existing.chat.pane)) {
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
        } })
        if (initialPane) {
          await client.call('pane.close', { pane_id: initialPane })
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
        await client.call('pane.close', { pane_id: replacedPlaceholder })
      }
      if (initialPane) await client.call('pane.close', { pane_id: initialPane })
      this.reserve(key, record, {
        ...record, state: 'ready',
        ...(placement.role === 'chat' ? { chat: { tab: applied.layout.tab_id, pane: applied.layout.root.pane_id } } : {}),
      })
    } catch (error) {
      // The host has not received this pane yet and cannot discharge its normal
      // failed-spawn cleanup. Close only the pane this operation just created.
      // A failed close leaves the journal pending: no claim of retirement.
      try { await client.call('pane.close', { pane_id: applied.layout.root.pane_id }) } catch { /* remains pending */ }
      throw error
    }
    return applied
  }

  /**
   * Sample the scope's Chat slot without ANY mutation (#1226 sleep): no close, no
   * journal write, never `workspace.close` (Herdr has no atomic ownership/contents
   * guard for a workspace or whole-tab close, so the workspace is always left for
   * lifecycle reconciliation). Serialized with this scope's placements, so a Chat
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

  private async inspect(client: HerdrRpc, scope: [string, string | null], key: string): Promise<ChatInspection> {
    try {
      // A read under the journal lock: nothing is written.
      const record = this.journal.read(rows => rows[key] === undefined ? undefined : structuredClone(rows[key]!))
      if (record === undefined) return { status: 'none' }
      if (record.version !== 1 || JSON.stringify(record.scope) !== JSON.stringify(scope) || !nonempty(record.token)
        || record.state !== 'ready' || !nonempty(record.workspace) || !record.chat
        || !nonempty(record.chat.tab) || !nonempty(record.chat.pane)) {
        return { status: 'refused', reason: 'workspace ownership is invalid or pending' }
      }
      const workspace = record.workspace
      const found = object(object(await client.call('workspace.get', { workspace_id: workspace })).workspace)
      if (found.workspace_id !== workspace || object(found.tokens)[TOKEN] !== record.token) {
        return { status: 'refused', reason: 'live workspace ownership mismatch' }
      }
      const live = await this.verifyChat(client, workspace, record.chat)
      if (!live) return { status: 'gone', workspace, pane: record.chat.pane }
      return { status: record.chat.placeholderArgv ? 'placeholder' : 'live', workspace, pane: record.chat.pane }
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) }
    }
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
