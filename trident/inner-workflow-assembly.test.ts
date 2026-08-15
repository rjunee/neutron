/**
 * RB2 (b) — AS-BUILT behavioral coverage of the reflection trust boundary, executed
 * over the REAL `inner-workflow.mjs` prompt assembly (not a parallel helper).
 *
 * The script is not importable (top-level `return` + Workflow-runtime globals + no
 * module resolution), so this harness reads its source, strips the single `export`,
 * and runs the body as an AsyncFunction with MOCKED runtime globals
 * (`agent`/`parallel`/`phase`/`log`/`budget`) that RECORD every `agent()` call's
 * `{label, prompt}`. Checkpoints + terminal-result writes no-op (null `dbPath`/`runId`),
 * so the run reaches Forge build → review → one fix round → review, letting us assert
 * the COMPLETE assembled prompt for EVERY Forge and Argus role. This catches an
 * indirect reviewer leak (e.g. aliasing `reflectionGuidance`) that source-text checks
 * could miss.
 */
import { describe, expect, test, afterAll, beforeAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildReflectionGuidance } from './reflection-guidance.ts'
import { briefIntegrity, writeBriefParts } from './brief-parts.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

// A distinctive marker inside the (untrusted) reflection block so we can trace exactly
// which agent prompts carry the owner corrections.
const REFLECT_MARKER = 'REFLECT_MARKER_X1Y2Z3'
const GUIDANCE = buildReflectionGuidance(
  `<learned_corrections>\n- ${REFLECT_MARKER} always prefer TypeScript\n</learned_corrections>`,
)

interface Captured {
  label: string | undefined
  prompt: string
}

interface RunOpts {
  phaseModels?: Record<string, { model: string }>
  /**
   * Labels whose agent returns NOTHING — the seat was DISPATCHED and its agent died.
   * This is the case the panel-completeness gate exists for, and the only way to
   * produce it against the REAL panel is to kill a seat by its label and let the
   * workflow assign the slots itself.
   */
  dead?: string[]
  /**
   * Every surviving seat APPROVEs, on round 1. Then the ONLY thing that can keep the
   * run from returning APPROVE is the completeness gate — nothing else is in the way.
   */
  approveAll?: boolean
  /**
   * Run in Ralph mode, which is the ONLY way `plan:fable` is dispatched — the planner
   * prompt is unreachable otherwise, so a rule spliced only into the non-Ralph path
   * would look covered while the planner never sees it.
   */
  ralph?: boolean
  task?: string
  briefParts?: unknown
  codexBuild?: boolean
  /**
   * The rendered TEST EXECUTION block. Undefined → the arg is not set at all, which is
   * the legacy-contract case (the workflow defaults it to '').
   */
  testStrategy?: string
}

