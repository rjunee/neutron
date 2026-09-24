/**
 * herdr-workspace-fake-server.ts — a scripted Herdr server that understands
 * WORKSPACES, TAB OBJECTS and MANY PANES, for tests that drive the real
 * `ProjectWorkspaceManager` through the real strict `createProjectWorkspaceHost`.
 *
 * `herdr-fake-server.ts` models ONE pane, which is right for the REPL host suites and
 * wrong here: a worker placement creates a workspace, reserves an inert Chat pane,
 * moves its tab, and then adds a worker tab — four objects the single-pane fake cannot
 * tell apart. This fake answers only the methods those two components ask, records
 * every request so tests assert the EXACT RPC sent (not an internal call), and keeps
 * the same levers: fail a method, malform a reply, hold a method in flight, or inspect
 * the calls. `panes` is public so a test can model replaced work (change a pane's
 * argv or pid) or a vanished pane (delete it).
 * Anything else is refused loudly as a new question the host started asking.
 */

import { HerdrError, type HerdrRpc } from '../herdr-client.ts'
import { HERDR_PANE_NOT_FOUND } from '../herdr-protocol.ts'
import type { RecordedCall } from './herdr-fake-server.ts'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectWorkspaceHost } from '../project-workspace-host.ts'
import { createWorkerPlacement, type WorkerPlacementScope } from '../../../../workers/worker-placement.ts'

interface FakePane { pane_id: string; workspace_id: string; tab_id: string; argv: string[]; shell_pid: number; label: string }
interface FakeTab { tab_id: string; workspace_id: string; label: string }

export class FakeHerdrWorkspaceServer implements HerdrRpc {
  readonly calls: RecordedCall[] = []
  readonly workspaces = new Map<string, { workspace_id: string; label: string; tokens: Record<string, unknown> }>()
  readonly tabs = new Map<string, FakeTab>()
  readonly panes = new Map<string, FakePane>()
  /** Panes a SUCCESSFUL `pane.close` destroyed, in order. */
  readonly closed: string[] = []
  /** What `pane.read` reports for every pane. Nothing under test may read it. */
  screen = ''
  private serial = 0
  private readonly failures = new Map<string, Error>()
  private readonly malformed = new Map<string, Record<string, unknown>>()
  private readonly holds = new Map<string, Promise<void>>()

  failMethod(method: string, error?: Error): void { this.failures.set(method, error ?? new Error(`fake-herdr: ${method} refused`)) }
  clearFailure(method: string): void { this.failures.delete(method) }
  malformMethod(method: string, payload: Record<string, unknown>): void { this.malformed.set(method, payload) }
  /** Make `method` HANG (recorded, unanswered) until the returned function runs. */
  holdMethod(method: string): () => void {
    let release: () => void = () => {}
    this.holds.set(method, new Promise<void>(resolve => { release = () => { this.holds.delete(method); resolve() } }))
    return () => release()
  }
  callsTo(method: string): RecordedCall[] { return this.calls.filter(call => call.method === method) }

  /** Worker tabs: every layout.apply that is not the inert Chat reservation. */
  workerLayouts(): RecordedCall[] { return this.callsTo('layout.apply').filter(call => call.params['tab_label'] !== 'Chat') }

  private next(prefix: string): string { return `${prefix}-${++this.serial}` }

