/**
 * @neutronai/calendar-core — public barrel.
 *
 * Tier 1 free Calendar Core. Production surface (v0.2.0):
 *
 *   9 MCP tools — list / create / update / cancel / brief (existing 5)
 *     + freebusy / find_time / invite / send_pre_meeting_brief (S1).
 *   5 chat commands — `/cal show`, `/cal create`, `/cal find-time`,
 *     `/cal next`, `/cal invite`. Pure parser + dispatcher under
 *     `src/chat-commands.ts`; gateway pre-checks for `/cal` before
 *     LLM dispatch.
 *   Pre-meeting-brief LLM agent (Haiku 4.5) fires PRE_MEETING_LEAD_MS
 *     before each upcoming meeting via a per-Core timer-wheel
 *     scheduler. Composes a 3-6-sentence brief over the structured
 *     `calendar_brief` row + prior_context bullets sourced from
 *     Notes / Tasks lookups against the attendee set.
 *   Per-project SQLite sidecar at `<OWNER_HOME>/Projects/<id>/
 *     calendar/calendar.db` — fast-render cache for the launcher tile
 *     + durable audit log of every pre-meeting-brief fire.
 *   Production Google v3 REST client wired through
 *     `gateway/cores/oauth-token-manager.ts:OAuthTokenManager.getAccessToken`
 *     for transparent access-token refresh. Falls back to the
 *     in-memory client when the Cores OAuth surface is unmounted
 *     (Open self-host without envs, Managed before the owner's OAuth client
 *     setup lands).
 *   Per-project event filtering via the
 *     `extendedProperties.private.neutron_project_id` Google API
 *     filter (`/cal show today` inside project A returns only A-tagged
 *     events; `calendar_list` MCP-tool dispatch with `project_id`
 *     mirrors the same scope).
 *
 * Cross-refs:
 *   - docs/plans/calendar-core-tier1-brief.md (the spec this Core ships)
 *   - SPEC.md § Phases→Steps (Tier 1 Cores buildout; TODO(K10): root SPEC.md not yet in this repo)
 *   - docs/research/neutron-cores-marketplace-split-2026-05-17.md (2-tier model)
 *   - cores/sdk/SDK-CONTRACT.md (the API surface this Core consumes)
 *   - gateway/cores/oauth-token-manager.ts (OAuth substrate this Core depends on)
 */

export const __MODULE__ = '@neutronai/calendar-core' as const

export {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  OAUTH_SECRET_LABEL,
  PROJECT_ID_EXTENDED_PROPERTY,
  READ_CAPABILITY,
  TOOL_NAMES,
  WRITE_CAPABILITY,
  loadManifest,
  type CalendarToolName,
} from './src/manifest.ts'

export {
  DEFAULT_CALENDAR_ID,
  DEFAULT_LIST_LIMIT,
  EventNotFoundError,
  GoogleCalendarApiError,
  OAuthMissingError,
  buildGoogleCalendarClient,
  buildInMemoryCalendarClient,
  durationMinutes,
  parseAgenda,
  type BusyInterval,
  type CalendarCancelInput,
  type CalendarClient,
  type CalendarCreateInput,
  type CalendarEventRow,
  type CalendarEventStatus,
  type CalendarGetInput,
  type CalendarListInput,
  type CalendarUpdateFields,
  type CalendarUpdateInput,
  type FetchLike,
  type FindTimeInput,
  type FreeBusyInput,
  type GoogleCalendarClientOptions,
  type InviteInput,
  type TimeSlot,
} from './src/backend.ts'

export {
  buildTools,
  type BuiltTools,
  type CalendarBriefToolInput,
  type CalendarBriefToolOutput,
  type CalendarCancelToolInput,
  type CalendarCancelToolOutput,
  type CalendarCreateToolInput,
  type CalendarCreateToolOutput,
  type CalendarListToolInput,
  type CalendarListToolOutput,
  type CalendarUpdateToolInput,
  type CalendarUpdateToolOutput,
  type ToolDeps,
} from './src/tools.ts'