async function runWorkflow(
  reflectionGuidance: string,
  opts: RunOpts = {},
): Promise<{ captured: Captured[]; result: Record<string, unknown>; logs: string[] }> {
  const captured: Captured[] = []
  const logs: string[] = []
  let synthCount = 0
  const dead = new Set(opts.dead ?? [])

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label
    captured.push({ label, prompt })
    // A DEAD SEAT: dispatched, returned nothing. Checked FIRST so it can kill any
    // label, including a retry lane ('argus:codex-retry').
    if (dead.has(String(label))) return null
    // The build-completion head, read from git the moment a Forge round exits. Without
    // it every local-mode run stops boundedly at forge-done and none of the review
    // seats this harness exists to measure are ever dispatched.
    if (String(label).startsWith('head-probe-round-built-')) return { head: 'a'.repeat(40) }
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      if (opts.codexBuild) {
        return { codexStatus: 'connected', trailerComplete: true, wrapperExitCode: 0, preservedWork: false, branch: 'trident/test-run', commitSha: 'a'.repeat(40), prNumber: null, diffFile: '/tmp/x.diff', worktreePath: '/wt', testsPassed: true }
      }
      return { prNumber: null, branch: 'trident/test-run', diffFile: '/tmp/x.diff', worktreePath: '/wt', commitSha: 'abc', testsPassed: true }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      return { verdict: opts.approveAll === true ? 'APPROVE' : 'REQUEST_CHANGES', findings: [] }
    }
    if (label === 'plan:fable') {
      // `remainingTasks: 0` so the run does NOT hand back to the outer loop for a
      // re-fire — it continues into forge:build + the full review panel.
      return {
        implementationPlan: '- [ ] the one task',
        topTask: 'the one task',
        executionSpec: 'TARGET FILES: x.ts',
        complexity: 'reasoning',
        remainingTasks: 0,
      }
    }
    if ((label === 'argus:kimi' || label === 'argus:kimi-retry' || label === 'argus:codex' || label === 'argus:codex-retry') && prompt.includes('KIMI K3 CROSS-MODEL REVIEW')) {
      return { verdict: 'APPROVE', findings: [], kimiStatus: 'connected' }
    }
    if (label === 'argus:codex' || label === 'argus:codex-retry') {
      // `codexTruncated` included because CODEX_VERDICT_SCHEMA REQUIRES it — a mock
      // that omits it is a bridge that dropped it, which is a different case (and
      // deliberately reads as PARTIAL, SCOPE UNKNOWN).
      return { verdict: 'APPROVE', findings: [], codexStatus: 'connected', codexTruncated: false }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      // Round 1 → REQUEST_CHANGES (forces one fix round so forge:fix-round-* is
      // exercised); round 2 → APPROVE (ends the loop). Under `approveAll` the
      // synthesis APPROVEs immediately, so the gate is the only remaining actor.
      return { verdict: opts.approveAll === true || synthCount > 1 ? 'APPROVE' : 'REQUEST_CHANGES', findings: [] }
    }
    // checkpoint / terminal-result / cleanup bash steps (also no-op'd by null dbPath).
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (...values: unknown[]): void => { logs.push(values.map(String).join(' ')) }
  const budget = { total: 0, spent: (): number => 0 }

  const args: Record<string, unknown> = {
    repoPath: '/repo',
    task: opts.task ?? 'build the feature',
    baseBranch: 'main',
    slug: 'test-run',
    maxRounds: 3,
    ralph: opts.ralph === true,
    // Codex-build cases use pr mode so the workflow stops at the durable publisher
    // handoff after Forge; the task is not subsequently copied into reviewer prompts.
    mergeMode: opts.codexBuild ? 'pr' : 'local',
    prNumber: null,
    branch: null,
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op (no bash agent steps)
    runId: null,
    resumeCheckpoint: null,
    codexHome: '/codex', // → codexConfigured, so argus:codex runs (and is asserted excluded)
    kimiConfigured: true, // → the kimi cross-model seat runs too, so its prompt is captured
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance,
    phaseModels: opts.phaseModels ?? null,
    modelTiers: {
      none: { model_id: 'none', transport: 'agent', env_var: null, group: 'none' },
      sol: { model_id: 'gpt', transport: 'cli', env_var: 'CODEX_REVIEW_MODEL', group: 'codex' },
      k3: { model_id: 'kimi', transport: 'cli', env_var: 'KIMI_MODEL', group: 'kimi' },
    },
  }
  if (opts.testStrategy !== undefined) args.testStrategy = opts.testStrategy
  if (opts.briefParts !== undefined) args.briefParts = opts.briefParts
  if (opts.codexBuild) {
    args.phaseModels = { build: { model: 'gpt' } }
    args.modelTiers = { gpt: { model_id: 'gpt-5-codex', transport: 'cli', env_var: 'CODEX_BUILD_MODEL', group: 'codex' } }
  }

  // Strip the single `export` so the module body is legal inside an AsyncFunction
  // (top-level return + await are legal in a function body).
  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Record<string, unknown>
  return { captured, result, logs }
}

const LARGE_TASK = [
  ...Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')} ${'task contract bytes '.repeat(4)}`),
  `${'é'.repeat(5000)} TASKBYTES_MARKER_Q9`,
].join('\n')

const forgeBuildPrompt = (captured: Captured[]): string =>
  captured.find((c) => c.label === 'forge:build')?.prompt ?? ''

