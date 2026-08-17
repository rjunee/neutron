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
// So the comparison is by TIER RANK, derived from the FAMILY token of the id,
// and the order is read off the `runtime/models.ts` aliases rather than a
// hardcoded table, so a generation bump cannot silently invert it. That closes
// the alias, generation, snapshot and casing gaps in one predicate, with nothing
// to maintain when a tier moves generation.
//
// THE FAMILY TOKEN IS NOT THE FIRST TOKEN — AND ASSUMING IT WAS LET REAL IDS
// THROUGH. A previous revision anchored on the first dash-token after `claude-`,
// which is only correct for the CURRENT naming order (`claude-haiku-4-5-…`).
// Anthropic's earlier order puts the generation FIRST, so the genuinely
// published `claude-3-5-haiku-20241022` yielded family `3` — unrecognised,
// therefore ranked at the frontier, therefore NOT clamped. Its own regression
// test hid this by asserting on `claude-haiku-3-5-20241022`, an id in the new
// order that Anthropic never shipped: a fabricated string that made the gap look
// closed. Gateway/proxy prefixes had the identical shape of failure —
// `us.anthropic.claude-haiku-4-5-v1:0` (Bedrock) and `anthropic/claude-haiku-4-5`
// (OpenRouter-style) both yielded a family that was really a provider prefix.
//
// So the id is SPLIT on every non-alphanumeric boundary and scanned for the
// first token that is neither a provider/routing word nor a bare number: both
// naming orders, both proxy prefixes, the `@`-separated Vertex form and the bare
// CLI aliases all land on the same tier token. When no such token exists the
// family is empty, which ranks at the frontier — see below.
//
// AN UNRECOGNISED ID RANKS AT THE TOP, DELIBERATELY. Clamping it would fight the
// model-upgrade path, which legitimately writes ids THIS process has never heard
// of into a record (`supervision.ts` rewrites `record.model` before a `--resume`
// respawn). A NAMED lower tier is unambiguous; an unknown id is not, and guessing
// would trade a loud wrong-model bug for a silent fights-the-upgrade one. Note
// which way the remaining error leans: a token scan that lands on a lower-tier
// word by accident spends MORE money on a BETTER model, while the failure this
// file exists to stop is the reverse. Over-clamping is the survivable direction.
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
 * Vendor / routing words that appear in a model id but never name a TIER. Every
 * one of these is real: `claude-*` is the CLI form, `us.anthropic.claude-*-v1:0`
 * is Bedrock, `anthropic/claude-*` is the OpenRouter-style proxy form, and
 * `publishers/anthropic/models/claude-*` is Vertex. Skipping them is what lets a
 * proxied id be RANKED rather than waved through as unrecognised.
 */
const NON_TIER_TOKENS = new Set([
  'anthropic',
  'apac',
  'bedrock',
  'claude',
  'eu',
  'global',
  'models',
  'publishers',
  'us',
  'vertex',
])

/**
 * The family token of a model id — the part naming the TIER rather than the
 * generation, the vendor or the snapshot. All of these yield `haiku`:
 * `claude-haiku-4-5-20251001` (current order), `claude-3-5-haiku-20241022`
 * (earlier order, generation first), `us.anthropic.claude-haiku-4-5-v1:0`
 * (Bedrock), `anthropic/claude-haiku-4-5` (proxy), `claude-3-5-haiku@20241022`
 * (Vertex) and the bare CLI alias `haiku`. That last one is the point a literal
 * id set always misses: `--model haiku` is a real thing the CLI accepts.
 *
 * MECHANISM: lowercase, split on every non-alphanumeric boundary, then return
 * the first token that is neither a {@link NON_TIER_TOKENS} vendor word nor a
 * bare number (a bare number is a generation or a `YYYYMMDD` snapshot, never a
 * tier). An id with no such token — `claude-2.1` — yields `''`, which
 * {@link tierRankOf} ranks at the frontier along with everything else it does
 * not recognise.
 */
export function familyOf(model: string): string {
  for (const token of model.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token === '') continue
    if (NON_TIER_TOKENS.has(token)) continue
    if (/^\d+$/.test(token)) continue
    return token
  }
  return ''
}

/** Rank of the frontier, and of anything unrecognised — see the header for why
 *  an unknown id sits at the TOP rather than being treated as suspicious. */
