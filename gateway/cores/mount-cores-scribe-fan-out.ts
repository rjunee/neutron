/**
 * @neutronai/gateway/cores — mount the scribe phase-2 Cores→scribe fan-out.
 *
 * Gap #1 (Vajra→Neutron parity, 2026-06-25 scan §5.1): the `scribeFanOut` seam
 * is fully built — `gateway/cores/calendar-wiring.ts` +
 * `gateway/cores/email-managed-wiring.ts` accept a `scribeFanOut?` and call it
 * inside their scheduler `fire` callbacks (with the already-fetched, flattened
 * Core row) — but NOTHING threads it in production: pre-this-module the only
 * references to `scribeFanOut` / `extractFromCoresSource` were `__tests__`. So
 * per-Core ambient memory extraction (calendar events / inbox mail → GBrain) was
 * DEAD. Chat-turn extraction (`scribe.handleUserTurn`) was the only live path.
 *
 * This module closes that wire on the single-owner **Open** boot path (the
 * daily-driver path — the Managed composer was split out-of-repo at the C2 OSS
 * split, 2026-06-10). It does two things:
 *
 *   1. `buildScribeCoresFanOut(scribe)` — the composer-owned BINDING the
 *      scribe-fan-out.ts docblock specifies: it converts the scribe's awaitable
 *      `extractFromCoresSource(...)` into the `void`-returning `ScribeFanOut`
 *      shape the Cores' fire callbacks expect, fire-and-forget + error-swallowing
 *      so a failed extraction never throws into a Core's brief/triage path. It
 *      also exposes `idle()` (awaits all in-flight extractions) so shutdown can
 *      drain cleanly and tests can assert the extraction reached the writer.
 *
 *   2. `mountCoresScribeFanOut(input)` — CONSTRUCTS the fan-out (the binding from
 *      (1)) WITHOUT starting anything, and returns a LATE-BOUND handle exposing
 *      `arm(clients)`. `arm` composes the Calendar pre-meeting-brief scheduler +
 *      the Email daily-triage scheduler (the two Cores that own the fan-out seam)
 *      from the live Google clients, threads the binding, and starts them; its
 *      `stop()` drains in-flight extractions then tears the schedulers + handles
 *      down. Each scheduler owns its own self-tick (no external loop, no new
 *      poller — preserving the "no duplicate poller" invariant the phase-2
 *      static tests guard).
 *
 * WHY LATE-BINDING (the reflectLoop precedent): the schedulers need the live
 * OAuth-backed `CalendarClient` / `GmailClient`, but those are built by
 * `mountOpenCores` ~100 lines AFTER `wireMemory` constructs this fan-out. So —
 * exactly as `reflectLoop` is constructed early + its cleanup registered early
 * but its `start()` deferred to the end of composition — `wireMemory` calls
 * `mountCoresScribeFanOut` (construct + register `stop()` cleanup) and the
 * composer calls `arm({ calendarClient, gmailClient })` once `mountOpenCores`
 * exists. `arm` is failure-atomic (a throw mid-arm tears down what it started)
 * and `stop()` is a safe no-op before `arm`, so a composition failure between
 * construction and the arm can never leak a started scheduler.
 *
 * Credentials / graceful degradation: `mountOpenCores` builds the OAuth-backed
 * `CalendarClient` / `GmailClient` when the owner has connected Google, and its
 * in-memory fallback clients otherwise (the SAME instances the `calendar_core` /
 * `email_managed_core` MCP tools + `/cal` + `/email` filters use). `arm` always
 * receives a real client instance; with the in-memory fallback the schedulers
 * run harmlessly against an empty calendar/inbox and fan out nothing — the
 * moment a Google-backed client is supplied, real events/mail flow into GBrain
 * with no further wiring. The composer only mounts this when scribe is live (it
 * has no extraction target otherwise), so LLM-less boxes are completely
 * unaffected.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CalendarClient, PreMeetingBriefScheduler, TimerHandle } from '@neutronai/calendar-core'
import { buildPreMeetingBriefScheduler } from '@neutronai/calendar-core'
import type { GmailClient, TriageScheduler } from '@neutronai/email-managed-core'
import {
  EmailProjectCacheResolver,
  buildTriageScheduler,
} from '@neutronai/email-managed-core'

import type { Scribe } from '@neutronai/scribe/index.ts'
import {
  buildCalendarCacheResolver,
  buildCalendarPreMeetingBriefQueueStore,
  buildCalendarPreMeetingBriefSchedulerDeps,
} from './calendar-wiring.ts'
import {
  buildEmailTriageSchedulerDeps,
  fileScribeEmailWatermark,
} from './email-managed-wiring.ts'
import type { ScribeFanOut } from './scribe-fan-out.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('cores-scribe-fanout')

/**
 * The composer-owned scribe fan-out binding (see module docblock §1). Wraps the
 * scribe's awaitable Cores-source entry into the fire-and-forget `ScribeFanOut`
 * the Cores expect, and tracks in-flight extractions so `idle()` can drain them.
 */
