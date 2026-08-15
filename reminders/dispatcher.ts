/**
 * @neutronai/reminders — the real fire-time `ReminderDispatcher`.
 *
 * Before this module, `reminders/tick.ts` fired on schedule but delegated
 * composition to a `ReminderDispatcher` interface that Open never implemented
 * — the Open composer passed `{ dispatch: async () => undefined }`, so a due
 * reminder advanced its row and posted NOTHING. This is the missing seam.
 *
 * At fire time `dispatch(reminder)`:
 *   1. classifies the stored `message` into its shape (literal / smart-wrap /
 *      pattern — `message-shape.ts`);
 *   2. resolves the destination topic (the reminder's own `topic_id`, else a
 *      `[ROUTING]` header, else the General fallback);
 *   3. composes the body — when an LLM seam is wired it gathers live context
 *      and dispatches a Haiku-class composition turn (`prompt.ts`); on ANY
 *      failure (no LLM, timeout, empty reply, thrown error) it degrades to the
 *      shape's literal fallback so a reminder ALWAYS delivers something real;
 *   4. posts the composed body to the topic via the injected `ReminderOutbound`.
 *
 * Mirrors `gateway/wiring/build-live-agent-turn.ts`: CC-spawn
 * substrate only (NEVER a direct api.anthropic.com call), per-dispatch
 * `metering_context.project_id` keying, a wall-clock timeout around the turn.
 */

import { FAST_MODEL } from '@neutronai/runtime/models.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { ToolDef } from '@neutronai/cores-sdk/manifest'
import { collectTokensToString } from '@neutronai/runtime/collect-tokens.ts'
import { classifyReminderMessage, literalFallback, type ReminderShape } from './message-shape.ts'
import { buildReminderPrompt } from './prompt.ts'
import type { Reminder } from './store.ts'
import type { ReminderDispatcher } from './tick.ts'
import { RITUAL_TIMEOUT_MS } from './rituals.ts'
import {
  formatRitualUnplannableNotice,
  RITUAL_MAX_TOKENS,
  type RitualFireDecision,
  type RitualFirePlan,
  type RitualFirePlanner,
} from './ritual-fire.ts'
import { createLogger } from '@neutronai/logger'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'

const dispatcherLog = createLogger('reminder-dispatcher')

/** Where a composed reminder body is posted. */
export interface ReminderOutboundInput {
  topic_id: string
  owner_slug: string
  body: string
  reminder_id: string
}

export interface ReminderOutbound {
  /** Deliver one composed reminder to a topic. Returns true when accepted. */
  post(input: ReminderOutboundInput): boolean | Promise<boolean>
}

/** Gathers live context (calendar / STATUS / project state) for a fire. */
export interface ReminderContextSource {
  /**
   * `project_id` is the DESTINATION project the reminder composes against
   * (see {@link deriveReminderProjectId}) — NOT the instance `owner_slug`.
   * The source uses it to locate the right project's state (e.g. STATUS.md).
   */
  gather(reminder: Reminder, project_id: string): string | Promise<string>
}

/**
 * Derive the DESTINATION project id a reminder composes against from its
 * stored `topic_id`. For project reminders the engine stores the destination
 * project in `topic_id` (Reminders Core persists the raw `project_id`; the app
 * surface persists `app-project:<project_id>`; an already-web-shaped topic is
 * `web:<user_id>:<project_id>`), while `owner_slug` is the FIXED instance /
 * owner slug. Keying context + metering off `owner_slug` reads the wrong
 * project's STATUS.md and meters every project reminder to the owner — this
 * bridges to the actual destination, mirroring `resolveTopicId` in
 * `open/composer.ts`.
 *
 * `null` / empty topic, or a General `web:<user_id>` topic with no project
 * segment, → the instance slug (`owner_slug`), preserving instance-level
 * behaviour. A `[ROUTING]` header is a thread destination, not a project, so
 * it is deliberately NOT consulted here (only `reminder.topic_id` is).
 *
 * THE APP'S GENERAL SCOPE IS INSTANCE-LEVEL TOO, which is the third spelling of
 * the same case. `app-project:~general` is the no-project scope on the app
 * reminders surface (`gateway/http/app-reminders-surface.ts`
 * `resolveScopeSegment`) — a scope, not a project — so it resolves to
 * `owner_slug` exactly as its `web:<user_id>` twin above does. Without this it
 * would resolve to the literal `~general` and the context source would go
 * looking for `<owner_home>/Projects/~general/STATUS.md`, a directory that
 * cannot exist because `~` is not a legal project id.
 */
