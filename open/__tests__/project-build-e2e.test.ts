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
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
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
import { buildRun, type BuildRunOutcome } from '@neutronai/trident/build-run.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { PROJECT_SESSION_ACQUIRE_TIMEOUT_MS, prepareProjectBuild, type ProjectBuildContext } from '../wiring/project-build.ts'

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
  /**
   * BLOCKING FINDINGS THIS PANEL RAISES, BY HOST ROUND (1-based; index 0 unused).
   * Every seat and the synthesis read the SAME entry for the round they were
   * dispatched at, because `reviewPanel` compares the review worker's trailer with
   * the recorded synthesis field by field (`gates/review-panel.ts:104-105`) and
   * blocks on any disagreement. `0` — including every round past the end of this
   * array — is an APPROVE with no findings.
   */
  blockersByRound: readonly number[]
  /** Keep the first finding's identity stable across rounds to exercise G070. */
  repeatFirstFinding: boolean
  /**
   * ROUNDS WHOSE VERDICT ALSO DECLARES `escalate: { kind: 'design-gap', … }`.
   * That declaration — and only that declaration, with a nonempty `whatIsMissing`
   * and a verdict that is not APPROVE (`gates/escalation.ts:85-96,140`) — is what
   * turns the panel into `{ kind: 're-plan' }` instead of `{ kind: 'fix' }`.
   */
  replanRounds: readonly number[]
  /** ROUNDS WHOSE REVIEWER AND SYNTHESIS ANSWER WITH AN UNRESOLVED COMMENT. */
  commentRounds: ReadonlySet<number>
  /** ROUNDS WHOSE ADVERSARIAL PANEL SEAT CANNOT PRODUCE A VERDICT. */
  unavailableSeatRounds: ReadonlySet<number>
  /**
   * ROLES THIS WORKER REPORTS AS BLOCKED. Every role brief sanctions exactly this:
   * `"kind" — "completed" when you finished the role, or "blocked" when you could
   * not` plus `"on"` (`open/wiring/project-build.ts:190-192`), and
   * `decodeProjectTrailer` turns it into `{ kind: 'blocked', on }`
   * (`runtime/workers/project-runners.ts:54-57`). It does no role work first,
   * because a blocked worker did none.
   */
  blockRoles: ReadonlySet<string>
  /** Every dispatch this fake observed, in order — the harness's audit trail. */
  dispatches: { role: string; step_id: string; schema: string; wrote: string[] }[]
  /** The task the host handed each build turn after planner validation. */
  selectedTasks: string[]
  /** The planner route the real driver wrote into each plan turn's context. */
  plannerChoices: string[]
}

/**
 * ONE PANEL VERDICT FOR ONE ROUND, shared by the review role, the adversarial seat
 * and the synthesis.
 *
 * `severity: 'major'` is what makes a finding BLOCKING (`review-panel.ts:107` keeps
 * everything that is not `minor`/`nit`), which is what turns the decision into
 * `{ kind: 'fix' }` (`review-panel.ts:118-121`).
 *
 * THE IDENTITY CARRIES THE ROUND. `findingIdentity` is `file:symbol:rule`
 * (`gates/escalation.ts:25-31`), and G070 blocks the run if a finding from the
 * previous panel reappears (`gates/review-progress.ts:16`). A harness whose rounds
 * all raised the same finding would therefore stop on `repeated finding` and never
 * reach a second fix — so the symbol names the round it came from.
 */
function verdictFor(world: WorkerWorld, round: number) {
  const blockers = world.blockersByRound[round] ?? 0
  return {
    verdict: world.commentRounds.has(round) ? 'COMMENT' : blockers > 0 ? 'REQUEST_CHANGES' : 'APPROVE',
    findings: Array.from({ length: blockers }, (_, index) => ({
      severity: 'major',
      title: `NOTES.md is missing the round ${round} marker (${index})`,
      evidence: `NOTES.md carries no marker for round ${round}, finding ${index}`,
      file: 'NOTES.md', symbol: world.repeatFirstFinding && index === 0 ? 'note-repeated-f0' : `note-r${round}-f${index}`,
      rule: 'harness-round-blocker', line: 1,
    })),
    ...(world.replanRounds.includes(round)
      ? { escalate: { kind: 'design-gap', whatIsMissing: `the round ${round} spec never said where the marker goes` } }
      : {}),
  }
}

/** The host round a dispatch belongs to, taken from the identity the HOST assigned:
 *  `build-run.ts:308` ends every role step id with `:${role}:${round}`. */
