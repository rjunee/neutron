/**
 * @neutronai/email-managed-core — the classification CASCADE.
 *
 * Pure module: no I/O of its own, no database handle, no clock. Everything it
 * touches arrives through `deps` — including the LLM, which is NULLABLE.
 *
 * ── WHY A CASCADE, DETERMINISTIC-FIRST ────────────────────────────────────────
 * Most mail classifies with NO model call at all. The owner's own rules, three
 * importance patterns and a learned sender cache answer the common cases; the
 * LLM is the LAST resort and its cost is bounded by writing its verdict back
 * into `sender_cache`. This ordering is also what makes an LLM-less box work:
 * a `null` llm (or one that throws) simply falls through to the default —
 * the classifier NEVER crashes a poll tick.
 *
 * Order:
 *   (a) sender_rules   — owner data. Exact address beats domain. `protected`
 *                        rules are important and immune to (c).
 *   (b) importance patterns — authentication codes, billing actions,
 *                        deadlines. These WIN over (c): a "payment failed"
 *                        notice with an unsubscribe footer is still a payment
 *                        that failed.
 *   (c) mass-mailer downgrade — unsubscribe text (or CATEGORY_PROMOTIONS)
 *                        forces `newsletter` / not-important, and it applies
 *                        to the cache and LLM verdicts too. This is the
 *                        source system's semantic and it is what keeps a
 *                        marketing blast that calls itself urgent out of the
 *                        owner's chat.
 *   (d) sender_cache   — a previously learned category.
 *   (e) llm            — one shot, defensively parsed, result cached.
 *   (f) default        — `other`, not important.
 */

import { buildClassifyPrompt, DEFAULT_CATEGORIES } from './prompts.ts'
import type { SenderCacheRow, SenderRule } from './store.ts'

export type ClassificationSource = 'rule' | 'pattern' | 'cache' | 'llm' | 'default'

export interface Classification {
  category: string
  important: boolean
  /** Short human phrase — this is what the escalation text quotes. */
  reason: string
  source: ClassificationSource
  /** True when a `protected` sender rule matched. */
  protected: boolean
}

export interface ClassifyInput {
  sender: string
  subject: string
  snippet: string
  body_text: string
  label_ids: readonly string[]
}

export interface ClassifyDeps {
  rules: readonly SenderRule[]
  cache_lookup: (sender: string) => SenderCacheRow | null
  /** Persists the learned verdict. BOTH facts — the category and the importance
   *  decision — because the second cannot be re-derived from the first. */
  cache_store: (sender: string, category: string, important: boolean) => void
  /** The substrate one-shot caller, or null on an LLM-less box. */
  llm: ((prompt: string) => Promise<string>) | null
}

/** Gmail's promotions bucket — the label half of the mass-mailer signal. */
export const PROMOTIONS_LABEL = 'CATEGORY_PROMOTIONS'

/** How much body the classifier looks at / sends to the model. */
export const BODY_EXCERPT_LIMIT = 2000

/**
 * Extract the bare address from an RFC 5322 mailbox spec
 * (`"Name" <local@host>` → `local@host`). Returns the lower-cased input when
 * there is no angle-bracket form.
 *
 * ── WHY TWO indexOf CALLS AND NOT A REGEX ─────────────────────────────────────
 * This used to be `/<([^>]*)>/.exec(from)`, and CodeQL was right to call it
 * `js/polynomial-redos`. `[^>]` matches `<` as well, so on a `From:` header of
 * N `<` characters and no `>` the engine consumes to end-of-string from EVERY
 * one of the N starting positions: quadratic. Measured on the pre-fix code on
 * ONE developer box — 8 KB → 104 ms, 16 KB → 437 ms, 32 KB → 1.6 s, 64 KB →
 * 6.8 s (`pipeline-classify-redos.test.ts` carries the same series; the
 * absolute figures vary several-fold by machine, the QUADRUPLING per doubling
 * does not). A 1 MB header — well inside what a sender may legally emit — is
 * therefore minutes of pegged CPU. `from` is an RFC 5322 header, so the REMOTE SENDER
 * chooses this string; on a public, self-hostable project that is a
 * denial-of-service anyone can post to any self-hoster's mail path.
 *
 * `indexOf` scans forward once and has no backtracking to do, so the rewrite is
 * linear by construction rather than linear by careful quantifier tuning. The
 * semantics are preserved exactly: the greedy `[^>]*` between `<` and `>` picks
 * out the span from the FIRST `<` to the FIRST `>` that follows it, and a `<`
 * with no `>` after it anywhere makes the whole match fail and falls back to the
 * unbracketed input. See `pipeline-classify-redos.test.ts` for the linearity pin.
 */