export interface ScribeCoresFanOut {
  /** The `void`-returning hook threaded into each Core's `fire` callback. */
  readonly fanOut: ScribeFanOut
  /** Resolve once every extraction started so far has settled. */
  idle(): Promise<void>
}

/**
 * Bind `scribe.extractFromCoresSource` into a `ScribeFanOut`. Fire-and-forget by
 * contract: the returned `fanOut` returns `void`, never throws (the binding
 * swallows extraction errors — the scribe's own path also catches, this is the
 * last-resort backstop), and never blocks the calling Core. Only the
 * `extractFromCoresSource` capability is needed, so the parameter is narrowed.
 */
export function buildScribeCoresFanOut(
  scribe: Pick<Scribe, 'extractFromCoresSource'>,
  logFailure: (msg: string, err: unknown) => void = defaultLogFailure,
): ScribeCoresFanOut {
  const inflight = new Set<Promise<unknown>>()
  const fanOut: ScribeFanOut = (trigger, text, source): void => {
    // Pass the RAW extraction promise through the wrapper so a rejection is
    // counted + structured-logged by fireAndForget (F3); the contextual log
    // rides the onError callback. (A prior `.catch(() => log)` here swallowed
    // the rejection into a resolved `p` before the wrapper — invisible to the
    // counter; see the F3 pre-swallow gate.)
    const p = scribe.extractFromCoresSource({ trigger, text, source })
    inflight.add(p)
    fireAndForget(
      'mount-cores-scribe-fan-out',
      p.finally(() => inflight.delete(p)),
      (err) => logFailure('cores fan-out extraction failed', err),
    )
  }
  return {
    fanOut,
    async idle(): Promise<void> {
      // Snapshot + await; a settling extraction can spawn no further fan-outs,
      // so one drain pass is sufficient.
      await Promise.allSettled([...inflight])
    },
  }
}

/** Default Open-local project enumerator: the `<owner_home>/Projects/<id>` dirs.
 *  Best-effort — a missing/unreadable Projects dir yields an empty list (the
 *  schedulers simply enqueue nothing) rather than throwing into boot. */
