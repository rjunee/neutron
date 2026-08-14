/**
 * A REVIEWER THAT DIES OUTRIGHT, DRIVEN THROUGH THE WHOLE WORKFLOW (2026-08-13).
 *
 * THE RECURRENCE THIS CLOSES. #212 (`f246f619`) made a synthesis that RETURNED nothing
 * an infra block. It guarded the returned VALUE — `synthesisOrInfraBlock(await
 * reviewAndSynthesize(…))` — on the premise that a dead subagent makes `agent()` return
 * null. A seat can also die the other way: the call REJECTS (an API 529 Overloaded, a
 * timeout, a subprocess that exits non-zero, a reply that fails its schema). A
 * rejection is not a return value, so the guard never ran at all: it unwound out of
 * `reviewAndSynthesize`, past the guard (an argument is only evaluated on a value that
 * ARRIVED), out of the loop's `try`, and ended the lane at checkpoint `inner-error`
 * with no verdict — on 2026-08-13 that discarded ten hours and seven rounds of review
 * whose PR was green and open the whole time.
 *
 * WHY END TO END, and not only the unit tests in `synthesis-unavailable.test.ts`: the
 * bug was never in a gate, it was in what the round does with a promise. Only a run
 * can show that. So this drives the REAL `inner-workflow.mjs` (source, not a copy) with
 * mocked runtime globals — the harness shape `dead-core-seat-e2e.test.ts` established —
 * kills seats by THROWING from `agent`, and asserts on how the run terminated.
 *
 * THE DANGEROUS DIRECTION IS A FALSE APPROVE, so every case below asserts BOTH that the
 * run survived and that it did not merge. A panel that lost a seat may never approve
 * (`trident/kimi-review.ts` — a cross-model review that did not happen can never become
 * an APPROVE, and never falls back to a Claude-family model).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)), 'utf8')

interface Captured {
  label: string
  prompt: string
}
interface RunOut {
  captured: Captured[]
  logs: string[]
  result: {
    ok?: boolean
    verdict?: string
    blockKind?: string
    round?: number
    checkpoint?: string
  } | null
}

/**
 * A reply per seat, as a function of that seat's OWN dispatch count, so a run can
 * script "dies the first time, answers on the retry". A seat that THROWS is the case
 * under test; returning `null` is the already-fixed #212 case, kept alongside so the
 * two are proven indistinguishable.
 */
interface Script {
  rubric?: (n: number) => unknown
  adversarial?: (n: number) => unknown
  synthesis?: (n: number) => unknown
  ciProbe?: (n: number) => unknown
  /** PR mode, so the CI probe actually runs (it no-ops without a PR). */
  pr?: boolean
}

