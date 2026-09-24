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
 *
 * CLEANUP NEVER GATES THE RESULT. A runner `release()`s the view when its worker exits;
 * that STARTS the bounded pane cleanup and returns at once, so the exit is classified,
 * the deadline checked and the result published exactly as with no terminal.
 *
 * A PANE ID IS NOT IDENTITY. Every close — in-run, late after a placement timeout, or a
 * restart retire — first re-reads the live pane (`inspectHandle`) and closes only when it
 * still runs the follower the receipt recorded (`followerOwnsPane`). Unknown identity is
 * refused and kept for a later retire; changed identity is refused and `disowned`.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WorkerRole } from '../bounded-work.ts'
import type { HandleInspection, PtyChild, PtySpawnOpts } from '../adapters/claude-code/persistent/pty-host.ts'

/** The explicit per-dispatch terminal scope. `projectId: null` is General; the
 * literal id `'general'` is a DIFFERENT project scope and passes through untouched. */
export interface WorkerPlacementScope {
  instanceId: string
  projectId: string | null
  projectLabel: string
}

/** The three host capabilities placement uses. In production this is the strict
 * `createProjectWorkspaceHost(...)` host, which refuses any spawn without explicit
 * `projectPlacement` and routes every one through `ProjectWorkspaceManager`.
 * `inspectHandle` is what makes a close SAFE: a pane id is only a handle, and no pane
 * is closed until the live pane is shown to still run the follower this host placed. */
