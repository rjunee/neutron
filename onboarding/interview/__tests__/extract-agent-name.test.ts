/**
 * 2026-05-11 — bug fix tests for agent_name extraction from freeform
 * signup replies.
 *
 * Context: the static signup fallback body was rewritten from
 * "What's your name?" to a persona-discovery question (Jane's verbatim
 * example). Multi-field replies that include the user's name as one
 * slice ("Sherlock Holmes but warmer, call me Jane") MUST extract
 * "Jane" — otherwise `phase_state.agent_name` ends up as the whole
 * archetype-laden reply and the slug picker seeds an unusable
 * `suggested_slug`.
 *
 * The heuristic is a best-effort: when no pattern matches it returns
 * the whole trimmed reply (preserves the single-word case "Jane" + the
 * legacy single-question contract).
 */

import { describe, expect, test } from 'bun:test'
import { extractAgentNameFromFreeform } from '../extract-agent-name.ts'

describe('extractAgentNameFromFreeform', () => {
  test('extracts "Jane" from "call me Jane"', () => {
    expect(extractAgentNameFromFreeform('call me Jane')).toBe('Jane')
  })

  test('extracts "Jane" from a multi-clause persona-discovery reply', () => {
    // The exact shape from the bug report.
    expect(
      extractAgentNameFromFreeform('Sherlock Holmes but warmer, call me Jane'),
    ).toBe('Jane')
  })

  test('extracts "Jane" from "I\'m Jane, sherlock but warmer"', () => {
    expect(
      extractAgentNameFromFreeform("I'm Jane, sherlock but warmer"),
    ).toBe('Jane')
  })

  test('extracts "Jane" from "Im Jane, sherlock but warmer" (no apostrophe)', () => {
    expect(
      extractAgentNameFromFreeform('Im Jane, sherlock but warmer'),
    ).toBe('Jane')
  })

  test('extracts "Jane" from "I am Jane"', () => {
    expect(extractAgentNameFromFreeform('I am Jane')).toBe('Jane')
  })

  // Argus r1 [MINOR] (2026-05-11) — iOS autocorrect rewrites a typed
  // straight apostrophe to U+2019 (RIGHT SINGLE QUOTATION MARK). The
  // original ASCII-only character class fell through to whole-reply so
  // "I’m Jane" seeded `agent_name = "I’m Jane"` and the slug picker
  // sanitised it to `im-sam` / `i-m-sam` instead of `sam`.
  test('extracts "Jane" from "I’m Jane" (iOS smart-quote U+2019)', () => {
    expect(extractAgentNameFromFreeform('I’m Jane')).toBe('Jane')
  })

  test('extracts "Jane" from "I‘m Jane" (U+2018 LEFT SINGLE QUOTE)', () => {
    // U+2018 is rarer in chat replies but iOS Notes / mac auto-typography
    // sometimes flips an opening single quote. Cover it for symmetry.
    expect(extractAgentNameFromFreeform('I‘m Jane')).toBe('Jane')
  })

  // 2026-05-12 (Bug C) — persona-discovery replies that fail all
  // explicit name patterns AND fail the bare-name heuristic now return
  // null. The engine's signup→name_chosen transition uses the null
  // signal to stay at signup and emit a clarifying re-prompt instead
  // of advancing with archetype prose as `agent_name`.
  test('returns null for "I’m thinking ..." — rejected via stop-word guard, no bare-name fallback', () => {
    expect(
      extractAgentNameFromFreeform('I’m thinking Marcus Aurelius but warmer'),
    ).toBeNull()
  })

  test('returns null for "I\'m thinking Marcus Aurelius but warmer" — no bare-name fallback', () => {
    expect(
      extractAgentNameFromFreeform("I'm thinking Marcus Aurelius but warmer"),
    ).toBeNull()
  })

  test('returns null for "I\'m looking for something more like ..." — no bare-name fallback', () => {
    expect(
      extractAgentNameFromFreeform("I'm looking for something more like Marcus Aurelius"),
    ).toBeNull()
  })

  test('lowercase "i\'m sam" — falls through "I\'m" pattern via uppercase check; commas/clause-marks would block bare-name', () => {
    // 2026-05-12: "i'm" is rejected by the uppercase check on Pattern 3.
    // Bare-name check accepts the whole reply because it's short and
    // tokens start with letters → returns "i'm sam" (the slug picker
    // sanitises to "im-sam" / "i-m-sam"). Documented over-acceptance:
    // a user typing exactly "i'm sam" expects something usable; the
    // bare-name fallback gives them that without an extra round trip.
    expect(extractAgentNameFromFreeform("i'm sam")).toBe("i'm sam")
  })

  test('accepts "I am Jane" (capitalised) but rejects "I am thinking maybe Marcus Aurelius" — too long for bare-name', () => {
    expect(extractAgentNameFromFreeform('I am Jane')).toBe('Jane')
    expect(
      extractAgentNameFromFreeform('I am thinking maybe Marcus Aurelius'),
    ).toBeNull()
  })

  // Bug C primary repro — persona-only reply from the M2 walkthrough.
  test('returns null for "a warm collaborator with Marcus Aurelius vibes" (persona-only — no name)', () => {
    expect(
      extractAgentNameFromFreeform(
        'a warm collaborator with Marcus Aurelius vibes',
      ),
    ).toBeNull()
  })

  test('returns null for archetype-only reply "I want my agent to be like a strategist"', () => {
    expect(
      extractAgentNameFromFreeform(
        'I want my agent to be like a strategist',
      ),
    ).toBeNull()
  })

  test('returns null for a comma-separated archetype list "wise, contemplative, sharp"', () => {
    expect(
      extractAgentNameFromFreeform('wise, contemplative, sharp'),
    ).toBeNull()
  })

  test('extracts "Jane" from "my name is Jane"', () => {
    expect(extractAgentNameFromFreeform('my name is Jane')).toBe('Jane')
  })

  test('extracts multi-token name "Jane Doe" from "my name is Jane Doe"', () => {
    expect(
      extractAgentNameFromFreeform('my name is Jane Doe'),
    ).toBe('Jane Doe')
  })

  test('extracts "jane doe" from "jane doe" (whole reply fallback, lowercase)', () => {
    // No introduction phrase + multi-token; we capture the whole reply
    // as-is. The slug-picker downstream sanitises to "jane-doe".
    expect(extractAgentNameFromFreeform('jane doe')).toBe('jane doe')
  })

  test('extracts "Jane" from "Jane" (single-word fallback)', () => {
    expect(extractAgentNameFromFreeform('Jane')).toBe('Jane')
  })

  test('caps multi-clause "call me X" capture at the comma', () => {
    // "call me Jane, sherlock but warmer" must NOT capture
    // "Jane sherlock but warmer". The clause-end split fires on the
    // comma so we return just "Jane".
    expect(
      extractAgentNameFromFreeform('call me Jane, sherlock but warmer'),
    ).toBe('Jane')
  })

  test('handles trailing punctuation after the name', () => {
    expect(extractAgentNameFromFreeform('call me Jane.')).toBe('Jane')
    expect(extractAgentNameFromFreeform('My name is Jane!')).toBe('Jane')
  })

  test('returns null for empty / whitespace input', () => {
    expect(extractAgentNameFromFreeform('')).toBeNull()
    expect(extractAgentNameFromFreeform('   ')).toBeNull()
  })

  test('returns null for non-string input', () => {
    expect(extractAgentNameFromFreeform(null)).toBeNull()
    expect(extractAgentNameFromFreeform(undefined)).toBeNull()
  })

  test('prefers "call me" over "I\'m" when both appear (more specific)', () => {
    // "I'm thinking Sherlock-but-warmer, call me Jane" must return
    // "Jane" not "thinking" — "call me X" is the more specific
    // introduction pattern and the function tries it first.
    expect(
      extractAgentNameFromFreeform(
        "I'm thinking Sherlock-but-warmer, call me Jane",
      ),
    ).toBe('Jane')
  })

  test('caps captured name at 3 tokens', () => {
    // Defensive: a reply like "my name is Jane Mary Doe Foo" only
    // captures 3 tokens. The slug picker sanitises the rest of the way.
    expect(
      extractAgentNameFromFreeform('my name is Jane Mary Doe Foo'),
    ).toBe('Jane Mary Doe')
  })

  // 2026-05-12 — bare-name fallback acceptance criteria.
  test('accepts "Jane Doe" via bare-name fallback (short, letter-led)', () => {
    expect(extractAgentNameFromFreeform('Jane Doe')).toBe('Jane Doe')
  })

  test('rejects "Sherlock Holmes but warmer, call me Jane"-shaped without "call me" via clause-marker', () => {
    // No "call me" — commas in the reply trigger the clause-separator
    // rejection on the bare-name path; extraction returns null and the
    // engine re-prompts. (Even though there's clearly a name in there,
    // the heuristic shouldn't try to guess at clause boundaries.)
    expect(
      extractAgentNameFromFreeform(
        'Sherlock Holmes but warmer, then Jane I guess',
      ),
    ).toBeNull()
  })

  test('rejects an over-length reply with no name pattern', () => {
    // Exactly above the 30-char short-name threshold — falls through.
    expect(
      extractAgentNameFromFreeform(
        'just some general vibe with no actual name in it',
      ),
    ).toBeNull()
  })

  test('accepts "Sherlock Holmes" as bare-name (short two-token, letter-led)', () => {
    // No introduction phrase; "Sherlock Holmes" is plausibly a chosen
    // agent persona. The slug picker still surfaces "sherlock-holmes"
    // as the suggestion, and the user can rename later. Better than a
    // forced re-prompt for the common quick-reply case.
    expect(extractAgentNameFromFreeform('Sherlock Holmes')).toBe('Sherlock Holmes')
  })
})
