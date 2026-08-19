/**
 * THE ARRIVAL PROOF for the codex BUILD dispatch.
 *
 * The card reports two symptoms: (1) the brief parts are written but
 * `NEUTRON_CODEX_BUILD_BRIEF_PARTS` never reaches the child, so the build starts
 * blind; (2) the run id is mistyped on the same path, so the run cannot be
 * correlated back. Both were RE-MEASURED against main before this suite was
 * written and NEITHER reproduces when the transport the workflow actually emits is
 * executed verbatim — the parts arrive, the assembled brief matches the prompt's
 * own receipt at the codex seam, and the exit/trailer files land at the run-id-keyed
 * paths. Saying that honestly matters more than shipping a fix for a bug that is
 * not there.
 *
 * What WAS missing is the measurement that would have said so. No suite executed
 * the workflow-EMITTED run command and then read the CHILD's environment:
 * `inner-workflow.test.ts` asserts prompt TEXT, `codex-build.test.ts` hands the
 * wrapper a HAND-BUILT env, and the `inner-workflow-assembly.test.ts` lockstep runs
 * the chunk blocks but stops at file assembly and never launches anything. A
 * regression that dropped `${partsEnv}` from the emitted command, broke
 * `shSingleQuote` on the newline-joined parts list, or drifted the run id between
 * the artifact paths would ship green today.
 *
 * So this closes the seam in the `trident/gh-authed.test.ts` style: run the REAL
 * thing as a subprocess and read what the child actually received. The real
 * `writeBriefParts` writes the host-held parts, the real `inner-workflow.mjs`
 * composes the forge:build prompt, REAL bash executes the prompt's own chunk blocks
 * and its own run command against the REAL `trident/codex-build.sh` with a stub
 * `codex`, and the wrapper's documented exec seam dumps the CHILD's environment and
 * stdin. Every assertion below is on a child-written artifact — the env dump, the
 * stdin dump, and the exit/trailer/err files — never on an object the parent built.
 *
 * A stripped-PARTS negative control proves the suite can fail: with the PARTS
 * assignment cut out of the emitted command the wrapper refuses at exit 3 with
 * CODEX_BUILD_NO_BRIEF, and the seam never runs at all — a blind build is refused
 * before a token is spent, not started and then noticed.
 *
 * HAZARD, for the next reader: the emitted run command contains REAL embedded
 * newlines (inside the supervisor's `printf "%s\n"` and inside the single-quoted
 * PARTS value). Never split it on newlines; slicing from `rm -f ` to the trailing
 * `</dev/null &` is the only correct extraction.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { briefIntegrity, writeBriefParts, type BriefParts } from './brief-parts.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')
// The REAL repository root, so the emitted command names the REAL wrapper script.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

// >30 KB, which is what puts the brief on the by-path transport in the first place.
// The marker rides all the way to the codex seam's stdin, and is what proves the
// build was not started blind.
const TASK = 'do the arrival thing ARRIVAL_MARKER_77 line\n'.repeat(900)

const tempDirs: string[] = []
const runIds: string[] = []
const mkTemp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Compose the REAL forge:build prompt by running `inner-workflow.mjs` itself.
 *
 * The script is not importable (top-level `return` + Workflow-runtime globals), so
 * this reads its source, strips the single `export`, and runs the body as an
 * AsyncFunction with mocked `agent`/`parallel`/`phase`/`log`/`budget` — the same
 * harness `inner-workflow-assembly.test.ts` uses, and for the same reason: the
 * prompt under test must be the one production emits, not a reconstruction of it.
 */
