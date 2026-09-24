/**
 * worker-placement.ts — a VISIBLE TAB for a cross-provider bounded worker, in the
 * dispatch's own project Herdr workspace, WITHOUT moving the worker into Herdr.
 *
 * WHY THE WORKER STAYS A NATIVE PROCESS. The headless runners read their verdict from
 * the worker's own structured channels: Claude's JSON result on stdout plus its exit
 * status (`claude-headless.ts` `execute`), the Codex build wrapper's exit code plus the
 * trailer file (`codex-headless.ts` `waitFor`/`mapTrailer`), and the Codex review seat's
 * JSONL events, exit code and `-o` candidate (`codex-review.ts`). Herdr hands back a
 * RENDERED SCREEN and no exit code (`herdr-host.ts`: "NO EXIT CODES EXIST ANYWHERE IN
 * HERDR"). Re-hosting the worker inside a pane would throw every one of those channels
 * away, and launching a SECOND worker to fill a tab is forbidden by the spec
 * (`docs/spec-items/project-herdr-workspaces.md`: "a task view must not launch a
 * duplicate worker merely to provide a tab").
 *
 * So the tab is a TASK VIEW. The host tees the worker's own stdout bytes — the SAME
 * bytes it decodes, never a copy it reads back — to a private per-dispatch view file,
 * and the tab's pane runs a credential-free follower of that file under `env -i`. The
 * follower launches no provider CLI, holds no credential, has no network, and is not
 * read by anybody: nothing in this module or its callers ever reads a pane screen.
 *
 * PLACEMENT-FAILURE POLICY: UNPLACED EXECUTION WITH PRESERVED EVIDENCE. A missing
 * manager, an invalid explicit scope, an unreachable server, an ownership mismatch or
 * any RPC failure yields `{ kind: 'unplaced', reason }`, recorded in the placement
 * receipt, and the worker runs and reports exactly as it would with no terminal at all.
 * There is NEVER a fallback to an inherited/ambient workspace: every placement goes
 * through a host whose spawn refuses without `projectPlacement`
 * (`createProjectWorkspaceHost`) and the ownership manager is the only thing that ever
 * names the workspace. A Herdr outage must not lose a paid build or turn a real verdict
 * into `unknown`, because the tab is a view of the evidence, not the evidence.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkerRole } from '../bounded-work.ts'
import type { PtyChild, PtySpawnOpts } from '../adapters/claude-code/persistent/pty-host.ts'

/** The explicit per-dispatch terminal scope. `projectId: null` is General; the
 * literal id `'general'` is a DIFFERENT project scope and passes through untouched. */
export interface WorkerPlacementScope {
  instanceId: string
  projectId: string | null
  projectLabel: string
}

/** The two host capabilities placement uses. In production this is the strict
 * `createProjectWorkspaceHost(...)` host, which refuses any spawn without explicit
 * `projectPlacement` and routes every one through `ProjectWorkspaceManager`. */
export interface WorkerPlacementHost {
  spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild>
  closeHandle(handle: string): Promise<void>
}

export type WorkerView =
  | { kind: 'placed'; paneHandle: string; close(): Promise<void> }
  | { kind: 'unplaced'; reason: string }

export interface WorkerPlaceInput {
  /** Stable per-dispatch key; names the receipt. Must be filename-safe. */
  key: string
  taskLabel: string
  cwd: string
  viewPath: string
  receiptDir: string
}

export interface WorkerPlacement {
  /** False when no terminal host exists; a runner then keeps no view file at all. */
  readonly available: boolean
  /** Never throws and never touches the worker. */
  place(input: WorkerPlaceInput): Promise<WorkerView>
  /** Restart path: close a view pane an earlier host recorded. Never places, never throws. */
  retire(input: { key: string; receiptDir: string }): Promise<void>
}

export type WorkerPlacementOptions =
  | { host: WorkerPlacementHost; scope: WorkerPlacementScope; placeTimeoutMs?: number; closeTimeoutMs?: number }
  | { host: null; unavailable: string }

type Receipt =
  | { state: 'pending' }
  | { state: 'placed'; pane: string }
  | { state: 'closed'; pane?: string }
  | { state: 'unplaced'; reason: string }

