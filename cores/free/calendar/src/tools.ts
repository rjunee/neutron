/**
 * @neutronai/calendar-core — capability-guarded MCP tool wiring.
 *
 * Five tools the manifest declares (calendar_list / calendar_create /
 * calendar_update / calendar_cancel / calendar_brief). Each is wrapped
 * by the Sprint 31 `CapabilityGuard.wrapToolHandler` so every dispatch
 * records an audit row + rejects with `CapabilityDeniedError` when the
 * manifest doesn't declare the matching capability.
 *
 * The runtime composer registers `buildTools(deps)` output with the MCP
 * host at install time; for tests, the helpers are directly callable.
 * Capability strings are imported from `manifest.ts` so a stray edit to
 * the manifest body that drifts from the locked
 * `read:/write:calendar_core.events` pair surfaces as a tool-mismatch
 * the guard rejects at the first dispatch.
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
  type CalendarClient,
  type CalendarCreateInput,
  type CalendarEventRow,
  type CalendarListInput,
  type CalendarUpdateFields,
} from './backend.ts'
import {
  buildExtraTools,
  type ExtraToolDeps,
  type ExtraTools,
} from './mcp-tools-extra.ts'

export interface CalendarListToolInput extends CalendarListInput {}

export interface CalendarListToolOutput {
  results: CalendarEventRow[]
}

export interface CalendarCreateToolInput extends CalendarCreateInput {}

export interface CalendarCreateToolOutput {
  id: string
  event: CalendarEventRow
}

export interface CalendarUpdateToolInput {
  event_id: string
  calendar_id?: string
  fields: CalendarUpdateFields
}

export interface CalendarUpdateToolOutput {
  event: CalendarEventRow
}

export interface CalendarCancelToolInput {
  event_id: string
  calendar_id?: string
}

export interface CalendarCancelToolOutput {
  ok: true
  event_id: string
}

export interface CalendarBriefToolInput {
  event_id: string
  calendar_id?: string
}

/**
 * Pre-meeting brief shape. The v1 surface is deliberately small:
 * everything except `prior_context` is derived directly from the
 * event row; `prior_context` is a stub array (empty v1) that future
 * sprints will populate by querying Notes / GBrain / Tasks for
 * prior interactions with the attendee set or matching keywords.
 *
 * The brief is intentionally NOT an LLM-synthesised free-form summary
 * — that would require Claude / GPT plumbing the Tier 1 Core
 * deliberately avoids. A separate `calendar_brief_llm` tool (Tier 2
 * Calendar-Private variant or follow-up sprint) can layer LLM
 * synthesis on top of this structured output.
 */
export interface CalendarBriefToolOutput {
  brief: {
    event_id: string
    title: string
    start: string
    end: string
    duration_minutes: number
    attendees: string[]
    agenda: string[]
    prior_context: string[]
  }
}

export type { CalendarEventRow } from './backend.ts'

/**
 * Bundle of dependencies the tools dispatch against. The runtime
 * composer (P3+) constructs this at install time and passes it into
 * `buildTools` — tests pass mocks directly.
 */
export interface ToolDeps {
  manifest: NeutronManifest
  project_slug: string
  audit: SecretAuditLog
  client: CalendarClient
  /**
   * Optional extras bundle the gateway wires when the per-project
   * cache + chat-bridge are available. When omitted the 4 new tools
   * (calendar_freebusy / calendar_find_time / calendar_invite /
   * calendar_send_pre_meeting_brief) still register against the
   * `client` directly — only the audit log + chat post path stay
   * unwired in that mode.
   */
  extras?: Omit<ExtraToolDeps, 'manifest' | 'project_slug' | 'audit' | 'client'>
}

export interface BuiltTools extends ExtraTools {
  calendar_list: (input: CalendarListToolInput) => Promise<CalendarListToolOutput>
  calendar_create: (input: CalendarCreateToolInput) => Promise<CalendarCreateToolOutput>
  calendar_update: (input: CalendarUpdateToolInput) => Promise<CalendarUpdateToolOutput>
  calendar_cancel: (input: CalendarCancelToolInput) => Promise<CalendarCancelToolOutput>
  calendar_brief: (input: CalendarBriefToolInput) => Promise<CalendarBriefToolOutput>
}