const roundOfStep = (step_id: string): number => Number(step_id.split(':').at(-1))

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
    const panelRound = request.result.schema === 'verdict' ? JSON.parse(brief).round as number : undefined
    const stopped = world.blockRoles.has(request.role)
      || (request.role === 'review' && panelRound !== undefined && world.unavailableSeatRounds.has(panelRound))
    const inner = stopped ? undefined : await performRole(world, request, brief)

    // Write ONLY what the brief asked for. See `envelopeFieldsNamedBy`. A blocked
    // answer OMITS `result` and ADDS `on`, exactly as the brief words it.
    const named = envelopeFieldsNamedBy(brief)
    const envelope: Record<string, unknown> = { schema: request.result.schema, run_id: request.run_id,
      step_id: request.step_id, kind: stopped ? 'blocked' : 'completed', result: inner }
    const body = named.size === 0 ? inner : {
      ...Object.fromEntries([...named].filter(field => !(stopped && field === 'result'))
        .map(field => [field, envelope[field]])),
      ...(stopped ? { on: `harness: the ${request.role} worker was stopped mid-turn` } : {}),
    }
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
  // `verdict` schema, and its brief is the panel's own JSON, not a role brief. Its
  // step id is per DIRECTORY, round and attempt (`project-review-source.ts:99`), so
  // the round comes from the brief the source wrote, not from the step id.
  if (request.result.schema === 'verdict') return verdictFor(world, JSON.parse(brief).round)

  // Every role brief points at the host turn context, which the host wrote in
  // `prepareWork` (`production-host-effects.ts:451`) and whose path the brief
  // itself names. That is where the measured snapshot lives.
  const context = JSON.parse(await readFile(workContextPath(request.brief.path), 'utf8'))
  const snapshot = context.snapshot as { head: string; diff: string; pr: unknown }
  const cwd = request.cwd

  if (request.role === 'plan') {
    // A plan turn writes no commit, so the measured revision is unchanged.
    world.plannerChoices.push(context.planner)
    if (context.planner === 'next') {
      // THE WORKER MUST NOT DO G029'S JOB. This used to read `context.committedPlan`
      // and emit the first unchecked task and the remaining count itself — so the
      // case passed whether or not `build-run.ts:438` replaced them, and a review
      // lane proved it by deleting that guard and watching the test stay green.
      //
      // The worker is a MODEL: it returns a plausible, UNTRUSTED claim, and here a
      // deliberately wrong one. Only the host's measured replacement can turn that
      // into the real task, so the assertions below now have exactly one source.
      return { ...snapshot, payload: {
        implementationPlan: 'WORKER CLAIM — not the committed plan',
        topTask: '- [ ] WORKER INVENTED a task that is not in the committed plan',
        executionSpec: 'Complete the worker-invented task',
        complexity: 'mechanical',
        remainingTasks: 99,
      } }
    }
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
    const selected = context.previous as { implementationPlan?: string; topTask?: string }
    const commitsPlan = request.role === 'build' && selected.topTask
      && selected.implementationPlan?.includes('T2 record another note')
    if (commitsPlan && selected.topTask && selected.implementationPlan) {
      world.selectedTasks.push(selected.topTask)
      await writeFile(join(cwd, 'IMPLEMENTATION_PLAN.md'),
        selected.implementationPlan.replace(selected.topTask, selected.topTask.replace('- [ ]', '- [x]')))
    }
    const branch = await gitOut(world.run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Prose only, deliberately: `runMutationProofGate` exempts a prose-only diff
    // (`mutation-prover.ts:3814`), which is the one publish path that does not
    // require running a real guard/control test pair on this box.
    const notes = join(cwd, 'NOTES.md')
    const previous = await readFile(notes, 'utf8').catch(() => '')
    await writeFile(notes, `${previous}${request.step_id}\n`)
    await gitOut(world.run, cwd, ['add', '--', 'NOTES.md',
      ...(commitsPlan ? ['IMPLEMENTATION_PLAN.md'] : [])])
    await gitOut(world.run, cwd, ['-c', 'user.email=w@example.invalid', '-c', 'user.name=Worker',
      '-c', 'commit.gpgsign=false', 'commit', '-m', `work: ${request.role} ${request.step_id}`])
    // Measure the produced revision from the only base this worker was given.
    //
    // THE BASE IS THE PRE-DISPATCH HEAD. On the FIRST build that happens to be the
    // launch pin, because `prepareProjectBuild` cut the branch at it — so the diff
    // coincides with the host's. ON A FIX ROUND IT IS NOT: the pre-dispatch head is
    // the reviewed commit, and the host still measures from `base_sha`
    // (`production-host-effects.ts:223`), so this diff covers the fix commit alone
    // while the host's covers the whole branch. The host turn context carries no
    // `base_sha` (`prepareWork` writes `{request, snapshot, previous, findings, …}`,
    // `production-host-effects.ts:453`), so a fix worker CANNOT reconstruct it.
    //
    // That is exactly the disagreement #1041 removed: the trailer is corroborated
    // on `head` and `pr`, not on diff bytes (`claimMatches`, `build-run.ts:182-186`).
    // Leaving this measurement deliberately wrong on a fix round is what gives the
    // fix-round case its teeth — restore `corroborates` there and it goes red.
    const head = await gitOut(world.run, world.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    const diff = await measureDiff(world.run, world.repo, snapshot.head, head, world.scratch)
    return { head, diff, pr: snapshot.pr, payload: {
      mutationClaim: null, worktreePath: cwd, branch, commitSha: head, prNumber: null,
      diffFile: '', testsPassed: true, suiteOutcome: 'passed', suiteEvidence: 'harness stub suite',
    } }
  }

  // review: read-only, so the measured revision must be the one it was handed. Its
  // payload must equal the recorded synthesis field for field, so both read
  // `verdictFor` at the round the host stamped into this dispatch's step id.
  return { ...snapshot, payload: verdictFor(world, roundOfStep(request.step_id)) }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FAKE GITHUB
// ─────────────────────────────────────────────────────────────────────────────

interface FakePr { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefName: string; baseRefName: string }

function fakeGithub(input: { origin: string; repo: string }) {
  const prs: FakePr[] = []
  /** `gh pr <verb>`s this fake refuses, so a case can stop the driver at a chosen
   *  point without touching the driver. Mutable so one fixture can refuse and
   *  then relent, which is what a restarted build meets. */
  const refuse = new Set<string>()
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
    prs, refuse,
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
      if (action !== undefined && refuse.has(action)) {
        return { ok: false, exit_code: 1, stdout: '', stderr: `fake gh refuses pr ${action}` }
      }
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

/**
 * THE HOST'S OWN SUITE RUN, AND WHY THIS FIXTURE PINS IT.
 *
 * G063 needs a HOST-observed suite receipt, not the builder's claim. `readCheckpoint`
 * (`open/wiring/project-build.ts:249-253`) pulls the command out of the test strategy
 * with `fullSuiteCommand`, which takes the indented lines under the exact marker
 * `Full suite (stage 2), run exactly this` (`project-build.ts:82`), runs it in the run
 * worktree, and records the process exit code. With no such marker there is no command,
 * the report is `null`, and `assessReviewSuite` returns
 * `Host-observed review suite exit code is missing or unreadable`
 * (`gates/review-suite.ts:41`) for every card — measured: that is exactly how this
 * harness failed when #1040 landed after it was written.
 *
 * PINNED, NOT AMBIENT, in two ways. The command is a script COMMITTED TO THIS
 * FIXTURE'S OWN REPO and named by a RELATIVE path, so it resolves only if the host
 * really runs it in the worktree; and its exit status is `suiteExit` and nothing
 * else, so a green receipt here is this fixture's decision rather than whatever
 * `bun test` would have done to a temporary directory.
 */
const suiteScript = (exit: number) => `#!/usr/bin/env bash\necho "HARNESS SUITE ran in $PWD"\nexit ${exit}\n`
const suiteStrategy = 'TEST EXECUTION: run the card regression.\n\n'
  + 'Full suite (stage 2), run exactly this:\n\n  bash scripts/ci/suite.sh\n'

async function fixture(options: { ralph?: boolean; moreTasks?: boolean; suiteExit?: number
  blockersByRound?: readonly number[]; replanRounds?: readonly number[]
  maxRounds?: number; mergeMode?: 'pr' | 'local'; blockRoles?: readonly string[]
  repeatFirstFinding?: boolean; commentRounds?: readonly number[]
  unavailableSeatRounds?: readonly number[] } = {}) {
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
  await writeFile(join(repo, 'scripts', 'ci', 'suite.sh'), suiteScript(options.suiteExit ?? 0), { mode: 0o755 })
  await writeFile(join(repo, 'NOTES.md'), 'seed\n')
  await writeFile(join(repo, 'IMPLEMENTATION_PLAN.md'),
    `- [ ] T1 record the note\n${options.moreTasks ? '- [ ] T2 record another note\n' : ''}`)
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
    task: `Record a note in NOTES.md.${options.moreTasks ? '\nMORE TASKS' : ''}`, ralph: options.ralph ?? false,
    // The review round ceiling is read off THIS row (`build-host.ts:140-144`), so a
    // ceiling case pins its own rather than leaning on the schema default of 8/10.
    ...(options.maxRounds === undefined ? {} : { max_rounds: options.maxRounds }) })
  await store.update(row.id, { merge_mode: options.mergeMode ?? 'pr', base_sha: baseSha })

  const github = fakeGithub({ origin, repo })
  const commands: string[][] = []
  const world: WorkerWorld = { run: spawnCapture, repo, scratch, dispatches: [],
    selectedTasks: [], plannerChoices: [],
    blockersByRound: options.blockersByRound ?? [], replanRounds: options.replanRounds ?? [],
    blockRoles: new Set(options.blockRoles ?? []), repeatFirstFinding: options.repeatFirstFinding ?? false,
    commentRounds: new Set(options.commentRounds ?? []),
    unavailableSeatRounds: new Set(options.unavailableSeatRounds ?? []) }
  const runHost = Object.assign(async (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => {
    commands.push([...argv])
    if (argv[0] === 'gh') return github.handle(argv)
    return spawnCapture(argv, cwd, env, timeout)
  }, { writesDiffOutput: true as const })
  world.run = runHost

  // The project REPL session. `spawnProjectSession` is the composition's own
  // seam; the entries it writes are the ones `prepareProjectBuild` reads back
  // (`open/wiring/project-build.ts:214-251`).
  const key = `e2e-${row.id}`
  cleanups.push(() => { pool.delete(key); supervisedBySessionKey.delete(key) })
  const session = { sessionId: 'e2e-session', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: dir, hasChildExited: () => false,
    child: { submitLine: literalWorker(world) }, acquireTurn: async () => () => {} }

  const register = (registration: { key?: string; projectId?: string; instanceId?: string
    state?: 'ready' | 'pending' | 'missing' | 'empty' | 'exited' } = {}) => {
    const sessionKey = registration.key ?? key
    cleanups.push(() => { pool.delete(sessionKey); supervisedBySessionKey.delete(sessionKey) })
    supervisedBySessionKey.set(sessionKey, {
      substrate_instance_id: registration.instanceId ?? 'cc-agent-e2e',
      project_id: registration.projectId ?? 'e2e-project',
      skip_permissions: true, extra_dirs: [dir],
    } as never)
    if (registration.state === 'missing') { pool.delete(sessionKey); return }
    pool.set(sessionKey, registration.state === 'pending' ? new Promise(() => {})
      : Promise.resolve((registration.state === 'empty' ? undefined
        : registration.state === 'exited' ? { ...session, hasChildExited: () => true } : session) as never))
  }

  const context: ProjectBuildContext = {
    store, phaseUsage: new TridentPhaseUsageStore(db), runHost, runSuite: runHost,
    stateRoot: join(dir, 'state'), projectDir: dir, projectId: 'e2e-project',
    provider: 'anthropic', providerSource: 'application', env: {},
    spawnProjectSession: async () => {
      register()
      await Promise.resolve()
    },
  }

  const input: InnerLoopInput = {
    run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'project.db'), max_rounds: 3,
    // A nonempty strategy is what makes `assessReviewSuite` actually read the
    // build's recorded claim; an empty one returns `known()` vacuously
    // (`gates/review-suite.ts:39`). The stage-2 block is what gives the host a
    // command to run for its own receipt — see `suiteStrategy`.
    test_strategy: suiteStrategy,
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

  return { dir, repo, origin, baseSha, db, store, row, input, context, prepare, github, commands, world, register, key }
}

async function drive(f: Awaited<ReturnType<typeof fixture>>, mode: 'pr' | 'ralph'): Promise<ProjectBuildOutcome> {
  const options = await f.prepare()
  const host = await createProjectBuildHost(options)
  return host.run({ mode, start: 'fresh' }, new AbortController().signal)
}

/**
 * ONE DRIVER PROCESS THAT DOES NOT LIVE TO CLEAN UP.
 *
 * `createProjectBuildHost(...).run` wraps every build in `withProductionCleanup`
 * (`project-build-host.ts:104-112`), whose `finally` removes the worktree and
 * deletes the branch. A gateway that is KILLED mid-run never reaches that finally,
 * and the whole point of resume is what the next process finds on disk — so this
 * drives the same `buildRun` state machine over the same real `host.deps` and
 * `host.workers` and simply stops when the driver returns.
 *
 * The four fields below are the ONLY thing reconstructed here; they are exactly
 * what `project-build-host.ts:107` passes, read from the same places.
 */
async function driveUntilTheProcessDies(f: Awaited<ReturnType<typeof fixture>>, start: 'fresh' | 'resume'): Promise<BuildRunOutcome> {
  const host = await createProjectBuildHost(await f.prepare())
  return buildRun({ mode: 'pr', start, run_id: f.row.id, workers: host.workers,
    repl_provider: 'anthropic', merge_mode: f.store.get(f.row.id)!.merge_mode },
  host.deps, new AbortController().signal)
}

/** The state a restarted driver actually reads back (`production-host-effects.ts:235`). */
function lastCheckpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const events = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
  return JSON.parse(events.at(-1)!.meta!).checkpoint as Record<string, unknown>
}

/** The outcome plus the dispatch trail — a stop is only legible with both. */
function why(f: Awaited<ReturnType<typeof fixture>>, outcome: BuildRunOutcome | ProjectBuildOutcome): string {
  return JSON.stringify({ outcome, dispatches: f.world.dispatches })
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TESTS
// ─────────────────────────────────────────────────────────────────────────────

// Acquisition is driven through the same composed host as the successful build.
//
// EVERY DETAIL HERE IS DISTINCT, AND THAT IS THE ASSERTION (#1085). Three of these
// shapes — `missing`, `ambiguous-before`, `ambiguous-after` — used to answer with one
// string, "Project conversation session is missing or ambiguous". That string is the
// ONLY thing an operator receives: it travels out as the run's uncertainty detail via
// `runtime/workers/project-runners.ts`. So an instance that had lost its project REPL
// and an instance that was spawning two of them under one project id were, on the
// wire, the same event — and the acts they call for are opposites. The table pins the
// strings; `acquisitionDetails` below pins that no two of them are equal, so a future
// edit cannot quietly re-merge them and stay green.
const acquisitionCases = [
  ['missing', 'Project conversation session was NOT created: the spawn for project id "e2e-project" returned without error (none existed) and no live cc-agent session exists for it'],
  ['ambiguous-before', 'Project conversation session is AMBIGUOUS: 2 live cc-agent sessions carry project id "e2e-project"'],
  ['ambiguous-after', 'Project conversation session is AMBIGUOUS after a spawn: 2 live cc-agent sessions carry project id "e2e-project"'],
  ['reject', 'Project conversation session could not be started (none existed): start failed'],
  ['missing-pool', 'Project conversation is not ready'],
  ['pending', 'Project conversation is not ready'],
  ['empty', 'Project conversation child is unavailable'],
  ['exited', 'Project conversation child is unavailable'],
] as const

test('#1085 — the acquisition failures that call for different acts carry different strings', () => {
  // `missing-pool`/`pending` and `empty`/`exited` legitimately pair up: each pair is
  // one fact about one session reached two ways. The three that must NOT pair are the
  // ones about how many sessions exist.
  const distinct = ['missing', 'ambiguous-before', 'ambiguous-after', 'reject']
    .map(shape => acquisitionCases.find(([s]) => s === shape)![1])
  expect(new Set(distinct).size).toBe(distinct.length)
  // And each says WHICH of the two counts it saw, so the string is actionable rather
  // than merely unique.
  expect(distinct[0]).toContain('NOT created')
  expect(distinct[1]).toContain('AMBIGUOUS: 2')
  expect(distinct[2]).toContain('AMBIGUOUS after a spawn: 2')
})

for (const [shape, detail] of acquisitionCases) {
  test(`session acquisition: ${shape} stops as unknown before dispatch`, async () => {
    const f = await fixture()
    let spawns = 0
    const ambiguous = () => { f.register(); f.register({ key: `${f.key}-second` }) }
    if (shape === 'ambiguous-before') ambiguous()
    f.context.spawnProjectSession = async projectId => {
      expect(projectId).toBe(f.context.projectId)
      spawns++
      if (shape === 'reject') throw new Error('start failed')
      if (shape === 'ambiguous-after') ambiguous()
      if (shape === 'missing-pool') f.register({ state: 'missing' })
      if (shape === 'pending' || shape === 'empty' || shape === 'exited') f.register({ state: shape })
    }
    const outcome = await drive(f, 'pr')
    expect(outcome).toMatchObject({ kind: 'unknown', phase: 'plan',
      detail: `Dispatch turn completion unknown: ${detail}` })
    expect(spawns).toBe(shape === 'ambiguous-before' ? 0 : 1)
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  }, 30_000)
}

for (const state of ['ready', 'exited', 'rekeyed'] as const) {
  test(`session acquisition: ${state} session reaches merge`, async () => {
    const f = await fixture()
    // An adopted session can have a different map key. Selection uses its options.
    f.register({ key: state === 'rekeyed' ? `${f.key}-adopted` : f.key,
      state: state === 'exited' ? 'exited' : 'ready' })
    // Both filter clauses must exclude unrelated live sessions.
    f.register({ key: `${f.key}-other-project`, projectId: 'other-project' })
    f.register({ key: `${f.key}-other-substrate`, instanceId: 'cc-compose-e2e' })
    let spawns = 0
    f.context.spawnProjectSession = async () => { spawns++; f.register() }
    const outcome = await drive(f, 'pr')
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(spawns).toBe(state === 'exited' ? 1 : 0)
    expect(f.world.dispatches[0]?.role).toBe('plan')
  }, 120_000)
}

test('session acquisition: hung prewarm expires and late completion never dispatches', async () => {
  const f = await fixture()
  let release!: () => void
  let started = false
  f.context.spawnProjectSession = () => {
    started = true
    return new Promise<void>(resolve => { release = resolve })
  }
  const host = await createProjectBuildHost(await f.prepare())
  const controller = new AbortController()
  const nativeTimeout = globalThis.setTimeout
  // Accelerate only the acquisition clock; keep the real worker wall and host intact.
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(callback, ms === PROJECT_SESSION_ACQUIRE_TIMEOUT_MS ? 20 : ms, ...args)
  ) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout')
  const watchdog = nativeTimeout(() => controller.abort(), 2_000)
  try {
    expect(PROJECT_SESSION_ACQUIRE_TIMEOUT_MS).toBe(35_000)
    const outcome = await host.run({ mode: 'pr', start: 'fresh' }, controller.signal)
    expect(started).toBe(true)
    expect(outcome).toMatchObject({ kind: 'unknown', phase: 'plan',
      // The timeout names the budget it blew AND what it was trying to repair, so a
      // reader can tell a cold first spawn from a respawn after a death (#1085).
      detail: `Dispatch turn completion unknown: Project conversation session acquisition timed out after ${PROJECT_SESSION_ACQUIRE_TIMEOUT_MS}ms (none existed)` })
    const timerIndex = clock.mock.calls.findIndex(call => call[1] === PROJECT_SESSION_ACQUIRE_TIMEOUT_MS)
    expect(timerIndex).toBeGreaterThanOrEqual(0)
    const acquisitionTimer = clock.mock.results[timerIndex]!.value
    expect(clear.mock.calls.some(([handle]) => handle === acquisitionTimer)).toBe(true)
    f.register()
    release()
    await new Promise(resolve => nativeTimeout(resolve, 50))
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  } finally {
    release?.()
    controller.abort()
    clearTimeout(watchdog)
    clock.mockRestore()
    clear.mockRestore()
  }
}, 30_000)

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

  // G063's receipt is the HOST'S OWN suite run (#1040), not the builder's claim:
  // once, in the run worktree, of the command the strategy named.
  //
  // Matched by CONTENT, not by exact argv. The host no longer passes the bare
  // command: it wraps it so the child's stdout and stderr are redirected to the
  // run's own log instead of being captured into gateway memory, which the gateway
  // never reads and which `run-tests.sh` makes unbounded. An equality assertion here
  // pinned the WRAPPER's shape as if it were the contract; what this case actually
  // owns is that the named command ran exactly once, in the worktree.
  const suiteRuns = f.commands.filter(argv =>
    argv[0] === 'bash' && argv[1] === '-lc' && (argv[2] ?? '').includes('bash scripts/ci/suite.sh'))
  expect(suiteRuns).toHaveLength(1)
  // And the transcript is redirected away from the gateway rather than captured.
  expect(suiteRuns[0]![2]).toMatch(/>>.*suite-round-\d+\.log.* 2>&1/)

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

test('ralph continuation probes the committed plan and selects its next unchecked task', async () => {
  const f = await fixture({ ralph: true, moreTasks: true })

  // Keep the first process's worktree and mode checkpoint, as a real process exit
  // would, then construct a fresh composed host over those durable artifacts.
  const firstHost = await createProjectBuildHost(await f.prepare())
  const first = await buildRun({ mode: 'ralph', start: 'fresh', ralphRound: 0,
    run_id: f.row.id, workers: firstHost.workers, repl_provider: 'anthropic', merge_mode: 'pr' },
  firstHost.deps, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('continued')
  expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note'])

  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'ralph', start: 'resume' }, new AbortController().signal)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'publish' })
  expect(f.world.dispatches[0]).toMatchObject({ role: 'plan', step_id: `${f.row.id}:task:1:plan:0` })
  expect(f.world.plannerChoices).toEqual(['full', 'next'])
  expect(f.world.selectedTasks).toEqual([
    '- [ ] T1 record the note',
    '- [ ] T2 record another note',
  ])
}, 300_000)

