/**
 * Kimi K3 — a cross-model reviewer from a DIFFERENT model family.
 *
 * ── WHY A FOURTH PANELIST ────────────────────────────────────────────────────
 * The review panel is `argus:claude`, `argus:adversarial`, and `argus:codex`.
 * Two of those three are the same model family: same training data, same blind
 * spots, correlated failures. When both Claude reviewers approve, that is weaker
 * evidence than the vote count implies, and if codex is unconfigured or defers
 * the panel collapses to a single family entirely.
 *
 * K3 is a genuinely different architecture, so **its DISAGREEMENTS are the
 * value**. A defect every Claude-family reviewer misses but K3 flags is exactly
 * the class the current panel is structurally blind to. It is not here to be a
 * third vote for consensus.
 *
 * ── WHY THIS IS TYPESCRIPT AND NOT A SHELL SCRIPT ────────────────────────────
 * The legacy harness reached K3 through a bash + curl wrapper because Claude
 * Code resolves `agent({model})` through its OWN endpoint, so a non-Anthropic
 * model is unreachable from inside a workflow that way — a subprocess was the
 * only route. That constraint on the *workflow* still holds and the workflow
 * still shells out.
 *
 * But the thing being shelled INTO does not have to be bash. Moonshot serves an
 * **Anthropic-compatible** API, so the call is an ordinary `fetch` with an
 * `x-api-key` header, and writing it in TypeScript buys real unit tests with an
 * injected `fetch` — including a test for the empty-answer trap below, which is
 * the failure most likely to silently degrade the panel and is essentially
 * untestable in bash.
 *
 * ── THE EMPTY-ANSWER TRAP (measured, do not "simplify" this away) ────────────
 * K3 thinks by default and its thinking tokens count against `max_tokens`. On a
 * 2.7KB diff it spent ~4,971 tokens thinking before emitting any answer text. At
 * `max_tokens: 6000` the response came back with a thinking block and **no text
 * block at all** — a successful HTTP 200 carrying zero answer. A reviewer
 * configured that way defers on every non-trivial input, and a reviewer that
 * returned "no findings" from an empty answer would be an APPROVE that reviewed
 * nothing. So: a 200 with no text is `deferred`, never empty-and-fine, and the
 * default budget is high enough that thinking has room.
 *
 * ── THE HARD INVARIANT ───────────────────────────────────────────────────────
 * Any non-`connected` status with a credential PRESENT is `deferred`, and a
 * deferred cross-model review can NEVER become an APPROVE — enforced
 * deterministically by `enforceCrossModelGate` in the workflow, not left to a
 * synthesis LLM. And there is **no fallback to a Claude-family model, ever**:
 * that would quietly restore the single-family panel this reviewer exists to
 * break, while still reporting that a cross-model review happened.
 */

/**
 * Anthropic-compatible; Kimi serves the same wire shape.
 *
 * Subscription billing (Kimi For Coding), not per-token platform billing.
 * Switched 2026-08-08 — these are two different credential classes on two
 * different hosts, so the key and the base URL must move together: a
 * subscription key returns 401 against the old platform endpoint
 * (`https://api.moonshot.ai/anthropic`), and this host rejects platform keys.
 * Overridable via KIMI_BASE_URL so a platform key can still be used
 * deliberately rather than by accident.
 */
export const KIMI_BASE_URL =
  process.env['KIMI_BASE_URL'] ?? 'https://api.kimi.com/coding'
export const KIMI_DEFAULT_MODEL = 'kimi-k3'

/**
 * High on purpose — thinking tokens are drawn from this budget. See the
 * empty-answer note in the header before lowering it.
 */
export const KIMI_DEFAULT_MAX_TOKENS = 20_000

/** Mirrors `codexStatus` so the panel has ONE vocabulary for cross-model peers. */
export type CrossModelStatus =
  /** Ran, returned review text. */
  | 'connected'
  /** No credential configured. The graceful path — noted, never blocking. */
  | 'not_connected'
  /** Configured but the call failed, timed out, or returned no answer. BLOCKS. */
  | 'deferred'

export interface KimiReviewResult {
  status: CrossModelStatus
  /** The review text. Empty unless `connected`. */
  text: string
  /**
   * Why it is not connected/deferred. Safe to surface: carries no key material,
   * because every construction site below builds it from a status code, a
   * timeout, or a provider message — never from the request.
   */
  reason?: string
}

