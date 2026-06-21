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
import { classifyReminderMessage, literalFallback } from './message-shape.ts'
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
  gather(reminder: Reminder): string | Promise<string>
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
  /** Composition model. Defaults to the Haiku-class `FAST_MODEL`. */
  model?: string
  max_tokens?: number
  /** Topic id used when a reminder has neither `topic_id` nor a routing header. */
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

  async function compose(reminder: Reminder): Promise<string> {
    const shape = classifyReminderMessage(reminder.message)
    if (llm === null) {
      return literalFallback(shape)
    }
    try {
      let context = ''
      if (input.context !== undefined) {
        try {
          context = await input.context.gather(reminder)
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
        metering_context: { project_id: reminder.project_slug },
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

  return {
    async dispatch(reminder: Reminder): Promise<void> {
      const shape = classifyReminderMessage(reminder.message)
      const topic_id = reminder.topic_id ?? shape.routing_topic ?? general_topic_id
      const body = await compose(reminder)
      await input.outbound.post({
        topic_id,
        project_slug: reminder.project_slug,
        body,
        reminder_id: reminder.id,
      })
    },
  }
}