// ── FIX ROUNDS ───────────────────────────────────────────────────────────────

test('a REQUEST_CHANGES panel dispatches a fix worker and the re-review merges', async () => {
  // THE ROUND THE DRIVER SPENDS MOST OF ITS LIFE IN, and the first case here that
  // reaches `work('fix')`, `checkFixLineage`, `reviewProgress` and a second pass
  // through publication.
  const f = await fixture({ blockersByRound: [0, 1] })
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // The exact sequence, not merely the ending. `work('review')` dispatches the
  // review ROLE first; `reviewGate` then reads the adversarial seat and the
  // synthesis through the same transport (`gates/review-panel.ts:85,99`).
  expect(f.world.dispatches.map(d => d.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
    'fix', 'review', 'review', 'synthesis',
  ])
  // The fix carries the host's round-1 identity (`build-run.ts:308`).
  const fix = f.world.dispatches.find(dispatch => dispatch.role === 'fix')!
  expect(fix.step_id).toBe(`${f.row.id}:fix:1`)
  expect(fix.schema).toBe('project-build')
  // Every dispatch still wrote the whole envelope, fix and second panel included.
  for (const dispatch of f.world.dispatches) {
    expect(dispatch.wrote, `${dispatch.role} ${dispatch.step_id}`).toEqual([...ENVELOPE_FIELDS].sort())
  }

  // THE FIX COMMIT IS WHAT LANDED. Three notes reached the base branch: the seed,
  // the round-0 build and the round-1 fix — so the merged revision is the FIXED
  // one, not the reviewed-then-rejected one.
  // (`spawnCapture` trims its stdout — `trident/git-mode.ts:1223` — so the file's
  // real trailing newline is not part of this comparison.)
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:fix:1`)

  // The driver recorded the rejection BEFORE dispatching the fix, and the fix
  // before the approval (`build-run.ts:553`, `:399`, `:560`).
  const stages = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
    .map(event => JSON.parse(event.meta!).checkpoint.stage)
  expect(stages.filter((stage, index) => stage !== stages[index - 1]))
    .toEqual(['built', 'rejected', 'fixed', 'approved'])

  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a COMMENT panel stops as an unresolved verdict and never merges', async () => {
  const f = await fixture({ commentRounds: [1] })
  const outcome = await drive(f, 'pr')
  expect(outcome, why(f, outcome)).toMatchObject({
    kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'Review has an unresolved verdict without nonblocking findings',
  })
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review', 'synthesis'])
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toEqual([])
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('an unavailable panel seat stops by configured seat and never synthesizes or merges', async () => {
  const f = await fixture({ unavailableSeatRounds: [1] })
  const outcome = await drive(f, 'pr')
  expect(outcome, why(f, outcome)).toMatchObject({
    kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'Review seat review_adversarial (anthropic) is unavailable',
  })
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review'])
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'synthesis')).toBe(false)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'fix')).toBe(false)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('a design-gap escalation re-plans and rebuilds instead of dispatching a fix', async () => {
  // THE RE-PLAN BRANCH (`build-run.ts:564-574`). The panel reaches it only through a
  // valid self-declared claim: `escalate.kind === 'design-gap'`, a nonempty
  // `whatIsMissing`, a verdict that is not APPROVE, and no re-plan already spent
  // (`gates/escalation.ts:85-96,140`). It then runs plan AND build again rather
  // than a fix, which is the whole difference between the two branches.
  const f = await fixture({ blockersByRound: [0, 1], replanRounds: [1] })
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
    'plan', 'build', 'review', 'review', 'synthesis',
  ])
  // NO fix worker ran, and the replacement pair carries round 1's identity.
  expect(f.world.dispatches.map(dispatch => dispatch.step_id).filter(id => id.startsWith(f.row.id)))
    .toEqual([`${f.row.id}:plan:0`, `${f.row.id}:build:0`, `${f.row.id}:review:1`,
      `${f.row.id}:plan:1`, `${f.row.id}:build:1`, `${f.row.id}:review:2`])

  // What landed is the REBUILD on top of the reviewed commit, not a fix.
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:build:1`)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a second unconverged round stops at the row-configured ceiling, not at a verdict', async () => {
  // G071 AND THE CEILING, TOGETHER. Round 1 raises two blockers and round 2 raises
  // one: `reviewProgress` allows the second round because the count strictly fell
  // (`gates/review-progress.ts:20`) and the identities differ, so the run reaches
  // `round >= maxRounds` with work still outstanding (`build-run.ts:576`) instead of
  // being stopped earlier by progress arithmetic. The cap is this ROW's
  // (`build-host.ts:140-144`), pinned here at 2.
  const f = await fixture({ blockersByRound: [0, 2, 1], maxRounds: 2 })
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('blocked')
  if (outcome.kind === 'blocked') {
    expect(outcome.on).toBe('Review requires orchestrator arbitration: round ceiling')
    expect(outcome.phase).toBe('review')
    expect(outcome.recipient).toBe('orchestrator')
  }
  // Exactly one fix ran — the round-1 one. Round 2 was rejected and then stopped.
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix').map(d => d.step_id))
    .toEqual([`${f.row.id}:fix:1`])
  // The rejection is recorded BEFORE the ceiling stop, so the orchestrator resumes
  // from a row that knows round 2 was rejected (`build-run.ts:548-555`).
  const last = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state').at(-1)!
  expect(JSON.parse(last.meta!).checkpoint.stage).toBe('rejected')
  expect(JSON.parse(last.meta!).checkpoint.round).toBe(2)
  // Nothing merged: the PR was published for review but the base never moved.
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('a finding repeated after a fix stops before another fix is dispatched', async () => {
  const f = await fixture({ blockersByRound: [0, 2, 1], repeatFirstFinding: true })
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('blocked')
  if (outcome.kind === 'blocked') {
    expect(outcome.on).toBe('Review requires orchestrator arbitration: repeated finding')
    expect(outcome.phase).toBe('review')
    expect(outcome.recipient).toBe('orchestrator')
  }
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix').map(d => d.step_id))
    .toEqual([`${f.row.id}:fix:1`])
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'rejected', round: 2 })
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 300_000)

