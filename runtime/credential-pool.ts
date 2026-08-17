/**
 * @neutronai/runtime — credential pool with rotation + cooldown.
 *
 * Port of Hermes' `credential_pool.py` (TIER 1 lift target per
 * internal design notes § 2).
 * Same four selection strategies; cooldown TTLs tightened where the Hermes
 * value was not justified by data and tracked with a per-credential reason
 * tag so observability can attribute pool churn.
 *
 * Used by every substrate adapter that talks to a multi-key upstream:
 *
 *   - `runtime/adapters/claude-code/`        — same-user multi-sub Claude Max OAuth pool
 *                                              (per Atlas's session-id portability research)
 *   - `runtime/adapters/codex-cli/`  — Codex CLI device-code OAuth + BYO API key pool
 *   - `runtime/adapters/openai-responses/`        — OpenAI API key pool (BYO; no subscription path)
 *
 * Adapters call `selectCredential(pool)` to pick a credential, then
 * `reportSuccess(pool, id)` after a 2xx and `reportFailure(pool, id, status,
 * retry_after_ms?)` after 429/402/401 / 5xx so the cooldown clock + failure
 * counter advance.
 *
 * `member_rotation` (pooling Max OAuth tokens between humans) is forbidden per
 * `engineering-plan.md` line 142 + line 237. This pool only mixes credentials
 * within a single billing context (one user's many subs, one workspace's many
 * keys, etc.) — the caller is responsible for never mixing owners.
 */

export type CredentialStrategy = 'fill_first' | 'round_robin' | 'random' | 'least_used'

// `ambient` — no secret material of our own; the downstream substrate spawns
// `claude` and lets the child authenticate via its OWN ambient/Keychain auth
// (the macOS "Claude Code-credentials" item, or `~/.claude/.credentials.json`).
// Only ever produced by the single-owner Open path (`resolveOpenLlmPool`); the
// substrate's auth-env resolver threads NO token for this kind (see
// `resolveScrubbedAuthEnv`). Only the single-owner Open path produces it.
export type CredentialKind = 'api_key' | 'oauth' | 'codex_oauth' | 'ambient'

export type CooldownReason = 'rate_limit_429' | 'billing_402' | 'auth_401' | 'consecutive_failures' | 'manual'

/** Cooldown TTLs. Exported so adapters can override per-call when they have better data. */
export const COOLDOWN_429_MS = 60_000
export const COOLDOWN_402_MS = 30 * 60_000
export const COOLDOWN_401_MS = 5 * 60_000
export const MAX_CONSECUTIVE_FAILURES = 5
export const CONSECUTIVE_COOLDOWN_MS = 60 * 60_000

/**
 * CEILING on any single park, and the only bound this pool has.
 *
 * Cooldowns became MONOTONIC under failure (see {@link park}) so a short park
 * could not release a long one. That fix has a cost nobody had priced: with no
 * ceiling, one absurd park is UNSHORTENABLE. `>=` rejects every finite
 * replacement, and {@link reportSuccess} — the one release — has no way to be
 * called: {@link selectCredential} and {@link hasUsableCredential} both filter a
 * cooled credential out, so no NEW dispatch happens, so no new success can be
 * reported. On a single-credential box, which every Open install is, that is the
 * product silent until the process restarts.
 *
 * Precisely: NEW dispatches, not all of them. A turn dispatched BEFORE the park
 * started can still complete and report success afterwards, and that does clear the
 * park (see {@link reportSuccess}). It is not a release the pool can rely on, because
 * it exists only while such a turn happens to be in flight — which is why the ceiling
 * is the guarantee and the in-flight success is luck.
 *
 * The value that gets there is not exotic. `retry-after: 31536000` is one year
 * and a legal HTTP header. `retry-after: 1e308` is worse: the OpenAI adapter's
 * `parseRetryAfterMs` checked `Number.isFinite` on the SECONDS and then
 * multiplied by 1000, so the pool received `Infinity`. Either way an upstream
 * value we do not control decides how long the owner's box stays dark.
 *
 * SIX HOURS because it clears the reset window the owner actually waits out and
 * stops short of every window indistinguishable from a brick. A Claude
 * subscription quota window is five hours, so the longest park with an everyday
 * cause fits under the ceiling untouched.
 *
 * SAID EXACTLY, because the looser claim ("past every reset window we honour")
 * was FALSE and this repo's own surfaces disprove it: `gateway/http/app-usage-
 * surface.ts` meters a 7-day window alongside the 5-hour one, so a weekly-cap
 * `retry-after` IS clamped, and after six hours we probe a credential whose quota
 * has not reset. That cost is already priced below — one failed request every six
 * hours — and it is the cost we choose over a park nothing in the process can end.
 *
 * This is a CLAMP, not a rejection: a park longer than the ceiling still parks
 * for the ceiling. Refusing it outright would hand back a credential the
 * provider just told us to stop using.
 */