export interface WorkerPlacementHost {
  spawn(argv: string[], opts: PtySpawnOpts): Promise<PtyChild>
  closeHandle(handle: string): Promise<void>
  inspectHandle(handle: string): Promise<HandleInspection>
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
  /** A host line written once at the top of the view file, before any worker byte.
   * Display only; for a worker whose own stdout carries no progress until it exits. */
  banner?: string
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
  | { host: WorkerPlacementHost; scope: WorkerPlacementScope; placeTimeoutMs?: number; closeTimeoutMs?: number; inspectTimeoutMs?: number }
  | { host: null; unavailable: string }

/**
 * The durable placement record. `placed` carries the FOLLOWER IDENTITY observed at
 * placement time — the pid the host reported for the pane and the view path that is
 * the follower's last argv token — because a pane id alone is not identity: a Herdr
 * restart re-issues ids, and a saved id can later name somebody else's work
 * (`docs/spec-items/project-herdr-workspaces.md`, "an unverified saved handle").
 * `script` is the sha256 of the follower script the pane was started with, so the
 * receipt is self-contained: a later build that edits `VIEW_FOLLOW_SCRIPT` still
 * recognises (and retires) a follower an older build placed.
 * `disowned` is terminal: the pane is live but no longer runs our follower, so it is
 * never targeted again.
 */
export type PlacementReceipt =
  | { state: 'pending' }
  | { state: 'placed'; pane: string; pid?: number; viewPath?: string; taskLabel?: string; script?: string }
  | { state: 'closed'; pane?: string }
  | { state: 'unplaced'; reason: string }
  | { state: 'disowned'; pane: string; reason: string }
type Receipt = PlacementReceipt
type PlacedReceipt = Extract<Receipt, { state: 'placed' }>

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

/** The follower identity a receipt records: the script's sha256, not its text. */
export function followerScriptDigest(script: string): string {
  return createHash('sha256').update(script).digest('hex')
}
const VIEW_FOLLOW_SCRIPT_SHA256 = followerScriptDigest(VIEW_FOLLOW_SCRIPT)

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

/**
 * Does the live pane still run the follower `receipt` recorded? Pure; the caller has
 * already turned `gone` into a positive absence. Refusal comes in two kinds:
 *  - `unknown`: identity could not be ESTABLISHED (host unreachable, no process sample,
 *    or a receipt that recorded no identity). The receipt is kept, so a later retire
 *    may look again. Unknown is never read as ours.
 *  - `changed`: the pane is live and runs something else. It is not ours any more.
 * The pane label is never consulted: labels are owner-editable and not identity.
 */
export function followerOwnsPane(receipt: PlacedReceipt, seen: HandleInspection):
  { ok: true } | { ok: false; refuse: 'unknown' | 'changed'; reason: string } {
  if (seen.kind === 'unavailable') return { ok: false, refuse: 'unknown', reason: `identity unavailable: ${seen.reason}` }
  if (seen.kind === 'gone') return { ok: false, refuse: 'unknown', reason: 'pane is gone' }
  if (typeof receipt.viewPath !== 'string' || receipt.viewPath === '') {
    return { ok: false, refuse: 'unknown', reason: 'receipt records no follower identity' }
  }
  if (seen.argv.length === 0) return { ok: false, refuse: 'unknown', reason: 'no process sample for the pane' }
  // The script the RECEIPT recorded; a receipt from before digests existed was written
  // by a build running the current script.
  const script = typeof receipt.script === 'string' && receipt.script !== '' ? receipt.script : VIEW_FOLLOW_SCRIPT_SHA256
  if (seen.argv.at(-1) !== receipt.viewPath || !seen.argv.some(arg => followerScriptDigest(arg) === script)) {
    return { ok: false, refuse: 'changed', reason: 'pane runs another process than the recorded view follower' }
  }
  if (typeof receipt.pid === 'number' && typeof seen.pid === 'number' && receipt.pid !== seen.pid) {
    return { ok: false, refuse: 'changed', reason: `pane process changed (recorded pid ${receipt.pid}, live pid ${seen.pid})` }
  }
  return { ok: true }
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
  const inspectTimeoutMs = options.inspectTimeoutMs ?? 5_000

  /**
   * THE ONLY PATH THAT CLOSES A VIEW PANE — the in-run close, the late close after a
   * placement timeout, and the restart retire all come here. The pane is closed ONLY
   * when the live pane is shown to run the follower this receipt recorded:
   *  - `gone`: positive absence; recorded `closed`, and no close is sent.
   *  - unknown identity (unreachable host, no process sample, a receipt without
   *    identity): refused, receipt left `placed` so a later retire re-verifies.
   *  - changed identity: refused and recorded `disowned`; never targeted again.
   * `write` is false for the late close after a placement timeout, whose receipt
   * already carries the `unplaced` timeout verdict: that verdict is only rewritten
   * (back to the identity-bearing `placed`) when the late pane could NOT be retired,
   * so a later retire still has something to re-verify. Never throws.
   */
  const closeOwned = async (receiptDir: string, key: string, receipt: PlacedReceipt, write = true): Promise<'retired' | 'kept'> => {
    const pane = receipt.pane
    const inspected = await bounded(host.inspectHandle(pane).catch((error: unknown) =>
      ({ kind: 'unavailable', reason: errText(error) }) as HandleInspection), inspectTimeoutMs)
    const seen: HandleInspection = inspected.done ? inspected.value
      : { kind: 'unavailable', reason: `inspect did not answer within ${inspectTimeoutMs}ms` }
    if (seen.kind === 'gone') {
      if (write) record(receiptDir, key, { state: 'closed', pane })
      return 'retired'
    }
    const owned = followerOwnsPane(receipt, seen)
    if (!owned.ok) {
      if (owned.refuse === 'unknown') return 'kept'
      if (write) record(receiptDir, key, { state: 'disowned', pane, reason: owned.reason })
      return 'retired'
    }
    const closed = await bounded(host.closeHandle(pane).then(() => true, () => false), closeTimeoutMs)
    // A close that failed or did not answer leaves the receipt `placed`, so a later
    // retire still knows there is a pane to close. No claim of retirement.
    if (!closed.done || !closed.value) return 'kept'
    if (write) record(receiptDir, key, { state: 'closed', pane })
    return 'retired'
  }

  type Attempt = { kind: 'unplaced'; reason: string } | { kind: 'placed'; paneHandle: string; receipt: PlacedReceipt }
  const attempt = async (input: WorkerPlaceInput): Promise<Attempt> => {
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
      return { kind: 'unplaced', reason: `placement-refused: ${errText(error)}` }
    }
    // STOP POLLING THE PANE. Nothing consumes its screen; detaching ends the host's
    // `pane.read` loop without closing or signalling anything.
    try { child.detach?.() } catch { /* a detach failure cannot affect the worker */ }
    const pane = child.paneHandle
    if (typeof pane !== 'string' || pane === '') {
      return { kind: 'unplaced', reason: 'placement-refused: host returned no durable pane handle' }
    }
    const placed: PlacedReceipt = { state: 'placed', pane, viewPath: input.viewPath, taskLabel: input.taskLabel,
      script: VIEW_FOLLOW_SCRIPT_SHA256, ...(typeof child.pid === 'number' && child.pid > 0 ? { pid: child.pid } : {}) }
    return { kind: 'placed', paneHandle: pane, receipt: placed }
  }