// ── RESUME ACROSS A DRIVER RESTART ───────────────────────────────────────────

test('a driver restarted between the build and review re-adopts the build instead of redoing it', async () => {
  // GATEWAY RESTARTS HAPPEN MID-RUN, and a build is the most expensive thing to
  // redo. What the next process has is the run row, the mode-state checkpoint and
  // the previous process's worker result files — nothing else.
  const f = await fixture()

  // ── PROCESS 1: plan, build, then the publication the restart interrupts.
  f.github.refuse.add('create')
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('unknown')
  if (first.kind === 'unknown') expect(first.phase).toBe('publish')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['plan', 'build'])

  // The exact state the restart will find. `pending` MUST be absent: a checkpoint
  // that still names a running turn is settled by its host, never re-dispatched
  // (`build-run.ts:239-243`), and that is the other resume case below.
  const built = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/trident/card'], f.repo)
  expect(lastCheckpoint(f)).toEqual({ head: built.stdout, stage: 'built', round: 1,
    replansUsed: 0, previousFindings: [], previousBlockingCount: 0, findings: [], pending: undefined })

  // …and the build worker's result file, which the next process reads back as the
  // suite checkpoint for this revision (`open/wiring/project-build.ts:243-247`).
  const buildResult = JSON.parse(await readFile(join(f.dir, 'state', f.row.id, 'build.result'), 'utf8'))
  expect(buildResult.step_id).toBe(`${f.row.id}:build:0`)
  expect(buildResult.result.head).toBe(built.stdout)

  // ── PROCESS 2: a brand-new prepare, host and driver over the same row and disk.
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  const host = await createProjectBuildHost(await f.prepare())
  const outcome = await host.run({ mode: 'pr', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // RE-ADOPTED, NOT REDONE: no plan and no build in the second process, and the
  // review it did run is round 1 — the round the first process had reached.
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'review', 'synthesis'])
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:review:1`)
  // The merged revision is the one process 1 built: one note, not two.
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0`)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a driver resumed after the branch head moved rebuilds instead of adopting the moved revision', async () => {
  const f = await fixture()

  // PROCESS 1 reaches a durable built checkpoint, then dies while publishing.
  f.github.refuse.add('create')
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('unknown')
  if (first.kind === 'unknown') expect(first.phase).toBe('publish')
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', round: 1 })

  // While the driver is down, another writer advances the assigned branch. The
  // resume checkpoint still names process 1's build, not this new revision.
  const worktree = f.store.get(f.row.id)!.worktree!
  await writeFile(join(worktree, 'MOVED.md'), 'advanced while driver was down\n')
  await gitOut(f.world.run, worktree, ['add', 'MOVED.md'])
  await gitOut(f.world.run, worktree, ['commit', '-m', 'advance assigned branch'])
  const moved = await gitOut(f.world.run, f.repo, ['rev-parse', 'refs/heads/trident/card'])
  expect(moved).not.toBe(checkpoint.head)

  // PROCESS 2 must rebuild from the newly measured revision. Re-adopting it would
  // skip both these turns and send someone else's unbuilt commit straight to review.
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'pr', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
  ])
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:plan:1`)
  expect(f.world.dispatches[1]!.step_id).toBe(`${f.row.id}:build:1`)

  const mergedMove = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:MOVED.md'], f.origin)
  expect(mergedMove.stdout).toBe('advanced while driver was down')
  const mergedNotes = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(mergedNotes.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:build:1`)
}, 300_000)

