/**
 * A DEAD CORE REVIEWER, DRIVEN THROUGH THE WHOLE WORKFLOW (#535 / #536, round 3).
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. `enforceCrossModelGate`, `classifyBlock`
 * and `missingCoreReviewers` are each tested in isolation, and each one was GREEN while
 * the composition of the three was broken: the gate only stamped its blockers when the
 * synthesis said APPROVE, so on the path the synthesis prompt itself makes LIKELY — it
 * tells the model, verbatim, "the panel is incomplete: do NOT return APPROVE" — a
 * COMPLIANT REQUEST_CHANGES bypassed the gate entirely. The deterministic "which seat
 * produced nothing" blocker was dropped from the round, and nothing carried `kind:'lane'`,
 * so the classifier read the model's own findings as CODE and the fix loop re-Forged the
 * diff to "fix" a reviewer that never ran. Three green unit suites, one open hole.
 *
 * So this runs the REAL `inner-workflow.mjs` — source, not a copy — with mocked runtime
 * globals (the harness shape `inner-workflow-assembly.test.ts` established), kills a core
 * seat, and asserts on what the run actually DID: which agents were dispatched, what the
 * synthesis was told, what the fix round was handed, and how the run terminated.
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
  result: { verdict?: string; blockKind?: string; round?: number } | null
}

/**
 * Replies for the seats this run wants to control; everything else answers normally.
 * A seat's reply is a function of ITS OWN dispatch count, so a run can script "dies the
 * first time, answers on the retry" — the case the whole retry path exists for.
 */
interface Script {
  rubric?: (n: number) => unknown
  adversarial?: (n: number) => unknown
  synthesis: (n: number) => unknown
}

