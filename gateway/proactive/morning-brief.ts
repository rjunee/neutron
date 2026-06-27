/**
 * @neutronai/gateway/proactive — the REAL daily morning brief.
 *
 * Closes gap-audit P0-5 (first half). Neutron's prior "morning brief"
 * (`onboarding/overnight/morning-brief.ts`) reports ONLY the overnight
 * Trident completions and ONLY fires when something ran overnight. This is
 * the Vajra-parity daily brief: it composes from whatever live context is
 * available — today's calendar, the focus/task queue, recent entity/memory
 * deltas, project STATUS — and POSTS it on a schedule, EVERY owner-local day,
 * regardless of overnight activity.
 *
 * Design:
 *   • Context sources are injected as INDEPENDENT, OPTIONAL async providers
 *     (`ProactiveContextSources`). Each is gathered behind its own try/catch
 *     so a single unavailable/throwing source (no calendar credential, GBrain
 *     down, …) degrades to "that section omitted" rather than killing the
 *     brief. Open default wires the focus-queue source from the local
 *     TaskStore; calendar/entities layer in when the host supplies them.
 *   • `composeMorningBrief` is PURE — sections in, body out — so the exact
 *     copy is unit-testable in isolation.
 *   • Same-day idempotency lives in `proactive_brief_log` (the handler ticks
 *     frequently; it posts at most one brief per owner-local day), so a
 *     gateway restart mid-morning cannot double-post.
 *   • Posting goes through the channel-agnostic `OutboundSink` (the
 *     production `ChannelRouter`), exactly like trident async-delivery.
 *
 * It NEVER invents data: an empty section is dropped; a fully-quiet day
 * yields a short honest brief rather than a fabricated one.
 */

import { resolveOwnerDay } from '../tasks/p6/nudge-engine.ts'
import { proactiveTopic, type OutboundSink, type Topic } from './sink.ts'
import { ProactiveStateStore } from './state-store.ts'

export const DEFAULT_OWNER_TIMEZONE = 'America/Los_Angeles'

/** Default morning-brief tick cadence — every 30 min; posts once/local day. */
export const DEFAULT_BRIEF_INTERVAL_MS = 30 * 60 * 1000

/** Default owner-local hour (24h) at/after which the brief may post. */
export const DEFAULT_BRIEF_HOUR = 7

/** A single calendar event for today. */
export interface BriefCalendarEvent {
  /** Local time label, e.g. "09:30" or "all-day". */
  when: string
  title: string
}

/** A single focus/task-queue line. */
export interface BriefFocusItem {
  title: string
  /** Optional project label for multi-project owners. */
  project?: string | null
  /** Optional due-date label, e.g. "due today". */
  due?: string | null
}

/** A recent entity/memory delta (new or updated wiki entry). */
export interface BriefEntityDelta {
  /** e.g. "person", "company", "concept". */
  kind: string
  name: string
}

/** A project STATUS line (one-line current state). */
export interface BriefProjectStatus {
  project: string
  status: string
}

/**
 * The assembled, already-resolved context for one brief. Every field is
 * optional; the composer renders only the sections that resolved to a
 * non-empty value.
 */
export interface BriefContext {
  calendar?: BriefCalendarEvent[]
  focus?: BriefFocusItem[]
  entities?: BriefEntityDelta[]
  projects?: BriefProjectStatus[]
  /**
   * Whether the calendar source actually ran and returned (even empty).
   * `true` ⟺ a `calendarToday` provider was wired AND it resolved without
   * throwing — so an empty calendar is a CONFIRMED-empty day. `false`/absent
   * means the calendar was never checked (no provider, or it threw): the
   * quiet-day copy must NOT then claim "nothing on the calendar" (#320).
   */
  calendar_checked?: boolean
}

/**
 * Optional, independent context providers. Each may be absent (source not
 * wired) and each is invoked behind its own try/catch — a throw or rejection
 * degrades to that section being omitted, never a failed brief.
 */
export interface ProactiveContextSources {
  calendarToday?(day: string): Promise<BriefCalendarEvent[]>
  focusQueue?(): Promise<BriefFocusItem[]>
  entityDeltas?(): Promise<BriefEntityDelta[]>
  projectStatus?(): Promise<BriefProjectStatus[]>
}

/**
 * Gather all available context. Each source is awaited independently and
 * failures are swallowed (logged) so the brief composes from whatever
 * succeeded. Returns a `BriefContext` with only the sections that produced
 * a non-empty array.
 */
