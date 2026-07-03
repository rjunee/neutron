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
 * The recognised terminal-failure classes (#352). A build's `failure_reason`
 * (authored by the merge/orchestrator layer) is classified into ONE of these so
 * the chat announce is INTERPRETED — plain language + the specific input the
 * operator must give — instead of a raw git/tool error paste.
 */
export type FailureClass =
  | 'merge-conflict'
  | 'stale-state'
  | 'merge-mechanics'
  | 'review-unresolved'
  | 'hang'
  | 'infra'
  | 'underspecified'
  | 'unknown'

export interface FailureInterpretation {
  klass: FailureClass
  /** One plain-language sentence: what happened, in terms a non-engineer follows.
   *  NEVER contains raw git/tool stderr. */
  summary: string
  /** The SPECIFIC decision/input needed to move the build forward. */
  input_needed: string
}

/** True when the reason is one of OUR authored, plain-language escalation
 *  questions (from `merge.ts` / `conflict-resolver.ts`) rather than a git error
 *  message — those are already safe + specific, so we surface them verbatim. */
function isAuthoredConflictQuestion(reason: string): boolean {
  const r = reason.toLowerCase()
  return (
    r.includes("couldn't auto-resolve") ||
    r.includes('hit conflicts across') ||
    r.includes('needs a manual') ||
    r.includes('needs your call') ||
    (r.includes('conflict') && !r.includes('failed:'))
  )
}

/**
 * #352 — INTERPRET a terminal failure into a plain-language summary + the specific
 * input needed, NEVER a raw error paste. Pure + deterministic (a bounded classifier
 * over the authored `failure_reason` — no LLM, so it is reliable + unit-testable):
 * every recoverable class (stale merge/rebase state, transient infra) is already
 * auto-recovered upstream in the merge path (`recoverStaleGitState`) or the #342
 * Forge conflict-resolver, so a run that reaches HERE is genuinely unrecoverable and
 * needs a human. Raw git stderr (a `TridentMergeError`-wrapped `merge failed: git …`
 * message) is DISCARDED — the operator sees only what happened + what to do.
 */
export function interpretFailure(run: TridentRun): FailureInterpretation {
  const reason = (run.failure_reason ?? '').trim()
  const r = reason.toLowerCase()
  const branch = run.branch !== null ? `\`${run.branch}\`` : 'the build branch'
  const retry = 'Reply to retry the build, or take it from here manually.'

  // Suspected agent hang / stalled inner workflow — already a plain reason.
  if (r.includes('suspected agent hang') || r.includes('no progress for') || r.includes('stalled')) {
    return {
      klass: 'hang',
      summary: 'The build stopped making progress and I stopped it before it could hang indefinitely.',
      input_needed: `${retry} (its last progress is saved on ${branch}.)`,
    }
  }

  // Argus still had blocking findings after the round budget — a review outcome.
  if (r.includes('without argus approve') || r.includes('request_changes') || r.includes('exhausted')) {
    return {
      klass: 'review-unresolved',
      summary: `The build ran its review rounds but the reviewer still had blocking findings, so I did not merge it.`,
      input_needed: `${branch} is saved for you to review — reply to send it back for another fix pass, or take it over.`,
    }
  }

  // An AMBIGUOUS content conflict the resolver escalated — the reason IS the
  // authored, specific question. Surface it (plain by construction, no stderr).
  if (isAuthoredConflictQuestion(reason) && !r.startsWith('merge failed')) {
    return {
      klass: 'merge-conflict',
      summary:
        'The build finished, but two changes edited the same code in ways I could not reconcile automatically.',
      input_needed: reason,
    }
  }

  // A stale shared-checkout index surfaced DIRECTLY (a bare git error, not wrapped
  // in a `merge failed:` TridentMergeError — those are the mechanics class below).
  // Should be self-healed now, but classified for completeness — never surface the
  // raw "resolve your current index first".
  if (
    !r.startsWith('merge failed') &&
    (r.includes('resolve your current index') || r.includes('merge_head') || r.includes('unmerged'))
  ) {
    return {
      klass: 'stale-state',
      summary:
        'The build finished but the shared checkout was left mid-merge by an earlier build, which blocked this merge.',
      input_needed: `${retry} (I clean this up automatically now, so a retry should go through.)`,
    }
  }

  // Any other git-mechanics failure landing the branch — DISCARD the raw stderr.
  if (r.startsWith('merge failed') || r.includes('git ') || r.includes('rebase') || r.includes('checkout')) {
    return {
      klass: 'merge-mechanics',
      summary: 'The build finished but a git step failed while landing the branch, so it was not merged.',
      input_needed: `${branch} is saved. ${retry}`,
    }
  }

  // The task itself was too vague to act on.
  if (r.includes('underspecified') || r.includes('specified enough')) {
    return {
      klass: 'underspecified',
      summary: 'I could not start this build because the task was not specific enough to act on.',
      input_needed: reason.length > 0 ? reason : 'Add a short description or a design doc and dispatch it again.',
    }
  }

  // Couldn't start / internal / garbled result — an infrastructure failure.
  if (
    r.includes('fire failed') ||
    r.includes('could not prepare') ||
    r.includes('backend') ||
    r.includes('garbled') ||
    r.includes('missing') ||
    r.includes('provenance')
  ) {
    return {
      klass: 'infra',
      summary: 'The build hit an internal error and could not finish.',
      input_needed: retry,
    }
  }

  // Fallback — a reason we don't specifically classify. Keep it plain: show the
  // authored reason if it's short + question-like, else a generic line. Still
  // never a multi-line raw paste.
  const oneLine = reason.replace(/\s+/g, ' ').trim()
  const safe = oneLine.length > 0 && oneLine.length <= 200 && !oneLine.includes('failed:')
  return {
    klass: 'unknown',
    summary: safe && oneLine.length > 0 ? oneLine : 'The build did not complete.',
    input_needed: `${branch} is saved. ${retry}`,
  }
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
      // #352 — INTERPRET the failure into plain language + the specific input
      // needed, never a raw git/tool error paste. The recoverable classes were
      // already auto-recovered upstream (stale merge state, the #342 conflict
      // resolver), so a run reaching here is genuinely unrecoverable.
      const interp = interpretFailure(run)
      const trail =
        run.merge_mode === 'pr' && run.pr !== null
          ? `\nPR #${run.pr} left open for review.`
          : ''
      return { text: `❌ \`${slug}\` — ${interp.summary}\n${task}\n${interp.input_needed}${trail}` }
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