async function runWorkflow(script: Script): Promise<RunOut> {
  const captured: Captured[] = []
  const logs: string[] = []
  const calls: Record<string, number> = {}
  const bump = (label: string): number => {
    calls[label] = (calls[label] ?? 0) + 1
    return calls[label]
  }

  const agent = async (prompt: string, opts?: { label?: string }): Promise<unknown> => {
    const label = String(opts?.label ?? '')
    captured.push({ label, prompt })
    if (label === 'forge:build' || label.startsWith('forge:fix-round-')) {
      return {
        prNumber: script.pr === true ? 7 : null,
        branch: 'trident/dying-seat',
        diffFile: '/tmp/x.diff',
        worktreePath: '/wt',
        commitSha: `sha-${bump('forge')}`,
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      const seat = label === 'argus:claude' ? script.rubric : script.adversarial
      const n = bump(label)
      return seat === undefined ? { verdict: 'REQUEST_CHANGES', findings: [] } : seat(n)
    }
    if (label === 'argus:synthesis') {
      const n = bump(label)
      return script.synthesis === undefined ? { verdict: 'APPROVE', findings: [] } : script.synthesis(n)
    }
    if (label.startsWith('ci-probe-round-')) {
      const n = bump('ci-probe')
      // A healthy probe reports one green check through CI_PROBE_SCHEMA.
      return script.ciProbe === undefined
        ? { raw: '[{"name":"test","state":"SUCCESS","link":"x"}]\n___EXIT=0', exit_code: 0 }
        : script.ciProbe(n)
    }
    if (label.startsWith('review-readiness-r')) {
      return {
        raw: JSON.stringify({
          mergeable: 'MERGEABLE',
          statusCheckRollup: ['test', 'lint', 'typecheck'].map((name) => ({
            name,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
          })),
        }),
        exit_code: 0,
      }
    }
    // The branch moved iff a Forge round ran, so a fix round LANDS and the loop can
    // reach its second review (`roundLanded`).
    if (label.startsWith('head-probe-round-')) return { head: `sha-${calls['forge'] ?? 0}` }
    return ''
  }
  // Promise.all, exactly as the runtime does it — so a thunk that REJECTS rejects the
  // whole panel. That propagation is the bug; the fix is that no thunk can reject.
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (line?: unknown): void => {
    logs.push(String(line ?? ''))
  }
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: '/repo',
    task: 'build the feature',
    baseBranch: 'main',
    slug: 'dying-seat',
    maxRounds: 3,
    ralph: false,
    mergeMode: script.pr === true ? 'pr' : 'local',
    prNumber: script.pr === true ? 7 : null,
    branch: null,
    dbPath: null,
    runId: null,
    // PR-mode review starts only after the outer publisher has pushed and
    // witnessed the commit. This harness exercises reviewer death, so enter at
    // that durable handoff instead of stopping at the preceding publish request.
    resumeCheckpoint: script.pr === true
      ? 'outer-published:0123456789abcdef0123456789abcdef01234567:0:1'
      : null,
    // No cross-model credential: the only incompleteness in these runs is the seat
    // this test kills, so nothing else can explain a block.
    codexHome: null,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as RunOut['result']
  return { captured, logs, result }
}

const labels = (out: RunOut): string[] => out.captured.map((c) => c.label)
const countOf = (out: RunOut, label: string): number => labels(out).filter((l) => l === label).length
const promptFor = (out: RunOut, label: string): string =>
  out.captured.find((c) => c.label === label)?.prompt ?? ''

/** The failure the lane recorded: no verdict, only `inner-error`. */
const crashed = (out: RunOut): boolean => out.result?.checkpoint === 'inner-error' || out.result?.ok === false

const overloaded = (): never => {
  throw new Error('API error 529 Overloaded')
}

describe('the SYNTHESIS agent dies outright', () => {
  // THE 2026-08-13 INCIDENT, reproduced: round 7 of 10, the synthesis seat dies on a
  // 529, and the whole lane ends at `inner-error` with no verdict. Every other
  // assertion in this file is downstream of this one.
  test('the run does NOT crash — it ends with a verdict, not `inner-error`', async () => {
    const out = await runWorkflow({ synthesis: overloaded })
    expect(crashed(out)).toBe(false)
    expect(out.result?.ok).toBe(true)
    expect(out.result?.checkpoint).toBe('argus-request-changes')
  })

  test('…and it ends as an INFRA block: REQUEST_CHANGES, never an APPROVE', async () => {
    // Both core seats APPROVE and CI is green: the ONLY thing wrong is the dead seat,
    // so a fix that "recovered" by trusting the panel would show up here as a merge.
    const out = await runWorkflow({
      rubric: () => ({ verdict: 'APPROVE', findings: [] }),
      adversarial: () => ({ verdict: 'APPROVE', findings: [] }),
      synthesis: overloaded,
    })
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('it does not buy a fix round against nothing', async () => {
    const out = await runWorkflow({ synthesis: overloaded })
    // The `crashed` assertion is what keeps this HONEST: a lane that died also runs no
    // fix round, so without it this passes on the very bug it is here to catch.
    expect(crashed(out)).toBe(false)
    expect(labels(out)).not.toContain('forge:fix-round-2')
    expect(out.result?.round).toBe(1)
  })

  // A 529 is TRANSIENT, so the seat that costs the whole round is retried before it is
  // written off — through the same bounded `retryDeferredPeers` the panel seats use.
  test('the seat is RETRIED, and a seat that recovers gives its real verdict', async () => {
    const out = await runWorkflow({
      synthesis: (n) => (n === 1 ? overloaded() : { verdict: 'APPROVE', findings: [] }),
    })
    expect(countOf(out, 'argus:synthesis')).toBe(2)
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
  })

  test('an EXHAUSTED retry still blocks — it never degrades into an approve', async () => {
    const out = await runWorkflow({ synthesis: overloaded })
    expect(countOf(out, 'argus:synthesis')).toBe(2) // 1 dispatch + LANE_RETRY_ATTEMPTS
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('a healthy synthesis is NOT retried — a real verdict is an answer', async () => {
    const out = await runWorkflow({ synthesis: () => ({ verdict: 'APPROVE', findings: [] }) })
    expect(countOf(out, 'argus:synthesis')).toBe(1)
    expect(out.result?.verdict).toBe('APPROVE')
  })

  test('WHICH seat died, and why, is on the record', async () => {
    const out = await runWorkflow({ synthesis: overloaded })
    // The seat-death line specifically, not merely "the string argus:synthesis appears
    // in the transcript" — the crash transcript contains that too, so the looser
    // assertion passed on the broken code.
    const died = out.logs.filter((l) => l.startsWith('trident.seat-died '))
    expect(died.length).toBeGreaterThan(0)
    expect(died.join('\n')).toContain('seat=argus:synthesis')
    expect(died.join('\n')).toContain('529')
    expect(crashed(out)).toBe(false)
  })

  // Dying and answering-with-nothing must be the SAME event to the loop. If these two
  // runs ever diverge, one of the two paths has grown its own handling again.
  test('dying is indistinguishable from returning null', async () => {
    const died = await runWorkflow({ synthesis: overloaded })
    const empty = await runWorkflow({ synthesis: () => null })
    expect(died.result?.verdict).toBe(empty.result?.verdict!)
    expect(died.result?.blockKind).toBe(empty.result?.blockKind!)
    expect(died.result?.checkpoint).toBe(empty.result?.checkpoint!)
  })

  test.each([
    ['a non-Error rejection', (): never => { throw 'killed by signal 9' }],
    ['a non-object reply', () => 'APPROVE'],
    ['an object with no verdict', () => ({ findings: [] })],
    ['a null verdict', () => ({ verdict: null })],
    ['a non-string verdict', () => ({ verdict: 42 })],
  ])('%s ends the same way: a clean infra block, never a crash', async (_label, synthesis) => {
    const out = await runWorkflow({ synthesis: synthesis as (n: number) => unknown })
    expect(crashed(out)).toBe(false)
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })
})

describe('a PANEL seat dies outright', () => {
  test('a dead core seat does not crash the run — it is retried, then gated', async () => {
    const out = await runWorkflow({ adversarial: overloaded })
    expect(crashed(out)).toBe(false)
    expect(countOf(out, 'argus:adversarial')).toBe(2) // dispatch + retry
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('the synthesis model is TOLD that seat is empty, never handed a crash', async () => {
    const out = await runWorkflow({ adversarial: overloaded })
    expect(promptFor(out, 'argus:synthesis')).toContain('Verdict B (Argus adversarial): DID NOT COMPLETE')
  })

  test('one flake costs no build: a seat that dies once and answers on retry still merges', async () => {
    const out = await runWorkflow({
      adversarial: (n) => (n === 1 ? overloaded() : { verdict: 'APPROVE', findings: [] }),
      rubric: () => ({ verdict: 'APPROVE', findings: [] }),
      synthesis: () => ({ verdict: 'APPROVE', findings: [] }),
    })
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
  })

  test('an APPROVE-happy synthesis cannot rescue a dead seat', async () => {
    const out = await runWorkflow({ adversarial: overloaded, synthesis: () => ({ verdict: 'APPROVE', findings: [] }) })
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('BOTH core seats dying is still a clean block, not a crash', async () => {
    const out = await runWorkflow({ rubric: overloaded, adversarial: overloaded })
    expect(crashed(out)).toBe(false)
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })
})

describe('the CI probe dies outright', () => {
  // The probe is a seat too: its agent shells out to `gh`, and an unguarded rejection
  // there ended the lane exactly as a reviewer's did. "We could not tell" is an infra
  // deferral, never a green build.
  test('a dead probe blocks as "could not tell" instead of crashing the run', async () => {
    const out = await runWorkflow({ pr: true, ciProbe: overloaded, synthesis: () => ({ verdict: 'APPROVE', findings: [] }) })
    expect(crashed(out)).toBe(false)
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('a healthy probe still merges — the guard only fires on a seat that failed', async () => {
    const out = await runWorkflow({ pr: true, synthesis: () => ({ verdict: 'APPROVE', findings: [] }) })
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
  })
})

describe('a healthy run is untouched', () => {
  // The regression this change could plausibly cause is over-blocking. A run where
  // nothing died must still merge, and must still spend exactly one dispatch per seat.
  test('a complete panel with a real APPROVE still merges, in one round', async () => {
    const out = await runWorkflow({
      rubric: () => ({ verdict: 'APPROVE', findings: [] }),
      adversarial: () => ({ verdict: 'APPROVE', findings: [] }),
      synthesis: () => ({ verdict: 'APPROVE', findings: [] }),
    })
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
    expect(out.result?.round).toBe(1)
    expect(countOf(out, 'argus:claude')).toBe(1)
    expect(countOf(out, 'argus:adversarial')).toBe(1)
    expect(countOf(out, 'argus:synthesis')).toBe(1)
  })

  test('a real CODE rejection still re-Forges — a block that has something to fix', async () => {
    const out = await runWorkflow({
      synthesis: (n) =>
        n === 1
          ? { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'blocker', title: 'null deref', evidence: 'a.ts:1' }] }
          : { verdict: 'APPROVE', findings: [] },
    })
    expect(labels(out)).toContain('forge:fix-round-2')
    expect(promptFor(out, 'forge:fix-round-2')).toContain('null deref')
    expect(out.result?.verdict).toBe('APPROVE')
  })
})
