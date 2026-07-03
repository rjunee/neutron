/**
 * @neutronai/trident — async result delivery.
 *
 * Closes gap-audit P0-1 ("Async result delivery back to chat is missing").
 * Trident builds correctly — the state machine advances forge-init → argus
 * → fix loop → merge → done (or → failed) — but on a terminal phase NOTHING
 * was posted back to the originating chat topic. The run row already carries
 * the originating `chat_id`/`thread_id` (`code-command.ts`, persisted at
 * dispatch), but the tick loop never used them: the user ran `/code`, saw
 * "🛠 Building…", then silence.
 *
 * This module is the Neutron port of Vajra's `/forge/delivered` +
 * `/argus/delivered` delivery callbacks: a per-terminal-state result post
 * back to the topic the build came from. It is wired into the tick loop's
 * `on_terminal` seam (`tick.ts`), so it fires the instant a run reaches ANY
 * terminal phase (done OR failed) — not only at the very end of a happy
 * path.
 *
 * GENERIC BY DESIGN. The mechanism is "a terminal run carrying a
 * chat_id/thread_id → compose a result → post to the bound channel." It is
 * keyed on the run's own persisted routing fields, NOT on `/code` — so any
 * background agent dispatched into a `code_trident_runs` row (overnight
 * dispatcher, a future typed-agent dispatch) delivers its result through the
 * exact same path. Runs with no originating chat (`chat_id === null`, e.g. a
 * cron-seeded run) simply no-op: there is nothing to deliver to.
 *
 * Layering: this module depends only on the run shape (`store.ts`) and the
 * channel-agnostic outbound TYPES (`channels/types.ts`, type-only import).
 * It talks to the channel layer through a minimal structural `OutboundSink`
 * (one `send` method) that the production `ChannelRouter` satisfies, so the
 * trident package never imports the channels runtime.
 */

import type { InlineChoice, OutgoingMessage, Topic } from '../channels/types.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'

/**
 * Minimal structural outbound seam — the subset of `ChannelRouter` this
 * module needs. `ChannelRouter.send(OutgoingMessage)` satisfies it
 * structurally, so production passes the router directly; tests pass a
 * recording fake. Kept structural (not an import of `ChannelRouter`) so
 * the trident package stays free of the channels runtime.
 */
export interface OutboundSink {
  send(message: OutgoingMessage): Promise<string>
}

/** The composed body + optional buttons for a terminal result post. */
export interface ComposedDelivery {
  text: string
  inline_choices?: InlineChoice[]
}

export interface BuildTridentDeliveryOptions {
  /** The outbound seam — production passes the instance `ChannelRouter`. */
  sink: OutboundSink
  /**
   * Fallback channel for runs whose row carries no `channel_kind` (defensive
   * — every row written since migration 0081 carries one, defaulting to
   * `'telegram'`). The per-run `run.channel_kind` is authoritative (#317);
   * this is only consulted if that is somehow absent.
   */
  channel_kind?: Topic['channel_kind']
  /**
   * Override the result-message composer (else `composeTerminalDelivery`).
   * Lets a caller restyle the copy without touching the routing/send path.
   */
  compose?: (run: TridentRun) => ComposedDelivery | null
}

/**
 * Truncate a task line for a one-line result header. Mirrors the `/code`
 * dispatch ack's 60-char clamp so the build's start + end messages match.
 */
