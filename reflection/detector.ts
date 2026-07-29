/**
 * @neutronai/reflection — correction detection.
 *
 * Two stages, the cheap one deterministic and the expensive one gated behind it:
 *
 *   1. `looksLikeCorrection(userText)` — a DETERMINISTIC keyword pre-gate. Most
 *      turns are not corrections; running an LLM judge on every turn would be
 *      wasteful. The pre-gate cheaply admits only turns that carry a plausible
 *      correction cue ("no, …", "actually", "don't", "from now on", "I meant",
 *      "should be", "use X not Y", …). Pure + exported so it is unit-testable.
 *
 *   2. `detectCorrection(deps, exchange)` — the LLM judge. Mirrors scribe's
 *      `runExtraction`: dispatch ONE turn through the CC-spawn substrate (NEVER
 *      a direct api.anthropic.com POST), drain tokens, parse a small JSON
 *      verdict. The LLM has the final say on whether the flagged turn is really
 *      a correction (kills keyword false-positives) and distils wrong/right/why.
 *
 * The pre-gate is the "deterministic where possible"; the judge is the "LLM
 * judges what's a correction" — exactly the split the task asks for.
 */

import type { Substrate } from '@neutronai/runtime/substrate.ts'
import { getBestModel } from '@neutronai/runtime/models.ts'
import { drainToText } from '@neutronai/runtime/substrate-text.ts'

import type { CorrectionJudgment } from './types.ts'

const NOT_A_CORRECTION: CorrectionJudgment = Object.freeze({
  is_correction: false,
  wrong: '',
  right: '',
  why: '',
}) as CorrectionJudgment

/**
 * Deterministic correction cues. Case-insensitive substring / word matches.
 * Deliberately broad (recall over precision) — the LLM judge downstream
 * removes false positives, so a missed cue (a silent false negative) is the
 * only real cost, and these cover the overwhelming majority of redirections.
 */
const CUE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bno[,.\s]/i,
  /\bnope\b/i,
  /\bactually\b/i,
  /\bnot\s+(?:quite|what|right|correct|true)\b/i,
  /\bthat'?s\s+(?:not|wrong|incorrect)\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bdon'?t\b/i,
  /\bdo\s+not\b/i,
  /\bstop\b/i,
  /\bi\s+meant\b/i,
  /\bi\s+said\b/i,
  /\binstead\b/i,
  /\bshould\s+(?:be|have|use|n'?t)\b/i,
  /\brather\s+than\b/i,
  /\bnot\s+\w+[,.\s]+(?:use|do|say|prefer)\b/i,
  /,\s*not\b/i, // "use spaces, not tabs" — the X-not-Y correction idiom
  /\bfrom\s+now\s+on\b/i,
  /\bgoing\s+forward\b/i,
  /\bin\s+(?:the\s+)?future\b/i,
  /\balways\s+\w+/i,
  /\bnever\s+\w+/i,
  /\bplease\s+(?:don'?t|stop|use|always|never)\b/i,
  /\bcorrection\b/i,
  /\bremember\s+(?:that|to|this)\b/i,
  /\bprefer\b/i,
])

/**
 * Cheap deterministic gate: does this owner message plausibly carry a
 * correction / redirection / standing-preference cue? Empty / whitespace → false.
 */
export function looksLikeCorrection(userText: string): boolean {
  const t = userText.trim()
  if (t.length === 0) return false
  for (const re of CUE_PATTERNS) {
    if (re.test(t)) return true
  }
  return false
}

export const CORRECTION_JUDGE_PROMPT = `You are a silent learning-keeper for a personal AI assistant. You read ONE exchange — the assistant's last reply, then the owner's response to it — and decide whether the owner is CORRECTING or REDIRECTING the assistant, or stating a standing preference for how it should behave (which is also a correction to capture).

A correction is: the owner says the assistant was wrong, did the wrong thing, made a bad assumption, or tells it to do something differently from now on. Confirming a non-obvious approach the assistant proposed ("yes, always do it that way") IS a correction worth capturing. Ordinary follow-up questions, new requests, thanks, or agreement with nothing new are NOT corrections.

Return a SINGLE JSON object — no preamble, no markdown fence, JSON only:

{
  "is_correction": true | false,
  "wrong": "<what the assistant did or assumed that was off — empty string if is_correction is false>",
  "right": "<the durable learning: what the assistant should do instead, stated as a general instruction — empty string if false>",
  "why": "<the reason / context, one short line — empty string if false>"
}

Rules:
- Judge ONLY from the exchange below. Never invent.
- "right" must be a GENERAL, reusable instruction (it will be applied on future turns), not a one-off answer.
- When in doubt, return is_correction false. A false correction pollutes the log; a missed one is recoverable.

ASSISTANT'S LAST REPLY:
`

