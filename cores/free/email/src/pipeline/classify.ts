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

import { buildClassifyPrompt } from './prompts.ts'
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
  cache_store: (sender: string, category: string) => void
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
 */
export function bareAddress(from: string): string {
  const match = /<([^>]*)>/.exec(from)
  const raw = match?.[1] ?? from
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

/** The mass-mailer signal: an unsubscribe affordance, or the promotions bucket. */
export function hasUnsubscribeSignal(body: string, label_ids: readonly string[]): boolean {
  if (body.toLowerCase().includes('unsubscribe')) return true
  return label_ids.includes(PROMOTIONS_LABEL)
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
    return applyDowngrade({
      category: cached.category,
      important: cached.category === 'important',
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
      if (verdict !== null && typeof verdict.category === 'string' && verdict.category.length > 0) {
        const category = verdict.category
        deps.cache_store(bareAddress(input.sender), category)
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
