/**
 * @neutronai/landing — how long a project switch actually takes, measured.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The owner: *"annoyingly slow to switch between project tabs. Can take a couple
 * seconds after clicking on a project."* Reading `controller.setProject` gives a
 * plausible story — the old socket is torn down, a new one is opened, and the
 * transcript is re-hydrated — but a plausible story is not a measurement, and
 * the two candidate causes have OPPOSITE fixes:
 *
 *   • the empty scoped view is slow to paint  ⇒ something blocks the render
 *   • the empty view is instant and the CONTENT is slow ⇒ cache the transcript
 *     and/or keep the socket warm
 *
 * Both feel identical to the person clicking. So this records the four instants
 * that separate them rather than guessing between them.
 *
 * A corroborating hint, not a conclusion: `switchConnectingGraceMs` defaults to
 * **2500 ms**, a window somebody sized to suppress the connecting banner for the
 * duration of a normal switch. That it matches "a couple of seconds" is exactly
 * the kind of coincidence worth measuring rather than believing.
 *
 * ── IT REPORTS AN INCOMPLETE SWITCH TOO, WHICH IS THE POINT ─────────────────
 * A switch that never finishes is the most interesting one, and a recorder that
 * only emits on completion is silent for precisely that case. So an unfinished
 * record is flushed on a deadline with the marks it DID reach, and the missing
 * ones named — a partial answer beats no answer, and "socket_open never arrived"
 * is a diagnosis on its own.
 *
 * ── ALWAYS ON ──────────────────────────────────────────────────────────────
 * No flag. It is four `performance.now()` reads and one line per switch; a knob
 * would only create a state where the data the owner asked for is missing.
 */

import type { WebClientReport } from './diagnostics-client.ts'

/** Independently observed instants in a switch; their relative order is not assumed. */
export type SwitchMark = 'vm_published' | 'socket_open' | 'transcript_read' | 'transcript'

/** Every mark a complete switch reaches. Used to decide "done" and name missing marks. */
const ALL_MARKS: readonly SwitchMark[] = [
  'vm_published',
  'socket_open',
  'transcript_read',
  'transcript',
]

/**
 * Marks whose absence is a NORMAL OUTCOME, not a failure.
 *
 * `socket_open` does not fire when the warm cache returns a session whose socket
 * is ALREADY open — which is the win, not a fault. Reporting that as
 * `never_arrived` sent the owner a line that reads exactly like the failure case
 * ("the socket never came up") when it meant the opposite.
 *
 * ⇒ an instrument MUST distinguish "did not happen because it was unnecessary"
 * from "did not happen because it failed". One symbol for both is a lie the
 * reader has no way to detect.
 */
const OPTIONAL_MARKS: ReadonlySet<SwitchMark> = new Set<SwitchMark>(['socket_open'])

export interface SwitchRecord {
  /** Project navigated FROM (`null` = General). */
  readonly from: string | null
  /** Project navigated TO (`null` = General). */
  readonly to: string | null
  /** ms from click to each mark. A missing key means that mark never arrived. */
  readonly marks: Partial<Record<SwitchMark, number>>
  /** ms from click to the last mark seen — the number the owner feels. */
  readonly total: number
  /** True when the record was flushed by the deadline rather than by completing. */
  readonly incomplete: boolean
}

export interface SwitchTimingOptions {
  /** Injectable clock; defaults to `performance.now()` (monotonic, sub-ms). */
  now?: () => number
  /** Injectable sink; defaults to a single `console.info` line. */
  emit?: (record: SwitchRecord) => void
  /**
   * How long to wait for the remaining marks before flushing what we have.
   * Deliberately LONGER than `switchConnectingGraceMs` (2500 ms): a switch that
   * trips that grace window is still in progress and worth waiting out, and
   * flushing first would report every slow-but-successful switch as incomplete.
   */
  deadlineMs?: number
  /** How many finished records to keep for retrieval. */
  keep?: number
}

const DEFAULT_DEADLINE_MS = 8_000
const DEFAULT_KEEP = 50

/**
 * One switch's stopwatch. Created per switch; `mark()` is a no-op after the
 * record is flushed, so a late frame from a superseded switch cannot resurrect
 * or corrupt it.
 */
export class SwitchTimer {
  private readonly now: () => number
  private readonly emit: (record: SwitchRecord) => void
  private readonly deadlineMs: number
  private readonly startedAt: number
  private readonly marks: Partial<Record<SwitchMark, number>> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushed = false

  constructor(
    private readonly from: string | null,
    private readonly to: string | null,
    opts: SwitchTimingOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now())
    this.emit = opts.emit ?? defaultEmit
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
    this.startedAt = this.now()
    this.timer = setTimeout(() => this.flush(true), this.deadlineMs)
    // Never hold the process open for a measurement (node/bun test runners).
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /**
   * Stamp a mark. The FIRST stamp of each mark wins — a reconnect that fires a
   * second `socket_open` must not overwrite the one the user actually waited for.
   */
  mark(mark: SwitchMark): void {
    if (this.flushed) return
    if (this.marks[mark] !== undefined) return
    this.marks[mark] = round(this.now() - this.startedAt)
    if (ALL_MARKS.every((m) => OPTIONAL_MARKS.has(m) || this.marks[m] !== undefined)) this.flush(false)
  }

