/**
 * @neutronai/reminders-core — Shape A / B / C composer.
 *
 * Three create-time modes for the `message` body persisted into the
 * engine's `reminders.message` column. NO LLM call at create time —
 * the fire-time engine agent (`prompts/reminder-agent-base.md`) owns
 * all LLM composition.
 *
 *   Shape A (literal)     — the input `body` verbatim.
 *   Shape B (smart_wrap)  — prepend the LOCKED smart-wrap prelude so
 *                           the fire-time agent gathers context (the
 *                           project's STATUS.md) and composes a fresh
 *                           message at fire time.
 *   Shape C (pattern)     — load a named pattern body from
 *                           `prompts/reminder-patterns.md` verbatim +
 *                           substitute caller-supplied `FILL:<slot>`
 *                           markers.
 *
 * The Shape-B prelude is an explicit composition instruction persisted
 * into the reminder body. It is stored verbatim (modulo `{{OWNER_HOME}}`
 * template substitution at fire time) and names only Open-real context
 * sources. Changing this literal changes the stored body of every
 * existing smart-wrapped reminder, so the snapshot test in
 * `__tests__/smart-wrap.test.ts` pins the prelude bytes and any future
 * drift surfaces as a deliberate diff.
 *
 * Shape C delegates pattern resolution to a caller-supplied
 * `loadPattern(name)` closure so tests inject stubs and the production
 * loader can read `prompts/reminder-patterns.md` off disk (or via the
 * same template runtime the gateway uses for fire-time agent prompts).
 * The composer never opens the patterns file directly.
 */

/**
 * The five locked pattern names. New patterns are operator-managed via
 * git (a new section in `prompts/reminder-patterns.md` + a new entry
 * here in lockstep). Inventing patterns is out-of-scope for this
 * sprint per the brief's § 9.
 */
export const REMINDER_PATTERN_NAMES = [
  'nag-until-done',
  'escalating-urgency',
  'daily-countdown',
  'check-in-cadence',
  'context-aware-one-shot',
] as const

export type ReminderPatternName = typeof REMINDER_PATTERN_NAMES[number]

/**
 * The locked smart-wrap prelude — an explicit fire-time composition
 * instruction persisted into the reminder body for Shape B. It names
 * ONLY Open-real context sources: the destination project's recent state
 * from its `STATUS.md` (the dispatcher's `ReminderContextSource` gathers
 * that content and hands it to the compose agent, which also has read-only
 * Read/Glob/Grep — `reminders/dispatcher.ts` + `reminders/context.ts`),
 * plus the clock. It deliberately references NO external shell tooling —
 * Open ships no weather / telegram-post / calendar CLI helpers; the
 * dispatcher composes the nudge and posts it through the internal
 * `ReminderOutbound` seam.
 *
 * The prelude carries NO template tokens (`{{...}}`): the persisted body is
 * fed to the fire-time substrate VERBATIM by `buildReminderPrompt`
 * (`reminders/prompt.ts`) with no template substitution, so any
 * `{{OWNER_HOME}}` here would reach the agent unresolved as a literal,
 * nonexistent path. It stays path-free instead.
 *
 * Exported so the snapshot test + the production-composer integration
 * test can compare the persisted `message` field against this literal
 * byte-for-byte.
 */
export const SMART_WRAP_PRELUDE: string =
  'Compose a smart version of this reminder using available context ' +
  "(the destination project's recent state from its STATUS.md, plus the day " +
  'of week and time of day). Keep it 1-3 sentences, action-oriented, no ' +
  'preamble, no em dashes. If no useful context is available, deliver the ' +
  'original message verbatim.'

/**
 * The body the user typed is appended after the prelude as a trailing
 * "Original reminder: <body>" line. The fire-time agent reads this
 * exact prefix to locate the user's literal phrase, and the no-LLM
 * degrade (`literalFallback` in `@neutronai/reminders/message-shape.ts`)
 * extracts it to post the user's original words rather than the
 * composition instruction.
 */
const ORIGINAL_REMINDER_PREFIX = 'Original reminder: '

