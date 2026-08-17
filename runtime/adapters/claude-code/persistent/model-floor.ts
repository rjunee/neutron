// persistent-repl-substrate.ts → model-floor.ts
//
// THE FRONTIER-MODEL FLOOR for owner-facing conversational REPLs.
//
// WHAT WENT WRONG. The owner's project chat answered on the fast tier for a
// whole working day, twice, and nobody could see it. The mechanism is one `??`:
// `pool.ts` and `supervision.ts` resolve a spawn's model as
// `record.model ?? getBestModel()`, so a registry row that names a model
// OVERRIDES the best model rather than falling back to it — and `spawn.ts`
// writes the row back with whatever it just spawned on, which makes any wrong
// value SELF-PERPETUATING across every respawn, restart and resume. Editing the
// row by hand fixed it for hours; it came back.
//
// WHY THIS IS A FLOOR AND NOT A BUGFIX AT THE WRITER. This was built without
// knowing what first wrote the fast tier into that row. The writer was found
// separately — PR #340: the reminder dispatcher composed on the owner's warm
// chat REPL passing no model, so its own `input.model ?? FAST_MODEL` default
// rewrote the chat session's record on every fire (`open/composer.ts`). Two
// things keep the floor load-bearing anyway, and they are why it stayed:
//
//   1. THAT FIX CLOSES ONE CALL SITE. Any future caller that dispatches on the
//      live-agent substrate without naming a model reopens the identical hole,
//      and the only detector this class has is the owner noticing the answers
//      got worse. A floor makes the class unreachable, not one instance fixed.
//   2. IT DOES NOT REPAIR AN ALREADY-POISONED ROW. Nothing else rewrites
//      `record.model`: the sole writer is the model-update watchdog's graceful
//      upgrade (`supervision.ts`), which fires only when a 6h-gated probe finds
//      a genuinely NEW top-tier id. So a row already holding the fast tier keeps
//      respawning itself on the fast tier until an upgrade lands or someone
//      edits it by hand — the owner did edit it by hand, and it held for hours.
//
// So the property is enforced where it cannot be bypassed: at the single spawn
// chokepoint that turns a model id into the child's `--model`. Whatever wrote
// the record, the child comes up at or above the floor — and the row is
// rewritten with the clamped value, which is what repairs it.
//
// HOW THE COMPARISON WORKS, AND WHY IT IS NOT AN ID SET. The first version of
// this file matched the requested id against `getKnownFallbackModels()` (four
// literals) plus a `-YYYYMMDD` strip. Cross-model review showed that does not
// enforce the property the file's name claims: the `claude` CLI accepts the bare
// aliases `haiku` / `sonnet`, and an older generation, a future generation with
// a new base, or a case/whitespace variant all sail straight through four
// literals — while `repl-registry.ts` leaves `model` optional and never
// schema-checks it, so a row really can hold any of those. "Whatever the record
// says" has to mean whatever it says.
//
// So the comparison is by TIER RANK, derived from the FAMILY token of the id
// (`claude-haiku-4-5-20251001` → `haiku`; the bare alias `haiku` → `haiku`), and
// the order is read off the `runtime/models.ts` aliases rather than a hardcoded
// table, so a generation bump cannot silently invert it. That closes the alias,
// generation, snapshot and casing gaps in one predicate, with nothing to
// maintain when a tier moves generation.
//
// AN UNRECOGNISED ID RANKS AT THE TOP, DELIBERATELY. Clamping it would fight the
// model-upgrade path, which legitimately writes ids THIS process has never heard
// of into a record (`supervision.ts` rewrites `record.model` before a `--resume`
// respawn). A NAMED lower tier is unambiguous; an unknown id is not, and guessing
// would trade a loud wrong-model bug for a silent fights-the-upgrade one.
//
// THE FLOOR IS THE CONFIGURED BEST, NOT "THE TOP TIER". `BEST_MODEL` is
// overridable via `NEUTRON_BEST_MODEL`, so an operator can run an instance
// deliberately on a cheaper tier. An earlier revision DISABLED the floor
// entirely in that case; cross-model review was right that this is not a floor
// at all — a poisoned fast-tier row would then sit below the operator's own
// configured best and stay there. Rank comparison gives the correct behaviour
// for free: clamp whenever the request ranks BELOW the floor, leave it alone at
// or above, so a same-tier request never produces a no-op clamp with a
// misleading event.

import { createLogger } from '@neutronai/logger'
import { FAST_MODEL, SONNET_MODEL, getBestModel } from '../../../models.ts'

const log = createLogger('model-floor')

/**
 * The family token of a model id — the part naming the TIER rather than the
 * generation. `claude-haiku-4-5-20251001` → `haiku`, `claude-sonnet-5` →
 * `sonnet`, `claude-opus-5` → `opus`. The bare CLI aliases normalise to
 * themselves, which is the point: `--model haiku` is a real thing the CLI
 * accepts, and a set of four literal ids does not catch it.
 *
 * Trims and lowercases first, so a stray-whitespace or mixed-case value in an
 * unvalidated registry row cannot walk past the comparison.
 */