const ROLE_LABELS: Record<WorkerRole, string> = {
  plan: 'Plan', build: 'Build', fix: 'Fix', review: 'Review', synthesis: 'Synthesis',
  replan: 'Replan', probe: 'Probe', resolve: 'Resolve', arbitrate: 'Arbitrate', 'fix-leak': 'Fix leak',
}
const TASK_NAME_MAX = 48

/** `Review · authentication`: the role, then a short task name. Exported so tests
 * assert the exact label that goes over the wire. */
export function workerTaskLabel(role: WorkerRole, taskName: string): string {
  const cleaned = taskName.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  const task = cleaned === '' ? 'task' : cleaned.length > TASK_NAME_MAX ? `${cleaned.slice(0, TASK_NAME_MAX - 1)}…` : cleaned
  return `${ROLE_LABELS[role] ?? role} · ${task}`
}

/**
 * The follower the tab runs: print the view file as it grows. No network, no
 * credential (it is launched under `env -i`), no provider CLI, and it never exits on
 * its own — the host closes its pane when the worker finishes.
 */
export const VIEW_FOLLOW_SCRIPT = [
  "const fs = require('node:fs')",
  'const path = process.argv[process.argv.length - 1]',
  'let offset = 0',
  'const buffer = Buffer.alloc(65536)',
  'const tick = () => {',
  '  let fd',
  "  try { fd = fs.openSync(path, 'r') } catch { return }",
  '  try {',
  '    for (;;) {',
  '      const read = fs.readSync(fd, buffer, 0, buffer.length, offset)',
  '      if (read <= 0) break',
  '      offset += read',
  '      process.stdout.write(buffer.subarray(0, read))',
  '    }',
  '  } catch {} finally { fs.closeSync(fd) }',
  '}',
  'tick()',
  'setInterval(tick, 250)',
].join('\n')

export function viewFollowerArgv(viewPath: string): string[] {
  // Herdr MERGES a pane's env into its own environment; `env -i` really clears it
  // before exec, exactly as the manager's inert Chat placeholder does.
  return ['/usr/bin/env', '-i', process.execPath, '-e', VIEW_FOLLOW_SCRIPT, viewPath]
}

function receiptPath(receiptDir: string, key: string): string {
  return join(receiptDir, `${key}.placement.json`)
}

/** Atomic, private write. Failure is swallowed by callers: a receipt is placement
 * evidence, never result evidence, and must not change a worker's outcome. */
