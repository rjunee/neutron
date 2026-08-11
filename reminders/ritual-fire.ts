/**
 * @neutronai/reminders — the ritual FIRE PLAN.
 *
 * A ritual is a REMINDER. It fires down the SAME path every other reminder
 * fires down: the tick loop hands the due row to `ReminderDispatcher.dispatch`,
 * the dispatcher composes one turn on the owner's normal warm session, and posts
 * the result through the one delivery seam. There is no second execution path,
 * no second substrate, and no branch in `reminders/tick.ts`.
 *
 * WHAT THIS MODULE IS. The one thing a ritual genuinely differs in is WHERE ITS
 * PROMPT COMES FROM and WHAT MUST BE RECORDED ABOUT THE RUN — an approved prompt
 * file plus a durable `code_ritual_runs` ledger entry, versus a stored nudge
 * message and no ledger. So this module answers exactly one question for the
 * dispatcher — "what should this row compose from, and what has to be written
 * down about it?" — as DATA ({@link RitualFireDecision}) plus a settle hook. It
 * owns no substrate, spawns nothing, and never posts; the dispatcher does all
 * three, identically for a ritual and for a nudge.
 *
 * WHY IT LOOKS LIKE THIS (ISSUES #504, SPEC Decisions Log 2026-08-05). The
 * previous design routed a `ritual_id` row to a separate executor that spawned a
 * fresh ephemeral `cc-ritual-*` REPL. That REPL wired NO tool bridge, so the
 * morning brief could not read the owner's calendar: granting
 * `mcp__neutron__calendar_list` validated and then failed, because the MCP server
 * it named did not exist inside the sandbox. The lane built to make rituals SAFE
 * was the lane that made them USELESS. The owner rejected it outright — *"Rituals
 * shouldn't be a special case in a private REPL… The morning brief should just be
 * a regular reminder in the general chat, with access to everything general has
 * access to."*
 *
 * WHERE THE SECURITY WENT. The sandbox is gone, so the APPROVAL GATE is the only
 * boundary — which is where the 2026-07-20 decision had already put the security
 * property for registration. Everything load-bearing survives and is exercised
 * here on every single fire:
 *   - {@link validateRitualFire} still runs FAIL-CLOSED (unknown id / missing or
 *     oversized prompt / unapproved / an approval store that THROWS ⇒ SKIP), and
 *     a skip lands a durable `code_ritual_runs` 'skipped' row and composes
 *     NOTHING;
 *   - the approval grant is CONTENT-HASH-BOUND and re-checked at every fire, so
 *     an edited prompt file drops approval by design;
 *   - `RITUAL_ID_RE` and the non-empty `tool_surface` pin (#361's toolless class)
 *     are enforced by the registry that this module reads;
 *   - the `code_ritual_runs` ledger records the whole chain — running → finished /
 *     failed — so a background failure is answerable without logs.
 *
 * ⚠️ `tool_surface` IS NOW AN APPROVAL DECLARATION, NOT A RUNTIME GRANT, and that
 * is a MECHANICAL consequence rather than a preference. A ritual composes on the
 * owner's warm pooled session, and that session's `--tools` allow-list is fixed
 * at SPAWN: the persistent-REPL reuse guard EVICTS AND RESPAWNS a warm child
 * whose requested surface differs from the one it was spawned with
 * (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`). Passing a
 * per-ritual surface would therefore not restrict the ritual — it would destroy
 * and rebuild the owner's live chat REPL on every fire, and leave the NEXT chat
 * turn to evict it right back. So `tool_surface` is what the owner is SHOWN and
 * what the approval hash BINDS; it is not a sandbox, and no code here pretends
 * otherwise. This is the accepted consequence the owner signed off on: a ritual
 * firing into the warm session can do anything that session can.
 */

import { createLogger } from '@neutronai/logger'
import type { ApprovalManager } from '@neutronai/tools/approval.ts'

