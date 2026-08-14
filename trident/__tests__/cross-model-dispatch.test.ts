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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
  runOverrides: Record<string, unknown> = {},
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
      ...runOverrides,
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
  opts: {
    requestChangesOnce?: boolean
    complexity?: 'mechanical' | 'reasoning'
    /** Round 1 comes back with these instead of a sha + a diff path. */
    buildProduces?: { commitSha?: string; diffFile?: string }
    /**
     * What a FIX round reports, when it must differ from round 1's healthy shape.
     * Round 1 still succeeds, so the run reaches the fix loop and the gates there are
     * the ones under test.
     */
    fixProduces?: { commitSha?: string; diffFile?: string }
    /** The PR number round 1 reports. Default null (the local-mode shape). */
    buildPr?: number
    /** The branch the build reports having committed on. Default the run's own. */
    buildBranch?: string
    /** Ralph's planner says this many tasks remain AFTER the one being built. */
    remainingTasks?: number
    /**
     * Make the branch-head probe report a MOVED head, so `roundLanded` passes and the
     * fix round reaches the gates that come after it. Default (unset) reports no head,
     * which is byte-identical to the stub's previous fall-through and keeps every
     * existing case unchanged.
     */
    fixLands?: boolean
    /** Make the codex-backed adversarial core seat fail closed. */
    deferredAdversarial?: boolean
    /** Simulate a wrapper death before either trailer-writing branch. */
    missingBuildTrailer?: boolean
    /** The preserved build worktree contains changes after that death. */
    preservedBuildWork?: boolean
  } = {},
): Promise<{ captured: Captured[]; logs: string[]; result: Record<string, unknown> }> {
  const captured: Captured[] = []
  const logs: string[] = []
  let synthCount = 0

  const agent = async (prompt: string, o?: Record<string, unknown>): Promise<unknown> => {
    const label = o?.['label'] as string | undefined
    captured.push({ label, prompt, opts: o ?? {} })
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      const empty = opts.buildProduces !== undefined && label === 'forge:build'
      const isFix = String(label).startsWith('forge:fix-round-')
      const fixEmpty = opts.fixProduces !== undefined && isFix
      const built = {
        prNumber: opts.buildPr ?? null,
        branch: opts.buildBranch ?? 'trident/a-run',
        // A build that ran and produced NOTHING is the wrapper's honest answer, not a
        // malformed one: it measures with git and emits EMPTY rather than wrong.
        diffFile: empty
          ? (opts.buildProduces?.diffFile ?? '')
          : fixEmpty
            ? (opts.fixProduces?.diffFile ?? '')
            : '/tmp/x.diff',
        worktreePath: '/wt',
        commitSha: empty
          ? (opts.buildProduces?.commitSha ?? '')
          : fixEmpty
            ? (opts.fixProduces?.commitSha ?? 'def')
            : label === 'forge:build'
              ? 'abc'
              : 'def',
        testsPassed: true,
      }
      // THE BRIDGE'S SHAPE, not a second happy path. A codex build comes back through
      // `CODEX_FORGE_SCHEMA`, which carries whether the executor ran at all — and the
      // workflow refuses to continue without it. A mock that omitted `codexStatus`
      // would be testing a bridge that dropped it.
      return prompt.includes('CODEX BUILD bridge')
        ? {
            ...built,
            codexStatus: opts.missingBuildTrailer === true ? 'deferred' : 'connected',
            trailerComplete: opts.missingBuildTrailer !== true,
            wrapperExitCode: opts.missingBuildTrailer === true ? 143 : 0,
            preservedWork: opts.preservedBuildWork === true,
          }
        : built
    }
    if (String(label).startsWith('head-probe-round-')) {
      // A head DIFFERENT from round 1's `abc`, so `roundLanded` sees the branch move.
      return { head: opts.fixLands === true ? 'fed' : '' }
    }
    if (label === 'plan:fable') {
      // Ralph's planner. `complexity` is the field that splits the build dispatch
      // into `build` and `build_mechanical`, which is the whole point of the test
      // that asks for it.
      return {
        implementationPlan: '- [ ] the one task\n',
        topTask: 'the one task',
        executionSpec: 'TARGET FILES: x\nACCEPTANCE CRITERION: y\nTEST PLAN: z',
        complexity: opts.complexity ?? 'reasoning',
        remainingTasks: opts.remainingTasks ?? 0,
      }
    }
    if (label === 'argus:adversarial' && prompt.includes('CODEX ADVERSARIAL REVIEW bridge')) {
      return opts.deferredAdversarial === true
        ? { verdict: 'REQUEST_CHANGES', findings: [], codexStatus: 'deferred', codexTruncated: false }
        : { verdict: 'APPROVE', findings: [], codexStatus: 'connected', codexTruncated: false }
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
  // Every healthy run reaches synthesis, so a workflow that silently stopped early
  // cannot pass a test by dispatching nothing. `buildProduces` is the one case that
  // is SUPPOSED to stop before the panel, and it asserts that itself.
  if (
    args.mergeMode !== 'pr' &&
    opts.buildProduces === undefined &&
    opts.remainingTasks === undefined &&
    opts.buildBranch === undefined &&
    opts.missingBuildTrailer !== true
  ) {
    expect(synthCount).toBeGreaterThan(0)
  }
  return { captured, logs, result }
}

/**
 * ONE CHUNK CALL of the brief transport, parsed back out of the bridge prompt.
 *
 * The brief no longer travels as a single heredoc: run `000cedc8` proved a model
 * cannot retype 26 KB verbatim (it wrote 24,524 bytes, twice, identically), so it now
 * goes in bounded pieces — one Bash call each, `>` on the first and `>>` after. The
 * assertions below still speak about the FILE, so they have to reassemble it the way
 * the bridge's shell would.
 */
type BriefCall = { redirect: '>' | '>>'; payload: string; marker: string | null }

/**
 * Reassemble the brief the chunk calls write, byte for byte.
 *
 * `payload` is what the shell would append: a heredoc emits its body (each line plus
 * its newline) and `printf '%s'` emits its argument and nothing else. Anything that
 * does not parse is an error rather than a skip — a block silently ignored here is a
 * dropped chunk that the receipt assertions would then happily "confirm".
 */
const briefCalls = (cmd: string): BriefCall[] => {
  const parts = cmd.split(/^CALL (\d+) of (\d+):\n/m)
  const calls: BriefCall[] = []
  for (let i = 1; i + 2 < parts.length; i += 3) {
    // The block runs to the next CALL header, or to the run command that follows the
    // last one.
    const body = String(parts[i + 2]).split('\n\nTHEN run this ONE command:')[0]!.replace(/\n+$/, '')
    const here = /^cat (>>?) '([^']*)' <<'([^']+)'\n/.exec(body)
    if (here !== null) {
      const marker = here[3]!
      const rest = body.slice(here[0].length)
      if (!rest.endsWith(`\n${marker}`) && rest !== marker) {
        throw new Error(`chunk ${(i + 2) / 3} does not close on its marker`)
      }
      calls.push({
        redirect: here[1] as '>' | '>>',
        payload: rest === marker ? '' : rest.slice(0, rest.length - marker.length),
        marker,
      })
      continue
    }
    const raw = /^printf '%s' '([\s\S]*)' (>>?) '([^']*)'$/.exec(body)
    if (raw === null) throw new Error(`unparseable brief chunk: ${body.slice(0, 80)}`)
    calls.push({
      redirect: raw[2] as '>' | '>>',
      // `shSingleQuote`'s only escape, undone.
      payload: raw[1]!.replaceAll("'\\''", "'"),
      marker: null,
    })
  }
  if (calls.length === 0) throw new Error('the bridge prompt carried no brief chunk calls')
  return calls
}

