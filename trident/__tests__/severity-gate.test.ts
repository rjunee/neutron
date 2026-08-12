/**
 * THE SEVERITY GATE — a nit may not cost a round.
 *
 * WHY IT EXISTS. The synthesis prompt has always said a non-blocking finding must
 * not block a merge on its own. Nothing enforced it, so the rule held only as far
 * as one LLM's obedience — and it did not hold. On 2026-08-11 six of six capped
 * lanes terminated REQUEST_CHANGES and none converged, because a reviewer asked
 * for findings always finds some; a loop that blocks on non-blocking findings
 * cannot terminate by construction.
 *
 * TESTED AGAINST THE REAL FUNCTION, extracted from the `.mjs` source and
 * evaluated — the same technique the CI-gate and cross-model-gate tests use, and
 * for the same reason: a hand-copied TypeScript duplicate is a test that cannot
 * fail for the reason it claims to check.
 *
 * THIS GATE ONLY EVER TURNS A REJECTION INTO A PASS, which is the dangerous
 * direction, so most of what follows asserts the cases where it must REFUSE.
 */

import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

interface Finding {
  severity?: unknown
  title?: string
  evidence?: string
}
interface Verdict {
  verdict: string
  findings?: unknown
}

/** Brace-match one function out of the source and evaluate it. */
function grab(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

/**
 * The DECLARATION line of the severity set — anchored at column 0.
 *
 * The docblock above the const discusses `NON_BLOCKING_SEVERITIES` by name, so a
 * bare `indexOf('const NON_BLOCKING_SEVERITIES')` is one prose edit away from
 * extracting a COMMENT instead of the declaration — and then `loadReal` would
 * evaluate a comment and every test here would fail for the wrong reason (or,
 * worse, the source assertion below would pass against prose). Comment lines
 * start with `//`, so anchoring on a leading newline can only ever match the
 * real top-level declaration.
 */
function severitySetDecl(): string {
  const at = SRC.indexOf('\nconst NON_BLOCKING_SEVERITIES')
  if (at === -1) throw new Error('NON_BLOCKING_SEVERITIES is missing from inner-workflow.mjs')
  return SRC.slice(at + 1, SRC.indexOf('\n', at + 1))
}

/** The whole comment block above the severity set — the thing #184's false claim hid in. */
function gateDocblock(): string {
  const at = SRC.indexOf('// A NIT MAY NOT COST A ROUND.')
  if (at === -1) throw new Error('the severity-gate docblock header is missing')
  const end = SRC.indexOf('\nconst NON_BLOCKING_SEVERITIES')
  if (end === -1 || end < at) throw new Error('the severity-gate docblock is not above its const')
  return SRC.slice(at, end)
}

/** Just the bullets the docblock asserts ARE enforced. */
function implementedClaims(): string {
  const doc = gateDocblock()
  const at = doc.indexOf('// IMPLEMENTED')
  const end = doc.indexOf('// NOT IMPLEMENTED')
  if (at === -1 || end === -1 || end < at) {
    throw new Error('the docblock no longer separates IMPLEMENTED from NOT IMPLEMENTED claims')
  }
  return doc.slice(at, end)
}

/**
 * The source MINUS the docblock under audit.
 *
 * Checking a cited symbol against all of `SRC` is self-satisfying: the citation
 * itself lives in `SRC`, so `expect(SRC).toContain('enforceImaginaryGate')` passes
 * on a symbol that exists nowhere else in the repo — a fabricated citation, which
 * is the exact defect class this file exists to catch. Resolve citations here.
 */
function codeOutsideDocblock(): string {
  const doc = gateDocblock()
  const at = SRC.indexOf(doc)
  if (at === -1) throw new Error('the docblock did not come from SRC')
  return SRC.slice(0, at) + SRC.slice(at + doc.length)
}

/**
 * The docblock MINUS its one sanctioned mention of the deleted claim.
 *
 * The block is allowed to say the words once, in the past tense, to record WHAT
 * #184 asserted — deleting that sentence too would leave the next reader unable to
 * recognise the claim if it came back. Everything outside it is held to a flat ban,
 * because scoping the ban to the IMPLEMENTED bullets let a plain rewording survive
 * in the surrounding prose ("the mutation prover still vetoes a bad APPROVE").
 */
function docblockOutsideHistory(): string {
  const doc = gateDocblock()
  const at = doc.indexOf('(PR #184 asserted here')
  if (at === -1) {
    throw new Error('the docblock no longer records what #184 claimed — the ban below has no carve-out to justify')
  }
  const end = doc.indexOf(')', at)
  if (end === -1) throw new Error('the #184 citation is unterminated')
  return doc.slice(0, at) + doc.slice(end + 1)
}

function loadReal(): {
  // `undefined` is in the domain deliberately: the gate is fed a synthesis result
  // that can be absent, and the pass-through for it is asserted below.
  enforceSeverityGate: (v: Verdict | null | undefined) => Verdict | null | undefined
} {
  // The severity set is a const the function closes over, so it must come along.
  const factory = new Function(
    `${severitySetDecl()}\n${grab('enforceSeverityGate')}\nreturn { enforceSeverityGate }`,
  ) as () => ReturnType<typeof loadReal>
  return factory()
}

const f = (severity: unknown): Finding => ({ severity, title: 't', evidence: 'e' })
const reject = (...findings: Finding[]): Verdict => ({ verdict: 'REQUEST_CHANGES', findings })

// Loaded INSIDE each test, never at describe time: a load failure at describe time
// DELETES the tests instead of failing them — the same cannot-fail shape this file
// exists to prevent.
describe('the extraction itself works (a gate that cannot load is a gate that cannot fail)', () => {
  test('the function and its severity set are extractable', () => {
    const r = loadReal()
    expect(typeof r.enforceSeverityGate).toBe('function')
  })

  test('the source lists the NON-BLOCKING severities, not the blocking ones', () => {
    // The direction of this list is load-bearing. Enumerating the BLOCKING
    // severities would make a typo ('blockers') fail OPEN — an unrecognised
    // severity would read as non-blocking and merge. Enumerating the
    // NON-blocking ones makes every unrecognised severity block instead.
    const line = severitySetDecl()
    expect(line).toContain("'minor'")
    expect(line).toContain("'nit'")
    expect(line).not.toContain("'blocker'")
    expect(line).not.toContain("'major'")
  })
})

describe('it downgrades ONLY an all-non-blocking rejection', () => {
  test('nits and minors alone → APPROVE, and the findings SURVIVE on the verdict', () => {
    const { enforceSeverityGate } = loadReal()
    const input = reject(f('nit'), f('minor'), f('nit'))
    // Snapshotted BEFORE the call: asserting against `input.findings` afterwards
    // would also pass if the gate mutated the array in place.
    const expected = structuredClone(input.findings)
    const out = enforceSeverityGate(input)
    expect(out?.verdict).toBe('APPROVE')
    // The whole point is that THIS gate does not drop them — it hands them on to
    // the gates after it. Nothing downstream posts them to the PR. Compared by
    // VALUE, not by length: a gate that replaced or rewrote the findings would
    // satisfy `.length === 3` while destroying the property this test names.
    expect(out?.findings).toEqual(expected)
  })

  test('a single nit → APPROVE (this is the PR #171 case: a seat approved with four nits and synthesis still rejected)', () => {
    const { enforceSeverityGate } = loadReal()
    expect(enforceSeverityGate(reject(f('nit')))?.verdict).toBe('APPROVE')
  })
})

describe('it REFUSES in every case where a rejection might be real', () => {
  test('one blocker among nits still blocks', () => {
    const { enforceSeverityGate } = loadReal()
    expect(enforceSeverityGate(reject(f('nit'), f('blocker'), f('minor')))?.verdict).toBe(
      'REQUEST_CHANGES',
    )
  })

  test('MAJOR still blocks — the owner said nit and minor become comments, not major', () => {
    const { enforceSeverityGate } = loadReal()
    expect(enforceSeverityGate(reject(f('major')))?.verdict).toBe('REQUEST_CHANGES')
    expect(enforceSeverityGate(reject(f('nit'), f('major')))?.verdict).toBe('REQUEST_CHANGES')
  })

  test('an UNKNOWN severity blocks — fails CLOSED', () => {
    const { enforceSeverityGate } = loadReal()
    // A severity added to the schema later, or misspelled by the synthesis LLM,
    // must never be silently treated as ignorable.
    for (const bad of ['critical', 'Minor', 'MINOR', 'nitpick', 'blocke', '', 'trivial']) {
      expect(enforceSeverityGate(reject(f(bad)))?.verdict).toBe('REQUEST_CHANGES')
    }
  })

  test('a MISSING or non-string severity blocks', () => {
    const { enforceSeverityGate } = loadReal()
    for (const bad of [undefined, null, 0, 1, {}, []]) {
      expect(enforceSeverityGate(reject(f(bad)))?.verdict).toBe('REQUEST_CHANGES')
    }
    expect(enforceSeverityGate({ verdict: 'REQUEST_CHANGES', findings: [null] })?.verdict).toBe(
      'REQUEST_CHANGES',
    )
  })

  test('a rejection with NO findings is left ALONE, not converted to a pass', () => {
    const { enforceSeverityGate } = loadReal()
    // A rejection with no stated reason is malformed, not benign. Turning it into
    // a merge is exactly the silent downgrade this harness forbids elsewhere.
    expect(enforceSeverityGate({ verdict: 'REQUEST_CHANGES', findings: [] })?.verdict).toBe(
      'REQUEST_CHANGES',
    )
    expect(enforceSeverityGate({ verdict: 'REQUEST_CHANGES' })?.verdict).toBe('REQUEST_CHANGES')
    expect(
      enforceSeverityGate({ verdict: 'REQUEST_CHANGES', findings: 'not-an-array' })?.verdict,
    ).toBe('REQUEST_CHANGES')
  })
})

describe('it never touches anything that is not a REQUEST_CHANGES', () => {
  test('an APPROVE passes through byte-identical', () => {
    const { enforceSeverityGate } = loadReal()
    const input = { verdict: 'APPROVE', findings: [f('nit')] }
    expect(enforceSeverityGate(input)).toBe(input)
  })

  test('null / undefined pass through untouched', () => {
    const { enforceSeverityGate } = loadReal()
    expect(enforceSeverityGate(null)).toBe(null)
    expect(enforceSeverityGate(undefined)).toBeUndefined()
  })

  test('an APPROVE carrying a BLOCKER also passes through — the documented gap, pinned', () => {
    // NOT a safeguard, and deliberately asserted so it cannot be mistaken for one:
    // this gate reads severities ONLY to refuse a downgrade. It never blocks. The
    // docblock's "NOT IMPLEMENTED" bullet says exactly this, and if someone ever
    // makes a blocker veto an APPROVE, THIS test fails and forces that bullet to
    // be rewritten — which is the whole point of writing the gap down.
    const input = { verdict: 'APPROVE', findings: [f('blocker'), f('major')] }
    expect(loadReal().enforceSeverityGate(input)).toBe(input)
  })
})

describe('the ORDERING in the chain is what stops a false APPROVE', () => {
  // These are source assertions BY NECESSITY — the ordering is a property of the
  // call site, not of the pure function, and reviewAndSynthesize cannot be
  // evaluated in isolation (it awaits injected workflow globals).
  test('the severity gate runs BEFORE the CI gate and the cross-model gate', () => {
    const sev = SRC.indexOf('const severityGated = enforceSeverityGate(')
    const ci = SRC.indexOf('const withCi =')
    const cross = SRC.indexOf('const gated = enforceCrossModelGate(')
    expect(sev).toBeGreaterThan(-1)
    expect(ci).toBeGreaterThan(sev)
    expect(cross).toBeGreaterThan(sev)
  })

  test('the CI gate and the cross-model gate consume the severity-gated value, not the raw synthesis', () => {
    // If either still read `synthesisRaw`, a downgrade would be invisible to it
    // and a red build or a dead reviewer could ride out on an APPROVE.
    const chain = SRC.slice(
      SRC.indexOf('const severityGated = enforceSeverityGate('),
      SRC.indexOf('blockKind: classifyBlock('),
    )
    expect(chain).toContain('severityGated?.findings')
    expect(chain).toContain(': severityGated')
    expect(chain).not.toContain('synthesisRaw?.findings')
    expect(chain).not.toContain(': synthesisRaw')
  })
})

describe('the docblock may not claim a safeguard that no code implements (#184 → #198)', () => {
  // WHY A TEST READS A COMMENT. PR #184 wrote into this docblock that "the
  // mutation-prover phase still stands between APPROVE and merge", and used that
  // claim as part of its justification for removing nit-blocking. No such phase
  // has ever existed anywhere in this repo. It survived review for one reason:
  // nothing executable read the docblock, so every check stayed green. This is
  // that reader. It is a source assertion by necessity — the defect IS the prose.
  test('the docblock says "prover" NOWHERE except in the past-tense record of what #184 claimed', () => {
    // A flat ban, not a pattern match on the phrasing #184 happened to use. Any
    // regex over the wording is a spelling test: `the mutation-prover phase is
    // still in place` and `the mutation prover still vetoes a bad APPROVE` both
    // evade a verb list, and prose outside the IMPLEMENTED bullets was not read
    // at all. There is no legitimate present-tense use of the word here, so the
    // rule is: the word appears once, inside the historical citation, or not.
    expect(docblockOutsideHistory()).not.toMatch(/prover|proving/i)
    // The carve-out itself stays a record of a DELETED claim, not a live one.
    const doc = gateDocblock()
    expect(doc).toContain('No such phase ever existed')
    expect(doc).not.toMatch(/\b(stands?|sits?)\s+between\s+APPROVE\s+and\s+merge/i)
    // And it may not come back as a promise instead of a statement.
    expect(docblockOutsideHistory()).not.toMatch(/(TODO|FIXME|XXX|later|planned|will\s+be)[^\n]*phase/i)
  })

  test('the IMPLEMENTED claims never mention a prover, and each names real code', () => {
    const claims = implementedClaims()
    expect(claims).not.toMatch(/prover|proving/i)
    // The block's own rule: a claim must name the code that enforces it. So every
    // symbol it backticks has to actually be in the source — a claim naming a
    // function that does not exist is the same defect wearing a citation.
    // flatMap, not map: the capture group is `string | undefined` to the type
    // checker, and a `!` here would silently turn a regex that stopped matching
    // into a loop over nothing — a guard that cannot fail.
    const cited = [...claims.matchAll(/`([^`]+)`/g)].flatMap((m) => (m[1] ? [m[1]] : []))
    expect(cited.length).toBeGreaterThan(0)
    const code = codeOutsideDocblock()
    for (const symbol of cited) {
      if (/^[A-Za-z_$][\w$]*$/.test(symbol)) {
        // An identifier must resolve to a DECLARATION. Mere presence is not enough:
        // an ordinary English word in backticks ('every') occurs in the source by
        // coincidence and would pass while naming no code at all.
        expect(code).toMatch(new RegExp(String.raw`\b(function|const|let|var|class)\s+${symbol}\b`))
      } else {
        // An expression citation (`ci.status === 'red'`) has no declaration to find,
        // so it must appear verbatim — outside the docblock, or it cites itself.
        expect(code).toContain(symbol)
      }
    }
  })

  test('the gap is stated as a gap — a blocker does NOT veto an APPROVE', () => {
    // The honest counterpart to the deletion. If this bullet is ever removed while
    // enforceSeverityGate still early-returns on a non-REQUEST_CHANGES verdict,
    // the docblock is back to overstating the floor.
    const doc = gateDocblock()
    expect(doc).toContain('NOT IMPLEMENTED')
    expect(doc).toMatch(/does NOT veto an APPROVE/)
    expect(grab('enforceSeverityGate')).toContain("verdict !== 'REQUEST_CHANGES'")
  })
})