/**
 * Leading sentinel that marks a persisted body as a Shape-B composition
 * instruction. The fire-time classifier (`classifyReminderMessage` in
 * `@neutronai/reminders/message-shape.ts`) routes a body to the
 * `smart-wrap` branch ONLY when it opens with this sentinel — without it
 * the prelude would be misclassified as a plain `literal` and posted
 * verbatim. Kept in lockstep with that module's `SMART_RE`.
 */
export const SMART_WRAP_SENTINEL = '[smart] '

export type ReminderMode =
  | { kind: 'literal' }
  | { kind: 'smart_wrap' }
  | {
      kind: 'pattern'
      name: ReminderPatternName
      slots?: Record<string, string>
    }

export interface SmartWrapInput {
  /** Raw user phrase. The body is preserved verbatim across all shapes. */
  body: string
  mode: ReminderMode
}

export interface SmartWrapResult {
  /** The final `message` body to persist into the engine row. */
  message: string
  /** True iff the body was wrapped or templated; Shape A returns false. */
  composed: boolean
  /** Audit metadata for the fire-time agent + the production log. */
  audit: {
    mode: 'literal' | 'smart_wrap' | 'pattern'
    pattern_name?: ReminderPatternName
    slots_filled?: string[]
  }
}

export interface SmartWrapComposer {
  compose(input: SmartWrapInput): SmartWrapResult
}

export interface SmartWrapDeps {
  /**
   * Loader that returns the verbatim pattern body from
   * `prompts/reminder-patterns.md` by name. Tests inject a stub. The
   * production wiring reuses the prompts/ template runtime that the
   * gateway uses for fire-time agent prompts.
   *
   * The returned string MUST be the pattern body verbatim — including
   * the leading `PATTERN: <name>` header that the fire-time agent
   * uses to detect the Shape-C branch.
   */
  loadPattern: (name: ReminderPatternName) => string
}

export class UnknownReminderPatternError extends Error {
  override readonly name = 'UnknownReminderPatternError'
  readonly code = 'unknown_pattern' as const
}

export function isReminderPatternName(value: unknown): value is ReminderPatternName {
  if (typeof value !== 'string') return false
  return (REMINDER_PATTERN_NAMES as ReadonlyArray<string>).includes(value)
}

export function buildSmartWrapComposer(deps: SmartWrapDeps): SmartWrapComposer {
  return {
    compose(input: SmartWrapInput): SmartWrapResult {
      const mode = input.mode
      if (mode.kind === 'literal') {
        return {
          message: input.body,
          composed: false,
          audit: { mode: 'literal' },
        }
      }
      if (mode.kind === 'smart_wrap') {
        const message = `${SMART_WRAP_SENTINEL}${SMART_WRAP_PRELUDE}\n\n${ORIGINAL_REMINDER_PREFIX}${input.body}`
        return {
          message,
          composed: true,
          audit: { mode: 'smart_wrap' },
        }
      }
      // Shape C — pattern template.
      if (!isReminderPatternName(mode.name)) {
        throw new UnknownReminderPatternError(
          `unknown reminder pattern: ${String(mode.name)}`,
        )
      }
      let body: string
      try {
        body = deps.loadPattern(mode.name)
      } catch (err) {
        // A pattern named in the locked enum should always resolve;
        // surface a loader failure as UnknownReminderPatternError so
        // the chat-bridge can render a consistent error code.
        throw new UnknownReminderPatternError(
          `failed to load pattern '${mode.name}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      const slots = mode.slots ?? {}
      const slotsFilled: string[] = []
      let composed = body
      for (const [key, value] of Object.entries(slots)) {
        const marker = `FILL:${key}`
        if (composed.includes(marker)) {
          composed = composed.split(marker).join(value)
          slotsFilled.push(key)
        }
      }
      // Append the user's raw body at the end as a trailing context
      // line, mirroring Shape B's "Original reminder: <body>" — the
      // fire-time agent reads this when the pattern body itself does
      // not carry the user's phrase verbatim.
      const message = `${composed}\n\n${ORIGINAL_REMINDER_PREFIX}${input.body}`
      const audit: SmartWrapResult['audit'] = {
        mode: 'pattern',
        pattern_name: mode.name,
      }
      if (slotsFilled.length > 0) audit.slots_filled = slotsFilled
      return { message, composed: true, audit }
    },
  }
}
