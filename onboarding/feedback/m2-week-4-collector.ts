/**
 * @neutronai/onboarding/feedback — M2 week-4 collector (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 9.4 (Casey-specific qualitative loop)
 * + § 6 S6 line 2187. When the user taps [B] on the Sean Ellis prompt
 * and provides freeform feedback, this collector:
 *
 *   1. Updates the `sean_ellis_responses` row with response_kind +
 *      freeform_text.
 *   2. Appends a markdown entry to the configured feedback file
 *      (`M2_FEEDBACK_PATH`, else `DEFAULT_M2_FEEDBACK_PATH`).
 *      File is APPEND-ONLY — never overwrites prior content.
 *   3. Emits the `onboarding.sean_ellis_response` telemetry event so the
 *      `onboarding_metrics` view aggregates the response.
 *
 * The collector is also the single seam the [A]/[C] taps go through —
 * those record the response_kind without freeform text and skip the
 * markdown append (no qualitative content to capture).
 */

import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import type {
  OnboardingTelemetry,
  SeanEllisResponsePayload,
} from '../telemetry/event-emitter.ts'
import {
  SEAN_ELLIS_PROMPT_OPTIONS,
  SeanEllisStore,
} from '../telemetry/sean-ellis-trigger.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

/**
 * Default M2 feedback path. Resolved under `NEUTRON_HOME` (the owner's Neutron
 * home dir), falling back to the process cwd, so installs get a sensible
 * destination without configuration. The `M2_FEEDBACK_PATH` env override lets
 * tests and custom installs redirect. One append per response.
 */
export const DEFAULT_M2_FEEDBACK_PATH = join(
  process.env.NEUTRON_HOME ?? process.cwd(),
  'feedback',
  'm2-week-4.md',
)

export type M2ResponseKind = SeanEllisResponsePayload['response']

export interface M2FeedbackCollectorDeps {
  db: ProjectDb
  telemetry: OnboardingTelemetry
  /** Override the feedback markdown destination. Reads M2_FEEDBACK_PATH first; defaults to DEFAULT_M2_FEEDBACK_PATH. */
  feedbackPath?: string
  /** Test seam for fs writes. Production wires node:fs append. */
  appendFile?: (path: string, contents: string) => void
  /** Test seam for clock. */
  now?: () => number
}

export interface RecordResponseInput {
  owner_slug: string
  /** The open `sean_ellis_responses.id`; supplied by the inbound callback router. */
  response_id: string
  user_id: string
  /** Tap value the channel adapter delivers; controls what's appended to the markdown file. */
  response_kind: M2ResponseKind
  /** Optional freeform — only set when [B] tap path is followed by a freeform reply. */
  freeform_text?: string
}

export interface RecordResponseResult {
  appended_to_markdown: boolean
  feedbackPath: string
}

export class M2FeedbackCollector {
  private readonly db: ProjectDb
  private readonly telemetry: OnboardingTelemetry
  private readonly feedbackPath: string
  private readonly appendFile: (path: string, contents: string) => void
  private readonly now: () => number

