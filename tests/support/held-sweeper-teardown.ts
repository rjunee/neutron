/**
 * Held-sweeper teardown harness — proves an integration fixture's teardown
 * QUIESCES the composer's registered loops before it closes SQLite.
 *
 * WHY THIS EXISTS (#1389 follow-up): two integration fixtures ran the composed
 * `realmode_cleanups` in a synchronous `try { c() }` loop — they CALLED each
 * async cleanup but never awaited it — and then closed the DB. A loop tick that
 * was in flight at teardown could therefore touch a closed database. A fixed
 * microtask flush or a sleep cannot tell a correct teardown from a lucky one, so
 * this harness holds a REAL tick at an explicit barrier and records an ordered
 * event trace of what the teardown does while that tick is held.
 *
 * THE SEAM: the Open composer's chunked-upload sweeper (`open/wiring/uploads.ts`)
 * registers its `SupervisedLoop` (`chunked-upload-sweeper`) in the loop registry,
 * starts it, and pushes an awaited `stop()` into `realmode_cleanups`. Its tick
 * scans `upload_sessions` for expired `uploading` rows and awaits
 * `store.markExpired(id)` for each. The harness
 *   1. captures the ACTUAL loop instance the composer starts (a
 *      `SupervisedLoop.prototype.start` patch keyed on the loop's name, installed
 *      only around the boot),
 *   2. seeds a known expired row still in `uploading` (without it the tick's scan
 *      returns early and never reaches the DB write),
 *   3. holds `SqliteUploadSessionStore.prototype.markExpired` for THAT row at a
 *      barrier BEFORE the real SQL update runs, and
 *   4. drives one tick through the captured loop's public `runOnce()` — the
 *      external-tick path whose in-flight promise `SupervisedLoop.stop()` awaits.
 *
 * It then starts the fixture's own teardown and, once the teardown reaches the
 * held loop's `stop()`, records what has (wrongly) already happened: a graph
 * shutdown, a DB close, or a LATER cleanup entered while the tick is still held.
 * After release it records the real write's outcome (the sweeper swallows DB
 * errors, so tick completion alone proves nothing) and the final event order.
 *
 * `runHeldSweeperTeardown` never asserts — it returns a
 * {@link HeldTeardownReport} so the self-test can show it DETECTS a broken
 * teardown, and consumer tests assert a clean one with
 * {@link expectQuiescedTeardown}. Every patch is restored, the barrier released and both
 * the tick and the teardown awaited in `finally`, whatever happened.
 *
 * MODULE IDENTITY IS LOAD-BEARING: the prototype patches below must hit the
 * SAME module records the composed instances were built from. Both classes are
 * therefore resolved FROM THE CONSUMING MODULE'S OWN DIRECTORY — the store from
 * the composer's upload wiring, `SupervisedLoop` from the sweeper — rather than
 * from this file. A bare `@neutronai/loop` import here can resolve to a
 * DIFFERENT copy than the sweeper's (a partially-installed checkout falls back
 * to an ancestor `node_modules`), and a patch on that copy captures nothing.
 */

import { expect } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SupervisedLoop } from '@neutronai/loop'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

function resolveFrom(consumerSpecifier: string, specifier: string): string {
  const consumerDir = dirname(fileURLToPath(import.meta.resolve(consumerSpecifier)))
  return Bun.resolveSync(specifier, consumerDir)
}

const { SupervisedLoop: SweeperSupervisedLoop } = (await import(
  resolveFrom('@neutronai/gateway/upload/chunked-upload-sweeper.ts', '@neutronai/loop')
)) as typeof import('@neutronai/loop')

const { SqliteUploadSessionStore } = (await import(
  resolveFrom('@neutronai/open/wiring/uploads.ts', '@neutronai/gateway/upload/upload-session-store.ts')
)) as typeof import('@neutronai/gateway/upload/upload-session-store.ts')