describe('inner-workflow.mjs — Codex build brief by-path transport', () => {
  const taskParts = (task = LARGE_TASK) => ({
    taskFile: '/tmp/t.part',
    taskIntegrity: briefIntegrity(task),
    reflectionFile: null,
    reflectionIntegrity: null,
  })

  test('a >30 KB task travels by path and is absent from every agent prompt', async () => {
    expect(new TextEncoder().encode(LARGE_TASK).length).toBeGreaterThan(30_000)
    const { captured } = await runWorkflow('', { codexBuild: true, task: LARGE_TASK, briefParts: taskParts() })
    for (const call of captured) expect(call.prompt).not.toContain('TASKBYTES_MARKER_Q9')
    const prompt = forgeBuildPrompt(captured)
    expect(prompt).toContain('NEUTRON_CODEX_BUILD_BRIEF_PARTS=')
    expect(prompt).toContain('NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY=')
    const a1 = prompt.indexOf('.brief.a1')
    const task = prompt.indexOf('/tmp/t.part', a1)
    const a2 = prompt.indexOf('.brief.a2', task)
    expect(a1).toBeGreaterThan(-1)
    expect(task).toBeGreaterThan(a1)
    expect(a2).toBeGreaterThan(task)
  })

  test('whole-brief receipt is unchanged and fallback still carries the task', async () => {
    const byPath = forgeBuildPrompt((await runWorkflow('', { codexBuild: true, task: LARGE_TASK, briefParts: taskParts() })).captured)
    const fallback = forgeBuildPrompt((await runWorkflow('', { codexBuild: true, task: LARGE_TASK })).captured)
    const receipt = (prompt: string) => prompt.match(/NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY='([^']+)'/)?.[1]
    expect(receipt(byPath)).toBe(receipt(fallback))
    expect(fallback).toContain('TASKBYTES_MARKER_Q9')
    expect(fallback).not.toContain('NEUTRON_CODEX_BUILD_BRIEF_PARTS=')
  })

  test('malformed manifest produces the byte-identical fallback prompt', async () => {
    const malformed = forgeBuildPrompt((await runWorkflow('', { codexBuild: true, task: LARGE_TASK, briefParts: 'garbage' })).captured)
    const absent = forgeBuildPrompt((await runWorkflow('', { codexBuild: true, task: LARGE_TASK })).captured)
    expect(malformed).toBe(absent)
  })

  test('args-transit receipt mismatch throws the named terminal error', async () => {
    const { result, logs } = await runWorkflow('', {
      codexBuild: true,
      task: LARGE_TASK,
      briefParts: { ...taskParts(), taskIntegrity: '1:00000000' },
    })
    const failure = `${JSON.stringify(result)} ${logs.join('\n')}`
    expect(failure).toContain('CODEX_BUILD_BRIEF_ARGS_CORRUPT')
    expect(failure).not.toContain('inner loop exhausted')
  })

  test('reflection guidance travels by path and missing reflection metadata fails closed', async () => {
    const manifest = {
      ...taskParts(),
      reflectionFile: '/tmp/r.part',
      reflectionIntegrity: briefIntegrity(GUIDANCE),
    }
    const { captured } = await runWorkflow(GUIDANCE, { codexBuild: true, task: LARGE_TASK, briefParts: manifest })
    for (const call of captured) expect(call.prompt).not.toContain(REFLECT_MARKER)
    const prompt = forgeBuildPrompt(captured)
    const task = prompt.indexOf('/tmp/t.part')
    const reflection = prompt.indexOf('/tmp/r.part', task)
    const a2 = prompt.indexOf('.brief.a2', reflection)
    expect(reflection).toBeGreaterThan(task)
    expect(a2).toBeGreaterThan(reflection)

    const { result, logs } = await runWorkflow(GUIDANCE, {
      codexBuild: true,
      task: LARGE_TASK,
      briefParts: { ...manifest, reflectionFile: null },
    })
    expect(`${JSON.stringify(result)} ${logs.join('\n')}`).toContain('CODEX_BUILD_BRIEF_ARGS_CORRUPT')
  })
})

/**
 * END-TO-END LOCKSTEP — the prompt's OWN emitted transport must assemble to the
 * prompt's OWN receipt.
 *
 * Every other by-path test checks one half against a test-built counterpart: the
 * workflow's slicing against hand-written expectations, or the wrapper's assembly
 * against a hand-written parts list. Both halves can be self-consistently wrong.
 * A one-byte slicing error — say the `\n` between the coda tail and the receipt
 * taken over `${brief}\n` — passes every existing suite and then turns EVERY live
 * build into `CODEX_BUILD_BRIEF_CORRUPT` exit 3 at deploy, which is precisely the
 * failure the pipeline cannot repair because the pipeline is what it breaks.
 *
 * So this runs the real thing: the REAL `writeBriefParts` writes the host-held part
 * files, the real workflow composes the forge:build prompt from that manifest, and
 * the prompt's chunk blocks are handed to REAL `bash`. Then the files named by the
 * prompt's own `NEUTRON_CODEX_BUILD_BRIEF_PARTS` are concatenated in the order the
 * prompt itself lists and measured against the prompt's own
 * `NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY` — byte count AND fnv32, the identical
 * comparison `codex-build.sh` makes before it will spend a token.
 *
 * The far side of the chain is already closed by `trident/codex-build.test.ts`
 * ("a >30 KB brief assembled by path reaches codex byte-identical"): ANY parts list
 * matching the receipt yields exit 0 with codex stdin byte-identical. Proving
 * prompt-emitted parts ⇒ receipt here joins launcher → prompt → wrapper → codex with
 * no agent retyping anywhere in it, so the wrapper harness is deliberately NOT
 * duplicated into this file.
 */