export function bareAddress(from: string): string {
  const open = from.indexOf('<')
  const close = open === -1 ? -1 : from.indexOf('>', open + 1)
  const raw = open !== -1 && close !== -1 ? from.slice(open + 1, close) : from
  return raw.trim().toLowerCase()
}

/** The domain half of a bare address, or '' when there isn't one. */
export function addressDomain(from: string): string {
  const bare = bareAddress(from)
  const at = bare.lastIndexOf('@')
  return at === -1 ? '' : bare.slice(at + 1)
}

interface PatternHit {
  category: string
  reason: string
}

const AUTH_CODE =
  /\b(2fa|two[- ]factor|verification code|one[- ]time (code|password)|security code|otp)\b/i
const BILLING_ACTION =
  /(payment failed|payment declined|card declined|past due|invoice due|action required on (your )?account|subscription expir)/i
const DEADLINE = /(deadline|final notice|expires (today|soon)|due by)/i

/**
 * The deterministic importance patterns. Case-insensitive over subject + body.
 * Returns null when nothing fires.
 */
export function matchImportancePattern(subject: string, body: string): PatternHit | null {
  const hay = `${subject}\n${body}`
  if (AUTH_CODE.test(hay)) return { category: 'important', reason: 'authentication code' }
  if (BILLING_ACTION.test(hay)) return { category: 'important', reason: 'billing action' }
  if (DEADLINE.test(hay)) return { category: 'important', reason: 'deadline' }
  return null
}

const UNSUBSCRIBE = 'unsubscribe'

/**
 * The mass-mailer signal: an unsubscribe affordance, or the promotions bucket.
 *
 * ── WHY TWO BOUNDED SPANS AND NOT THE WHOLE BODY ─────────────────────────────
 * This used to be `body.toLowerCase().includes(...)` over the FULL remote body,
 * while every other read of that body is bounded to `BODY_EXCERPT_LIMIT`. Two
 * problems, both on text a remote sender chooses: `toLowerCase()` allocates a
 * second copy of an arbitrarily large body on every message, and a token past
 * the excerpt limit could downgrade a message whose importance patterns had only
 * ever seen the first 2,000 characters — an asymmetry nothing declared.
 *
 * The head alone is not enough: an unsubscribe affordance lives in the FOOTER of
 * a marketing mail, which is exactly the part a head-only scan drops, and losing
 * it puts bulk mail back in the owner's chat. So both ENDS are scanned, each
 * bounded by the same limit, with the spans overlapping by the needle length so
 * a token straddling an edge is still seen. Allocation is bounded by the limit,
 * not by what the sender sent.
 */
export function hasUnsubscribeSignal(body: string, label_ids: readonly string[]): boolean {
  if (label_ids.includes(PROMOTIONS_LABEL)) return true
  const span = BODY_EXCERPT_LIMIT + UNSUBSCRIBE.length
  if (body.slice(0, span).toLowerCase().includes(UNSUBSCRIBE)) return true
  if (body.length <= span) return false
  return body.slice(-span).toLowerCase().includes(UNSUBSCRIBE)
}

/** Pull the first `{...}` block out of a model answer and parse it. */
function parseVerdict(raw: string): { category?: unknown; important?: unknown; reason?: unknown } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Find the rule that governs this sender — exact address first, then domain. */
function matchRule(sender: string, rules: readonly SenderRule[]): SenderRule | null {
  const bare = bareAddress(sender)
  const domain = addressDomain(sender)
  let domainHit: SenderRule | null = null
  for (const rule of rules) {
    const pattern = rule.pattern.trim().toLowerCase()
    if (rule.kind === 'sender' && pattern === bare) return rule
    if (rule.kind === 'domain' && domainHit === null && pattern === domain) domainHit = rule
  }
  return domainHit
}

