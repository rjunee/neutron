import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Execute the complete production body, as in inner-workflow-built-head.test.ts.
// Only runtime seats are faked: gates, checkpoints and terminal results are real.
const SRC = readFileSync(new URL('./inner-workflow.mjs', import.meta.url), 'utf8')
const HEAD = 'a'.repeat(40)
const BRANCH = 'trident/gate-pins'
const COMPLETE = {
  branch: BRANCH, commitSha: HEAD, diffFile: '/tmp/gates.diff', worktreePath: '/wt',
  testsPassed: true, prNumber: null, codexStatus: 'connected', trailerComplete: true,
  wrapperExitCode: 0,
}
const UNKNOWN = { ...COMPLETE, trailerComplete: false, wrapperExitCode: null }

interface Options {
  args?: Record<string, unknown>
  build?: Record<string, unknown> | Error
  probes?: unknown[]
  head?: string
  plan?: unknown
  replan?: unknown
  planWrong?: boolean
}

async function runWorkflow(opts: Options = {}) {
  const calls: Array<{ label: string; prompt: string }> = []
  let probes = 0
  let builds = 0
  let reviews = 0
  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    calls.push({ label, prompt })
    if (label.startsWith('probe:codex-trailer-')) {
      // A removed bound must terminate the fixture too, with the wrong consequence.
      if (++probes > 6) throw new Error('fixture probe budget exceeded')
      return opts.probes?.[probes - 1] ?? null
    }
    if (label === 'forge:build') {
      if (opts.build instanceof Error) throw opts.build
      return builds++ === 0 ? opts.build ?? COMPLETE : COMPLETE
    }
    if (label.startsWith('head-probe-round-')) return { head: opts.head ?? (reviews > 0 ? 'b'.repeat(40) : HEAD) }
    if (label === 'plan:fable') {
      const plan = opts.planWrong ? opts.replan : opts.plan
      if (plan instanceof Error) throw plan
      return plan ?? null
    }
    if (label.startsWith('forge:fix-round-')) return { ...COMPLETE, commitSha: 'b'.repeat(40) }
    if (label === 'argus:synthesis' && opts.planWrong && reviews++ === 0) {
      return { verdict: 'REQUEST_CHANGES', findings: [],
        escalate: { kind: 'design-gap', whatIsMissing: 'the plan requires the wrong protocol' } }
    }
    if (label.startsWith('argus:')) return { verdict: 'APPROVE', findings: [] }
    return ''
  }
  const args = {
    repoPath: '/repo', task: 'pin existing gates', baseBranch: 'main', slug: 'gate-pins',
    branch: BRANCH, maxRounds: 3, executionStrategy: 'single', mergeMode: 'pr',
    dbPath: '/tmp/gates.db', runId: 'gate-pins', checkpointScript: '/harness/checkpoint.sh',
    codexBuildScript: '/harness/codex-build.sh',
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    phaseModels: { build: { model: 'gpt' } },
    modelTiers: { gpt: { model_id: 'gpt-5-codex', transport: 'cli', group: 'codex' } },
    ...opts.args,
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args',
    SRC.replace('export const meta', 'const meta'))(
    agent, async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
    () => {}, () => {}, { total: 0, spent: () => 0 }, args,
  )
  return { result, calls, probes }
}

function expectStopped(out: Awaited<ReturnType<typeof runWorkflow>>, cause: string) {
  expect(out.result.ok).toBe(false)
  expect(out.result.terminalCause).toContain(cause)
  expect(out.result.publishRequested).toBeUndefined()
  expect(out.calls.filter((c) => c.label.startsWith('argus:'))).toEqual([])
  expect(out.calls.some((c) => c.label === 'terminal-result')).toBe(true)
}