type SqliteUploadSessionStore = InstanceType<typeof SqliteUploadSessionStore>

export const SWEEPER_LOOP_NAME = 'chunked-upload-sweeper'

export type Cleanup = () => void | Promise<void>

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function loopName(loop: SupervisedLoop): string {
  // `name` is a private field; same read the reflect-loop arming test uses.
  return (loop as unknown as { name: string }).name
}

/**
 * Record every `SupervisedLoop` named `name` whose `start()` runs while the patch
 * is installed. Install immediately before booting the composer and `restore()`
 * right after (in a `finally`), then assert exactly one loop was captured.
 */
export function captureLoopOnStart(name: string = SWEEPER_LOOP_NAME): {
  readonly loops: SupervisedLoop[]
  restore(): void
} {
  const proto = SweeperSupervisedLoop.prototype
  const realStart = proto.start
  const loops: SupervisedLoop[] = []
  let restored = false
  proto.start = function capturingStart(this: SupervisedLoop): void {
    if (loopName(this) === name) loops.push(this)
    return realStart.call(this)
  }
  return {
    loops,
    restore(): void {
      if (restored) return
      restored = true
      proto.start = realStart
    },
  }
}

/**
 * Boot something (the fixture's own boot) with the start-capture installed, and
 * return its value plus the ONE captured sweeper loop. The patch is restored
 * before this returns, even when the boot throws.
 */
export async function bootCapturingSweeperLoop<T>(
  boot: () => Promise<T>,
): Promise<{ value: T; loop: SupervisedLoop }> {
  const capture = captureLoopOnStart(SWEEPER_LOOP_NAME)
  let value: T
  try {
    value = await boot()
  } finally {
    capture.restore()
  }
  if (capture.loops.length !== 1) {
    throw new Error(
      `expected exactly one started '${SWEEPER_LOOP_NAME}' loop during boot, captured ${capture.loops.length}`,
    )
  }
  return { value, loop: capture.loops[0]! }
}

export interface SeededUploadRow {
  upload_id: string
  status: string
  expires_at: number
}

/** Seed one upload session that is already expired but still `uploading`. */
export function seedExpiredUploadingRow(
  db: ProjectDb,
  opts: { upload_id: string; project_slug?: string; now?: number },
): SeededUploadRow {
  const now = opts.now ?? Date.now()
  db.raw().run(
    `INSERT INTO upload_sessions
       (upload_id, project_slug, source, filename, total_bytes,
        bytes_received, mime_type, status, created_at, expires_at)
     VALUES (?, ?, 'chatgpt', 'export.zip', 1024, 0, 'application/zip', 'uploading', ?, ?)`,
    [opts.upload_id, opts.project_slug ?? 'owner', now - 120_000, now - 60_000],
  )
  const row = readUploadRow(db, opts.upload_id)
  if (row === null) throw new Error(`seeded upload row ${opts.upload_id} is not readable`)
  return row
}

export function readUploadRow(db: ProjectDb, upload_id: string): SeededUploadRow | null {
  return (
    (db
      .raw()
      .query(`SELECT upload_id, status, expires_at FROM upload_sessions WHERE upload_id = ?`)
      .get(upload_id) as SeededUploadRow | null) ?? null
  )
}

export interface HeldWriteOutcome {
  /** The real `markExpired` return — true iff the row transitioned. */
  changed: boolean | null
  /** The row's status read immediately after the real write resolved. */
  statusAfterWrite: string | null
  /** The real write's (or the follow-up read's) error, when it threw. */
  error: string | null
}

/**
 * Hold `markExpired(uploadId)` at a barrier before the real SQL runs. Other ids
 * pass straight through. `entered` resolves when the held call arrives.
 */
