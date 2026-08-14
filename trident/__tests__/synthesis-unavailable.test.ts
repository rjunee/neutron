/**
 * A SYNTHESIS THAT DID NOT ANSWER — the guard, and the hole it actually closes.
 *
 * WHY IT EXISTS. `agent()` returns null when its subagent dies on a terminal API
 * error after retries, which is what a session-limit 429 looks like from inside the
 * workflow. On 2026-08-12 `adopt-200-r3` and `adopt-201-r4` both ended on `null is
 * not an object (evaluating 'synthesis.verdict')`, recorded only as `checkpoint:
 * "inner-error"` with no verdict — a finished Forge build and four paid-for reviews
 * discarded, with nothing an operator could act on.
 *
 * THE HOLE IS NOT THE CRASH ANY MORE, AND THAT IS THE POINT OF THE FIRST DESCRIBE
 * BLOCK. `reviewAndSynthesize` ends in a single object literal (`{ ...gated,
 * blockKind: … }`), and `{ ...null }` is `{}` — so a dead synthesis agent no longer
 * yields null, it yields `{ blockKind: 'code' }`: no verdict, no findings. That is
 * REQUEST_CHANGES (so nothing merges) but classified as CODE, so the loop re-Forges
 * and hands the fix agent `JSON.stringify(undefined)`. A guard written as a null
 * check would be dead code against that. So the premise is PROVEN here from the real
 * gate chain before anything asserts that the guard catches it.
 *
 * TESTED AGAINST THE REAL FUNCTIONS, extracted from the `.mjs` source and evaluated
 * — the same technique `severity-gate.test.ts` and `ci-gate.test.ts` use, and for
 * the same reason: a hand-copied TypeScript duplicate is a test that cannot fail for
 * the reason it claims to check.
 *
 * THE DANGEROUS DIRECTION IS A FALSE APPROVE, so most of what follows asserts the
 * cases where the guard must REFUSE to produce one.
 */

import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

interface Finding {
  severity?: string
  kind?: string
  title?: string
  evidence?: string
}
interface Synthesis {
  verdict?: unknown
  blockKind?: string
  findings?: Finding[]
}
interface Peer {
  name: string
  title: string
  evidence: string
}

/**
 * Brace-match one function out of the source.
 *
 * The `async ` prefix is carried along when there is one: extracting an async body
 * without it produces a SYNTAX error on the first `await` inside — a test file that
 * cannot load rather than one that fails honestly.
 */