export const MAX_PARK_MS = 6 * 60 * 60_000

/**
 * WHOSE turn produced a failure report. `'background'` marks a timer-driven lane
 * with nobody waiting on it (proactive nudge composition); everything else is
 * `'interactive'`. See {@link reportFailure} for what it changes and why.
 */
export type FailureOrigin = 'interactive' | 'background'

export interface PooledCredential {
  /** Stable identifier (e.g. `anthropic-key-1`). MUST be unique within a pool. */
  id: string
  kind: CredentialKind
  /** Secret material. Never log or include in observability spans. */
  secret: string
  /** Optional override for OpenAI-compatible endpoints. */
  base_url?: string
  added_at: number
  use_count: number
  last_used_at?: number
  /** Epoch-ms; falsy / past = available. */
  cooldown_until?: number
  cooldown_reason?: CooldownReason
  /**
   * Epoch-ms at which the CURRENT park began — the anchor {@link MAX_PARK_MS} is
   * measured from, so the ceiling bounds the whole park rather than each report
   * that lands during it. Set when a park starts, preserved while it is extended,
   * cleared by {@link reportSuccess} along with the park itself.
   */
  cooldown_started_at?: number
  consecutive_failures: number
}

export interface CredentialPool {
  credentials: PooledCredential[]
  strategy: CredentialStrategy
  /** Round-robin cursor — only consumed when `strategy === 'round_robin'`. */
  cursor: number
}

export interface NewPoolInput {
  strategy: CredentialStrategy
  credentials: ReadonlyArray<{
    id: string
    kind: CredentialKind
    secret: string
    base_url?: string
  }>
}

/**
 * Construct a fresh pool. Validates that `id` values are unique — duplicate
 * ids are a configuration bug that would break the failure / success reporters
 * (which look up by id) silently.
 */
export function newCredentialPool(input: NewPoolInput): CredentialPool {
  const seen = new Set<string>()
  const now = Date.now()
  const credentials: PooledCredential[] = input.credentials.map((c) => {
    if (seen.has(c.id)) {
      throw new Error(`newCredentialPool: duplicate credential id ${JSON.stringify(c.id)}`)
    }
    seen.add(c.id)
    const out: PooledCredential = {
      id: c.id,
      kind: c.kind,
      secret: c.secret,
      added_at: now,
      use_count: 0,
      consecutive_failures: 0,
    }
    if (c.base_url !== undefined) out.base_url = c.base_url
    return out
  })
  return { credentials, strategy: input.strategy, cursor: -1 }
}

/**
 * Pure read: `true` when at least one credential is currently selectable
 * (not cooling down). Mirrors the exact `available` predicate
 * `selectCredential` uses below, but does NOT mutate the pool — no
 * `use_count` bump, no `last_used_at` stamp, no round-robin cursor advance.
 *
 * Callers that need a fast "is this pool usable right now?" probe without
 * consuming a selection slot MUST use this rather than `selectCredential`,
 * which would inflate `use_count` and advance the round-robin cursor on
 * every probe (corrupting `least_used` / `round_robin` fairness). The
 * credential-pool memoizer's all-cooldown invalidation check is the first
 * such caller (`gateway/wiring/memoize-credential-pool.ts`).
 */