export function deriveReminderProjectId(reminder: Reminder): string {
  const topic = reminder.topic_id
  if (topic === null || topic.trim().length === 0) return reminder.owner_slug
  if (topic.startsWith('app-project:')) {
    const id = topic.slice('app-project:'.length)
    if (id === GENERAL_RAIL_ID) return reminder.owner_slug
    return id.length > 0 ? id : reminder.owner_slug
  }
  if (topic.startsWith('web:')) {
    // `web:<user_id>` (General) → instance; `web:<user_id>:<project_id>` → project.
    const sep = topic.indexOf(':', 'web:'.length)
    if (sep < 0) return reminder.owner_slug
    const id = topic.slice(sep + 1)
    return id.length > 0 ? id : reminder.owner_slug
  }
  // Raw engine destination = the project_id itself (Reminders Core path).
  return topic
}

/**
 * Maps a reminder's stored destination to the surface's actual topic key.
 * The stored `topic_id` is engine-shaped (the Reminders Core persists the raw
 * `project_id`, or `null` for instance-level reminders) and does NOT match the
 * surface's routing key (Open's web chat routes on `web:<user_id>` /
 * `web:<user_id>:<project_id>`). The composer injects a resolver that bridges
 * the two; without one the dispatcher uses the explicit topic verbatim (the
 * Telegram-style behaviour, and what tests assert against).
 */
export interface ReminderTopicResolver {
  /**
   * `explicit_topic` is the reminder's `topic_id`, else a `[ROUTING]` header,
   * else `null` (no destination specified — resolve to the surface's General).
   */
  (ctx: { reminder: Reminder; explicit_topic: string | null }): string
}

/**
 * The fire-time composition seam. Production wraps the warm CC substrate via
 * `buildSubstrateReminderLlm`; tests inject a deterministic fake. `null`/absent
 * → the dispatcher composes nothing and posts the literal degrade body.
 *
 * `timeout_ms` overrides the seam's construction default for THIS turn. A ritual
 * needs a far wider budget than a nudge (`RITUAL_TIMEOUT_MS`), and
 * both compose through this one seam, so the budget travels with the call rather
 * than forcing a second seam instance.
 */
export interface ReminderLlm {
  compose(spec: AgentSpec, opts?: { timeout_ms?: number }): Promise<string>
}

/**
 * Tool surface for a fire-time composition turn.
 *
 * ⚠️ THIS MUST MATCH THE OWNER'S LIVE-CHAT SURFACE, and matching it is not a
 * style choice — it is what makes a fired reminder land ON the owner's warm
 * session instead of destroying it. The persistent-REPL reuse guard compares the
 * requested `--tools` surface against the one the warm child was spawned with and,
 * on a mismatch, EVICTS the child and respawns it
 * (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`). This dispatcher
 * composes on `liveAgentSubstrate` — the SAME substrate the live chat uses, and
 * the only one carrying the native-MCP tool bridge — so a narrower surface here
 * would tear down the owner's chat REPL on every fire, and his next chat turn
 * would tear it down again.
 *
 * So the production composition passes the live-agent surface explicitly (the
 * composer threads `tool_names`), and this default exists only for callers with
 * no live-chat substrate at all, where there is no warm child to thrash.
 */
const DEFAULT_TOOL_NAMES = ['Read', 'Glob', 'Grep'] as const

/** Per-composition wall-clock budget before the substrate handle is cancelled. */
const DEFAULT_TIMEOUT_MS = 90_000

/** Upper bound on a composed nudge — a few sentences, never an essay. */
const DEFAULT_MAX_TOKENS = 512

/**
 * Wrap a warm CC substrate into the `ReminderLlm` composition seam. Spawns the
 * turn, collects tokens with an abort-on-timeout guard, returns the text.
 * Throws on timeout / substrate error so the dispatcher degrades to literal.
 */
