/**
 * OFFLINE END-TO-END HARNESS FOR THE REBUILT TRIDENT DRIVER.
 *
 * WHY THIS EXISTS. The rebuilt driver has never completed a build. Three live
 * acceptance dispatches each stopped at a DIFFERENT point, and each stop was
 * only discoverable by spending a dispatch:
 *
 *   1. the admission gate discarded its cause (#1009);
 *   2. the admission gate's post-fire write clobbered the worktree the launcher
 *      had persisted (#1032);
 *   3. the plan worker's trailer was rejected — "Trailer run_id missing or
 *      mismatched." — because the brief asked for `{head, diff, pr, payload}`
 *      while `decodeProjectTrailer` requires the ENVELOPE
 *      `{schema, run_id, step_id, kind, result}` (#1033).
 *
 * Every one of them was a WIRING bug, findable offline. This file drives a
 * COMPLETE build — plan → build → review → publish → merge — through the real
 * composition, so the next one is found in a test run instead of a dispatch.
 *
 * ── WHAT IS REAL HERE ─────────────────────────────────────────────────
 *   • `prepareProjectBuild` (open/wiring/project-build.ts) builds the options.
 *   • `createProjectBuildHost` → `createBuildHost` → `buildRun` drive them.
 *   • A REAL temporary git repository with a REAL bare `origin` beside it, so
 *     admission's `git fetch`, publication's `ls-remote` /
 *     `push --force-with-lease` / witness read, `pinnedMergeReadiness`'s fetch
 *     and diff, and the merge itself are all real git against real objects.
 *   • A REAL migrated sqlite database (`tests/support/migrated-db.ts`) behind
 *     the real `TridentRunStore` and `TridentPhaseUsageStore`.
 *   • The REAL in-REPL worker transport: `createProjectRunners` →
 *     `claudeInReplRunner` → `createClaudeActingTurn` → `decodeProjectTrailer`.
 *     Nothing about the dispatch, the result file, or its decoding is stubbed.
 *   • The REAL leak preflight module, over a real throwaway git worktree.
 *   • The REAL `productionCiSource`, parsing real `gh api` JSON shapes.
 *
 * ── WHAT IS FAKE, AND EXACTLY WHERE ───────────────────────────────────
 *   1. THE MODEL TURN, at the one seam where a model actually sits:
 *      `session.child.submitLine`. `createClaudeActingTurn` hands that function
 *      the same line a live Claude REPL would receive, and `literalWorker`
 *      below reads the dispatch out of it, reads the brief and the host turn
 *      context off disk, does the role's work in the real worktree, and writes
 *      the result file. If a brief is wrong, this harness goes red exactly as
 *      the live run did — see `envelopeFieldsNamedBy`.
 *   2. THE GITHUB API (`gh`), as an in-memory PR record over the real bare
 *      origin. Everything else in `runHost` is `spawnCapture`.
 *   3. THE LEAK SCANNER ITSELF — `policy.leak.gate_script` is pointed at a
 *      two-line stub that prints the gate's own SILENT sentinel. The preflight
 *      module, its worktree provisioning and its verdict classification are
 *      real; only the ~100s scan is not.
 *
 * Everything this does NOT cover is enumerated at the bottom of this file.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentPhaseUsageStore } from '@neutronai/trident/phase-usage.ts'
import { createProjectBuildHost, type ProjectBuildOutcome } from '@neutronai/trident/project-build-host.ts'
import { spawnCapture, type HostCommandResult } from '@neutronai/trident/git-mode.ts'
import { gitRangeArgv } from '@neutronai/trident/git-range.ts'
import { workContextPath } from '@neutronai/trident/production-host-effects.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { prepareProjectBuild, type ProjectBuildContext } from '../wiring/project-build.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

// ─────────────────────────────────────────────────────────────────────────────
// THE LITERAL-MINDED WORKER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five top-level fields `decodeProjectTrailer` compares against the request
 * (`runtime/workers/project-runners.ts:48-59`). This list is the decoder's
 * vocabulary, and it is the ONLY thing this harness knows about the envelope —
 * it deliberately does not know which of them any particular brief asks for.
 */
const ENVELOPE_FIELDS = ['schema', 'run_id', 'step_id', 'kind', 'result'] as const