export const FRONTIER_RANK = Number.MAX_SAFE_INTEGER

/**
 * Order the tiers FROM THE ALIASES rather than a hardcoded table, so a
 * generation bump in `runtime/models.ts` cannot silently invert this: rank 0 is
 * whatever `FAST_MODEL`'s family is, rank 1 is whatever `SONNET_MODEL`'s is, and
 * everything else ranks above both.
 *
 * THIS DOES NOT USE {@link familyOf}'S POSITION, and the difference is the point.
 * `familyOf` answers "which tier does this id NAME", positionally, which is what
 * the alias constants and a human reader want. The FLOOR needs a stronger
 * question — "can a lower tier be hiding anywhere in this string" — because the
 * vendor-word list `familyOf` skips is an ENUMERATION, and an enumeration is a
 * list of the prefixes someone remembered. One unlisted routing segment
 * (`bedrock/us-east-1/claude-3-5-haiku`) would make `familyOf` return that
 * segment, rank the id at the frontier and let the fast tier through — the exact
 * class of miss this round is fixing, one level up. So the rank scans EVERY
 * token, and a lower-tier family found anywhere wins.
 *
 * The cost is a possible false CLAMP on an id that merely contains a tier word,
 * which spends more money on a better model. The failure this file exists to
 * stop is the reverse, so the asymmetry is deliberate.
 */
export function tierRankOf(model: string): number {
  // BOTH SIDES OF THE EMPTY STRING ARE REFUSED, and neither line is tidiness.
  // A leading or trailing separator splits to a `''` token, and an alias an
  // operator pinned to a tier-less id (`NEUTRON_FAST_MODEL=claude-2`) makes
  // `familyOf` return `''` as well. Match those two and EVERY id ranks as the
  // fast tier — a floor that clamps its own frontier requests.
  //
  // ⚠️ Only the token half is reachable from a test: the aliases are module-level
  // consts bound at import, so a suite cannot pin a tier-less one. The family
  // half is defensive, and is labelled rather than dressed up as covered.
  const tokens = new Set(model.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ''))
  const fast = familyOf(FAST_MODEL)
  const sonnet = familyOf(SONNET_MODEL)
  if (fast !== '' && tokens.has(fast)) return 0
  if (sonnet !== '' && tokens.has(sonnet)) return 1
  return FRONTIER_RANK
}

/** The outcome of applying (or not applying) the floor to one spawn. */
export interface ModelFloorDecision {
  /** The model the child will actually be spawned with. */
  readonly model: string
  /** True when {@link requested} was refused and replaced by {@link model}. */
  readonly clamped: boolean
  /** What the caller asked for — the registry record's value, in the live bug.
   *  On a FLOORED substrate this is the TRIMMED form (and `''` for a non-string
   *  row), because that is the value the decision was actually made on; on an
   *  unfloored one it is the input untouched. Said precisely because a field
   *  documented as "what the caller asked for" that silently differs from the
   *  input is the kind of name-versus-content drift this file has already been
   *  bitten by. */
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
  // THE UNFLOORED PATH RETURNS THE INPUT BYTE-FOR-BYTE, and it returns FIRST.
  // An earlier revision coerced a non-string to `''` before this check, so a
  // substrate that had opted OUT of the floor still came away with a different
  // value than it passed in — contradicting this function's own docstring and
  // the identity claim `spawn.ts` rests on. Nothing below this line can run for
  // a utility caller now.
  if (!input.enabled) {
    return { model: input.requested, clamped: false, requested: input.requested, floor }
  }
  // Defensive against an unvalidated registry row. `requested` is TYPED `string`,
  // but `repl-registry.ts` leaves `model` optional and never schema-checks it, so
  // a row written by another build can carry anything — and a `.trim()` on a
  // non-string would throw INSIDE a spawn, converting a wrong-model bug into a
  // dead session.
  const raw = typeof input.requested === 'string' ? input.requested : ''
  // NORMALISE WHAT WE RETURN, not just what we compare. The rank comparison has
  // always been whitespace/case-insensitive, but the un-clamped path used to hand
  // the ORIGINAL bytes to `--model` — so a padded frontier id in an unvalidated
  // row reached the CLI padded. Trimming is the whole normalisation: the case of
  // a model id is meaningful to the API, so it is left alone.
  const requested = raw.trim()
  // A blank floor cannot improve anything, and clamping TO it would hand the CLI
  // an empty `--model` and fail the launch outright — strictly worse than the
  // degradation being corrected. (`BEST_MODEL` resolves with `??`, so an empty
  // `NEUTRON_BEST_MODEL` arrives here as `''` rather than the default.)
  if (floor.trim() === '') return { model: requested, clamped: false, requested, floor }
  // A blank request on a floored session resolves TO the floor: an empty
  // `--model` is a failed spawn, and the floor is the best available answer.
  if (requested === '') return { model: floor, clamped: true, requested, floor }
  if (tierRankOf(requested) >= tierRankOf(floor)) {
    return { model: requested, clamped: false, requested, floor }
  }
  return { model: floor, clamped: true, requested, floor }
}