export function holdMarkExpired(opts: {
  uploadId: string
  db: ProjectDb
  trace: string[]
}): {
  readonly entered: Promise<void>
  readonly outcome: HeldWriteOutcome
  readonly enteredCount: () => number
  release(): void
  restore(): void
} {
  const proto = SqliteUploadSessionStore.prototype
  const realMarkExpired = proto.markExpired
  const entered = deferred<void>()
  const barrier = deferred<void>()
  const outcome: HeldWriteOutcome = { changed: null, statusAfterWrite: null, error: null }
  let enteredCount = 0
  let restored = false
  proto.markExpired = async function heldMarkExpired(
    this: SqliteUploadSessionStore,
    upload_id: string,
  ): Promise<boolean> {
    if (upload_id !== opts.uploadId) return realMarkExpired.call(this, upload_id)
    enteredCount += 1
    opts.trace.push('tick:markExpired-entered')
    entered.resolve()
    await barrier.promise
    try {
      const changed = await realMarkExpired.call(this, upload_id)
      outcome.changed = changed
      outcome.statusAfterWrite = readUploadRow(opts.db, upload_id)?.status ?? null
      opts.trace.push('tick:markExpired-done')
      return changed
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err)
      opts.trace.push('tick:markExpired-threw')
      throw err
    }
  }
  return {
    entered: entered.promise,
    outcome,
    enteredCount: () => enteredCount,
    release: () => barrier.resolve(),
    restore(): void {
      if (restored) return
      restored = true
      proto.markExpired = realMarkExpired
    },
  }
}

export interface LoopRegistryLike {
  get(name: string): { isActive?: () => boolean } | undefined
}

export interface HeldTeardownTarget {
  /** The real composition whose `realmode_cleanups` the teardown drains. */
  composition: { realmode_cleanups?: Cleanup[]; loop_registry?: LoopRegistryLike }
  /** The composed production graph the teardown shuts down. */
  graph: { shutdown(): Promise<void> }
  /** The DB the teardown closes. */
  db: ProjectDb
  /** The sweeper loop instance captured at boot ({@link bootCapturingSweeperLoop}). */
  loop: SupervisedLoop
  /** The fixture's ACTUAL teardown invocation under test. */
  teardown: () => Promise<void>
  /** Override the seeded upload id (defaults to a unique id). */
  uploadId?: string
}

export interface HeldTeardownReport {
  seeded: SeededUploadRow
  /** Registry descriptor `isActive()` before the tick was driven. */
  loopActiveBefore: boolean | null
  /** The captured loop reported a running tick once the barrier was reached. */
  loopRunningWhileHeld: boolean
  /** Index (registration order) of the cleanup that entered the held loop's stop. */
  sweeperIndex: number | null
  /**
   * Ordering violations observed WHILE the tick was held — the teardown either
   * never reached the held loop's stop, or shut the graph / closed the DB /
   * entered a later cleanup before that stop could settle. Empty == quiesced.
   */
  whileHeldViolations: string[]
  /** The teardown promise had already settled while the tick was still held. */
  teardownSettledWhileHeld: boolean
  /** A real read of the seeded row while held (the DB must still be usable). */
  dbStatusWhileHeld: string | null
  dbReadErrorWhileHeld: string | null
  /** The real write's outcome after release. */
  write: HeldWriteOutcome
  /** How many times the held write was entered (must be exactly one). */
  writeEnteredCount: number
  /** The captured loop's `runOnce()` result for the driven tick. */
  tickResult: { ran: boolean; skipped: boolean } | null
  /** The teardown's rejection, if it rejected. */
  teardownError: string | null
  /** Ordered event trace across tick, cleanups, loop stop, graph and DB. */
  trace: string[]
  /** Per-callback invocation count, indexed in registration order. */
  counts: number[]
  /** Registry descriptor `isActive()` after the teardown settled. */
  loopActiveAfter: boolean | null
  /** A post-teardown query on the DB threw (i.e. the DB really closed). */
  dbClosedAfter: boolean
  /** Unhandled rejections observed between drive and settle. */
  unhandledRejections: string[]
}