  private pane(workspace_id: string, tab_id: string, argv: string[], label: string): FakePane {
    const pane = { pane_id: this.next('pane'), workspace_id, tab_id, argv, shell_pid: 40_000 + this.serial, label }
    this.panes.set(pane.pane_id, pane)
    return pane
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    const held = this.holds.get(method)
    if (held !== undefined) await held
    const injected = this.failures.get(method)
    if (injected !== undefined) throw injected
    const bad = this.malformed.get(method)
    if (bad !== undefined) return bad
    switch (method) {
      case 'ping':
        return { type: 'pong', version: '0.8.2', protocol: 20 }
      case 'workspace.create': {
        const workspace_id = this.next('workspace')
        const tab_id = this.next('tab')
        this.workspaces.set(workspace_id, { workspace_id, label: String(params['label']), tokens: {} })
        this.tabs.set(tab_id, { tab_id, workspace_id, label: 'shell' })
        const root = this.pane(workspace_id, tab_id, ['initial-shell'], 'shell')
        return { workspace: { workspace_id }, tab: { tab_id }, root_pane: { pane_id: root.pane_id } }
      }
      case 'workspace.report_metadata': {
        const workspace = this.workspaces.get(String(params['workspace_id']))
        if (!workspace) throw new HerdrError('workspace_not_found', 'workspace not found')
        workspace.tokens = { ...(params['tokens'] as Record<string, unknown>) }
        return {}
      }
      case 'workspace.get': {
        const workspace = this.workspaces.get(String(params['workspace_id']))
        if (!workspace) throw new HerdrError('workspace_not_found', 'workspace not found')
        return { workspace: { workspace_id: workspace.workspace_id, tokens: workspace.tokens } }
      }
      case 'layout.apply': {
        const workspace_id = params['workspace_id']
        if (typeof workspace_id !== 'string' || !this.workspaces.has(workspace_id)) {
          throw new HerdrError('workspace_not_found', 'layout.apply names no known workspace')
        }
        const root = params['root'] as { command: string[]; label?: string }
        const tab_id = this.next('tab')
        this.tabs.set(tab_id, { tab_id, workspace_id, label: String(params['tab_label']) })
        const argv = root.command[0] === '/usr/bin/env' && root.command[1] === '-i' ? root.command.slice(2) : root.command
        const pane = this.pane(workspace_id, tab_id, [...argv], String(root.label ?? ''))
        return { layout: { workspace_id, tab_id, root: { pane_id: pane.pane_id } } }
      }
      case 'tab.move':
        return {}
      case 'tab.get': {
        const tab = this.tabs.get(String(params['tab_id']))
        if (!tab) throw new HerdrError('tab_not_found', 'tab not found')
        return { tab: { ...tab, pane_count: [...this.panes.values()].filter(pane => pane.tab_id === tab.tab_id).length } }
      }
      case 'pane.get': {
        const pane = this.panes.get(String(params['pane_id']))
        if (!pane) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        return { pane: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id,
          label: pane.label, scroll: { viewport_rows: 40 } } }
      }
      case 'pane.process_info': {
        const pane = this.panes.get(String(params['pane_id']))
        if (!pane) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        return { process_info: { pane_id: pane.pane_id, shell_pid: pane.shell_pid,
          foreground_processes: [{ pid: pane.shell_pid, name: pane.argv[0], argv: [...pane.argv] }] } }
      }
      case 'pane.read': {
        const pane = this.panes.get(String(params['pane_id']))
        if (!pane) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        return { read: { pane_id: pane.pane_id, source: String(params['source']), text: this.screen, revision: 0, truncated: false } }
      }
      case 'pane.list':
        return { panes: [...this.panes.values()].filter(pane => pane.workspace_id === params['workspace_id']) }
      case 'pane.close': {
        const id = String(params['pane_id'])
        const pane = this.panes.get(id)
        // Measured on the real server: closing a missing pane is `pane_not_found`, not ok.
        if (!pane) throw new HerdrError(HERDR_PANE_NOT_FOUND, 'pane not found')
        this.panes.delete(id)
        this.closed.push(id)
        if (![...this.panes.values()].some(other => other.tab_id === pane.tab_id)) this.tabs.delete(pane.tab_id)
        return { type: 'ok' }
      }
      default:
        throw new Error(`fake-herdr-workspace: unscripted method '${method}' — the host asked for something new`)
    }
  }
}

/**
 * A worker-placement rig over the REAL strict host and manager, for the bounded
 * worker suites: one fake server, one private journal under `directory`, and a
 * factory for placements in `scope`. `receipts(dir)` reads every placement
 * receipt a runner wrote there, so tests assert the durable record, not a mock.
 */
export function workerPlacementRig(directory: string, scope: Partial<WorkerPlacementScope> = {},
  timeouts: { placeTimeoutMs?: number; closeTimeoutMs?: number; inspectTimeoutMs?: number } = {}) {
  const server = new FakeHerdrWorkspaceServer()
  const journal = join(directory, 'terminal', 'workspaces.json')
  // Screens are released and polled at once, so a view that is NOT detached shows up
  // as `pane.read` traffic within the test instead of after a multi-second gate.
  const host = createProjectWorkspaceHost(journal, { connect: async () => server, pidWaitMs: 500, outputGateMaxMs: 1, pollIntervalMs: 10 })
  const resolved: WorkerPlacementScope = { instanceId: 'instance', projectId: 'project-one', projectLabel: 'Project One', ...scope }
  const receipts = async (dir: string) => Promise.all((await readdir(dir)).filter(name => name.endsWith('.placement.json')).sort()
    .map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as { state: string; pane?: string; reason?: string; pid?: number; viewPath?: string; taskLabel?: string }))
  return { server, host, journal, scope: resolved, placement: () => createWorkerPlacement({ host, scope: resolved, ...timeouts }), receipts }
}

/** Poll `probe` until it yields a value; bounded by attempts, never by a clock assertion. */
export async function until<T>(probe: () => Promise<T | undefined> | T | undefined, attempts = 1_000, stepMs = 10): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(stepMs)
  }
  throw new Error('until: condition never held')
}