describe('inner-workflow.mjs — by-path transport lockstep (emitted blocks run through real bash)', () => {
  /**
   * Execute the forge:build prompt's chunk blocks and assemble exactly as the wrapper
   * will, returning the assembled brief beside the receipt the prompt itself carries.
   */
  const runEmittedTransport = (
    prompt: string,
    dir: string,
  ): { assembled: string; receipt: string; partsList: string[] } => {
    const partsMatch = /NEUTRON_CODEX_BUILD_BRIEF_PARTS='([^']*)'/.exec(prompt)
    expect(partsMatch).not.toBeNull()
    // LITERAL embedded newlines separate the ordered absolute paths.
    const partsList = String(partsMatch?.[1]).split('\n')
    const receiptMatch = /NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY='([^']*)'/.exec(prompt)
    expect(receiptMatch).not.toBeNull()
    const receipt = String(receiptMatch?.[1])

    // The two workflow-composed segments live under /tmp in the emitted prompt; the
    // host-written task/reflection parts already live in `dir`.
    const local = (p: string): string =>
      p.startsWith('/tmp/trident-codex-build-') ? join(dir, basename(p)) : p

    // Carve out the chunk-block region: from `CALL 1 of N:` up to the run command.
    const start = /^CALL 1 of (\d+):$/m.exec(prompt)
    expect(start).not.toBeNull()
    const declared = Number(start?.[1])
    const startIndex = Number(start?.index)
    const end = prompt.indexOf('\nTHEN run this ONE command', startIndex)
    expect(end).toBeGreaterThan(startIndex)
    const region = prompt.slice(startIndex, end)

    // Split on the CALL headers, NOT on blank lines — heredoc bodies contain them.
    const headers = [...region.matchAll(/^CALL \d+ of \d+:\n/gm)]
    // If a heredoc body ever contained a line that looked like a header, this parse
    // would silently mangle the transport; the prompt's own count is the check.
    expect(headers.length).toBe(declared)
    const blocks = headers.map((h, i) =>
      region.slice(
        Number(h.index) + h[0].length,
        i + 1 < headers.length ? Number(headers[i + 1]?.index) : region.length,
      ),
    )
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    for (const block of blocks) {
      expect(block.startsWith('cat ') || block.startsWith('printf ')).toBe(true)
    }

    for (const block of blocks) {
      // REMAP ONLY THE QUOTED REDIRECT TARGETS, never the block wholesale. The coda
      // that forms the `.a2` segment names `/tmp/trident-codex-build-<run>.diff` as
      // BRIEF TEXT, so a blanket path rewrite would alter the very bytes the receipt
      // covers and fail this test for a bug it does not have. The `.a1`/`.a2` paths
      // appear only as `shSingleQuote`d redirect targets, and the assembled brief is
      // asserted below to mention neither — so nothing but a target can be rewritten.
      let command = block
      for (const p of partsList) {
        if (local(p) !== p) command = command.split(`'${p}'`).join(`'${local(p)}'`)
      }
      // A chunk write that fails must fail the test loudly, not leave an empty file
      // for the receipt to blame.
      const run = spawnSync('bash', ['-c', command.endsWith('\n') ? command : `${command}\n`])
      expect(run.status).toBe(0)
    }

    const assembled = new TextDecoder().decode(
      Buffer.concat(partsList.map((p) => readFileSync(local(p)))),
    )
    // The remap could only have touched brief content if a segment path appeared
    // inside the brief; it does not, and this is what says so.
    expect(assembled).not.toContain('.brief.a1')
    expect(assembled).not.toContain('.brief.a2')
    return { assembled, receipt, partsList }
  }

  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'trident-lockstep-'))
  })
  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  })

  test('the emitted by-path transport assembles to the prompt’s own receipt (>30 KB, task only)', async () => {
    expect(new TextEncoder().encode(LARGE_TASK).length).toBeGreaterThan(30_000)
    // The launcher's REAL fs transport, not a stand-in for it.
    const parts = writeBriefParts({ runId: 'lockstep-e2e', task: LARGE_TASK, reflectionGuidance: '', dir })
    expect(parts).not.toBeNull()

    const { captured } = await runWorkflow('', { codexBuild: true, task: LARGE_TASK, briefParts: parts })
    const prompt = forgeBuildPrompt(captured)
    const { assembled, receipt, partsList } = runEmittedTransport(prompt, dir)

    expect(partsList.length).toBe(3)
    expect(partsList[0]?.endsWith('.brief.a1')).toBe(true)
    expect(partsList[1]).toBe(String(parts?.taskFile))
    expect(partsList[2]?.endsWith('.brief.a2')).toBe(true)

    // THE CANONICAL ASSERTION: byte count AND fnv32, the comparison the wrapper makes.
    expect(briefIntegrity(assembled)).toBe(receipt)
    expect(assembled).toContain('TASKBYTES_MARKER_Q9')
    expect(assembled.endsWith('\n')).toBe(true)
  })

  test('the same lockstep holds with reflection guidance carried by path', async () => {
    const parts = writeBriefParts({
      runId: 'lockstep-e2e-r',
      task: LARGE_TASK,
      reflectionGuidance: GUIDANCE,
      dir,
    })
    expect(parts).not.toBeNull()

    const { captured } = await runWorkflow(GUIDANCE, { codexBuild: true, task: LARGE_TASK, briefParts: parts })
    const prompt = forgeBuildPrompt(captured)
    const { assembled, receipt, partsList } = runEmittedTransport(prompt, dir)

    expect(partsList.length).toBe(4)
    expect(partsList[0]?.endsWith('.brief.a1')).toBe(true)
    expect(partsList[1]).toBe(String(parts?.taskFile))
    expect(partsList[2]).toBe(String(parts?.reflectionFile))
    expect(partsList[3]?.endsWith('.brief.a2')).toBe(true)

    expect(briefIntegrity(assembled)).toBe(receipt)
    expect(assembled).toContain('TASKBYTES_MARKER_Q9')
    expect(assembled).toContain(REFLECT_MARKER)
    expect(assembled.endsWith('\n')).toBe(true)
  })
})

