/**
 * THE CHOSEN MODEL REACHES THE DISPATCH — asserted against the REAL launcher output
 * and the REAL workflow, not a hand-built config literal.
 *
 * WHY THIS FILE IS THE ONE THAT MATTERS. A settings pane that saves a choice nothing
 * reads is this repository's most repeated defect (ISSUES #551 — an entire device-flow
 * backend with no caller; #447; #448), and the per-phase model config has already been
 * shipped once with no producer at all. So the chain is exercised end to end:
 *
 *   the owner's stored override
 *     → `buildWorkflowArgs` (the production launcher — same function the composer's
 *        firer calls, not a fixture)
 *     → `inner-workflow.mjs` (the real script, run as an AsyncFunction with mocked
 *        runtime globals, exactly as `inner-workflow-assembly.test.ts` does)
 *     → the COMMAND STRING the cross-model bridge is told to run.
 *
 * The last step is the one worth insisting on. For a Claude phase the assertion can
 * read `agent()`'s opts; for a GPT or Kimi phase there are no opts to read — the model
 * is only real if it appears in the subprocess's environment on the command line. An
 * assertion that stopped at "the setting was stored" would pass on a build that
 * reviewed with the wrong model.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SONNET_MODEL } from '@neutronai/runtime/models.ts'

import { buildWorkflowArgs } from '../inner-loop.ts'

const SRC = readFileSync(fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)), 'utf8')

interface Captured {
  label: string | undefined
  prompt: string
  opts: Record<string, unknown>
}

/** The production launcher args for a run, with the owner's overrides applied. */
function productionArgs(
  phase_models: Record<string, { model?: string; effort?: string }> | null,
): Record<string, unknown> {
  return buildWorkflowArgs({
    run: {
      id: 'run-1',
      slug: 'a-run',
      task: 'do the thing',
      repo_path: '/repo',
      worktree: null,
      branch: null,
      pr: null,
      merge_mode: 'local',
      ralph: false,
    } as never,
    base_branch: 'main',
    db_path: null as never,
    max_rounds: 2,
    // Both cross-model peers configured, or their seats never dispatch and there is
    // no command to assert.
    codex_home: '/codex',
    kimi_configured: true,
    ...(phase_models !== null ? { phase_models } : {}),
  })
}