/** Violations in the FINAL trace order (empty == correct teardown order). */
export function finalOrderViolations(report: HeldTeardownReport): string[] {
  const t = report.trace
  const out: string[] = []
  const at = (e: string): number => t.indexOf(e)
  const before = (a: string, b: string): void => {
    const ia = at(a)
    const ib = at(b)
    if (ia < 0) out.push(`missing ${a}`)
    else if (ib < 0) out.push(`missing ${b}`)
    else if (ia > ib) out.push(`${a} after ${b}`)
  }
  before('tick:markExpired-done', 'loop:stop-settled')
  before('loop:stop-settled', 'graph:shutdown')
  before('graph:shutdown', 'db:close')
  const closes = t.filter((e) => e === 'db:close').length
  if (closes !== 1) out.push(`db:close recorded ${closes} times`)
  return out
}

let uploadSeq = 0

/**
 * Drive one held sweeper tick through the captured composer loop, run the
 * fixture's teardown against it, and report what the teardown did. Never
 * asserts; always releases the barrier, awaits both promises and restores
 * every patch before returning.
 */
export async function runHeldSweeperTeardown(target: HeldTeardownTarget): Promise<HeldTeardownReport> {
  const { composition, graph, db, loop } = target
  const cleanups = composition.realmode_cleanups
  if (cleanups === undefined) throw new Error('composition has no realmode_cleanups')
  const uploadId = target.uploadId ?? `held-sweeper-${process.pid}-${++uploadSeq}`
  const trace: string[] = []
  const unhandled: string[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason))
  }

  // Seed a row the tick WILL reach (expired, still uploading).
  const seeded = seedExpiredUploadingRow(db, { upload_id: uploadId })
  if (seeded.status !== 'uploading' || !(seeded.expires_at < Date.now())) {
    throw new Error(`seeded row is not expired+uploading: ${JSON.stringify(seeded)}`)
  }

  const descriptor = composition.loop_registry?.get(SWEEPER_LOOP_NAME)
  const loopActive = (): boolean | null => descriptor?.isActive?.() ?? null

  // ── instrument the teardown surfaces (all restored in finally) ────────────
  const counts = cleanups.map(() => 0)
  const originals = cleanups.slice()
  // A holder object (not bare `let`s) so closure writes are not narrowed away.
  const st: { currentIndex: number | null; sweeperIndex: number | null; teardownSettled: boolean } = {
    currentIndex: null,
    sweeperIndex: null,
    teardownSettled: false,
  }
  for (let i = 0; i < cleanups.length; i++) {
    const original = originals[i]!
    cleanups[i] = async (): Promise<void> => {
      counts[i] = (counts[i] ?? 0) + 1
      st.currentIndex = i
      trace.push(`cleanup:${i}:enter`)
      try {
        await original()
        trace.push(`cleanup:${i}:settle`)
      } catch (err) {
        trace.push(`cleanup:${i}:reject`)
        // Rethrow: the drain's continue-after-rejection is what is exercised.
        throw err
      }
    }
  }

  const stopEntered = deferred<void>()
  const realLoopStop = loop.stop
  const loopOwn = loop as unknown as { stop: () => Promise<void> }
  loopOwn.stop = async function heldLoopStop(this: SupervisedLoop): Promise<void> {
    trace.push('loop:stop-entered')
    if (st.sweeperIndex === null) st.sweeperIndex = st.currentIndex
    stopEntered.resolve()
    await realLoopStop.call(loop)
    trace.push('loop:stop-settled')
  }

  const graphOwn = graph as { shutdown: () => Promise<void> }
  const hadOwnShutdown = Object.prototype.hasOwnProperty.call(graph, 'shutdown')
  const realShutdown = graph.shutdown
  graphOwn.shutdown = function tracedShutdown(): Promise<void> {
    trace.push('graph:shutdown')
    return realShutdown.call(graph)
  }

  const dbOwn = db as unknown as { close: () => void }
  const hadOwnClose = Object.prototype.hasOwnProperty.call(db, 'close')
  const realClose = db.close
  dbOwn.close = function tracedClose(): void {
    trace.push('db:close')
    realClose.call(db)
  }

  const hold = holdMarkExpired({ uploadId, db, trace })
  process.on('unhandledRejection', onUnhandled)

  const report: HeldTeardownReport = {
    seeded,
    loopActiveBefore: loopActive(),
    loopRunningWhileHeld: false,
    sweeperIndex: null,
    whileHeldViolations: [],
    teardownSettledWhileHeld: false,
    dbStatusWhileHeld: null,
    dbReadErrorWhileHeld: null,
    write: hold.outcome,
    writeEnteredCount: 0,
    tickResult: null,
    teardownError: null,
    trace,
    counts,
    loopActiveAfter: null,
    dbClosedAfter: false,
    unhandledRejections: unhandled,
  }

  let tickP: Promise<{ ran: boolean; skipped: boolean }> | null = null
  let teardownP: Promise<void> | null = null
  try {
    tickP = loop.runOnce()
    const reached = await Promise.race([
      hold.entered.then(() => true),
      tickP.then(() => false),
    ])
    if (!reached) {
      throw new Error(`the driven tick settled without reaching markExpired(${uploadId})`)
    }
    report.loopRunningWhileHeld = loop.stats().running

    teardownP = target.teardown().then(
      () => {
        st.teardownSettled = true
        trace.push('teardown:settled')
      },
      (err: unknown) => {
        st.teardownSettled = true
        report.teardownError = err instanceof Error ? err.message : String(err)
        trace.push('teardown:rejected')
      },
    )
    // Wait on EVENTS, not time: the teardown reaches the held stop, or settles.
    await Promise.race([stopEntered.promise, teardownP])

    // ── while held ────────────────────────────────────────────────────────
    const sweeperIndex = st.sweeperIndex
    report.sweeperIndex = sweeperIndex
    const v = report.whileHeldViolations
    if (!trace.includes('loop:stop-entered')) v.push('teardown never reached the held loop stop')
    if (trace.includes('graph:shutdown')) v.push('graph:shutdown while the tick was held')
    if (trace.includes('db:close')) v.push('db:close while the tick was held')
    if (sweeperIndex !== null) {
      for (const e of trace) {
        const m = /^cleanup:(\d+):enter$/.exec(e)
        if (m !== null && Number(m[1]) > sweeperIndex) {
          v.push(`${e} while the tick was held`)
        }
      }
    }
    report.teardownSettledWhileHeld = st.teardownSettled
    try {
      report.dbStatusWhileHeld = readUploadRow(db, uploadId)?.status ?? null
    } catch (err) {
      report.dbReadErrorWhileHeld = err instanceof Error ? err.message : String(err)
    }
  } finally {
    hold.release()
    if (teardownP !== null) await teardownP
    if (tickP !== null) {
      try {
        report.tickResult = await tickP
      } catch {
        /* runOnce never rejects; defensive */
      }
    }
    report.writeEnteredCount = hold.enteredCount()
    report.loopActiveAfter = loopActive()
    // Let any rejection produced during the drive surface to the collector
    // before it is detached (one macrotask turn — an event boundary, not a wait
    // for some work to finish).
    await new Promise<void>((r) => setImmediate(r))
    process.off('unhandledRejection', onUnhandled)
    hold.restore()
    delete (loop as unknown as Record<string, unknown>)['stop']
    if (hadOwnShutdown) graphOwn.shutdown = realShutdown
    else delete (graph as unknown as Record<string, unknown>)['shutdown']
    if (hadOwnClose) dbOwn.close = realClose
    else delete (db as unknown as Record<string, unknown>)['close']
    for (let i = 0; i < originals.length && i < cleanups.length; i++) cleanups[i] = originals[i]!
  }

  try {
    db.raw().query('SELECT 1').get()
    report.dbClosedAfter = false
  } catch {
    report.dbClosedAfter = true
  }
  return report
}