const FORGE_LABELS = ['forge:build', 'forge:fix-round-2']
const REVIEWER_LABELS = ['argus:claude', 'argus:adversarial', 'argus:synthesis', 'argus:codex']

describe('inner-workflow.mjs — AS-BUILT reflection boundary (executed prompt capture)', () => {
  let captured: Captured[]
  beforeAll(async () => {
    captured = (await runWorkflow(GUIDANCE)).captured
  })

  test('the harness exercised every Forge and Argus role at least once', () => {
    for (const label of [...FORGE_LABELS, ...REVIEWER_LABELS]) {
      expect(captured.some((c) => c.label === label)).toBe(true)
    }
  })

  test('EVERY Forge builder prompt carries the reflection guidance, APPENDED after the task', () => {
    for (const label of FORGE_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        expect(c.prompt).toContain('<owner_reflection>')
        expect(c.prompt).toContain(REFLECT_MARKER)
        expect(c.prompt).toContain('MUST NOT override')
        // Appended: the guidance comes AFTER the task, never before the contract.
        expect(c.prompt.indexOf('<owner_reflection>')).toBeGreaterThan(c.prompt.indexOf('TASK:'))
      }
    }
  })

  test('NO reviewer/synthesis/peer prompt contains any reflection content (the merge gate)', () => {
    for (const label of REVIEWER_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        expect(c.prompt).not.toContain('owner_reflection')
        expect(c.prompt).not.toContain(REFLECT_MARKER)
        expect(c.prompt).not.toContain('always prefer TypeScript')
      }
    }
  })

  test('with NO reflection context, no prompt gains an <owner_reflection> block (clean no-op)', async () => {
    const { captured: none } = await runWorkflow(buildReflectionGuidance(null))
    for (const c of none) expect(c.prompt).not.toContain('owner_reflection')
  })
})