export function enumerateOwnerProjects(owner_home: string): string[] {
  try {
    return readdirSync(join(owner_home, 'Projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export interface MountCoresScribeFanOutInput {
  /** The live scribe instance (composer guarantees non-null when mounting). */
  scribe: Pick<Scribe, 'extractFromCoresSource'>
  /** Instance slug — provenance + audit keying. */
  project_slug: string
  /** Per-owner data dir (`<owner_home>`): caches, queue store, watermark live here. */
  owner_home: string
  /** Haiku-fast triage LLM. Defaults to a failing stub → deterministic
   *  `llm_error` triage fallback (the structured row rendered as bullets). */
  emailLlm?: (prompt: string) => Promise<string>
  /** Resolved Haiku-fast model id (audit provenance). */
  emailModel?: string
  /** User-local tz for the daily-fire boundary. Defaults to America/Los_Angeles. */
  userTz?: string
  /** Clock (epoch-ms) override — tests inject; production uses the wall clock. */
  nowMs?: () => number
  /** Timer factory override — tests drive deterministically; production uses setTimeout. */
  scheduleTimer?: (fn: () => void, delay_ms: number) => TimerHandle
  /** Failure log sink. Defaults to console.warn. */
  logFailure?: (msg: string, err: unknown) => void
}

/**
 * The live Google clients threaded in at ARM time (post-`mountOpenCores`). When
 * Google is unconnected these are `mountOpenCores`' in-memory fallbacks — the
 * schedulers then run against an empty calendar/inbox and fan out nothing.
 */
export interface ArmCoresScribeFanOutInput {
  /** The SAME calendar client the `calendar_core` tools + `/cal` filter use. */
  calendarClient: CalendarClient
  /** The SAME gmail client the `email_managed_core` tools + `/email` filter use. */
  gmailClient: GmailClient
}

export interface MountedCoresScribeFanOut {
  /**
   * Build both schedulers from the live Google clients and START them. Call
   * EXACTLY ONCE, AFTER `mountOpenCores` has built the clients. Failure-atomic:
   * if constructing/starting a scheduler throws, everything started so far is
   * torn down (async, best-effort) before the throw propagates, so a composition
   * failure never leaks a running scheduler. A second `arm()` throws (guard).
   */
  arm(clients: ArmCoresScribeFanOutInput): void
  /** The started calendar scheduler; `null` until `arm()` runs. */
  readonly calendarScheduler: PreMeetingBriefScheduler | null
  /** The started email scheduler; `null` until `arm()` runs. */
  readonly emailScheduler: TriageScheduler | null
  /** Await all in-flight fan-out extractions (shutdown drain + test sync). */
  idle(): Promise<void>
  /** Stop both schedulers (no-op before `arm`), drain in-flight extractions, close handles. */
  stop(): Promise<void>
}

/**
 * CONSTRUCT the Calendar + Email scheduled-Core fan-out into scribe (the binding
 * only — NOTHING is started here). See the module docblock for the full
 * late-binding contract. Returns a handle whose `arm(clients)` builds + starts
 * the two schedulers once the live Google clients exist, and whose `stop()` is
 * registered against `realmode_cleanups` at construction time (safe no-op until
 * armed).
 */
export function mountCoresScribeFanOut(
  input: MountCoresScribeFanOutInput,
): MountedCoresScribeFanOut {
  const logFailure = input.logFailure ?? defaultLogFailure
  const binding = buildScribeCoresFanOut(input.scribe, logFailure)

  // Late-bound armed state — the schedulers do not exist until arm() runs.
  let armed = false
  let stopped = false
  let calendarScheduler: PreMeetingBriefScheduler | null = null
  let emailScheduler: TriageScheduler | null = null
  let startCalendar: Promise<void> | null = null
  let startEmail: Promise<void> | null = null
  // Sync close()rs (caches + queue store) collected as they are opened, so a
  // failed arm() or a stop() releases exactly what was acquired, in order.
  const closers: Array<() => void> = []

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    // BOTH `start()`s awaited before `stop()`: the initial tick's `fire()` →
    // `scribeFanOut(...)` queues its extraction into the binding's in-flight set
    // BEFORE `start()` resolves, so awaiting the start promise then draining
    // `binding.idle()` guarantees no fan-out extraction runs (or touches a closed
    // handle) AFTER teardown — closing Codex r1 P2 (shutdown racing the initial
    // fire tick).
    try {
      if (startCalendar !== null) await startCalendar
      if (calendarScheduler !== null) await calendarScheduler.stop()
    } catch (err) {
      logFailure('calendar scheduler stop failed', err)
    }
    try {
      if (startEmail !== null) await startEmail
      if (emailScheduler !== null) await emailScheduler.stop()
    } catch (err) {
      logFailure('email scheduler stop failed', err)
    }
    // Both initial ticks have settled (their fan-outs are queued); drain all
    // in-flight extractions before releasing the write handles.
    await binding.idle()
    for (const close of closers.splice(0)) {
      try {
        close()
      } catch {
        // best-effort
      }
    }
  }

  function arm(clients: ArmCoresScribeFanOutInput): void {
    if (armed) throw new Error('mountCoresScribeFanOut: arm() called more than once')
    armed = true
    try {
      // ── Calendar: pre-meeting-brief scheduler ──────────────────────────────
      const calCache = buildCalendarCacheResolver(input.owner_home)
      closers.push(() => calCache.closeAll())
      const calQueue = buildCalendarPreMeetingBriefQueueStore(input.owner_home)
      closers.push(() => calQueue.closeAll())
      const calDeps = buildCalendarPreMeetingBriefSchedulerDeps({
        project_slug: input.project_slug,
        client: clients.calendarClient,
        cacheFor: calCache.cacheFor,
        enumerateProjects: async (): Promise<string[]> =>
          enumerateOwnerProjects(input.owner_home),
        pushDispatcher: null,
        queueStore: calQueue.store,
        ...(input.userTz !== undefined ? { userTz: input.userTz } : {}),
        scribeFanOut: binding.fanOut,
      })
      calendarScheduler = buildPreMeetingBriefScheduler({
        ...calDeps,
        ...(input.nowMs !== undefined ? { now: input.nowMs } : {}),
        ...(input.scheduleTimer !== undefined ? { scheduleTimer: input.scheduleTimer } : {}),
      })

      // ── Email: daily-triage scheduler ──────────────────────────────────────
      const emailCache = new EmailProjectCacheResolver({ owner_home: input.owner_home })
      closers.push(() => emailCache.closeAll())
      const emailLlm =
        input.emailLlm ??
        (async (): Promise<string> => {
          throw new Error('no email triage llm wired')
        })
      const emailDeps = buildEmailTriageSchedulerDeps({
        project_slug: input.project_slug,
        client: clients.gmailClient,
        cacheFor: (project_id: string) => emailCache.resolve(project_id),
        // Single-owner Open: fan the first active project (General), or 'general'
        // when the Projects dir is empty (nothing to triage yet — fire no-ops).
        targetProjectId: async (): Promise<string> =>
          enumerateOwnerProjects(input.owner_home)[0] ?? 'general',
        llm: emailLlm,
        model: input.emailModel ?? 'claude-haiku-fallback',
        ...(input.userTz !== undefined ? { userTz: input.userTz } : {}),
        pushDispatcher: null,
        scribeFanOut: binding.fanOut,
        scribeWatermark: fileScribeEmailWatermark(
          join(input.owner_home, '.scribe-email-watermark.json'),
        ),
      })
      emailScheduler = buildTriageScheduler({
        ...emailDeps,
        ...(input.nowMs !== undefined ? { now: () => new Date(input.nowMs!()) } : {}),
        ...(input.scheduleTimer !== undefined ? { scheduleTimer: input.scheduleTimer } : {}),
      })

      // Start both. BOTH `start()`s are async and AWAIT their initial tick before
      // arming the recurring self-tick (calendar re-walks the durable queue; email
      // runs one immediate tick so a (re)start during the daily fire minute doesn't
      // miss the window). We retain BOTH start promises so `stop()` can await them.
      startCalendar = calendarScheduler.start().catch((err: unknown) => {
        logFailure('calendar scheduler start failed', err)
      })
      startEmail = emailScheduler.start().catch((err: unknown) => {
        logFailure('email scheduler start failed', err)
      })
    } catch (err) {
      // Failure-atomic: a synchronous throw while building/starting either
      // scheduler must not leak the one that DID start (mirrors reflectLoop's
      // `catch { await stop(); throw }`). Tear down (best-effort, async) then
      // propagate so the composer sees the failure.
      fireAndForget('mount-cores-scribe-fan-out.arm-abort', stop())
      throw err
    }
  }

  return {
    arm,
    get calendarScheduler(): PreMeetingBriefScheduler | null {
      return calendarScheduler
    },
    get emailScheduler(): TriageScheduler | null {
      return emailScheduler
    },
    idle: () => binding.idle(),
    stop,
  }
}

function defaultLogFailure(msg: string, err: unknown): void {
  moduleLog.warn(msg, { error: err instanceof Error ? err.message : String(err) })
}