export function familyOf(model: string): string {
  const normalized = model.trim().toLowerCase()
  const base = normalized.startsWith('claude-') ? normalized.slice('claude-'.length) : normalized
  const dash = base.indexOf('-')
  return dash === -1 ? base : base.slice(0, dash)
}

/** Rank of the frontier, and of anything unrecognised — see the header for why
 *  an unknown id sits at the TOP rather than being treated as suspicious. */
export const FRONTIER_RANK = Number.MAX_SAFE_INTEGER

/**
 * Order the tiers FROM THE ALIASES rather than a hardcoded table, so a
 * generation bump in `runtime/models.ts` cannot silently invert this: rank 0 is
 * whatever `FAST_MODEL`'s family is, rank 1 is whatever `SONNET_MODEL`'s is, and
 * everything else ranks above both.
 */
export function tierRankOf(model: string): number {
  const family = familyOf(model)
  if (family === familyOf(FAST_MODEL)) return 0
  if (family === familyOf(SONNET_MODEL)) return 1
  return FRONTIER_RANK
}

/** The outcome of applying (or not applying) the floor to one spawn. */
export interface ModelFloorDecision {
  /** The model the child will actually be spawned with. */
  readonly model: string
  /** True when {@link requested} was refused and replaced by {@link model}. */
  readonly clamped: boolean
  /** What the caller asked for (the registry record's value, in the live bug). */
  readonly requested: string
  /** The model the floor holds the session at — the CONFIGURED best. */
  readonly floor: string
}

/** Inputs to {@link resolveModelFloor}. `best` is injectable so the decision is
 *  testable without mutating process-wide model state. */
export interface ModelFloorInput {
  /** The model the spawn resolved — usually `record.model ?? getBestModel()`. */
  readonly requested: string
  /** Whether THIS substrate is owner-facing conversational (profile-driven). */
  readonly enabled: boolean
  /** The floor. Defaults to the live `getBestModel()`. */
  readonly best?: string
}

/**
 * PURE decision — no logging, no side effects. A substrate WITHOUT the floor is
 * returned verbatim, which is what keeps the deliberate `FAST_MODEL` callers
 * (scribe extraction, the correction/reflection judges — all on
 * `PROFILE_TOOLLESS_UTILITY`) working exactly as before.
 */
export function resolveModelFloor(input: ModelFloorInput): ModelFloorDecision {
  const floor = input.best ?? getBestModel()
  // Defensive against an unvalidated registry row. `requested` is TYPED `string`,
  // but `repl-registry.ts` leaves `model` optional and never schema-checks it, so
  // a row written by another build can carry anything — and a `.trim()` on a
  // non-string would throw INSIDE a spawn, converting a wrong-model bug into a
  // dead session.
  const requested = typeof input.requested === 'string' ? input.requested : ''
  if (!input.enabled) return { model: requested, clamped: false, requested, floor }
  // A blank floor cannot improve anything, and clamping TO it would hand the CLI
  // an empty `--model` and fail the launch outright — strictly worse than the
  // degradation being corrected. (`BEST_MODEL` resolves with `??`, so an empty
  // `NEUTRON_BEST_MODEL` arrives here as `''` rather than the default.)
  if (floor.trim() === '') return { model: requested, clamped: false, requested, floor }
  // A blank request on a floored session resolves TO the floor: an empty
  // `--model` is a failed spawn, and the floor is the best available answer.
  if (requested.trim() === '') return { model: floor, clamped: true, requested, floor }
  if (tierRankOf(requested) >= tierRankOf(floor)) {
    return { model: requested, clamped: false, requested, floor }
  }
  return { model: floor, clamped: true, requested, floor }
}

/**
 * Apply the floor AND make a clamp LOUD. The silence is half the defect: this
 * ran for a day and the only signal was the owner noticing worse answers, while
 * the chat itself explained the degradation with a claim about environment
 * defaults that `runtime/models.ts` contradicts. A clamp now names the session,
 * the model that was requested, where it came from, and the floor applied — on
 * `warn`, which flows at every log level above `error`.
 *
 * Returns the model to spawn with. Callers use the return value for BOTH the
 * child argv and the registry write, so one clamp also un-poisons the row.
 */
export function applyModelFloor(
  input: ModelFloorInput & { readonly sessionKey: string; readonly source: string },
): string {
  const decision = resolveModelFloor(input)
  if (decision.clamped) {
    log.warn('model_floor_applied', {
      session_key: input.sessionKey,
      source: input.source,
      requested_model: decision.requested,
      floor_model: decision.floor,
      detail:
        'an owner-facing conversational REPL resolved a model below the configured ' +
        'best tier; the request was refused and the session re-resolved to the floor',
    })
  }
  return decision.model
}