import type { Reminder } from './store.ts'
import {
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  validateRitualFire,
  type RitualApprovalCheck,
  type RitualFireSkipReason,
  type RitualRegistry,
} from './rituals.ts'
import {
  computeRitualContentHash,
  createRitualApprovalCheck,
  ritualCadenceString,
} from './ritual-approval.ts'
import { MAX_RITUAL_FAILURE_REASON_CHARS, type RitualRunStore } from './ritual-runs.ts'
import {
  RITUAL_ESCALATION_CONSECUTIVE_FAILURES,
  formatRitualCompletionFallback,
  formatRitualEscalationNotice,
  formatRitualFailureNotice,
  formatRitualUnplannableNotice,
  shouldEscalate,
} from './ritual-delivery.ts'

const log = createLogger('ritual-fire')


/**
 * Upper bound on a composed ritual body. A morning brief is a digest, not an
 * essay, but it is far longer than the 512-token nudge ceiling.
 */
export const RITUAL_MAX_TOKENS = 4096

/** What the dispatcher must record + deliver once a ritual turn has settled. */
export interface RitualFirePlan {
  ritual_id: string
  /** The `code_ritual_runs` row id this fire is recorded under. */
  run_id: string
  /** The approved prompt bytes — composed as the turn's message. */
  prompt: string
  /**
   * The ritual's DECLARED tool surface. Carried so a caller can log/inspect what
   * the owner approved. It is deliberately NOT applied as the turn's `spec.tools`
   * — see the module header on the warm-session reuse guard.
   */
  declared_tool_surface: readonly string[]
  /** No success post when true (failure notices still post). */
  silent: boolean
  /**
   * Close the ledger for this fire and return any notice bodies the dispatcher
   * should post (failure notice, plus a once-per-streak escalation). Returns an
   * empty array on success. NEVER throws — the durable row is the record, and a
   * bookkeeping fault must not turn a delivered ritual into a retried one.
   */
  settle(
    outcome: { status: 'finished'; body: string } | { status: 'failed'; detail: string },
  ): Promise<string[]>
}

/**
 * What the dispatcher should do with a due row. Deliberately THREE-valued: a
 * ritual that refuses fail-closed is NOT the same as a row that has nothing to
 * fire, because the former must post nothing while still having written a durable
 * 'skipped' row.
 */
export type RitualFireDecision =
  /** Not a ritual — dispatch as an ordinary nudge. */
  | { kind: 'nudge' }
  /** Refused fail-closed. A durable 'skipped' row landed. Compose + post nothing. */
  | { kind: 'skipped'; ritual_id: string; reason: RitualFireSkipReason }
  /** Fire it: compose `plan.prompt` on the normal session, post, then settle. */
  | { kind: 'fire'; plan: RitualFirePlan }

/**
 * The seam the dispatcher consumes. One method, so the dispatcher has ONE
 * question to ask per due row and no knowledge of rituals beyond the answer.
 */
export interface RitualFirePlanner {
  plan(reminder: Reminder): Promise<RitualFireDecision>
}

export interface RitualFirePlannerDeps {
  /** The ritual registry (fire-time validation + prompt read). */
  registry: RitualRegistry
  /** The approval manager — the content-hash approval checker source. */
  approvals: ApprovalManager
  /** Owning instance slug (durable run rows + approval scope). */
  project_slug: string
  /** The sole `code_ritual_runs` writer. */
  runs: RitualRunStore
  /** Approval-checker factory seam (tests). Defaults to `createRitualApprovalCheck`. */
  build_approval_check?: (cadence: string) => RitualApprovalCheck
  /** run_id factory (test seam). */
  mint_run_id?: () => string
  /** Now-injection (test seam). */
  now?: () => number
}