function grabFn(name: string): string {
  const found = SRC.indexOf(`function ${name}(`)
  if (found === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  const at = SRC.slice(found - 6, found) === 'async ' ? found - 6 : found
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
 * Bracket-match one top-level `const` DECLARATION.
 *
 * Anchored on a newline + `const` at column 0 so a mention of the name in the prose
 * above it cannot be extracted instead — the trap `severity-gate.test.ts` documents.
 */
function grabConst(name: string): string {
  const at = SRC.indexOf(`\nconst ${name}`)
  if (at === -1) throw new Error(`const ${name} is missing from inner-workflow.mjs`)
  let depth = 0
  for (let i = at + 1; i < SRC.length; i += 1) {
    // Explicit comparisons, not `'({['.includes(c)`: an out-of-range index reads as
    // `undefined`, and every ''-coercion of it would count as an OPEN bracket.
    const c = SRC.charAt(i)
    if (c === '(' || c === '{' || c === '[') depth += 1
    else if (c === ')' || c === '}' || c === ']') depth -= 1
    else if (c === '\n' && depth === 0) return SRC.slice(at + 1, i)
  }
  throw new Error(`could not bracket-match const ${name}`)
}

/** Lines the extracted `log` was called with — the record that names the dead seat. */
const logged: string[] = []

const real = new Function(
  'log',
  `
  ${grabConst('NON_BLOCKING_SEVERITIES')}
  ${grabConst('LANE_FINDING_KIND')}
  ${grabConst('usableStatus')}
  ${grabFn('errText')}
  ${grabFn('seatAttempt')}
  ${grabFn('synthesisUnavailable')}
  ${grabConst('SYNTHESIS_UNAVAILABLE')}
  ${grabFn('normalizeVerdict')}
  ${grabFn('enforceSeverityGate')}
  ${grabFn('enforceCrossModelGate')}
  ${grabFn('classifyBlock')}
  ${grabFn('synthesisOrInfraBlock')}
  ${grabFn('reviewRoundOrInfraBlock')}
  return {
    LANE_FINDING_KIND, SYNTHESIS_UNAVAILABLE, normalizeVerdict, enforceSeverityGate,
    enforceCrossModelGate, classifyBlock, synthesisOrInfraBlock, seatAttempt,
    synthesisUnavailable, reviewRoundOrInfraBlock, errText,
  }
`,
)((line: string) => logged.push(line)) as {
  LANE_FINDING_KIND: string
  SYNTHESIS_UNAVAILABLE: Readonly<Synthesis>
  normalizeVerdict: (v: unknown) => string
  enforceSeverityGate: (s: unknown) => Synthesis | null
  enforceCrossModelGate: (s: unknown, peers: Peer[]) => Synthesis
  classifyBlock: (s: unknown, peers: Peer[]) => string
  synthesisOrInfraBlock: (s: unknown) => Synthesis
  seatAttempt: (seat: string, run: () => unknown) => Promise<unknown>
  synthesisUnavailable: (seat: string, reason: string) => Readonly<Synthesis>
  reviewRoundOrInfraBlock: (run: () => unknown) => Promise<Synthesis>
  errText: (err: unknown) => string
}

/**
 * The TAIL of `reviewAndSynthesize` — its gate chain and its single `return`, run
 * on the REAL gates. Everything the chain reads that is not a gate (the CI verdict,
 * the deferred-peer list) is a parameter, because those are the inputs whose
 * combination decides whether the dead synthesis is visible at all.
 */
function reviewAndSynthesizeTail(
  synthesisRaw: unknown,
  { ciRed = false, peers = [] as Peer[] } = {},
): Synthesis {
  const severityGated = real.enforceSeverityGate(synthesisRaw)
  const withCi = ciRed
    ? {
        verdict: 'REQUEST_CHANGES',
        findings: [{ severity: 'blocker', title: 'CI FAILING: typecheck', evidence: 'red' }, ...(severityGated?.findings ?? [])],
      }
    : severityGated
  const gated = real.enforceCrossModelGate(withCi, peers)
  return { ...gated, blockKind: real.classifyBlock(gated, peers) }
}

/** What the loop at the call site would do with a given synthesis. */
const wouldReForge = (s: Synthesis): boolean =>
  real.normalizeVerdict(s.verdict) === 'REQUEST_CHANGES' && s.blockKind !== 'infra-only'

const laneBlocker: Peer = { name: 'kimi', title: 'kimi deferred', evidence: 'timeout' }

describe('the premise: what a dead synthesis agent ACTUALLY produces', () => {
  // If these ever fail, the guard below may be testing a shape that no longer
  // occurs — which is exactly how the null check it replaced became dead code.
  test('it is NOT null — the single `return` spreads it into an object', () => {
    const out = reviewAndSynthesizeTail(null)
    expect(out).not.toBeNull()
    expect(typeof out).toBe('object')
  })

  test('it carries NO verdict and NO findings, only `blockKind: code`', () => {
    expect(reviewAndSynthesizeTail(null)).toEqual({ blockKind: 'code' })
  })

  test('UNGUARDED that re-Forges — against `JSON.stringify(undefined)`', () => {
    const out = reviewAndSynthesizeTail(null)
    expect(wouldReForge(out)).toBe(true)
    expect(JSON.stringify(out.findings)).toBeUndefined()
  })

  test('the source really does end in that single spread `return`', () => {
    expect(SRC).toContain('return { ...gated, blockKind: classifyBlock(gated, peers) }')
    // One `return`, so there is no other exit that could hand back a bare null.
    const body = grabFn('reviewAndSynthesize')
    expect(body.split('\n').filter((l) => /^ {2}return /.test(l))).toHaveLength(1)
  })
})

describe('the guard turns "no answer" into an infra block', () => {
  test('the dead-agent shape becomes REQUEST_CHANGES + infra-only', () => {
    const guarded = real.synthesisOrInfraBlock(reviewAndSynthesizeTail(null))
    expect(real.normalizeVerdict(guarded.verdict)).toBe('REQUEST_CHANGES')
    expect(guarded.blockKind).toBe('infra-only')
  })

  test('…so the loop STOPS instead of re-Forging a network error', () => {
    expect(wouldReForge(real.synthesisOrInfraBlock(reviewAndSynthesizeTail(null)))).toBe(false)
  })

  // A verdict is a non-empty STRING or it is not an answer. `{ verdict: 42 }` is the
  // shape a schema-violating or half-serialised agent reply takes, and truthiness
  // would have let it through as a review.
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
    ['a bare object with no verdict', {}],
    ['the real dead-agent shape', { blockKind: 'code' }],
    ['a null verdict', { verdict: null }],
    ['a non-string verdict', { verdict: 42 }],
    ['an empty-string verdict', { verdict: '' }],
  ])('%s is not a review: REQUEST_CHANGES + infra-only, never APPROVE', (_label, input) => {
    const guarded = real.synthesisOrInfraBlock(input)
    expect(guarded.verdict).toBe('REQUEST_CHANGES')
    expect(real.normalizeVerdict(guarded.verdict)).not.toBe('APPROVE')
    expect(guarded.blockKind).toBe('infra-only')
  })
})

