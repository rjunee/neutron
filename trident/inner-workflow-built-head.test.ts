import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { innerTerminalFailureReason } from './orchestrator.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
const H = 'c'.repeat(40)
const FIX = 'f'.repeat(40)

interface Options {
  mode?: 'pr' | 'local'
  claim?: string
  probes?: string[]
  verdicts?: Array<'APPROVE' | 'REQUEST_CHANGES'>
  fixClaim?: string
  buildDiff?: string
}

async function runBuiltHead(opts: Options = {}) {
  const labels: string[] = []
  const logs: string[] = []
  const prompts: Array<{ label: string; prompt: string }> = []
  const probes = [...(opts.probes ?? [H])]
  const verdicts = [...(opts.verdicts ?? ['APPROVE'])]
  let round = 1
  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = String(o?.label ?? '')
    labels.push(label)
    prompts.push({ label, prompt })
    if (label.startsWith('head-probe-round-built-')) return { head: probes.shift() ?? FIX }
    if (label.startsWith('head-probe-round-')) return { head: FIX }
    if (label === 'forge:build') return { prNumber: null, branch: 'trident/built-head', diffFile: opts.buildDiff ?? '/tmp/built.diff', worktreePath: '/wt', commitSha: opts.claim ?? '', testsPassed: true }
    if (label.startsWith('forge:fix-round-')) {
      round = Number(label.slice('forge:fix-round-'.length))
      return { prNumber: null, branch: 'trident/built-head', diffFile: '/tmp/fix.diff', worktreePath: '/wt', commitSha: opts.fixClaim ?? FIX, testsPassed: true }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') {
      const verdict = verdicts.shift() ?? 'APPROVE'
      return verdict === 'APPROVE' ? { verdict, findings: [] } : { verdict, findings: [{ severity: 'blocker', title: 'fix it', evidence: 'x:1' }] }
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f()))
  const args = {
    repoPath: '/repo', task: 'Ship it', baseBranch: 'main', slug: 'built-head', maxRounds: 3,
    ralph: false, mergeMode: opts.mode ?? 'local', prNumber: null, branch: 'trident/built-head',
    dbPath: '/tmp/no.db', runId: 'built-head-run', resumeCheckpoint: null, codexHome: null,
    checkpointScript: '/repo/trident/checkpoint.sh', worktreeCleanupScript: '/repo/trident/worktree-cleanup.sh',
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' }, reflectionGuidance: '',
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', SRC.replace('export const meta', 'const meta'))(
    agent, parallel, () => {}, (...v: unknown[]) => { logs.push(v.map(String).join(' ')) }, { total: 0, spent: () => 0 }, args,
  )
  return { labels, prompts, logs, result, round }
}

const checkpoint = (out: Awaited<ReturnType<typeof runBuiltHead>>, name: string) =>
  out.prompts.find((p) => p.label === `checkpoint:${name}`)?.prompt ?? ''