export async function gatherBriefContext(
  sources: ProactiveContextSources,
  day: string,
  log?: (msg: string) => void,
): Promise<BriefContext> {
  const ctx: BriefContext = {}
  const calendar = await safeSource(() => sources.calendarToday?.(day), 'calendar', log)
  // `safeSource` returns null when the provider is absent (returned undefined)
  // OR threw — both mean "calendar not checked." A non-null result (possibly
  // an empty array) means the calendar was actually consulted, so an empty day
  // is CONFIRMED empty rather than merely unchecked (#320).
  if (calendar !== null) {
    ctx.calendar_checked = true
    if (calendar.length > 0) ctx.calendar = calendar
  }
  const focus = await safeSource(() => sources.focusQueue?.(), 'focus', log)
  if (focus !== null && focus.length > 0) ctx.focus = focus
  const entities = await safeSource(() => sources.entityDeltas?.(), 'entities', log)
  if (entities !== null && entities.length > 0) ctx.entities = entities
  const projects = await safeSource(() => sources.projectStatus?.(), 'projects', log)
  if (projects !== null && projects.length > 0) ctx.projects = projects
  return ctx
}

async function safeSource<T>(
  fn: () => Promise<T[]> | undefined,
  name: string,
  log?: (msg: string) => void,
): Promise<T[] | null> {
  try {
    const out = fn()
    if (out === undefined) return null
    return await out
  } catch (err) {
    log?.(`[proactive] morning-brief source '${name}' failed: ${err}`)
    return null
  }
}

/**
 * Compose the brief body. PURE. Renders one section per non-empty context
 * field; a fully-empty context yields a short honest "quiet day" note (never
 * a fabricated section). `day` heads the brief.
 */
export function composeMorningBrief(ctx: BriefContext, day: string): string {
  const lines: string[] = [`Morning brief — ${day}`]

  const hasAny =
    (ctx.calendar?.length ?? 0) > 0 ||
    (ctx.focus?.length ?? 0) > 0 ||
    (ctx.entities?.length ?? 0) > 0 ||
    (ctx.projects?.length ?? 0) > 0

  if (!hasAny) {
    lines.push('')
    // Only claim the calendar is clear when it was actually checked (#320).
    // If the calendar source is unwired or threw, say so honestly rather than
    // over-claiming "nothing on the calendar."
    if (ctx.calendar_checked === true) {
      lines.push('Nothing on the calendar and no open focus items — a clear day.')
    } else {
      lines.push("No open focus items — a clear day. (I couldn't check your calendar.)")
    }
    return lines.join('\n')
  }

  if (ctx.calendar !== undefined && ctx.calendar.length > 0) {
    lines.push('')
    lines.push(`📅 Today (${ctx.calendar.length})`)
    for (const e of ctx.calendar) lines.push(`- ${e.when} — ${e.title}`)
  }

  if (ctx.focus !== undefined && ctx.focus.length > 0) {
    lines.push('')
    lines.push(`🎯 Focus (${ctx.focus.length})`)
    for (const f of ctx.focus) {
      const meta: string[] = []
      if (f.project !== undefined && f.project !== null && f.project.length > 0) {
        meta.push(f.project)
      }
      if (f.due !== undefined && f.due !== null && f.due.length > 0) meta.push(f.due)
      const suffix = meta.length > 0 ? ` (${meta.join(', ')})` : ''
      lines.push(`- ${f.title}${suffix}`)
    }
  }

  if (ctx.projects !== undefined && ctx.projects.length > 0) {
    lines.push('')
    lines.push(`📂 Projects (${ctx.projects.length})`)
    for (const p of ctx.projects) lines.push(`- ${p.project}: ${p.status}`)
  }

  if (ctx.entities !== undefined && ctx.entities.length > 0) {
    lines.push('')
    lines.push(`🧠 Recently learned (${ctx.entities.length})`)
    for (const e of ctx.entities) lines.push(`- ${e.name} (${e.kind})`)
  }

  return lines.join('\n')
}

/**
 * Minimal LLM seam (structurally the onboarding `LlmCallFn`): a single
 * Anthropic-Messages turn. Kept local so this module does not import the
 * onboarding resolver; production passes the same warm-substrate call it
 * uses for the nudge engine / wow picker.
 */
export type ProactiveLlm = (input: {
  system: string
  user: string
  max_tokens: number
}) => Promise<string>

/**
 * Compose the brief body from the resolved context. Production routes this
 * through the warm LLM (`buildLlmBriefComposer`); the pure `composeMorningBrief`
 * template is the deterministic fallback when no LLM is wired or it fails.
 */
export type BriefComposer = (ctx: BriefContext, day: string) => Promise<string>

/** System prompt for the LLM brief — lifts Vajra's morning-brief intent
 *  (`~/vajra/prompts/morning-brief.md`): structured, <20 lines, evidence-only,
 *  no fabrication, no filler. */
export const LLM_BRIEF_SYSTEM = [
  "You are Neutron's morning brief agent. Compose a short daily brief from the",
  'structured context provided — and ONLY that context. Hard rules:',
  '- NEVER invent events, tasks, or facts not present in the context.',
  '- Keep it under 20 lines. Lead with what matters today.',
  '- If a section is empty, omit it. If everything is empty, say it is a clear',
  '  day in one honest line (do not claim the calendar is clear unless it was',
  '  actually checked).',
  '- Plain, direct voice. No preamble, no sign-off, no filler.',
].join('\n')