describe('a REAL synthesis is untouched', () => {
  test('an APPROVE passes through as the SAME object, still APPROVE', () => {
    const approve = { verdict: 'APPROVE', findings: [], blockKind: 'code' }
    const out = real.synthesisOrInfraBlock(approve)
    expect(out).toBe(approve) // identity, not just equality
    expect(real.normalizeVerdict(out.verdict)).toBe('APPROVE')
  })

  test('a real REQUEST_CHANGES keeps its findings AND its code classification', () => {
    const rc = {
      verdict: 'REQUEST_CHANGES',
      blockKind: 'code',
      findings: [{ severity: 'blocker', title: 'null deref', evidence: 'a.ts:1' }],
    }
    const out = real.synthesisOrInfraBlock(rc)
    expect(out).toBe(rc)
    expect(wouldReForge(out)).toBe(true) // a code block still gets its fix round
  })

  test('the guard NEVER invents an APPROVE from anything', () => {
    for (const input of [null, undefined, {}, { blockKind: 'code' }, { verdict: 'REQUEST_CHANGES' }]) {
      expect(real.normalizeVerdict(real.synthesisOrInfraBlock(input).verdict)).toBe('REQUEST_CHANGES')
    }
  })

  // The severity gate is the ONE place that can turn a rejection into a pass, and
  // it runs upstream of the guard. It must not be reachable with the injected block.
  test('the severity gate cannot downgrade the injected block to APPROVE', () => {
    const gated = real.enforceSeverityGate(real.SYNTHESIS_UNAVAILABLE)
    expect(gated?.verdict).toBe('REQUEST_CHANGES')
  })
})

describe('the injected finding is a LANE finding, not a code finding', () => {
  const finding = () => real.SYNTHESIS_UNAVAILABLE.findings?.[0] as Finding

  // Printed rather than assumed: `classifyBlock` keys on this FIELD, and two sites
  // agreeing on a string by convention is the trap `LANE_FINDING_KIND` exists to
  // close. The constant is resolved from the source, so a rename that misses one
  // site fails here.
  test('its `kind` is the very constant `classifyBlock` reads', () => {
    expect(finding().kind).toBe(real.LANE_FINDING_KIND)
    expect(finding().kind).toBe('lane')
  })

  test('classifyBlock therefore reads it as infra-only, not code', () => {
    expect(real.classifyBlock(real.SYNTHESIS_UNAVAILABLE, [laneBlocker])).toBe('infra-only')
  })

  test('it is a blocker — a lane that could not run may not be a nit', () => {
    expect(finding().severity).toBe('blocker')
  })

  // Field names the schema requires and every other producer emits. A finding
  // spelled `short_summary`/`summary` renders blank wherever findings are surfaced,
  // so the operator would be told nothing at all — the failure this whole change
  // exists to end.
  test('it uses `title`/`evidence`, the shape VERDICT_SCHEMA requires', () => {
    expect(typeof finding().title).toBe('string')
    expect(typeof finding().evidence).toBe('string')
    expect(finding().title!.length).toBeGreaterThan(0)
    expect(finding().evidence!.length).toBeGreaterThan(0)
    for (const key of Object.keys(finding())) {
      expect(['severity', 'kind', 'title', 'evidence']).toContain(key)
    }
  })

  test('it says the code was never judged, so nobody reads it as a diff finding', () => {
    expect(finding().evidence!.toLowerCase()).toContain('never judged')
  })
})

