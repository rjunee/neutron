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
// So the comparison is by TIER RANK, derived from the FAMILY token of the id.
// That closes the alias, generation, snapshot and casing gaps in one predicate,
// with nothing to maintain when a tier moves generation.
//
// THE ORDER OF THE TIERS IS CANONICAL, NOT ALIAS-DERIVED — and this line used to
// say the opposite. An earlier revision read rank 0 off `FAST_MODEL`'s family and
// rank 1 off `SONNET_MODEL`'s, on the reasoning that a hardcoded table could be
// inverted by a generation bump. The cost of that was not visible from here: it
// left the floor able to rank only TWO families, chosen by operator environment,
// so `NEUTRON_FAST_MODEL=claude-sonnet-5` made a persisted haiku id rank at the
// FRONTIER and the floor went silently inert — no clamp, no warn, no event, no
// bubble. Reproduced. The order now comes from `TIER_WORDS`, which held it all
// along; the aliases still seed a tier name this build predates. Full account,
// with the repro, at `tierRankTable`.
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
  'databricks',
  'eu',
  'global',
  'models',
  'publishers',
  'us',
  'vertex',
])

/**
 * Anthropic's TIER NAMES, ASCENDING — and yes, this is an enumeration, sitting
 * two lines under a comment about the danger of enumerations. The distinction is
 * which one you are forced to keep up with.
 *
 * A cross-model review found the hole that made this necessary. Databricks
 * publishes `databricks-claude-haiku-4-5` / `databricks-claude-opus-4-5`, and
 * with BOTH aliases pointed at that form (`NEUTRON_FAST_MODEL` +
 * `NEUTRON_BEST_MODEL`, `runtime/models.ts:52`/`:106`) the positional scan
 * returned `databricks` for the fast family AND `databricks` for the best — the
 * two tiers collapsed onto one token, every rank came out equal, and the floor
 * went INERT. Reproduced before fixing, and note the shape: the request itself
 * was still ranked correctly by {@link tierRankOf}'s token scan; it was deriving
 * the ALIAS's family that broke, which the token scan cannot protect.
 *
 * So a KNOWN tier word anywhere in an id wins over position. The trade is
 * deliberate: cloud vendors mint routing prefixes continuously (this one was
 * missed), whereas Anthropic has shipped three tier names in five years. A name
 * this build has not heard of still falls through to the positional scan below.
 *
 * ⚠️ THE ARRAY IS ORDERED AND THE ORDER IS THE RANK — index 0 is the cheapest
 * tier. It is an array rather than a `Set` for exactly that reason, and
 * {@link tierRankTable} reads the rank off the index. See that function for why
 * the order stopped being derived from the aliases.
 */
const TIER_WORDS: readonly string[] = ['haiku', 'sonnet', 'opus']

/** Membership view of {@link TIER_WORDS} for {@link familyOf}'s first pass. */
const TIER_WORD_SET: ReadonlySet<string> = new Set(TIER_WORDS)

/**
 * The family token of a model id — the part naming the TIER rather than the
 * generation, the vendor or the snapshot. All of these yield `haiku`:
 * `claude-haiku-4-5-20251001` (current order), `claude-3-5-haiku-20241022`
 * (earlier order, generation first), `us.anthropic.claude-haiku-4-5-v1:0`
 * (Bedrock), `anthropic/claude-haiku-4-5` (proxy), `claude-3-5-haiku@20241022`
 * (Vertex) and the bare CLI alias `haiku`. That last one is the point a literal
 * id set always misses: `--model haiku` is a real thing the CLI accepts.
 *
 * MECHANISM, in two passes. FIRST a {@link TIER_WORDS} name found ANYWHERE wins,
 * so no vendor prefix — enumerated or not — can hide a tier
 * (`databricks-claude-haiku-4-5` → `haiku`). SECOND, for a tier name this build
 * has never heard of, fall back to position: the first token that is neither a
 * {@link NON_TIER_TOKENS} vendor word nor a bare number (a bare number is a
 * generation or a `YYYYMMDD` snapshot, never a tier). An id with no such token —
 * `claude-2.1` — yields `''`, which {@link tierRankOf} ranks at the frontier
 * along with everything else it does not recognise.
 */