function truncateTask(task: string, n = 60): string {
  const clean = task.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}…`
}

/**
 * Compose the result message for a terminal run. Pure — no I/O — so the
 * exact copy per terminal state is unit-testable in isolation. Returns
 * `null` for a NON-terminal run (defensive: the loop only ever hands this
 * terminal rows).
 *
 * Trident merges autonomously on Argus APPROVE, so `done` means "already
 * merged + cleaned up" — the message reports the landed result rather than
 * offering a merge button (the human-in-the-loop merge is Vajra's
 * Forge-delivery model; trident is the autonomous loop). Branch / PR
 * identifiers ride inline so the operator can open them.
 */
export function composeTerminalDelivery(run: TridentRun): ComposedDelivery | null {
  if (!isTerminalPhase(run.phase)) return null
  // #339 — the completion message leads with the build's SLUG (the same handle
  // the Work list shows) + a short context line from the task.
  const slug = run.slug
  const task = truncateTask(run.task)
  const rounds = run.round > 1 ? ` after ${run.round} review round${run.round === 2 ? '' : 's'}` : ''

  switch (run.phase) {
    case 'done': {
      const where =
        run.merge_mode === 'pr' && run.pr !== null
          ? `merged PR #${run.pr}${run.branch !== null ? ` (\`${run.branch}\`)` : ''}`
          : run.branch !== null
            ? `merged \`${run.branch}\` locally`
            : 'merged'
      return { text: `✅ \`${slug}\` — build done, ${where}${rounds}.\n${task}` }
    }
    case 'failed': {
      // #340 — a specific reason (a merge-conflict question, a hang, exhausted
      // rounds). The build's branch/PR is left in place for manual follow-up.
      const reason = run.failure_reason ?? 'no reason recorded'
      const trail =
        run.merge_mode === 'pr' && run.pr !== null
          ? `\nPR #${run.pr} left open for review.`
          : run.branch !== null
            ? `\nBranch \`${run.branch}\` left in place for review.`
            : ''
      return { text: `❌ \`${slug}\` — build failed: ${reason}\n${task}${trail}` }
    }
    case 'stopped':
      // `/code stop` flips a row straight to `stopped` via the store (not
      // the tick loop) and replies to the user synchronously, so the loop's
      // on_terminal hook never sees a stopped row in practice. Composed
      // anyway for completeness / direct callers.
      return { text: `🛑 \`${slug}\` — build stopped.\n${task}` }
    default:
      return null
  }
}

/**
 * Build the run's originating chat topic from its persisted routing
 * fields. Returns `null` when `chat_id` is absent (a run with no
 * originating chat — e.g. cron-seeded — has nothing to deliver to).
 *
 * `channel_topic_id` is the `<chat_id>[:<thread_id>]` shape the Telegram
 * webhook decoder emits (`channels/adapters/telegram/webhook-server.ts`
 * `renderTopicId`) and the adapter's `send` parses back into
 * `chat_id` + `message_thread_id`. The other `Topic` fields are not read
 * by the outbound send path, so they carry safe placeholders.
 */
export function topicForRun(
  run: TridentRun,
  channel_kind: Topic['channel_kind'],
): Topic | null {
  if (run.chat_id === null || run.chat_id.length === 0) return null
  const channel_topic_id =
    run.thread_id !== null && run.thread_id.length > 0
      ? `${run.chat_id}:${run.thread_id}`
      : run.chat_id
  return {
    topic_id: channel_topic_id,
    channel_kind,
    channel_topic_id,
    project_id: null,
    privacy_mode: 'regular',
  }
}

/**
 * Build the `TridentTerminalHook` the tick loop fires on every terminal
 * transition. Composes the result message and posts it to the run's
 * originating topic through the outbound sink. No-ops (returns without
 * sending) when the run has no originating chat or the composer declines.
 *
 * Errors propagate to the loop's `on_terminal` try/catch, which logs them
 * and continues — the terminal row is already committed.
 */
export function buildTridentDelivery(
  opts: BuildTridentDeliveryOptions,
): TridentTerminalHook {
  const fallback_channel_kind = opts.channel_kind ?? 'telegram'
  const compose = opts.compose ?? composeTerminalDelivery
  return {
    async onTerminal(run: TridentRun): Promise<void> {
      // Derive the delivery channel from the RUN (#317) so a `/code` build
      // originating on the app-WebSocket surface posts its result back there
      // instead of misrouting to Telegram. Falls back to the build-time
      // default only for a row missing the field (pre-0081 / defensive).
      const channel_kind = run.channel_kind ?? fallback_channel_kind
      const topic = topicForRun(run, channel_kind)
      if (topic === null) return
      const composed = compose(run)
      if (composed === null) return
      const message: OutgoingMessage = { topic, text: composed.text }
      if (composed.inline_choices !== undefined && composed.inline_choices.length > 0) {
        message.inline_choices = composed.inline_choices
      }
      await opts.sink.send(message)
    },
  }
}