describe('the shared frozen instance is safe to share', () => {
  test('the object and its findings are frozen', () => {
    expect(Object.isFrozen(real.SYNTHESIS_UNAVAILABLE)).toBe(true)
    expect(Object.isFrozen(real.SYNTHESIS_UNAVAILABLE.findings)).toBe(true)
    expect(Object.isFrozen(real.SYNTHESIS_UNAVAILABLE.findings?.[0])).toBe(true)
  })

  test('two rounds get the SAME instance and neither can corrupt it for the other', () => {
    const roundOne = real.synthesisOrInfraBlock(null)
    const roundTwo = real.synthesisOrInfraBlock(undefined)
    expect(roundOne).toBe(roundTwo)
    expect(() => {
      ;(roundOne as { verdict: string }).verdict = 'APPROVE'
    }).toThrow()
    expect(roundTwo.verdict).toBe('REQUEST_CHANGES')
  })

  // Every gate SPREADS rather than mutating, which is what makes one shared instance
  // correct. If a gate ever starts assigning into its argument, this fails.
  test('no consumer mutates a synthesis in place', () => {
    const input = Object.freeze({ verdict: 'REQUEST_CHANGES', findings: Object.freeze([]) })
    expect(() => real.enforceSeverityGate(input)).not.toThrow()
    expect(() => real.enforceCrossModelGate(input, [laneBlocker])).not.toThrow()
    expect(() => real.classifyBlock(input, [laneBlocker])).not.toThrow()
    expect(input.verdict).toBe('REQUEST_CHANGES')
  })
})

describe('the guard does not fire when a gate DID supply a verdict', () => {
  // Red CI over a dead synthesis is a real, actionable code blocker: the fix round
  // has something to do, so it must still run.
  test('red CI still classifies as code and still re-Forges', () => {
    const out = real.synthesisOrInfraBlock(reviewAndSynthesizeTail(null, { ciRed: true }))
    expect(out.blockKind).toBe('code')
    expect(wouldReForge(out)).toBe(true)
    expect(out.findings?.[0]?.title).toContain('CI FAILING')
  })

  // A deferred peer already produces the infra shape AND names which seat died,
  // which is strictly more useful than the generic block. It must survive.
  test('a deferred peer keeps its own, more specific infra block', () => {
    const out = real.synthesisOrInfraBlock(reviewAndSynthesizeTail(null, { peers: [laneBlocker] }))
    expect(out.blockKind).toBe('infra-only')
    expect(out).not.toBe(real.SYNTHESIS_UNAVAILABLE)
    expect(out.findings?.[0]?.title).toBe('kimi deferred')
    expect(wouldReForge(out)).toBe(false)
  })
})

describe('every call site is guarded', () => {
  // Source-scoped, and labelled weaker for the reason the sibling suites give: the
  // loop body is top-level script and cannot be invoked in isolation.
  test('BOTH reads of `synthesis.verdict` are fed by a guarded assignment', () => {
    const reads = SRC.split('\n').filter((l) => l.includes('normalizeVerdict(synthesis.verdict)'))
    const guarded = SRC.split('\n').filter((l) => l.includes('runReviewRound(diffFile, round, pr)'))
    expect(reads).toHaveLength(2)
    expect(guarded).toHaveLength(2)
  })

  test('NO assignment reaches `synthesis` from an unguarded review', () => {
    const assigns = SRC.split('\n').filter((l) => /^\s*(let )?synthesis\s*=/.test(l))
    expect(assigns.length).toBeGreaterThan(0) // the filter can find these lines at all
    for (const line of assigns) {
      expect(line).toContain('runReviewRound(')
    }
  })

  // THE HOLE #212 LEFT OPEN. Its guard read the RETURN VALUE, so it never ran when the
  // review REJECTED — the rejection unwound past it and killed the lane. Every
  // `reviewAndSynthesize` CALL must therefore be inside the try/catch, i.e. inside a
  // thunk handed to `reviewRoundOrInfraBlock`, not merely awaited in its argument.
  test('the only calls to `reviewAndSynthesize` are thunks passed to the guard', () => {
    const calls = SRC.split('\n').filter(
      (l) =>
        l.includes('reviewAndSynthesize(') &&
        !l.includes('async function reviewAndSynthesize') &&
        !/^\s*(\/\/|\*)/.test(l), // prose ABOUT the call is not a call
    )
    expect(calls.length).toBe(1) // one callback inside runReviewRound; both call sites use that wrapper
    for (const line of calls) {
      expect(line).toContain('() => reviewAndSynthesize(')
    }
  })

  // The seat chokepoint, pinned the same way: a seat dispatched AROUND `seatAttempt`
  // can still reject, and that is the whole failure class.
  test('every reviewer put on the panel is dispatched through `seatAttempt`', () => {
    const lines = SRC.split('\n')
    const pushes = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.includes('reviewers.push('))
    expect(pushes.length).toBe(3) // the core-seat helper, codex, kimi
    for (const { i } of pushes) {
      expect(lines.slice(i, i + 3).join('\n')).toContain('seatAttempt(')
    }
  })

  test('the synthesis seat and the CI probe are dispatched through it too', () => {
    expect(SRC).toContain("seatAttempt('argus:synthesis'")
    expect(SRC).toContain('seatAttempt(`ci-probe-round-')
  })
})

