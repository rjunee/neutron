/**
 * @neutronai/onboarding/telemetry — Sean Ellis 4-week trigger (P2 S6).
 *
 * Per docs/plans/P2-onboarding.md § 5.3 (Sean Ellis 4-week trigger) +
 * § 9.4 (Casey-specific qualitative loop) + § 6 S6 line 2184.
 *
 * Master-plan §2 Phase 3 PMF question — fires 4 weeks after the user's
 * `onboarding.completed_at` event. The cron handler:
 *
 *   1. Reads onboarding_metrics for completed_at.
 *   2. If `now - completed_at >= 4 weeks` AND no row exists yet in
 *      `sean_ellis_responses`, emits the survey button-prompt to the
 *      user's onboarding topic and inserts a `no_response` placeholder
 *      row (idempotency guard against repeat fires).
 *   3. The `recordResponse(...)` helper applies the user's tap +
 *      optional freeform; the [B] tap path is wired through the
 *      m2-week-4 feedback collector.
 *
 * Cron registration shape:
 *   - `name`: `onboarding.sean_ellis_survey_<owner_slug>`
 *   - `handler`: 'onboarding.sean_ellis_survey'
 *   - `schedule`: { kind: 'interval_ms', interval_ms: 1h }
 *
 * The interval-shaped schedule lets the in-process scheduler tick this
 * hourly; production wires it through systemd OnCalendar as well so the
 * instance doesn't need the in-process scheduler running. Both paths
 * share the same handler.
 */