export function hasUsableCredential(pool: CredentialPool): boolean {
  const now = Date.now()
  return pool.credentials.some((c) => !c.cooldown_until || c.cooldown_until <= now)
}

/**
 * 2026-06-17 (import-analysis-completeness) — soonest wall-clock epoch-ms
 * at which SOME credential in the pool leaves cooldown and becomes
 * selectable again. Returns:
 *   - `null` if at least one credential is already available (nothing to
 *     wait for), OR the pool is empty.
 *   - otherwise the minimum `cooldown_until` across all credentials —
 *     i.e. how long a caller must wait before `selectCredential` can
 *     succeed again.
 *
 * Pure read — does NOT mutate the pool. The import substrate uses this in
 * its all-cooldown branch to tell the runner the ACTUAL retry-after window
 * (so the runner sleeps the right amount + shows an accurate countdown)
 * rather than guessing with a fixed backoff schedule.
 */
export function soonestCooldownUntil(pool: CredentialPool): number | null {
  const now = Date.now()
  let soonest: number | null = null
  for (const c of pool.credentials) {
    // An available credential means nothing to wait for.
    if (!c.cooldown_until || c.cooldown_until <= now) return null
    if (soonest === null || c.cooldown_until < soonest) soonest = c.cooldown_until
  }
  return soonest
}

/**
 * Select the next credential per the pool's strategy, skipping any in
 * cooldown. Mutates the pool: increments `use_count`, sets `last_used_at`,
 * advances the round-robin cursor. Returns `null` if every credential is
 * cooling down — callers MUST treat that as a hard failure (no key to dispatch
 * with) rather than spinning.
 */
export function selectCredential(pool: CredentialPool): PooledCredential | null {
  const now = Date.now()
  const available = pool.credentials.filter((c) => !c.cooldown_until || c.cooldown_until <= now)
  if (available.length === 0) return null

  let pick: PooledCredential
  switch (pool.strategy) {
    case 'fill_first': {
      const first = available[0]
      if (first === undefined) return null
      pick = first
      break
    }
    case 'round_robin': {
      // Advance cursor inside the *available* slice so a credential entering
      // cooldown does not stall rotation. Use the credential id to keep the
      // cursor stable across selections so order is deterministic.
      const ids = available.map((c) => c.id)
      const lastId = pool.credentials[pool.cursor]?.id
      const startIdx = lastId !== undefined ? ids.indexOf(lastId) : -1
      const nextIdx = (startIdx + 1) % ids.length
      const nextId = ids[nextIdx]
      const candidate = pool.credentials.find((c) => c.id === nextId)
      if (candidate === undefined) return null
      pick = candidate
      pool.cursor = pool.credentials.indexOf(pick)
      break
    }
    case 'random': {
      const idx = Math.floor(Math.random() * available.length)
      const candidate = available[idx]
      if (candidate === undefined) return null
      pick = candidate
      break
    }
    case 'least_used': {
      pick = available.reduce<PooledCredential>((acc, c) => {
        if (c.use_count < acc.use_count) return c
        return acc
      }, available[0]!)
      break
    }
  }

  pick.use_count++
  pick.last_used_at = now
  return pick
}