/**
 * Trace an empty-cleanup-list teardown: only graph shutdown and DB close are
 * instrumented. Returns the ordered trace and whether the DB really closed.
 */
export async function runTracedTeardown(target: {
  graph: { shutdown(): Promise<void> }
  db: ProjectDb
  teardown: () => Promise<void>
}): Promise<{ trace: string[]; teardownError: string | null; dbClosedAfter: boolean }> {
  const { graph, db } = target
  const trace: string[] = []
  const graphOwn = graph as { shutdown: () => Promise<void> }
  const hadOwnShutdown = Object.prototype.hasOwnProperty.call(graph, 'shutdown')
  const realShutdown = graph.shutdown
  graphOwn.shutdown = function tracedShutdown(): Promise<void> {
    trace.push('graph:shutdown')
    return realShutdown.call(graph)
  }
  const dbOwn = db as unknown as { close: () => void }
  const hadOwnClose = Object.prototype.hasOwnProperty.call(db, 'close')
  const realClose = db.close
  dbOwn.close = function tracedClose(): void {
    trace.push('db:close')
    realClose.call(db)
  }
  let teardownError: string | null = null
  try {
    await target.teardown()
    trace.push('teardown:settled')
  } catch (err) {
    teardownError = err instanceof Error ? err.message : String(err)
  } finally {
    if (hadOwnShutdown) graphOwn.shutdown = realShutdown
    else delete (graph as unknown as Record<string, unknown>)['shutdown']
    if (hadOwnClose) dbOwn.close = realClose
    else delete (db as unknown as Record<string, unknown>)['close']
  }
  let dbClosedAfter = false
  try {
    db.raw().query('SELECT 1').get()
  } catch {
    dbClosedAfter = true
  }
  return { trace, teardownError, dbClosedAfter }
}