export function familyOf(model: string): string {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/)
  for (const token of tokens) {
    if (TIER_WORD_SET.has(token)) return token
  }
  for (const token of tokens) {
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
 * The family → rank table the floor compares on. Rank ascends with capability;
 * anything absent from the table ranks {@link FRONTIER_RANK}.
 *
 * ⚠️ THE ORDER IS CANONICAL NOW, NOT ALIAS-DERIVED, AND THAT IS THE FIX FOR A
 * REPRODUCED INERTNESS BUG. The previous revision derived BOTH sub-frontier ranks
 * from the aliases — rank 0 was `familyOf(FAST_MODEL)`, rank 1 was
 * `familyOf(SONNET_MODEL)`, everything else frontier — with a docblock claiming
 * that made a generation bump unable to invert the order. It did do that. It also
 * meant the floor recognised EXACTLY TWO families, and which two was operator
 * configuration. Point `NEUTRON_FAST_MODEL` at a model that is not the cheapest
 * tier and the fast tier stops being ranked at all:
 *
 *   `NEUTRON_FAST_MODEL=claude-sonnet-5` ⇒ fast family `sonnet`, sonnet family
 *   `sonnet`, so `haiku` matched NEITHER and a persisted
 *   `claude-haiku-4-5-20251001` ranked FRONTIER. `clamped` came back false, the
 *   child spawned on the fast tier, the row was rewritten with it, and NOTHING
 *   fired — no warn, no `system_events` row, no bubble. The floor did not fail
 *   loudly; it went silently inert, which is the precise failure mode this whole
 *   file exists to end. `NEUTRON_FAST_MODEL=claude-opus-4-5` was worse still:
 *   `opus` took rank 0, so the FLOOR itself ranked bottom and nothing could ever
 *   clamp. Reproduced against the unmutated head at `5691492b`:
 *   `NEUTRON_FAST_MODEL=claude-sonnet-5 bun test model-floor.test.ts` → 17 failures,
 *   35/35 green on the default env.
 *
 * So {@link TIER_WORDS} — which held the true order all along and was consulted
 * only for MEMBERSHIP — is now the rank, by index. Anthropic's three tier names
 * are ranked whatever the aliases say, and an operator's env can no longer
 * silently remove a tier from the floor's vocabulary.
 *
 * THE ALIASES STILL CONTRIBUTE, for the case the canonical list cannot cover: a
 * tier name this build predates. If an alias's family is not a known tier word,
 * the alias TELLS us which tier it occupies, so it is seeded at that tier's rank
 * (`FAST_MODEL`'s family at the fast rank, `SONNET_MODEL`'s at the mid rank). A
 * tie is harmless — {@link tierRankOf} takes the MINIMUM matched rank and the
 * comparison is `>=`. A known tier word is never overwritten, which is what stops
 * `NEUTRON_FAST_MODEL=claude-sonnet-5` from dragging `sonnet` down to rank 0.
 *
 * Aliases are parameters, defaulted to the module consts, purely so a suite can
 * exercise an operator env: `runtime/models.ts` binds them at import, so no
 * in-process test can set the environment variables that produced the bug above.
 */
export function tierRankTable(
  fastAlias: string = FAST_MODEL,
  sonnetAlias: string = SONNET_MODEL,
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>()
  TIER_WORDS.forEach((word, index) => ranks.set(word, index))
  // Seed the mid rank before the fast one so that two aliases sharing one unknown
  // family settle at the mid rank rather than the fast one — over-ranking a family
  // costs money on a better model, under-ranking it is the degradation this file
  // exists to stop.
  const sonnet = familyOf(sonnetAlias)
  if (sonnet !== '' && !ranks.has(sonnet)) ranks.set(sonnet, 1)
  const fast = familyOf(fastAlias)
  if (fast !== '' && !ranks.has(fast)) ranks.set(fast, 0)
  return ranks
}

/**
 * Rank one model id: the LOWEST tier rank any of its tokens names, else
 * {@link FRONTIER_RANK}.
 *
 * THIS ASKS A DIFFERENT QUESTION THAN {@link familyOf}, and keeps asking it even
 * though `familyOf` now answers most of it. `familyOf` answers "which tier does
 * this id NAME" — a known tier word anywhere, else the first non-vendor,
 * non-numeric token. The FLOOR asks the blunter "can a lower tier be hiding
 * anywhere in this string", and it does not go through `familyOf`'s single answer
 * to get there.
 *
 * That is redundant for a KNOWN tier and deliberately kept, because the two
 * mechanisms fail on different inputs. `familyOf`'s positional fallback is
 * guarded by a vendor-word ENUMERATION — a list of the prefixes someone
 * remembered — so a tier name NOT in `TIER_WORDS`, behind a prefix NOT on the
 * vendor list, resolves to the prefix. A rank taken from that single answer would
 * put the id at the frontier and let it through. Scanning every token means only
 * ONE of the two has to be right.
 *
 * (This docblock previously illustrated the point with
 * `bedrock/us-east-1/claude-3-5-haiku`, which the tier-word pass now resolves
 * correctly — the example went stale the moment `familyOf` improved. Left noted
 * rather than silently swapped: a comment that describes behaviour the code
 * stopped having is the failure mode this file keeps running into.)
 *
 * The cost is a possible false CLAMP on an id that merely contains a tier word,
 * which spends more money on a better model. The failure this file exists to
 * stop is the reverse, so the asymmetry is deliberate.
 */
export function tierRankOf(
  model: string,
  aliases?: { readonly fast?: string; readonly sonnet?: string },
): number {
  // THE EMPTY STRING IS REFUSED ON BOTH SIDES, and neither guard is tidiness. A
  // leading or trailing separator splits to a `''` token, and an alias an operator
  // pinned to a tier-less id (`NEUTRON_FAST_MODEL=claude-2`) makes `familyOf`
  // return `''` too — {@link tierRankTable} drops that one, this filter drops the
  // other. Match those two and EVERY id would rank as the fast tier: a floor that
  // clamps its own frontier requests.
  const tokens = new Set(model.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== ''))
  let rank = FRONTIER_RANK
  for (const [family, familyRank] of tierRankTable(aliases?.fast, aliases?.sonnet)) {
    if (familyRank < rank && tokens.has(family)) rank = familyRank
  }
  return rank
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
  /** Tier aliases, injectable for the same reason `best` is: `runtime/models.ts`
   *  binds `FAST_MODEL` / `SONNET_MODEL` at import, so an in-process suite cannot
   *  set the environment variables that made the old rank derivation go inert.
   *  Production omits this and gets the module consts. */
  readonly aliases?: { readonly fast?: string; readonly sonnet?: string }
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
  if (tierRankOf(requested, input.aliases) >= tierRankOf(floor, input.aliases)) {
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
 * an hour and would re-fire on every scan. On the SUCCEEDING path a clamp cannot
 * repeat for the same cause, because the same call's return value is written
 * back to the row (`spawn.ts`), so a later clamp means something re-poisoned it
 * — a live re-poisoner, and the single most important thing to say out loud.
 * Suppressing that repeat would rebuild the silence this whole file is here for.
 *
 * ⚠️ THAT REASONING DOES NOT HOLD ON A FAILED SPAWN, and an earlier revision of
 * this docblock asserted it unconditionally — a cross-model review disproved it
 * and the correction is kept here rather than quietly dropped. The registry write
 * happens only after the post-spawn readiness assertion (`spawn.ts:631`), while a
 * channel-wedged attempt throws before it (`spawn.ts:573`), so the bounded
 * respawn loop re-enters with the row STILL poisoned and one bad row produces
 * three identical notices, not one. Reproduced, not reasoned.
 *
 * It stays unlatched anyway, on volume rather than on the false claim: the
 * repeats are hard-capped at both levels — `MAX_FLEET_RESPAWNS = 2`
 * (`channel-unbound-respawn.ts:23`, then one operator alert and auto-recovery
 * stops) and `RESPAWN_CAP_MAX = 3` (`signatures.ts:173`, after which the row is
 * `capped_at` and stops respawning at all). A handful of true notices with a hard
 * ceiling beats a latch that could swallow a genuine second degradation.
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