/**
 * A cooldown is a FLOOR AGAINST FAILURE REPORTS: {@link reportFailure} may only
 * ever push it LATER. `park` is what makes that true: it takes the max of the
 * standing park and the proposed one, and leaves
 * `cooldown_reason` describing whichever park actually governs. The plain
 * assignment it replaces had a THIRD failure direction nobody had named — a
 * SHORT park silently TRUNCATING a long one — and the release it handed out was
 * of a credential something had already judged unfit.
 *
 * The concrete case (Codex review, PR #356). A background report cannot trip the
 * hour-long strike park and cannot extend one, both of which were handled. But
 * `reportFailure(pool, id, 401, undefined, 'background')` arriving while an
 * hour-long `consecutive_failures` park stands used to overwrite `cooldown_until`
 * with `now + COOLDOWN_401_MS` — five minutes — and relabel the reason. A
 * timer-driven lane with nobody waiting on it thereby RELEASED the credential
 * the owner's own strike counter had benched, 55 minutes early, and left a label
 * naming the wrong cause. Reachable whenever a background turn is in flight while
 * the interactive lane parks the credential underneath it.
 *
 * Monotonic-under-failure applies on BOTH lanes rather than only the background
 * one, because it is the same defect wherever it appears and it is a smaller rule
 * than a lane-conditional: a 429's one-minute window must not release a standing
 * 30-minute `billing_402` park either, and a `retry-after` of two hours must not
 * be undercut by a later short status. {@link reportSuccess} stays the ONE
 * release — a confirmed working dispatch is the only evidence that ends a park.
 *
 * `>=` rather than `>` so an equal-length park does not RELABEL a standing one:
 * the first reason to explain a given expiry is the one that keeps it.
 *
 * THE CEILING IS APPLIED HERE, not at the call sites, because monotonicity is
 * what makes an unbounded park permanent and this is the one line monotonicity
 * lives on — see {@link MAX_PARK_MS}.
 *
 * THE CEILING IS ANCHORED TO WHEN THE PARK BEGAN, not to the clock of whichever
 * report happens to be speaking. Re-deriving it per call made `MAX_PARK_MS` not a
 * bound at all: reports DO arrive during a park — a parked credential is never
 * SELECTED, but {@link reportFailure} is called per error event by turns already
 * dispatched before the park started, and each one recomputes a ceiling further
 * out, so the monotonic rule below adopts it. Measured on this file: two
 * over-ceiling reports five hours apart walked one park from 21,600,000 ms to
 * 39,600,000 ms — six hours to eleven — while every assertion about the ceiling
 * still passed. Anchoring makes the second report re-derive the SAME ceiling, so
 * `>=` returns early and the park expires six hours after it started, once.
 *
 * A NON-FINITE proposal collapses to the ceiling rather than being written
 * through, because `NaN` is falsy and `NaN > now` is false, so writing it would
 * make a PARKED credential read as available at every reader in this file — the
 * failure direction that hammers a provider asking us to stop. Said honestly:
 * NOTHING IN PRODUCTION REACHES THAT ARM TODAY. {@link reportFailure} filters a
 * non-finite `retry_after_ms` before it gets here and every other call site passes
 * `now + <constant>`, so this is a belt on an untrusted-arithmetic path and not a
 * live defence — the adapters upstream have shipped `Infinity` twice, which is why
 * the belt stays rather than being deleted as dead. Do not credit it with catching
 * anything the guard above already catches.
 */
function park(c: PooledCredential, until: number, reason: CooldownReason): void {
  const now = Date.now()
  const standing = c.cooldown_until !== undefined && c.cooldown_until > now
  // ADOPT AN ANCHOR WHENEVER ONE IS MISSING, standing park or not. Anchoring only
  // fresh parks left the exact walk-outward hole it was meant to close, one step
  // further in: a STANDING park with no `cooldown_started_at` re-derived the ceiling
  // from every report and never gained an anchor to stop it. Measured on this
  // function: reports at +5h/+10h/+15h against a standing six-hour park walked it to
  // 11h, 16h, then 21h, unbounded. That state is reachable — a credential carried
  // across a pool re-resolve from before this field existed, or any `cooldown_until`
  // written by another path — so the missing-anchor case has to be handled rather
  // than assumed away. The park's true start is unknowable by then, and `now` is the
  // honest conservative answer: it may run up to one window past six hours from the
  // real beginning, and never further.
  if (!standing || c.cooldown_started_at === undefined) c.cooldown_started_at = now
  const ceiling = c.cooldown_started_at + MAX_PARK_MS
  const capped = Number.isFinite(until) ? Math.min(until, ceiling) : ceiling
  if (c.cooldown_until !== undefined && c.cooldown_until >= capped) return
  c.cooldown_until = capped
  c.cooldown_reason = reason
}