  /** Abandon this switch — the user clicked somewhere else. Reports what it had. */
  supersede(): void {
    this.flush(true)
  }

  private flush(incomplete: boolean): void {
    if (this.flushed) return
    this.flushed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const seen = ALL_MARKS.map((m) => this.marks[m]).filter((v): v is number => v !== undefined)
    this.emit({
      from: this.from,
      to: this.to,
      marks: { ...this.marks },
      total: seen.length > 0 ? Math.max(...seen) : 0,
      incomplete,
    })
  }
}

/** The finished records, newest last. Read from a console or a debug pane. */
const recent: SwitchRecord[] = []
let keep = DEFAULT_KEEP

export function recentProjectSwitches(): readonly SwitchRecord[] {
  return recent
}

export function clearProjectSwitches(): void {
  recent.length = 0
}

export function setProjectSwitchHistoryLimit(n: number): void {
  keep = Math.max(1, Math.trunc(n))
  while (recent.length > keep) recent.shift()
}

/**
 * One line per switch, plus the record kept for retrieval.
 *
 * Every mark is reported as an absolute duration from the click. Transcript
 * hydration is a local store read and may finish before the socket opens, so no
 * cross-mark gap is derived from an ordering the switch does not guarantee.
 */
function defaultEmit(r: SwitchRecord): void {
  recent.push(r)
  while (recent.length > keep) recent.shift()
  const vm = r.marks.vm_published
  const sock = r.marks.socket_open
  const tx = r.marks.transcript
  // Only a REQUIRED mark can be missing in the failure sense. A reused socket
  // is reported as `reused`, which is a different fact and reads like one.
  const missing = ALL_MARKS.filter((m) => !OPTIONAL_MARKS.has(m) && r.marks[m] === undefined)
  const reused = ALL_MARKS.filter((m) => OPTIONAL_MARKS.has(m) && r.marks[m] === undefined)
  const parts = [
    `to=${r.to ?? 'general'}`,
    `from=${r.from ?? 'general'}`,
    `vm=${fmt(vm)}`,
    `socket=${fmt(sock)}`,
    `transcript_read=${fmt(r.marks.transcript_read)}`,
    `transcript=${fmt(tx)}`,
    `total=${fmt(r.total)}`,
  ]
  if (reused.length > 0) parts.push(`reused=${reused.join(',')}`)
  if (missing.length > 0) parts.push(`never_arrived=${missing.join(',')}`)
  console.info(`[project-switch] ${parts.join(' ')}`)
}

/** Build the persisted perf report without ever accepting or embedding a bearer. */
export function buildSwitchReport(r: SwitchRecord, createdAt = Date.now()): WebClientReport {
  return {
    schema: 1,
    report_id: `web-switch-${createdAt}-${randomId()}`,
    created_at: createdAt,
    origin: globalThis.location?.origin ?? '',
    reason: 'perf',
    app: { version: 'web', build: null, platform: 'web', os_version: null },
    session: { signed_in: true },
    events: [{
      at: createdAt,
      level: 'info',
      kind: 'project_switch',
      message: r.incomplete ? 'Project switch incomplete' : 'Project switch complete',
      context: {
        from: r.from,
        to: r.to,
        marks: { ...r.marks },
        total: r.total,
        incomplete: r.incomplete,
      },
    }],
  }
}

/**
 * Add best-effort remote reporting to the local console/history emitter.
 * Delivery is deliberately non-blocking and non-durable: it starts in a
 * microtask, a failed post is dropped without retry, and telemetry can never
 * delay or break the project switch that produced it.
 */
export function createSwitchTimingEmitter(
  send: (report: WebClientReport) => Promise<unknown>,
): (record: SwitchRecord) => void {
  // Latch: one console error per failing REASON, not one per switch. A broken
  // ingest fails on every single switch, and a message repeated forty times
  // reads as noise and gets scrolled past — which is the same invisibility this
  // is here to end, one layer up.
  let reported = ''
  return (record) => {
    defaultEmit(record)
    void Promise.resolve()
      .then(() => send(buildSwitchReport(record)))
      .catch((err: unknown) => {
        // NEVER swallow. `.catch(() => undefined)` here, plus a client that
        // discarded its Response, is why switch timings reached nobody for a
        // day while the owner hand-pasted them into chat. The report itself is
        // droppable; the fact that it dropped is not.
        const reason = err instanceof Error ? err.message : String(err)
        if (reason === reported) return
        reported = reason
        console.error(`[project-switch] timing report NOT delivered — ${reason}`)
      })
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

function fmt(v: number | undefined): string {
  return v === undefined ? '-' : `${v}ms`
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}
