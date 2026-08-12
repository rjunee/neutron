/**
 * Email pipeline — the classifier's regex surface is LINEAR on remote input.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 * `bareAddress` used to be `/<([^>]*)>/.exec(from)`, which CodeQL flagged as
 * `js/polynomial-redos`. `[^>]` matches `<` too, so a `From:` header of N `<`
 * and no `>` makes the engine scan to end-of-string from all N start positions.
 * Measured on the pre-fix code on ONE developer box: 8 KB → 104 ms, 16 KB →
 * 437 ms, 32 KB → 1.6 s, 64 KB → 6.8 s. The absolute figures vary several-fold
 * with the machine (a reviewer measured 2.1 s for the 32 KB case) and are quoted
 * here and in `classify.ts` only as one attributed measurement; the QUADRUPLING
 * per doubling is the machine-independent part, and it is the signature of a
 * quadratic scan rather than of a slow box.
 *
 * That input is not hypothetical or local: `from` is an RFC 5322 header, so the
 * REMOTE SENDER picks the string. On a public, self-hostable project this is a
 * denial-of-service that any stranger can post into any self-hoster's mail path,
 * and the reporter is whoever emailed them.
 *
 * ── WHAT IT PINS, AND WHY CORRECTNESS TESTS CANNOT ────────────────────────────
 * A ReDoS regression returns the SAME answer as the linear code, just
 * catastrophically later. `pipeline-classify.test.ts` already covers the values;
 * no assertion over a RETURN VALUE can distinguish a linear scan from a
 * quadratic one. Elapsed time is the only observable that separates them, which
 * is what the `WALL-CLOCK-BOUND-OK` markers below argue.
 *
 * ── THE WHOLE CLASS, NOT JUST THE ONE CodeQL NAMED ───────────────────────────
 * Every regex this pipeline adds or touches is enumerated here, with its input's
 * provenance and its verdict, so "no others" is an evidenced claim rather than
 * an assumption. Each one that reads remote input is exercised below against
 * input shaped to be its worst case.
 *
 *   classify.ts  `/<([^>]*)>/`        REMOTE (From: header)  FIXED — deleted;
 *                                     `bareAddress` is two `indexOf` calls.
 *   classify.ts  AUTH_CODE            REMOTE (subject+body)  CLEARED — an
 *   classify.ts  BILLING_ACTION       REMOTE (subject+body)  alternation of
 *   classify.ts  DEADLINE             REMOTE (subject+body)  LITERALS with no
 *                                     nested or adjacent quantifier, so a
 *                                     failed alternative advances the start
 *                                     position instead of re-deriving a span.
 *                                     Pinned below.
 *   escalate.ts  `/\s+/g`             REMOTE (subject/sender) + model text.
 *                                     CLEARED — one character class, one
 *                                     quantifier, no ambiguity. Pinned below.
 *   in-memory.ts `split(/\s+/)` (x2)  LOCAL — the test double's query parser;
 *                                     the string is caller-chosen, never a
 *                                     remote header. Same non-ambiguous shape.
 *
 * `poller.ts`, `store.ts`, `prompts.ts` and the gateway wiring add NO regex at
 * all — the remaining string work there is `slice`, `indexOf` and `includes`.
 * The non-regex scans over remote bodies are pinned here too, because an
 * unbounded ALLOCATION on sender-chosen text is the same denial-of-service by a
 * different mechanism.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'

import {
  addressDomain,
  bareAddress,
  hasUnsubscribeSignal,
  matchImportancePattern,
} from '../src/pipeline/classify.ts'
import { composeEscalationText } from '../src/pipeline/escalate.ts'

/** Big enough that a quadratic rescan is seconds, small enough that a linear one
 *  is microseconds. The pre-fix regex needed ~66 s for this input. */
const PATHOLOGICAL = 200_000

