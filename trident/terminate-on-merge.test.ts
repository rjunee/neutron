/**
 * A SUCCESSFUL MERGE IS TERMINAL (ISSUES #563).
 *
 * WHAT HAPPENED. A lane approved its PR and MERGED it; the merge deleted the head
 * branch; the workflow then entered `forge:fix-round-2` and ran ~19 more minutes —
 * a live executor and an 18-minute cross-model reviewer — generating fixes for a
 * branch with nowhere to push. Nothing downstream complained: the PR was green and
 * merged, so from outside the lane merely looked slow. Every lane that merges paid
 * that, which made it a tax on every other item in the queue.
 *
 * WHERE THE TWO DECISIONS DIVERGE. The loop-continuation decision is made ENTIRELY
 * by the fix loop's `while` condition in `trident/inner-workflow.mjs` — `verdict`,
 * `round`, `blockKind`, none of them a fact about the PR. The merge is performed by
 * a DIFFERENT component: `trident/orchestrator.ts` `applyResult` →
 * `trident/git-mode.ts` `cleanupAfterMerge` → `trident/merge.ts` `mergePr`, which
 * only runs after this workflow's terminal result is harvested — or by an agent
 * INSIDE the run, when the task itself is to sign off on a PR. The workflow never
 * re-reads its own run row (`trident/checkpoint.sh` only WRITES), so a merge that
 * happens mid-run is invisible to every later decision in the loop.
 *
 * THE FIX, AND THE TWO CONSTRAINTS ON IT.
 *   1. TERMINATE ON THE MERGE, not on a later observation of it: the merge state is
 *      probed the instant a Forge round returns, ahead of the review panel, the
 *      Ralph re-fire and any round increment — everything the wasted round is made
 *      of.
 *   2. NEVER CONFLATE IT WITH THE ROUND-LOST GUARD (Open #148). That guard decides
 *      by reading the branch head, and a merge DELETES the branch, so a merged run
 *      presents to it as an unreadable head — i.e. as the failure it exists to
 *      catch. GitHub is asked about the merge BEFORE any `round-lost` verdict is
 *      written, and a merged run is recorded as a SUCCESS.
 *
 * These tests EXECUTE the real function bodies pulled out of the shipped script
 * (same technique and same reason as `round-landed.test.ts`: `inner-workflow.mjs`
 * is a Workflow script with no imports, and a substring check cannot tell `===`
 * from `!==`). The ORDERING claims — which cannot be executed, because the loop
 * body is top-level script — are source-scoped and every index is asserted to have
 * been FOUND before it is compared, or a rename would make them pass vacuously.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseInnerResult } from './inner-loop.ts'
import { phaseForLabel } from './phase-models.ts'
import { deriveStepLabel } from './run-progress.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/** Slice one top-level `function name(...) { … }` out of the script, brace-balanced. */
function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in inner-workflow.mjs`)
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

const load = <T>(name: string, ...deps: string[]): T =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(
    `${deps.map(extractFn).join('\n')}\n${extractFn(name)}; return ${name}`,
  )() as T

const classifyPrMerged = load<(res: unknown) => string>('classifyPrMerged')
// Loaded WITH its dependency, so the ordering between the two guards is exercised
// as it ships rather than against a stand-in `roundLanded`.
const roundOutcome = load<(status: string, before: unknown, after: unknown) => string>(
  'roundOutcome',
  'roundLanded',
)
const mergedTerminalResult = load<
  (pr: number | null, branch: string, round: number) => Record<string, unknown>
>('mergedTerminalResult')

/** The probe's report shape: raw stdout+stderr, plus the exit code, verbatim. */
const probe = (raw: string, exit_code = 0) => ({ raw, exit_code })

/** What `gh pr view <n> --json state,mergedAt` prints, plus the wrapper's exit line. */
const ghJson = (body: Record<string, unknown>, exit = 0) =>
  probe(`${JSON.stringify(body)}\n___EXIT=${exit}`, exit)

/** The index of a construct in the shipped source, asserted to have been FOUND.
 *  Without this, a renamed construct yields -1 and every `<` comparison below
 *  passes for the wrong reason — the vacuous-green failure mode these ordering
 *  assertions are most exposed to. */
function at(needle: string): number {
  const i = SRC.indexOf(needle)
  expect({ needle, found: i >= 0 }).toEqual({ needle, found: true })
  return i
}

function lastAt(needle: string): number {
  const i = SRC.lastIndexOf(needle)
  expect({ needle, found: i >= 0 }).toEqual({ needle, found: true })
  return i
}

describe('classifyPrMerged — only GitHub gets to say "merged"', () => {
  test('state MERGED is a merge', () => {
    expect(classifyPrMerged(ghJson({ state: 'MERGED', mergedAt: '2026-08-13T03:49:17Z' }))).toBe(
      'merged',
    )
  })

  test('a mergedAt timestamp alone is a merge (either field is GitHub stating the fact)', () => {
    expect(classifyPrMerged(ghJson({ mergedAt: '2026-08-13T03:49:17Z' }))).toBe('merged')
  })

  test('OPEN is not a merge — the ordinary case, and it must not end the run', () => {
    expect(classifyPrMerged(ghJson({ state: 'OPEN', mergedAt: null }))).toBe('not-merged')
  })

  test('CLOSED-without-merge is NOT a merge', () => {
    // An abandoned PR is closed, not merged. Reading it as a merge would report an
    // unshipped change as a success — the inverse of the defect being fixed.
    expect(classifyPrMerged(ghJson({ state: 'CLOSED', mergedAt: null }))).toBe('not-merged')
  })

  test('a failed command is UNKNOWN, never "not merged" and never "merged"', () => {
    // `gh` unauthenticated / rate-limited / PR gone. "Could not tell" is its own
    // answer: the run continues exactly as it did before this guard existed.
    expect(classifyPrMerged(probe('gh: could not find pull request\n___EXIT=1', 1))).toBe('unknown')
    expect(classifyPrMerged(ghJson({ state: 'MERGED' }, 1))).toBe('unknown')
  })

  test('a missing/garbled report is UNKNOWN — nothing is inferred from silence', () => {
    expect(classifyPrMerged(null)).toBe('unknown')
    expect(classifyPrMerged({})).toBe('unknown')
    expect(classifyPrMerged(probe('', 0))).toBe('unknown')
    expect(classifyPrMerged(probe('not json at all\n___EXIT=0', 0))).toBe('unknown')
    expect(classifyPrMerged(probe('{"state":"MERG\n___EXIT=0', 0))).toBe('unknown')
    expect(classifyPrMerged(probe('null\n___EXIT=0', 0))).toBe('unknown')
    // An exit code that never arrived is not a zero.
    expect(classifyPrMerged({ raw: JSON.stringify({ state: 'MERGED' }) })).toBe('unknown')
  })

  test('an unrecognised state is UNKNOWN, not "not merged"', () => {
    // A future/renamed state must not be read as a licence to keep spending, but
    // must not end a live run either.
    expect(classifyPrMerged(ghJson({ state: 'DRAFT', mergedAt: null }))).toBe('unknown')
  })

  test('whitespace and case in the state do not change the answer', () => {
    expect(classifyPrMerged(ghJson({ state: ' merged ', mergedAt: null }))).toBe('merged')
    expect(classifyPrMerged(ghJson({ state: 'MERGED', mergedAt: '   ' }))).toBe('merged')
    // A blank mergedAt is not a timestamp.
    expect(classifyPrMerged(ghJson({ state: 'OPEN', mergedAt: '   ' }))).toBe('not-merged')
  })
})

describe('roundOutcome — a merge outranks the round-lost guard (constraint 2)', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)

  test('MERGED with a DELETED branch is a merge, NOT a lost round', () => {
    // THE MUTANT THIS KILLS: consult `roundLanded` first. The merge deleted the
    // branch, so the head probe reads '' and the head-first order reports
    // 'round-lost' — a shipped change recorded as a failure, and an operator sent
    // to `git stash list` to recover work that is already on the base branch.
    expect(roundOutcome('merged', A, '')).toBe('merged')
    expect(roundOutcome('merged', A, null)).toBe('merged')
  })

  test('MERGED wins even when the round DID land', () => {
    // A merge that lands while a healthy fix round is running still ends the run —
    // there is nothing left to re-review.
    expect(roundOutcome('merged', A, B)).toBe('merged')
  })

  test('the round-lost guard is UNCHANGED for the case it was built for', () => {
    // Open #148: a fix round that committed nothing leaves the head where it was.
    // No merge, so the guard decides, exactly as before.
    expect(roundOutcome('not-merged', A, A)).toBe('round-lost')
    expect(roundOutcome('not-merged', A, '')).toBe('round-lost')
    expect(roundOutcome('unknown', A, A)).toBe('round-lost')
    // …and an unreadable head with an UNREADABLE merge answer is still round-lost:
    // "could not tell" is not a merge, so nothing new is excused.
    expect(roundOutcome('unknown', A, '')).toBe('round-lost')
  })

  test('a round that moved the branch is landed', () => {
    expect(roundOutcome('not-merged', A, B)).toBe('landed')
    expect(roundOutcome('unknown', A, B)).toBe('landed')
    // No baseline → permissive, unchanged from `roundLanded`.
    expect(roundOutcome('not-merged', '', B)).toBe('landed')
  })
})

describe('mergedTerminalResult — a merged run is recorded as a SUCCESS', () => {
  const r = () => mergedTerminalResult(215, 'feat-x', 1)

  test('it is an ok APPROVE with no block of any kind', () => {
    expect(r().ok).toBe(true)
    expect(r().verdict).toBe('APPROVE')
    expect(r().blockKind).toBe('none')
    // Never the round-lost verdict, which is what a deleted branch would otherwise
    // have produced.
    expect(r().blockKind).not.toBe('round-lost')
    expect(r().findings).toBeUndefined()
  })

  test('it carries the flag the outer loop keys on, and its own checkpoint', () => {
    expect(r().prMerged).toBe(true)
    expect(r().checkpoint).toBe('pr-merged')
    expect(r().prNumber).toBe(215)
    expect(r().branch).toBe('feat-x')
    expect(r().round).toBe(1)
  })

  test('it records NO reviewedHead — there is no merge left to pin', () => {
    // `reviewedHead` exists only for `gh pr merge --match-head-commit` (#545).
    // Recording one here could only invite the second merge `prMerged` prevents.
    expect(r().reviewedHead).toBeUndefined()
  })

  test('it never re-fires a Ralph task onto a merged, deleted branch', () => {
    expect(r().remainingTasks).toBe(0)
  })

  test('it decodes through the REAL harvest decoder the outer loop uses', () => {
    // The producer and the consumer are in two files that cannot import each other;
    // this runs the shipped decoder over the shipped shape so they cannot drift.
    const decoded = parseInnerResult(JSON.stringify(mergedTerminalResult(215, 'feat-x', 2)))
    expect(decoded?.pr_merged).toBe(true)
    expect(decoded?.verdict).toBe('APPROVE')
    expect(decoded?.pr_number).toBe(215)
    expect(decoded?.remaining_tasks).toBe(0)
  })
})

describe('the loop terminates ON the merge, not on a later observation of it', () => {
  // Source-scoped and labelled weaker for the reason `round-landed.test.ts` gives:
  // the loop body is top-level script and cannot be invoked in isolation. Every
  // index is asserted found (see `at`), so a rename fails loudly instead of
  // silently passing.
  const R1_PROBE = "await probePrMerged(pr, 'r1')"

  test('round 1 asks BEFORE the review panel is dispatched', () => {
    // The panel is the expensive half (five reviewers, one of them an 18-minute
    // subprocess). Asking after it has already bought most of what is being saved.
    expect(at(R1_PROBE)).toBeLessThan(at('runReviewRound(diffFile, round, pr)'))
  })

  test('round 1 asks BEFORE the Ralph re-fire and BEFORE the empty-build throw', () => {
    // A merged PR ends a Ralph run too: the next task would be built onto a branch
    // the merge deleted. And a sign-off style task that merges someone else's PR
    // legitimately produces no diff — the throw would record that shipped work as a
    // failure, so the merge question must be settled first.
    expect(at(R1_PROBE)).toBeLessThan(at('if (ralph === true && ralphRemaining > 0)'))
    expect(at(R1_PROBE)).toBeLessThan(at("if (branchHead === '' || diffFile === '')"))
  })

  test('the fix loop asks BEFORE it re-reviews and BEFORE it blames the round', () => {
    const probeAt = lastAt('await probePrMerged(pr, `r${round}`)')
    expect(probeAt).toBeLessThan(lastAt('runReviewRound(diffFile, round, pr)'))
    expect(probeAt).toBeLessThan(lastAt("if (outcome === 'round-lost')"))
  })

  test('both merge exits RETURN a terminal result — no round increment, no next phase', () => {
    // `break` would fall through to the shared terminal-result builder, which
    // derives its verdict from the review synthesis and would report the merged run
    // as REQUEST_CHANGES/round-lost. The merged path builds its OWN result.
    const returns = SRC.split('\n').filter((l) => l.trim() === 'return mergedResult')
    expect(returns.length).toBe(2)
    // …and each one persists the result first, or the outer loop never harvests it
    // and the run sits in flight until the stall reaper.
    expect(SRC.indexOf('await writeTerminalResult(mergedResult)')).toBeGreaterThan(-1)
  })

  test('a resume after a recorded merge does NOT rebuild', () => {
    // The prior process wrote `pr-merged` and may have died before the harvest. A
    // re-fire must not re-enter the build: the branch is gone and the change shipped.
    expect(at("if (resumeMode === 'merged')")).toBeLessThan(at("if (resumeMode === 'approved')"))
  })

  test('the probe is one deterministic command, and the model interprets nothing', () => {
    // Same contract as the head and CI probes: run one thing, transcribe it. "Is the
    // PR merged?" asked of a model is a question it can answer plausibly and wrongly,
    // and a wrong yes ends a live run.
    expect(SRC).toContain('gh pr view ${String(prForProbe)} --json state,mergedAt')
    expect(SRC).toContain('do NOT decide whether the PR is merged')
  })

  test('the probe is routed to the cheap tier — it runs once per round', () => {
    // `head-probe` sat on the most expensive tier for months because a missing
    // routing entry and a deliberate one are indistinguishable behind a silent
    // fallback. This one runs every round, so the same mistake would be a per-round
    // tax on the step that exists to remove a per-lane tax.
    expect(phaseForLabel('merge-probe-round-r3')?.key).toBe('bookkeeping')
    expect(SRC).toContain("label: `merge-probe-round-${roundTag}`")
  })

  test('local mode and a PR-less build spend nothing', () => {
    // No PR to read, and local mode merges only after the harvest, so it cannot race
    // the loop the way a PR merge can.
    expect(SRC).toContain(
      "if (!isPr || prForProbe === null || prForProbe === undefined) return 'not-merged'",
    )
  })
})

describe('the live progress label does not show a merged run as still working', () => {
  test('pr-merged reads as merging, not as building', () => {
    expect(deriveStepLabel('forge-init', 'pr-merged')).toBe('merging')
    // The terminal stamp still wins.
    expect(deriveStepLabel('done', 'pr-merged')).toBe('done')
  })
})