test('a driver restarted during a worker turn refuses to re-fire it', async () => {
  // THE OTHER HALF OF THE CONTRACT. `work()` writes `pending` BEFORE it dispatches
  // (`build-run.ts:313`), so a process that dies inside a turn leaves a checkpoint
  // naming a turn whose outcome nobody observed. Re-dispatching it would run the
  // same step id twice; the driver instead returns `unknown` with that identity
  // preserved, for the orchestrator to settle (`build-run.ts:239-243`).
  // PROCESS 1 stops INSIDE the review turn: the worker reports `blocked`, which is
  // what every role brief tells it to do when it cannot finish. The driver has
  // already written `pending` and nothing on that path clears it.
  const f = await fixture({ blockRoles: ['review'] })
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('blocked')
  if (first.kind === 'blocked') expect(first.on).toBe('harness: the review worker was stopped mid-turn')
  // The blocked answer really went through the decoder as a blocked envelope.
  expect(f.world.dispatches.at(-1)!.wrote).toEqual(['kind', 'on', 'run_id', 'schema', 'step_id'])
  expect(lastCheckpoint(f).pending).toEqual({ phase: 'review', step_id: `${f.row.id}:review:1` })

  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'pr', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.detail).toBe('Resume awaits the existing worker observation')
    // The identity is PRESERVED, which is what lets the orchestrator settle it.
    expect(outcome.phase).toBe('review')
    expect(outcome.step_id).toBe(`${f.row.id}:review:1`)
  }
  // Nothing was dispatched by the second process, and the PR process 1 opened for
  // review is untouched — no merge, no second PR.
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 300_000)