/**
 * THE FAILURE CLASS, NOT THE INSTANCE. #212 closed "the seat RETURNED nothing" and
 * left "the seat DIED" open, which is the recurrence. These are the ways a seat can
 * fail to produce a usable verdict; every one of them must end as a block, never as a
 * throw and never as an APPROVE.
 */
describe('a seat that DIES is indistinguishable from a seat that answered nothing', () => {
  test.each([
    ['a rejected promise (API 529 Overloaded)', async () => { throw new Error('API error 529 Overloaded') }],
    ['a synchronous throw', () => { throw new Error('boom') }],
    ['a rejection that is not an Error', async () => { throw 'exit 1' }],
    ['a rejection of null', async () => { throw null }],
  ])('%s becomes null, the shape the panel already handles', async (_label, run) => {
    const out = await real.seatAttempt('argus:kimi', run as () => unknown)
    expect(out).toBeNull()
  })

  test('a seat that ANSWERS is passed through by identity — the wrapper judges nothing', async () => {
    const verdict = { verdict: 'APPROVE', findings: [] }
    expect(await real.seatAttempt('argus:claude', () => verdict)).toBe(verdict)
    expect(await real.seatAttempt('argus:claude', async () => verdict)).toBe(verdict)
  })

  test('the death is RECORDED with the seat and the reason', async () => {
    logged.length = 0
    await real.seatAttempt('argus:kimi', () => {
      throw new Error('API error 529 Overloaded')
    })
    expect(logged.join('\n')).toContain('seat=argus:kimi')
    expect(logged.join('\n')).toContain('529')
  })

  test('a dead seat NEVER becomes a verdict — null is not usable, so the gate still blocks', async () => {
    const dead = await real.seatAttempt('argus:kimi', () => {
      throw new Error('529')
    })
    // The very predicate the completeness gate and the lane retry share.
    expect(real.normalizeVerdict((dead as { verdict?: string } | null)?.verdict)).toBe('REQUEST_CHANGES')
  })

  test('errText survives a non-Error, and bounds a flood of stderr', () => {
    expect(real.errText('plain string')).toBe('plain string')
    expect(real.errText(null)).toBe('null')
    expect(real.errText(new Error('a\n  b'))).toBe('a b')
    expect(real.errText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(201)
  })
})

describe('a review ROUND that throws ends the round, not the run', () => {
  test.each([
    ['a rejected promise', async () => { throw new Error('API error 529 Overloaded') }],
    ['a synchronous throw', () => { throw new Error('parallel() died') }],
    ['a non-Error rejection', async () => { throw 'killed' }],
  ])('%s becomes REQUEST_CHANGES + infra-only, and does NOT propagate', async (_label, run) => {
    const out = await real.reviewRoundOrInfraBlock(run as () => unknown)
    expect(real.normalizeVerdict(out.verdict)).toBe('REQUEST_CHANGES')
    expect(out.blockKind).toBe('infra-only')
    expect(wouldReForge(out)).toBe(false)
  })

  test('the injected finding names the seat AND the reason — an unactionable block is not a fix', async () => {
    const out = await real.reviewRoundOrInfraBlock(async () => {
      throw new Error('API error 529 Overloaded')
    })
    const finding = out.findings?.[0] as Finding
    expect(finding.kind).toBe(real.LANE_FINDING_KIND)
    expect(finding.severity).toBe('blocker')
    expect(finding.evidence).toContain('529')
    expect(finding.evidence!.toLowerCase()).toContain('never judged')
  })

  test('the same round that RESOLVES is still guarded by the verdict check, not just the throw', async () => {
    // A round that returns the dead-agent shape must still infra-block: the outer
    // try/catch must not have REPLACED the value guard.
    const out = await real.reviewRoundOrInfraBlock(async () => ({ blockKind: 'code' }))
    expect(out.blockKind).toBe('infra-only')
    expect(out.verdict).toBe('REQUEST_CHANGES')
  })

  test('a REAL verdict still passes through the guard by identity', async () => {
    const approve = { verdict: 'APPROVE', findings: [], blockKind: 'none' }
    expect(await real.reviewRoundOrInfraBlock(async () => approve)).toBe(approve)
  })

  test('a dead round can NEVER be an APPROVE, whatever the error says', async () => {
    for (const thrown of [new Error('APPROVE'), 'APPROVE', { verdict: 'APPROVE' }]) {
      const out = await real.reviewRoundOrInfraBlock(() => {
        throw thrown
      })
      expect(real.normalizeVerdict(out.verdict)).toBe('REQUEST_CHANGES')
    }
  })
})
