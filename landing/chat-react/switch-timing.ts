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
 * ── WHY `frame_rendered` EXISTS (2026-08-17) ────────────────────────────────
 * The first four marks answered "which step is slow" with a number that was real,
 * current, and about the wrong step. `vm_published` is stamped the instant
 * `publish()` RETURNS, and `publish()` only SCHEDULES the render — it computes the
 * VM and notifies subscribers, and React flushes the resulting render synchronously
 * at the END of the discrete event, after `setProject` has already returned. So
 * `vm_published` contains none of the paint. `transcript_read` is stamped after an
 * `await` whose continuation is a microtask, and microtasks cannot run until that
 * flush finishes — so it contains all of it. The whole render was charged to the
 * transcript read, and 47 real samples read
 * `transcript_read` median 3283 ms / `vm_published` median 3 ms — which says
 * "rendering is instant, the store is the cost" and means the exact opposite.
 * The store read cannot be the cost, and the reason is structural, not a benchmark:
 * `chat-core/stores/opfs-store.ts:113-115` delegates `list()` to the in-memory
 * index, so there is no OPFS I/O in the read path at all. (An uncommitted harness
 * put it at 0.1 ms median / 1.0 ms max over a 12-topic × 533-message store —
 * indicative corroboration, not a reproducible figure.)
 *
 * ⚠️ THE MISATTRIBUTION IS PROVEN; THE RENDER'S REAL MAGNITUDE IS NOT MEASURED.
 * The proof is a CONTROL experiment, not a measurement of the owner's client: a
 * subscriber with a deliberately INJECTED 250 ms synchronous body, driven through
 * React's synthetic discrete-event path, put `render_ended` at 256.6 ms while
 * `vm_published` reported 0.2 ms — and the same injected body on a plain
 * (non-React) listener reported `transcript_read` 1.8 ms. That discriminates
 * "the render lands inside the transcript window" from "it doesn't", which is all
 * it was built to do. It says NOTHING about how long the owner's 533-row
 * markdown thread actually takes to paint. Nobody has that number yet, which is
 * exactly the gap this mark exists to close — do not quote the 250 ms as if it
 * were it.
 *
 * `frame_rendered` closes the hole: stamped from a `requestAnimationFrame` plus a
 * trailing task (a single rAF callback runs BEFORE that frame's paint), it is the
 * first instant at which the published frame has actually been drawn.
 * `frame_rendered ≈ transcript_read` ⇒ the render is the cost.
 * `frame_rendered ≪ transcript_read` ⇒ the store is. No pair of marks in the
 * original four could tell those apart.
 *
 * ── A PAINT THAT NEVER HAPPENS IS NOT A FAILURE ─────────────────────────────
 * `frame_rendered`'s only in-browser source is `requestAnimationFrame`, and a
 * BACKGROUNDED OR HIDDEN TAB does not run rAF at all. A boot deep-link can switch
 * projects in exactly such a tab (`useNeutronChat.ts` documents the mount as
 * possibly hidden). Treating the mark as required therefore manufactured a
 * failure report — the switch would sit out the whole deadline and then emit
 * `Project switch incomplete … never_arrived=frame_rendered` for a switch that
 * completed correctly and simply had no picture to draw.
 *
 * ⇒ it is an OPTIONAL mark (absence = `not_painted`, a normal outcome) that the
 * recorder nevertheless WAITS for whenever the caller has told it a paint is on the
 * way ({@link SwitchTimer.expectPaint}). Both halves are load-bearing: without the
 * optionality a hidden tab lies, and without the wait the mark would be dropped on
 * essentially every switch, because the paint necessarily lands one frame AFTER the
 * `transcript` mark that would otherwise flush the record.
 *
 * ── WHY THE WAIT IS A DECLARATION AND NOT A TIMEOUT (2026-08-18) ────────────────
 * The wait used to be a fixed 250 ms window armed the moment the last required mark
 * landed. That window is in a RACE WITH THE RENDER IT EXISTS TO MEASURE, and it loses
 * exactly the samples that matter: `transcript` is stamped synchronously right after
 * `publish()` merely SCHEDULES React's render, so on a switch whose render takes the
 * 3–9 s the owner complained about, the 250 ms task comes due while the main thread is
 * still inside that render and flushes the record `not_painted` before the frame the
 * mark is for is ever drawn. The slower the switch, the more certainly its paint was
 * discarded — an instrument that is blind in proportion to the badness of what it
 * measures.
 *
 * So the caller DECLARES that it has scheduled a paint stamp, and the record then waits
 * for the stamp or for the deadline, never for a guess about how long a render takes.
 * A caller that knows no paint is coming (a hidden document, where rAF does not run)
 * simply does not declare one, and the record flushes the moment its required marks are
 * in. That is an exact answer where the timeout was an estimate, and it cannot be
 * defeated by a slow frame.
 *
 * ── ALWAYS ON ──────────────────────────────────────────────────────────────
 * No flag. It is five `performance.now()` reads and one line per switch; a knob
 * would only create a state where the data the owner asked for is missing.
 */

import type { WebClientReport } from './diagnostics-client.ts'

/** Independently observed instants in a switch; their relative order is not assumed. */
export type SwitchMark =
  | 'vm_published'
  | 'frame_rendered'
  | 'socket_open'
  | 'transcript_read'
  | 'transcript'

/** Every mark a complete switch reaches. Used to decide "done" and name missing marks. */
const ALL_MARKS: readonly SwitchMark[] = [
  'vm_published',
  'frame_rendered',
  'socket_open',
  'transcript_read',
  'transcript',
]

/**
 * Marks whose absence is a NORMAL OUTCOME, not a failure — each with the word
 * the report uses for that outcome, because "absent" alone is not a diagnosis.
 *
 * `socket_open` does not fire when the warm cache returns a session whose socket
 * is ALREADY open — which is the win, not a fault. Reporting that as
 * `never_arrived` sent the owner a line that reads exactly like the failure case
 * ("the socket never came up") when it meant the opposite.
 *
 * `frame_rendered` does not fire in a hidden or backgrounded tab, because rAF
 * does not run there and there is genuinely no paint to time. Same trap, one
 * layer along, and it would have been LOUDER: a required paint mark turns every
 * such switch into `Project switch incomplete`.
 *
 * ⇒ an instrument MUST distinguish "did not happen because it was unnecessary"
 * from "did not happen because it failed". One symbol for both is a lie the
 * reader has no way to detect.
 */
const ABSENCE_IS_NORMAL: ReadonlyMap<SwitchMark, string> = new Map<SwitchMark, string>([
  ['socket_open', 'reused'],
  ['frame_rendered', 'not_painted'],
])

/**
 * The same map for a switch whose first frame was PAINTED FROM CACHE.
 *
 * `setProject` reads the entered topic's last resolved transcript synchronously and
 * publishes it, so the owner is looking at his messages before the store is asked
 * anything. The read that follows is a BACKGROUND REFRESH of a screen already drawn
 * — nobody is waiting on it. Holding the record open for it meant a switch the owner
 * experienced as instant was filed as an eight-second switch, with the whole eight
 * seconds attributed to the store.
 *
 * That is the ORIGINAL misattribution (see the `frame_rendered` note above) reappearing
 * one level up, in the fix for it: the first version charged the store for the render;
 * this version charged the switch for work that happened after the switch was over.
 * Both come from the same reflex — treating "the last thing that finished" as "what the
 * user waited for" — and both are only visible if you ask what the owner was actually
 * looking at while the clock ran.
 */
const ABSENCE_IS_NORMAL_WHEN_CACHED: ReadonlyMap<SwitchMark, string> = new Map<SwitchMark, string>([
  ...ABSENCE_IS_NORMAL,
  ['transcript_read', 'refreshed'],
  ['transcript', 'refreshed'],
])

/**
 * The marks whose absence IS a failure. Derived so that adding a mark to
 * {@link ABSENCE_IS_NORMAL} cannot leave a second list disagreeing with it.
 */
const REQUIRED_MARKS: readonly SwitchMark[] = ALL_MARKS.filter((m) => !ABSENCE_IS_NORMAL.has(m))

const REQUIRED_MARKS_WHEN_CACHED: readonly SwitchMark[] = ALL_MARKS.filter(
  (m) => !ABSENCE_IS_NORMAL_WHEN_CACHED.has(m),
)

/**
 * The marks a cache-served switch's `total` may come from — what the owner WAITED
 * for, which is his frame being drawn. The background refresh's marks are still
 * RECORDED when they arrive inside the flush window; they are simply not allowed to
 * inflate the headline number, because he was already reading the screen.
 */
const WAITED_MARKS_WHEN_CACHED: readonly SwitchMark[] = ['vm_published', 'frame_rendered']

export interface SwitchRecord {
  /** Project navigated FROM (`null` = General). */
  readonly from: string | null
  /** Project navigated TO (`null` = General). */
  readonly to: string | null
  /** ms from click to each mark. A missing key means that mark never arrived. */
  readonly marks: Partial<Record<SwitchMark, number>>
  /**
   * ms from click to the last mark the owner WAITED for — the number he feels. For a
   * cache-served switch that is the paint, not the background refresh that followed
   * it; see {@link ABSENCE_IS_NORMAL_WHEN_CACHED}.
   */
  readonly total: number
  /**
   * True when this switch did not finish: a mark whose absence is a failure is
   * missing, OR the owner abandoned it by clicking somewhere else (see
   * {@link superseded}).
   */
  readonly incomplete: boolean
  /**
   * True when the owner clicked a THIRD project before this switch settled, so the
   * record is a partial observation of a switch he walked away from.
   *
   * It is a field rather than an inference because a cache-served switch's only
   * required mark is `vm_published`, which is stamped in the first millisecond — so
   * an abandoned switch reaches "every required mark is in" and, judged on the marks
   * alone, is indistinguishable from a genuinely instant one. Rapid consecutive
   * switches would then enter the sample as complete sub-millisecond switches and
   * pull p50/p90 DOWN — flattering, by construction, the exact metric that is
   * supposed to judge whether switching got faster.
   */
  readonly superseded: boolean
  /**
   * True when the first frame carried the entered topic's transcript from cache, so
   * the owner never waited on the store. It changes which marks are REQUIRED and
   * which may set `total` — and it is on the record, not just used inside the timer,
   * because a reader comparing two samples cannot otherwise tell why one of them
   * stopped at the paint.
   */
  readonly servedFromCache: boolean
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

/**
 * The deadline must exceed the SLOWEST REAL SWITCH, or it truncates exactly the
 * samples the owner filed the complaint about. It was 8000 ms while his own 47
 * samples ran to a max of 9198 ms — so the slowest switches, the only ones that
 * mattered, were flushed as `incomplete` before their last mark could land and
 * were unattributable by construction. Sized off that measurement with room over
 * it; the only cost of waiting longer is how late a genuinely stuck switch is
 * reported, and every mark is an absolute offset from the click, so nothing about
 * the numbers depends on when the record flushes.
 */
const DEFAULT_DEADLINE_MS = 30_000

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
  /** See {@link expectPaint}. While true the record is held open for the paint. */
  private paintExpected = false
  /** See {@link servedFromCache}. Decides which marks are REQUIRED and which may set
   *  `total`, and rides out on the record so the reader can derive the rest; never
   *  changes what is measured, only what it is called. */
  private cached = false
  /** See {@link SwitchRecord.superseded}. Set by {@link supersede} before it flushes. */
  private superseded = false

  constructor(
    private readonly from: string | null,
    private readonly to: string | null,
    opts: SwitchTimingOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now())
    this.emit = opts.emit ?? defaultEmit
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
    this.startedAt = this.now()
    this.timer = this.unrefed(setTimeout(() => this.flush(), this.deadlineMs))
  }

  /**
   * Declare that this switch's FIRST FRAME carried the entered topic's transcript,
   * read from cache rather than awaited from the store.
   *
   * Called by `setProject` before it publishes, because the answer is known there and
   * nowhere else: the timer cannot infer it from the marks — a cache-served switch and
   * a store-served one stamp exactly the same five, in the same order. The difference
   * is only WHAT THE OWNER WAS LOOKING AT while they were stamped, which is a fact
   * about the frame, not about the clock.
   */
  servedFromCache(): void {
    this.cached = true
  }

  /**
   * Declare that a `frame_rendered` stamp HAS BEEN SCHEDULED against a frame that has
   * not been drawn yet, so the record must not settle before it lands.
   *
   * Only the caller can know this. The paint is scheduled from a `requestAnimationFrame`
   * the caller owns, and whether that callback will ever run is a fact about the caller's
   * document (a hidden tab runs no frames), not about any mark. Declared BEFORE the first
   * mark, because a cache-served switch's only required mark is `vm_published` and the
   * record would otherwise be flushed by it, in the same call stack that is about to
   * schedule the paint.
   *
   * Undeclared, the record flushes as soon as its required marks are in and reports
   * `not_painted` — the correct answer when nothing is going to paint. Declared, it waits
   * for the stamp or for the deadline: a wait bounded by the same clock that bounds every
   * other unfinished switch, rather than by a guess about how long a render takes.
   */
  expectPaint(): void {
    this.paintExpected = true
  }

  private get requiredMarks(): readonly SwitchMark[] {
    return this.cached ? REQUIRED_MARKS_WHEN_CACHED : REQUIRED_MARKS
  }

  /**
   * Stamp a mark. The FIRST stamp of each mark wins — a reconnect that fires a
   * second `socket_open` must not overwrite the one the user actually waited for.
   */
  mark(mark: SwitchMark): void {
    if (this.flushed) return
    if (this.marks[mark] !== undefined) return
    this.marks[mark] = round(this.now() - this.startedAt)
    if (!this.requiredMarks.every((m) => this.marks[m] !== undefined)) return
    // Every required mark is in. The paint is the one absence worth waiting on: it
    // necessarily arrives a frame AFTER `transcript`, so flushing here would drop it
    // from every switch. Whether one is coming is the caller's to say
    // ({@link expectPaint}); if it is, the deadline is what bounds the wait, and a
    // slow render can no longer outrun a settle window and be reported as no render
    // at all.
    if (this.marks.frame_rendered !== undefined || !this.paintExpected) this.flush()
  }

  /**
   * Abandon this switch — the user clicked somewhere else. Reports what it had,
   * CARRYING THE CAUSE: an abandoned switch is never `complete`, however many marks
   * it happened to collect before the owner gave up on it. See {@link SwitchRecord.superseded}.
   */
  supersede(): void {
    this.superseded = true
    this.flush()
  }

  /**
   * Emit exactly once, whatever brought us here.
   *
   * `incomplete` is DERIVED rather than passed in by the caller, from exactly two
   * facts the timer owns: a mark whose absence is a failure is missing, or the switch
   * was abandoned. Every flush path (final mark, paint settle, deadline, supersede)
   * then agrees on one definition, and a hidden tab that reached every required mark
   * reports complete instead of the deadline path stamping it a failure because of
   * the clock that woke it.
   *
   * The abandonment half is not decoration. Deriving `incomplete` from the MARKS
   * ALONE silently reclassified every abandoned cache-served switch as complete,
   * because such a switch requires only `vm_published` — so a burst of rapid clicks
   * entered the sample as a run of sub-millisecond successes. A metric that gets
   * better the more the owner gives up on it is worse than no metric.
   */
  private flush(): void {
    if (this.flushed) return
    this.flushed = true
    this.timer = this.cleared(this.timer)
    const waited = this.cached ? WAITED_MARKS_WHEN_CACHED : ALL_MARKS
    const seen = waited.map((m) => this.marks[m]).filter((v): v is number => v !== undefined)
    this.emit({
      from: this.from,
      to: this.to,
      marks: { ...this.marks },
      total: seen.length > 0 ? Math.max(...seen) : 0,
      incomplete:
        this.superseded || this.requiredMarks.some((m) => this.marks[m] === undefined),
      superseded: this.superseded,
      servedFromCache: this.cached,
    })
  }

  /** Never hold the process open for a measurement (node/bun test runners). */
  private unrefed(handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  }

  private cleared(handle: ReturnType<typeof setTimeout> | null): null {
    if (handle !== null) clearTimeout(handle)
    return null
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
  // Only a REQUIRED mark can be missing in the failure sense. Every other absence
  // gets the word for WHY it is absent — a reused socket is `reused`, a hidden tab
  // is `not_painted` — because one symbol for "unnecessary" and "broken" is a lie
  // the reader cannot detect.
  const normal = r.servedFromCache ? ABSENCE_IS_NORMAL_WHEN_CACHED : ABSENCE_IS_NORMAL
  const missing = ALL_MARKS.filter((m) => !normal.has(m) && r.marks[m] === undefined)
  const parts = [
    `to=${r.to ?? 'general'}`,
    `from=${r.from ?? 'general'}`,
    `vm=${fmt(vm)}`,
    `frame=${fmt(r.marks.frame_rendered)}`,
    `socket=${fmt(sock)}`,
    `transcript_read=${fmt(r.marks.transcript_read)}`,
    `transcript=${fmt(tx)}`,
    `total=${fmt(r.total)}`,
  ]
  for (const [mark, reason] of normal) {
    if (r.marks[mark] === undefined) parts.push(`${reason}=${mark}`)
  }
  if (missing.length > 0) parts.push(`never_arrived=${missing.join(',')}`)
  // Named, because `incomplete` alone would read as "this switch broke" for a
  // switch the owner simply walked away from — two very different diagnoses.
  if (r.superseded) parts.push('abandoned=superseded')
  console.info(`[project-switch] ${parts.join(' ')}`)
}

/**
 * Build the persisted perf report without ever accepting or embedding a bearer.
 *
 * `schema: 5` because a REPORTED FIELD CHANGED MEANING — the id moves whenever a
 * definition does, without exception, because a gap in the numbering is free and a
 * collision is a wrong comparison nobody can detect afterwards.
 *
 * v5: `frame_rendered` is now waited for rather than raced against a 250 ms window, so
 * in a v4 sample its ABSENCE means either "nothing painted" or "the render took longer
 * than the window", and those are the slow switches — the population a reader is most
 * likely to be selecting on. Mixing v4 and v5 would compare a paint-time distribution
 * with its own fast tail against one with all of it.
 *
 * v4: `incomplete` now also covers ABANDONED switches. Under v3 an abandoned
 * cache-served switch reported complete (its only required mark is stamped in the
 * first millisecond), so filtering a v3 sample on `incomplete === false` and a v4
 * sample the same way selects different populations — v3's includes clicks the owner
 * gave up on, at sub-millisecond `total`s that drag the percentiles down.
 *
 * v3: `total` stops a CACHE-SERVED switch at the paint instead of at the background
 * refresh that followed it, so a v2 sample and a v3 sample of the identical switch
 * differ by seconds.
 *
 * The v2 rationale, which still holds: It is the largest mark
 * seen, and `frame_rendered` is normally the last one, so a v2 `total` includes
 * the paint where a v1 `total` stopped at `transcript`. The owner has a 47-sample
 * baseline stamped `1`; leaving the id alone would have let the two be averaged
 * together, and the shift would have read as a regression in whatever this change
 * touched. Nothing branches on the number — it exists so a reader can tell which
 * definition a sample was taken under.
 */
export function buildSwitchReport(r: SwitchRecord, createdAt = Date.now()): WebClientReport {
  return {
    schema: 5,
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
      message: r.superseded
        ? 'Project switch abandoned'
        : r.incomplete
          ? 'Project switch incomplete'
          : 'Project switch complete',
      context: {
        from: r.from,
        to: r.to,
        marks: { ...r.marks },
        total: r.total,
        incomplete: r.incomplete,
        superseded: r.superseded,
        served_from_cache: r.servedFromCache,
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