test('a driver resumed from a rejected checkpoint dispatches the deferred fix', async () => {
  const f = await fixture({ blockersByRound: [0, 1], maxRounds: 1 })

  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('blocked')
  if (first.kind === 'blocked') expect(first.on).toBe('Review requires orchestrator arbitration: round ceiling')
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'rejected', round: 1 })
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toEqual([])

  f.db.raw().query('UPDATE code_trident_runs SET max_rounds = ? WHERE id = ?').run(3, f.row.id)
  f.input.run = f.store.get(f.row.id)!
  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'pr', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'fix', 'review', 'review', 'synthesis',
  ])
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:fix:1`)
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:fix:1`)
}, 300_000)

// ── LOCAL MERGE MODE ─────────────────────────────────────────────────────────

test('local merge mode reaches merged with no PR, no push and no gh call', async () => {
  // `merge_mode` DEFAULTS TO 'local' (`trident/store.ts:867`), and nothing here had
  // ever driven it. It could not reach review at all: `reviewCi`'s project source
  // reads its rows off `snapshot.pr`, which is `null` by construction for a local
  // run, so G055 answered `unknown` — fail-closed — for every local build. That is
  // the fix this case guards; see `build-host.ts`'s `reviewCi`.
  const f = await fixture({ mergeMode: 'local' })
  const outcome = await drive(f, 'pr')
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review', 'synthesis'])

  // NOTHING WENT TO GITHUB. No PR record, and — the stronger claim — the driver
  // never invoked `gh` at all, so the mode is genuinely offline-by-construction
  // rather than merely tolerant of a fake that answered.
  expect(f.github.prs).toEqual([])
  expect(f.commands.filter(argv => argv[0] === 'gh')).toEqual([])
  // Nor did it push: `origin/main` and the branch on the origin are untouched.
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
  const originBranch = await spawnCapture(['git', '-C', f.origin, 'rev-parse', '--verify', 'refs/heads/trident/card'], f.origin)
  expect(originBranch.ok).toBe(false)

  // THE LOCAL BASE MOVED, by a real merge commit with the reviewed head as a
  // parent, and the branch survives it (`mergeLocalReviewed` keeps the branch).
  const localMain = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/main'], f.repo)
  expect(localMain.stdout).not.toBe(f.baseSha)
  const parents = await spawnCapture(['git', '-C', f.repo, 'rev-list', '--parents', '-n', '1', 'refs/heads/main'], f.repo)
  const built = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/trident/card'], f.repo)
  expect(parents.stdout.split(' ').slice(1)).toEqual([f.baseSha, built.stdout])
  const notes = await spawnCapture(['git', '-C', f.repo, 'show', 'refs/heads/main:NOTES.md'], f.repo)
  expect(notes.stdout).toBe(`seed\n${f.row.id}:build:0`)
  // Local cleanup runs `keep-branch` (`production-host-effects.ts:427`), so the
  // branch itself survives — asserted on the ref, not on the script's prose.
  expect(built.ok).toBe(true)
  expect(outcome.cleanup.kind).toBe('cleaned')
  expect(outcome.cleanup.detail).not.toContain('DELETED branch')
}, 300_000)

