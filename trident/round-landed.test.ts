/**
 * A fix round that never reached the branch (owner-visible defect, 2026-08-09).
 *
 * WHAT HAPPENED. A fix round runs with `isolation: 'worktree'` — its own throwaway
 * git worktree. Edits that are not committed AND pushed die with it, while the
 * round still reports success. The next review then reads the UNCHANGED pushed
 * head and re-reports the SAME findings, which reads as "the fixes didn't work"
 * rather than "the fixes were never there".
 *
 * PR #145 is the record. Its review blocked it with, verbatim: "pushed head does
 * not contain the round-2 fix set; merging now ships rejected code … addressed
 * only in uncommitted tree". Three rounds, four reviewers each, essentially all of
 * it spent on a head that never moved. The work was found afterwards in a
 * `git stash` on the build host and pushed by hand.
 *
 * WHY THE DECISION IS IN CODE AND NOT IN A PROMPT. The head probe asks an agent
 * for ONE fact — the sha — and `roundLanded` decides. An agent asked "did your
 * round land?" is auditing itself, and the failing case is precisely the one where
 * it believes it succeeded. Same reason the cross-model gate is deterministic.
 *
 * These tests evaluate the REAL function bodies pulled out of the shipped script,
 * for the reason given at length in `lane-retry.test.ts`: `inner-workflow.mjs` is
 * a Workflow script with zero imports, so its helpers cannot be imported, and a
 * substring check cannot tell `!==` from `===`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/** Slice one top-level `function name(...) { … }` out of the script, brace-balanced. */
function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in inner-workflow.mjs`)
  // Walk the parameter list to its matching close paren BEFORE brace-matching the
  // body — a destructured parameter otherwise balances on the parameter braces and
  // slices the function in half (see `lane-retry.test.ts`).
  let paren = 0
  let i = SRC.indexOf('(', start)
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '(') paren += 1
    else if (SRC[i] === ')') {
      paren -= 1
      if (paren === 0) break
    }
  }
  let depth = 0
  for (let j = SRC.indexOf('{', i); j < SRC.length; j += 1) {
    if (SRC[j] === '{') depth += 1
    else if (SRC[j] === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

const load = <T>(name: string): T =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(`${extractFn(name)}; return ${name}`)() as T

const roundLanded = load<(before: unknown, after: unknown) => boolean>('roundLanded')
const roundDidNotLandFinding = load<
  (round: number, head: string) => { severity: string; title: string; evidence: string }
>('roundDidNotLandFinding')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('roundLanded — did the branch actually move?', () => {
  test('a moved head landed', () => {
    expect(roundLanded(A, B)).toBe(true)
  })

  test('an UNCHANGED head did NOT land — this is the whole defect', () => {
    expect(roundLanded(A, A)).toBe(false)
  })

  test('whitespace does not fake movement', () => {
    // A probe that returns the sha with a trailing newline must not read as a new
    // commit, or the gate is worse than useless: it goes permanently green.
    expect(roundLanded(A, `${A}\n`)).toBe(false)
    expect(roundLanded(`  ${A}  `, A)).toBe(false)
  })

  test('an UNREADABLE after does NOT land — a failed fetch is not progress', () => {
    // The dangerous default. If a `git ls-remote` fails and returns '', treating
    // that as movement would let the exact case this guards sail through.
    expect(roundLanded(A, '')).toBe(false)
    expect(roundLanded(A, null)).toBe(false)
    expect(roundLanded(A, undefined)).toBe(false)
  })

  test('an unreadable BEFORE is permissive — no baseline, so invent no failure', () => {
    // Round 1's Forge is the only source of the baseline. If it reported no
    // commitSha we know nothing, and failing the run on that would block builds
    // for a reason unrelated to the work.
    expect(roundLanded('', B)).toBe(true)
    expect(roundLanded(null, B)).toBe(true)
    expect(roundLanded(undefined, '')).toBe(true)
  })
})

describe('roundDidNotLandFinding — the operator is told what to recover', () => {
  test('names the round and the stuck head', () => {
    const f = roundDidNotLandFinding(2, A)
    expect(f.severity).toBe('blocker')
    expect(f.title).toContain('round 2')
    expect(f.evidence).toContain(A)
  })

  test('says it is a PROCESS problem, not a defect in the diff', () => {
    // #145's synthesiser got this right for the codex deferral and it is the same
    // distinction: nothing here is a judgement about the code.
    expect(roundDidNotLandFinding(2, A).title).toContain('PROCESS')
  })

  test('points at where the work actually is', () => {
    // The work is recoverable — it was for #145 — and the finding should say so
    // rather than leaving the operator to conclude the round produced nothing.
    expect(roundDidNotLandFinding(3, B).evidence).toContain('git stash list')
  })

  test('survives an unreadable head without printing "undefined"', () => {
    expect(roundDidNotLandFinding(2, '').evidence).toContain('unreadable')
    expect(roundDidNotLandFinding(2, '').evidence).not.toContain('undefined')
  })
})

describe('the loop honours the gate', () => {
  // Source-scoped and labelled weaker, for the reason `lane-retry.test.ts` gives:
  // the loop body is top-level script and cannot be invoked in isolation. The
  // behaviour of the predicate itself is covered above.
  test('the check runs BEFORE the re-review, not after', () => {
    // Order is the point. Checking after the review would still have paid for four
    // reviewers on unchanged code — the exact cost being eliminated.
    const probeAt = SRC.indexOf('const headAfter = await readBranchHead(round)')
    // `lastIndexOf` on purpose: the FIRST `reviewAndSynthesize(diffFile, round)` is
    // the pre-loop review (`let synthesis = await …`), which of course precedes the
    // probe. The one that must come after is the RE-review inside the fix loop, and
    // an `indexOf` here made this assertion fail on correct code.
    // Matched on the CALL PREFIX, not the full argument list: the CI gate added a
    // third parameter and this assertion failed on a change that left the ordering
    // it checks completely intact. Two source-shape assertions broke that way in one
    // change, which is the argument for pinning the construct rather than its
    // spelling.
    const reReviewAt = SRC.lastIndexOf('synthesis = await reviewAndSynthesize(')
    expect(probeAt).toBeGreaterThan(-1)
    expect(reReviewAt).toBeGreaterThan(probeAt)
  })

  test('a lost round breaks the loop rather than continuing it', () => {
    expect(SRC).toContain('if (!roundLanded(branchHead, headAfter))')
    expect(SRC).toContain('roundLostItsWork = { round, head:')
  })

  test('a lost round is reported as its OWN blockKind, never as a code rejection', () => {
    expect(SRC).toContain("'round-lost'")
  })

  test('the head probe asks the REMOTE in PR mode', () => {
    // "Pushed" is the property that matters: a local ref can be ahead of anything
    // a reviewer or the merge will ever see.
    expect(SRC).toContain('git ls-remote origin')
  })
})