describe('classifier regexes are linear on attacker-chosen input', () => {
  test('bareAddress does not backtrack on a header of unclosed angle brackets', () => {
    // The exact worst case for `/<([^>]*)>/`: every position starts a candidate
    // match and none of them can ever complete, because there is no `>` at all.
    const from = '<'.repeat(PATHOLOGICAL)

    const start = performance.now()
    const bare = bareAddress(from)
    // WALL-CLOCK-BOUND-OK: this is a COMPLEXITY assertion, and elapsed time is
    // the only observable that separates a linear scan from the quadratic
    // backtracking CodeQL flagged here (js/polynomial-redos). Nothing
    // deterministic can replace it: a regressed `bareAddress` returns the SAME
    // string this test already asserts below, just orders of magnitude later, so
    // the value assertions cannot see the defect. The per-test timeout is not a
    // substitute either — it catches a total hang, while the quadratic form
    // lands in the seconds, and more importantly a timeout failure reads as
    // "flaky infra" rather than naming the bug. The threshold discriminates two
    // outcomes ~4 orders of magnitude apart and the margin is measured, not
    // hoped for: 0.42-0.44 ms unloaded with a 1.19 ms first-run outlier, and
    // 0.35-0.43 ms with a 2.00 ms outlier under 2x CPU oversubscription (16
    // spinners on 8 cores), against the 1000 ms budget — 0.2% of it at worst.
    // The pre-fix code needed ~66 s for this same input. ISSUES #438, #547.
    expect(performance.now() - start).toBeLessThan(1000)

    // Correctness is unchanged: no `>` anywhere means no angle-bracket form, so
    // the whole input is the address, exactly as the old regex fell back to.
    expect(bare).toBe(from)
  })

  test('the importance patterns do not backtrack on a crafted subject and body', () => {
    // Each string is built out of a PREFIX of the corresponding alternation, so
    // every start position begins a partial match that must then fail — the
    // worst case for an alternation of literals. `one-time ` is a prefix of
    // `one[- ]time (code|password)` and `action required on your ` is a prefix
    // of `action required on (your )?account`; neither repeat ever completes.
    const subject = 'one-time '.repeat(PATHOLOGICAL / 9)
    // The ONLY real hit sits at the very end, after all the near-misses, so a
    // verdict of `billing action` proves the scan traversed the entire body
    // rather than short-circuiting early and timing a fraction of the work.
    const body = `${'action required on your '.repeat(PATHOLOGICAL / 24)}payment failed`

    const start = performance.now()
    const hit = matchImportancePattern(subject, body)
    // WALL-CLOCK-BOUND-OK: same COMPLEXITY argument as the bound above, applied
    // to AUTH_CODE / BILLING_ACTION / DEADLINE rather than to `bareAddress`.
    // These three run over subject + body, both of which the remote sender
    // chooses, so they are in exactly the same threat position as the regex
    // CodeQL named; this bound is what makes "the other regexes are linear too"
    // an evidenced claim instead of an assumption. No return value distinguishes
    // a linear alternation scan from a backtracking one. Measured margin:
    // 3.24-3.84 ms unloaded, and 3.26-3.73 ms with a 7.29 ms outlier under 2x
    // CPU oversubscription (16 spinners on 8 cores), against the 1000 ms
    // budget — 0.73% of it at worst. ISSUES #438, #547.
    expect(performance.now() - start).toBeLessThan(1000)

    // The body's repeated phrase is a real billing hit, so this also proves the
    // scan actually ran to a verdict rather than bailing out early.
    expect(hit).toEqual({ category: 'important', reason: 'billing action' })
  })

  test('the escalation text flattener is linear on a remote subject', () => {
    // `composeEscalationText` clamps each field with `.replace(/\s+/g, ' ')`.
    // That regex is UNAMBIGUOUS — one character class, one quantifier, no
    // nesting and no alternation — so a failed match at a position advances by
    // one rather than re-deriving the span. Worst case is a subject that is
    // ALL whitespace: every character is in the class, so the single match spans
    // the whole string.
    const subject = ' '.repeat(PATHOLOGICAL)

    const start = performance.now()
    const text = composeEscalationText({
      sender: 'Vendor Billing <billing@vendor.example.com>',
      subject,
      reason: 'billing action',
    })
    // WALL-CLOCK-BOUND-OK: same COMPLEXITY argument as the bounds above. This
    // regex runs on an RFC 5322 subject and on model free text — both remote or
    // untrusted — and it is on the escalation path, so the same threat position
    // as `bareAddress`. Measured in the low single-digit milliseconds; the
    // budget is 1000 ms, three orders of magnitude above it.
    expect(performance.now() - start).toBeLessThan(1000)

    // And the output is BOUNDED, so a megabyte subject cannot become a megabyte
    // chat row: an all-whitespace subject flattens to nothing at all.
    expect(text.length).toBeLessThan(600)
    expect(text).toContain('billing@vendor.example.com')
  })

  test('the unsubscribe scan is bounded on a huge remote body', () => {
    // No regex here — the check is `indexOf` over two bounded spans — but it
    // reads the same attacker-chosen body, and it used to lower-case ALL of it,
    // allocating a second copy of whatever the sender sent.
    const body = 'x'.repeat(5_000_000)

    const start = performance.now()
    const hit = hasUnsubscribeSignal(body, [])
    // WALL-CLOCK-BOUND-OK: an ALLOCATION bound rather than a backtracking one,
    // and elapsed time is again the only observable — the answer (`false`) is
    // identical whether 4 KB or 5 MB was copied to get it.
    expect(performance.now() - start).toBeLessThan(1000)
    expect(hit).toBe(false)
  })

  test('addressDomain inherits the linear scan through bareAddress', () => {
    const from = `${'<'.repeat(PATHOLOGICAL)}@host.example.com`

    const start = performance.now()
    const domain = addressDomain(from)
    // WALL-CLOCK-BOUND-OK: `addressDomain` calls `bareAddress`, so it inherited
    // the quadratic blowup and would inherit any regression reintroduced there.
    // It is pinned separately because it is the function the sender-rule matcher
    // actually calls on the domain path, and a future refactor could give it its
    // own parse rather than delegating. Same COMPLEXITY argument as above: the
    // returned domain is identical either way, so only elapsed time can tell.
    // Measured well under 3 ms loaded, against the 1000 ms budget. ISSUES #438.
    expect(performance.now() - start).toBeLessThan(1000)

    expect(domain).toBe('host.example.com')
  })
})