import { randomUUID } from 'node:crypto'
import {
  buildButtonPrompt,
  type ButtonPrompt,
  type ButtonOption,
} from '@neutronai/channels/button-primitive.ts'
import type { CronHandler, CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type {
  OnboardingTelemetry,
  SeanEllisResponsePayload,
} from './event-emitter.ts'

/** Four weeks expressed in unix-ms — the locked PMF survey window. */
export const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000

/** Default cron tick — once per hour is sufficient for a 4-week trigger. */
export const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000

export const SEAN_ELLIS_HANDLER_NAME = 'onboarding.sean_ellis_survey'

export const SEAN_ELLIS_PROMPT_BODY =
  'Hey, it\'s been 4 weeks. How would you feel if you could no longer use Neutron? ' +
  '(And — what\'s the ONE thing that\'s not working? Tap [B] to tell me.)'

export const SEAN_ELLIS_PROMPT_OPTIONS: ReadonlyArray<{
  label: string
  body: string
  value: string
  metadata?: ButtonOption['metadata']
}> = [
  {
    label: 'A',
    body: 'Very disappointed (no real issues)',
    value: 'very_disappointed',
    metadata: { action_kind: 'confirm' },
  },
  {
    label: 'B',
    body: 'Somewhat disappointed — let me tell you',
    value: 'somewhat_disappointed',
    metadata: { action_kind: 'edit' },
  },
  {
    label: 'C',
    body: 'Not disappointed — ask later',
    value: 'not_disappointed',
    metadata: { action_kind: 'skip' },
  },
]

/** What `WowChannelAdapter`-shaped consumers see on the trigger fire. */
export interface SeanEllisChannel {
  emitPrompt(input: { prompt: ButtonPrompt; topic_id: string }): Promise<{ prompt_id: string }>
}

export interface SeanEllisRow {
  id: string
  project_slug: string
  user_id: string
  prompt_emitted_at: number
  responded_at: number | null
  response_kind:
    | 'very_disappointed'
    | 'somewhat_disappointed'
    | 'not_disappointed'
    | 'no_response'
  freeform_text: string | null
  /** Codex r4 P1 — the button-prompt id this row was emitted with;
   *  channel callbacks only carry prompt_id, so this is the lookup key. */
  prompt_id: string | null
  /** Codex r4 P1 — for [B] taps, the kind to finalize with once the
   *  follow-up freeform message arrives. NULL for unprompted rows. */
  pending_response_kind: SeanEllisRow['response_kind'] | null
}

interface SeanEllisDbRow {
  id: string
  project_slug: string
  user_id: string
  prompt_emitted_at: number
  responded_at: number | null
  response_kind: SeanEllisRow['response_kind']
  freeform_text: string | null
  prompt_id: string | null
  pending_response_kind: SeanEllisRow['response_kind'] | null
}

/**
 * The store + helpers around `sean_ellis_responses`. Kept narrow on purpose —
 * the rest of the pipeline (admin observability, m2-week-4-collector)
 * read via `latestForOwner` / `recordResponse`.
 */
export class SeanEllisStore {
  constructor(private readonly db: ProjectDb) {}

  async insertOpen(input: {
    owner_slug: string
    user_id: string
    prompt_emitted_at: number
    /** Codex r4 P1 — store the prompt id so channel callbacks can find this row. */
    prompt_id?: string
    uuid?: () => string
  }): Promise<{ id: string }> {
    const id = (input.uuid ?? randomUUID)()
    await this.db.run(
      `INSERT INTO sean_ellis_responses
         (id, project_slug, user_id, prompt_emitted_at, responded_at,
          response_kind, freeform_text, prompt_id, pending_response_kind)
       VALUES (?, ?, ?, ?, NULL, 'no_response', NULL, ?, NULL)`,
      [
        id,
        input.owner_slug,
        input.user_id,
        input.prompt_emitted_at,
        input.prompt_id ?? null,
      ],
    )
    return { id }
  }

  private static readonly SELECT_COLUMNS =
    `id, project_slug, user_id, prompt_emitted_at, responded_at,
     response_kind, freeform_text, prompt_id, pending_response_kind`

  latestForOwner(owner_slug: string): SeanEllisRow | null {
    const row = this.db
      .get<SeanEllisDbRow, [string]>(
        `SELECT ${SeanEllisStore.SELECT_COLUMNS}
           FROM sean_ellis_responses
          WHERE project_slug = ?
          ORDER BY prompt_emitted_at DESC
          LIMIT 1`,
        [owner_slug],
      )
    return row ?? null
  }

  /**
   * Per-(instance, user) lookup — production uses this so a workspace instance
   * with multiple onboarded members surveys each member exactly once.
   */
  latestForUser(owner_slug: string, user_id: string): SeanEllisRow | null {
    const row = this.db
      .get<SeanEllisDbRow, [string, string]>(
        `SELECT ${SeanEllisStore.SELECT_COLUMNS}
           FROM sean_ellis_responses
          WHERE project_slug = ? AND user_id = ?
          ORDER BY prompt_emitted_at DESC
          LIMIT 1`,
        [owner_slug, user_id],
      )
    return row ?? null
  }

  /**
   * Codex r4 P1: lookup the open row for a given button-prompt id. The
   * channel callback router calls this when an inbound `ButtonChoice`
   * arrives — only `prompt_id` is on the wire, so the row must be
   * recoverable by it. Instance-scoped to keep workspace instances isolated.
   */
  byPromptId(owner_slug: string, prompt_id: string): SeanEllisRow | null {
    const row = this.db
      .get<SeanEllisDbRow, [string, string]>(
        `SELECT ${SeanEllisStore.SELECT_COLUMNS}
           FROM sean_ellis_responses
          WHERE project_slug = ? AND prompt_id = ?
          LIMIT 1`,
        [owner_slug, prompt_id],
      )
    return row ?? null
  }

  byId(input: { owner_slug: string; id: string }): SeanEllisRow | null {
    const row = this.db
      .get<SeanEllisDbRow, [string, string]>(
        `SELECT ${SeanEllisStore.SELECT_COLUMNS}
           FROM sean_ellis_responses
          WHERE project_slug = ? AND id = ?
          LIMIT 1`,
        [input.owner_slug, input.id],
      )
    return row ?? null
  }

  /**
   * Codex r4 P1: find the latest row for a (instance, user) pair that's in
   * the "[B] tapped, awaiting freeform" state — `pending_response_kind`
   * IS NOT NULL AND `responded_at` IS NULL. The freeform follow-up router
   * uses this when no precise `response_id` is supplied (the common
   * case: Telegram callback delivers the tap, the next freeform inbound
   * is a separate update with no prompt_id reference).
   */
  latestPendingForUser(owner_slug: string, user_id: string): SeanEllisRow | null {
    const row = this.db
      .get<SeanEllisDbRow, [string, string]>(
        `SELECT ${SeanEllisStore.SELECT_COLUMNS}
           FROM sean_ellis_responses
          WHERE project_slug = ? AND user_id = ?
            AND pending_response_kind IS NOT NULL
            AND responded_at IS NULL
          ORDER BY prompt_emitted_at DESC
          LIMIT 1`,
        [owner_slug, user_id],
      )
    return row ?? null
  }

  async recordResponse(input: {
    id: string
    response_kind: SeanEllisResponsePayload['response']
    responded_at: number
    freeform_text?: string | null
  }): Promise<void> {
    await this.db.run(
      `UPDATE sean_ellis_responses
          SET response_kind = ?, responded_at = ?, freeform_text = ?,
              pending_response_kind = NULL
        WHERE id = ?`,
      [
        input.response_kind,
        input.responded_at,
        input.freeform_text ?? null,
        input.id,
      ],
    )
  }

  /**
   * Codex r4 P1: a [B] tap is recorded as PENDING — `responded_at` stays
   * NULL, `response_kind` stays 'no_response', and the chosen kind is
   * parked in `pending_response_kind`. When the follow-up freeform
   * arrives, `recordResponse(...)` finalizes the row with the pending
   * kind + the freeform_text. If no freeform ever arrives, the row
   * stays open + the cron's idempotency guard treats it as already-
   * surveyed.
   */
  async markPending(input: {
    id: string
    pending_response_kind: SeanEllisResponsePayload['response']
  }): Promise<void> {
    await this.db.run(
      `UPDATE sean_ellis_responses
          SET pending_response_kind = ?
        WHERE id = ?`,
      [input.pending_response_kind, input.id],
    )
  }
}

export interface SeanEllisHandlerDeps {
  db: ProjectDb
  telemetry: OnboardingTelemetry
  channel: SeanEllisChannel
  /**
   * Resolves the topic_id for a given (owner_slug, user_id) so the
   * survey lands on that user's onboarding topic. Returns null when the
   * topic can't be resolved (e.g. the user has since left the instance);
   * the handler skips that user without erroring.
   */
  resolveContext: (input: {
    owner_slug: string
    user_id: string
  }) => Promise<{ topic_id: string } | null>
  /** Window for "is it 4 weeks since completed_at" — defaults to FOUR_WEEKS_MS. */
  surveyWindowMs?: number
  /** Test seam. */
  now?: () => number
  uuid?: () => string
}

interface CompletedRow {
  user_id: string
  completed_at: number | null
}

/**
 * Build the Sean Ellis cron handler for an instance. The returned function
 * is ready to register against `CronHandlerRegistry` under
 * `SEAN_ELLIS_HANDLER_NAME`.
 */
export function buildSeanEllisHandler(deps: SeanEllisHandlerDeps): CronHandler {
  const now = deps.now ?? ((): number => Date.now())
  const window = deps.surveyWindowMs ?? FOUR_WEEKS_MS
  const store = new SeanEllisStore(deps.db)

  return async (ctx) => {
    // Codex r2 P1 fix (2026-05-03): per-instance DBs may host multiple
    // onboarded users (workspace instances). Iterate over EVERY completed
    // onboarding past the 4-week window AND missing a sean_ellis row,
    // not just the most recent. Otherwise a newer completion masks
    // older eligible users (Codex r2 example: A completed 5w ago, B
    // completed 1w ago → handler used to see B, skip 'not_yet', and A
    // never gets surveyed).
    const completedRows = deps.db
      .all<CompletedRow, [string]>(
        `SELECT user_id, completed_at
           FROM onboarding_metrics
          WHERE project_slug = ? AND completed_at IS NOT NULL
          ORDER BY completed_at ASC`,
        [ctx.owner_slug],
      )

    if (completedRows.length === 0) {
      return { status: 'skipped', detail: 'no_completed_onboarding' }
    }

    const ts = now()
    const eligible: Array<{ user_id: string; completed_at: number; elapsed: number }> = []
    let skipped_in_window = 0
    let skipped_already_emitted = 0
    for (const row of completedRows) {
      if (row.completed_at === null) continue
      const elapsed = ts - row.completed_at
      if (elapsed < window) {
        skipped_in_window += 1
        continue
      }
      const existing = store.latestForUser(ctx.owner_slug, row.user_id)
      if (existing !== null) {
        skipped_already_emitted += 1
        continue
      }
      eligible.push({ user_id: row.user_id, completed_at: row.completed_at, elapsed })
    }

    if (eligible.length === 0) {
      if (skipped_in_window > 0 && skipped_already_emitted === 0) {
        return {
          status: 'skipped',
          detail: `not_yet_${skipped_in_window}_users_in_window`,
        }
      }
      if (skipped_already_emitted > 0 && skipped_in_window === 0) {
        return { status: 'skipped', detail: 'already_emitted' }
      }
      return {
        status: 'skipped',
        detail: `no_eligible_users_in_window=${skipped_in_window}_already=${skipped_already_emitted}`,
      }
    }

    const emitted_ids: string[] = []
    for (const { user_id, elapsed } of eligible) {
      const context = await deps.resolveContext({ owner_slug: ctx.owner_slug, user_id })
      if (context === null) {
        // Skip this user without aborting the whole tick — other users
        // in the same instance may still be resolvable.
        continue
      }
      const prompt = buildButtonPrompt({
        body: SEAN_ELLIS_PROMPT_BODY,
        options: SEAN_ELLIS_PROMPT_OPTIONS.map((o) => {
          const opt: {
            label: string
            body: string
            value: string
            metadata?: ButtonOption['metadata']
          } = { label: o.label, body: o.body, value: o.value }
          if (o.metadata !== undefined) opt.metadata = o.metadata
          return opt
        }),
        allow_freeform: true,
        idempotency: {
          project_slug: ctx.owner_slug,
          topic_id: context.topic_id,
          seed: `sean-ellis-week-4:${user_id}`,
        },
        ...(deps.uuid !== undefined ? { uuid: deps.uuid } : {}),
      })

      // Codex r5 P1 fix (2026-05-03):
      //   1. Emit the prompt FIRST so the actual delivered prompt_id
      //      (which may differ from `prompt.prompt_id` when the channel
      //      adapter dedupes via idempotency_key) is the one we store.
      //   2. Use that returned prompt_id when inserting the
      //      `sean_ellis_responses` row.
      // The build → emit → insert order mirrors the button-store contract
      // where the channel adapter is the source of truth for the
      // delivered prompt_id.
      const emitResult = await deps.channel.emitPrompt({ prompt, topic_id: context.topic_id })
      const delivered_prompt_id =
        typeof emitResult.prompt_id === 'string' && emitResult.prompt_id.length > 0
          ? emitResult.prompt_id
          : prompt.prompt_id

      const emitted_at = now()
      const { id } = await store.insertOpen({
        owner_slug: ctx.owner_slug,
        user_id,
        prompt_emitted_at: emitted_at,
        // Codex r4 + r5 P1: persist the channel-delivered prompt_id so the
        // callback router can resolve `prompt_id` → `sean_ellis_responses.id`.
        prompt_id: delivered_prompt_id,
        ...(deps.uuid !== undefined ? { uuid: deps.uuid } : {}),
      })

      await deps.telemetry.emit({
        owner_slug: ctx.owner_slug,
        user_id,
        event: 'onboarding.sean_ellis_prompt_emitted',
        payload: {
          prompt_id: prompt.prompt_id,
          weeks_since_completed: Math.round(elapsed / (7 * 24 * 60 * 60 * 1000)),
        },
      })
      emitted_ids.push(id)
    }

    if (emitted_ids.length === 0) {
      return { status: 'skipped', detail: 'no_topic_resolved' }
    }

    return {
      status: 'ok',
      detail: `emitted_${emitted_ids.length}_users_at_${now()}`,
    }
  }
}

/**
 * Per-instance cron job definition. Production wires this into the per-
 * instance CronJobRegistry alongside the rest of the onboarding crons.
 */
export function buildSeanEllisJob(input: {
  owner_slug: string
  interval_ms?: number
}): CronJobDef {
  // Cron job name budget is 64 chars (validateJobName /^[a-z][a-z0-9-]{0,63}$/);
  // 'sean-ellis-' (11) leaves 53 chars for the instance slug. The registry's
  // own slug allocation is ≤ 50 chars (instance-provisioning/allocate-slug.ts),
  // so this fits with margin.
  return {
    name: `sean-ellis-${input.owner_slug}`,
    description: `Sean Ellis 4-week PMF survey trigger for ${input.owner_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? DEFAULT_CHECK_INTERVAL_MS,
    },
    handler: SEAN_ELLIS_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 30_000,
  }
}

/**
 * Register the Sean Ellis cron + handler against the per-instance
 * `CronJobRegistry` + `CronHandlerRegistry`. The per-instance gateway boot
 * calls this after the onboarding orchestrator finishes provisioning an
 * instance; the cron starts ticking on the next `CronScheduler.start()`
 * pass and fires the survey 4 weeks after `onboarding.completed`.
 *
 * Idempotent against re-register attempts: throws via the registries'
 * native validation (`'cron job already registered'` /
 * `'cron handler already registered'`) — callers should pre-check via
 * `jobs.get(name)` if a re-register path is intentional. Production uses
 * a per-instance boot that runs this exactly once per instance slug.
 *
 * Codex r1 P1 fix (2026-05-03): the bare `buildSeanEllisHandler` /
 * `buildSeanEllisJob` factories shipped in the first pass of S6 but no
 * code path glued them into the runtime registries. This helper closes
 * that gap so the production scheduler actually fires the survey.
 */
export function registerSeanEllisCron(input: {
  owner_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  /** The handler that drives the actual emit; built via `buildSeanEllisHandler`. */
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const job = input.interval_ms !== undefined
    ? buildSeanEllisJob({ owner_slug: input.owner_slug, interval_ms: input.interval_ms })
    : buildSeanEllisJob({ owner_slug: input.owner_slug })
  input.jobs.register(job)
  if (input.handlers.get(SEAN_ELLIS_HANDLER_NAME) === undefined) {
    input.handlers.register(SEAN_ELLIS_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}
