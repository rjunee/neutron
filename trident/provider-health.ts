/**
 * @neutronai/trident — EXHAUSTED, UNAVAILABLE, OR NEITHER: the three states a
 * cross-model provider can be in, and the one that is the owner's to fix.
 *
 * ── The incident this exists for (ISSUES #567) ───────────────────────────────
 * A cross-model seat pointed at a provider whose account was out of quota. Every
 * review call failed, the never-silent-downgrade gate correctly refused to APPROVE,
 * and the lane could therefore never merge — but the run discovered this only AFTER
 * paying for the entire panel, and the message it produced said "deferred", which
 * reads as a transient blip. The owner is quota-constrained across providers, so this
 * is not an edge case; it is the normal case, and it was costing a full panel per run
 * to learn a fact that never changes on its own.
 *
 * ── Why the three states must not be collapsed ───────────────────────────────
 *   • EXHAUSTED is a BUSINESS decision the owner has to make: buy capacity, re-point
 *     the slot at another provider, or set the slot to NONE. Nothing the run can do
 *     will clear it, so retrying is pure spend and substituting silently would convert
 *     his decision into an invisible one (owner, 2026-08-11). It must be surfaced
 *     LOUDLY and EARLY.
 *   • TRANSIENT (capacity, 5xx, a timeout) clears on its own. Retry it, and if it
 *     still fails, fall back only WITHIN the non-Claude family — never to Claude,
 *     which would restore the single-family panel the seat exists to break.
 *   • UNKNOWN is anything this classifier cannot place. It is treated as transient,
 *     because the cost of retrying a genuinely dead provider once is one call, while
 *     the cost of declaring a live provider exhausted is a false alarm that trains the
 *     owner to ignore the alarm.
 *
 * ── Why a string classifier rather than a status code ────────────────────────
 * The two providers report exhaustion differently and neither uses a dedicated code:
 * Moonshot answers HTTP 429 for both a per-minute rate limit and an out-of-credit
 * account, and the codex CLI prints a prose line to stderr and exits non-zero. The
 * distinguishing evidence is in the TEXT either way, so the text is what gets
 * classified — once, here, with a test — rather than being re-grepped at each call
 * site with slightly different patterns.
 */

/** What a failed provider call means for the run. See the header. */
export type ProviderHealth = 'exhausted' | 'transient' | 'unknown'

/**
 * Exit code a cross-model wrapper uses for EXHAUSTED.
 *
 * Deliberately distinct from the existing `deferred` codes (3/5 for codex, 2/3 for
 * kimi) rather than folded into them: the whole point is that the workflow can tell
 * "the provider is out of quota" from "the call flaked", and reusing a code would make
 * that impossible for exactly the case the owner reported.
 */
export const EXIT_PROVIDER_EXHAUSTED = 4

/**
 * Markers that mean "this account has no capacity left until someone pays or waits out
 * a billing period". Matched case-insensitively against the provider's own message.
 *
 * KEPT NARROW ON PURPOSE. A false EXHAUSTED stops the run and pages the owner; a false
 * TRANSIENT costs one retry. So a phrase only earns a place here if it cannot plausibly
 * describe a momentary condition — `rate limit` is absent for exactly that reason (it
 * is the per-minute case far more often than the out-of-credit case), while
 * `insufficient_quota` and `usage limit reached` are not things a provider says about a
 * blip.
 */
const EXHAUSTED_MARKERS: ReadonlyArray<string> = Object.freeze([
  'insufficient_quota',
  'insufficient quota',
  'quota exceeded',
  'quota_exceeded',
  'out of credit',
  'insufficient balance',
  'insufficient_balance',
  'usage limit reached',
  'usage_limit_reached',
  'exceeded your current quota',
  'billing_hard_limit_reached',
  'subscription has expired',
  'plan limit reached',
  'no credits remaining',
])

/**
 * Markers that mean "busy or broken right now, try again". These are checked ONLY when
 * no exhaustion marker matched, because a body can carry both (a 429 whose message
 * names a quota is exhaustion, not capacity).
 */
const TRANSIENT_MARKERS: ReadonlyArray<string> = Object.freeze([
  'overloaded',
  'service unavailable',
  'service_unavailable',
  'temporarily unavailable',
  'try again later',
  'timed out',
  'timeout',
  'connection reset',
  'econnreset',
  'etimedout',
  'bad gateway',
  'gateway timeout',
  'internal server error',
  'rate limit',
  'rate_limit',
])

/**
 * Classify a provider's failure text.
 *
 * Order is load-bearing: exhaustion wins over transience whenever both appear, because
 * a quota message delivered with a 429 is still a quota message and retrying it burns
 * the panel to learn nothing.
 */
export function classifyProviderFailure(text: string | null | undefined): ProviderHealth {
  if (typeof text !== 'string' || text.trim().length === 0) return 'unknown'
  const haystack = text.toLowerCase()
  for (const marker of EXHAUSTED_MARKERS) {
    if (haystack.includes(marker)) return 'exhausted'
  }
  for (const marker of TRANSIENT_MARKERS) {
    if (haystack.includes(marker)) return 'transient'
  }
  return 'unknown'
}

/**
 * Classify an HTTP status plus its body together.
 *
 * THE BODY DECIDES, THE STATUS ONLY NARROWS. 429 alone is ambiguous — it is the code
 * for both "too fast" and "out of credit" — so a 429 whose body names a quota is
 * exhaustion and a 429 whose body does not is transient. 402 is unambiguous and needs
 * no body. Everything 5xx is transient, and a 4xx that is neither is `unknown` so an
 * auth failure is not mistaken for a spend problem.
 */
export function classifyProviderResponse(status: number, body: string | null | undefined): ProviderHealth {
  const fromBody = classifyProviderFailure(body)
  if (fromBody === 'exhausted') return 'exhausted'
  // 402 Payment Required is the one status that means exhaustion on its own.
  if (status === 402) return 'exhausted'
  if (status === 429) return 'transient'
  if (status >= 500) return 'transient'
  return fromBody
}

/**
 * The sentence the owner reads when a seat is exhausted.
 *
 * NAMES THE THREE REMEDIES, because "quota exceeded" alone leaves an operator staring
 * at a blocked merge with no stated way out — and two of the three remedies are
 * settings changes he can make in the pane the rest of this change builds.
 */
export function exhaustedRemedyText(slotTitle: string, modelId: string): string {
  return (
    `${slotTitle} is pointed at ${modelId}, and that provider reports NO REMAINING QUOTA. ` +
    'This will not clear on its own and nothing will be retried against it: quota is a ' +
    'spending decision, and substituting another model silently would make that decision ' +
    'invisible. Three ways forward, all yours: add capacity with the provider, re-point ' +
    'this slot at a different non-Claude model, or set the slot to NONE to run without it. ' +
    'Until then this seat produces no review, and a configured seat that produces no ' +
    'review cannot be counted as an approval.'
  )
}
