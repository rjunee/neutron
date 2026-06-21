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
 * Mirrors `gateway/realmode-composer/build-live-agent-turn.ts`: CC-spawn
 * substrate only (NEVER a direct api.anthropic.com call), per-dispatch
 * `metering_context.project_id` keying, a wall-clock timeout around the turn.
 */

import { FAST_MODEL } from '../runtime/models.ts'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { ToolDef } from '../core-sdk/types.ts'
import { collectTokensToString } from '../gateway/realmode-composer/build-llm-call-substrate.ts'
import { classifyReminderMessage, literalFallback, type ReminderShape } from './message-shape.ts'
import { buildReminderPrompt } from './prompt.ts'
import type { Reminder } from './store.ts'
import type { ReminderDispatcher } from './tick.ts'

/** Where a composed reminder body is posted. */
export interface ReminderOutboundInput {
  topic_id: string
  project_slug: string
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
   * (see {@link deriveReminderProjectId}) — NOT the instance `project_slug`.
   * The source uses it to locate the right project's state (e.g. STATUS.md).
   */
  gather(reminder: Reminder, project_id: string): string | Promise<string>
}

/**
 * Derive the DESTINATION project id a reminder composes against from its
 * stored `topic_id`. For project reminders the engine stores the destination
 * project in `topic_id` (Reminders Core persists the raw `project_id`; the app
 * surface persists `app-project:<project_id>`; an already-web-shaped topic is
 * `web:<user_id>:<project_id>`), while `project_slug` is the FIXED instance /
 * owner slug. Keying context + metering off `project_slug` reads the wrong
 * project's STATUS.md and meters every project reminder to the owner — this
 * bridges to the actual destination, mirroring `resolveTopicId` in
 * `open/composer.ts`.
 *
 * `null` / empty topic, or a General `web:<user_id>` topic with no project
 * segment, → the instance slug (`project_slug`), preserving instance-level
 * behaviour. A `[ROUTING]` header is a thread destination, not a project, so
 * it is deliberately NOT consulted here (only `reminder.topic_id` is).
 */
export function deriveReminderProjectId(reminder: Reminder): string {
  const topic = reminder.topic_id
  if (topic === null || topic.trim().length === 0) return reminder.project_slug
  if (topic.startsWith('app-project:')) {
    const id = topic.slice('app-project:'.length)
    return id.length > 0 ? id : reminder.project_slug
  }
  if (topic.startsWith('web:')) {
    // `web:<user_id>` (General) → instance; `web:<user_id>:<project_id>` → project.
    const sep = topic.indexOf(':', 'web:'.length)
    if (sep < 0) return reminder.project_slug
    const id = topic.slice(sep + 1)
    return id.length > 0 ? id : reminder.project_slug
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
 */
export interface ReminderLlm {
  compose(spec: AgentSpec): Promise<string>
}

/** Read-only tool surface for the composition turn (recall workspace files). */
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
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
  return {
    async compose(spec: AgentSpec): Promise<string> {
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
  /** Override the read-only tool allow-list (tests). */
  tool_names?: ReadonlyArray<string>
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
  const log = input.log ?? ((): void => undefined)
  const toolNames = input.tool_names ?? DEFAULT_TOOL_NAMES

  // The REPL `--tools` allow-list only consumes `t.name`; the rest is contract
  // filler for the locked AgentSpec interface (mirrors build-live-agent-turn).
  const tools: ToolDef[] = toolNames.map((name) => ({
    name,
    description: `Built-in Claude Code tool '${name}' (reminder compose read surface)`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    capability_required: 'fs:project_data',
  }))

  async function compose(
    reminder: Reminder,
    shape: ReminderShape,
    project_id: string,
  ): Promise<string> {
    if (llm === null) {
      return literalFallback(shape)
    }
    try {
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
      const spec: AgentSpec = {
        prompt,
        tools,
        model_preference: [model],
        max_tokens,
        // Meter the compose turn to the DESTINATION project, not the instance
        // slug — see `deriveReminderProjectId`. Without this every project
        // reminder is metered/session-keyed to the owner.
        metering_context: { project_id },
      }
      const text = await llm.compose(spec)
      if (text.trim().length === 0) {
        log(`reminder ${reminder.id} composed empty — using literal fallback`)
        return literalFallback(shape)
      }
      return text.trim()
    } catch (err) {
      log(`reminder ${reminder.id} compose failed (${String(err)}) — using literal fallback`)
      return literalFallback(shape)
    }
  }

  const resolveTopicId = input.resolveTopicId

  return {
    async dispatch(reminder: Reminder): Promise<void> {
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
      const topic_id =
        resolveTopicId !== undefined
          ? resolveTopicId({ reminder, explicit_topic })
          : (explicit_topic ?? general_topic_id)
      const body = await compose(reminder, shape, destination_project_id)
      const accepted = await input.outbound.post({
        topic_id,
        project_slug: reminder.project_slug,
        body,
        reminder_id: reminder.id,
      })
      // A rejected durable post (e.g. the chat history write failed) MUST NOT
      // let the tick loop mark the row fired / advance its recurrence — that
      // would silently consume a reminder that never reached the user. Throw
      // so the tick's try/catch leaves the row pending to retry next tick.
      if (accepted === false) {
        throw new Error(
          `reminder ${reminder.id} outbound post rejected for topic ${topic_id} — left pending for retry`,
        )
      }
    },
  }
}
