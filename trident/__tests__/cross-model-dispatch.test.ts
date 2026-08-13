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

import { SONNET_MODEL, getBestModel } from '@neutronai/runtime/models.ts'

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
  opts: { requestChangesOnce?: boolean } = {},
): Promise<{ captured: Captured[]; logs: string[]; result: Record<string, unknown> }> {
  const captured: Captured[] = []
  const logs: string[] = []
  let synthCount = 0

  const agent = async (prompt: string, o?: Record<string, unknown>): Promise<unknown> => {
    const label = o?.['label'] as string | undefined
    captured.push({ label, prompt, opts: o ?? {} })
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      const built = {
        prNumber: null,
        branch: 'trident/a-run',
        diffFile: '/tmp/x.diff',
        worktreePath: '/wt',
        commitSha: label === 'forge:build' ? 'abc' : 'def',
        testsPassed: true,
      }
      // THE BRIDGE'S SHAPE, not a second happy path. A codex build comes back through
      // `CODEX_FORGE_SCHEMA`, which carries whether the executor ran at all — and the
      // workflow refuses to continue without it. A mock that omitted `codexStatus`
      // would be testing a bridge that dropped it.
      return prompt.includes('CODEX BUILD bridge')
        ? { ...built, codexStatus: 'connected' }
        : built
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      return { verdict: 'APPROVE', findings: [] }
    }
    if (label === 'argus:codex' || label === 'argus:codex-retry') {
      return { verdict: 'APPROVE', findings: [], codexStatus: 'connected', codexTruncated: false }
    }
    if (label === 'argus:kimi' || label === 'argus:kimi-retry') {
      return { verdict: 'APPROVE', findings: [], kimiStatus: 'connected' }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      // One REQUEST_CHANGES first when asked, which is the ONLY way a fix round is
      // dispatched — and a fix round landing on a different executor than round 1 is
      // precisely the drift worth catching.
      return {
        verdict: opts.requestChangesOnce === true && synthCount === 1 ? 'REQUEST_CHANGES' : 'APPROVE',
        findings: [],
      }
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
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Record<string, unknown>
  expect(synthCount).toBeGreaterThan(0)
  return { captured, logs, result }
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
    expect(promptFor(captured, 'argus:codex')).toContain("CODEX_REVIEW_MODEL='gpt-5.6-sol'")
    expect(promptFor(captured, 'argus:kimi')).toContain("KIMI_MODEL='kimi-k3'")
  })

  test('the model is set on the SUBPROCESS, never on the wrapping agent', async () => {
    // `agent({model})` resolves against Claude Code's own endpoint; a GPT id there
    // reaches nothing. The thin bridge agent must therefore carry NO model at all.
    const { captured } = await runWorkflow(productionArgs(null))
    for (const label of ['argus:codex', 'argus:kimi']) {
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
    const stored = { review_codex: { model: 'terra' } }
    // Through the production launcher: if `buildWorkflowArgs` dropped it, or the
    // workflow ignored it, this is the assertion that goes red.
    const args = productionArgs(stored)
    expect(args['phaseModels']).toEqual({ review_codex: { model: 'terra' } })
    const { captured, logs } = await runWorkflow(args)
    const cmd = promptFor(captured, 'argus:codex')
    expect(cmd).toContain("CODEX_REVIEW_MODEL='gpt-5.6-terra'")
    expect(cmd).not.toContain('gpt-5.6-sol')
    // And the run says so, because "did my setting take effect?" must be answerable
    // from the output of a build the owner did not watch.
    expect(logs.some((l) => l.includes('label=argus:codex') && l.includes('gpt-5.6-terra'))).toBe(
      true,
    )
    expect(logs.some((l) => l.includes('label=argus:codex') && l.includes('override=owner'))).toBe(
      true,
    )
    // The OTHER cross-model lane is untouched — one row's choice is one row's choice.
    expect(promptFor(captured, 'argus:kimi')).toContain("KIMI_MODEL='kimi-k3'")
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

describe('THE BUILD RUNS ON CODEX — and stops spending Anthropic when it does', () => {
  /**
   * The reason to move a build off Claude is the Anthropic quota, so "it routes to
   * codex but still pays Anthropic for the build" is a failure even if the build
   * succeeds. These tests therefore assert an ABSENCE as well as a presence, and pair
   * the absence with a positive control on the same label — an absence assertion with
   * no control is the shape that passes because nothing ran.
   */
  const CODEX_BUILD = { build: { model: 'terra' } }

  test('the production launcher carries the choice — the typed boundary accepts it', () => {
    // If `parsePhaseModelConfig` still refused a codex tier on a build row, this is
    // where the chain would break, and every assertion below would be testing a
    // hand-built literal instead of what the composer produces.
    expect(productionArgs(CODEX_BUILD)['phaseModels']).toEqual({ build: { model: 'terra' } })
  })

  test('forge:build dispatches through the codex build wrapper, with the chosen model', async () => {
    const { captured } = await runWorkflow(productionArgs(CODEX_BUILD))
    const cmd = promptFor(captured, 'forge:build')
    // The wrapper, by path, from the repo of record.
    expect(cmd).toContain("bash '/repo/trident/codex-build.sh'")
    // The MODEL on the subprocess's command line — the only place a GPT id can be
    // real. `CODEX_BUILD_MODEL`, not the reviewer's `CODEX_REVIEW_MODEL`: one name
    // for both knobs would let a box that exports one silently steer the other.
    expect(cmd).toContain("CODEX_BUILD_MODEL='gpt-5.6-terra'")
    expect(cmd).not.toContain('CODEX_REVIEW_MODEL=')
    // And the BRIEF travels with it — the same Forge contract the Claude builder
    // gets, so the two executors cannot be building to different rules.
    expect(cmd).toContain('You are FORGE')
    expect(cmd).toContain('do the thing')
  })

  test('NO Anthropic model is requested for the build phase — with a positive control', async () => {
    const onCodex = await runWorkflow(productionArgs(CODEX_BUILD))
    const codexBuild = onCodex.captured.find((c) => c.label === 'forge:build')!
    // `agent({model})` resolves against Claude Code's endpoint. No model on the opts
    // means nothing asked it for a build model, and no effort either — a CLI picks
    // its own.
    expect({ model: codexBuild.opts['model'] ?? null, effort: codexBuild.opts['effort'] ?? null })
      .toEqual({ model: null, effort: null })
    // No Anthropic id anywhere on ANY spawn in the build phase, not just this one.
    const anthropicOnBuild = onCodex.captured
      .filter((c) => String(c.label).startsWith('forge:'))
      .map((c) => c.opts['model'])
      .filter((m) => m !== undefined && m !== null)
    expect(anthropicOnBuild).toEqual([])
    // THE CONTROL. Without the override the very same label DOES carry an Anthropic
    // id, so the emptiness above is caused by the codex route and not by an
    // assertion that can never fail.
    const onClaude = await runWorkflow(productionArgs(null))
    expect(onClaude.captured.find((c) => c.label === 'forge:build')!.opts['model']).toBe(
      getBestModel(),
    )
  })

  test('a task that contains the heredoc terminator cannot break out of it', async () => {
    // Part of the brief is the owner's free-form task text. A line equal to the
    // terminator would close the heredoc early and leave the rest of the brief in
    // the command as SHELL. The marker grows until it provably does not occur.
    const args = productionArgs(CODEX_BUILD)
    const runId = String((args as { runId?: unknown }).runId ?? '')
    expect(runId.length).toBeGreaterThan(0)
    const collide = `NEUTRON_CODEX_BRIEF_EOF_${runId}`
    const { captured } = await runWorkflow({
      ...args,
      task: `build it\n${collide}\nrm -rf /tmp/should-never-run\n`,
    })
    const cmd = promptFor(captured, 'forge:build')
    const chosen = `${collide}_X`
    // The heredoc opens on the GROWN marker, not on the line the task supplied.
    // (Delete the growth loop and this is the assertion that goes red.)
    expect(cmd).toContain(`<<'${chosen}'`)
    expect(cmd).not.toContain(`<<'${collide}'\n`)
    // The colliding line survives INSIDE the brief, as data — it is not stripped,
    // rewritten, or allowed to end the heredoc.
    expect(cmd).toContain(`\n${collide}\nrm -rf /tmp/should-never-run\n`)
    // …and the brief is still closed exactly once, after that line.
    expect(cmd.split(`\n${chosen}\n`).length - 1).toBe(1)
    expect(cmd.indexOf(`\n${collide}\n`)).toBeLessThan(cmd.indexOf(`\n${chosen}\n`))
  })

  test('the bridge is told not to build, so the phase cannot leak back onto Claude', async () => {
    // The workflow runtime hands this script `agent()` and nothing else, so a
    // subprocess is only reachable through a thin Claude agent — the same shape the
    // codex REVIEW seat has had all along. That agent's whole job is to run one
    // command and copy six measured values; an agent that decided to finish the build
    // itself would put the expensive phase straight back on Anthropic.
    const { captured } = await runWorkflow(productionArgs(CODEX_BUILD))
    const cmd = promptFor(captured, 'forge:build')
    expect(cmd).toContain('DO NOT BUILD ANYTHING YOURSELF')
  })

  test('every FIX round lands on the same executor as round 1', async () => {
    const { captured } = await runWorkflow(productionArgs(CODEX_BUILD), {
      requestChangesOnce: true,
    })
    const fix = captured.find((c) => c.label === 'forge:fix-round-2')
    expect(fix).toBeDefined()
    expect(fix!.prompt).toContain("bash '/repo/trident/codex-build.sh'")
    expect(fix!.opts['model'] ?? null).toBeNull()
    // …and it is still a FIX: the findings and the re-entry contract reached codex.
    expect(fix!.prompt).toContain('You are FIXING')
  })

  test('the downstream contract survives: the measured sha becomes `reviewedHead`', async () => {
    // The merge pins to `reviewedHead` (#545) and refuses when it is empty, so a
    // codex build that could not report a pushed sha the way a Claude build does
    // would fail every merge. The bridge copies it out of the wrapper's measured
    // trailer, and it has to arrive here unchanged.
    const { result } = await runWorkflow(productionArgs(CODEX_BUILD))
    expect(result['reviewedHead']).toBe('abc')
    expect(result['branch']).toBe('trident/a-run')
    expect(result['verdict']).toBe('APPROVE')
  })

  test('the bridge reads the PUSHED sha in pr mode and the local one otherwise', async () => {
    // Two different questions, and pinning a merge to the wrong one certifies a
    // commit no reviewer or merge will ever see. `productionArgs` is local-mode.
    const local = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    expect(local).toContain('NEUTRON_CODEX_BUILD_HEAD=')
    expect(local).toContain('local mode has no remote')

    const prArgs = { ...productionArgs(CODEX_BUILD), mergeMode: 'pr' }
    const pr = promptFor((await runWorkflow(prArgs)).captured, 'forge:build')
    expect(pr).toContain('NEUTRON_CODEX_BUILD_REMOTE_HEAD=')
    expect(pr).toContain("the build's own commit, confirmed pushed")
  })

  test('the trailer is read from ITS OWN FILE, never from the codex transcript', async () => {
    // The transcript is model-controlled text. When the wrapper printed its trailer to
    // the same stdout and the bridge was shown the last N lines of it, a build that
    // narrated `NEUTRON_CODEX_BUILD_HEAD=<sha>` put a second, fabricated trailer in the
    // reader's window with no rule about which one won. The command must therefore
    // hand the wrapper a trailer path and read THAT back.
    const prompt = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    const trailerFile = '/tmp/trident-codex-build-run-1-r1.trailer'
    expect(prompt).toContain(`NEUTRON_CODEX_BUILD_TRAILER_FILE='${trailerFile}'`)
    expect(prompt).toContain(`cat '${trailerFile}'`)
    // The transcript is NOT tailed into the window as the source of the six values.
    expect(prompt).not.toContain('tail -n 12')
    // …and the bridge is told in words to disregard trailer-shaped lines in it.
    expect(prompt).toContain('you must ignore them entirely')

    // POSITIVE CONTROL: the assertions above can distinguish the two files. The .out
    // path IS in the prompt (the bridge still reads stderr/stdout for diagnosis), so
    // "not tailed" is a statement about how it is used, not about it being absent.
    expect(prompt).toContain('/tmp/trident-codex-build-run-1-r1.out')
    expect(trailerFile).not.toBe('/tmp/trident-codex-build-run-1-r1.out')
  })

  test('the brief gives the codex builder ONE diff path, and it is the measured one', async () => {
    // The Forge contract's step 5 names an example path; the wrapper only ever looks at
    // `NEUTRON_CODEX_BUILD_DIFF_FILE`. Two live instructions in one brief meant a build
    // that followed the wrong one handed the review panel an empty path.
    const prompt = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    const measured = '/tmp/trident-codex-build-run-1.diff'
    expect(prompt).toContain(`NEUTRON_CODEX_BUILD_DIFF_FILE='${measured}'`)
    expect(prompt).toContain(`this REPLACES it: write the branch diff to EXACTLY ${measured}`)
    // Step 5's own example is still in the brief (both builders read one text), so the
    // coda has to say out loud that it supersedes it — which the line above does.
    expect(prompt).toContain('/tmp/trident-a-run.diff')
    expect(prompt).toContain('REPLACES steps 5 and 6 above')
  })

  test('a build lane that never ran STOPS the run instead of falling back to Claude', async () => {
    // The failure mode this route must not have: codex is unreachable, the workflow
    // quietly re-Forges on Opus, and the owner discovers the quota was spent anyway —
    // with nothing in the output saying so.
    const args = productionArgs(CODEX_BUILD)
    const captured: Captured[] = []
    const logs: string[] = []
    const agent = async (prompt: string, o?: Record<string, unknown>): Promise<unknown> => {
      captured.push({ label: o?.['label'] as string | undefined, prompt, opts: o ?? {} })
      if (o?.['label'] === 'forge:build') {
        return {
          prNumber: null,
          branch: '',
          diffFile: '',
          worktreePath: '',
          commitSha: '',
          testsPassed: false,
          codexStatus: 'not_connected',
        }
      }
      return ''
    }
    const body = SRC.replace('export const meta', 'const meta')
    const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {})
      .constructor as (...a: string[]) => (...a: unknown[]) => Promise<unknown>
    const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
    const result = (await fn(
      agent,
      async (fns: Array<() => Promise<unknown>>) => Promise.all(fns.map((f) => f())),
      () => {},
      (line: unknown) => {
        logs.push(String(line))
      },
      { total: 0, spent: () => 0 },
      args,
    )) as Record<string, unknown>

    expect(result['ok']).toBe(false)
    expect(result['checkpoint']).toBe('inner-error')
    // The run SAYS which lane failed and why. "The build did not happen" and "the
    // build produced bad code" are opposite situations and the operator has to be
    // able to tell them apart from the output of a run nobody watched.
    expect(
      logs.some((l) => l.includes('codexStatus=not_connected') && l.includes('forge:build')),
    ).toBe(true)
    // NO reviewer was paid to read an unbuilt branch, and nothing re-Forged on Claude.
    expect(captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
    expect(captured.filter((c) => String(c.label).startsWith('forge:fix-round-'))).toEqual([])
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
    expect(productionArgs({ review_codex: { model: 'gpt-5.7-nova' } })['phaseModels']).toBeUndefined()

    const { captured, logs } = await runWorkflow(past({ review_codex: { model: 'gpt-5.7-nova' } }))
    // FALLS BACK, never dispatches the unknown id: a value the registry cannot place
    // carries no transport, so "send it anyway" means handing it to whichever
    // executor happens to be wired.
    const cmd = promptFor(captured, 'argus:codex')
    expect(cmd).toContain("CODEX_REVIEW_MODEL='gpt-5.6-sol'")
    expect(cmd).not.toContain('gpt-5.7-nova')
    expect(
      logs.some((l) => l.includes('IGNORED') && l.includes('unknown-tier') && l.includes('gpt-5.7-nova')),
    ).toBe(true)
  })

  test('a tier from an executor this step cannot reach is refused, not handed to agent()', async () => {
    // `k3` is the Kimi CLI's tier. The build step has TWO executors now (Claude and
    // codex) and Kimi is neither, so the override is dropped rather than handed to
    // `agent({model: 'kimi-k3'})` — a spawn against an endpoint that has never heard
    // of it.
    expect(productionArgs({ build: { model: 'k3' } })['phaseModels']).toBeUndefined()

    const { captured, logs } = await runWorkflow(past({ build: { model: 'k3' } }))
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.opts['model']).not.toBe('kimi-k3')
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('executor-mismatch'))).toBe(true)
  })

  test('an effort on a CLI lane is refused rather than stored into a dispatch nothing reads', async () => {
    expect(productionArgs({ review_codex: { effort: 'max' } })['phaseModels']).toBeUndefined()

    const { logs } = await runWorkflow(past({ review_codex: { effort: 'max' } }))
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('effort-not-settable'))).toBe(true)
  })
})
