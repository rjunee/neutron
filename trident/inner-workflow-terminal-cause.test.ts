/**
 * EVERY TERMINAL PATH NAMES WHY IT IS TERMINAL (#520) — enforced over the SHIPPED
 * `inner-workflow.mjs`, not asserted in prose.
 *
 * WHY A SOURCE-LEVEL GUARD AND NOT A BEHAVIOURAL ONE. "Every terminal path emits a
 * cause" is an ABSENCE claim about the paths that do not, and the only honest way to
 * make one is to ENUMERATE the paths rather than sample them. The inner workflow is a
 * detached script with a top-level return and no exports, so its twelve terminal exits
 * cannot be reached one at a time from a test process; what CAN be enumerated is every
 * `writeTerminalResult(...)` call site, which is the definition of a terminal path in
 * this file. This scans them all and fails on the first that hands over a result with no
 * `terminalCauseKind`.
 *
 * AND EVERY SCAN HERE CARRIES A POSITIVE CONTROL. A scanner that finds nothing proves
 * nothing until the same scanner has been shown finding something, so each guard is run
 * a second time over a DOCTORED copy of the same source with the defect reintroduced,
 * and that run must fail. Without those, a regex that silently stopped matching would
 * read as a clean bill of health — which is precisely how the four paths this card is
 * about went years without one.
 *
 * THE DRIFT THIS IS REALLY AGAINST is the one the spec item documents under HOW IT GOT
 * THIS WAY: the catch-all sentence was TRUE when it was written, and every early exit
 * added afterwards landed in it without anyone adding a terminal branch. Not randomness
 * — one plausible commit at a time. So the guard is not "the twelve known paths are
 * fine"; it is "a thirteenth cannot be added silently."
 */
import { describe, expect, test } from 'bun:test'
import { TERMINAL_CAUSES, type TerminalCause } from './terminal-cause.ts'

const SRC = await Bun.file(new URL('./inner-workflow.mjs', import.meta.url)).text()

