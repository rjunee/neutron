/**
 * @neutronai/gateway/cores — Calendar Core S1 production-boot wiring helpers.
 *
 * Argus r2 (2026-05-20) — extracted from `gateway/index.ts` so the
 * production-composer reachability test can construct the same
 * dispatcher / scheduler-deps shapes the gateway boot does, without
 * hand-rolling them in the test (the anti-pattern that caused
 * r1 BLOCKER #1 to slip past the existing test suite).
 *
 * Two exports:
 *
 *   1. `buildCalendarChatCommandDispatcher(deps)` — pure factory that
 *      wraps `parseCalCommand` + `executeCalCommand` into a
 *      `ChatCommandDispatcher` the app-ws surface pre-checks BEFORE
 *      forwarding to the LLM path. The boot block + the test both
 *      call this — identity of the returned shape is the regression
 *      guard.
 *
 *   2. `buildCalendarPreMeetingBriefSchedulerDeps(deps)` — pure
 *      factory that bundles the `cacheFor` + `listProjects` +
 *      `fire` callbacks the `buildPreMeetingBriefScheduler` consumes.
 *      The fire callback composes the brief via
 *      `composePreMeetingBrief` + posts via the supplied
 *      `PushDispatcher.pushAll` (the same surface Reminders Core's
 *      `on_fired` hook uses).
 *
 * No side effects — neither factory opens DB handles, schedules
 * timers, or mounts adapters. The boot path threads the resulting
 * objects into `createAppWsSurface` + `buildPreMeetingBriefScheduler`
 * respectively; the test threads them through the same call sites.
 */

import { mkdirSync } from 'node:fs'
import { join as joinPath } from 'node:path'

import type {
  CalCommandContext,
  CalendarClient,
  CalendarProjectCache,
  PreMeetingBriefFireInput,
  PreMeetingBriefOutcome,
  PreMeetingBriefQueueStore,
  PreMeetingBriefSchedulerOpts,
} from '@neutronai/calendar-core'
import {
  SqlitePreMeetingBriefQueueStore,
  composePreMeetingBrief,
  durationMinutes,
  executeCalCommand,
  openCalendarProjectCache,
  parseAgenda,
  parseCalCommand,
} from '@neutronai/calendar-core'

import { composeCalendarPayload } from '@neutronai/scribe/index.ts'
import type { ScribeFanOut } from './scribe-fan-out.ts'

import type {
  ChatCommandFilter,
  ChatCommandFilterResult,
} from '../http/app-ws-surface.ts'
import type { PushDispatcher } from '../push/dispatcher.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('calendar-core')

export interface CalendarChatCommandDispatcherDeps {
  client: CalendarClient
  cacheFor: (project_id: string) => Promise<CalendarProjectCache | null>
  /** Clock override (tests). */
  now?: () => Date
  /** User timezone for the executor's date formatter. Defaults to
   *  `America/Los_Angeles` to match Sam's locale. */
  userTz?: string
}

/**
 * Build the `/cal` chat-command filter. Pure — invoking
 * `match(...)` is the only thing that touches the calendar
 * client.
 *
 * Conforms to the shared `ChatCommandFilter` shape (see
 * `gateway/http/app-ws-surface.ts`) so the boot wiring composes this
 * filter alongside Notes / Reminders / Email-Managed via
 * `buildChainedChatCommandFilter`.
 */