  return {
    available: true,
    async place(input) {
      record(input.receiptDir, input.key, { state: 'pending' })
      const timeoutReason = `placement-timeout after ${placeTimeoutMs}ms`
      // ONE decision, taken by whichever side gets there first: the attempt's own
      // outcome, or the timeout. The loser never writes the receipt.
      let decided: 'attempt' | 'timeout' | undefined
      const running = attempt(input).catch((error: unknown): Attempt =>
        ({ kind: 'unplaced', reason: `placement-refused: ${errText(error)}` })).then(async (view): Promise<WorkerView> => {
        if (decided === 'timeout') {
          // Too slow to be worth waiting for: the timeout verdict is on record. A late
          // pane is closed through the SAME verified path; only a pane that could not
          // be retired is put back on record, so a later retire can re-verify it.
          if (view.kind === 'placed' &&
            await closeOwned(input.receiptDir, input.key, view.receipt, false) === 'kept') {
            record(input.receiptDir, input.key, view.receipt)
          }
          return { kind: 'unplaced', reason: timeoutReason }
        }
        decided = 'attempt'
        if (view.kind === 'unplaced') {
          record(input.receiptDir, input.key, { state: 'unplaced', reason: view.reason })
          return view
        }
        const receipt = view.receipt
        record(input.receiptDir, input.key, receipt)
        return { kind: 'placed', paneHandle: view.paneHandle,
          close: async () => { await closeOwned(input.receiptDir, input.key, receipt) } }
      })
      const settled = await bounded(running, placeTimeoutMs)
      if (settled.done) return settled.value
      // The attempt may have decided in the instant the timer fired: honour it.
      if (decided === 'attempt') return running
      decided = 'timeout'
      record(input.receiptDir, input.key, { state: 'unplaced', reason: timeoutReason })
      return { kind: 'unplaced', reason: timeoutReason }
    },
    async retire(input) {
      const receipt = readReceipt(input.receiptDir, input.key)
      if (receipt?.state !== 'placed' || typeof receipt.pane !== 'string' || receipt.pane === '') return
      await closeOwned(input.receiptDir, input.key, receipt)
    },
  }
}

/**
 * The per-dispatch view a runner drives. `tee` receives the worker's own stdout
 * chunks as the host reads them; `started` begins placement AFTER the native worker
 * exists; `release` ends the view when the worker has exited. None of them throws,
 * none of them is consulted for the outcome, and NONE OF THEM BLOCKS THE RESULT:
 * `release` is synchronous — it finishes the view file and STARTS the bounded pane
 * cleanup (placement settle, then the verified close) without waiting for it, so a
 * runner classifies the exit, checks its deadline, writes its receipt and publishes
 * its result exactly as fast as it would with no terminal at all. A stalled or failed
 * cleanup can therefore never turn a within-budget result into `unknown` or `failed`;
 * a pane it leaves behind stays `placed` on record for the verified retire.
 * `settled` is the cleanup's promise, for tests and for callers that genuinely want
 * to wait; it never rejects.
 */
export interface WorkerViewSession {
  tee(chunk: Uint8Array | string): void
  started(): void
  release(): void
  settled(): Promise<WorkerView | undefined>
}

const NO_VIEW: WorkerViewSession = { tee() {}, started() {}, release() {}, settled: async () => undefined }

export function openWorkerView(placement: WorkerPlacement | undefined, input: WorkerPlaceInput): WorkerViewSession {
  if (placement === undefined) return NO_VIEW
  if (!placement.available) {
    let pending: Promise<WorkerView> | undefined
    let cleanup: Promise<WorkerView | undefined> | undefined
    return {
      tee() {},
      started() { pending ??= placement.place(input) },
      release() { cleanup ??= pending?.catch(() => undefined) },
      settled: () => cleanup ?? Promise.resolve(undefined),
    }
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
  if (input.banner !== undefined && input.banner !== '') write(`[host] ${input.banner.replace(/[\x00-\x1f\x7f]/g, ' ')}\n`)
  let pending: Promise<WorkerView> | undefined
  let released = false
  let cleanup: Promise<WorkerView | undefined> | undefined
  return {
    tee: write,
    started() { if (!released) pending ??= placement.place(input) },
    release() {
      if (released) return
      released = true
      write('\n[host] worker exited\n')
      if (fd !== undefined) { try { closeSync(fd) } catch { /* display only */ } fd = undefined }
      // Held on the session with its rejection absorbed: nothing dangles, nothing waits.
      if (pending !== undefined) {
        cleanup = pending.then(async view => {
          if (view.kind === 'placed') await view.close()
          return view
        }).catch(() => undefined)
      }
    },
    settled: () => cleanup ?? Promise.resolve(undefined),
  }
}
