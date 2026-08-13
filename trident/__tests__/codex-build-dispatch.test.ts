/**
 * ISSUES #565 — "THE WHOLE POINT IS I WANT TO BE ABLE TO SWITCH BUILD TO SOL."
 *
 * THIS FILE IS THE CLAIM. Every other artefact in that change — a phase row that lists
 * `codex` among its executors, a validator that stops rejecting `sol` on the build row,
 * a settings pane that stops greying the option — is a PROMISE that a build so
 * configured will run on Codex. The promise is worth nothing on its own: a selectable
 * option that does not dispatch is strictly worse than a greyed one, because the owner
 * believes the run used the model they chose and reads its output accordingly.
 *
 * So the chain is exercised end to end, and the last link is a COMMAND STRING:
 *
 *   the owner's stored override  { build: { model: 'sol' } }
 *     → `buildWorkflowArgs` — the PRODUCTION launcher, the same function the composer's
 *        firer calls. Not a fixture, not a hand-built args literal: "exists" is not
 *        "wired", and a config object typed out in a test proves only that the test
 *        can type one.
 *     → `inner-workflow.mjs` — the REAL script, run as an AsyncFunction with mocked
 *        runtime globals (the technique `inner-workflow-assembly.test.ts` established).
 *     → the command the Forge bridge is told to run.
 *
 * For a Claude phase an assertion can read `agent()`'s `model` opt. For a codex build
 * there is no opt to read — `agent({model})` resolves against Claude Code's own
 * endpoint and cannot reach a GPT model at all, which is the entire reason the CLI
 * route exists. The model is real only if it appears in the subprocess's environment on
 * the command line. An assertion that stopped at "the setting was stored" would pass on
 * a build that silently ran on Opus.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildWorkflowArgs } from '../inner-loop.ts'

const SRC = readFileSync(fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)), 'utf8')

interface Captured {
  label: string | undefined
  prompt: string
  opts: Record<string, unknown>
}

/** The PRODUCTION launcher args for a run, with the owner's overrides applied. */
function productionArgs(
  phase_models: Record<string, { model?: string; effort?: string }> | null,
  opts: { codex?: boolean } = {},
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
    codex_home: opts.codex === false ? null : '/codex',
    kimi_configured: true,
    ...(phase_models !== null ? { phase_models } : {}),
  })
}

async function runWorkflow(
  args: Record<string, unknown>,
): Promise<{ captured: Captured[]; logs: string[] }> {
  const captured: Captured[] = []
  const logs: string[] = []

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
    if (String(label).startsWith('argus:cross-')) {
      return { verdict: 'APPROVE', findings: [], crossStatus: 'connected', crossTruncated: false }
    }
    if (label === 'argus:synthesis') return { verdict: 'APPROVE', findings: [] }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  await fn(
    agent,
    parallel,
    (): void => {},
    (line: unknown): void => {
      logs.push(String(line))
    },
    { total: 0, spent: (): number => 0 },
    args,
  )
  return { captured, logs }
}

const promptFor = (captured: Captured[], label: string): string => {
  const found = captured.find((c) => c.label === label)
  if (found === undefined) throw new Error(`no agent was dispatched with label '${label}'`)
  return found.prompt
}