/**
 * PANEL COMPLETENESS, DRIVEN THROUGH THE REAL PANEL — the seat is killed by its LABEL
 * and the workflow assigns its own slot.
 *
 * The unit tests for `missingCoreReviewers` / `crossModelPeerStatus` hand them a
 * hand-built `verdicts` array, so they assert the predicates in isolation and CANNOT
 * see the one assumption the whole gate rests on: that `CORE_REVIEWER_SEATS`' hardcoded
 * slots 0 and 1 really are argus:claude and argus:adversarial in the assembled
 * `reviewers` array. Nothing else pins that. Insert a reviewer ahead of them — or
 * reorder the two — and the gate keys on the wrong seats while every unit test stays
 * green, which is the FAIL-OPEN direction: the moved seat's death stops being gated.
 * That is the same positional-indexing trap the source already calls out for codex
 * ("POSITIONAL INDEXING WAS A LATENT BUG"), and it deserves an executable guard rather
 * than a convention.
 *
 * So these run the REAL workflow body and assert on the RETURNED VERDICT: not that a
 * blocker was recorded somewhere, but that the run actually REFUSED to approve.
 */
describe('inner-workflow.mjs — AS-BUILT: a dead seat is REFUSED an APPROVE through the real panel', () => {
  test('CONTROL — every seat answers, so the run APPROVEs (the gate is not always-on)', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true })
    expect(result['verdict']).toBe('APPROVE')
    expect(result['blockKind']).toBe('none')
    // …and no seat was described to the synthesis as dead.
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).not.toContain('DID NOT COMPLETE')
  })

  test('argus:claude DIED → the run REFUSES to APPROVE, and slot 0 really is that seat', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true, dead: ['argus:claude'] })
    // THE BEHAVIOUR, not the bookkeeping: same inputs as the control, one dead seat,
    // and the answer flips from APPROVE to a refusal.
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    // …classified as a lane failure, so the fix loop does not re-Forge a dead agent —
    // and the loop exits immediately, on round 1.
    expect(result['blockKind']).toBe('infra-only')
    expect(result['round']).toBe(1)
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    // The dead seat is Verdict A, which is what pins slot 0 to argus:claude.
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): DID NOT COMPLETE')
    // The exact regression: a verdict-shaped blank a synthesis model reads as
    // "this reviewer raised nothing".
    expect(synth?.prompt).not.toContain('Verdict A (Claude rubric): null')
    // The SURVIVING seat is still reported normally — the hedge is per-seat.
    expect(synth?.prompt).toContain('Verdict B (Argus adversarial): {')
  })

  test('argus:adversarial DIED → the run REFUSES to APPROVE, and slot 1 really is that seat', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true, dead: ['argus:adversarial'] })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    expect(result['blockKind']).toBe('infra-only')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict B (Argus adversarial): DID NOT COMPLETE')
    expect(synth?.prompt).not.toContain('Verdict B (Argus adversarial): null')
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): {')
  })

  test('BOTH core seats DIED → still refused, with a blocker for each', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, {
      approveAll: true,
      dead: ['argus:claude', 'argus:adversarial'],
    })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): DID NOT COMPLETE')
    expect(synth?.prompt).toContain('Verdict B (Argus adversarial): DID NOT COMPLETE')
  })

  test('a CONFIGURED codex that DIED (and whose retry died) is refused, not read as never-configured', async () => {
    // The cross-model half of the same fix, through the real slot assignment: codexHome
    // is set, so the seat exists and its emptiness is a review we did not get. The retry
    // lane is killed too, or the round would silently heal.
    const { captured, result } = await runWorkflow(GUIDANCE, {
      approveAll: true,
      dead: ['argus:codex', 'argus:codex-retry'],
    })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    expect(result['blockKind']).toBe('infra-only')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict C (Cross-model review 1, codex): DEFERRED')
    // NOT the graceful never-set-up path, which does not block.
    expect(synth?.prompt).not.toContain('Verdict C (Cross-model review 1, codex): NOT CONNECTED')
    // The core seats answered, so only codex is hedged.
    expect(synth?.prompt).not.toContain('DID NOT COMPLETE')
  })

  test('NONE seats dispatch nothing and do not block, while a configured dead seat beside them does', async () => {
    const allOff = {
      review_rubric: { model: 'none' },
      review_adversarial: { model: 'none' },
      review_codex: { model: 'none' },
      review_kimi: { model: 'none' },
    }
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true, phaseModels: allOff })
    for (const label of ['argus:claude', 'argus:adversarial', 'argus:codex', 'argus:kimi']) {
      expect(captured.some((call) => call.label === label)).toBe(false)
    }
    expect(result['verdict']).toBe('APPROVE')
    expect(result['reviewRecord']).toContain('NO REVIEW RAN')

    const configuredButDead = { ...allOff, review_rubric: { model: 'opus' } }
    const dead = await runWorkflow(GUIDANCE, {
      approveAll: true,
      phaseModels: configuredButDead,
      dead: ['argus:claude'],
    })
    expect(dead.result['verdict']).toBe('REQUEST_CHANGES')
    expect(dead.result['reviewRecord']).toContain('1 seat(s) ran')
  })

  test('both generic cross-model slots can dispatch through the same non-Claude family', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, {
      approveAll: true,
      phaseModels: { review_codex: { model: 'k3' }, review_kimi: { model: 'k3' } },
    })
    expect(result['verdict']).toBe('APPROVE')
    for (const label of ['argus:codex', 'argus:kimi']) {
      expect(captured.find((call) => call.label === label)?.prompt).toContain('KIMI K3 CROSS-MODEL REVIEW')
    }
  })
})

