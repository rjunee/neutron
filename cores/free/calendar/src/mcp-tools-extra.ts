/**
 * @neutronai/calendar-core — four new MCP tools landing with v0.2.0.
 *
 *   calendar_freebusy                — per-attendee busy intervals
 *   calendar_find_time               — proposed slots over freebusy
 *   calendar_invite                  — add attendees + send invites
 *   calendar_send_pre_meeting_brief — Haiku 4.5 composer + audit log
 *
 * Lives alongside `src/tools.ts` (which keeps the existing 5) so a
 * future refactor that drops the legacy 5 leaves this module standing.
 * Both modules contribute to the manifest's `tools[]` declaration —
 * the 9-tool surface is the union.
 *
 * The Core's `buildTools(deps)` entry point in `src/tools.ts` adds
 * these wrappers when the extra-deps bundle is supplied. The runtime
 * composer's `normalizeBackend` for `calendar_core` returns the
 * single `client` field; the optional `cache`, `briefComposer`,
 * `now`, and `postBrief` deps come from a `buildExtraDeps(...)`
 * factory the gateway wires (see § 12 of the brief).
 */

import {
  CapabilityGuard,
  type SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import {
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from './manifest.ts'
import {
  DEFAULT_CALENDAR_ID,
  durationMinutes,
  parseAgenda,
  type BusyInterval,
  type CalendarClient,
  type CalendarEventRow,
  type FindTimeInput,
  type FreeBusyInput,
  type InviteInput,
  type TimeSlot,
} from './backend.ts'
import type {
  CalendarProjectCache,
  PreMeetingBriefOutcome,
} from './cache.ts'
import {
  composePreMeetingBrief,
  type PreMeetingBrief,
} from './pre-meeting-brief.ts'

/* ─── Tool input / output shapes ──────────────────────────────────── */

export interface CalendarFreebusyToolInput extends FreeBusyInput {}
export interface CalendarFreebusyToolOutput {
  per_attendee: BusyInterval[][]
}

export interface CalendarFindTimeToolInput extends FindTimeInput {}
export interface CalendarFindTimeToolOutput {
  slots: TimeSlot[]
}

export interface CalendarInviteToolInput extends InviteInput {}
export interface CalendarInviteToolOutput {
  event: CalendarEventRow
}

export interface CalendarSendPreMeetingBriefToolInput {
  event_id: string
  calendar_id?: string
  project_id: string
  lead_minutes?: number
  dry_run?: boolean
}

export interface CalendarSendPreMeetingBriefToolOutput {
  brief: PreMeetingBrief
  posted_chat_message_id: string | null
}

export interface ExtraToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  client: CalendarClient
  /**
   * Optional per-project cache resolver — when supplied, brief fires
   * write audit rows + the chat-command surface refreshes the cache
   * after writes. When omitted (Forge minimal-boot path), audit rows
   * are simply not written.
   */
  cacheFor?: (project_id: string) => Promise<CalendarProjectCache | null>
  /**
   * Pluggable LLM call. Production wires the @neutronai/runtime fast-
   * model dispatcher; tests inject a deterministic stub. When
   * omitted, the brief composer falls back to the deterministic
   * `llm_error` shape (the structured row rendered as bullets).
   */
  llm?: (prompt: string) => Promise<string>
  /**
   * Model id stamped onto the brief metadata + audit row. Defaults to
   * `'claude-haiku-fallback'` when omitted; production passes
   * `runtime/models.ts:FAST_MODEL`.
   */
  modelId?: string
  /** Per-project prior-context resolver. v1: optional; when omitted
   *  the brief composes with empty prior_context. */
  resolvePriorContext?: (input: {
    project_id: string
    attendees: readonly string[]
  }) => Promise<readonly string[]>
  /** Owner tz, used by the brief composer's start-time formatter.
   *  Defaults to `America/Los_Angeles`. */
  userTz?: string
  /** Posts a composed brief to the project's chat surface. Returns
   *  the channel-side message id (null = no live channel). v1: when
   *  omitted, briefs compose but never post (audit row reflects
   *  `'no_post_target'`). */
  postBrief?: (input: {
    project_id: string
    text: string
    event: CalendarEventRow
  }) => Promise<{ chat_message_id: string | null }>
  /** Clock override (tests). */
  now?: () => number
}

export interface ExtraTools {
  calendar_freebusy: (
    input: CalendarFreebusyToolInput,
  ) => Promise<CalendarFreebusyToolOutput>
  calendar_find_time: (
    input: CalendarFindTimeToolInput,
  ) => Promise<CalendarFindTimeToolOutput>
  calendar_invite: (
    input: CalendarInviteToolInput,
  ) => Promise<CalendarInviteToolOutput>
  calendar_send_pre_meeting_brief: (
    input: CalendarSendPreMeetingBriefToolInput,
  ) => Promise<CalendarSendPreMeetingBriefToolOutput>
}

const FALLBACK_MODEL_ID = 'claude-haiku-fallback'

/** Default failing `llm` that triggers the deterministic fallback. */
const FAILING_LLM = async (): Promise<string> => {
  throw new Error('no llm wired')
}

/**
 * Construct the four S1 extra MCP tools. Each is wrapped by the
 * Sprint 31 `CapabilityGuard.wrapToolHandler` so every dispatch is
 * audited.
 */
export function buildExtraTools(deps: ExtraToolDeps): ExtraTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const now = deps.now ?? ((): number => Date.now())
  const userTz = deps.userTz ?? 'America/Los_Angeles'
  const modelId = deps.modelId ?? FALLBACK_MODEL_ID
  const llm = deps.llm ?? FAILING_LLM

  const calendar_freebusy = guard.wrapToolHandler<
    CalendarFreebusyToolInput,
    CalendarFreebusyToolOutput
  >({
    tool_name: 'calendar_freebusy',
    capability_required: READ_CAPABILITY,
    fn: async (input) => {
      const per_attendee = await deps.client.freebusy(input)
      return { per_attendee }
    },
  })

  const calendar_find_time = guard.wrapToolHandler<
    CalendarFindTimeToolInput,
    CalendarFindTimeToolOutput
  >({
    tool_name: 'calendar_find_time',
    capability_required: READ_CAPABILITY,
    fn: async (input) => {
      const slots = await deps.client.findTime(input)
      return { slots }
    },
  })

  const calendar_invite = guard.wrapToolHandler<
    CalendarInviteToolInput,
    CalendarInviteToolOutput
  >({
    tool_name: 'calendar_invite',
    capability_required: WRITE_CAPABILITY,
    fn: async (input) => {
      const event = await deps.client.invite(input)
      return { event }
    },
  })

  const calendar_send_pre_meeting_brief = guard.wrapToolHandler<
    CalendarSendPreMeetingBriefToolInput,
    CalendarSendPreMeetingBriefToolOutput
  >({
    tool_name: 'calendar_send_pre_meeting_brief',
    capability_required: READ_CAPABILITY,
    fn: async (input) => {
      const calendar_id = input.calendar_id ?? DEFAULT_CALENDAR_ID
      const event = await deps.client.get({
        event_id: input.event_id,
        calendar_id,
      })
      const briefRowAttendees = event.attendees ?? []
      const priorContext =
        deps.resolvePriorContext !== undefined
          ? await deps.resolvePriorContext({
              project_id: input.project_id,
              attendees: briefRowAttendees,
            })
          : []
      const brief = await composePreMeetingBrief({
        briefRow: {
          event_id: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          duration_minutes: durationMinutes(event.start, event.end),
          attendees: briefRowAttendees,
          agenda: parseAgenda(event.description),
          prior_context: [...priorContext],
        },
        priorContext,
        userTz,
        ...(input.lead_minutes !== undefined ? { leadMinutes: input.lead_minutes } : {}),
        modelId,
        llm,
      })

      const dry_run = input.dry_run ?? false
      let posted_chat_message_id: string | null = null
      let outcome: PreMeetingBriefOutcome
      if (brief.outcome === 'llm_error') {
        outcome = 'llm_error'
      } else if (dry_run) {
        outcome = 'ok'
      } else if (deps.postBrief === undefined) {
        outcome = 'no_post_target'
      } else {
        try {
          const posted = await deps.postBrief({
            project_id: input.project_id,
            text: brief.text,
            event,
          })
          posted_chat_message_id = posted.chat_message_id
          outcome = 'ok'
        } catch {
          outcome = 'no_post_target'
        }
      }

      // Record the audit row when the cache resolver is wired.
      if (deps.cacheFor !== undefined) {
        try {
          const cache = await deps.cacheFor(input.project_id)
          if (cache !== null) {
            cache.recordBriefFire({
              calendar_id,
              event_id: event.id,
              fired_at: now(),
              model: brief.model,
              outcome,
              prompt_hash: brief.prompt_hash,
              response_excerpt: brief.text.slice(0, 240),
              chat_message_id: posted_chat_message_id,
            })
          }
        } catch {
          // best-effort
        }
      }

      return { brief, posted_chat_message_id }
    },
  })

  return {
    calendar_freebusy,
    calendar_find_time,
    calendar_invite,
    calendar_send_pre_meeting_brief,
  }
}