describe('bareAddress keeps its exact pre-fix semantics', () => {
  // These pin the behaviour the old regex had, so the linear rewrite cannot
  // quietly change WHICH span it extracts while being fast.
  test.each([
    ['"A Person" <person@sender.example.com>', 'person@sender.example.com'],
    ['person@sender.example.com', 'person@sender.example.com'],
    ['  <  PERSON@Sender.Example.COM  >  ', 'person@sender.example.com'],
    // The greedy `[^>]*` spanned an inner `<`, so the FIRST `<` and the FIRST
    // following `>` bound the address. Preserved deliberately.
    ['a<b c<d>e', 'b c<d'],
    ['<<person@sender.example.com>', '<person@sender.example.com'],
    // A `<` with no `>` after it failed the whole match and fell back.
    ['<unterminated', '<unterminated'],
    ['<', '<'],
    // A `>` BEFORE any `<` is not an opener — the pair that counts is still the
    // first `<` and the first `>` after it.
    ['>', '>'],
    ['>no-open@sender.example.com', '>no-open@sender.example.com'],
    ['><person@sender.example.com>', 'person@sender.example.com'],
    // Several bracketed pairs — the FIRST one wins.
    ['<first@sender.example.com> <second@sender.example.com>', 'first@sender.example.com'],
    // An empty bracket pair is an empty address, not a fallback.
    ['<>', ''],
    ['no brackets here', 'no brackets here'],
  ])('bareAddress(%j) === %j', (input, expected) => {
    expect(bareAddress(input)).toBe(expected)
  })
})