async function emitForgeBuildPrompt(
  runId: string,
): Promise<{ prompt: string; parts: BriefParts }> {
  const partsDir = mkTemp('trident-arrival-parts-')
  const parts = writeBriefParts({ runId, task: TASK, reflectionGuidance: '', dir: partsDir })
  expect(parts).not.toBeNull()

  const codexHome = mkTemp('trident-arrival-codexhome-')
  writeFileSync(join(codexHome, 'auth.json'), '{}')

  const captured: Array<{ label: string | undefined; prompt: string }> = []
  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label
    captured.push({ label, prompt })
    if (String(label).startsWith('head-probe-round-built-')) return { head: 'a'.repeat(40) }
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return {
        codexStatus: 'connected',
        trailerComplete: true,
        wrapperExitCode: 0,
        preservedWork: false,
        branch: 'trident/arrival-run',
        commitSha: 'a'.repeat(40),
        prNumber: null,
        diffFile: '/tmp/x.diff',
        worktreePath: '/wt',
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial' || label === 'argus:synthesis') {
      return { verdict: 'APPROVE', findings: [] }
    }
    if (String(label).startsWith('argus:codex')) {
      return { verdict: 'APPROVE', findings: [], codexStatus: 'connected', codexTruncated: false }
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args: Record<string, unknown> = {
    repoPath: REPO_ROOT,
    task: TASK,
    baseBranch: 'main',
    slug: 'arrival-run',
    maxRounds: 1,
    ralph: false,
    mergeMode: 'pr',
    prNumber: null,
    branch: null,
    dbPath: null,
    runId,
    resumeCheckpoint: null,
    codexHome,
    kimiConfigured: false,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
    phaseModels: { build: { model: 'gpt' } },
    modelTiers: {
      gpt: { model_id: 'gpt-5-codex', transport: 'cli', env_var: 'CODEX_BUILD_MODEL', group: 'codex' },
    },
    briefParts: parts,
    // Main dropped the repoPath fallback for the wrapper path (resolving it from the
    // repo being built is the drift #355 fixed): forgeAgent now FAILS CLOSED when the
    // launcher does not thread codexBuildScript, throwing BEFORE forge:build is ever
    // dispatched. Thread the REAL wrapper, same as inner-loop.ts buildWorkflowArgs does.
    codexBuildScript: join(REPO_ROOT, 'trident', 'codex-build.sh'),
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  await fn(agent, parallel, phase, log, budget, args)

  const prompt = captured.find((c) => c.label === 'forge:build')?.prompt ?? ''
  expect(prompt).toContain('NEUTRON_CODEX_BUILD_BRIEF_PARTS=')
  return { prompt, parts: parts as BriefParts }
}

/**
 * Execute the prompt's OWN chunk blocks with real bash, exactly as the bridge agent
 * is told to. No path remapping: the `.a1`/`.a2` targets are real /tmp paths keyed by
 * this run's unique id, and they are cleaned up in `afterAll`.
 */
function runChunkBlocks(prompt: string): void {
  const start = /^CALL 1 of (\d+):$/m.exec(prompt)
  expect(start).not.toBeNull()
  const declared = Number(start?.[1])
  const startIndex = Number(start?.index)
  const end = prompt.indexOf('\nTHEN run this ONE command', startIndex)
  expect(end).toBeGreaterThan(startIndex)
  const region = prompt.slice(startIndex, end)

  // Split on the CALL headers, NOT on blank lines — heredoc bodies contain them.
  const headers = [...region.matchAll(/^CALL \d+ of \d+:\n/gm)]
  expect(headers.length).toBe(declared)
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    const block = region.slice(
      Number(h?.index) + String(h?.[0]).length,
      i + 1 < headers.length ? Number(headers[i + 1]?.index) : region.length,
    )
    const run = spawnSync('bash', ['-c', block.endsWith('\n') ? block : `${block}\n`])
    expect(run.status).toBe(0)
  }
}

/**
 * THE RUN COMMAND, sliced — never split on lines. It carries real embedded newlines
 * inside the supervisor's `printf "%s\n"` and inside the quoted PARTS value, so the
 * `</dev/null &` terminator is the only thing that marks its end.
 */
function extractRunCommand(prompt: string): string {
  const anchor = prompt.indexOf('THEN run this ONE command')
  expect(anchor).toBeGreaterThan(-1)
  const cmdStart = prompt.indexOf('rm -f ', anchor)
  expect(cmdStart).toBeGreaterThan(anchor)
  const cmdEnd = prompt.indexOf('</dev/null &', cmdStart) + '</dev/null &'.length
  expect(cmdEnd).toBeGreaterThan(cmdStart)
  return prompt.slice(cmdStart, cmdEnd)
}

/** A worktree stand-in: a REAL git repo on the forge branch, with no `origin`. */
function makeWorktree(): string {
  const dir = mkTemp('trident-arrival-wt-')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  const init = spawnSync(
    'bash',
    [
      '-c',
      'git init -q -b trident/arrival-run . && git config user.email a@b.c && git config user.name a && git add -A && git commit -q -m seed',
    ],
    { cwd: dir },
  )
  expect(init.status).toBe(0)
  return dir
}

/** A stub `codex` that satisfies `command -v codex` and the bounded login precheck. */
function makeStubBin(): string {
  const dir = mkTemp('trident-arrival-bin-')
  const codex = join(dir, 'codex')
  writeFileSync(codex, '#!/bin/sh\nexit 0\n')
  chmodSync(codex, 0o755)
  return dir
}

/** Launch the emitted command and wait for the detached wrapper's exit file. */
async function launch(
  command: string,
  opts: { worktree: string; stubBin: string; envDump: string; stdinDump: string; exitFile: string },
): Promise<void> {
  const home = mkTemp('trident-arrival-home-')
  const run = spawnSync('bash', ['-c', command], {
    cwd: opts.worktree,
    env: {
      PATH: `${opts.stubBin}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: home,
      NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
      // The wrapper's documented test seam: it reads the same stdin and runs where
      // codex would. THIS is the child whose environment the assertions read.
      NEUTRON_CODEX_BUILD_EXEC_CMD: `env > ${JSON.stringify(opts.envDump)}; cat > ${JSON.stringify(opts.stdinDump)}`,
      // The seam is scrubbed with `env -u GH_TOKEN -u GITHUB_TOKEN`, same as the real
      // launch; this sentinel is what says so.
      GH_TOKEN: 'should-not-arrive-sentinel',
    },
  })
  expect(run.status).toBe(0)

  // The wrapper runs DETACHED (`nohup setsid … &`) and exits on its own in well under
  // a second with a stub codex and the seam. Nothing is ever killed here.
  for (let i = 0; i < 150 && !existsSync(opts.exitFile); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(existsSync(opts.exitFile)).toBe(true)
}

/**
 * The PARTS value as the CHILD reported it. `env` prints `NAME=value` and the value
 * here contains real newlines, so the entry runs on until the next `NAME=` line.
 */
function partsFromEnvDump(dump: string): string[] {
  const lines = dump.split('\n')
  const i = lines.findIndex((l) => l.startsWith('NEUTRON_CODEX_BUILD_BRIEF_PARTS='))
  expect(i).toBeGreaterThan(-1)
  const collected = [String(lines[i]).slice('NEUTRON_CODEX_BUILD_BRIEF_PARTS='.length)]
  for (let j = i + 1; j < lines.length; j++) {
    const line = String(lines[j])
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) break
    collected.push(line)
  }
  return collected.filter((p) => p !== '')
}

const artifact = (runId: string, suffix: string): string =>
  `/tmp/trident-codex-build-${runId}-r1${suffix}`

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  for (const runId of runIds) {
    for (const suffix of ['.exit', '.trailer', '.err', '.out', '.brief', '.brief.a1', '.brief.a2']) {
      rmSync(artifact(runId, suffix), { force: true })
    }
    rmSync(`/tmp/trident-codex-build-${runId}.diff`, { force: true })
  }
})

describe('codex build dispatch — the brief ARRIVES at the child and the run id correlates', () => {
  test(
    'the emitted run command delivers PARTS, the brief and the routed model to the child',
    async () => {
      const runId = `arrival-${process.pid}`
      runIds.push(runId)
      const { prompt, parts } = await emitForgeBuildPrompt(runId)
      runChunkBlocks(prompt)

      const io = mkTemp('trident-arrival-io-')
      const envDump = join(io, 'env.dump')
      const stdinDump = join(io, 'stdin.dump')
      await launch(extractRunCommand(prompt), {
        worktree: makeWorktree(),
        stubBin: makeStubBin(),
        envDump,
        stdinDump,
        exitFile: artifact(runId, '.exit'),
      })

      // (a) The wrapper ran to completion.
      expect(readFileSync(artifact(runId, '.exit'), 'utf8').trim()).toBe('0')

      // (b) RUN-ID CORRELATION. This path is built by the TEST from its own runId
      // string, so the trailer existing here proves the id survived prompt → command
      // → wrapper without being mistyped or re-serialized on the way.
      const trailerPath = artifact(runId, '.trailer')
      expect(existsSync(trailerPath)).toBe(true)
      const trailer = readFileSync(trailerPath, 'utf8')
      expect(trailer.trim().length).toBeGreaterThan(0)
      const trailerLines = trailer.trim().split('\n')
      expect(trailerLines.length).toBe(6)
      for (const line of trailerLines) expect(line.startsWith('NEUTRON_CODEX_BUILD_')).toBe(true)
      expect(trailerLines).toContain('NEUTRON_CODEX_BUILD_BRANCH=trident/arrival-run')

      // (c) PARTS ARRIVAL — read out of the dump the CHILD wrote, in order.
      const dump = readFileSync(envDump, 'utf8')
      const partsList = partsFromEnvDump(dump)
      expect(partsList.length).toBe(3)
      expect(partsList[0]?.endsWith('.brief.a1')).toBe(true)
      expect(partsList[1]).toBe(parts.taskFile)
      expect(partsList[2]?.endsWith('.brief.a2')).toBe(true)
      for (const p of partsList) expect(existsSync(p)).toBe(true)

      // (d) THE BUILD IS NOT BLIND. Parts mode carries per-part receipts, not a
      // whole-file one (the arbitration dropped NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY
      // from this path): every part the CHILD reported measures to the prompt's OWN
      // per-part receipt, and what landed on the seam's stdin is byte-for-byte the
      // in-order assembly of those receipted parts.
      const stdin = readFileSync(stdinDump, 'utf8')
      expect(stdin).toContain('ARRIVAL_MARKER_77')
      const receiptList = /NEUTRON_CODEX_BUILD_BRIEF_PART_INTEGRITY='([^']*)'/.exec(prompt)?.[1]
      expect(receiptList).toBeTruthy()
      const receipts = String(receiptList).split('\n')
      expect(receipts.length).toBe(partsList.length)
      for (let i = 0; i < partsList.length; i++) {
        expect(briefIntegrity(readFileSync(String(partsList[i]), 'utf8'))).toBe(String(receipts[i]))
      }
      expect(stdin).toBe(partsList.map((p) => readFileSync(p, 'utf8')).join(''))
      // The branch's own whole-brief assertion (`briefIntegrity(stdin)` against
      // NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY) is subsumed, not lost: the per-part
      // receipts above plus this byte-for-byte assembly say the same thing about
      // stdin, and in parts mode the launcher no longer emits a whole-file receipt
      // for the regex to find.

      // (e) The routed model reached the child, and the scrub held on the seam path.
      expect(dump).toContain('CODEX_BUILD_MODEL=gpt-5-codex')
      expect(/^GH_TOKEN=/m.test(dump)).toBe(false)
    },
    30_000,
  )

  test(
    'with the PARTS assignment stripped the build is REFUSED before the seam runs',
    async () => {
      const runId = `arrival-neg-${process.pid}`
      runIds.push(runId)
      const { prompt } = await emitForgeBuildPrompt(runId)
      runChunkBlocks(prompt)

      // The quoted PARTS value carries newlines but no single quote — `writeBriefParts`
      // sanitizes the run id and the a1/a2 paths are workflow-composed — so the span
      // is exactly this, and the replace changing the string is what says so.
      const command = extractRunCommand(prompt)
      const stripped = command.replace(/NEUTRON_CODEX_BUILD_BRIEF_PARTS='[^']*' /, '')
      expect(stripped).not.toBe(command)
      expect(stripped).not.toContain('NEUTRON_CODEX_BUILD_BRIEF_PARTS')

      const io = mkTemp('trident-arrival-neg-io-')
      const envDump = join(io, 'env.dump')
      const stdinDump = join(io, 'stdin.dump')
      await launch(stripped, {
        worktree: makeWorktree(),
        stubBin: makeStubBin(),
        envDump,
        stdinDump,
        exitFile: artifact(runId, '.exit'),
      })

      expect(readFileSync(artifact(runId, '.exit'), 'utf8').trim()).toBe('3')
      expect(readFileSync(artifact(runId, '.err'), 'utf8')).toContain('CODEX_BUILD_NO_BRIEF')
      // NOT A SINGLE TOKEN: the seam that stands in for codex never ran at all.
      expect(existsSync(envDump)).toBe(false)
      expect(existsSync(stdinDump)).toBe(false)
    },
    30_000,
  )
})