/** The bytes on disk once every call has run, in order. */
const assembledBrief = (cmd: string): string => briefCalls(cmd).reduce((s, c) => s + c.payload, '')

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

  test('the KIMI lane is left exactly as it was — the build move did not touch it', async () => {
    // Kimi is OUT OF SCOPE for this change, and "out of scope" has to be visible in the
    // dispatch and not just in a commit message: the seat runs, on its own tier, through
    // its own wrapper, with the model threaded exactly the way it was before the build
    // moved to codex.
    const { captured, logs } = await runWorkflow(productionArgs(null))
    const cmd = promptFor(captured, 'argus:kimi')
    expect(cmd).toContain('kimi-review-cli.ts')
    expect(cmd).toContain("KIMI_MODEL='kimi-k3'")
    // …and the tally still attributes the seat to Kimi. Losing the route would fall
    // through to the unknown-label default and log an Anthropic id for a Kimi
    // subprocess — mis-attributing spend in the ledger this whole lane exists to keep
    // honest.
    expect(
      logs.some(
        (l) =>
          l.includes('label=argus:kimi') &&
          l.includes('model=kimi-k3') &&
          l.includes('phase=review_kimi'),
      ),
    ).toBe(true)
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
    expect(promptFor(captured, 'argus:kimi')).not.toContain('gpt-5.6-terra')
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

describe('THE ADVERSARIAL SEAT RUNS ON CODEX WITHOUT LOSING ITS CONTRACT', () => {
  const TARGET = {
    build: { model: 'sol' },
    review_adversarial: { model: 'terra' },
    review_rubric: { model: 'opus' },
    decomposition: { model: 'fable' },
    synthesis: { model: 'fable' },
  }

  test('the subprocess receives the adversarial rubric and no Anthropic model is requested', async () => {
    const { captured } = await runWorkflow(productionArgs(TARGET, { ralph: true }))
    const seat = captured.find((c) => c.label === 'argus:adversarial')!
    expect(seat.prompt).toContain("CODEX_REVIEW_MODEL='gpt-5.6-terra'")
    expect(seat.prompt).toContain('NEUTRON_CODEX_REVIEW_RUBRIC=')
    expect(seat.prompt).toContain('Independently try to REFUTE the change')
    expect(seat.prompt).toContain('Do not substitute the generic second-opinion rubric')
    expect({ model: seat.opts['model'] ?? null, effort: seat.opts['effort'] ?? null }).toEqual({
      model: null,
      effort: null,
    })

    const anthropicLabels = captured
      .filter((c) => c.opts['model'] !== undefined && c.opts['model'] !== null)
      .map((c) => c.label)
      .filter((label): label is string => label !== undefined)
    expect(anthropicLabels).toEqual([
      'plan:fable',
      'argus:claude',
      'argus:synthesis',
      'cleanup:worktree',
    ])
  })

  test('a deferred codex adversarial core seat cannot yield APPROVE', async () => {
    const { result } = await runWorkflow(productionArgs(TARGET, { ralph: true }), {
      deferredAdversarial: true,
    })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    expect(result['blockKind']).toBe('infra-only')
  })
})

describe('THE BUILD RUNS ON CODEX — no Anthropic model is requested for the phase', () => {
  /**
   * The reason to move a build off Claude is the Anthropic quota, so "it routes to
   * codex but still pays Anthropic for the build" is a failure even if the build
   * succeeds. These tests therefore assert an ABSENCE as well as a presence, and pair
   * the absence with a positive control on the same label — an absence assertion with
   * no control is the shape that passes because nothing ran.
   *
   * WHAT THIS DOES NOT CLAIM, said plainly because the describe used to overclaim it:
   * the phase does not reach ZERO Anthropic tokens. A workflow step has no way to
   * reach a shell except through `agent()`, so a thin Claude bridge is still spawned
   * to run one command and copy six measured values, and it runs on the launcher's own
   * default model. What moves off Anthropic is the BUILD — the reading, the editing,
   * the test loop, which is essentially all of the phase's tokens. The bridge's prompt
   * is the command string plus a "do not build anything yourself" instruction, and
   * `the bridge is told not to build` below is what holds that line.
   */
  const CODEX_BUILD = { build: { model: 'terra' } }

  test('the detached wrapper outlives the Bash-call bound that used to kill it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-codex-detach-'))
    const marker = join(dir, 'completed')
    try {
      // Scaled reproduction of the real mechanism: the foreground caller is killed
      // at 50ms, before the 250ms build finishes. `nohup` + backgrounding severs the
      // wrapper from that caller, exactly as the generated production command does.
      spawnSync(
        'bash',
        ['-c', `nohup sh -c 'sleep 0.25; printf done > "$1"' _ '${marker}' </dev/null >/dev/null 2>&1 & wait`],
        { timeout: 50 },
      )
      await Bun.sleep(400)
      expect(readFileSync(marker, 'utf8')).toBe('done')

      const prompt = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
      expect(prompt).toContain('600-second per-call ceiling')
      expect(prompt).toContain('nohup setsid ')
      expect(prompt).toContain('540 seconds')
      expect(prompt).toContain('45 minutes total')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an absent completion trailer is DEFERRED and names the killed wrapper artifacts', async () => {
    const { result, logs, captured } = await runWorkflow(productionArgs(CODEX_BUILD), {
      missingBuildTrailer: true,
    })
    expect(result['ok']).toBe(false)
    expect(result['checkpoint']).toBe('inner-error')
    const terminal = logs.find((line) => line.includes('inner THREW')) ?? ''
    expect(terminal).toContain('DEFERRED: the build wrapper was killed before it could report')
    expect(terminal).toContain('/tmp/trident-codex-build-run-1-r1.trailer')
    expect(terminal).toContain('/tmp/trident-codex-build-run-1-r1.err')
    expect(terminal).toContain('preserved worktree')
    expect(terminal).not.toContain('produced no')
    expect(captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
  })

  test('the terminal result says when the preserved worktree holds uncommitted work', async () => {
    const { logs } = await runWorkflow(productionArgs(CODEX_BUILD), {
      missingBuildTrailer: true,
      preservedBuildWork: true,
    })
    expect(logs.find((line) => line.includes('inner THREW'))).toContain(
      'preserved worktree, which holds uncommitted work',
    )
  })

  test('completed failed and ok trailers retain their existing result paths', async () => {
    const prompt = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    expect(prompt).toContain("test -s '/tmp/trident-codex-build-run-1-r1.trailer'")
    expect(prompt).toContain("EXIT 3 or 5 (any other reason) → codexStatus='deferred'")
    const healthy = await runWorkflow(productionArgs(CODEX_BUILD))
    expect(healthy.result['ok']).toBe(true)
    expect(healthy.captured.filter((c) => String(c.label).startsWith('argus:')).length).toBeGreaterThan(0)
  })

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

  test('a task that contains a heredoc terminator cannot break out of it', async () => {
    // Part of the brief is the owner's free-form task text. A line equal to a chunk's
    // terminator would close that heredoc early and leave the REST OF THE CHUNK in the
    // command as SHELL. Both the run-scoped base marker and the per-chunk marker grow
    // until they provably do not occur, so the task supplies BOTH names to attack.
    const args = productionArgs(CODEX_BUILD)
    const runId = String((args as { runId?: unknown }).runId ?? '')
    expect(runId.length).toBeGreaterThan(0)
    const base = `NEUTRON_CODEX_BRIEF_EOF_${runId}`
    const perChunk = `${base}_P1`
    const { captured } = await runWorkflow({
      ...args,
      task: `build it\n${base}\n${perChunk}\nrm -rf /tmp/should-never-run\n`,
    })
    const cmd = promptFor(captured, 'forge:build')
    const calls = briefCalls(cmd)
    // NO HEREDOC CONTAINS ITS OWN TERMINATOR AS A LINE. This is the whole property, and
    // it holds per chunk — delete either growth loop and the chunk carrying the task
    // text opens on a marker its payload also contains, and this goes red.
    for (const call of calls) {
      if (call.marker === null) continue
      expect(call.payload.split('\n')).not.toContain(call.marker)
    }
    // Neither attacked name is ever used as an opener.
    expect(cmd).not.toContain(`<<'${base}'\n`)
    expect(cmd).not.toContain(`<<'${perChunk}'\n`)
    // The colliding lines survive INSIDE the brief, as data — not stripped, not
    // rewritten, not allowed to end a chunk.
    expect(assembledBrief(cmd)).toContain(`\n${base}\n${perChunk}\nrm -rf /tmp/should-never-run\n`)
    // …and each chunk is still closed exactly once, on its own marker.
    for (const call of calls) {
      if (call.marker === null) continue
      expect(cmd.split(`\n${call.marker}\n`).length - 1).toBe(1)
    }
  })

  test('the bridge is given a launcher prompt, not a build brief — and told so', async () => {
    // WHAT THIS TEST CAN AND CANNOT SHOW, since the name used to overclaim it. The
    // workflow runtime hands this script `agent()` and nothing else, so a subprocess
    // is only reachable through a thin Claude agent. Nothing at runtime can stop that
    // agent from editing a file — it holds the same tools in the same worktree. What
    // is checkable, and checked here, is that it is given no reason or material to:
    // the instruction is explicit, the prompt carries no build contract of its own,
    // and every value it may report comes from a file the wrapper wrote.
    const { captured } = await runWorkflow(productionArgs(CODEX_BUILD))
    const build = captured.find((c) => c.label === 'forge:build')!
    const cmd = build.prompt
    expect(cmd).toContain('DO NOT BUILD ANYTHING YOURSELF')
    expect(cmd).toContain('Do not edit a file, do not run the tests, do not commit')
    // The bridge's OWN task is a copy and then one command. The build contract exists
    // in the prompt only as chunk payload addressed to codex — never as an instruction
    // to the agent reading it — so what surrounds it must say copy-then-launch, not
    // build.
    expect(cmd).toContain('SEPARATE Bash call(s), in the order given')
    expect(cmd).toContain('THEN run this ONE command:')
    expect(cmd).toContain('YOUR job is to launch it')
    // The six values are read from the WRAPPER'S trailer file, and the transcript is
    // named as a non-source. A bridge that built something itself still has nowhere to
    // report it from: every field it may fill names that file.
    expect(cmd).toContain('COPY THOSE SIX VALUES VERBATIM')
    expect(cmd).toContain('is NOT a source for any of them')
    // And it is handed NO Anthropic build model or effort — the phase's tokens are
    // not budgeted here (the positive control lives in the test above).
    expect({ model: build.opts['model'] ?? null, effort: build.opts['effort'] ?? null }).toEqual({
      model: null,
      effort: null,
    })
  })

  test('the brief travels with a RECEIPT, so a bridge that mangles it cannot build', async () => {
    // The one part of this route that an LLM has to reproduce byte-for-byte. A bridge
    // that truncates or paraphrases the brief hands codex a contract nobody wrote, and
    // every check after that point asks about the repository — it would come back with
    // a real sha, a real diff and a real PR for the wrong task.
    //
    // A REAL-SIZED TASK, deliberately: the brief that broke run `000cedc8` was 26,183
    // bytes, and a one-chunk brief would leave every multi-chunk assertion below
    // vacuously true — which is the shape of test this very change was rejected for
    // once already.
    const { captured } = await runWorkflow({
      ...productionArgs(CODEX_BUILD),
      task: Array.from({ length: 400 }, (_, i) => `requirement ${i} — a line of the contract`).join(
        '\n',
      ),
    })
    const cmd = promptFor(captured, 'forge:build')
    const receipt = /NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY='(\d+):([0-9a-f]{8})'/.exec(cmd)
    expect(receipt).not.toBeNull()
    // IT DESCRIBES THE BYTES THE CHUNK CALLS ACTUALLY WRITE, not some other string, and
    // it is ONE receipt over the ASSEMBLED file — which is what makes a dropped,
    // duplicated or reordered chunk a refusal rather than a silent short build. Pull
    // every payload back out of the command, join them in order, and measure the way
    // the wrapper does.
    const calls = briefCalls(cmd)
    expect(calls.length).toBeGreaterThan(1)
    const written = assembledBrief(cmd)
    expect(Buffer.byteLength(written, 'utf8')).toBe(Number(receipt![1]))
    // Chunk 1 TRUNCATES and the rest APPEND, so a re-run from call 1 cannot inherit
    // half of a previous attempt.
    expect(calls.map((c) => c.redirect)).toEqual(calls.map((_, i) => (i === 0 ? '>' : '>>')))
    // Dropping the last chunk is exactly the failure that stopped the pipeline, and the
    // receipt is what has to catch it: the short file measures differently.
    const short = calls.slice(0, -1).reduce((s, c) => s + c.payload, '')
    expect(Buffer.byteLength(short, 'utf8')).not.toBe(Number(receipt![1]))
    // Every piece is small enough that a model can actually copy it — the transport's
    // whole reason for existing. The bound is the shipped constant, read from source.
    const limit = Number(
      /const CODEX_BRIEF_CHUNK_BYTES = (\d+)/.exec(
        readFileSync(fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)), 'utf8'),
      )![1],
    )
    for (const c of calls) expect(Buffer.byteLength(c.payload, 'utf8')).toBeLessThanOrEqual(limit)
    // Non-trivially long: a receipt for an empty brief would satisfy the equality
    // above and mean nothing.
    expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(1000)
    expect(written).toContain('You are FORGE')
    // The bridge is TOLD the check exists, so a model inclined to tidy the block has a
    // reason not to.
    expect(cmd).toContain('REFUSES to build (exit 3)')
    // …AND IT IS TOLD TO TRY EXACTLY ONCE MORE. Reproducing kilobytes verbatim is still
    // a model doing a copy, so a corrupt receipt is a real failure rate — and with no
    // retry it is terminal: deferred, a throw, and an already-built, already-reviewed
    // branch thrown away over a copying wobble. It is also the ONE failure here that is
    // cheap and knowably transient, because the wrapper refuses BEFORE spending a
    // token. The cap matters as much as the retry: a model that produced the same wrong
    // copy twice will produce it a third time, and fail-closed is the right end state.
    expect(cmd).toContain('CODEX_BUILD_BRIEF_CORRUPT')
    // …AND THE RETRY IS ALL THE CALLS FROM CALL 1, never a repair of the piece the
    // model thinks went wrong: only a full re-run starts from the truncating `>`, and
    // only the whole file is measured.
    expect(cmd).toContain(`RE-RUN ALL ${calls.length} CHUNK CALL(S) FROM CALL 1`)
    expect(cmd).toContain('Exactly ONE retry')
    // A DIFFERENT brief gets a DIFFERENT receipt — the value is a function of the
    // text, not a constant that happens to match.
    const other = await runWorkflow({ ...productionArgs(CODEX_BUILD), task: 'build something else' })
    const otherReceipt = /NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY='([^']+)'/.exec(
      promptFor(other.captured, 'forge:build'),
    )![1]
    expect(otherReceipt).not.toBe(`${receipt![1]}:${receipt![2]}`)
  })

  test('a build reported on the WRONG BRANCH stops the run instead of being reviewed', async () => {
    // The wrapper already blanks the sha when it measures the wrong branch; this is
    // the workflow half, and it is what makes the reported branch load-bearing rather
    // than decorative. In local mode the failure it prevents is silent: the reviewers
    // read a real diff, `git merge --no-ff <branch>` then lands nothing, and the
    // branch that held the work is deleted straight afterwards.
    const { result, captured, logs } = await runWorkflow(productionArgs(CODEX_BUILD), {
      buildBranch: 'trident/some-other-branch',
    })
    expect(result['ok']).toBe(false)
    expect(logs.some((l) => l.includes('trident/some-other-branch'))).toBe(true)
    // No reviewer was paid to read a diff the merge cannot land.
    expect(captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
  })

  test('a Ralph task tagged [mechanical] goes to codex too — one row, both build phases', async () => {
    // THE SECOND BUILD PHASE. `modelForTag` splits the forge dispatch by the planner's
    // complexity tag, so a Ralph iteration tagged `mechanical` resolves the separate
    // `build_mechanical` phase key — which the owner never sees and never sets. Read
    // literally, that key has no override, so it kept dispatching Sonnet on Anthropic
    // for exactly the tasks a codex build was moved off Claude to cover.
    const ralphArgs = productionArgs(CODEX_BUILD, { ralph: true })
    expect(ralphArgs['ralph']).toBe(true)
    const { captured } = await runWorkflow(ralphArgs, { complexity: 'mechanical' })
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.prompt).toContain("bash '/repo/trident/codex-build.sh'")
    expect(build.prompt).toContain("CODEX_BUILD_MODEL='gpt-5.6-terra'")
    expect(build.opts['model'] ?? null).toBeNull()
    // …and the run SAYS the owner's setting reached this phase. A mirrored override
    // that logged `phase=build_mechanical` with no `override=owner` would leave the
    // one honest answer to "did my setting take effect?" reading like a no.
    const { logs } = await runWorkflow(ralphArgs, { complexity: 'mechanical' })
    expect(
      logs.some((l) => l.includes('phase=build_mechanical') && l.includes('override=owner')),
    ).toBe(true)

    // THE CONTROL, on the same ralph+mechanical path: with no override the very same
    // dispatch carries Sonnet, so the assertions above are caused by the mirroring
    // and not by a mechanical route that never ran.
    const plain = await runWorkflow(productionArgs(null, { ralph: true }), {
      complexity: 'mechanical',
    })
    expect(plain.captured.find((c) => c.label === 'forge:build')!.opts['model']).toBe(SONNET_MODEL)
    expect(plain.logs.some((l) => l.includes('override=owner'))).toBe(false)
  })

  test('a stored build_mechanical entry cannot hold the mechanical build on Claude', async () => {
    // THE ROW THAT DOES NOT EXIST CANNOT OUTVOTE THE ONE THAT DOES. `build_mechanical`
    // is never rendered, so a value stored against it — by an older build, or by hand
    // — is one the owner can neither see nor clear. Honouring it kept every
    // `[mechanical]` task on Anthropic after Build was moved to codex, with the pane
    // showing the codex tier and nothing anywhere admitting the difference.
    //
    // TWO LAYERS, asserted separately because either alone would leave a hole.
    // First: the typed boundary drops the key, so the production launcher never
    // forwards it.
    const args = productionArgs({
      build: { model: 'terra' },
      build_mechanical: { model: 'sonnet', effort: 'low' },
    })
    expect(args['phaseModels']).toEqual({ build: { model: 'terra' } })

    // Second: even handed the key directly — a blob threaded by something that skipped
    // validation — the workflow ignores it and mirrors `build`.
    const { captured } = await runWorkflow(
      {
        ...productionArgs({ build: { model: 'terra' } }, { ralph: true }),
        phaseModels: { build: { model: 'terra' }, build_mechanical: { model: 'sonnet', effort: 'low' } },
      },
      { complexity: 'mechanical' },
    )
    const build = captured.find((c) => c.label === 'forge:build')!
    expect(build.prompt).toContain("bash '/repo/trident/codex-build.sh'")
    expect(build.prompt).toContain("CODEX_BUILD_MODEL='gpt-5.6-terra'")
    // No Anthropic model, and no effort from the ignored entry, on the wrapping agent.
    expect({ model: build.opts['model'] ?? null, effort: build.opts['effort'] ?? null }).toEqual({
      model: null,
      effort: null,
    })
    // The CONTROL that keeps the assertion honest: SONNET_MODEL is what this dispatch
    // carries when nothing moved it, so "no Anthropic model" above is a real absence.
    const plain = await runWorkflow(productionArgs(null, { ralph: true }), {
      complexity: 'mechanical',
    })
    expect(plain.captured.find((c) => c.label === 'forge:build')!.opts['model']).toBe(SONNET_MODEL)
  })

  test('a FIX round lands on the same executor as round 1', async () => {
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

  test('a fix round that LANDED but produced no diff stops instead of opening a panel', async () => {
    // ROUND 1 REFUSES TO REVIEW AN EMPTY DIFF; every later round used to review one
    // happily. The codex wrapper DELETES the diff path before each launch so a stale
    // diff can never be reported as this round's, and regenerates one only when the
    // build committed — so a fix round whose regeneration produced nothing leaves the
    // path absent, and the panel was dispatched at it with no gate at all. Five
    // reviewers reading a missing file and reporting nothing wrong with it is an
    // APPROVE of a diff no one saw.
    const { result, captured } = await runWorkflow(productionArgs(CODEX_BUILD), {
      requestChangesOnce: true,
      fixLands: true,
      fixProduces: { commitSha: 'def', diffFile: '' },
    })
    // NOT 'code' — the code was never re-judged, so reporting a code rejection would
    // be a verdict about a diff nobody read.
    expect(result['blockKind']).toBe('round-lost')
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    const findings = result['findings'] as Array<{ title: string; evidence: string }>
    expect(findings).toHaveLength(1)
    expect(findings[0]!.title).toContain('landed on the branch but produced no diff')
    // …and it says the work is SAFE, because it is: `roundLanded` just confirmed the
    // commit is on the branch. Telling the operator to recover a worktree would send
    // them after something that is not missing.
    expect(findings[0]!.evidence).toContain('not lost')
    // THE PANEL WAS NEVER PAID. Round 1's reviewers ran; round 2's did not.
    expect(captured.filter((c) => c.label === 'argus:synthesis')).toHaveLength(1)
  })

  test('…and the SAME round WITH a diff proceeds to a second panel', async () => {
    // The positive control. Without it the assertions above pass for any fix round
    // that stops for any reason, and the gate could be firing on something else
    // entirely — the two fixtures differ only in whether `diffFile` is empty.
    const { result, captured } = await runWorkflow(productionArgs(CODEX_BUILD), {
      requestChangesOnce: true,
      fixLands: true,
      fixProduces: { commitSha: 'def', diffFile: '/tmp/round-2.diff' },
    })
    expect(result['blockKind']).not.toBe('round-lost')
    expect(result['verdict']).toBe('APPROVE')
    expect(captured.filter((c) => c.label === 'argus:synthesis')).toHaveLength(2)
  })

  test('the second panel reads THIS round\'s diff, not round 1\'s', async () => {
    // The loop captured `diffFile` once and handed the same path to every review
    // round. That is the other half of the gate above: a round whose diff went to a
    // different path would have its work reviewed from the previous round's file.
    const { captured } = await runWorkflow(productionArgs(CODEX_BUILD), {
      requestChangesOnce: true,
      fixLands: true,
      fixProduces: { commitSha: 'def', diffFile: '/tmp/round-2.diff' },
    })
    const panels = captured.filter((c) => c.label === 'argus:claude')
    expect(panels).toHaveLength(2)
    expect(panels[0]!.prompt).toContain('/tmp/x.diff')
    expect(panels[1]!.prompt).toContain('/tmp/round-2.diff')
    expect(panels[1]!.prompt).not.toContain('/tmp/x.diff')
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

  test('the bridge reports the local build sha for the outer publisher', async () => {
    // Two different questions, and pinning a merge to the wrong one certifies a
    // commit no reviewer or merge will ever see. `productionArgs` is local-mode.
    const local = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    expect(local).toContain('NEUTRON_CODEX_BUILD_HEAD=')
    expect(local).toContain('the build commit')

    const prArgs = { ...productionArgs(CODEX_BUILD), mergeMode: 'pr' }
    const pr = promptFor((await runWorkflow(prArgs)).captured, 'forge:build')
    expect(pr).toContain('NEUTRON_CODEX_BUILD_HEAD=')
    expect(pr).toContain('outer loop independently publishes and confirms it')
  })

  test('the run\'s MERGE MODE is handed to the wrapper as an argument, not re-derived', async () => {
    // THE WEDGE THIS FIXES. Three of the wrapper's checks are pr-only — the remote
    // baseline, the push-credential precheck and the `gh pr list` probe — and with no
    // argument to read it inferred "am I in pr mode" from "does an `origin` exist",
    // which is a question about the CLONE and not about the RUN. Any local-mode build
    // in a clone whose origin was unreachable (offline, a stale URL, a non-GitHub
    // remote) hard-deferred at the baseline before codex launched, every round.
    const local = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    expect(local).toContain("bash '/repo/trident/codex-build.sh' 'trident/a-run' 'main' 'local'")

    const prArgs = { ...productionArgs(CODEX_BUILD), mergeMode: 'pr' }
    const pr = promptFor((await runWorkflow(prArgs)).captured, 'forge:build')
    expect(pr).toContain("bash '/repo/trident/codex-build.sh' 'trident/a-run' 'main' 'pr'")
    // The two really are different commands, so neither assertion is passing on a
    // constant that happens to contain both.
    expect(local).not.toContain("'main' 'pr'")
  })

  test('the composed wrapper invocation carries no GitHub credential', async () => {
    const prompt = promptFor((await runWorkflow({ ...productionArgs(CODEX_BUILD), mergeMode: 'pr' })).captured, 'forge:build')
    const invocation = prompt.split('THEN run this ONE command:')[1]!.split('\n\nThen WAIT')[0]!
    expect(invocation).not.toContain('GH_TOKEN=')
    expect(invocation).not.toContain('GITHUB_TOKEN=')
    expect(invocation).not.toContain('GIT_CONFIG_KEY_')
    // Positive control: the slice is the real invocation, not an empty string.
    expect(invocation).toContain("bash '/repo/trident/codex-build.sh'")
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

  test('every pr-mode Forge brief stands down publishing for the outer loop', async () => {
    // THE PUBLISH BOUNDARY, on the composing side. The codex build holds no GitHub
    // credential and is never going to: `gh` authenticates from `GH_TOKEN` and the
    // child shell's environment filter strips it, deliberately (widening that filter is
    // what leaked the owner's Anthropic credential into a `danger-full-access` GPT
    // shell the one time it was tried). A build ordered to push and open a PR anyway
    // did exactly what that implies — wrote the whole feature, could not deliver it,
    // and came back indistinguishable from a build that produced nothing. So the
    // outer loop publishes and the brief says so.
    const prArgs = { ...productionArgs(CODEX_BUILD), mergeMode: 'pr' }
    const codexPr = promptFor((await runWorkflow(prArgs)).captured, 'forge:build')
    expect(codexPr).toContain("STEP 4'S PUSH AND PR ARE NOT YOURS")
    expect(codexPr).toContain('COMMIT LOCALLY')
    expect(codexPr).toContain('Do NOT run `git push`')

    // The Claude builder obeys the same boundary; credentials must be absent from
    // every inner executor, not merely from codex.
    const claudePr = promptFor(
      (await runWorkflow({ ...productionArgs(null), mergeMode: 'pr' })).captured,
      'forge:build',
    )
    expect(claudePr).toContain('durable outer loop publishes')
    expect(claudePr).not.toContain('open a PR with `gh pr create`')
    expect(claudePr).not.toContain("STEP 4'S PUSH AND PR ARE NOT YOURS")
    expect(codexPr).not.toContain('open a PR with `gh pr create`')

    // LOCAL MODE STANDS NOTHING DOWN, because there was never anything to publish:
    // step 4 already says "commit on the branch, do NOT push".
    const codexLocal = promptFor((await runWorkflow(productionArgs(CODEX_BUILD))).captured, 'forge:build')
    expect(codexLocal).toContain('do NOT push or run `gh pr create`')
    expect(codexLocal).not.toContain("STEP 4'S PUSH AND PR ARE NOT YOURS")
  })

  test('a build that CONNECTED but produced nothing never reaches the review panel', async () => {
    // The sibling of the not_connected case above, and the more expensive one. Here
    // codex ran to completion and the wrapper measured honestly: no sha, no diff. The
    // status is `connected`, so the executor gate passes — and round 1 had no
    // did-it-land check, so five reviewers were dispatched to read an empty diff, find
    // nothing wrong with it, and APPROVE. Only the outer merge's empty-`reviewedHead`
    // refusal stopped it shipping, one gate too far down and the whole review budget
    // already spent on a change that does not exist.
    const { captured, result } = await runWorkflow(productionArgs(CODEX_BUILD), {
      buildProduces: { commitSha: '', diffFile: '' },
    })
    expect(result['ok']).toBe(false)
    expect(result['checkpoint']).toBe('inner-error')
    expect(captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
    expect(captured.filter((c) => String(c.label).startsWith('forge:fix-round-'))).toEqual([])
    // Never an APPROVE — an empty diff must not be able to produce one.
    expect(result['verdict'] ?? null).not.toBe('APPROVE')

    // EACH FACT ALONE IS FATAL, for a different reason: a diff with no sha can never
    // be merged (`--match-head-commit` has nothing to pin), and a sha with no diff
    // gives the panel nothing to read.
    for (const produced of [{ commitSha: 'abc', diffFile: '' }, { commitSha: '', diffFile: '/tmp/x.diff' }]) {
      const half = await runWorkflow(productionArgs(CODEX_BUILD), { buildProduces: produced })
      expect(half.result['ok']).toBe(false)
      expect(half.captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
    }

    // THE CONTROL: the same harness with a real sha and diff DOES reach the panel, so
    // the emptiness above is the guard firing and not a workflow that never reviews.
    const healthy = await runWorkflow(productionArgs(CODEX_BUILD))
    expect(healthy.captured.filter((c) => String(c.label).startsWith('argus:')).length).toBeGreaterThan(0)
  })

  test('…and the terminal failure NAMES the PR the empty build opened', async () => {
    // The gate captures the PR number BEFORE it throws. A build that opened a PR and
    // then reported no sha is exactly the case an operator needs the number for — it
    // is where the half-finished work is — and a message that could not mention it
    // sent them looking for a branch by hand.
    const { result, logs } = await runWorkflow(productionArgs(CODEX_BUILD), {
      buildProduces: { commitSha: '', diffFile: '' },
      buildPr: 4242,
    })
    expect(result['ok']).toBe(false)
    // The thrown message is what the run's output shows, and it says which PR.
    expect(logs.some((l) => l.includes('inner THREW') && l.includes('#4242'))).toBe(true)
    // …and it is carried as the typed field too, not only in prose.
    expect(result['prNumber']).toBe(4242)

    // THE CONTROL: with no PR the message says nothing about one rather than
    // inventing "#null".
    const noPr = await runWorkflow(productionArgs(CODEX_BUILD), {
      buildProduces: { commitSha: '', diffFile: '' },
    })
    expect(noPr.logs.some((l) => l.includes('inner THREW') && l.includes('nothing was built.'))).toBe(
      true,
    )
  })

  test('a Ralph task that built nothing RE-FIRES the next task instead of aborting', async () => {
    // THE GATE GUARDS THE REVIEW PANEL, and an intermediate Ralph task opens none. A
    // single task the planner turned into a no-op must not kill a multi-task run: the
    // outer loop re-fires the next task, and the FINAL task still passes through the
    // gate before any reviewer is paid. Placing the check ahead of the re-fire made
    // one empty task abort everything.
    const { captured, result } = await runWorkflow(
      productionArgs(CODEX_BUILD, { ralph: true }),
      { buildProduces: { commitSha: '', diffFile: '' }, remainingTasks: 2 },
    )
    expect(result['ok']).toBe(true)
    expect(result['checkpoint']).toBe('ralph-task-built')
    expect(result['remainingTasks']).toBe(2)
    // No panel was opened for the empty intermediate — the budget is still unspent.
    expect(captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])

    // THE CONTROL: the LAST task (nothing remaining) with the same emptiness still
    // stops the run, so this is the re-fire path and not a hole in the gate.
    const last = await runWorkflow(productionArgs(CODEX_BUILD, { ralph: true }), {
      buildProduces: { commitSha: '', diffFile: '' },
      remainingTasks: 0,
    })
    expect(last.result['ok']).toBe(false)
    expect(last.captured.filter((c) => String(c.label).startsWith('argus:'))).toEqual([])
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
          trailerComplete: true,
          wrapperExitCode: 10,
          preservedWork: false,
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
    // The rubric reviewer has ONE dispatch, `agent({model})`, which resolves against
    // Claude Code's endpoint. `sol` is a codex tier, so the override is dropped rather
    // than handed to `agent({model: 'gpt-5.6-sol'})` — a spawn against an endpoint
    // that has never heard of it. (The BUILD row is the counter-example, and the whole
    // point of this change: it declares a codex dispatch, so the same tier is accepted
    // there. `alsoRunsOn` is what separates the two.)
    expect(productionArgs({ review_rubric: { model: 'sol' } })['phaseModels']).toBeUndefined()

    const { captured, logs } = await runWorkflow(past({ review_rubric: { model: 'sol' } }))
    const rubric = captured.find((c) => c.label === 'argus:claude')!
    expect(rubric.opts['model']).toBe(getBestModel())
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('executor-mismatch'))).toBe(true)
  })

  test('an effort on a CLI lane is refused rather than stored into a dispatch nothing reads', async () => {
    expect(productionArgs({ review_codex: { effort: 'max' } })['phaseModels']).toBeUndefined()

    const { logs } = await runWorkflow(past({ review_codex: { effort: 'max' } }))
    expect(logs.some((l) => l.includes('IGNORED') && l.includes('effort-not-settable'))).toBe(true)
  })
})
