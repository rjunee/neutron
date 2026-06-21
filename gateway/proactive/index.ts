/**
 * @neutronai/gateway/proactive — public barrel.
 *
 * The proactive messaging layer (gap-audit P0-5): a real daily morning brief
 * and an idle-topic nudge sweep that POST to chat, closing Neutron's
 * "only speaks when spoken to" gap. Both reuse the existing cron registry +
 * the P6 nudge ranker and post through the channel-agnostic `OutboundSink`.
 */

export const __MODULE__ = '@neutronai/gateway/proactive' as const

export {
  type OutboundSink,
  type OutgoingMessage,
  type Topic,
  proactiveTopic,
} from './sink.ts'
export { ProactiveStateStore, type ProactiveTopicState } from './state-store.ts'
export {
  DEFAULT_BRIEF_HOUR,
  DEFAULT_BRIEF_INTERVAL_MS,
  DEFAULT_OWNER_TIMEZONE,
  composeMorningBrief,
  gatherBriefContext,
  ownerLocalHour,
  runMorningBrief,
  type BriefCalendarEvent,
  type BriefContext,
  type BriefEntityDelta,
  type BriefFocusItem,
  type BriefProjectStatus,
  type MorningBriefDeps,
  type MorningBriefResult,
  type ProactiveContextSources,
} from './morning-brief.ts'
export {
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  composeNudge,
  evaluateNudgeGate,
  readTodayPick,
  runIdleNudgeSweep,
  type IdleNudgeSweepDeps,
  type IdleNudgeSweepResult,
  type NudgeSkipReason,
  type ProactiveTopicCandidate,
  type TodayPick,
} from './idle-nudge-sweep.ts'
export {
  IDLE_NUDGE_SWEEP_HANDLER_NAME,
  MORNING_BRIEF_HANDLER_NAME,
  buildIdleNudgeSweepHandler,
  buildIdleNudgeSweepJob,
  buildMorningBriefHandler,
  buildMorningBriefJob,
  registerIdleNudgeSweepCron,
  registerMorningBriefCron,
} from './cron.ts'