describe('build-completion heads come from git', () => {
  test('PR no claim publishes with null claim and checkpoints the git OID', async () => {
    const out = await runBuiltHead({ mode: 'pr' })
    expect(out.result.publishRequested).toBe(true)
    expect(out.result.publishHead).toBeNull()
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head '${H}'`)
  })

  test('PR abbreviated claim is cross-checked but full git OID is checkpointed', async () => {
    const out = await runBuiltHead({ mode: 'pr', claim: H.slice(0, 7) })
    expect(out.result.publishHead).toBe(H.slice(0, 7))
    expect(checkpoint(out, 'forge-done')).toContain(`inner_checkpoint_head '${H}'`)
  })

  test('mismatch stops infra-only, names both values, and never dispatches review', async () => {
    const claim = 'd'.repeat(40)
    const out = await runBuiltHead({ mode: 'pr', claim })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain(claim)
    expect(out.result.terminalCause).toContain(H)
    expect(out.result.publishRequested).toBeUndefined()
    expect(out.labels.some((l) => l.startsWith('argus:'))).toBe(false)
    const reason = innerTerminalFailureReason(
      { max_rounds: 3, round: 1, inner_checkpoint: null },
      { round: 1, checkpoint: 'forge-done', block_kind: 'infra-only', terminal_cause: out.result.terminalCause },
    )
    expect(reason).toContain(claim)
    expect(reason).toContain(H)
    expect(reason).not.toContain('without Argus APPROVE')
  })

  test('transient unreadability retries exactly once and proceeds', async () => {
    const out = await runBuiltHead({ mode: 'pr', probes: ['', H] })
    expect(out.labels.filter((l) => l === 'head-probe-round-built-r1')).toHaveLength(2)
    expect(out.result.publishRequested).toBe(true)
  })

  test('permanent local unreadability stops boundedly before plan or review', async () => {
    const out = await runBuiltHead({ probes: ['', ''], claim: H.slice(0, 7) })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('refs/heads/trident/built-head')
    expect(out.result.terminalCause).toContain(H.slice(0, 7))
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.labels.some((l) => l.startsWith('argus:') || l === 'plan:fable')).toBe(false)
  })

  test('local build with no claim reviews and returns the git-read OID', async () => {
    const out = await runBuiltHead()
    expect(out.result.reviewedHead).toBe(H)
  })

  test('fix mismatch stops and names the fix claim and git head', async () => {
    const claim = 'e'.repeat(40)
    const out = await runBuiltHead({ probes: [H, FIX], verdicts: ['REQUEST_CHANGES'], fixClaim: claim })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain(claim)
    expect(out.result.terminalCause).toContain(FIX)
  })

  test('fix checkpoint records the OID probed at that round completion', async () => {
    const out = await runBuiltHead({ probes: [H, FIX], verdicts: ['REQUEST_CHANGES'], fixClaim: FIX })
    expect(checkpoint(out, 'fix-round-2')).toContain(`inner_checkpoint_head '${FIX}'`)
  })
})

/**
 * "NOTHING WAS BUILT" AND "COULD NOT READ THE HEAD" ARE DIFFERENT OUTCOMES with
 * different recoveries, and collapsing them emits re-run advice that can never
 * succeed: re-running a build that produced nothing produces nothing again. The
 * probe is tri-state for exactly this — `'absent'` is git ANSWERING that the branch
 * was never created, `''` is a failed read.
 */
describe('an empty build is never reported as an unreadable head', () => {
  test('a branch git says does NOT exist throws "nothing was built", with no re-run advice', async () => {
    const out = await runBuiltHead({ probes: ['absent'] })
    expect(out.result.ok).toBe(false)
    expect(out.logs.some((l) => l.includes('inner THREW') && l.includes('nothing was built'))).toBe(true)
    expect(out.logs.some((l) => l.includes('re-run when the read succeeds'))).toBe(false)
    expect(out.logs.some((l) => l.includes(`no commit on trident/built-head`))).toBe(true)
    expect(out.labels.some((l) => l.startsWith('argus:'))).toBe(false)
  })

  test('an unreadable head with NO diff is "nothing was built" too — the read is not what failed', async () => {
    const out = await runBuiltHead({ probes: ['', ''], buildDiff: '' })
    expect(out.result.ok).toBe(false)
    expect(out.logs.some((l) => l.includes('inner THREW') && l.includes('nothing was built'))).toBe(true)
    expect(out.result.terminalCause ?? '').not.toContain('re-run when the read succeeds')
  })

  test('the CONTROL: an unreadable head WITH a diff is the infra-only stop, not a throw', async () => {
    const out = await runBuiltHead({ probes: ['', ''] })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.logs.some((l) => l.includes('inner THREW'))).toBe(false)
  })
})

describe('a fix round stops on an unreadable head, exactly as round 1 does', () => {
  test('permanent unreadability at a fix round: no APPROVE, no empty reviewedHead, no empty checkpoint head', async () => {
    const out = await runBuiltHead({ probes: [H, '', ''], verdicts: ['REQUEST_CHANGES'] })
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.checkpoint).toBe('fix-round-2')
    expect(out.result.terminalCause).toContain('refs/heads/trident/built-head')
    expect(out.result.terminalCause).toContain('re-run when the read succeeds')
    expect(out.result.verdict).not.toBe('APPROVE')
    // The checkpoint that used to be written with head '' — which classifyResume maps
    // to REBUILD (no recorded head), the rebuild-of-committed-work path Part 2 removes.
    expect(checkpoint(out, 'fix-round-2')).toBe('')
  })

  test('PR mode does NOT stop on a PERMANENTLY unreadable head — the publisher rev-parses it (the `!isPr` carve-out)', async () => {
    // The case the carve-out exists for, and the one the suite did not cover: BOTH
    // reads failed, so this is not the transient path. In `pr` mode the workflow hands
    // the BRANCH NAME to the outer publisher, which resolves the OID itself at the
    // credentialed boundary — so an unread head here is not the run's problem. Delete
    // `&& !isPr` and this test fails while every other one still passes.
    const r1 = await runBuiltHead({ mode: 'pr', probes: ['', ''] })
    expect(r1.result.publishRequested).toBe(true)
    expect(r1.result.publishHead).toBeNull()
    expect(r1.result.blockKind).toBeUndefined()
    expect(r1.labels.filter((l) => l === 'head-probe-round-built-r1')).toHaveLength(2)
    // …and the SAME probes in local mode DO stop, so the difference is the carve-out.
    const local = await runBuiltHead({ probes: ['', ''] })
    expect(local.result.blockKind).toBe('infra-only')
  })
})

describe('the two bounded stops agree on `ok` — one failure class, one shape', () => {
  test('a built-head stop reports ok:false, like the resume stop', async () => {
    const out = await runBuiltHead({ probes: ['', ''] })
    expect(out.result.ok).toBe(false)
    expect(out.result.blockKind).toBe('infra-only')
    expect(out.result.verdict).toBe('REQUEST_CHANGES')
  })
})