describe('G022 current completion consequences', () => {
  test('finished trailer is collected before publication handoff', async () => {
    const out = await runWorkflow({ build: UNKNOWN, probes: [{ trailerBody: `NEUTRON_CODEX_BUILD_HEAD=${HEAD}`, exitCode: 0 }] })
    expect(out.probes).toBe(1)
    expect(out.calls.filter((c) => c.label === 'forge:build')).toHaveLength(2)
    expect(out.result.publishRequested).toBe(true)
    expect(out.result.publishHead).toBe(HEAD)
    expect(out.result.checkpoint).toBe('forge-done')
  })

  test.each([0, 1, 137])('recorded exit %s without trailer is a measured failure', async (exitCode) => {
    const out = await runWorkflow({ build: UNKNOWN, probes: [{ exitCode, trailerBody: '', errBytesBefore: 1, errBytesAfter: 2 }] })
    expectStopped(out, exitCode >= 128 ? `recorded exit ${exitCode}` : `exited with code ${exitCode}`)
    expect(out.probes).toBe(1)
    expect(out.result.checkpoint).toBe('inner-error')
    expect(out.result.blockKind).toBeUndefined()
  })

  test('could-not-find-out remains resumable after exactly two inconclusive probes', async () => {
    const out = await runWorkflow({ build: UNKNOWN })
    expectStopped(out, 'no wrapper exit was recorded')
    expect(out.probes).toBe(2)
    expect(out.result.checkpoint).toBe('awaiting-trailer')
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.calls.some((c) => c.label === 'checkpoint:awaiting-trailer')).toBe(true)
  })

  test('complete but disconnected result refuses publication', async () => {
    const out = await runWorkflow({ build: { ...COMPLETE, codexStatus: 'not_connected' } })
    expectStopped(out, 'not_connected')
    expect(out.probes).toBe(0)
  })
})

describe('G021 launcher wrapper and G023 assigned branch', () => {
  test('a refusing commit wrapper reaches the terminal workflow-threw vocabulary', async () => {
    const guard = new URL('./commit-with-resolved-head.sh', import.meta.url).pathname
    const refusal = spawnSync('bash', [guard, BRANCH, '-m', 'must not land'], {
      cwd: '/tmp',
      encoding: 'utf8',
    })
    expect(refusal.status).toBe(65)
    expect(refusal.stderr).toContain('HEAD does not resolve')

    const out = await runWorkflow({ build: new Error(refusal.stderr.trim()) })

    expectStopped(out, 'HEAD does not resolve')
    expect(out.result.terminalCauseKind).toBe('workflow-threw')
    expect(out.result.checkpoint).toBe('inner-error')
  })

  test('G021 missing wrapper stops before invoking the builder', async () => {
    const out = await runWorkflow({ args: { codexBuildScript: null } })
    expectStopped(out, 'launcher did not thread codexBuildScript')
    expect(out.calls.filter((c) => c.label === 'forge:build')).toEqual([])
  })

  test('G021 supplied wrapper and G023 matching branch allow handoff', async () => {
    const out = await runWorkflow()
    expect(out.result.publishRequested).toBe(true)
    expect(out.result.branch).toBe(BRANCH)
    expect(out.calls.find((c) => c.label === 'forge:build')?.prompt).toContain('/harness/codex-build.sh')
  })

  test('G023 differing reported branch refuses handoff even with a valid commit', async () => {
    const out = await runWorkflow({ build: { ...COMPLETE, branch: 'trident/other' } })
    expectStopped(out, "committed on branch 'trident/other'")
    expect(out.result.terminalCause).toContain(BRANCH)
  })
})

const MEMBER = { pinnedTaskId: 'T1', memberBranch: BRANCH, phaseModels: {} }
const PLAN = {
  implementationPlan: '- [ ] T1: pinned task\n- [ ] T2: other task',
  topTask: '- [ ] T2: other task', executionSpec: 'implement the pinned task',
  complexity: 'mechanical', remainingTasks: 1,
}