export function buildSubstrateReminderLlm(
  substrate: Substrate,
  opts: { timeout_ms?: number } = {},
): ReminderLlm {
  const default_timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  return {
    async compose(spec: AgentSpec, callOpts?: { timeout_ms?: number }): Promise<string> {
      const timeout_ms = callOpts?.timeout_ms ?? default_timeout_ms
      const handle = substrate.start(spec)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeout_ms)
      try {
        return await collectTokensToString(handle, ac.signal)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export interface BuildReminderDispatcherInput {
  /** Where composed bodies are posted. Required — the whole point. */
  outbound: ReminderOutbound
  /** Fire-time composition seam. Absent/null → literal-degrade everything. */
  llm?: ReminderLlm | null
  /** Live-context gatherer. Absent → compose from intent + clock only. */
  context?: ReminderContextSource
  /**
   * Maps the reminder's engine-shaped destination to the surface topic key
   * (Open: `web:<user_id>[:<project_id>]`). Absent → the explicit topic is used
   * verbatim, falling back to `general_topic_id`.
   */
  resolveTopicId?: ReminderTopicResolver
  /** Composition model. Defaults to the Haiku-class `FAST_MODEL`. */
  model?: string
  max_tokens?: number
  /** Topic id used when no resolver is wired and a reminder has no destination. */
  general_topic_id?: string
  /**
   * The composition tool allow-list. Production MUST pass the owner's live-chat
   * surface — see {@link DEFAULT_TOOL_NAMES} for why a mismatch evicts the warm
   * session rather than restricting the turn.
   */
  tool_names?: ReadonlyArray<string>
  /**
   * Ritual fire planner (ISSUES #504). Answers "what should this due row compose
   * from, and what must be recorded about it?" — see `reminders/ritual-fire.ts`.
   *
   * Absent → an ordinary NUDGE row composes from its own stored `message`, which is
   * what a test or an instance with no model credential wants. A row carrying a
   * `ritual_id` is a different case and is NOT dispatched as a nudge: it composes
   * nothing, logs at error level, and posts one plain-language notice
   * ({@link formatRitualUnplannableNotice}) — see `dispatch` below for why. This
   * docblock previously claimed EVERY row fell through to the nudge path and called
   * that fail-closed; it was true of the approved PROMPT and false of the
   * NOTIFICATION, because a ritual row's stored `message` is the dispatch token
   * `ritual:<id>` and composing it put that token on the owner's lock screen.
   */
  ritual_planner?: RitualFirePlanner
  /**
   * Resolve the concrete model id for a ritual turn. A THUNK, not a value, so the
   * ritual tracks the live best model the way the chat agent does instead of
   * pinning whatever id was current at composition (`RITUAL_MODEL_TIER` is the
   * TIER; this resolves it). Defaults to the nudge `model` when unwired.
   */
  resolve_ritual_model?: () => string
  now?: () => number
  log?: (msg: string) => void
}

/**
 * Build the production `ReminderDispatcher`. The returned object is what
 * `ReminderTickLoop` invokes per due row.
 */
export function buildReminderDispatcher(input: BuildReminderDispatcherInput): ReminderDispatcher {
  const llm = input.llm ?? null
  const model = input.model ?? FAST_MODEL
  const max_tokens = input.max_tokens ?? DEFAULT_MAX_TOKENS
  const general_topic_id = input.general_topic_id ?? 'general'
  const now = input.now ?? ((): number => Date.now())
  const log = input.log ?? ((msg: string): void => dispatcherLog.debug(msg))
  const toolNames = input.tool_names ?? DEFAULT_TOOL_NAMES
  const ritual_planner = input.ritual_planner
  const resolveRitualModel = input.resolve_ritual_model ?? ((): string => model)

  // The REPL `--tools` allow-list only consumes `t.name`; the rest is contract
  // filler for the locked AgentSpec interface (mirrors build-live-agent-turn).
  const tools: ToolDef[] = toolNames.map((name) => ({
    name,
    description: `Built-in Claude Code tool '${name}' (reminder compose read surface)`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    capability_required: 'fs:project_data',
  }))

  /**
   * Run ONE composition turn. This is the SINGLE place a fired reminder — nudge
   * or ritual — reaches the substrate, so both inherit the same session, the same
   * tool surface, and therefore the same access to Cores. That sameness is the
   * whole point of ISSUES #504; a second `llm.compose` call site would be the
   * beginning of a second execution path.
   *
   * Returns the trimmed text on success, or a REASON on failure.
   *
   * ⚠️ THE REASON IS THE POINT, not a nicety (ISSUES #506). A caller that only
   * learns "it didn't work" can only write "it didn't work" — which is precisely
   * how a real `evening-wrap` failure came to be recorded as
   * `"retry exhausted after 1 attempts: failed"`, a `failure_reason` whose inner
   * cause was the literal word `failed`, with empty `output_summary`, and no log
   * line naming the ritual anywhere in the window. So this returns the actual
   * cause — the thrown error, or the fact that the turn came back empty, or that
   * no composition seam is wired — and the ritual path writes THAT into the ledger.
   * Returning a bare `null` here would rebuild the same undiagnosable failure.
   *
   * The CALLER decides what a failure MEANS, because that is the one place the two
   * kinds legitimately differ: a nudge degrades to its literal body, a ritual
   * records the cause and tells the owner.
   */
  type ComposeOutcome = { ok: true; text: string } | { ok: false; reason: string }

  async function composeTurn(args: {
    reminder: Reminder
    prompt: string
    project_id: string
    model_preference: string[]
    max_tokens: number
    timeout_ms?: number
  }): Promise<ComposeOutcome> {
    if (llm === null) {
      return { ok: false, reason: 'no LLM composition seam is wired on this instance' }
    }
    try {
      const spec: AgentSpec = {
        prompt: args.prompt,
        tools,
        model_preference: args.model_preference,
        max_tokens: args.max_tokens,
        // Meter the compose turn to the DESTINATION project, not the instance
        // slug — see `deriveReminderProjectId`. Without this every project
        // reminder is metered/session-keyed to the owner.
        metering_context: { project_id: args.project_id },
      }
      const text = await llm.compose(
        spec,
        args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : undefined,
      )
      const trimmed = text.trim()
      if (trimmed.length > 0) return { ok: true, text: trimmed }
      return {
        ok: false,
        reason: `the composition turn returned an empty body (model ${args.model_preference[0] ?? 'unknown'})`,
      }
    } catch (err) {
      const reason = err instanceof Error ? (err.stack ?? err.message) : String(err)
      log(`reminder ${args.reminder.id} compose failed: ${reason}`)
      return { ok: false, reason }
    }
  }

  async function compose(
    reminder: Reminder,
    shape: ReminderShape,
    project_id: string,
  ): Promise<string> {
    if (llm === null) {
      return literalFallback(shape)
    }
    {
      let context = ''
      if (input.context !== undefined) {
        try {
          context = await input.context.gather(reminder, project_id)
        } catch (err) {
          log(`reminder ${reminder.id} context gather failed: ${String(err)}`)
        }
      }
      const prompt = buildReminderPrompt({
        shape,
        context,
        now_iso: new Date(now()).toISOString(),
      })
      const outcome = await composeTurn({
        reminder,
        prompt,
        project_id,
        model_preference: [model],
        max_tokens,
      })
      if (!outcome.ok) {
        log(`reminder ${reminder.id} composed nothing (${outcome.reason}) — using literal fallback`)
        return literalFallback(shape)
      }
      return outcome.text
    }
  }

  const resolveTopicId = input.resolveTopicId

  /** The destination topic for a fired row — identical for a nudge and a ritual. */
  function topicFor(reminder: Reminder, explicit_topic: string | null): string {
    return resolveTopicId !== undefined
      ? resolveTopicId({ reminder, explicit_topic })
      : (explicit_topic ?? general_topic_id)
  }

  async function post(reminder: Reminder, topic_id: string, body: string): Promise<boolean> {
    const accepted = await input.outbound.post({
      topic_id,
      owner_slug: reminder.owner_slug,
      body,
      reminder_id: reminder.id,
    })
    return accepted !== false
  }

  /**
   * Fire an approved ritual: ONE turn on the owner's normal session, posted
   * through the ONE delivery seam, then the ledger closed.
   *
   * Everything here except "which prompt" and "write it down" is the nudge path
   * verbatim — same `composeTurn`, same `post`, same topic resolution. What
   * differs is the failure posture, and only because the two genuinely differ: a
   * nudge has a literal body to degrade to, a ritual has none, so a ritual that
   * composes nothing is a recorded FAILURE with a one-line notice rather than a
   * silently-degraded post.
   */
  async function fireRitual(
    reminder: Reminder,
    plan: RitualFirePlan,
    topic_id: string,
    project_id: string,
  ): Promise<void> {
    const outcome = await composeTurn({
      reminder,
      prompt: plan.prompt,
      project_id,
      model_preference: [resolveRitualModel()],
      max_tokens: RITUAL_MAX_TOKENS,
      timeout_ms: RITUAL_TIMEOUT_MS,
    })
    if (!outcome.ok) {
      // FAILED. Record the ACTUAL CAUSE and say so out loud (ISSUES #506): the
      // previous lane logged a ritual failure at debug (so journalctl never named
      // the ritual in the whole window) and wrote a tautological reason (so the
      // ledger did not name the cause either) — leaving a failed morning brief with
      // literally no diagnosable trace on either surface. An unattended failure has
      // to be answerable from the logs OR the ledger; here it is both.
      dispatcherLog.error('ritual_fire_failed', {
        reminder: reminder.id,
        ritual_id: plan.ritual_id,
        run_id: plan.run_id,
        reason: outcome.reason,
      })
      const notices = await plan.settle({ status: 'failed', detail: outcome.reason })
      for (const notice of notices) await post(reminder, topic_id, notice)
      return
    }
    const body = outcome.text
    // A `silent` ritual suppresses SUCCESS output only — its failure notices
    // above still post. Settle FIRST either way: the durable row is the record,
    // and it must exist before the output can reach the owner.
    const notices = await plan.settle({ status: 'finished', body })
    for (const notice of notices) await post(reminder, topic_id, notice)
    if (plan.silent) return
    const posted = await post(reminder, topic_id, body)
    if (!posted) {
      throw new Error(
        `ritual ${plan.ritual_id} outbound post rejected for topic ${topic_id} — left pending for retry`,
      )
    }
  }

  return {
    async dispatch(reminder: Reminder): Promise<void> {
      // ONE question per due row, asked before anything else: what does this row
      // compose from? There is no `ritual_id` branch in `reminders/tick.ts` and no
      // second executor — a ritual and a nudge reach the substrate and the owner
      // through the code below, together (ISSUES #504).
      const decision: RitualFireDecision =
        ritual_planner !== undefined ? await ritual_planner.plan(reminder) : { kind: 'nudge' }

      if (decision.kind === 'skipped') {
        // Fail-closed refusal (unknown / unapproved / edited prompt / missing
        // file). A durable `code_ritual_runs` 'skipped' row already landed inside
        // the planner. Post NOTHING and return normally so the tick keeps its
        // claim — an unapproved ritual must not retry every 30 s forever.
        log(`reminder ${reminder.id} ritual ${decision.ritual_id} skipped: ${decision.reason}`)
        return
      }

      if (decision.kind === 'fire') {
        const explicit_topic = reminder.topic_id ?? null
        await fireRitual(
          reminder,
          decision.plan,
          topicFor(reminder, explicit_topic),
          deriveReminderProjectId(reminder),
        )
        return
      }

      // A RITUAL ROW WITH NO PLANNER MUST POST NOTHING — it must never fall through
      // to the nudge path below.
      //
      // `ritual_planner` is null on a box with no LLM (`open/composer.ts` —
      // `init_ritual_planner` never runs), and the decision above then reads
      // `{ kind: 'nudge' }` for EVERY row including ritual rows. A ritual row's
      // stored `message` is the dispatch token `ritual:<id>`
      // (`reminders/ritual-registration.ts:982`), so composing it as an ordinary
      // nudge puts that token through `classifyReminderMessage` as literal intent —
      // and the owner's lock screen reads `ritual:kaizen`. That is the exact symptom
      // this whole lane exists to remove, arriving by a second route.
      //
      // The comment on `ritualPlanner` called the fall-through "fail-closed: nothing
      // reads a ritual's prompt". True and beside the point: the prompt is protected,
      // the NOTIFICATION is not. Fail-closed here means posting nothing at all, the
      // same posture as the planner's own `skipped`.
      //
      // Keyed on `reminder.ritual_id` (`reminders/store.ts:59`), not on the shape of
      // the message text — the column is what makes the row a ritual, and a prefix
      // test would also swallow a plain reminder the owner happened to word that way.
      //
      // ⚠️ REFUSING TO COMPOSE IS ONLY HALF OF IT: THE OCCURRENCE IS CONSUMED HERE.
      // Returning normally leaves the tick loop's pre-dispatch claim standing, so
      // `markFired`/`advanceRecurrence` retires this occurrence — and the first
      // version of this guard did that with a `log()` that defaults to DEBUG and
      // nothing else. That is the ISSUES #506 shape exactly: a scheduled ritual
      // vanished with no post, no ledger row, no journal line at the default level,
      // and no way for the owner to tell it apart from a ritual he never scheduled.
      // `reminders/AGENTS.md` states the contract the other way round — for a
      // ritual, "a failure is recorded + noticed instead". So both happen here.
      //
      // WHY CONSUME RATHER THAN THROW. Throwing would revert the claim and retry
      // next tick, which on an instance with no model credential means every 30 s
      // forever for a condition that cannot resolve without an operator. That is
      // the same reasoning the planner's own `skipped` branch above is built on.
      //
      // WHY NO `code_ritual_runs` ROW. The ledger writer and the run-id mint both
      // live inside the planner, which is the thing that is absent, and 'skipped'
      // rows are constrained to a fixed `skip_reason` set at the schema level
      // (`migrations/0106_ritual_schema.sql`) that has no member for this state.
      // The record is therefore the error-level log line, and the notice is what
      // reaches the owner — the "answerable from the logs OR the ledger" bar
      // `fireRitual` states below, met on the log side.
      if (reminder.ritual_id !== null && reminder.ritual_id.length > 0) {
        dispatcherLog.error('ritual_unplannable', {
          reminder: reminder.id,
          ritual_id: reminder.ritual_id,
          reason: 'no ritual planner is wired on this instance',
        })
        const notice_topic_id = topicFor(reminder, reminder.topic_id ?? null)
        const noticed = await post(
          reminder,
          notice_topic_id,
          formatRitualUnplannableNotice({ ritual_id: reminder.ritual_id }),
        )
        // A rejected notice means the owner learned nothing, so the occurrence must
        // NOT be consumed, and the #319 contract holds (this throws before any
        // successful delivery).
        //
        // WHICH SITES THIS MATCHES, NAMED — the earlier wording ("the two sibling
        // post sites") was read by review as claiming parity with ALL of them, which
        // is false and worth being exact about. It matches the two DELIVERABLE
        // posts: the nudge body below, and `fireRitual`'s ritual body. It does NOT
        // match the SETTLE-NOTICE loops in `fireRitual`, which discard `post`'s
        // boolean — so a rejected settle notice still retires the occurrence with
        // neither output nor notice, which is the ISSUES #506 shape surviving in one
        // corner. That is pre-existing behaviour and a separate fix (the loops need
        // to collect their rejections without losing the ledger write that must
        // precede them); it is not what this guard changed, and this comment no
        // longer implies otherwise.
        if (!noticed) {
          throw new Error(
            `reminder ${reminder.id} ritual ${reminder.ritual_id} unplannable notice rejected for topic ${notice_topic_id} — left pending for retry`,
          )
        }
        return
      }

      const shape = classifyReminderMessage(reminder.message)
      // A reminder whose stored `message` is empty/whitespace (the Reminders
      // Core create path, unlike the app surface, has no non-empty guard) has
      // no deliverable intent — even the LLM has nothing to compose from.
      // Skip the post (and the wasted compose turn) and return normally so the
      // tick advances the row rather than re-firing an empty body forever.
      if (literalFallback(shape).trim().length === 0) {
        log(`reminder ${reminder.id} has empty message — skipping empty-body fire`)
        return
      }
      const explicit_topic = reminder.topic_id ?? shape.routing_topic ?? null
      const destination_project_id = deriveReminderProjectId(reminder)
      const topic_id = topicFor(reminder, explicit_topic)
      const body = await compose(reminder, shape, destination_project_id)
      const accepted = await post(reminder, topic_id, body)
      // A rejected durable post (e.g. the chat history write failed) MUST NOT
      // let the row stay claimed/fired — that would silently consume a reminder
      // that never reached the user. Throw so the tick loop reverts the
      // pre-dispatch claim and leaves the row pending to retry next tick. The
      // tick loop treats EVERY caught dispatch throw as "post did not happen"
      // (#319), which holds because the dispatcher only ever throws BEFORE a
      // successful delivery, never after one.
      if (accepted === false) {
        throw new Error(
          `reminder ${reminder.id} outbound post rejected for topic ${topic_id} — left pending for retry`,
        )
      }
    },
  }
}