function writeReceipt(receiptDir: string, key: string, receipt: Receipt): void {
  const target = receiptPath(receiptDir, key)
  const temporary = `${target}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(receipt)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, target)
}

function record(receiptDir: string, key: string, receipt: Receipt): void {
  try { writeReceipt(receiptDir, key, receipt) } catch { /* evidence of placement only */ }
}

function readReceipt(receiptDir: string, key: string): Receipt | undefined {
  try {
    const value = JSON.parse(readFileSync(receiptPath(receiptDir, key), 'utf8'))
    return value && typeof value === 'object' && typeof value.state === 'string' ? value as Receipt : undefined
  } catch { return undefined }
}

function errText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), ms) })
  try {
    return await Promise.race([work.then(value => ({ done: true as const, value })), expired])
  } finally { clearTimeout(timer) }
}

export function createWorkerPlacement(options: WorkerPlacementOptions): WorkerPlacement {
  if (options.host === null) {
    const reason = options.unavailable
    return {
      available: false,
      async place(input) {
        record(input.receiptDir, input.key, { state: 'unplaced', reason })
        return { kind: 'unplaced', reason }
      },
      async retire() { /* nothing was ever placed */ },
    }
  }
  const { host, scope } = options
  const placeTimeoutMs = options.placeTimeoutMs ?? 15_000
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000

  const closePane = async (receiptDir: string, key: string, pane: string): Promise<void> => {
    const closed = await bounded(host.closeHandle(pane).then(() => true, () => false), closeTimeoutMs)
    // A close that failed or did not answer leaves the receipt `placed`, so a later
    // retire still knows there is a pane to close. No claim of retirement.
    if (closed.done && closed.value) record(receiptDir, key, { state: 'closed', pane })
  }

  const attempt = async (input: WorkerPlaceInput): Promise<WorkerView> => {
    let child: PtyChild
    try {
      child = await host.spawn(viewFollowerArgv(input.viewPath), {
        cwd: input.cwd,
        // The follower gets NOTHING from the gateway: no credential, no lane token.
        env: {},
        label: input.taskLabel,
        onScreen() { /* the view is for the owner; its screen is never read */ },
        projectPlacement: { instanceId: scope.instanceId, projectId: scope.projectId,
          projectLabel: scope.projectLabel, role: 'worker', taskLabel: input.taskLabel },
      })
    } catch (error) {
      const reason = `placement-refused: ${errText(error)}`
      record(input.receiptDir, input.key, { state: 'unplaced', reason })
      return { kind: 'unplaced', reason }
    }
    // STOP POLLING THE PANE. Nothing consumes its screen; detaching ends the host's
    // `pane.read` loop without closing or signalling anything.
    try { child.detach?.() } catch { /* a detach failure cannot affect the worker */ }
    const pane = child.paneHandle
    if (typeof pane !== 'string' || pane === '') {
      const reason = 'placement-refused: host returned no durable pane handle'
      record(input.receiptDir, input.key, { state: 'unplaced', reason })
      return { kind: 'unplaced', reason }
    }
    record(input.receiptDir, input.key, { state: 'placed', pane })
    return { kind: 'placed', paneHandle: pane, close: () => closePane(input.receiptDir, input.key, pane) }
  }

  return {
    available: true,
    async place(input) {
      record(input.receiptDir, input.key, { state: 'pending' })
      const running = attempt(input)
      const settled = await bounded(running, placeTimeoutMs)
      if (settled.done) return settled.value
      // Too slow to be worth waiting for. If the pane appears later, close it at once
      // rather than leaving an unrecorded tab behind.
      running.then(view => view.kind === 'placed' ? view.close() : undefined).catch(() => undefined)
      const reason = `placement-timeout after ${placeTimeoutMs}ms`
      record(input.receiptDir, input.key, { state: 'unplaced', reason })
      return { kind: 'unplaced', reason }
    },
    async retire(input) {
      const receipt = readReceipt(input.receiptDir, input.key)
      if (receipt?.state !== 'placed' || typeof receipt.pane !== 'string' || receipt.pane === '') return
      await closePane(input.receiptDir, input.key, receipt.pane).catch(() => undefined)
    },
  }
}

/**
 * The per-dispatch view a runner drives. `tee` receives the worker's own stdout
 * chunks as the host reads them; `started` begins placement AFTER the native worker
 * exists; `finish` waits for placement to settle and closes a placed pane. None of
 * the three throws, and none of them is consulted for the outcome.
 */
export interface WorkerViewSession {
  tee(chunk: Uint8Array | string): void
  started(): void
  finish(): Promise<WorkerView | undefined>
}

const NO_VIEW: WorkerViewSession = { tee() {}, started() {}, async finish() { return undefined } }

export function openWorkerView(placement: WorkerPlacement | undefined, input: WorkerPlaceInput): WorkerViewSession {
  if (placement === undefined) return NO_VIEW
  if (!placement.available) {
    let pending: Promise<WorkerView> | undefined
    return { tee() {}, started() { pending ??= placement.place(input) }, finish: async () => pending }
  }
  let fd: number | undefined
  try { fd = openSync(input.viewPath, 'a', 0o600) } catch { fd = undefined }
  const write = (bytes: Uint8Array | string) => {
    if (fd === undefined) return
    try {
      // Two calls, one per overload: `writeSync` accepts neither for the union.
      if (typeof bytes === 'string') writeSync(fd, bytes)
      else writeSync(fd, bytes)
    } catch { /* display only */ }
  }
  let pending: Promise<WorkerView> | undefined
  return {
    tee: write,
    started() { pending ??= placement.place(input) },
    async finish() {
      write('\n[host] worker exited\n')
      if (fd !== undefined) { try { closeSync(fd) } catch { /* display only */ } fd = undefined }
      if (pending === undefined) return undefined
      const view = await pending
      if (view.kind === 'placed') await view.close().catch(() => undefined)
      return view
    },
  }
}