/**
 * NO-PATTERN-KILL, ASSERTED ON THE COMPOSED PROMPT — not on the constant.
 *
 * A rule constant that nothing splices in is the same defect one layer up: the source
 * text `const NO_PATTERN_KILL_RULE = …` can be present and correct while a given agent
 * never receives a word of it. Only the ASSEMBLED prompt the agent is actually handed
 * proves coverage, so these run the real workflow body and assert on what `agent()`
 * was called with — the same technique the reflection-boundary suite above uses.
 *
 * This caught the real gap: argus:adversarial (a CORE reviewer seat) and both
 * cross-model bridges build their prompts INLINE rather than from `ARGUS_RUBRIC`, so
 * splicing the rule into the rubric left three command-running seats uncovered.
 *
 * Scope is "every agent that can run a shell command", because that is exactly the set
 * that can `pkill`. argus:synthesis is deliberately excluded and asserted excluded: it
 * merges verdict TEXT and is handed no tools, which is why it carries neither of the
 * two pre-existing rules either.
 */
describe('inner-workflow.mjs — AS-BUILT: every command-running agent is told not to pattern-kill', () => {
  // Verbatim fragments of the shipped rule. Retyped deliberately: reading the constant
  // out of the source and asserting the prompt contains it would pass even if the rule
  // were softened to "avoid pkill when convenient" — these pin the MEANING.
  const SHARED_BOX = 'YOU SHARE THIS MACHINE WITH OTHER BUILD LANES'
  const PROHIBITION = 'NEVER kill processes by pattern or by name'
  const CARVE_OUT = 'Kill ONLY a pid you started yourself and can name'

  /** Every seat that is handed a shell, in BOTH modes. `plan:fable` is Ralph-only. */
  const COMMAND_RUNNING_LABELS = [
    'forge:build',
    'forge:fix-round-2',
    'argus:claude',
    'argus:adversarial',
    'argus:codex',
    'argus:kimi',
  ]

  let captured: Captured[]
  let ralphCaptured: Captured[]
  beforeAll(async () => {
    captured = (await runWorkflow(GUIDANCE)).captured
    ralphCaptured = (await runWorkflow(GUIDANCE, { ralph: true })).captured
  })

  test('the harness actually dispatched every seat it claims to cover', () => {
    for (const label of COMMAND_RUNNING_LABELS) {
      expect(captured.some((c) => c.label === label)).toBe(true)
    }
    // The planner exists ONLY in Ralph mode — assert the mode really produced it,
    // or its coverage test below would vacuously pass over an empty call list.
    expect(ralphCaptured.some((c) => c.label === 'plan:fable')).toBe(true)
  })

  test('EVERY command-running prompt carries the rule, with the reason and the carve-out', () => {
    for (const label of COMMAND_RUNNING_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        // The REASON is other lanes, not the agent's own safety.
        expect(c.prompt).toContain(SHARED_BOX)
        // An ABSOLUTE prohibition, and it names the binaries by hand.
        expect(c.prompt).toContain(PROHIBITION)
        expect(c.prompt).toContain('`pkill`')
        expect(c.prompt).toContain('`killall`')
        expect(c.prompt).toContain('kill $(pgrep')
        // …but a pid-scoped kill of something the agent started is still ALLOWED,
        // or agents would be unable to stop their own background processes.
        expect(c.prompt).toContain(CARVE_OUT)
        expect(c.prompt).toContain('`$!`')
      }
    }
  })

  test('the Ralph PLANNER gets it too — the planner spawns processes like any other seat', () => {
    const plan = ralphCaptured.filter((c) => c.label === 'plan:fable')
    expect(plan.length).toBeGreaterThan(0)
    for (const c of plan) {
      expect(c.prompt).toContain(SHARED_BOX)
      expect(c.prompt).toContain(PROHIBITION)
      expect(c.prompt).toContain(CARVE_OUT)
    }
    // …and Ralph's forge:build, which is assembled through a DIFFERENT path (it gets
    // the planner's execution note appended), keeps the rule.
    const forge = ralphCaptured.filter((c) => c.label === 'forge:build')
    expect(forge.length).toBeGreaterThan(0)
    for (const c of forge) expect(c.prompt).toContain(PROHIBITION)
  })

  test('it is stated as a PROHIBITION, never softened into advice', () => {
    const forge = captured.find((c) => c.label === 'forge:build')
    expect(forge).toBeDefined()
    const prompt = String(forge?.prompt)
    // No hedge anywhere in the sentence that carries the rule.
    const sentence = prompt.slice(prompt.indexOf(SHARED_BOX), prompt.indexOf(CARVE_OUT))
    for (const hedge of ['try to avoid', 'prefer not', 'should avoid', 'if possible', 'generally']) {
      expect(sentence.toLowerCase()).not.toContain(hedge)
    }
    // And it tells the agent what to do INSTEAD, so "work around it" is the escape
    // hatch rather than killing a process it did not start.
    expect(prompt).toContain('do NOT kill it — work around it')
  })

  test('argus:synthesis is toolless, so it gets none of the three shell rules (not an omission)', () => {
    const synth = captured.filter((c) => c.label === 'argus:synthesis')
    expect(synth.length).toBeGreaterThan(0)
    for (const c of synth) {
      expect(c.prompt).not.toContain(SHARED_BOX)
      // The pre-existing rules are absent for the same reason — this is the control
      // that shows exclusion is the file's convention for a toolless seat.
      expect(c.prompt).not.toContain('NEVER call AskUserQuestion')
      expect(c.prompt).not.toContain('redirect stdout+stderr to a log file')
    }
  })
})

