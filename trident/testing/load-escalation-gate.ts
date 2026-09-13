/**
 * TEST SUPPORT — load the escalation gate OUT OF `trident/inner-workflow.mjs` and
 * evaluate it, so the tests exercise the SHIPPED functions rather than a retyped copy.
 *
 * WHY THIS EXISTS AT ALL. `inner-workflow.mjs` cannot be imported: its
 * `agent`/`parallel`/`phase`/`log`/`budget` globals are injected by the Workflow runtime
 * and the file ends in a top-level `return`. The house technique is therefore to
 * brace-match a function out of the source text and `new Function` it. Every other test
 * that does this keeps its own copy of the extractor, which is fine for one function; the
 * escalation gate is EIGHT functions and three consts that close over each other, and
 * three test files need the same set. A second copy of that list is a list that silently
 * stops matching — a test would then evaluate a gate assembled from a stale subset and
 * report green about code it never ran.
 *
 * IT MAY NOT RETYPE ANY OF THEM. Everything returned here is sliced out of the shipped
 * file; nothing in this module implements a rule. A test that mutates
 * `inner-workflow.mjs` must go red, and it can only do that if this is a reader.
 *
 * NOTHING HERE DECIDES ANYTHING. If this file performed any part of a stop, the tests
 * built on it would pass against a workflow that had never learned to stop — the exact
 * "a fixture that performs the step under test" failure this gate was designed against.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The shipped workflow source. Read once; every extraction slices this string. */
export const WORKFLOW_SRC: string = readFileSync(
  fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)),
  'utf8',
)

/**
 * Brace-match one `function NAME(` out of the source.
 *
 * THROWS when the name is absent or the braces do not balance, rather than returning
 * `''`: a silently-empty extraction produces a `new Function` body that defines nothing,
 * and the failure then surfaces as a confusing `undefined is not a function` inside
 * whichever test happened to call it first.
 */
export function grabFunction(name: string): string {
  const at = WORKFLOW_SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < WORKFLOW_SRC.length; i += 1) {
    const c = WORKFLOW_SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return WORKFLOW_SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name} in inner-workflow.mjs`)
}

/**
 * Grab a single-line `const NAME = …` declaration.
 *
 * ANCHORED ON A LINE START so a mention of the name inside a docblock or another
 * function's body is never mistaken for its declaration.
 */
export function grabConst(name: string): string {
  const at = WORKFLOW_SRC.indexOf(`\nconst ${name} =`)
  if (at === -1) throw new Error(`const ${name} is missing from inner-workflow.mjs`)
  const end = WORKFLOW_SRC.indexOf('\n', at + 1)
  if (end === -1) throw new Error(`const ${name} has no line end in inner-workflow.mjs`)
  return WORKFLOW_SRC.slice(at + 1, end)
}

/** One finding as the review schema shapes it (every field optional, because the gate's
 *  whole job is to behave on the malformed ones too). */
export interface GateFinding {
  severity?: unknown
  title?: unknown
  evidence?: unknown
  key?: unknown
  kind?: unknown
  advisory?: unknown
}

export interface GateDecision {
  action: 'continue' | 're-plan' | 'stop'
  kind: string
  whatIsMissing: string
  triggers: string[]
  evidence: string
  refusedClaim: string
  undecidable: string[]
  round: number
}

export interface EscalationGate {
  findingIdentity: (f: unknown) => string
  roundIdentity: (findings: unknown) => { keys: string[]; unknown: number; readable: boolean }
  repeatVerdict: (
    previous: unknown,
    current: unknown,
  ) => { outcome: 'repeat' | 'none' | 'undecidable'; repeated: string[]; reason: string }
  blockingFindingCount: (findings: unknown) => number | null
  progressVerdict: (counts: unknown) => 'progress' | 'no-progress' | 'undecidable'
  /** `claimVerdict` is the SEAT'S OWN verdict, so the validator can refuse an answer that
   *  approves and escalates at once. Optional here because most callers are testing the
   *  claim's own shape, where the seat said nothing about a verdict — and UNKNOWN must not
   *  read as APPROVE. */
  validateEscalationClaim: (raw: unknown, claimVerdict?: string | null) => {
    ok: boolean
    kind: string
    whatIsMissing: string
    refusedBecause: string
  }
  decideEscalation: (state: unknown) => GateDecision
  eligibleFixFindings: (findings: unknown) => unknown[] | null
}

/**
 * Assemble and evaluate the gate.
 *
 * THE DEPENDENCY LIST IS THE POINT. `decideEscalation` closes over the validator, both
 * arithmetic gates and the arithmetic kind; the validator closes over the declared-kind
 * list, the redactor and the text cap; `repeatVerdict` closes over `roundIdentity` and
 * `findingIdentity`; and `eligibleFixFindings` closes over the WHOLE `isCodeWorkFinding`
 * predicate, which itself needs the lane/suite kinds, the advisory key and the
 * non-blocking severity set. Missing any one of them is a `ReferenceError` at call time,
 * not a silently weaker gate — which is why they are listed explicitly rather than
 * discovered by grepping for identifiers.
 *
 * CALL IT INSIDE EACH TEST, never at `describe` time: a load failure at describe time
 * DELETES the tests instead of failing them.
 */
export function loadEscalationGate(): EscalationGate {
  const source = [
    grabConst('SELF_DECLARED_ESCALATION_KINDS'),
    grabConst('ARITHMETIC_ESCALATION_KIND'),
    grabConst('WHAT_IS_MISSING_MAX'),
    grabConst('REPEATED_KEYS_MAX'),
    grabConst('NON_BLOCKING_SEVERITIES'),
    grabConst('ADVISORY_FINDING_KEY'),
    grabConst('LANE_FINDING_KIND'),
    grabConst('SUITE_FINDING_KIND'),
    grabFunction('redactProbeText'),
    // Redacts and bounds the reviewer-authored key list that BOTH arms of the arithmetic
    // escalation interpolate, so a gate assembled without it throws rather than silently
    // testing an unredacted `decideEscalation`.
    grabFunction('redactedRepeatedKeys'),
    grabFunction('isNonBlockingFinding'),
    grabFunction('isCodeWorkFinding'),
    grabFunction('findingIdentity'),
    grabFunction('roundIdentity'),
    grabFunction('repeatVerdict'),
    grabFunction('blockingFindingCount'),
    grabFunction('progressVerdict'),
    grabFunction('validateEscalationClaim'),
    grabFunction('decideEscalation'),
    grabFunction('eligibleFixFindings'),
    `return { findingIdentity, roundIdentity, repeatVerdict, blockingFindingCount, progressVerdict, validateEscalationClaim, decideEscalation, eligibleFixFindings }`,
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(source)() as EscalationGate
}
