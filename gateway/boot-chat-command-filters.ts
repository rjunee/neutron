/**
 * gateway/boot-chat-command-filters.ts — the Tier-1 Core `/`-command
 * chat filters + the pattern-body loader they compose with.
 *
 * Split out of the former monolithic `gateway/boot-helpers.ts` (C2
 * refactor). The production composer chains these via
 * `buildChainedChatCommandFilter([...])` from ONE import site; each filter
 * lazily imports its Core INSIDE `match()` so this module stays free of an
 * eager Core module-load and off the entry-module import edge. This module
 * MUST NEVER import `gateway/index.ts`.
 *
 * Open-classified and import-clean of Managed dirs.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * S1 — chain multiple `ChatCommandFilter` instances into one. Each
 * inner filter peeks at the inbound; the first to claim ownership (by
 * returning a non-null result) wins, the rest fall through. New Tier 1
 * Cores append their per-Core filter to the chain in
 * `gateway/index.ts` as they ship — Reminders ships
 * `buildRemindersChatCommandFilter` (below), Tasks Core S1 will ship
 * its own follow-up.
 */
export function buildChainedChatCommandFilter(
  filters: ReadonlyArray<import('./http/app-ws-surface.ts').ChatCommandFilter>,
): import('./http/app-ws-surface.ts').ChatCommandFilter {
  return {
    async match(input) {
      for (const filter of filters) {
        try {
          const result = await filter.match(input)
          if (result !== null) return result
        } catch (err) {
          // Single filter throwing must NOT poison the chain — fall
          // through to the next so one filter's bug never blocks the
          // /remind path (and vice versa). The surface itself catches
          // throws from the chain root too; this catch belt-and-
          // suspenders the per-filter boundary.
          console.warn(
            `[chat-command-filter] chained filter threw — falling through: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
      return null
    },
  }
}

/**
 * S1 — Reminders-Core `/remind` filter. Implements the
 * `ChatCommandFilter` shape (interface with a `match()` method) so the
 * chain composer above can treat every filter interchangeably. The
 * factory binds the substrate-backed adapter +
 * the smart-wrap composer; the closure handles every `/remind`
 * sub-command via `parseAndExecuteRemindCommand` from
 * `@neutronai/reminders-core`.
 */
export function buildRemindersChatCommandFilter(deps: {
  backend: import('@neutronai/reminders-core').RemindersBackend
  smartWrap: import('@neutronai/reminders-core').SmartWrapComposer
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      if (!trimmed.startsWith('/remind')) return null
      const { parseAndExecuteRemindCommand } = await import('@neutronai/reminders-core')
      const response = await parseAndExecuteRemindCommand(input.body, {
        backend: deps.backend,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        user_id: input.user_id,
        smartWrap: deps.smartWrap,
      })
      if (response === null) return null
      const out: import('./http/app-ws-surface.ts').ChatCommandFilterResult = {
        text: response.text,
      }
      if (response.data !== undefined) out.data = response.data
      if (response.deep_link !== undefined) out.deep_link = response.deep_link
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}

/**
 * Trident-port PR-5 — the `/code` chat-command filter, REWIRED onto
 * foundational Trident. This supersedes `buildCodegenChatCommandFilter`
 * (below): instead of dispatching into the Code-Gen Core's separate
 * `CodegenOrchestrator` + in-memory tracker + sidecar, `/code <task>`
 * simply CREATES a `code_trident_runs` row via the per-instance
 * `TridentRunStore` and returns — the foundational tick loop
 * (`buildTridentOrchestrator`, wired in `build-core-modules.ts` from
 * `input.trident.build_substrate`) picks the row up and drives it: launch the
 * inner CC Dynamic Workflow (Forge build → parallel Argus review → synthesis →
 * fix loop) → merge (per git-mode) → done. State lives in SQLite, so a `/code`
 * build survives a control-plane restart and resumes from its persisted phase.
 *
 * The composer threads `resolve_context(input)` — given the inbound
 * envelope (project_id / user_id / project_slug), it returns the
 * `TridentCodeContext` (store + project_slug + repo_path + the git-mode /
 * Ralph detection seams). Returning `null` means "no `/code` build target
 * for this project" → the filter replies with a friendly unavailable
 * message rather than throwing.
 */
export function buildTridentCodeChatCommandFilter(deps: {
  resolve_context: (input: {
    project_id: string
    project_slug: string
    user_id: string
    channel_topic_id: string
  }) =>
    | import('@neutronai/trident/code-command.ts').TridentCodeContext
    | null
    | Promise<import('@neutronai/trident/code-command.ts').TridentCodeContext | null>
  default_project_id?: string
  /** Message when `resolve_context` yields null (no build target wired). */
  unavailable_message?: string
  /**
   * Channel this filter's `/code` runs originate on (#317). This builder is
   * wired into the app-WebSocket surface, so the default is `'app_socket'`;
   * the value is stamped onto every created run (unless the resolved context
   * already set one) so terminal result delivery routes the build's result
   * back to THIS surface instead of defaulting to Telegram.
   */
  channel_kind?: import('@neutronai/channels/types.ts').Topic['channel_kind']
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  const default_pid = deps.default_project_id ?? 'default'
  const channel_kind = deps.channel_kind ?? 'app_socket'
  const unavailable =
    deps.unavailable_message ??
    '`/code` is not available for this project — no repository is wired for autonomous builds here.'
  return {
    async match(input) {
      const trimmed = input.body.trimStart()
      // Cheap early-out: skip the dynamic import for anything not even
      // prefixed `/code`. The real boundary check is `parseCodeCommand`
      // below — bare `startsWith` would wrongly claim `/codefoo`.
      if (!trimmed.startsWith('/code')) return null
      const { parseAndExecuteCodeCommand, parseCodeCommand } = await import('@neutronai/trident/code-command.ts')
      // Share ONE grammar with the canonical parser (K8): `/code` must be
      // followed by EOL/whitespace. `/codefoo bar` is NOT a code command —
      // fall through to the LLM instead of pre-claiming it here (which, in the
      // no-context branch below, would answer "unavailable" for a non-command).
      // IMPORTANT: only fall through on the genuine non-command reason
      // (`not_a_code_command`). Other `unrecognized` reasons — e.g. a
      // retired/unknown sub-verb like `/code status` — must still be CLAIMED
      // here so `parseAndExecuteCodeCommand` (below) answers with its
      // friendly reject text, matching the canonical contract in
      // `trident/code-command.ts` (`parseAndExecuteCodeCommand` only returns
      // `null` for `not_a_code_command`).
      const parsed = parseCodeCommand(input.body)
      if (parsed.kind === 'unrecognized' && parsed.reason === 'not_a_code_command') return null
      const ctx = await deps.resolve_context({
        project_id: input.project_id ?? default_pid,
        project_slug: input.project_slug,
        user_id: input.user_id,
        channel_topic_id: input.channel_topic_id,
      })
      if (ctx === null) {
        // Still claim the `/code` command (don't fall through to the LLM)
        // but answer honestly. `/code help` works with no context too.
        if (parsed.kind === 'help') return { text: unavailable }
        return { text: unavailable, error: { code: 'unavailable', message: 'no build target' } }
      }
      // Stamp the originating channel onto the run so its terminal result is
      // delivered back to this surface (#317). The resolver may override it
      // per-run; otherwise the filter's surface default wins (NOT telegram).
      if (ctx.channel_kind === undefined) ctx.channel_kind = channel_kind
      const response = await parseAndExecuteCodeCommand(input.body, ctx)
      if (response === null) return null
      const out: import('./http/app-ws-surface.ts').ChatCommandFilterResult = {
        text: response.text,
      }
      if (response.data !== undefined) out.data = response.data
      if (response.error !== undefined) out.error = response.error
      return out
    },
  }
}

// RETIRED (Trident-port close-out, 2026-06-24) — the Code-Gen Core's `/code`
// chat-command filter (`buildCodegenChatCommandFilter`) is gone. `/code` is now
// EXCLUSIVELY a thin entry into foundational Trident via
// `buildTridentCodeChatCommandFilter` (above): it creates a `code_trident_runs`
// row that the tick loop drives on the CC-subprocess substrate. The legacy
// filter dispatched through the Code-Gen Core wrapper's separate orchestration
// path (`CodegenOrchestrator` + the direct-`@anthropic-ai/sdk` runner the
// retired `gateway/cores/code-gen-factory.ts` built) — exactly the wrapper this
// close-out removes so there is ONE `/code` engine and NO direct-SDK code path.

/**
 * WAVE 3 (Calendar Core completion) — surface the `/cal` chat-command
 * filter through the SAME boot-helpers + barrel path as its sibling
 * Cores (`buildRemindersChatCommandFilter`,
 * `buildTridentCodeChatCommandFilter`),
 * so the production composer chains `/cal` into
 * `buildChainedChatCommandFilter([...])` alongside `/remind` and `/code`
 * from ONE import site. Before this, the canonical `/cal` filter was only
 * reachable from `./cores/calendar-wiring.ts` — a parity asymmetry the
 * dispatcher's own doc comment ("composes ... via
 * `buildChainedChatCommandFilter`") implied was unintended.
 *
 * The canonical `/cal` dispatcher stays in `./cores/calendar-wiring.ts`
 * (co-located with the pre-meeting-brief scheduler it shares a
 * `CalendarClient` + sidecar cache with) — this thin wrapper is the
 * composer-facing entry. It lazily imports the dispatcher INSIDE
 * `match()` (mirroring how the sibling filters lazy-import their Core)
 * so boot-helpers stays free of an eager `scribe` / calendar-wiring
 * module-load: single source of truth, no duplicated dispatch logic, no
 * entry-module import cycle.
 */
export function buildCalendarChatCommandFilter(deps: {
  client: import('@neutronai/calendar-core').CalendarClient
  cacheFor: (
    project_id: string,
  ) => Promise<import('@neutronai/calendar-core').CalendarProjectCache | null>
  /** Clock override (tests). */
  now?: () => Date
  /** User timezone for the executor's date formatter. */
  userTz?: string
}): import('./http/app-ws-surface.ts').ChatCommandFilter {
  let inner: import('./http/app-ws-surface.ts').ChatCommandFilter | null = null
  return {
    async match(input) {
      if (inner === null) {
        const { buildCalendarChatCommandDispatcher } = await import(
          './cores/calendar-wiring.ts'
        )
        inner = buildCalendarChatCommandDispatcher(deps)
      }
      return inner.match(input)
    },
  }
}

/**
 * S1 — load a named Shape-C pattern body from `prompts/reminder-patterns.md`.
 * Threaded into the Reminders Core's smart-wrap composer via the
 * cores backend factory map. Tests inject stubs; production reads from disk.
 *
 * Locked names match `REMINDER_PATTERN_NAMES` in
 * `@neutronai/reminders-core/smart-wrap`. The patterns file lays each
 * named pattern out as a `## Pattern: <name>` section with the template
 * body inside a triple-backtick code block whose first line is
 * `PATTERN: <name>`. We extract everything from the `PATTERN: <name>`
 * line through the closing ``` of that block.
 */
export function readPatternFromPrompts(name: string): string {
  // We deliberately read the RAW file (no substituteTemplate call)
  // so `{{OWNER_HOME}}` tokens survive into the persisted message
  // body — preserving forward-compat with home-token renames (exactly
  // what saved us at the C4-a2 {{OWNER_HOME}}→{{OWNER_HOME}} rename:
  // pre-rename bodies still resolve via the template alias) and
  // matching the brief § 3.5 "composer stores the un-substituted
  // literal" lock. The fire-time agent's prompt loader substitutes at
  // fire time via @neutronai/prompts/template.ts.
  const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
  const content = readFileSync(join(promptsDir, 'reminder-patterns.md'), 'utf8')
  const header = `PATTERN: ${name}`
  const idx = content.indexOf(header)
  if (idx === -1) {
    throw new Error(`unknown reminder pattern '${name}'`)
  }
  // Walk backwards to the opening ```; forwards to the closing ```.
  // The pattern body lives between (exclusive of) these fences.
  const openFence = content.lastIndexOf('```', idx)
  const closeFence = content.indexOf('\n```', idx)
  if (openFence === -1 || closeFence === -1 || closeFence < idx) {
    throw new Error(`malformed pattern block for '${name}'`)
  }
  const start = content.indexOf('\n', openFence) + 1
  return content.slice(start, closeFence).trimEnd()
}