/**
 * The consumer-side contract for a fixture teardown driven through
 * {@link runHeldSweeperTeardown}. The WHILE-HELD ordering assertion comes first
 * so an unawaited drain or an early DB close fails on ordering, not on some
 * downstream symptom; the per-callback exact-once count follows the final
 * order, so a duplicated drain fails on the count.
 */
export function expectQuiescedTeardown(report: HeldTeardownReport): void {
  // Preconditions: a real, active, registered loop's DB-using tick was held.
  expect(report.seeded.status).toBe('uploading')
  expect(report.loopActiveBefore).toBe(true)
  expect(report.loopRunningWhileHeld).toBe(true)
  // While held: ordering, teardown still pending, DB still usable.
  expect(report.whileHeldViolations).toEqual([])
  expect(report.sweeperIndex).not.toBeNull()
  expect(report.teardownSettledWhileHeld).toBe(false)
  expect(report.dbReadErrorWhileHeld).toBeNull()
  expect(report.dbStatusWhileHeld).toBe('uploading')
  // After release: the REAL write landed (the sweeper swallows DB errors).
  expect(report.writeEnteredCount).toBe(1)
  expect(report.write.error).toBeNull()
  expect(report.write.changed).toBe(true)
  expect(report.write.statusAfterWrite).toBe('expired')
  expect(report.tickResult).toEqual({ ran: true, skipped: false })
  expect(report.teardownError).toBeNull()
  expect(finalOrderViolations(report)).toEqual([])
  // Every registered cleanup invoked exactly once in this teardown invocation.
  expect(report.counts.length).toBeGreaterThan(0)
  expect(report.counts).toEqual(report.counts.map(() => 1))
  // Settled: loop inactive, DB really closed, nothing rejected unhandled.
  expect(report.loopActiveAfter).toBe(false)
  expect(report.dbClosedAfter).toBe(true)
  expect(report.unhandledRejections).toEqual([])
}