export type KimiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface KimiReviewInput {
  /** The unified diff to review. */
  diff: string
  /** What the change was supposed to do, so the reviewer can judge fitness. */
  task: string
  /** Absent/empty → `not_connected`. Never logged, never echoed. */
  apiKey: string | null
  model?: string
  maxTokens?: number
  timeoutMs?: number
  fetchImpl?: KimiFetch
}

const REVIEW_SYSTEM = [
  'You are an INDEPENDENT code reviewer from a different model family than the rest of the panel.',
  'Your DISAGREEMENTS are your value: prefer flagging a defect the other reviewers would plausibly miss over agreeing with an obvious consensus.',
  'Evidence-gate every claim with a file:line or a concrete reproduction. Do not speculate.',
  'If you cannot verify part of the change, say so explicitly rather than assuming it is fine.',
  'End your response with exactly one line: "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES".',
].join(' ')

/**
 * Review a diff with K3.
 *
 * Never throws for an expected failure — every outcome is a status. A caller
 * that has to distinguish "no credential" from "the provider is down" gets that
 * from `status`, and both are safe to act on without a try/catch.
 */
export async function reviewWithKimi(input: KimiReviewInput): Promise<KimiReviewResult> {
  if (input.apiKey === null || input.apiKey.length === 0) {
    return {
      status: 'not_connected',
      text: '',
      reason: 'no Kimi API key configured for this instance',
    }
  }
  if (input.diff.length === 0) {
    // A reviewer handed nothing to review must not answer. Reporting APPROVE on
    // an empty diff is the same defect class as approving an empty answer.
    return { status: 'deferred', text: '', reason: 'empty diff — nothing to review' }
  }

  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as KimiFetch)
  const model = input.model ?? KIMI_DEFAULT_MODEL
  const max_tokens = input.maxTokens ?? KIMI_DEFAULT_MAX_TOKENS
  const timeoutMs = input.timeoutMs ?? 480_000

  const body = JSON.stringify({
    model,
    max_tokens,
    system: REVIEW_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `TASK the change was meant to accomplish:\n${input.task}\n\nUnified diff to review:\n${input.diff}`,
      },
    ],
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let raw: string
  let status: number
  let ok: boolean
  try {
    const res = await fetchImpl(`${KIMI_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: controller.signal,
    })
    ok = res.ok
    status = res.status
    raw = await res.text()
  } catch (err) {
    // Network failure, or our own abort firing. Either way the credential was
    // present, so this is DEFERRED and blocks — never a quiet pass.
    return {
      status: 'deferred',
      text: '',
      reason: `Kimi request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timer)
  }

  if (!ok) {
    // 401/403 is a rejected key and 429 is no credit. Both are still DEFERRED
    // rather than a distinct 'auth' status: the panel's only question is whether
    // a configured reviewer produced a review, and neither of these did. The
    // status code goes in the reason so the operator can tell them apart.
    return { status: 'deferred', text: '', reason: `Kimi API returned HTTP ${status}` }
  }

  const text = extractAnswerText(raw)
  if (text === null) {
    return {
      status: 'deferred',
      text: '',
      reason: 'Kimi returned HTTP 200 with no answer text (thinking budget likely exhausted — see KIMI_DEFAULT_MAX_TOKENS)',
    }
  }
  return { status: 'connected', text }
}

/**
 * Pull the answer out of an Anthropic-shaped `content` array.
 *
 * Returns `null` — NOT `''` — when there is no text block, because the two mean
 * different things to the caller and collapsing them is exactly how an
 * answerless 200 becomes a silent approval. `thinking` blocks are skipped: they
 * are not the answer, and a response containing only thinking is the trap. A
 * whitespace-only answer is an answerless answer — the same class as that
 * thinking-budget trap.
 */
export function extractAnswerText(rawBody: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  const content = (parsed as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      parts.push(b.text)
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/**
 * Did K3's review end in a request for changes?
 *
 * Defaults to REQUEST_CHANGES on anything unclear. An unparseable review from a
 * reviewer that DID run must not become an approval by omission — the whole
 * point of this panelist is to catch what the others miss, so ambiguity resolves
 * toward blocking rather than toward agreement.
 */
export function kimiRequestsChanges(reviewText: string): boolean {
  const lines = reviewText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!
    // Match the VERDICT line anywhere it appears on a line, so a trailing
    // "```" or a stray character after it does not lose the verdict.
    if (/VERDICT:\s*APPROVE\b/i.test(line)) return false
    if (/VERDICT:\s*REQUEST_CHANGES\b/i.test(line)) return true
  }
  return true
}