  constructor(deps: M2FeedbackCollectorDeps) {
    this.db = deps.db
    this.telemetry = deps.telemetry
    this.feedbackPath =
      deps.feedbackPath ??
      process.env.M2_FEEDBACK_PATH ??
      DEFAULT_M2_FEEDBACK_PATH
    this.appendFile =
      deps.appendFile ??
      ((path, contents) => {
        const dir = dirname(path)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        appendFileSync(path, contents, { encoding: 'utf8', flag: 'a' })
      })
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Record a Sean Ellis response. Updates the open `sean_ellis_responses`
   * row, appends the markdown entry (only when freeform was provided),
   * and emits the `onboarding.sean_ellis_response` telemetry event.
   */
  async recordResponse(input: RecordResponseInput): Promise<RecordResponseResult> {
    const ts = this.now()
    const store = new SeanEllisStore(this.db)
    await store.recordResponse({
      id: input.response_id,
      response_kind: input.response_kind,
      responded_at: ts,
      ...(input.freeform_text !== undefined ? { freeform_text: input.freeform_text } : {}),
    })

    // Codex r5 P2 fix (2026-05-03): emit the telemetry event BEFORE the
    // markdown append so a file-write failure (bad path / permissions /
    // full disk) cannot suppress the event flow into `gateway_events` /
    // `onboarding_metrics`. The SQL row is already updated; the
    // observability surfaces should reflect that even if the markdown
    // sink temporarily fails.
    const payload: SeanEllisResponsePayload = { response: input.response_kind }
    if (input.freeform_text !== undefined) payload.freeform = input.freeform_text
    await this.telemetry.emit({
      owner_slug: input.owner_slug,
      user_id: input.user_id,
      event: 'onboarding.sean_ellis_response',
      payload,
    })

    let appended = false
    if (input.freeform_text !== undefined && input.freeform_text.trim().length > 0) {
      const entry = formatMarkdownEntry({
        owner_slug: input.owner_slug,
        response_kind: input.response_kind,
        freeform_text: input.freeform_text,
        timestamp_ms: ts,
      })
      this.appendFile(this.feedbackPath, entry)
      appended = true
    }

    return { appended_to_markdown: appended, feedbackPath: this.feedbackPath }
  }

  /**
   * Codex r4 P1: park a [B] tap as `pending_response_kind` without
   * finalizing the row. The follow-up freeform message will finalize via
   * `applyFreeformFollowUp`.
   */
  async markPending(input: {
    owner_slug: string
    response_id: string
    pending_response_kind: M2ResponseKind
  }): Promise<void> {
    const store = new SeanEllisStore(this.db)
    await store.markPending({
      id: input.response_id,
      pending_response_kind: input.pending_response_kind,
    })
  }

  /**
   * Codex r4 P1: finalize a parked [B] tap with the freeform_text the
   * user typed AFTER the tap. Looks up the latest pending row for the
   * (owner, user) pair (or uses the supplied `response_id` for a
   * precise lookup) and finalizes it. Returns null if no pending row
   * was found — the freeform is unbound and the channel-side handler
   * can fall through to the default unprompted-message handler.
   */
  async applyFreeformFollowUp(input: {
    owner_slug: string
    user_id: string
    freeform_text: string
    response_id?: string
  }): Promise<RecordResponseResult | null> {
    const store = new SeanEllisStore(this.db)
    const row =
      input.response_id !== undefined
        ? store.byId({ owner_slug: input.owner_slug, id: input.response_id })
        : store.latestPendingForUser(input.owner_slug, input.user_id)
    if (row === null || row.pending_response_kind === null) return null
    if (row.pending_response_kind === 'no_response') return null
    return this.recordResponse({
      owner_slug: input.owner_slug,
      response_id: row.id,
      user_id: input.user_id,
      response_kind: row.pending_response_kind,
      freeform_text: input.freeform_text,
    })
  }
}

/**
 * Routes an inbound `ButtonChoice` from a Sean Ellis prompt response into
 * the feedback collector. Production wires the channel callback router
 * (Telegram callback_query / app-socket inbound) to call this — the
 * callback only carries `prompt_id`, so the router resolves it back to
 * the open `sean_ellis_responses` row via `SeanEllisStore.byPromptId`.
 *
 * The choice values map to canonical response_kinds via
 * `SEAN_ELLIS_PROMPT_OPTIONS`. Unknown choice values fall through to
 * `null` (the row stays open).
 *
 * Codex r4 P1 fix (2026-05-03): for the [B] (somewhat_disappointed) tap,
 * the freeform explanation arrives asynchronously on a separate inbound.
 * If the [B] tap is recorded immediately (responded_at + final
 * response_kind), the row closes and the freeform never attaches. The
 * router now branches:
 *
 *   - [A] / [C] (no follow-up needed): finalize immediately via
 *     `collector.recordResponse(...)`.
 *   - [B] without `freeform_text` set: park the choice in
 *     `pending_response_kind` via `SeanEllisStore.markPending(...)`. The
 *     row stays open. When the follow-up freeform arrives, the channel
 *     router calls `applySeanEllisFreeform(...)` which finalizes with
 *     the parked kind + the freeform_text.
 *   - [B] with `freeform_text`: finalize immediately (some channels
 *     deliver tap + freeform on the same inbound — we accept both).
 */
export interface SeanEllisChoiceRouterInput {
  owner_slug: string
  user_id: string
  /**
   * The open `sean_ellis_responses.id`. Production looks this up via
   * `SeanEllisStore.byPromptId(owner_slug, choice.prompt_id)` before
   * calling.
   */
  response_id: string
  choice: ButtonChoice
  /** Set when the channel can deliver tap + freeform on a single inbound. */
  freeform_text?: string
}

export type SeanEllisChoiceOutcome =
  | { kind: 'finalized'; result: RecordResponseResult }
  | { kind: 'pending'; pending_response_kind: M2ResponseKind }
  | { kind: 'unknown_choice' }

export async function routeSeanEllisChoice(
  collector: M2FeedbackCollector,
  input: SeanEllisChoiceRouterInput,
): Promise<SeanEllisChoiceOutcome> {
  const response_kind = mapChoiceToResponseKind(input.choice.choice_value)
  if (response_kind === null) return { kind: 'unknown_choice' }

  // [B] without freeform yet → park the choice; do NOT finalize the row.
  if (response_kind === 'somewhat_disappointed' && input.freeform_text === undefined) {
    await collector.markPending({
      owner_slug: input.owner_slug,
      response_id: input.response_id,
      pending_response_kind: response_kind,
    })
    return { kind: 'pending', pending_response_kind: response_kind }
  }

  // [A] / [C], or [B] with freeform on the same inbound → finalize.
  const recordInput: RecordResponseInput = {
    owner_slug: input.owner_slug,
    response_id: input.response_id,
    user_id: input.user_id,
    response_kind,
  }
  if (input.freeform_text !== undefined) recordInput.freeform_text = input.freeform_text
  const result = await collector.recordResponse(recordInput)
  return { kind: 'finalized', result }
}

/**
 * Codex r4 P1 fix: when the user's freeform explanation arrives after a
 * [B] tap, the channel router calls this to finalize the parked row.
 * Looks up the latest pending row for the (owner, user) pair (or by
 * `response_id` if known); finalizes with the parked
 * `pending_response_kind` + the freeform_text. Returns null if no
 * pending row was found.
 */
export interface SeanEllisFreeformInput {
  owner_slug: string
  user_id: string
  freeform_text: string
  /** Optional precise lookup; when omitted, finds the most-recent pending row for the user. */
  response_id?: string
}

export async function applySeanEllisFreeform(
  collector: M2FeedbackCollector,
  input: SeanEllisFreeformInput,
): Promise<RecordResponseResult | null> {
  return collector.applyFreeformFollowUp(input)
}

function mapChoiceToResponseKind(choice_value: string): M2ResponseKind | null {
  for (const opt of SEAN_ELLIS_PROMPT_OPTIONS) {
    if (opt.value === choice_value) return opt.value as M2ResponseKind
  }
  return null
}

/**
 * Markdown entry shape — a separator + an ISO timestamp + project slug + the
 * response kind + the freeform text body. Append-only across all M2 cohort
 * owners so the feedback file accretes per-owner qualitative comments
 * Sam reads in chronological order.
 */
export function formatMarkdownEntry(input: {
  owner_slug: string
  response_kind: M2ResponseKind
  freeform_text: string
  timestamp_ms: number
}): string {
  const iso = new Date(input.timestamp_ms).toISOString()
  return [
    '',
    '---',
    '',
    `## ${iso} — \`${input.owner_slug}\` (${input.response_kind})`,
    '',
    input.freeform_text.trim(),
    '',
  ].join('\n')
}