/**
 * ── WHAT THIS HARNESS DOES NOT COVER ──────────────────────────────────
 *
 *  • REAL SESSION STARTUP AND RESTART. Acquisition shapes are injected; actual
 *    prewarm, process creation, and boot adoption are not executed.
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
 *  • THE PANEL'S OTHER STOPS. `blockersByRound` drives `fix`, `re-plan` and the
 *    round ceiling and G070's repeated-finding stop; separate cases drive a
 *    `COMMENT` verdict and an `unavailable` seat. A seat that remains `deferred`,
 *    or a synthesis that disagrees with the review worker's trailer, is not driven.
 *    Every ordinary round here raises fresh identities. `resumeFix` (the fix
 *    dispatched from a RESUMED rejection, `build-run.ts:461-472`) is driven
 *    alongside the fresh fix path.
 *  • THE REST OF RESUME. The cases here resume `built`, `pending`, `rejected` and
 *    `ralph-task-built` checkpoints. An `approved` checkpoint and a regenerated
 *    diff that disagrees with the measurement are not driven.
 *  • CODEX AND KIMI SEATS, and headless placement generally: both cross-model
 *    seats are configured off.
 *  • `mode: 'wave'` and `mode: 'bound_pr'`.
 *  • LOCAL MODE'S REFUSALS. The local case merges; `localMergeReadiness`'s dirty
 *    worktree, base-drift overlap, moved-branch and non-isolated-worktree stops
 *    are not driven, nor is `confirmLocalMerge` failing after a merge.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A DISPATCH SEAM THAT NEVER RETURNS MUST STOP AT THE WORKER WALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THESE EXIST, AND WHAT THEY RULED OUT.
 *
 * Two live acceptance runs parked in `forge-init` immediately after
 * `build-work-prepared`, with no failure and no subagent, and the first reading
 * was that the plan step's 15-minute wall had not fired — `last_advanced_at` was
 * frozen 18 minutes deep and no stage event had followed.
 *
 * These three cases hang each seam between `build-work-prepared` and the worker's
 * result, one at a time, on a 1.5s wall:
 *
 *   • `submitLine`   — the herdr RPC never acknowledges the dispatch line;
 *   • `acquireTurn`  — the session's turn mutex is never granted;
 *   • silent worker  — the line lands and no result file is ever written.
 *
 * All three stop, in ~1.6s, as a measured `unknown` naming which seam it was. So
 * the wall DOES fire, the dispatch path IS bounded, and a park cannot be produced
 * here — which is what moved the investigation downstream, to what the LAUNCHER
 * does with an `unknown` (`trident/project-launcher.ts`) rather than to what the
 * dispatch does. Keep these: they are the control that says a future park is not
 * in this path.
 *
 * WHAT THEY DO NOT COVER: a seam that hangs the event loop itself, and the real
 * herdr transport. Both are faked here by construction.
 */