async function runWorkflow(
  args: Record<string, unknown>,
): Promise<{ captured: Captured[]; logs: string[] }> {
  const captured: Captured[] = []
  const logs: string[] = []
  let synthCount = 0

  const agent = async (prompt: string, o?: Record<string, unknown>): Promise<unknown> => {
    const label = o?.['label'] as string | undefined
    captured.push({ label, prompt, opts: o ?? {} })
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return {
        prNumber: null,
        branch: 'trident/a-run',
        diffFile: '/tmp/x.diff',
        worktreePath: '/wt',
        commitSha: 'abc',
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      return { verdict: 'APPROVE', findings: [] }
    }
    if (label === 'argus:cross-1' || label === 'argus:cross-1-retry') {
      return { verdict: 'APPROVE', findings: [], crossStatus: 'connected', crossTruncated: false }
    }
    if (label === 'argus:cross-2' || label === 'argus:cross-2-retry') {
      return { verdict: 'APPROVE', findings: [], crossStatus: 'connected' }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      return { verdict: 'APPROVE', findings: [] }
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (line: unknown): void => {
    logs.push(String(line))
  }
  const budget = { total: 0, spent: (): number => 0 }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  await fn(agent, parallel, phase, log, budget, args)
  expect(synthCount).toBeGreaterThan(0)
  return { captured, logs }
}

const promptFor = (captured: Captured[], label: string): string => {
  const found = captured.find((c) => c.label === label)
  if (found === undefined) throw new Error(`no agent was dispatched with label '${label}'`)
  return found.prompt
}

describe('THE DEFAULT PATH — an install that never opened the pane', () => {
  test('codex still reviews on gpt-5.6-sol, and kimi on kimi-k3', async () => {
    const { captured } = await runWorkflow(productionArgs(null))
    // The wrapper's own pin says `sol` too (`model-tiers.test.ts` holds those two
    // together), so this is the behaviour that shipped before the selector existed —
    // now stated by the dispatch instead of left to the CLI's default.
    expect(promptFor(captured, 'argus:cross-1')).toContain("CODEX_REVIEW_MODEL='gpt-5.6-sol'")
    expect(promptFor(captured, 'argus:cross-2')).toContain("KIMI_MODEL='kimi-k3'")
  })

  test('the model is set on the SUBPROCESS, never on the wrapping agent', async () => {
    // `agent({model})` resolves against Claude Code's own endpoint; a GPT id there
    // reaches nothing. The thin bridge agent must therefore carry NO model at all.
    const { captured } = await runWorkflow(productionArgs(null))
    for (const label of ['argus:cross-1', 'argus:cross-2']) {
      const seat = captured.find((c) => c.label === label)!
      expect({ label, model: seat.opts['model'] ?? null }).toEqual({ label, model: null })
    }
  })

  test('the launcher omits phaseModels entirely, so the args are the ones it always sent', async () => {
    expect('phaseModels' in productionArgs(null)).toBe(false)
  })
})

describe('AN OVERRIDE REACHES THE DISPATCH', () => {
  test('choosing the `terra` tier puts gpt-5.6-terra on the codex command line', async () => {
    const stored = { review_cross_1: { model: 'terra' } }
    // Through the production launcher: if `buildWorkflowArgs` dropped it, or the
    // workflow ignored it, this is the assertion that goes red.
    const args = productionArgs(stored)
    expect(args['phaseModels']).toEqual({ review_cross_1: { model: 'terra' } })
    const { captured, logs } = await runWorkflow(args)
    const cmd = promptFor(captured, 'argus:cross-1')
    expect(cmd).toContain("CODEX_REVIEW_MODEL='gpt-5.6-terra'")
    expect(cmd).not.toContain('gpt-5.6-sol')
    // And the run says so, because "did my setting take effect?" must be answerable
    // from the output of a build the owner did not watch.
    expect(logs.some((l) => l.includes('label=argus:cross-1') && l.includes('gpt-5.6-terra'))).toBe(
      true,
    )
    expect(logs.some((l) => l.includes('label=argus:cross-1') && l.includes('override=owner'))).toBe(
      true,
    )
    // The OTHER cross-model lane is untouched — one row's choice is one row's choice.
    expect(promptFor(captured, 'argus:cross-2')).toContain("KIMI_MODEL='kimi-k3'")
  })

  test('a Claude phase override still lands on the agent opts', async () => {
    const { captured } = await runWorkflow(
      productionArgs({ build: { model: 'sonnet', effort: 'max' } }),
    )
    const build = captured.find((c) => c.label === 'forge:build')!
    // The RESOLVED id, not the tier name — a spawn asking for a model called
    // "sonnet" would be a tier that never got resolved.
    expect({ model: build.opts['model'], effort: build.opts['effort'] }).toEqual({
      model: SONNET_MODEL,
      effort: 'max',
    })
  })
})

describe('A CONFIG THAT GOT PAST THE TYPED BOUNDARY DEGRADES VISIBLY', () => {
  /**
   * These args are built by hand ON PURPOSE, and it is the one place in this file
   * that is legitimate: `buildWorkflowArgs` REJECTS both values, so the only way to
   * reach the workflow's own backstop is to write what a hand-edited row or an older,
   * looser build would have produced. Both are proved rejected first, so this can
   * never quietly become a test of a path the launcher actually takes.
   */
  const past = (phaseModels: Record<string, unknown>): Record<string, unknown> => ({
    ...productionArgs(null),
    phaseModels,
  })

  test('a RETIRED tier keeps the phase default and names itself in the log', async () => {
    expect(productionArgs({ review_cross_1: { model: 'gpt-5.7-nova' } })['phaseModels']).toBeUndefined()

    const { captured, logs } = await runWorkflow(past({ review_cross_1: { model: 'gpt-5.7-nova' } }))
    // FALLS BACK, never dispatches the unknown id: a value the registry cannot place
    // carries no transport, so "send it anyway" means handing it to whichever
    // executor happens to be wired.
    const cmd = promptFor(captured, 'argus:cross-1')
    expect(cmd).toContain("CODEX_REVIEW_MODEL='gpt-5.6-sol'")
    expect(cmd).not.toContain('gpt-5.7-nova')
    expect(
      logs.some((l) => l.includes('IGNORED') && l.includes('unknown-tier') && l.includes('gpt-5.7-nova')),
    ).toBe(true)
  })

  test('a tier the phase cannot REACH is refused, not handed to agent()', async () => {
    // THIS ASSERTION MOVED RATHER THAN WEAKENED. It used to prove `build: sol` was
    // refused, and that was right while nothing routed a build to codex — the
    // alternative was `agent({model: 'gpt-5.6-sol'})`, a spawn against an endpoint that
    // has never heard of the id. The codex build route exists now, so `sol` on the
    // build row is a legitimate choice and is proven to dispatch in
    // `codex-build-dispatch.test.ts`. What must STILL be refused is a tier whose
    // executor the phase genuinely cannot reach — here a codex tier on the Claude-only
    // synthesis step.
    expect(productionArgs({ synthesis: { model: 'sol' } })['phaseModels']).toBeUndefined()

    const { captured, logs } = await runWorkflow(past({ synthesis: { model: 'sol' } }))
    const synth = captured.find((c) => c.label === 'argus:synthesis')!
    expect(synth.opts['model']).not.toBe('gpt-5.6-sol')
    expect(
      logs.some((l) => l.includes('IGNORED') && l.includes('executor-not-reachable')),
    ).toBe(true)
  })

  test('an effort on a CLI lane is refused rather than stored into a dispatch nothing reads', async () => {
    expect(productionArgs({ review_cross_1: { effort: 'max' } })['phaseModels']).toBeUndefined()

    const { logs } = await runWorkflow(past({ review_cross_1: { effort: 'max' } }))
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('effort-not-settable'))).toBe(true)
  })
})