/**
 * WHICH TOP-LEVEL FIELDS DID THE BRIEF ACTUALLY ASK FOR?
 *
 * This is the whole point of the harness, so it is worth being precise about
 * what it models and what it does not.
 *
 * A worker writes the file its brief describes. The rule here is the most
 * literal reading of a brief there is: a field belongs in the result FILE only
 * if the brief names it, in double quotes, as a field — which is how #1033's
 * brief names them ("schema", "run_id", "step_id", "kind", "result"). The scan
 * stops at the embedded JSON payload schema, because that blob describes
 * `result.payload`, not the file, and its own keys must not be mistaken for
 * instructions about the envelope.
 *
 * When a brief names NONE of them, the only shape it has described is the inner
 * object, and that is what gets written — which is precisely what the plan
 * worker did on the third acceptance dispatch, and precisely what the host
 * rejected with "Trailer run_id missing or mismatched."
 *
 * THE LIMIT, STATED. A real model is not this literal: it also sees
 * `Request (data): {...}` in the dispatch prompt and might guess the envelope
 * from it. So a red here is "a worker that followed its brief exactly would
 * fail", not "every worker will fail". The live dispatch is the evidence that
 * the weaker claim is the one that matters: the real plan worker did follow the
 * brief exactly.
 */
export function envelopeFieldsNamedBy(brief: string): Set<string> {
  return new Set(ENVELOPE_FIELDS.filter(field => instructionsIn(brief).includes(`"${field}"`)))
}

/**
 * DATA A BRIEF CARRIES IS NOT INSTRUCTION A BRIEF GIVES.
 *
 * A role brief ends with `JSON.stringify(PLAN_SCHEMA | FORGE_SCHEMA |
 * VERDICT_SCHEMA)`, which describes `result.payload` and whose own keys must not
 * read as instructions about the file. A review-panel brief
 * (`createProjectReviewSource`) is JSON, and the measured diff it carries could
 * contain any text at all — including `"run_id"`. Both are stripped here, so a
 * brief only counts as naming a field when its prose names it.
 */
function instructionsIn(brief: string): string {
  try {
    const value: unknown = JSON.parse(brief)
    // A structured brief: only its string-valued fields are prose.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value).filter(entry => typeof entry === 'string').join('\n')
    }
  } catch { /* a role brief is prose, not JSON */ }
  return brief.split('\n\n{"type":"object"')[0] ?? brief
}