/**
 * Report a non-2xx / connection failure. Sets the cooldown clock per the
 * status code and increments `consecutive_failures`. After
 * `MAX_CONSECUTIVE_FAILURES` strikes the credential is parked for an hour.
 *
 * Every cooldown write here goes through {@link park}, so a failure can only push
 * a standing park LATER — never shorten it, and never relabel one it does not
 * outlast. See that docblock.
 *
 * `retry_after_ms` (parsed from upstream `retry-after` header) overrides the
 * default 429 cooldown — adapters MUST honor it so we play nice with provider
 * back-pressure signals. It is honoured up to {@link MAX_PARK_MS} and no further,
 * and a non-finite or negative value is discarded in favour of the status default
 * rather than believed: the number is an upstream one, and the cost of believing a
 * bad one is a credential nothing can release.
 *
 * `origin` says WHOSE turn failed, and it changes only the STRIKE COUNTER:
 *
 *   - `'interactive'` (default) — a person is waiting on this turn. Unchanged
 *     behaviour: count the strike, and park the credential for
 *     {@link CONSECUTIVE_COOLDOWN_MS} once it reaches
 *     {@link MAX_CONSECUTIVE_FAILURES}.
 *   - `'background'` — a timer-driven lane (proactive nudge composition). The
 *     per-status cooldown still applies, because a real 429/402/401 is the
 *     provider's own back-pressure and ignoring it would be rude and useless.
 *     But the strike counter is untouched — NOT incremented, and NOT re-read — so
 *     a background report can neither TRIP the hour-long park nor RE-ARM one an
 *     interactive turn already tripped. Both halves matter: gating only the
 *     increment still lets a background failure re-stamp `cooldown_until` an hour
 *     into the future every time it fires, which is the same outage with a slower
 *     fuse.
 *
 *     ⚠️ SAID EXACTLY, because the looser phrasing ("a background report cannot
 *     EXTEND a park") was WRONG and this file's own test disproves it. What a
 *     background report cannot do is reach {@link CONSECUTIVE_COOLDOWN_MS} — it
 *     has no route to the strike ledger. It CAN still push the expiry later when
 *     its own PROVIDER STATUS parks longer than whatever stands: a `retry-after`
 *     of two hours outlasts the hour-long strike park, so {@link park} keeps the
 *     two hours and relabels to `rate_limit_429`. That is correct and deliberate
 *     — a provider telling us to wait two hours is a fact about the credential,
 *     not an escalation this lane invented, and ignoring it would hammer someone
 *     who asked us not to. The bound that matters is that nothing a background
 *     lane does is SELF-COMPOUNDING.
 *
 *     The THIRD direction — TRUNCATING a standing park — is closed by
 *     {@link park} for every caller, not just this lane, and that is the one that
 *     handed the owner's lane a credential it had already benched.
 *
 * WHY THE ASYMMETRY (incident, live instance 2026-08-17). This counter is
 * PER-CREDENTIAL but the consequence is POOL-WIDE on a single-credential box —
 * which every Open install is. Five reminder-compose failures in a row, none of
 * them a quota condition, parked the one credential for an hour, and from then
 * on EVERY owner chat turn failed instantly with "all Anthropic credentials are
 * in cooldown (429/402/401)". The product went silent because a nudge failed
 * five times, and the message named a cause that was not true.
 *
 * The strike counter exists to stop us hammering a credential that is silently
 * broken. A background lane is the WRONG detector for that: nobody is waiting on
 * it, it retries on its own schedule, and any condition it could discover will be
 * rediscovered — immediately, authoritatively, with a real status — by the next
 * interactive turn, which cools the credential itself. So the counter keeps its
 * job and loses the only input that could weaponise it against the owner.
 */
