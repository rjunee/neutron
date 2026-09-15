/**
 * #746 — exactly one production path carries a question into the owner's chat.
 *
 * THE VOCABULARY IS NOT `askOwner`. An ambiguous merge throws a
 * `TridentMergeConflictEscalation` carrying a `.question` (`trident/merge.ts:154`,
 * thrown at `:3647`, `:3671`, `:3904`); the ASKING BOUNDARY is the single place that
 * turns that question into a terminal run's `failure_reason`, which terminal delivery
 * posts verbatim into the chat the run came from. The arbiter's `owner-only` outcome
 * (`trident/arbiter.ts:226`) is NOT a second boundary: it returns to its caller, which
 * falls back to the same escalation (`trident/merge.ts:3904`), as its own type
 * documents at `trident/arbiter.ts:60`.
 *
 * TWO ASSERTIONS, AND THE SECOND IS WHAT MAKES THE FIRST WORTH ANYTHING.
 *
 *  1. Scanning production TypeScript under the enumerated scopes finds the sanctioned
 *     boundary and nothing else. Zero matches fail and two matches fail, from the same
 *     expression — so this cannot go green on the day nobody can reach the owner.
 *
 *  2. The pattern is exercised against spellings a second asking path would plausibly
 *     use, INCLUDING ones that look nothing like the line it was written from, and
 *     against near-misses that must stay silent. A pattern that can only match the one
 *     line already in the tree is a tautology, not an enumeration, and assertion 1
 *     alone cannot tell the two apart.
 *
 * Deliberately no `rg`: a stock GitHub runner ships without ripgrep (the same reason
 * `cores/free/code-gen/src/tool-handlers.ts:413` carries a grep fallback), and a guard
 * that cannot run on the runner is not a guard. The scan is in-process.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Production roots that can reach the owner's chat. */
const SCOPES = ['trident', 'gateway', 'open', 'runtime', 'agent-dispatch']

/**
 * A QUESTION BECOMING AN OWNER-FACING RUN REASON, in either of the two shapes that
 * can do it: a question handed to a terminal-reason constructor / delivery seam, or
 * any identifier in the owner-asking vocabulary the issue itself enumerates.
 */
const ASKING_BOUNDARY =
  /(?:failedRun|failure_reason|terminate|deliver[A-Za-z]*)\s*[(:][^\n]*\bquestion\b|\b(?:askOwner|askTheOwner|ownerQuestion|owner_question|questionForOwner|needsOwner|promptOwner)\b/

// The boundary's HOME moved with the merge-approval cluster (#1021,
// `orchestrator.ts` -> `merge-approval.ts`); the boundary itself did not change, and
// the enumeration below still finds exactly one. Pinning the new path rather than
// loosening the pattern: this guard's value is that it notices when the single
// sanctioned asking site moves, which is precisely what it just did.
const SANCTIONED =
  /^trident\/merge-approval\.ts:\d+: *run: \{ \.\.\.failedRun\(doneRun, err\.question, true\), inner_verdict: 'APPROVE' \},$/

function* productionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.git') continue
      yield* productionFiles(rel)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield rel
    }
  }
}

/** Prose cannot ask anyone anything; only code lines are enumerated. */
function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function enumerateAskingBoundaries(): string[] {
  const found: string[] = []
  for (const scope of SCOPES) {
    for (const file of productionFiles(scope)) {
      readFileSync(join(REPO, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!isComment(line) && ASKING_BOUNDARY.test(line)) found.push(`${file}:${i + 1}:${line.trim()}`)
        })
    }
  }
  return found
}

describe('#746 — exactly one place asks the owner a question', () => {
  test('the enumeration finds the sanctioned boundary and no second one', () => {
    const found = enumerateAskingBoundaries()
    // ONE EXPRESSION, BOTH DIRECTIONS. An empty result is a failure, not a pass: the
    // day the sanctioned path is deleted or renamed, this goes red rather than
    // certifying a system that has gone mute.
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(SANCTIONED)
  })

  test('the pattern would in fact find a second path, in spellings unlike the first', () => {
    // Each of these is a plausible second asking path. If the pattern stopped matching
    // any of them it would still pass the test above — silently, and for ever.
    const wouldBeCaught = [
      "            run: { ...failedRun(doneRun, err.question, true), inner_verdict: 'APPROVE' },",
      '        run: { ...failedRun(run, escalation.question, false) },',
      '          failure_reason: conflict.question,',
      '    await terminate(store, run, { failure_reason: outcome.question })',
      '      await deliverTerminal(chat, run, pending.question)',
      "      const answer = await askOwner(run, 'which base should this land on?')",
      '      if (needsOwner(outcome)) return escalate(outcome)',
      '      const ownerQuestion = resolver.unresolved()',
      "      await promptOwner(run, 'the merge is ambiguous')",
    ]
    for (const line of wouldBeCaught) {
      expect({ line, matched: ASKING_BOUNDARY.test(line) }).toEqual({ line, matched: true })
    }

    // AND THE NEAR-MISSES MUST STAY SILENT, or assertion 1 would be red for reasons
    // that have nothing to do with the owner. These are the arbiter's own
    // model-directed question plumbing and ordinary terminal reasons.
    const mustNotMatch = [
      '  question: string',
      '    if (isOwnerOnlyQuestion(input.question)) {',
      "      return { kind: 'owner-only', question: input.question }",
      '      question: question.length > 0 ? question.slice(0, 500) : input.question,',
      '    throw new TridentMergeConflictEscalation(outcome.question)',
      '        run: { ...failedRun(doneRun, err.message, true), inner_verdict: \'APPROVE\' },',
      '      failure_reason: `${failureReason} — 0 commits`,',
    ]
    for (const line of mustNotMatch) {
      expect({ line, matched: ASKING_BOUNDARY.test(line) }).toEqual({ line, matched: false })
    }
  })
})