/**
 * Construct the five tool handlers, each wrapped by the Sprint 31
 * `CapabilityGuard.wrapToolHandler` so every dispatch is audited.
 *
 * The capability strings match the manifest's `tools[]` declarations
 * exactly — wrapping with a different `capability_required` value trips
 * the guard's `capability_mismatch` check at the FIRST call.
 */
export function buildTools(deps: ToolDeps): BuiltTools {
  const guard = new CapabilityGuard({
    manifest: deps.manifest,
    core_slug: CORE_SLUG,
    owner_slug: deps.project_slug,
    audit: deps.audit,
  })

  const calendar_list = guard.wrapToolHandler<CalendarListToolInput, CalendarListToolOutput>({
    tool_name: 'calendar_list',
    capability_required: READ_CAPABILITY,
    fn: async (input: CalendarListToolInput): Promise<CalendarListToolOutput> => {
      const results = await deps.client.list(input)
      return { results }
    },
  })

  const calendar_create = guard.wrapToolHandler<CalendarCreateToolInput, CalendarCreateToolOutput>({
    tool_name: 'calendar_create',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: CalendarCreateToolInput): Promise<CalendarCreateToolOutput> => {
      const event = await deps.client.create(input)
      return { id: event.id, event }
    },
  })

  const calendar_update = guard.wrapToolHandler<CalendarUpdateToolInput, CalendarUpdateToolOutput>({
    tool_name: 'calendar_update',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: CalendarUpdateToolInput): Promise<CalendarUpdateToolOutput> => {
      const event = await deps.client.update({
        event_id: input.event_id,
        fields: input.fields,
        ...(input.calendar_id !== undefined ? { calendar_id: input.calendar_id } : {}),
      })
      return { event }
    },
  })

  const calendar_cancel = guard.wrapToolHandler<CalendarCancelToolInput, CalendarCancelToolOutput>({
    tool_name: 'calendar_cancel',
    capability_required: WRITE_CAPABILITY,
    fn: async (input: CalendarCancelToolInput): Promise<CalendarCancelToolOutput> => {
      await deps.client.cancel({
        event_id: input.event_id,
        ...(input.calendar_id !== undefined ? { calendar_id: input.calendar_id } : {}),
      })
      return { ok: true, event_id: input.event_id }
    },
  })

  const calendar_brief = guard.wrapToolHandler<CalendarBriefToolInput, CalendarBriefToolOutput>({
    tool_name: 'calendar_brief',
    capability_required: READ_CAPABILITY,
    fn: async (input: CalendarBriefToolInput): Promise<CalendarBriefToolOutput> => {
      const event = await deps.client.get({
        event_id: input.event_id,
        ...(input.calendar_id !== undefined ? { calendar_id: input.calendar_id } : {}),
      })
      return {
        brief: {
          event_id: event.id,
          title: event.title,
          start: event.start,
          end: event.end,
          duration_minutes: durationMinutes(event.start, event.end),
          attendees: event.attendees ?? [],
          agenda: parseAgenda(event.description),
          // Stub v1 — full context-pulling lands in a follow-up sprint
          // that wires Notes / Tasks / GBrain lookups by attendee +
          // keyword. The empty array is a structural placeholder so the
          // tool's output schema doesn't change once the lookup ships.
          prior_context: [],
        },
      }
    },
  })

  // Touch DEFAULT_CALENDAR_ID so it's a real import — the wrapper
  // intentionally lets the backend default; this keeps the constant
  // exported for downstream callers and the lint-pass happy.
  void DEFAULT_CALENDAR_ID

  const extras = buildExtraTools({
    manifest: deps.manifest,
    project_slug: deps.project_slug,
    audit: deps.audit,
    client: deps.client,
    ...(deps.extras ?? {}),
  })

  return {
    calendar_list,
    calendar_create,
    calendar_update,
    calendar_cancel,
    calendar_brief,
    ...extras,
  }
}