export function reportFailure(
  pool: CredentialPool,
  id: string,
  status: number,
  retry_after_ms?: number,
  origin: FailureOrigin = 'interactive',
): void {
  const c = pool.credentials.find((x) => x.id === id)
  if (!c) return
  const now = Date.now()
  // `retry_after_ms` IS UNTRUSTED ARITHMETIC, not a number we computed. It comes
  // from an upstream header an adapter parsed, and the parsers have already shipped
  // `Infinity` (finiteness checked on the seconds, then multiplied by 1000) — a
  // value that used to park the credential until the process restarted.
  //
  // `> 0`, NOT `>= 0`, and the difference is the whole guard. `0` is what the
  // header parser used to hand us for `retry-after: -30` and for any HTTP-date
  // already in the past (clock skew alone produces those), because it floored
  // negatives instead of rejecting them. A `0` passes a `>= 0` test, so the park
  // became `now + 0` — and `now` is not a park: `hasUsableCredential`,
  // `soonestCooldownUntil` and `selectCredential` all treat `cooldown_until <= now`
  // as AVAILABLE, so a real 429 bought no cooldown whatsoever and we answered the
  // provider's back-pressure with an immediate retry. Worst on the background lane,
  // which by design never touches the strike ledger and so has no second net under
  // it. The parser now returns `undefined` for the same values; this is the boundary
  // that holds even if a future adapter forgets.
  //
  // THE TWO GUARDS ARE NOT REDUNDANT. `park`'s clamp bounds an `Infinity` at the
  // six-hour ceiling, which stops the brick; this boundary decides that a value
  // that is not a positive number of milliseconds buys no extra time AT ALL, so a
  // garbage header gets the 60-second default instead of the maximum park the pool
  // allows. And it is the only one of the two that can see a `NaN` for what it is:
  // by the time `now + NaN` reaches `park` the origin is gone.
  const retry_after =
    retry_after_ms !== undefined && Number.isFinite(retry_after_ms) && retry_after_ms > 0
      ? retry_after_ms
      : undefined
  if (status === 429) {
    park(c, now + (retry_after ?? COOLDOWN_429_MS), 'rate_limit_429')
  } else if (status === 402) {
    park(c, now + COOLDOWN_402_MS, 'billing_402')
  } else if (status === 401) {
    park(c, now + COOLDOWN_401_MS, 'auth_401')
  }
  // THE STRIKE LEDGER IS INTERACTIVE-ONLY, both the write and the read. A
  // background report must not be able to reach `CONSECUTIVE_COOLDOWN_MS` — not
  // by counting toward the threshold, and not by re-arming a park that is
  // already standing.
  if (origin === 'interactive') {
    c.consecutive_failures++
    if (c.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
      park(c, now + CONSECUTIVE_COOLDOWN_MS, 'consecutive_failures')
    }
  }
}

/**
 * Report a successful dispatch. Resets the failure counter + clears any
 * cooldown so a temporary 429 stops parking the credential after we've
 * confirmed it's working again.
 *
 * UNCONDITIONAL, and that is the deliberate half of the FLOOR rule described on
 * {@link park}: no comparison, so a success clears even a park a provider asked
 * for. Reachable — a turn dispatched before the park started can complete 200
 * after it, and that success wipes a two-hour `retry-after`. It stays
 * unconditional because a completed request is the only DIRECT evidence the
 * credential works, and the alternative fails in the direction this pool cannot
 * see its way out of: a park nothing releases on a single-credential box, which
 * every Open install is. A cleared park that should have stood costs one more
 * failed request, which re-parks it.
 */
export function reportSuccess(pool: CredentialPool, id: string): void {
  const c = pool.credentials.find((x) => x.id === id)
  if (!c) return
  c.consecutive_failures = 0
  delete c.cooldown_until
  delete c.cooldown_reason
  delete c.cooldown_started_at
}