function mintId(mint: (() => string) | undefined): string {
  if (mint !== undefined) return mint()
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `rr-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * The one non-'nudge' path a ritual takes, as a plan the dispatcher executes.
 *
 * A NULL planner is not offered and there is no permissive default anywhere in
 * this module. What a composition that wires NO planner does with a ritual row is
 * the dispatcher's decision, and it used to be the wrong one: it dispatched the row
 * as an ORDINARY NUDGE on the reasoning — written here, and wrong — that "a ritual
 * row's message is its human label". It is not. It is the dispatch token
 * `ritual:<id>` (`reminders/ritual-registration.ts`), so the nudge path composed
 * that token as literal intent and the owner's lock screen read `ritual:kaizen`.
 * The prompt was indeed never composed, which is what made the claim sound safe;
 * the NOTIFICATION was the unprotected half. The dispatcher now refuses such a row
 * outright, keyed on the `ritual_id` COLUMN, and tells the owner the occurrence was
 * skipped ({@link formatRitualUnplannableNotice}) rather than consuming it in
 * silence.
 */
export function buildRitualFirePlanner(deps: RitualFirePlannerDeps): RitualFirePlanner {
  const now = deps.now ?? Date.now

  /** Land a durable 'skipped' row. Best-effort: the decision stands either way. */
  async function recordSkip(
    reminder: Reminder,
    ritual_id: string,
    reason: RitualFireSkipReason,
  ): Promise<void> {
    try {
      await deps.runs.insertSkipped({
        run_id: mintId(deps.mint_run_id),
        ritual_id,
        reminder_id: reminder.id,
        project_slug: deps.project_slug,
        skip_reason: reason,
        now_ms: now(),
      })
    } catch (err) {
      log.error('ritual_skip_row_failed', {
        reminder: reminder.id,
        ritual_id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    async plan(reminder: Reminder): Promise<RitualFireDecision> {
      const ritual_id = reminder.ritual_id
      if (ritual_id === null) return { kind: 'nudge' }

      const cadence = ritualCadenceString(reminder)
      const checker =
        deps.build_approval_check?.(cadence) ??
        createRitualApprovalCheck({
          manager: deps.approvals,
          project_slug: deps.project_slug,
          cadence,
        })

      // FAIL-CLOSED validation. Unknown id / missing-or-oversized prompt /
      // unapproved / an approval store that THREW all land here as a skip, and a
      // skip composes NOTHING. This is the gate that the whole security model now
      // rests on, so it runs FIRST and its verdict is final.
      const verdict = await validateRitualFire(deps.registry, checker, ritual_id)
      if (!verdict.ok) {
        await recordSkip(reminder, ritual_id, verdict.reason)
        return { kind: 'skipped', ritual_id, reason: verdict.reason }
      }

      const def = verdict.def
      // A 'project'-scoped ritual still FAILS CLOSED. The old reason was
      // write-containment; the reason now is simply that there is nothing to
      // honour the scope WITH — a ritual composes on the owner's session, whose
      // cwd is the instance root, so a 'project' scope would be a promise the
      // runtime cannot keep. Refusing beats silently running it instance-wide
      // under a label that says otherwise (the Argus over-grant class). All three
      // bundled defs are scope:'instance', so this is a forward guard.
      if (def.scope !== 'instance') {
        log.info('ritual_fire_skip', {
          reminder: reminder.id,
          ritual_id,
          reason: 'unsupported_scope',
          scope: def.scope,
        })
        await recordSkip(reminder, ritual_id, 'unsupported_scope')
        return { kind: 'skipped', ritual_id, reason: 'unsupported_scope' }
      }

      const content_hash = computeRitualContentHash({
        prompt: verdict.prompt,
        tool_surface: def.tool_surface,
        scope: def.scope,
        cadence,
        model_tier: RITUAL_MODEL_TIER,
        timeout_ms: RITUAL_TIMEOUT_MS,
      })
      const run_id = mintId(deps.mint_run_id)

      // The durable 'running' row is written BEFORE the turn, so a crash mid-turn
      // leaves an inspectable orphan the boot reap can settle rather than an
      // occurrence that vanished with no record. `subagent_run_id` is OMITTED
      // (NULL): there is no subagent — the whole point of #504 — and writing the
      // run's own id there again would fabricate a cross-reference to a surface
      // that no longer exists.
      //
      // An insert failure is NOT swallowed. It is the one bookkeeping fault that
      // must stop the fire: composing anyway would put a ritual in front of the
      // owner with nothing recorded about it, which is the data-loss class the
      // ledger exists to prevent. Throwing here surfaces to the dispatcher, which
      // reverts the tick's claim so the occurrence retries on the next tick.
      await deps.runs.insertRunning({
        run_id,
        ritual_id,
        reminder_id: reminder.id,
        project_slug: deps.project_slug,
        content_hash,
        now_ms: now(),
      })

      return {
        kind: 'fire',
        plan: {
          ritual_id,
          run_id,
          prompt: verdict.prompt,
          declared_tool_surface: def.tool_surface,
          silent: def.silent,
          async settle(outcome): Promise<string[]> {
            const status = outcome.status
            try {
              await deps.runs.markTerminal({
                run_id,
                status,
                ended_at_ms: now(),
                ...(status === 'finished'
                  ? { output_summary: outcome.body }
                  : // The CAUSE, verbatim from the composition turn, capped to the
                    // column budget. No disposition prefix and no placeholder: the
                    // old lane wrote `"retry exhausted after 1 attempts: failed"`,
                    // whose inner cause was the literal word `failed`, and that made
                    // a real failure undiagnosable from the ledger (ISSUES #506).
                    { failure_reason: outcome.detail.slice(0, MAX_RITUAL_FAILURE_REASON_CHARS) }),
              })
            } catch (err) {
              log.error('ritual_run_terminal_persist_failed', {
                run_id,
                status,
                error: err instanceof Error ? err.message : String(err),
              })
            }
            if (status === 'finished') return []

            // Failure surfacing. A silently-failing morning brief is
            // indistinguishable from a morning brief that was never scheduled, so
            // every failure posts exactly one one-line notice, and a third
            // consecutive failure adds one escalation — once per streak, as a pure
            // rule over the recent terminal rows (no new state). Guarded: the
            // durable row above is the record, and a read failure here must not
            // cost the notice.
            // ISSUES #506, SECOND HALF. The ledger reason is no longer a tautology
            // and the owner now gets a notice — but a failed ritual STILL produced
            // no log line naming itself, which is the other half of what made the
            // 2026-08-05 `evening-wrap` failure undiagnosable: `journalctl` over the
            // whole window matched ZERO lines for `ritual|evening|error|fail`, while
            // a control grep proved 84 lines existed, so the service was talking and
            // the failure simply said nothing. The four pre-existing log calls in
            // this file cover persist failures and SKIPS — never the failure itself.
            //
            // An operator diagnosing "my brief didn't arrive" reaches for the
            // journal before the ledger, so the cause belongs in both. `detail` is a
            // composition-turn error string, not owner content, and it is capped to
            // the same budget the ledger column gets.
            log.warn('ritual_run_failed', {
              run_id,
              ritual_id,
              reason: outcome.detail.slice(0, MAX_RITUAL_FAILURE_REASON_CHARS),
            })
            const notices = [
              formatRitualFailureNotice({
                ritual_id,
                status: 'failed',
                run_id,
                failure_reason: outcome.detail,
              }),
            ]
            try {
              const recent = deps.runs.listRecentTerminal({
                ritual_id,
                limit: RITUAL_ESCALATION_CONSECUTIVE_FAILURES + 1,
              })
              if (shouldEscalate(recent)) {
                notices.push(formatRitualEscalationNotice({ ritual_id, run_id }))
              }
            } catch (err) {
              log.warn('ritual_escalation_read_failed', {
                run_id,
                ritual_id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
            return notices
          },
        },
      }
    },
  }
}

/**
 * Notice bodies the DISPATCHER posts directly (as opposed to the ones a `settle`
 * hook returns): the success line for an approved ritual that composed nothing,
 * and the line for a row that could not be planned at all because no planner is
 * wired. Re-exported through this module so the dispatcher keeps ONE import for
 * everything ritual-shaped and no new `dispatcher → ritual-delivery` graph edge is
 * introduced (`ritual-delivery.ts` imports this dispatcher's `ReminderOutbound`
 * type, and the cycle gate in `.dependency-cruiser.cjs` allows none).
 */
export { formatRitualCompletionFallback, formatRitualUnplannableNotice }