/** Brace-match one function or object out of the workflow source, from `at`. */
function braceMatchFrom(src: string, at: number): string {
  let depth = 0
  let started = false
  for (let i = at; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error('could not brace-match from offset')
}

interface TerminalSite {
  /** The identifier handed to `writeTerminalResult`. */
  name: string
  /** 1-based line of the call, for a failure message that points at the defect. */
  line: number
  /** The source of the object literal that identifier ultimately resolves to. */
  literal: string
}

/**
 * EVERY `writeTerminalResult(<ident>)` CALL, PAIRED WITH THE OBJECT IT HANDS OVER.
 *
 * The binding is found by walking BACKWARDS from the call for the nearest `const <ident> =`,
 * which is what the file does at every site: build the value, write it, return it. TWO
 * shapes appear there and both are followed:
 *
 *  - an object literal (`const stopResult = { … }`) — brace-matched in place;
 *  - a CALL to a composer (`const mergedResult = mergedTerminalResult(pr, …)`) — resolved
 *    to that function's own body, because three of the twelve sites share one composer and
 *    a scanner that could not see through it would report three false bares.
 *
 * A site matching neither is reported as a site with NO literal rather than skipped. A
 * scanner that silently drops what it cannot parse is a scanner that passes by
 * construction, which is the failure mode this whole file is written against.
 *
 * The DEFINITION of `writeTerminalResult` is excluded by requiring `await ` in front of the
 * call: it is not a terminal path, it is the thing every terminal path calls.
 */
function terminalSites(src: string): TerminalSite[] {
  const sites: TerminalSite[] = []
  const call = /await writeTerminalResult\(([A-Za-z_$][\w$]*)\)/g
  for (let m = call.exec(src); m !== null; m = call.exec(src)) {
    const name = m[1]!
    const line = src.slice(0, m.index).split('\n').length
    sites.push({ name, line, literal: resolveBinding(src, name, m.index) })
  }
  return sites
}

/** The source of the object `name` is bound to, following one composer call. */
function resolveBinding(src: string, name: string, before: number): string {
  const at = src.lastIndexOf(`const ${name} = `, before)
  if (at === -1) return ''
  const rhs = src.slice(at + `const ${name} = `.length)
  if (rhs.startsWith('{')) return braceMatchFrom(rhs, 0)
  const composer = /^([A-Za-z_$][\w$]*)\(/.exec(rhs)?.[1]
  if (composer === undefined) return ''
  const fn = src.indexOf(`function ${composer}(`)
  if (fn === -1) return ''
  return braceMatchFrom(src, fn)
}

describe('#520 — every terminal path of the inner workflow names its cause', () => {
  test('the enumeration itself is non-empty and covers every known exit', () => {
    // THE SCANNER'S OWN POSITIVE CONTROL. If this regex stops matching, every assertion
    // below passes vacuously. Twelve is what main carries: the resume stop, the resume
    // merged/approved shortcuts, the built-head stop, the wave-member build, two publish
    // handoffs, two mid-run merges, the Ralph re-fire, the main terminal result and the
    // catch path.
    const sites = terminalSites(SRC)
    expect(sites.length).toBe(12)
    expect(new Set(sites.map((s) => s.name)).size).toBeGreaterThan(1)
  })

  test('every call site hands over an explicit terminalCauseKind', () => {
    const bare = terminalSites(SRC)
      .filter((s) => !s.literal.includes('terminalCauseKind'))
      .map((s) => `${s.name} (line ${s.line})`)
    // Named, not counted: the failure message has to say WHICH path went out silent.
    expect(bare).toEqual([])
  })

  test('POSITIVE CONTROL — the same scan fails when one site loses its cause', () => {
    // The guard above is an absence claim. This is the evidence that it can be false:
    // the identical scan, over the identical source with ONE stamp deleted, must find
    // it. Chosen for the catch path because it is the site whose omission produced the
    // measured defect (run 3d2696c3, reported as "…without Argus APPROVE" on a path
    // Argus never reached).
    const doctored = SRC.replace("    terminalCauseKind: 'workflow-threw',\n", '')
    expect(doctored).not.toBe(SRC)
    const bare = terminalSites(doctored).filter((s) => !s.literal.includes('terminalCauseKind'))
    expect(bare.map((s) => s.name)).toEqual(['failureResult'])
  })

  test('POSITIVE CONTROL — the scan sees through the shared composer too', () => {
    // The three merged exits reach their cause through `mergedTerminalResult`, not
    // through a literal at the call site. A scanner that could not follow that would
    // report three false bares (caught while writing this file) — or, worse, a later
    // one that stopped following it would report three false CLEANS. So the indirection
    // gets its own control: delete the stamp inside the composer and all three sites
    // must go bare at once.
    const doctored = SRC.replace("    terminalCauseKind: 'pr-already-merged',\n", '')
    expect(doctored).not.toBe(SRC)
    const bare = terminalSites(doctored).filter((s) => !s.literal.includes('terminalCauseKind'))
    expect(bare.length).toBe(3)
  })

  test('every stamped kind is a member of the closed vocabulary', () => {
    const stamped = [...SRC.matchAll(/terminalCauseKind: '([a-z-]+)'/g)].map((m) => m[1]!)
    expect(stamped.length).toBeGreaterThan(0)
    for (const kind of stamped) expect(TERMINAL_CAUSES).toContain(kind as TerminalCause)
  })

  /**
   * THE MIRROR. `terminal-cause.ts` owns the vocabulary and the .mjs repeats it, because
   * a Workflow script cannot import TS — the same hand-mirroring `TERMINAL_CAUSE_MAX`
   * already has, and the same reason it needs a test: a drift is silent, and the .mjs
   * side is the one that WRITES the value while the .ts side is the one that DECODES it,
   * so a member added on one side only would be stamped and then decode to null.
   */
  test('the .mjs mirror of the vocabulary is the same list, in the same order', () => {
    const block = /const TERMINAL_CAUSE_KINDS = \[([\s\S]*?)\n\]/.exec(SRC)?.[1]
    expect(block).toBeDefined()
    const mirrored = [...block!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(mirrored).toEqual([...TERMINAL_CAUSES])
  })

  test("POSITIVE CONTROL — the mirror check sees a member the .ts side doesn't have", () => {
    const doctored = SRC.replace("  'unknown',\n]", "  'unknown',\n  'invented-cause',\n]")
    expect(doctored).not.toBe(SRC)
    const block = /const TERMINAL_CAUSE_KINDS = \[([\s\S]*?)\n\]/.exec(doctored)?.[1]
    const mirrored = [...block!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(mirrored).not.toEqual([...TERMINAL_CAUSES])
  })
})

/**
 * THE BACKSTOP, EXERCISED — `stampTerminalCause`, lifted out of the .mjs and run.
 *
 * The source scan above proves the twelve known paths name their exit. It cannot prove
 * anything about a result assembled where the scan cannot see it, and "a path it cannot
 * see" is exactly the shape of the drift the spec item records: every early exit added
 * since the initial commit landed in the catch-all one plausible commit at a time.
 *
 * SO THE RUNTIME REFUSES TO LET ONE TRAVEL BARE, and what it does instead is the tested
 * part. It stamps `'unknown'` — an answer, and the honest one — rather than throwing,
 * because throwing would trade a missing sentence for a LOST TERMINAL WRITE and leave the
 * run sitting `running` until the stall guard. And it SAYS SO on the run log, rather than
 * papering over the gap: `gateway-shutdown-kill.ts:774` makes the same choice for the
 * same reason, and that is the convention being followed rather than reinvented.
 */
describe('#520 — stampTerminalCause: a bare terminal result is answered, and said out loud', () => {
  interface Stamp {
    (result: Record<string, unknown> | null, report: (m: string) => void): unknown
  }
  const load = (): Stamp => {
    const at = SRC.indexOf('function stampTerminalCause(')
    expect(at).toBeGreaterThan(-1)
    return new Function(
      [
        /const TERMINAL_CAUSE_KINDS = \[[\s\S]*?\n\]/.exec(SRC)![0],
        braceMatchFrom(SRC, at),
        'return stampTerminalCause',
      ].join('\n'),
    )() as Stamp
  }

  test('a result that names a real kind is left alone, and nothing is reported', () => {
    const said: string[] = []
    const r = { checkpoint: 'argus-request-changes', terminalCauseKind: 'round-lost-work' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('round-lost-work')
    expect(said).toEqual([])
  })

  test("a result with NO kind is stamped 'unknown' AND reported", () => {
    const said: string[] = []
    const r: Record<string, unknown> = { checkpoint: 'forge-done' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('unknown')
    // The report names the checkpoint, because that is the one thing on a bare result
    // that says which path went out silent.
    expect(said.length).toBe(1)
    expect(said[0]).toContain('TERMINAL CAUSE MISSING')
    expect(said[0]).toContain('forge-done')
  })

  test('a kind OUTSIDE the vocabulary is also refused — and reported differently', () => {
    // Two different mistakes: one path forgot, the other invented a member. Neither may
    // travel, because `parseTerminalCause` decodes an invented kind to `null` and `null`
    // means "the field did not arrive" — so an invented kind reaching the row would be
    // indistinguishable from a legacy row that predates the field entirely.
    const said: string[] = []
    const r = { checkpoint: 'x', terminalCauseKind: 'round-lost' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('unknown')
    expect(said[0]).toContain('TERMINAL CAUSE UNRECOGNISED')
    expect(said[0]).toContain('round-lost')
  })

  test('MUTATION — with the stamp removed, a bare result travels bare and silently', () => {
    const at = SRC.indexOf('function stampTerminalCause(')
    const mutated = braceMatchFrom(SRC, at).replace("  result.terminalCauseKind = 'unknown'\n", '')
    const f = new Function(
      [
        /const TERMINAL_CAUSE_KINDS = \[[\s\S]*?\n\]/.exec(SRC)![0],
        mutated,
        'return stampTerminalCause',
      ].join('\n'),
    )() as Stamp
    const r: Record<string, unknown> = { checkpoint: 'forge-done' }
    f(r, () => {})
    expect(r.terminalCauseKind).toBeUndefined()
  })

  test('a non-object is returned untouched rather than thrown over', () => {
    expect(() => load()(null, () => {})).not.toThrow()
  })
})

/**
 * THE REVIEW LOOP'S OWN EXIT, EXERCISED — the function that turns the loop's guard
 * variables into a cause, lifted out of the .mjs and run.
 *
 * THIS IS THE PART THAT COULD BE AN INFERENCE AND IS NOT. Two Codex review rounds killed
 * two attempts to deduce a cause from `(round, checkpoint)`, and the reason they were
 * right is that those two values are equally consistent with four different endings. The
 * inputs below are different in kind: they are the conditions in the `while (...)` head
 * and the two `break`s inside it, read at the moment the loop stopped. A test that only
 * confirmed the happy arms would not show that, so every arm is exercised INCLUDING the
 * fall-through, which is the one that proves the function can decline to answer.
 */
describe('#520 — reviewLoopTerminalCause: the exit is measured, and may be undecidable', () => {
  interface Exit {
    finalVerdict: string | null
    round: number
    maxRounds: number
    blockKind: string | null | undefined
    roundLostItsWork: unknown
    roundLostItsDiff: unknown
  }
  const load = (): ((e: Exit) => string) => {
    const at = SRC.indexOf('function reviewLoopTerminalCause(')
    expect(at).toBeGreaterThan(-1)
    const body = braceMatchFrom(SRC, at)
    return new Function(`${body}\nreturn reviewLoopTerminalCause`)() as (e: Exit) => string
  }
  const exit = (over: Partial<Exit>): Exit => ({
    finalVerdict: 'REQUEST_CHANGES',
    round: 10,
    maxRounds: 10,
    blockKind: 'code',
    roundLostItsWork: null,
    roundLostItsDiff: null,
    ...over,
  })

  test("an APPROVE is 'review-approved'", () => {
    expect(load()(exit({ finalVerdict: 'APPROVE', blockKind: 'none' }))).toBe('review-approved')
  })

  test("a full budget with blocking findings is 'round-budget-exhausted' — the ONE true exhaustion", () => {
    expect(load()(exit({}))).toBe('round-budget-exhausted')
  })

  test("a lost round outranks the budget, because the budget did not end it", () => {
    // The break fires at round 2 of 10 — nothing ran out. If the budget arm were read
    // first this would read as exhaustion, which is the original defect's exact shape.
    const f = load()
    expect(f(exit({ round: 2, roundLostItsWork: { round: 2, head: 'abc' } }))).toBe('round-lost-work')
    expect(f(exit({ round: 2, roundLostItsDiff: 2 }))).toBe('round-lost-no-diff')
    // …and it outranks it AT the ceiling too, which is where the two can be confused.
    expect(f(exit({ round: 10, roundLostItsDiff: 10 }))).toBe('round-lost-no-diff')
  })

  test('the two block kinds that exit the loop are told apart', () => {
    const f = load()
    expect(f(exit({ round: 1, blockKind: 'infra-only' }))).toBe('review-infra-only')
    expect(f(exit({ round: 1, blockKind: 'advisory-only' }))).toBe('review-advisory-only')
  })

  test('a REQUEST_CHANGES below the ceiling with no other reason is UNKNOWN, not a guess', () => {
    // Unreachable through the loop as written — which is exactly why it is here. The
    // honest answer to "the loop stopped and none of my conditions explain it" is that
    // it cannot be established, and `'unknown'` is a member of the vocabulary so that
    // this arm has somewhere truthful to go. A nearest-plausible-member default here
    // would reintroduce the whole defect by the back door.
    expect(load()(exit({ round: 3, maxRounds: 10, blockKind: 'code' }))).toBe('unknown')
  })

  test('a garbled verdict is UNKNOWN too — it is not quietly read as a rejection', () => {
    expect(load()(exit({ finalVerdict: null, round: 10, blockKind: 'code' }))).toBe('unknown')
  })

  test('MUTATION — dropping the budget guard turns a real exhaustion into unknown', () => {
    // The guard under test is `round >= maxRounds`. With it removed the one exit this
    // whole card was raised about stops being nameable, which is what makes the guard
    // load-bearing rather than decorative.
    const at = SRC.indexOf('function reviewLoopTerminalCause(')
    const mutated = braceMatchFrom(SRC, at).replace(
      "if (exit.finalVerdict === 'REQUEST_CHANGES' && exit.round >= exit.maxRounds) return 'round-budget-exhausted'",
      '',
    )
    const f = new Function(`${mutated}\nreturn reviewLoopTerminalCause`)() as (e: Exit) => string
    expect(f(exit({}))).toBe('unknown')
    expect(load()(exit({}))).toBe('round-budget-exhausted')
  })
})
