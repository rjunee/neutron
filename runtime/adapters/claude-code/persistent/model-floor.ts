// persistent-repl-substrate.ts → model-floor.ts
//
// THE FRONTIER-MODEL FLOOR for owner-facing conversational REPLs.
//
// WHAT WENT WRONG. The owner's project chat answered on Haiku for a whole
// working day, twice, and nobody could see it. The mechanism is one `??`:
// `pool.ts` and `supervision.ts` resolve a spawn's model as
// `record.model ?? getBestModel()`, so a registry row that names a model
// OVERRIDES the best model rather than falling back to it — and `spawn.ts`
// writes the row back with whatever it just spawned on, which makes any wrong
// value SELF-PERPETUATING across every respawn, restart and resume. Editing the
// row by hand fixed it for hours; it came back.
//
// WHY THIS IS A FLOOR AND NOT A BUGFIX AT THE WRITER. We never identified what
// first wrote Haiku into that row, and a fix that closed one writer would leave
// the next one open — the owner would pay for it again, silently, and the only
// detector we have is him noticing the answers got worse. So the property is
// enforced where it cannot be bypassed: at the single spawn chokepoint that
// turns a model id into the child's `--model`. Whatever wrote the record, the
// child comes up on the frontier model.
//
// WHY THE PREDICATE IS "A KNOWN LOWER TIER" AND NOT "ANYTHING ≠ BEST".
// `getKnownFallbackModels()` (`runtime/models.ts`) already exists for exactly
// this judgement one layer up: the model-update watchdog refuses to ADOPT a
// lower-tier id, because during an Opus outage a `--fallback-model` CLI reports
// the Haiku/Sonnet id and a naive "new id → upgrade" would silently downgrade
// the fleet. That guard was never mirrored on the record-READ path, which is the
// gap this file closes — same set, same reasoning, other end of the pipe.
//
// Clamping "anything ≠ best" instead would be wrong in a way that matters: a
// warm session legitimately holds the model it SPAWNED with (the graceful
// model-upgrade rewrites the row before respawning so a resume re-attaches
// correctly), and a mid-generation id — or a newer top-tier id the watchdog
// adopted in another process — is not a degradation. Clamping it would fight the
// upgrade path. A KNOWN lower tier is unambiguous: nothing legitimately puts one
// in an owner chat's record.
//
// SNAPSHOT FORMS COUNT. `FAST_MODEL` is a dated snapshot
// (`claude-haiku-4-5-20251001` — the exact string measured in the owner's live
// registry), and the alias set carries both the dated and base forms today by
// hand. Normalising a trailing `-YYYYMMDD` means a FUTURE Haiku/Sonnet snapshot
// is caught for free rather than sailing through a floor that looks correct.

import { createLogger } from '@neutronai/logger'
import { getBestModel, getKnownFallbackModels } from '../../../models.ts'

const log = createLogger('model-floor')

/** Strip a trailing `-YYYYMMDD` release snapshot: `claude-haiku-4-5-20251001`
 *  → `claude-haiku-4-5`. Ids without one are returned verbatim. */
function baseForm(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

/** True when `model` names a tier BELOW the frontier — matched on the id as
 *  given AND on its snapshot-stripped base form, so a future dated release of a
 *  lower tier is recognised without touching the alias set. */
export function isBelowFrontierTier(model: string, lowerTiers: ReadonlySet<string>): boolean {
  if (lowerTiers.has(model)) return true
  const base = baseForm(model)
  if (lowerTiers.has(base)) return true
  for (const tier of lowerTiers) {
    if (baseForm(tier) === base) return true
  }
  return false
}

/** The outcome of applying (or not applying) the floor to one spawn. */
export interface ModelFloorDecision {
  /** The model the child will actually be spawned with. */
  readonly model: string
  /** True when {@link requested} was refused and replaced by {@link model}. */
  readonly clamped: boolean
  /** What the caller asked for (the registry record's value, in the live bug). */
  readonly requested: string
  /** The frontier model the floor holds the session at. */
  readonly floor: string
}

/** Inputs to {@link resolveModelFloor}. `best` / `lowerTiers` are injectable so
 *  the decision is testable without mutating process-wide model state. */
export interface ModelFloorInput {
  /** The model the spawn resolved — usually `record.model ?? getBestModel()`. */
  readonly requested: string
  /** Whether THIS substrate is owner-facing conversational (profile-driven). */
  readonly enabled: boolean
  /** The frontier model. Defaults to the live `getBestModel()`. */
  readonly best?: string
  /** The known lower tiers. Defaults to the live `getKnownFallbackModels()`. */
  readonly lowerTiers?: ReadonlySet<string>
}

/**
 * PURE decision — no logging, no side effects. A substrate WITHOUT the floor is
 * returned verbatim, which is what keeps the deliberate `FAST_MODEL` callers
 * (scribe extraction, the correction/reflection judges — all on
 * `PROFILE_TOOLLESS_UTILITY`) working exactly as before.
 */
export function resolveModelFloor(input: ModelFloorInput): ModelFloorDecision {
  const floor = input.best ?? getBestModel()
  const requested = input.requested
  if (!input.enabled) return { model: requested, clamped: false, requested, floor }
  const lowerTiers = input.lowerTiers ?? getKnownFallbackModels()
  // AN OPERATOR WHO PINS A LOWER TIER AS THE BEST MODEL MEANS IT. `BEST_MODEL`
  // is overridable via `NEUTRON_BEST_MODEL` (`runtime/models.ts:52-53`) so an
  // operator can deliberately run the whole instance on a cheaper tier. If the
  // floor itself is a known lower tier, clamping would be a no-op that swapped
  // one lower-tier id for another AND emitted a "floor applied" event naming a
  // degradation that did not happen — a misleading signal in the one subsystem
  // whose whole point is that the signal is trustworthy. Defer to the operator.
  if (isBelowFrontierTier(floor, lowerTiers)) {
    return { model: requested, clamped: false, requested, floor }
  }
  if (!isBelowFrontierTier(requested, lowerTiers)) {
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
        'an owner-facing conversational REPL resolved a model below the frontier tier; ' +
        'the request was refused and the session re-resolved to the floor',
    })
  }
  return decision.model
}