function registerSession(f: Awaited<ReturnType<typeof fixture>>, session: Record<string, unknown>) {
  supervisedBySessionKey.set(f.key, { substrate_instance_id: 'cc-agent-e2e',
    project_id: 'e2e-project', skip_permissions: true, extra_dirs: [f.dir] } as never)
  pool.set(f.key, Promise.resolve(session as never))
  cleanups.push(() => { pool.delete(f.key); supervisedBySessionKey.delete(f.key) })
}

const neverSettles = () => new Promise<never>(() => {})

for (const seam of ['submitLine', 'acquireTurn', 'silent-worker'] as const) {
  test(`a hung ${seam} stops the plan step at its wall as a measured unknown`, async () => {
    const f = await fixture()
    const options = await f.prepare()
    // The real wall is 15 minutes (`PROJECT_BUILD_WALL_MS.plan`); only its LENGTH is
    // shortened here, not the mechanism that enforces it.
    options.workers.plan.request = { ...options.workers.plan.request, budget: { wall_ms: 1_500 } }
    registerSession(f, {
      sessionId: 'e2e-session', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: f.dir, hasChildExited: () => false,
      child: { submitLine: seam === 'submitLine' ? neverSettles : async () => {} },
      acquireTurn: seam === 'acquireTurn' ? neverSettles : async () => () => {},
    })
    const host = await createProjectBuildHost(options)
    // IT STOPS is the load-bearing half, and the TEST TIMEOUT is what asserts it.
    // A wall-clock `expect(elapsed).toBeLessThan(...)` here would be a second, worse
    // instrument for the same contract: it reddens when the runner is loaded rather
    // than when the code is wrong, and it cannot fire at all in the case that matters
    // — a genuine park never reaches the assertion. The 60s timeout on this test does
    // fire, and was observed doing so: forcing both walls to an hour (the control for
    // this case) fails it with `timed out after 60000ms`.
    const outcome = await host.run({ mode: 'pr', start: 'fresh' }, new AbortController().signal)
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'unknown', phase: 'plan' })
    // WHICH uncertainty is deliberately not pinned. `claudeInReplRunner`'s dispatch
    // wall (`claude-in-repl.ts:76`) and `createClaudeActingTurn`'s own
    // (`claude-acting-turn.ts:73`) are armed from the SAME budget microseconds apart,
    // so either may win the race and each words its stop differently. Both are
    // `unknown`; nothing here depends on which one spoke.
    expect((outcome as { detail: string }).detail, why(f, outcome)).toMatch(/unknown/)
    expect(f.github.prs).toEqual([])
  }, 60_000)
}