describe('the build step dispatches to the codex executor when the owner picks one', () => {
  test('the launcher ACCEPTS a codex tier on the build row and threads it', () => {
    // The first link. Before #565 this returned `undefined` — `parsePhaseModelConfig`
    // rejected the entry as a transport mismatch and `buildWorkflowArgs` dropped it,
    // so the owner's choice never left the settings boundary.
    const args = productionArgs({ build: { model: 'sol' } })
    expect(args['phaseModels']).toEqual({ build: { model: 'sol' } })
    // …and the facts the dispatch needs travel with it: the executor group, the build
    // wrapper, and the env knob that carries the model into the subprocess.
    const tiers = args['modelTiers'] as Record<string, Record<string, unknown>>
    expect(tiers['sol']).toMatchObject({
      model_id: 'gpt-5.6-sol',
      group: 'codex',
      build_wrapper: 'trident/codex-build.sh',
      build_env_var: 'CODEX_BUILD_MODEL',
    })
    // The executor list is what unlocks the row at all, and it is DERIVED from the
    // phase table rather than restated in the launcher.
    expect((args['phaseExecutors'] as Record<string, string[]>)['build']).toEqual([
      'claude',
      'codex',
    ])
    // The wrapper's absolute path is threaded, because the workflow script cannot
    // resolve its own location.
    expect(String(args['codexBuildScript'])).toContain('trident/codex-build.sh')
  })

  test('THE DISPATCH ITSELF — forge:build shells into codex-build.sh with the chosen model', async () => {
    const { captured } = await runWorkflow(productionArgs({ build: { model: 'sol' } }))
    const prompt = promptFor(captured, 'forge:build')

    // ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────
    // The model reaches the SUBPROCESS's environment. Nothing else counts: an
    // `agent({model: 'gpt-5.6-sol'})` would be a spawn against an endpoint that has
    // never heard of the id, and a stored setting nothing puts on a command line is a
    // control with no consumer.
    expect(prompt).toContain("CODEX_BUILD_MODEL='gpt-5.6-sol'")
    expect(prompt).toContain('codex-build.sh')
    // The build prompt goes in on STDIN, not as an argv entry — a Forge contract plus
    // a task brief routinely exceeds a comfortable argv, and an E2BIG before codex
    // started would look exactly like a build that failed.
    expect(prompt).toMatch(/bash '[^']*codex-build\.sh' '[^']*' < '[^']*'/)
    // Synchronous and foreground: there is no mechanism to feed an async build back to
    // a headless workflow agent.
    expect(prompt).toContain('do NOT background it')
    // The bridge still owes the workflow a FORGE_SCHEMA result, so the wrapping agent
    // keeps that schema and the contract's last-lines discipline is what it harvests.
    expect(captured.find((c) => c.label === 'forge:build')?.opts['schema']).toBeDefined()
    expect(prompt).toContain('PR_NUMBER=')

    // NEGATIVE CONTROL. The GPT id must NOT have been handed to agent() — that is the
    // precise silent-wrong-model failure the transport field exists to prevent, and it
    // is indistinguishable from success unless asserted.
    expect(captured.find((c) => c.label === 'forge:build')?.opts['model']).not.toBe('gpt-5.6-sol')
  })

  test('a FIX ROUND takes the same executor — the choice is not round-1 only', async () => {
    // Routing only the first attempt to codex would mean the owner's choice applied to
    // the build and silently not to the revisions — the same asymmetry the review
    // retry lanes already exist to avoid. A REQUEST_CHANGES forces a second round.
    const args = productionArgs({ build: { model: 'sol' } })
    const captured: Captured[] = []
    let synth = 0
    const agent = async (prompt: string, o?: Record<string, unknown>): Promise<unknown> => {
      const label = o?.['label'] as string | undefined
      captured.push({ label, prompt, opts: o ?? {} })
      if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
        return {
          prNumber: null,
          branch: 'trident/a-run',
          diffFile: '/tmp/x.diff',
          worktreePath: '/wt',
          // A DIFFERENT sha per round, or the "did this round land" check stops the
          // loop before a second Forge is ever dispatched.
          commitSha: `sha-${captured.length}`,
          testsPassed: true,
        }
      }
      if (label === 'argus:synthesis') {
        synth += 1
        return synth === 1
          ? { verdict: 'REQUEST_CHANGES', findings: [{ severity: 'blocker', title: 'x', evidence: 'y' }] }
          : { verdict: 'APPROVE', findings: [] }
      }
      if (String(label).startsWith('argus:cross-')) {
        return { verdict: 'APPROVE', findings: [], crossStatus: 'connected', crossTruncated: false }
      }
      if (String(label).startsWith('argus:')) return { verdict: 'APPROVE', findings: [] }
      if (String(label).startsWith('head-probe')) return { raw: `sha-${captured.length}`, exit_code: 0 }
      return ''
    }
    const body = SRC.replace('export const meta', 'const meta')
    const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<unknown>
    await AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)(
      agent,
      async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
      (): void => {},
      (): void => {},
      { total: 0, spent: (): number => 0 },
      args,
    )
    const fix = captured.find((c) => String(c.label).startsWith('forge:fix-round-'))
    expect(fix).toBeDefined()
    expect(fix!.prompt).toContain("CODEX_BUILD_MODEL='gpt-5.6-sol'")
    expect(fix!.prompt).toContain('codex-build.sh')
    // …and the fix round still carries the findings it is meant to fix, so routing it
    // through the bridge did not drop the payload.
    expect(fix!.prompt).toContain('ARGUS FINDINGS')
  })

  test('THE CONTROL — an unconfigured build row still runs on Claude, with no bridge', async () => {
    // Without this the two assertions above would pass on a workflow that shelled into
    // codex unconditionally, which is a far worse bug than the one being fixed.
    const { captured } = await runWorkflow(productionArgs(null))
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.prompt).not.toContain('codex-build.sh')
    expect(build.prompt).not.toContain('CODEX_BUILD_MODEL')
    expect(String(build.opts['model'])).toContain('claude-opus')
  })

  test('KIMI IS REFUSED ON THE BUILD ROW, and the log says why', async () => {
    // The honest half of #565. Kimi has a review CLI and NO build wrapper —
    // `grep -ril 'kimi|moonshot' runtime/adapters/` returns nothing while the same
    // grep for `codex` returns the whole codex-cli adapter tree. Offering it would be
    // the exact defect this file exists to prevent, one provider over.
    expect(productionArgs({ build: { model: 'k3' } })['phaseModels']).toBeUndefined()

    // …and the workflow is the backstop for a config that got past the boundary: it
    // keeps the Claude default and LOGS the refusal by name rather than dispatching a
    // wrapper path that resolves to null.
    const args = productionArgs(null)
    args['phaseModels'] = { build: { model: 'k3' } }
    const { captured, logs } = await runWorkflow(args)
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.prompt).not.toContain('codex-build.sh')
    expect(String(build.opts['model'])).toContain('claude-opus')
    expect(
      logs.some((l) => l.includes('IGNORED') && l.includes('phase=build') && l.includes('k3')),
    ).toBe(true)
  })

  test('an unknown tier on the build row falls back to Claude rather than dispatching it', async () => {
    // A value the registry cannot place carries no executor, so "send it anyway" means
    // handing an unplaceable id to whichever wrapper happens to be wired.
    const args = productionArgs(null)
    args['phaseModels'] = { build: { model: 'gpt-5.7-nova' } }
    const { captured, logs } = await runWorkflow(args)
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.prompt).not.toContain('codex-build.sh')
    expect(build.prompt).not.toContain('gpt-5.7-nova')
    expect(String(build.opts['model'])).toContain('claude-opus')
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('unknown-tier'))).toBe(true)
  })

  test('the bridge does not silently rebuild on Claude when the provider is EXHAUSTED', async () => {
    // ISSUES #567's rule, at the build seam. Exit 10/11 (never connected) is a
    // legitimate fallback — an install with no codex credential still gets its build,
    // and the bridge says so. Exit 4 is NOT: quota is a spending decision, and
    // substituting a model the owner did not choose would make it invisible.
    const { captured } = await runWorkflow(productionArgs({ build: { model: 'sol' } }))
    const prompt = promptFor(captured, 'forge:build')
    expect(prompt).toContain('EXIT 10 or 11')
    expect(prompt).toContain('BUILD THE TASK YOURSELF')
    expect(prompt).toContain('EXIT 4')
    expect(prompt).toContain('Do NOT rebuild on Claude and do NOT retry')
  })
})