type Runner = (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<HostCommandResult>

async function gitOut(run: Runner, cwd: string, args: string[]): Promise<string> {
  const result = await run(['git', '-C', cwd, ...args], cwd)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/**
 * Reproduce the host's own diff measurement (`production-host-effects.ts:203`)
 * from inside the worker. A build worker has to: the host context it was given
 * describes the revision BEFORE its commit, and `corroborates`
 * (`build-run.ts:151`) compares its trailer against the revision the host
 * measures AFTER. Same flags, same three-dot range, same range builder.
 */
async function measureDiff(run: Runner, repo: string, base: string, head: string, scratch: string): Promise<string> {
  const output = join(scratch, `diff-${head}-${Math.random().toString(36).slice(2)}.txt`)
  const result = await run(gitRangeArgv({ repo_path: repo, subcommand: 'diff',
    flags: ['--binary', '--no-ext-diff', '--no-textconv', '--full-index', `--output=${output}`],
    base, head, dots: '...' }), repo)
  if (!result.ok) throw new Error(`worker diff measurement failed: ${result.stderr}`)
  return readFile(output, 'utf8')
}

interface WorkerWorld {
  run: Runner
  repo: string
  scratch: string
  /** Every dispatch this fake observed, in order — the harness's audit trail. */
  dispatches: { role: string; step_id: string; schema: string; wrote: string[] }[]
}

/**
 * THE ONLY FAKE MODEL IN THIS FILE.
 *
 * `createClaudeActingTurn` calls `child.submitLine` with
 *   'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify(spec)
 * and `claudeInReplRunner` composed that spec's prompt as
 *   '…Forward the arguments as data…' + JSON.stringify({ …, prompt: 'Request (data): {…}' })
 * so the request reaches this function exactly as it reaches a live worker.
 */
function literalWorker(world: WorkerWorld) {
  return async function submitLine(line: string): Promise<void> {
    const spec = JSON.parse(line.slice(line.indexOf('{')))
    const args = JSON.parse(String(spec.prompt).slice(String(spec.prompt).indexOf('{')))
    const marker = 'Request (data): '
    const requestLine = String(args.prompt).split('\n').find((row: string) => row.startsWith(marker))
    if (!requestLine) throw new Error('dispatch prompt carried no request')
    const request: BoundedWorkRequest = JSON.parse(requestLine.slice(marker.length))

    const brief = await readFile(request.brief.path, 'utf8')
    const inner = await performRole(world, request, brief)

    // Write ONLY what the brief asked for. See `envelopeFieldsNamedBy`.
    const named = envelopeFieldsNamedBy(brief)
    const envelope: Record<string, unknown> = { schema: request.result.schema, run_id: request.run_id,
      step_id: request.step_id, kind: 'completed', result: inner }
    const body = named.size === 0 ? inner : Object.fromEntries([...named].map(field => [field, envelope[field]]))
    world.dispatches.push({ role: request.role, step_id: request.step_id,
      schema: request.result.schema, wrote: Object.keys(body as object).sort() })
    // The dispatch prompt asks for a temporary file and a rename, so do that.
    await writeFile(`${request.result.path}.tmp`, JSON.stringify(body), { mode: 0o600 })
    await rename(`${request.result.path}.tmp`, request.result.path)
  }
}

/** What each role produces, done for real in the real worktree. */
async function performRole(world: WorkerWorld, request: BoundedWorkRequest, brief: string): Promise<unknown> {
  // A review-panel seat (`createProjectReviewSource`) dispatches under the bare
  // `verdict` schema, and its brief is the panel's own JSON, not a role brief.
  if (request.result.schema === 'verdict') return { verdict: 'APPROVE', findings: [] }

  // Every role brief points at the host turn context, which the host wrote in
  // `prepareWork` (`production-host-effects.ts:451`) and whose path the brief
  // itself names. That is where the measured snapshot lives.
  const context = JSON.parse(await readFile(workContextPath(request.brief.path), 'utf8'))
  const snapshot = context.snapshot as { head: string; diff: string; pr: unknown }
  const cwd = request.cwd

  if (request.role === 'plan') {
    // A plan turn writes no commit, so the measured revision is unchanged.
    const more = brief.includes('MORE TASKS')
    return { ...snapshot, payload: {
      implementationPlan: `- [ ] T1 record the note\n${more ? '- [ ] T2 record another note\n' : ''}`,
      topTask: '- [ ] T1 record the note',
      executionSpec: 'Append one line to NOTES.md and commit it.',
      complexity: 'mechanical',
      remainingTasks: more ? 1 : 0,
    } }
  }

  if (request.role === 'build' || request.role === 'fix') {
    const branch = await gitOut(world.run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Prose only, deliberately: `runMutationProofGate` exempts a prose-only diff
    // (`mutation-prover.ts:3814`), which is the one publish path that does not
    // require running a real guard/control test pair on this box.
    const notes = join(cwd, 'NOTES.md')
    const previous = await readFile(notes, 'utf8').catch(() => '')
    await writeFile(notes, `${previous}${request.step_id}\n`)
    await gitOut(world.run, cwd, ['add', '--', 'NOTES.md'])
    await gitOut(world.run, cwd, ['-c', 'user.email=w@example.invalid', '-c', 'user.name=Worker',
      '-c', 'commit.gpgsign=false', 'commit', '-m', `work: ${request.role} ${request.step_id}`])
    // Measure the produced revision exactly as the host will.
    //
    // THE BASE IS THE PRE-DISPATCH HEAD, which is the launch pin on the FIRST
    // build because `prepareProjectBuild` cut the branch at it. It would NOT be
    // the launch pin on a fix round — and the host turn context carries no
    // `base_sha`, so a fix worker has nothing to reconstruct the host's diff
    // from. That gap is recorded in the coverage list at the foot of this file.
    const head = await gitOut(world.run, world.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    const diff = await measureDiff(world.run, world.repo, snapshot.head, head, world.scratch)
    return { head, diff, pr: snapshot.pr, payload: {
      mutationClaim: null, worktreePath: cwd, branch, commitSha: head, prNumber: null,
      diffFile: '', testsPassed: true, suiteOutcome: 'passed', suiteEvidence: 'harness stub suite',
    } }
  }

  // review: read-only, so the measured revision must be the one it was handed.
  return { ...snapshot, payload: { verdict: 'APPROVE', findings: [] } }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FAKE GITHUB
// ─────────────────────────────────────────────────────────────────────────────

interface FakePr { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefName: string; baseRefName: string }

function fakeGithub(input: { origin: string; repo: string }) {
  const prs: FakePr[] = []
  const ok = (stdout = ''): HostCommandResult => ({ ok: true, exit_code: 0, stdout, stderr: '' })
  const json = (value: unknown) => ok(JSON.stringify(value))
  const headOf = async (branch: string) => {
    const result = await spawnCapture(['git', '-C', input.origin, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], input.origin)
    return result.ok ? result.stdout.trim() : ''
  }
  const project = async (pr: FakePr, fields: string[]) => {
    const all: Record<string, unknown> = { number: pr.number, state: pr.state, headRefName: pr.headRefName,
      baseRefName: pr.baseRefName, isCrossRepository: false, headRefOid: await headOf(pr.headRefName), mergeable: 'MERGEABLE' }
    return Object.fromEntries(fields.map(field => [field, all[field]]))
  }
  const checkRuns = { total_count: 1, check_runs: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  return {
    prs,
    async handle(argv: string[]): Promise<HostCommandResult> {
      const [, verb, ...rest] = argv
      if (verb === 'api') {
        const path = rest[0]!
        if (path.includes('/protection/required_status_checks')) return json({ contexts: ['test'], checks: [{ context: 'test' }] })
        if (path.includes('/rules/branches/')) return json([])
        if (path.includes('/check-runs')) return json(checkRuns)
        if (path.includes('/status')) return json({ total_count: 0, statuses: [] })
        if (/\/branches\/[^/]+$/.test(path)) return json({ protected: true })
        return { ok: false, exit_code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      }
      if (verb !== 'pr') throw new Error(`fake gh does not implement: ${argv.join(' ')}`)
      const action = rest[0]
      const fields = (rest[rest.indexOf('--json') + 1] ?? '').split(',').filter(Boolean)
      if (action === 'list') {
        const branch = rest[rest.indexOf('--head') + 1]
        const matches = prs.filter(pr => pr.headRefName === branch)
        return json(await Promise.all(matches.map(pr => project(pr, fields))))
      }
      if (action === 'view') {
        const pr = prs.find(row => row.number === Number(rest[1]))
        if (!pr) return { ok: false, exit_code: 1, stdout: '', stderr: 'no pull requests found' }
        return json(await project(pr, fields))
      }
      if (action === 'create') {
        const pr: FakePr = { number: prs.length + 1, state: 'OPEN',
          headRefName: rest[rest.indexOf('--head') + 1]!, baseRefName: rest[rest.indexOf('--base') + 1]! }
        prs.push(pr)
        return ok(`https://example.invalid/pull/${pr.number}`)
      }
      if (action === 'merge') {
        const pr = prs.find(row => row.number === Number(rest[1]))
        if (!pr) return { ok: false, exit_code: 1, stdout: '', stderr: 'no pull requests found' }
        const head = await headOf(pr.headRefName)
        if (rest[rest.indexOf('--match-head-commit') + 1] !== head) {
          return { ok: false, exit_code: 1, stdout: '', stderr: 'head commit changed' }
        }
        // A REAL fast-forward of the real base branch in the real bare origin.
        const pushed = await spawnCapture(['git', '-C', input.repo, 'push', input.origin,
          `${head}:refs/heads/${pr.baseRefName}`], input.repo)
        if (!pushed.ok) return { ok: false, exit_code: 1, stdout: '', stderr: pushed.stderr }
        pr.state = 'MERGED'
        return ok('Merged')
      }
      throw new Error(`fake gh does not implement: ${argv.join(' ')}`)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIXTURE
// ─────────────────────────────────────────────────────────────────────────────

const LEAK_GATE_STUB = '#!/usr/bin/env bash\necho "LEAK GATE: SILENT"\nexit 0\n'

async function fixture(options: { ralph?: boolean; moreTasks?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'project-build-e2e-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'code')
  const scratch = join(dir, 'scratch')
  await mkdir(scratch, { recursive: true })

  const git = async (cwd: string, args: string[]) => {
    const result = await spawnCapture(['git', '-C', cwd, ...args], cwd)
    if (!result.ok) throw new Error(`setup: git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  await spawnCapture(['git', 'init', '--bare', '--initial-branch=main', origin], dir)
  await spawnCapture(['git', 'init', '--initial-branch=main', repo], dir)
  await git(repo, ['config', 'user.email', 'harness@example.invalid'])
  await git(repo, ['config', 'user.name', 'Harness'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await mkdir(join(repo, 'scripts', 'ci'), { recursive: true })
  // The repo OPTS IN to the leak gate; `runLeakGatePreflight` probes for exactly
  // this path before it runs anything (`leak-preflight.ts:281`).
  await writeFile(join(repo, 'scripts', 'ci', 'leak-gate.sh'), LEAK_GATE_STUB, { mode: 0o755 })
  await writeFile(join(repo, 'NOTES.md'), 'seed\n')
  await writeFile(join(repo, 'IMPLEMENTATION_PLAN.md'), '- [ ] T1 record the note\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'chore: seed'])
  await git(repo, ['remote', 'add', 'origin', origin])
  await git(repo, ['push', '-u', 'origin', 'main'])
  const baseSha = await git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])

  await writeFile(join(dir, 'project-repos.json'), JSON.stringify({
    repos: [{ name: 'project', path: 'code', remote: null, ciWorkflow: 'ci.yml' }], default: 'project' }))

  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(() => db.close())
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'card', project_slug: 'project', repo_path: repo,
    task: `Record a note in NOTES.md.${options.moreTasks ? '\nMORE TASKS' : ''}`, ralph: options.ralph ?? false })
  await store.update(row.id, { merge_mode: 'pr', base_sha: baseSha })

  const github = fakeGithub({ origin, repo })
  const commands: string[][] = []
  const world: WorkerWorld = { run: spawnCapture, repo, scratch, dispatches: [] }
  const runHost = Object.assign(async (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => {
    commands.push([...argv])
    if (argv[0] === 'gh') return github.handle(argv)
    return spawnCapture(argv, cwd, env, timeout)
  }, { writesDiffOutput: true as const })
  world.run = runHost

  // The project REPL session. `spawnProjectSession` is the composition's own
  // seam; the entries it writes are the ones `prepareProjectBuild` reads back
  // (`open/wiring/project-build.ts:62-88`).
  const key = `e2e-${row.id}`
  cleanups.push(() => { pool.delete(key); supervisedBySessionKey.delete(key) })
  const session = { sessionId: 'e2e-session', cwd: dir, hasChildExited: () => false,
    child: { submitLine: literalWorker(world) }, acquireTurn: async () => () => {} }

  const context: ProjectBuildContext = {
    store, phaseUsage: new TridentPhaseUsageStore(db), runHost,
    stateRoot: join(dir, 'state'), projectDir: dir, projectId: 'e2e-project',
    provider: 'anthropic', providerSource: 'application', env: {},
    spawnProjectSession: async () => {
      supervisedBySessionKey.set(key, { substrate_instance_id: 'cc-agent-e2e', project_id: 'e2e-project',
        skip_permissions: true, extra_dirs: [dir] } as never)
      pool.set(key, Promise.resolve(session as never))
      await Promise.resolve()
    },
  }

  const input: InnerLoopInput = {
    run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'project.db'), max_rounds: 3,
    // A nonempty strategy is what makes `assessReviewSuite` actually read the
    // build's recorded claim; an empty one returns `known()` vacuously
    // (`gates/review-suite.ts:39`).
    test_strategy: 'TEST EXECUTION\n\nFull suite (stage 2), run exactly this:\n\n  true\n',
    // Only the adversarial core seat stays on; the cross-model seats need real
    // Codex and Kimi credentials, and the rubric seat adds nothing here.
    phase_models: { review_rubric: { model: 'none' }, review_codex: { model: 'none' }, review_kimi: { model: 'none' } },
  }

  const prepare = async () => {
    const options = await prepareProjectBuild(input, context, new AbortController().signal)
    // The leak SCANNER is stubbed; the preflight module around it is not.
    options.policy.leak.gate_script = join(repo, 'scripts', 'ci', 'leak-gate.sh')
    return options
  }

  return { dir, repo, origin, baseSha, store, row, input, context, prepare, github, commands, world }
}

async function drive(f: Awaited<ReturnType<typeof fixture>>, mode: 'pr' | 'ralph'): Promise<ProjectBuildOutcome> {
  const options = await f.prepare()
  const host = await createProjectBuildHost(options)
  return host.run({ mode, start: 'fresh' }, new AbortController().signal)
}

/** The outcome plus the dispatch trail — a stop is only legible with both. */
function why(f: Awaited<ReturnType<typeof fixture>>, outcome: ProjectBuildOutcome): string {
  return JSON.stringify({ outcome, dispatches: f.world.dispatches })
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('every dispatched brief states the envelope the decoder requires', async () => {
  const f = await fixture()
  const options = await f.prepare()
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const brief = await readFile(options.workers[role].request.brief.path, 'utf8')
    // THE REGRESSION TEST FOR #1033, stated as behaviour rather than as text: a
    // worker that writes exactly what the brief names must produce something the
    // decoder accepts. Reverting the brief to "Return a result object with head,
    // diff, pr and payload" empties this set and this assertion fails first.
    expect([...envelopeFieldsNamedBy(brief)].sort(), `${role} brief`).toEqual([...ENVELOPE_FIELDS].sort())
  }
}, 120_000)

test('pr mode drives plan, build, review, publish and merge to a terminal merged outcome', async () => {
  const f = await fixture()
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // The sequence actually dispatched, not merely the ending.
  const roles = f.world.dispatches.map(d => d.role)
  expect(roles.slice(0, 3)).toEqual(['plan', 'build', 'review'])
  // The review panel and its synthesis ran through the same real transport.
  expect(roles.filter(role => role === 'review').length).toBeGreaterThanOrEqual(2)
  expect(roles).toContain('synthesis')
  // Every dispatch wrote the full envelope, because every brief asked for it.
  for (const dispatch of f.world.dispatches) {
    expect(dispatch.wrote, `${dispatch.role} ${dispatch.step_id}`).toEqual([...ENVELOPE_FIELDS].sort())
  }

  // Publication and merge really happened: real push, real PR, real base move.
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).not.toBe(f.baseSha)
  expect(f.store.get(f.row.id)!.pr).toBe(1)
  expect(['cleaned', 'preserved']).toContain(outcome.cleanup.kind)
}, 300_000)

test('ralph mode with a single task reaches the same terminal merged outcome', async () => {
  const f = await fixture({ ralph: true })
  const outcome = await drive(f, 'ralph')
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(d => d.role).slice(0, 3)).toEqual(['plan', 'build', 'review'])
  // Ralph step ids carry the iteration (`build-run.ts:278`); pr mode's do not.
  expect(f.world.dispatches[0]!.step_id).toContain(':task:0:plan:0')
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

// ── THE FIRST TWO LIVE FAILURES, REPRODUCED THROUGH THE SAME DRIVER ──────────

test('an admission host exception reaches the outcome with its cause attached', async () => {
  // FAILURE 1 (#1009). The first acceptance dispatch stopped at admission, and
  // the refusal said only "Project admission host observation failed" — the
  // catch discarded `error`, so the dispatch bought a stop with no diagnosis.
  // `projectAdmission` (`gates/project-admission.ts:75`) now wraps with
  // `unknownCause`. Reverting that to a bare `catch { … }` drops the second half
  // of this assertion.
  const f = await fixture()
  const options = await f.prepare()
  const real = options.production.runHost
  options.production.runHost = Object.assign(async (argv: string[], ...rest: unknown[]) => {
    if (argv.includes('check-ref-format')) throw new Error('admission host is offline')
    return (real as Runner)(argv, ...(rest as [string?, Record<string, string>?, number?]))
  }, { writesDiffOutput: true as const }) as typeof real
  const host = await createProjectBuildHost(options)
  const outcome = await host.run({ mode: 'pr', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.phase).toBe('plan')
    expect(outcome.detail).toContain('Project admission host observation failed')
    // The cause itself — the half #1009 restored.
    expect(outcome.detail).toContain('admission host is offline')
  }
  // Admission stops before any worker is dispatched.
  expect(f.world.dispatches).toEqual([])
}, 120_000)

test('a clobbered run row stops the build and names the field that moved', async () => {
  // FAILURE 2 (#1032), AS THE DRIVER EXPERIENCED IT. The second acceptance
  // dispatch died at plan round 0 because the orchestrator's post-fire row write
  // spread the PRE-launch snapshot back over the row, putting `worktree: null`
  // over the worktree `prepareProjectBuild` had just persisted, and the driver's
  // next `row()` refused.
  //
  // WHAT THIS DOES AND DOES NOT COVER. The WRITE that clobbered the row lives in
  // `trident/orchestrator.ts`, upstream of this harness's entry point, and is
  // fixed by an injected `read_run` — that half is covered by
  // `trident/orchestrator.test.ts`, not here. What IS covered here is the
  // driver's response to the clobbered row, on the real store, and that the
  // refusal names WHICH field moved (#1031) rather than all four.
  const f = await fixture()
  const options = await f.prepare()
  await f.store.update(f.row.id, { worktree: null })
  await expect(createProjectBuildHost(options)).rejects.toThrow('initialized run with matching identity')

  // …and, exactly as the live dispatch had it, when the clobber lands AFTER the
  // host is bound and the driver's very first `row()` meets it: plan, round 0,
  // before any gate runs and before any worker is dispatched.
  const fresh = await fixture()
  const host = await createProjectBuildHost(await fresh.prepare())
  await fresh.store.update(fresh.row.id, { worktree: null })
  const outcome = await host.run({ mode: 'pr', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(fresh, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.phase).toBe('plan')
    // ONE field named, not all four (#1031). `worktree` is the field that moved;
    // `branch`, `repo_path` and `project_slug` did not, and must not appear.
    expect(outcome.detail).toContain('Build run identity changed: worktree no longer matches')
    for (const intact of ['branch', 'repo_path', 'project_slug']) expect(outcome.detail).not.toContain(intact)
  }
  expect(fresh.world.dispatches).toEqual([])
}, 180_000)

test('ralph mode with remaining tasks hands off after the build instead of merging', async () => {
  const f = await fixture({ ralph: true, moreTasks: true })
  const outcome = await drive(f, 'ralph')
  expect(outcome.kind, why(f, outcome)).toBe('continued')
  if (outcome.kind === 'continued') expect(outcome.remainingTasks).toBe(1)
  // The handoff is consumed before the iteration advances (`advanceRalph`).
  const events = f.store.stageEvents(f.row.id).filter(e => e.stage === 'build-mode-state')
  expect(JSON.parse(events.at(-1)!.meta!).iteration).toBe(1)
  expect(f.world.dispatches.map(d => d.role)).toEqual(['plan', 'build'])
}, 300_000)

/**
 * ── WHAT THIS HARNESS DOES NOT COVER ──────────────────────────────────
 *
 *  • THE MODEL. Whether a real model reads a brief the way `literalWorker`
 *    does. See `envelopeFieldsNamedBy` for the exact strength of the claim.
 *  • THE LEAK SCANNER. `scripts/ci/leak-gate.sh` itself is stubbed; only the
 *    preflight module around it runs. Findings, the fixer loop and the
 *    incomplete/skipped-rule verdicts are untested here.
 *  • THE MUTATION PROVER'S PROOF PATH. The harness's diff is prose-only, so
 *    `runMutationProofGate` takes its exemption. A real guard/control cycle
 *    spawns test processes and is not driven offline here.
 *  • REAL GITHUB. `gh` is faked. Rate limits, cross-repository PRs, branch
 *    protection variants and merge races are not exercised.
 *  • PHASE USAGE WRITES. `metadata()` is `() => undefined` in the real
 *    composition, so every worker outcome reports null usage and
 *    `recordPhaseUsage` skips the write (`build-host.ts:128`). The skip is
 *    covered; the write is not.
 *  • THE FIX AND RE-PLAN ROUNDS. The panel approves on round 1, so `work('fix')`,
 *    `checkFixLineage`, the round ceiling and the re-plan branch are not driven.
 *    A fix worker also could not reproduce the host's diff from the host turn
 *    context, which carries no launch pin — see `performRole`.
 *  • RESUME. Every case starts `fresh`; `loadResume`, `probePlan` and the
 *    crash-resume fast path are covered elsewhere.
 *  • CODEX AND KIMI SEATS, and headless placement generally: both cross-model
 *    seats are configured off.
 *  • `merge_mode: 'local'`, `mode: 'wave'` and `mode: 'bound_pr'`.
 */