export function buildCalendarChatCommandDispatcher(
  deps: CalendarChatCommandDispatcherDeps,
): ChatCommandFilter {
  const now = deps.now ?? ((): Date => new Date())
  const userTz = deps.userTz ?? 'America/Los_Angeles'
  return {
    async match(input: {
      user_id: string
      project_slug: string
      channel_topic_id: string
      project_id?: string
      body: string
    }): Promise<ChatCommandFilterResult | null> {
      const trimmed = input.body.trim()
      if (!trimmed.startsWith('/cal')) return null
      const parsed = parseCalCommand(trimmed, now())
      if (parsed.kind === 'unrecognized') return null
      const cache = input.project_id !== undefined
        ? await deps.cacheFor(input.project_id).catch(() => null)
        : null
      const ctx: CalCommandContext = {
        client: deps.client,
        now: now(),
        user_tz: userTz,
        ...(cache !== null ? { cache } : {}),
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        ...(input.user_id.length > 0 ? { user_id: input.user_id } : {}),
      }
      const response = await executeCalCommand(parsed, ctx)
      const result: ChatCommandFilterResult = { text: response.text }
      if (response.data !== undefined) result.data = response.data
      if (response.deep_link !== undefined) result.deep_link = response.deep_link
      return result
    },
  }
}

/**
 * Build the production pre-meeting-brief queue store (ISSUE #16).
 * Hands the gateway boot a `SqlitePreMeetingBriefQueueStore` instance
 * keyed to the same `<owner_home>/Projects/<id>/calendar/` sidecar
 * the `CalendarProjectCache` resolver uses. Caller owns `closeAll()`
 * — register it against `realmode_cleanups` to release per-project
 * DB handles at SIGTERM.
 */
export function buildCalendarPreMeetingBriefQueueStore(
  owner_home: string,
): {
  store: SqlitePreMeetingBriefQueueStore
  closeAll: () => void
} {
  const store = new SqlitePreMeetingBriefQueueStore({ owner_home })
  return {
    store,
    closeAll: (): void => store.closeAll(),
  }
}

/**
 * Open + cache per-project Calendar Core sidecars under
 * `<owner_home>/Projects/<id>/calendar/`. Caller owns close() —
 * register `close()` calls against `realmode_cleanups` to tear
 * handles down at SIGTERM.
 */
export function buildCalendarCacheResolver(
  owner_home: string,
): {
  cacheFor: (project_id: string) => Promise<CalendarProjectCache>
  closeAll: () => void
} {
  const caches = new Map<string, CalendarProjectCache>()
  return {
    async cacheFor(project_id: string): Promise<CalendarProjectCache> {
      const cached = caches.get(project_id)
      if (cached !== undefined) return cached
      const dir = joinPath(owner_home, 'Projects', project_id, 'calendar')
      mkdirSync(dir, { recursive: true })
      const cache = openCalendarProjectCache({ dir, project_id })
      caches.set(project_id, cache)
      return cache
    },
    closeAll(): void {
      for (const cache of caches.values()) {
        try {
          cache.close()
        } catch {
          // best-effort shutdown
        }
      }
      caches.clear()
    },
  }
}

export interface CalendarPreMeetingBriefSchedulerDepsInput {
  project_slug: string
  client: CalendarClient
  cacheFor: (project_id: string) => Promise<CalendarProjectCache>
  /** Sync project enumerator — pass `defaultEnumerateProjects(owner_home)`. */
  enumerateProjects: () => Promise<string[]>
  /** Optional push dispatcher. When `null`, brief composes + audit
   *  rows still write but no chat post happens (audit outcome:
   *  `'no_post_target'`). */
  pushDispatcher: PushDispatcher | null
  /** Durable queue store (ISSUE #16) — pass a
   *  `SqlitePreMeetingBriefQueueStore` constructed against the same
   *  owner_home as `cacheFor`. The scheduler re-walks this store on
   *  boot so a gateway restart doesn't silently drop fires whose lead
   *  window passed mid-restart. */
  queueStore: PreMeetingBriefQueueStore
  /** Brief composer LLM. Defaults to a failing stub which routes the
   *  composer into its deterministic `llm_error` fallback (the
   *  structured row rendered as bullets). The Haiku 4.5 dispatcher
   *  binding is deferred to a later sprint. */
  llm?: (prompt: string) => Promise<string>
  modelId?: string
  userTz?: string
  /**
   * Scribe phase-2 fan-out (optional). When bound, each fired event's
   * already-fetched `CalendarEventRow` rides into scribe's extract→GBrain path
   * (`trigger:'calendar'`, source `gcal:<id>`). Fire-and-forget — never blocks
   * or breaks the brief path. `undefined` when scribe is not live (owner has no
   * Anthropic credentials), so calendar briefs behave exactly as before.
   */
  scribeFanOut?: ScribeFanOut
}