/**
 * The TEST EXECUTION block rides the SAME trust boundary as `reflectionGuidance`: it
 * belongs to the BUILDER (forge:build + every fix round) and must never reach the
 * independent review gate — a reviewer told how to run the suite is a reviewer that can
 * be steered by the thing it is reviewing. Asserted over the EXECUTED workflow rather
 * than the source, because the leak this catches is an aliasing one.
 */
describe('AS-BUILT: TEST EXECUTION strategy threading (executed prompt capture)', () => {
  const MARKER = 'TESTSTRAT_MARKER_Q4'
  const STRATEGY = `TEST EXECUTION\n\n${MARKER} full suite rules`
  const LEGACY_STEP_3 = 'Run the relevant tests (redirect verbose output to a log, read only the tail).'

  let captured: Captured[] = []
  beforeAll(async () => {
    // The DEFAULT (non-approveAll) run: round 1 synthesises REQUEST_CHANGES, so a real
    // forge:fix-round-* is dispatched and its prompt can be asserted.
    captured = (await runWorkflow('', { testStrategy: STRATEGY })).captured
  })

  test('the block reaches forge:build', () => {
    expect(forgeBuildPrompt(captured)).toContain(MARKER)
  })

  test('the block reaches EVERY fix round — the round that re-pays the suite', () => {
    const fixRounds = captured.filter((c) => String(c.label).startsWith('forge:fix-round-'))
    expect(fixRounds.length).toBeGreaterThan(0)
    for (const c of fixRounds) expect(c.prompt).toContain(MARKER)
  })

  test('the block reaches NO reviewer or planner prompt (the trust boundary)', () => {
    const reviewers = captured.filter(
      (c) => String(c.label).startsWith('argus:') || c.label === 'plan:fable',
    )
    for (const c of reviewers) expect(c.prompt).not.toContain(MARKER)
  })

  test('step 3 points at the block and makes the FULL suite a precondition of testsPassed=true', () => {
    const prompt = forgeBuildPrompt(captured)
    expect(prompt).not.toContain(LEGACY_STEP_3)
    expect(prompt).toContain('REQUIRED before you may report testsPassed=true')
  })

  test('with no strategy arg the contract is the LEGACY one, verbatim', async () => {
    // The byte-identical-when-absent guarantee: an instance that never derives a
    // strategy (or a repo where the derivation failed) builds exactly as before.
    const prompt = forgeBuildPrompt((await runWorkflow('')).captured)
    expect(prompt).toContain(LEGACY_STEP_3)
    expect(prompt).not.toContain('TEST EXECUTION')
  })
})