/** A clamp, shaped for the notice-family DI seam. Mirrors `DeadTurnNotice` /
 *  `RateLimitBannerNotice`: the runtime detects, the gateway decides how the
 *  owner is told (`gateway/http/substrate-notice-sink.ts`). */
export interface ModelFloorNotice {
  /** Pool key of the session that was clamped. */
  readonly sessionKey: string
  /** `'spawn'` (cold) or `'resume'` (re-attach) — which path resolved the model. */
  readonly source: string
  /** The model the record asked for, i.e. the degradation. */
  readonly requested: string
  /** The model the session was held at instead. */
  readonly floor: string
}

/**
 * Apply the floor AND make a clamp LOUD. The silence is half the defect: this
 * ran for a day and the only signal was the owner noticing worse answers, while
 * the chat itself explained the degradation with a claim about environment
 * defaults that `runtime/models.ts` contradicts.
 *
 * A CONSOLE LINE IS NOT LOUD. The first revision emitted only `log.warn`, which
 * `logger/index.ts` routes to the server's stderr — a journald line on a box the
 * owner does not read. That is the SAME class of invisibility the notice family
 * was built to end for dead turns and rate-limit banners (`substrate-notice-
 * sink.ts`), so a clamp now takes the same two-surface route: the structured
 * warn for the operator log, AND {@link ModelFloorNotice} through the injected
 * sink, which the gateway fans to a `system_events` row plus a system bubble on
 * the owner's chat topic. Unwired (every utility substrate, and every test that
 * does not care) ⇒ the warn alone, exactly as before.
 *
 * DELIBERATELY UNLATCHED, unlike the three notices above it. Those latch because
 * their upstream condition PERSISTS — a rate-limit banner sits in the pane for
 * an hour and would re-fire on every scan. A clamp cannot repeat for the same
 * cause: it rewrites the offending row with the floored value in the same breath
 * (see `spawn.ts`), so a SECOND clamp means something re-poisoned the row, which
 * is a live re-poisoner and the single most important thing to say out loud.
 * Suppressing the repeat would rebuild the silence this whole file is here for.
 *
 * The obvious objection — a respawn loop turning that into a bubble storm — is
 * answered by the loops themselves rather than by hope. The channel-wedge retry
 * is hard-capped at `MAX_FLEET_RESPAWNS = 2` (`channel-unbound-respawn.ts:23`;
 * then one operator alert and auto-recovery stops), and the supervision respawn
 * cap is `RESPAWN_CAP_MAX = 3` (`signatures.ts:173`; then the row is `capped_at`
 * and stops respawning at all). A wedging session on a poisoned row is therefore
 * a handful of notices with a hard ceiling, and every one of them is true.
 *
 * A sink throw is swallowed: a visibility notice must never fail a spawn.
 *
 * Returns the model to spawn with. Callers use the return value for BOTH the
 * child argv and the registry write, so one clamp also un-poisons the row.
 */
export function applyModelFloor(
  input: ModelFloorInput & {
    readonly sessionKey: string
    readonly source: string
    readonly notify?: (notice: ModelFloorNotice) => void
  },
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
    try {
      input.notify?.({
        sessionKey: input.sessionKey,
        source: input.source,
        requested: decision.requested,
        floor: decision.floor,
      })
    } catch {
      /* a visibility notice must never fail the spawn it is describing */
    }
  }
  return decision.model
}