async function runWorkflow(script: Script): Promise<RunOut> {
  const captured: Captured[] = []
  let synthCount = 0
  const seatCalls: Record<string, number> = { 'argus:claude': 0, 'argus:adversarial': 0 }

  const agent = async (prompt: string, opts?: { label?: string }): Promise<unknown> => {
    const label = String(opts?.label ?? '')
    captured.push({ label, prompt })
    if (label.startsWith('head-probe-round-built-')) return { head: 'a'.repeat(40) }
    if (label === 'forge:build' || label.startsWith('forge:fix-round-')) {
      return {
        prNumber: null,
        branch: 'trident/dead-seat',
        diffFile: '/tmp/x.diff',
        worktreePath: '/wt',
        commitSha: 'abc123',
        testsPassed: true,
      }
    }
    // An unscripted seat answers normally; a scripted one returns whatever its own
    // dispatch count says — `null` being the DEAD seat under test (which is what
    // `parallel` yields for an agent whose subprocess died).
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      seatCalls[label] = (seatCalls[label] ?? 0) + 1
      const seat = label === 'argus:claude' ? script.rubric : script.adversarial
      return seat === undefined ? { verdict: 'REQUEST_CHANGES', findings: [] } : seat(seatCalls[label])
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      return script.synthesis(synthCount)
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: '/repo',
    task: 'build the feature',
    baseBranch: 'main',
    slug: 'dead-seat',
    maxRounds: 3,
    ralph: false,
    mergeMode: 'local',
    prNumber: null,
    branch: null,
    dbPath: null,
    runId: null,
    resumeCheckpoint: null,
    // No codex/kimi credential: the CROSS-MODEL seats are legitimately absent, so
    // the only incompleteness in these runs is the core seat that died.
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
  return { captured, result }
}

const labels = (out: RunOut): string[] => out.captured.map((c) => c.label)
const promptFor = (out: RunOut, label: string): string =>
  out.captured.find((c) => c.label === label)?.prompt ?? ''

describe('a CORE reviewer whose agent died, end to end', () => {
  test('the dead seat is RETRIED before anything reads the panel', async () => {
    // A dead core seat used to get zero retries — `slots` held codex/kimi only — so
    // one transient argus:adversarial crash ended the run as infra-only and threw the
    // whole Forge build away. The seat is re-dispatched under its own label, running
    // the SAME prompt (the seat's own thunk), which is why the count is what changes.
    const out = await runWorkflow({
      adversarial: () => null,
      synthesis: () => ({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'major', title: 'real bug' }] }),
    })
    const adversarialRuns = labels(out).filter((l) => l === 'argus:adversarial').length
    expect(adversarialRuns).toBe(2) // 1 dispatch + LANE_RETRY_ATTEMPTS
    // The healthy seat is NOT re-run: a real verdict is an answer, not a deferral.
    expect(labels(out).filter((l) => l === 'argus:claude').length).toBe(1)
  })

  test('a seat that recovers on RETRY leaves the panel COMPLETE — one flake costs no build', async () => {
    // THE COST THE RETRY REMOVES. Before this, a core seat had no retry at all: the
    // FIRST null ended the run as infra-only on round 1 and discarded the whole Forge
    // build. Here the seat dies once and answers on the retry, and the run merges —
    // the panel downstream never sees an incomplete seat, and no round is spent.
    const out = await runWorkflow({
      adversarial: (n) => (n === 1 ? null : { verdict: 'APPROVE', findings: [] }),
      synthesis: () => ({ verdict: 'APPROVE', findings: [] }),
    })
    expect(labels(out).filter((l) => l === 'argus:adversarial').length).toBe(2)
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
    // The recovered verdict is what the synthesis was shown, not a dead-seat notice.
    expect(promptFor(out, 'argus:synthesis')).not.toContain('DID NOT COMPLETE')
  })

  test('the synthesis model is TOLD the seat is empty — never handed the token `null`', async () => {
    const out = await runWorkflow({
      adversarial: () => null,
      synthesis: () => ({ verdict: 'REQUEST_CHANGES', findings: [] }),
    })
    const prompt = promptFor(out, 'argus:synthesis')
    expect(prompt).toContain('Verdict B (Argus adversarial): DID NOT COMPLETE')
    expect(prompt).not.toContain('Verdict B (Argus adversarial): null')
    // …and the seat that DID answer is still passed through verbatim.
    expect(prompt).toContain('Verdict A (Claude rubric): {"verdict":"REQUEST_CHANGES"')
  })

  // THE BLOCKER THIS FILE WAS WRITTEN FOR. The synthesis OBEYS the prompt and returns
  // REQUEST_CHANGES on its own. The gate used to early-return that verdict untouched,
  // so the deterministic incompleteness blocker never reached the round: the fix agent
  // was handed the model's findings alone and could not know the panel was down a seat.
  test('a COMPLIANT REQUEST_CHANGES still carries the deterministic incompleteness blocker into the fix round', async () => {
    const out = await runWorkflow({
      adversarial: () => null,
      synthesis: () => ({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'major', title: 'real bug' }] }),
    })
    const fixPrompt = promptFor(out, 'forge:fix-round-2')
    expect(fixPrompt).not.toBe('')
    expect(fixPrompt).toContain('produced NO verdict')
    expect(fixPrompt).toContain('"kind":"lane"')
    // The model's own finding is NOT dropped in the process — it rides along behind.
    expect(fixPrompt).toContain('real bug')
  })

  // Argus's composed repro, run end to end: a dead seat plus a nit-only synthesis.
  // `enforceSeverityGate` turns the nit-only REQUEST_CHANGES into an APPROVE, the
  // completeness gate re-blocks it, and the classifier used to count the surviving nit
  // as CODE — so the loop re-Forged a whole round (four fresh reviews) with the panel
  // STILL down a seat, which cannot converge. A nit may not cost a round.
  test('a dead seat plus a NIT-only synthesis stops the loop instead of re-Forging', async () => {
    const out = await runWorkflow({
      adversarial: () => null,
      synthesis: () => ({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'nit', title: 'rename a local' }] }),
    })
    expect(out.result?.blockKind).toBe('infra-only')
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.round).toBe(1)
    expect(labels(out)).not.toContain('forge:fix-round-2')
  })

  test('an incomplete panel can NEVER terminate APPROVE, however the synthesis votes', async () => {
    // The direction that matters: a dead seat and an APPROVE-happy synthesis must not
    // merge. Asserted on the run's own terminal verdict, not on a helper's return.
    const out = await runWorkflow({
      adversarial: () => null,
      synthesis: () => ({ verdict: 'APPROVE', findings: [] }),
    })
    expect(out.result?.verdict).toBe('REQUEST_CHANGES')
    expect(out.result?.blockKind).toBe('infra-only')
  })

  test('a COMPLETE panel is untouched — the gate only ever fires on a missing seat', async () => {
    // The over-blocking regression this change could plausibly cause: forcing
    // REQUEST_CHANGES on every path is only safe if `deferredPeers` is genuinely empty
    // for a healthy panel. A run with both seats answering must still merge.
    const out = await runWorkflow({ synthesis: () => ({ verdict: 'APPROVE', findings: [] }) })
    expect(out.result?.verdict).toBe('APPROVE')
    expect(out.result?.blockKind).toBe('none')
    expect(labels(out)).not.toContain('forge:fix-round-2')
  })
})