export {
  buildExtraTools,
  type CalendarFindTimeToolInput,
  type CalendarFindTimeToolOutput,
  type CalendarFreebusyToolInput,
  type CalendarFreebusyToolOutput,
  type CalendarInviteToolInput,
  type CalendarInviteToolOutput,
  type CalendarSendPreMeetingBriefToolInput,
  type CalendarSendPreMeetingBriefToolOutput,
  type ExtraToolDeps,
  type ExtraTools,
} from './src/mcp-tools-extra.ts'

export {
  executeCalCommand,
  parseAndExecuteCalCommand,
  parseCalCommand,
  type CalCommand,
  type CalCommandContext,
  type CalCommandErrorCode,
  type CalCommandResponse,
} from './src/chat-commands.ts'

export {
  PRE_MEETING_BRIEF_PROMPT_TEMPLATE,
  composePreMeetingBrief,
  renderBriefPrompt,
  type PreMeetingBrief,
  type PreMeetingBriefDeps,
  type PreMeetingBriefOutcome as PreMeetingBriefComposerOutcome,
} from './src/pre-meeting-brief.ts'

export {
  PRE_MEETING_LEAD_MS,
  PRE_MEETING_LOOKAHEAD_MS,
  PRE_MEETING_TICK_MS,
  buildPreMeetingBriefScheduler,
  type PreMeetingBriefFireInput,
  type PreMeetingBriefScheduler,
  type PreMeetingBriefSchedulerOpts,
  type TimerHandle,
} from './src/pre-meeting-brief-scheduler.ts'

export {
  InMemoryPreMeetingBriefQueueStore,
  SqlitePreMeetingBriefQueueStore,
  type PreMeetingBriefQueueRow,
  type PreMeetingBriefQueueStatus,
  type PreMeetingBriefQueueStore,
  type SqlitePreMeetingBriefQueueStoreOptions,
  type UpsertPendingInput,
} from './src/pre-meeting-brief-queue-store.ts'

export {
  DEFAULT_GRANULARITY_MINUTES,
  DEFAULT_MAX_SLOTS,
  DEFAULT_PREFERRED_HOURS,
  findFreeSlots,
  mergeIntervals,
  type FindFreeSlotsInput,
} from './src/free-busy.ts'

export {
  CALENDAR_DB,
  CALENDAR_DIR,
  CALENDAR_SCHEMA_VERSION,
  CalendarSidecarMismatchError,
  DEFAULT_CACHE_TTL_MS,
  openCalendarProjectCache,
  type BriefAuditRow,
  type CachedEventRow,
  type CalendarProjectCache,
  type ListEventsWindow,
  type OpenCalendarProjectCacheInput,
  type PreMeetingBriefOutcome,
  type RecordBriefFireInput,
} from './src/cache.ts'

export { LAUNCHER_ICON, type LauncherIconMeta } from './src/ui/launcher-icon.ts'
export { APP_TAB_META, type AppTabMeta } from './src/ui/app-tab-surface.ts'

// ── X2: typed Core module contract ──────────────────────────────────────
// The ONE declaration the install composer (`gateway/cores/install-bundled.ts`)
// reads instead of duck-typing barrel exports + a hardcoded backend-key table.
// `backendKey` is the `ToolDeps` key a bare backend primitive maps onto; when
// the backend factory returns an already-shaped object it is passed through
// verbatim. Conformance: cores/runtime/__tests__/define-core-conformance.test.ts.
import { defineCore } from '@neutronai/cores-sdk'
import { CORE_SLUG as CORE_SLUG_X2, TOOL_NAMES as TOOL_NAMES_X2 } from './src/manifest.ts'
import { buildTools as buildTools_X2 } from './src/tools.ts'

// NOTE: no `buildExtraTools` here — Calendar's `buildTools` ALREADY invokes
// `buildExtraTools` internally and returns the full 9-tool surface
// (`src/tools.ts`: `BuiltTools extends ExtraTools`, merges `...extras`). Wiring
// the extra factory a second time here would just re-run it and collide on
// every install. Tasks, by contrast, keeps its separate `buildExtraTools`
// because its `buildTools` only adds `tasks_pick_next` when a `pickNext` dep is
// wired — the extra factory is the coverage fallback when it isn't.
export const core = defineCore({
  slug: CORE_SLUG_X2,
  backendKey: 'client',
  toolNames: TOOL_NAMES_X2,
  buildTools: buildTools_X2,
})