/**
 * Build the `PreMeetingBriefSchedulerOpts` bundle the scheduler
 * consumes. The fire callback composes the brief + posts via the
 * supplied `PushDispatcher.pushAll` + records an audit row in the
 * per-project sidecar.
 */
export function buildCalendarPreMeetingBriefSchedulerDeps(
  input: CalendarPreMeetingBriefSchedulerDepsInput,
): PreMeetingBriefSchedulerOpts {
  const modelId = input.modelId ?? 'claude-haiku-fallback'
  const userTz = input.userTz ?? 'America/Los_Angeles'
  const llm = input.llm ?? (async (): Promise<string> => {
    throw new Error('no llm wired')
  })
  return {
    client: input.client,
    cacheFor: input.cacheFor,
    queueStore: input.queueStore,
    listProjects: async (): Promise<readonly { project_id: string }[]> => {
      const ids = await input.enumerateProjects()
      return ids.map((project_id) => ({ project_id }))
    },
    fire: async (fireInput: PreMeetingBriefFireInput): Promise<void> => {
      const { event, project_id } = fireInput
      try {
        const cache = await input.cacheFor(project_id).catch(() => null)
        const brief = await composePreMeetingBrief({
          briefRow: {
            event_id: event.id,
            title: event.title,
            start: event.start,
            end: event.end,
            duration_minutes: durationMinutes(event.start, event.end),
            attendees: event.attendees ?? [],
            agenda: parseAgenda(event.description),
            prior_context: [],
          },
          priorContext: [],
          userTz,
          modelId,
          llm,
        })
        let chat_message_id: string | null = null
        if (input.pushDispatcher !== null) {
          try {
            const pushed = await input.pushDispatcher.pushAll(input.project_slug, {
              title: `Pre-meeting brief: ${event.title}`,
              body: brief.text,
              data: {
                kind: 'calendar_pre_meeting_brief',
                event_id: event.id,
                project_id,
                project_slug: input.project_slug,
              },
            })
            if (pushed.ok && pushed.attempted > 0) {
              chat_message_id = `push:${event.id}`
            }
          } catch {
            // best-effort — audit row records the failure shape.
          }
        }
        const outcome: PreMeetingBriefOutcome =
          brief.outcome === 'llm_error'
            ? 'llm_error'
            : chat_message_id !== null
              ? 'ok'
              : 'no_post_target'
        if (cache !== null) {
          try {
            cache.recordBriefFire({
              calendar_id: event.calendar_id,
              event_id: event.id,
              fired_at: Date.now(),
              model: brief.model,
              outcome,
              prompt_hash: brief.prompt_hash,
              response_excerpt: brief.text.slice(0, 240),
              chat_message_id,
            })
          } catch {
            // best-effort
          }
        }
      } catch (err) {
        moduleLog.warn('pre_meeting_brief_fire_failed', {
          instance: input.project_slug,
          project: project_id,
          event: event.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Scribe phase-2 ride-along: hand the SAME already-fetched event row to
      // scribe's extract→GBrain path. Runs after the brief regardless of brief
      // outcome (the event data is valid even if the brief LLM failed). Fire-
      // and-forget — `scribeFanOut` swallows its own errors; no second fetch,
      // no new timer (the Core's scheduler tick IS the only cadence).
      input.scribeFanOut?.(
        'calendar',
        composeCalendarPayload(event),
        `gcal:${event.id}`,
      )
    },
  }
}