describe('G024 pinned member plan and G034 full commit', () => {
  test('G024 missing plan refuses Forge with the measured planner failure', async () => {
    const out = await runWorkflow({ args: MEMBER })
    expectStopped(out, 'plan:fable returned null for pinned wave task T1')
    expect(out.calls.filter((c) => c.label === 'forge:build')).toEqual([])
  })

  test.each(['- [x] T1: pinned task\n- [ ] T2: other task', '- [ ] T2: other task'])(
    'G024 checked or missing pinned task cannot substitute another unchecked task: %s', async (implementationPlan) => {
      const out = await runWorkflow({ args: MEMBER, plan: { ...PLAN, implementationPlan } })
      expectStopped(out, 'does not contain unchecked pinned task T1')
      expect(out.calls.filter((c) => c.label === 'forge:build')).toEqual([])
    },
  )

  test('G024 valid pinned task overrides planner selection; G034 returns built without review or publication', async () => {
    const out = await runWorkflow({ args: MEMBER, plan: { ...PLAN } })
    expect(out.result).toMatchObject({ ok: true, built: true, commitSha: HEAD, branch: BRANCH,
      checkpoint: 'built', terminalCauseKind: 'wave-member-built', prNumber: null, verdict: null })
    expect(out.result.publishRequested).toBeUndefined()
    expect(out.calls.filter((c) => c.label.startsWith('argus:'))).toEqual([])
    expect(out.calls.some((c) => c.label === 'checkpoint:built')).toBe(true)
    const prompt = out.calls.find((c) => c.label === 'forge:build')?.prompt ?? ''
    expect(prompt).toContain('Implement ONLY this pinned plan line, quoted verbatim from the shared plan:\n- [ ] T1: pinned task')
  })

  test('G034 no full OID refuses built result, with earlier head-read stop deliberately bypassed in PR mode', async () => {
    const out = await runWorkflow({ args: MEMBER, plan: { ...PLAN }, head: 'absent',
      build: { ...COMPLETE, commitSha: 'abc1234' } })
    expectStopped(out, 'completed Forge without a full commit OID')
    expect(out.result.built).toBeUndefined()
    expect(out.calls.some((c) => c.label === 'checkpoint:built')).toBe(false)
    expect(out.calls.some((c) => c.label.startsWith('head-probe-round-built-'))).toBe(true)
  })
})

describe('G075 failed bounded re-plan', () => {
  test.each([
    [null, 'returned null'],
    [{ ...PLAN, executionSpec: '  ' }, 'returned no executionSpec'],
    [new Error('planner unavailable'), 'threw: planner unavailable'],
  ])('stops with design-gap escalation when planner %s', async (replan, evidence) => {
    const out = await runWorkflow({ args: { mergeMode: 'local', phaseModels: {} }, planWrong: true, replan })
    expect(out.calls.filter((c) => c.label === 'plan:fable')).toHaveLength(1)
    // ok records workflow completion, while verdict/blockKind carry the refusal.
    expect(out.result.ok).toBe(true)
    expect(out.result.verdict).toBe('REQUEST_CHANGES')
    expect(out.result.blockKind).toBe('design-gap')
    expect(out.result.escalation).toMatchObject({ kind: 'design-gap',
      triggers: ['design-gap', 're-plan-failed'], round: 2 })
    expect(out.result.escalation.evidence).toContain(evidence)
    expect(out.result.terminalCauseKind).toBe('review-escalated')
    expect(out.calls.filter((c) => c.label.startsWith('forge:fix-round-'))).toEqual([])
  })

  test('a usable revised plan reaches the fix builder with the new execution spec', async () => {
    const out = await runWorkflow({ args: { mergeMode: 'local', phaseModels: {} }, planWrong: true,
      replan: { ...PLAN, executionSpec: 'REVISED protocol implementation' } })
    expect(out.calls.filter((c) => c.label === 'plan:fable')).toHaveLength(1)
    const fixes = out.calls.filter((c) => c.label.startsWith('forge:fix-round-'))
    expect(fixes).toHaveLength(1)
    expect(fixes[0]?.prompt).toContain('REVISED protocol implementation')
    expect(out.result.escalation).toBeUndefined()
    expect(out.result.verdict).toBe('APPROVE')
  })
})
