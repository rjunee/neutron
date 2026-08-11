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

function loadReal(): {
  // `undefined` is in the domain deliberately: the gate is fed a synthesis result
  // that can be absent, and the pass-through for it is asserted below.
  enforceSeverityGate: (v: Verdict | null | undefined) => Verdict | null | undefined
} {
  // The severity set is a const the function closes over, so it must come along.
  const at = SRC.indexOf('const NON_BLOCKING_SEVERITIES')
  if (at === -1) throw new Error('NON_BLOCKING_SEVERITIES is missing from inner-workflow.mjs')
  const consts = SRC.slice(at, SRC.indexOf('\n', at) + 1)
  const factory = new Function(
    `${consts}\n${grab('enforceSeverityGate')}\nreturn { enforceSeverityGate }`,
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
    const line = SRC.slice(
      SRC.indexOf('const NON_BLOCKING_SEVERITIES'),
      SRC.indexOf('\n', SRC.indexOf('const NON_BLOCKING_SEVERITIES')),
    )
    expect(line).toContain("'minor'")
    expect(line).toContain("'nit'")
    expect(line).not.toContain("'blocker'")
    expect(line).not.toContain("'major'")
  })
})

describe('it downgrades ONLY an all-non-blocking rejection', () => {
  test('nits and minors alone → APPROVE, and the findings SURVIVE as comments', () => {
    const { enforceSeverityGate } = loadReal()
    const out = enforceSeverityGate(reject(f('nit'), f('minor'), f('nit')))
    expect(out?.verdict).toBe('APPROVE')
    // The whole point is that they are surfaced, not discarded.
    expect((out?.findings as Finding[]).length).toBe(3)
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