export async function classifyEmail(
  input: ClassifyInput,
  deps: ClassifyDeps,
): Promise<Classification> {
  const body = input.body_text.slice(0, BODY_EXCERPT_LIMIT)
  const downgrade = hasUnsubscribeSignal(input.body_text, input.label_ids)

  /**
   * The mass-mailer downgrade, applied to a verdict that claims importance.
   * `protected` rules are the one exemption; the deterministic (b) hits are
   * exempt by returning before the downgrade is consulted.
   */
  const applyDowngrade = (c: Classification): Classification =>
    downgrade && c.important && !c.protected
      ? { category: 'newsletter', important: false, reason: 'mass mailer', source: c.source, protected: false }
      : c

  // (a) owner rules.
  const rule = matchRule(input.sender, deps.rules)
  if (rule !== null) {
    if (rule.protected === 1) {
      return {
        category: rule.category ?? 'important',
        important: true,
        reason: 'protected sender rule',
        source: 'rule',
        protected: true,
      }
    }
    // `handling` is the owner saying WHAT TO DO, a different claim from
    // `category` (what this IS). It was persisted and then ignored, so a rule
    // of {category:'newsletter', handling:'escalate'} was filed as a newsletter
    // and archived — the owner asked to be told and was not. An explicit
    // handling therefore decides, and it is immune to the mass-mailer
    // downgrade: an owner naming a sender outranks the heuristic that bulk mail
    // is rarely important.
    if (rule.handling !== null) {
      const escalate = rule.handling === 'escalate'
      return {
        category: rule.category ?? (escalate ? 'important' : 'newsletter'),
        important: escalate,
        reason: `sender rule (${rule.kind}, handling=${rule.handling})`,
        source: 'rule',
        protected: false,
      }
    }
    if (rule.category !== null) {
      const important = rule.category === 'important'
      return applyDowngrade({
        category: rule.category,
        important,
        reason: `sender rule (${rule.kind})`,
        source: 'rule',
        protected: false,
      })
    }
  }

  // (b) deterministic importance patterns — these BEAT the downgrade.
  const pattern = matchImportancePattern(input.subject, body)
  if (pattern !== null) {
    return {
      category: pattern.category,
      important: true,
      reason: pattern.reason,
      source: 'pattern',
      protected: false,
    }
  }

  // (c) mass-mailer downgrade, standalone. Returning HERE (rather than
  // downgrading a later verdict) is also the LLM cost bound: bulk mail is the
  // bulk of an inbox and none of it reaches the model.
  if (downgrade) {
    return {
      category: 'newsletter',
      important: false,
      reason: 'mass mailer',
      source: 'pattern',
      protected: false,
    }
  }

  // (d) learned sender cache — short-circuits the model entirely.
  const cached = deps.cache_lookup(bareAddress(input.sender))
  if (cached !== null) {
    // The IMPORTANCE decision is read back, never re-derived. Reconstructing it
    // as `category === 'important'` discarded every verdict where the two
    // legitimately disagree — `{category:'receipt', important:true}` escalated
    // once and was archived on every message from that sender afterwards.
    return applyDowngrade({
      category: cached.category,
      important: cached.important === 1,
      reason: 'known sender',
      source: 'cache',
      protected: false,
    })
  }

  // (e) the one-shot LLM. Null on an LLM-less box; a throw is not fatal.
  if (deps.llm !== null) {
    try {
      const answer = await deps.llm(
        buildClassifyPrompt({
          sender: input.sender,
          subject: input.subject,
          snippet: input.snippet,
          body_excerpt: body,
        }),
      )
      const verdict = parseVerdict(answer)
      // MODEL OUTPUT IS UNTRUSTED INPUT. Accepting any non-empty string wrote
      // whatever the model emitted straight into `sender_cache`, permanently:
      // one malformed (or prompt-injected) answer and that sender carries an
      // arbitrary category forever, with no path back through the cache. The
      // category must be one the prompt actually offered — an owner's own
      // categories arrive as `sender_rules`, which are handled above and never
      // reach here. An unrecognised category falls through to the deterministic
      // default rather than being invented into the store.
      const proposed = typeof verdict?.category === 'string' ? verdict.category.trim() : ''
      const known = (DEFAULT_CATEGORIES as readonly string[]).includes(proposed)
      if (verdict !== null && known && typeof verdict.important === 'boolean') {
        const category = proposed
        deps.cache_store(bareAddress(input.sender), category, verdict.important === true)
        return applyDowngrade({
          category,
          important: verdict.important === true,
          reason: typeof verdict.reason === 'string' && verdict.reason.length > 0
            ? verdict.reason
            : 'model classification',
          source: 'llm',
          protected: false,
        })
      }
    } catch {
      // A model outage degrades to the deterministic default. It must never
      // reach the poll tick.
    }
  }

  // (f) default.
  return {
    category: 'other',
    important: false,
    reason: 'no importance signal',
    source: 'default',
    protected: false,
  }
}