export function composeJudgePrompt(agentText: string, userText: string): string {
  return `${CORRECTION_JUDGE_PROMPT}${agentText.trim()}\n\nOWNER'S RESPONSE:\n${userText.trim()}\n`
}

export interface DetectCorrectionDeps {
  substrate: Substrate
  /** Model preference. Defaults to `[BEST_MODEL]` (Opus). */
  model_preference?: ReadonlyArray<string>
  /** Output token budget. Defaults to 512 — the verdict JSON is small. */
  max_tokens?: number
}

export interface CorrectionExchange {
  user_text: string
  agent_text: string
}

/**
 * Dispatch the correction-judge over the substrate and return the parsed
 * verdict. A malformed / empty response yields `is_correction: false` (a bad
 * emit never throws past the parser); only a substrate `error` event or a
 * watchdog abort throws.
 */
export async function detectCorrection(
  deps: DetectCorrectionDeps,
  exchange: CorrectionExchange,
  signal?: AbortSignal,
): Promise<CorrectionJudgment> {
  const handle = deps.substrate.start({
    prompt: composeJudgePrompt(exchange.agent_text, exchange.user_text),
    tools: [],
    model_preference:
      deps.model_preference !== undefined && deps.model_preference.length > 0
        ? [...deps.model_preference]
        : [getBestModel()],
    max_tokens: deps.max_tokens ?? 512,
  })
  // O8 — the drain loop is now the ONE `drainToText`. `keepAliveExempt` preserves
  // reflection's watchdog divergence (a fired `signal` cancels the handle, abandon-
  // poisoning the warm session). Error/abort prose is byte-identical to the pre-O8
  // local `drainToString`.
  const raw = await drainToText(handle, {
    ...(signal !== undefined ? { signal } : {}),
    errorPrefix: 'reflection detect: substrate error: ',
    abortMessage: 'reflection detect: aborted (watchdog)',
    abortBeforeDispatchMessage: 'reflection detect: aborted before dispatch (watchdog)',
    keepAliveExempt: true,
  })
  return parseJudgment(raw)
}

/**
 * Parse the judge's JSON verdict, tolerating a markdown code-fence wrapper and
 * leading preamble. Anything unparseable, or a verdict with no `right` learning,
 * collapses to `is_correction: false` so a bad emit can never log noise.
 */
export function parseJudgment(text: string): CorrectionJudgment {
  const obj = extractJsonObject(text)
  if (obj === null || typeof obj !== 'object') return NOT_A_CORRECTION
  const o = obj as Record<string, unknown>
  const is_correction = o['is_correction'] === true
  if (!is_correction) return NOT_A_CORRECTION
  const right = typeof o['right'] === 'string' ? o['right'].trim() : ''
  // A correction with no durable learning is not actionable — discard it.
  if (right.length === 0) return NOT_A_CORRECTION
  return {
    is_correction: true,
    wrong: typeof o['wrong'] === 'string' ? o['wrong'].trim() : '',
    right,
    why: typeof o['why'] === 'string' ? o['why'].trim() : '',
  }
}

/** Best-effort JSON-object extraction: direct parse → fence strip → balanced slice. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through */
  }
  // The capture is `.trim()`-ed below, so we don't need a leading `\s*` to eat
  // the whitespace after the fence opener — and dropping it removes the
  // `\s*` / `[\s\S]+?` overlap that gave this regex super-linear backtracking
  // on input like "```" + many spaces with no closing fence (CodeQL
  // js/polynomial-redos). The matched region (and therefore the parsed JSON)
  // is unchanged: lazy `[\s\S]+?` still stops at the first closing fence.
  const fence = trimmed.match(/```(?:json)?([\s\S]+?)```/)
  if (fence !== null && typeof fence[1] === 'string') {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fall through */
    }
  }
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace !== -1) {
    const slice = sliceBalancedObject(trimmed, firstBrace)
    if (slice !== null) {
      try {
        return JSON.parse(slice)
      } catch {
        /* fall through */
      }
    }
  }
  return null
}

function sliceBalancedObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
