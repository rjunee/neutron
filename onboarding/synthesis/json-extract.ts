/**
 * @neutronai/onboarding/synthesis — tolerant JSON extraction.
 *
 * (K3, 2026-07-03) — extracted verbatim from the deleted per-chunk
 * `history-import/substrate-callers.ts` so the LIVE synthesis session
 * (`synthesis-session.ts`, the sole cross-module consumer) keeps its
 * tolerant model-output parser after the per-chunk import pipeline was
 * evacuated. Behaviour is byte-identical to the pre-deletion helper;
 * golden-tested in `__tests__/json-extract.test.ts`.
 *
 * Note: `scribe/extract.ts`, `reflection/detector.ts`, and
 * `tasks/prioritize-llm.ts` each carry their OWN independent local copy —
 * this module is NOT their source and does not consolidate them.
 */

/**
 * Best-effort parse of a model emit into a JS value. Tries, in order:
 *   1. Direct `JSON.parse`.
 *   2. A ```` ```json ```` / ```` ``` ```` fenced block.
 *   3. The first balanced `{ ... }` object substring (model preamble like
 *      "Here's the JSON: { ... }").
 * Returns `null` when nothing parses — callers defensively fall back to
 * empty aggregates so a single bad LLM emit doesn't tank the flow.
 *
 * Exported for unit testing.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  // Direct JSON
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }
  // Markdown-fenced JSON: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/)
  if (fenceMatch !== null && typeof fenceMatch[1] === 'string') {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch {
      // fall through
    }
  }
  // First-object substring: model emitted preamble like
  // "Here's the JSON: { ... }". Find the first { and take through the
  // matching } (depth-counted). Only used as a last resort.
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace !== -1) {
    const slice = sliceBalancedObject(trimmed, firstBrace)
    if (slice !== null) {
      try {
        return JSON.parse(slice)
      } catch {
        // fall through
      }
    }
  }
  return null
}

/**
 * Walk forward from `start` (pointing at a `{`) and return the substring
 * through the matching `}`. Respects string literals + escape sequences so
 * a `}` inside a quoted value doesn't close the outer object prematurely.
 * Returns null when no balanced object is found.
 */
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