/**
 * Build an LLM-backed brief composer. Renders the resolved `BriefContext`
 * (the SAME structured sections the pure composer uses, so the model never
 * sees anything the deterministic path wouldn't) into a user message and asks
 * the warm LLM to write the brief. The caller (`runMorningBrief`) falls back
 * to the pure template if this throws or returns empty — the LLM is an
 * enrichment, never a single point of failure.
 */
export function buildLlmBriefComposer(
  llm: ProactiveLlm,
  opts: { max_tokens?: number } = {},
): BriefComposer {
  const maxTokens = opts.max_tokens ?? 700
  return async (ctx: BriefContext, day: string): Promise<string> => {
    // Reuse the pure composer to render the evidence block — it already drops
    // empty sections and never fabricates — then ask the LLM to turn that
    // evidence into the brief. This guarantees the model is grounded in
    // exactly the resolved context, nothing more.
    const evidence = composeMorningBrief(ctx, day)
    const user = [
      `Day: ${day}`,
      '',
      'Structured context (the only evidence — do not add anything beyond it):',
      evidence,
      '',
      'Write the morning brief now.',
    ].join('\n')
    const out = await llm({ system: LLM_BRIEF_SYSTEM, user, max_tokens: maxTokens })
    return typeof out === 'string' ? out.trim() : ''
  }
}

/** Owner-local hour (0–23) for `nowMs` in `tz`. */
export function ownerLocalHour(nowMs: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  })
  const h = Number(fmt.format(new Date(nowMs)))
  // en-GB renders midnight as '24' on some ICU builds — normalize.
  return h === 24 ? 0 : h
}

export interface MorningBriefDeps {
  store: ProactiveStateStore
  sources: ProactiveContextSources
  sink: OutboundSink
  /** The General/main topic the brief posts to (channel_topic_id). */
  general_topic_id: string
  channel_kind?: Topic['channel_kind']
  now(): number
  tz?: string
  /** Owner-local hour at/after which the brief may post. Default 7. */
  brief_hour?: number
  /**
   * Optional LLM composer. When supplied, the brief body is written by the
   * warm LLM over the resolved context (`buildLlmBriefComposer`); on a throw
   * or empty result the pure `composeMorningBrief` template is used instead.
   * Absent → the deterministic template (unchanged default).
   */
  composeWithLlm?: BriefComposer
  log?(msg: string): void
}

export interface MorningBriefResult {
  /**
   * `deliver_failed` is distinct from `too_early` (#320): a delivery outage
   * must surface in cron telemetry as an ERROR, not be folded into the benign
   * `too_early`/`skipped` bucket where outages would go unnoticed. The cron
   * handler maps `deliver_failed` → `error` and every other status → ok/skipped.
   */
  status: 'posted' | 'already_posted' | 'too_early' | 'deliver_failed'
  day: string
  /** Length of the composed body (0 when nothing posted). */
  body_length: number
}

/**
 * Run one morning-brief tick. Posts at most one brief per owner-local day,
 * at/after `brief_hour`. Returns a structured result; never throws (a deliver
 * failure logs + records nothing so the next tick retries).
 */
export async function runMorningBrief(deps: MorningBriefDeps): Promise<MorningBriefResult> {
  const tz = deps.tz ?? DEFAULT_OWNER_TIMEZONE
  const briefHour = deps.brief_hour ?? DEFAULT_BRIEF_HOUR
  const nowMs = deps.now()
  const day = resolveOwnerDay(nowMs, tz)

  if (deps.store.hasBriefForDay(day)) {
    return { status: 'already_posted', day, body_length: 0 }
  }
  if (ownerLocalHour(nowMs, tz) < briefHour) {
    return { status: 'too_early', day, body_length: 0 }
  }

  const ctx = await gatherBriefContext(deps.sources, day, deps.log)
  // Prefer the LLM composition over real sources (Vajra parity); the pure
  // template is the deterministic fallback when no LLM is wired or it fails
  // — the brief must never be lost to an LLM hiccup.
  let body = ''
  if (deps.composeWithLlm !== undefined) {
    try {
      const llmBody = await deps.composeWithLlm(ctx, day)
      if (typeof llmBody === 'string' && llmBody.trim().length > 0) body = llmBody.trim()
    } catch (err) {
      deps.log?.(`[proactive] morning-brief LLM compose failed, using template: ${err}`)
    }
  }
  if (body.length === 0) body = composeMorningBrief(ctx, day)

  const topic = proactiveTopic(deps.general_topic_id, deps.channel_kind ?? 'telegram')
  try {
    await deps.sink.send({ topic, text: body })
  } catch (err) {
    deps.log?.(`[proactive] morning-brief deliver failed: ${err}`)
    // Do NOT record the day — let the next tick retry. Return `deliver_failed`
    // (NOT `too_early`) so the cron handler surfaces the outage as an error in
    // telemetry instead of silently mapping it to `skipped` (#320).
    return { status: 'deliver_failed', day, body_length: 0 }
  }

  await deps.store.recordBriefForDay(day, new Date(nowMs).toISOString(), deps.general_topic_id)
  return { status: 'posted', day, body_length: body.length }
}
