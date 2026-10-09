/**
 * Owned published retry through outer launch (#1476) — direct real-Git cases.
 *
 * The predecessor is a terminal PR-mode attempt whose latest host checkpoint
 * still records a pending build or fix reservation while its original worker
 * wrote a completed result. Its linked checkout still holds the branch, which
 * carries the published PR head and (for a fix) an unpushed settled commit. The
 * card's fresh retry carries the same-card publication receipt. `prepareLaunch`
 * is the real outer launch seam; Git and the stores are real; only the GitHub
 * PR read and the origin URL spelling are answered by the host stub.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentAttemptLedger, type AttemptOutcome } from './attempt-ledger.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { spawnCapture, type HostCommandResult } from './git-mode.ts'
import { prepareLaunch, type PreparedLaunch } from './launch-preparation.ts'
import { publishedRetryHandoff, readPublishedRetryHandoff } from './published-retry-handoff.ts'
import { retryModeSource } from './build-mode-state.ts'
import { withRetainedCheckoutHandoff, type RetainedCheckoutOutcome, type RetainedCheckoutRefusal } from './published-retry-checkout.ts'

const GIT_ID = ['-c', 'user.name=Trident Test', '-c', 'user.email=trident-test@neutron.local', '-c', 'commit.gpgsign=false']
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const PR = 7
const BRANCH = 'trident/owned-published-retry'
const REMOTE = 'https://github.com/example/project.git'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await spawnCapture(['git', ...GIT_ID, ...args], cwd)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return res.stdout.trim()
}
async function commit(repo: string, name: string): Promise<string> {
  writeFileSync(join(repo, name), `${name}\n`)
  await git(repo, '-C', repo, 'add', '-A')
  await git(repo, '-C', repo, 'commit', '-qm', name)
  return git(repo, '-C', repo, 'rev-parse', 'HEAD')
}

type Shape = { phase: 'build' | 'fix'; outcome: AttemptOutcome | null; ended: boolean; terminal: 'failed' | 'stopped' }
const COMPLETED_BUILD: Shape = { phase: 'build', outcome: 'completed', ended: true, terminal: 'failed' }
const UNFINISHED_FIX: Shape = { phase: 'fix', outcome: null, ended: false, terminal: 'stopped' }
const UNKNOWN_FIX: Shape = { phase: 'fix', outcome: 'unknown', ended: true, terminal: 'failed' }

async function world(shape: Shape = COMPLETED_BUILD, options: { published?: number | null; priorReceipt?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'published-retry-handoff-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  const other = join(dir, 'other')
  await git(dir, 'init', '--bare', '-q', '--initial-branch=main', origin)
  await git(dir, 'clone', '-q', origin, repo)
  const base = await commit(repo, 'seed')
  await git(repo, '-C', repo, 'push', '-q', 'origin', 'main')
  // The predecessor's linked checkout still holds the branch.
  const worktree = join(repo, '.trident-worktrees', 'prior')
  await git(repo, '-C', repo, 'worktree', 'add', '-q', '-b', BRANCH, worktree, base)
  const published = await commit(worktree, 'published-build')
  await git(worktree, '-C', worktree, 'push', '-q', 'origin', BRANCH)
  // A settled fix commit the native worker left unpushed after the stop.
  const settled = shape.phase === 'fix' ? await commit(worktree, 'settled-fix') : published
  // Main moves on, so the retained branch is NOT contained in the fetched base.
  await git(dir, 'clone', '-q', origin, other)
  await commit(other, 'main-advance')
  await git(other, '-C', other, 'push', '-q', 'origin', 'main')
  // Observed before launch, so the launch's own base fetch is a no-op ref-wise.
  await git(repo, '-C', repo, 'fetch', '-q', 'origin')

  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.unshift(() => db.close())
  const store = new TridentRunStore(db)
  const board = new WorkBoardStore(db)
  const ledger = new TridentAttemptLedger(db)
  const card = await board.create('project', { title: 'owned published retry' })
  const task = 'Repair the owned published retry lifecycle'
  const prior = await store.create({ slug: 'owned-published-retry', project_slug: 'project', repo_path: repo, task,
    branch: BRANCH, merge_mode: 'pr', execution_strategy: 'single' })
  await board.attachRun('project', card.id, prior.id)
  await store.update(prior.id, { worktree, base_sha: base, pr: PR,
    published_pr: options.priorReceipt === undefined ? PR : options.priorReceipt })

  const root = join(dir, 'builds', encodeURIComponent(prior.id))
  mkdirSync(root, { recursive: true })
  const role = shape.phase
  const step = shape.phase === 'build' ? `${prior.id}:build:0` : `${prior.id}:fix:1`
  const request = { model_id: 'opus', effort: 'high', cwd: worktree, writable: true, network: true,
    tools: 'edit-and-run', thread: null, budget: { wall_ms: 1000 },
    brief: { path: join(root, `${role}.strategy-v3.brief.${role}.host`), integrity: 'brief' },
    result: { schema: 'project-build', path: join(root, `${role}.result`) },
    run_id: prior.id, step_id: step, role, needs_approval_decision: false }
  const files = {
    journal: join(root, `attempt-request-${digest([prior.id, step, 'dispatch'])}.json`),
    reservation: join(root, `claude-step-${digest([prior.id, step])}.json`),
    result: request.result.path,
  }
  writeFileSync(files.journal, JSON.stringify({ request, provider: 'anthropic', placement: 'in-repl',
    attribution: { phase: role, task_id: `${prior.id}:task:0`, head_sha: published, review_seat: null, requested_model: 'opus' } }))
  writeFileSync(files.reservation, JSON.stringify(request) + '\n#dispatch-armed\n')
  writeFileSync(files.result, JSON.stringify({ schema: 'project-build', run_id: prior.id, step_id: step, kind: 'completed',
    result: { head: settled, diff: 'diff', pr: { number: PR, head: published, state: 'OPEN' }, payload: {
      worktreePath: worktree, branch: BRANCH, commitSha: settled, prNumber: PR, diffFile: 'diff',
      testsPassed: false, mutationClaim: null, suiteOutcome: 'deferred' } } }))
  const key = { run_id: prior.id, step_id: step, attempt_id: 'dispatch' }
  await ledger.admit({ ...key, phase: 'build', task_id: `${prior.id}:task:0`, head_sha: published, role,
    review_seat: null, provider: 'anthropic', requested_model: 'opus', resolved_model: 'opus', placement: 'in-repl', queued_at: 1 })
  await ledger.lifecycle(key, { prepared_at: 2, started_at: 3,
    ...(shape.ended ? { ended_at: 4 } : {}), ...(shape.outcome !== null ? { outcome: shape.outcome } : {}) })
  const checkpoint = shape.phase === 'build'
    ? { head: null, stage: 'built', round: 0, replansUsed: 0, findings: [], previousFindings: [] }
    : { head: published, stage: 'rejected', round: 1, replansUsed: 0,
      findings: [{ kind: 'code', actionable: true, text: 'fix it' }], previousFindings: [] }
  await store.recordStageEvent(prior.id, 'build-mode-state', JSON.stringify({ runId: prior.id, branch: BRANCH, base,
    repo, worktree, projectSlug: 'project', mergeMode: 'pr', iteration: 0, checkpoint: { ...checkpoint,
      pending: { phase: role, step_id: step, recovery: { request, inputs: { workers: { [role]: { provider: 'anthropic', request } } },
        round: checkpoint.round, snapshot: { head: checkpoint.head ?? base, diff: '', pr: null }, previous: null, findings: [],
        planner: 'full', plan: null, executionStrategy: 'single', previousReview: null, reviewBaseline: 'none' } } } }))
  await store.update(prior.id, { phase: shape.terminal })
  await board.detachRun('project', prior.id, 'failed', { pr: PR, pr_url: null })

  const retry = await store.create({ slug: 'owned-published-retry', project_slug: 'project', repo_path: repo, task,
    branch: BRANCH, merge_mode: 'pr', execution_strategy: 'single',
    published_pr: options.published === undefined ? PR : options.published })
  await board.attachRun('project', card.id, retry.id)

  const prs = new Map<number, Record<string, unknown>>([[PR, { number: PR, url: `https://github.com/example/project/pull/${PR}`,
    headRefOid: published, state: 'OPEN', headRefName: BRANCH, baseRefName: 'main', isCrossRepository: false }]])
  const faults: { gitExit?: { match: (argv: string[]) => boolean; result: HostCommandResult } } = {}
  const commands: string[][] = []
  const run_host = Object.assign(async (argv: string[], cwd?: string): Promise<HostCommandResult> => {
    commands.push(argv)
    if (faults.gitExit?.match(argv)) return faults.gitExit.result
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view') {
      const pr = prs.get(Number(argv[3]))
      return pr ? { ok: true, stdout: JSON.stringify(pr), stderr: '', exit_code: 0 }
        : { ok: false, stdout: '', stderr: 'no pull requests found', exit_code: 1 }
    }
    if (argv.includes('remote') && argv.includes('get-url')) return { ok: true, stdout: `${REMOTE}\n`, stderr: '', exit_code: 0 }
    return spawnCapture(argv, cwd)
  }, { writesDiffOutput: true as const })
  const observe = async () => ({
    refs: await git(repo, '-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: await git(repo, '-C', repo, 'worktree', 'list', '--porcelain'),
    status: await git(worktree, '-C', worktree, 'status', '--porcelain'),
    prior: store.get(prior.id), events: store.stageEvents(prior.id), attempts: store.attempts(prior.id),
  })
  let settledWitness = (): boolean => true
  const launch = (run: TridentRun = store.get(retry.id)!, reader = (r: TridentRun) =>
    readPublishedRetryHandoff(store, () => settledWitness(), r), detected: number | null = null) => prepareLaunch(run, {
    run_host, sleep: async () => {}, list_stage_events: id => store.stageEvents(id),
    read_published_retry_handoff: reader,
  }, {
    resolveBase: async () => 'main', detectExistingPr: async () => detected, mint: () => 'wf-retry',
    failedRun: (r, reason) => ({ ...r, phase: 'failed', failure_reason: reason }),
    resumeHeadUnreadable: (r, cause) => ({ ...r, phase: 'failed', failure_reason: cause }),
    resolveResumeLiveHead: async () => '', resumeHeadDecides: () => false,
  })
  return { dir, db, store, board, ledger, card, prior: store.get(prior.id)!, retry: store.get(retry.id)!, repo, worktree,
    base, published, settled, files, prs, faults, commands, observe, launch, root, request, run_host,
    setWitness: (fn: () => boolean) => { settledWitness = fn } }
}

const refusal = (outcome: unknown): string =>
  (outcome as { run?: TridentRun }).run?.failure_reason ?? ''
const prepared = (outcome: unknown): PreparedLaunch => {
  expect((outcome as { run?: TridentRun }).run?.failure_reason ?? null).toBeNull()
  return outcome as PreparedLaunch
}
const WRONG_BASE = "refusing to build on another lane's work"

for (const [name, shape] of [['completed accounting with a lost driver acknowledgement', COMPLETED_BUILD],
  ['unfinished accounting (ended_at and outcome null) of a fix stopped through the supported control', UNFINISHED_FIX],
  ['an explicitly unknown fix attempt', UNKNOWN_FIX]] as const) {
  test(`owned published retry adopts the retained branch at outer launch: ${name}`, async () => {
    const f = await world(shape)
    const before = await f.observe()
    const outcome = prepared(await f.launch())
    expect(outcome.base_sha).toBe(f.base)
    expect(outcome.pinnedRun.base_sha).toBe(f.base)
    expect(outcome.pinnedRun.base_behind).toBe(1)
    expect(outcome.resume_checkpoint).toBeNull()
    expect(outcome.resume_checkpoint_head).toBeNull()
    expect(outcome.resume_findings).toBeNull()
    // Nothing moved: refs, linked checkouts, the checkout's files and every predecessor row.
    expect(await f.observe()).toEqual(before)
    // The pending checkpoint is still not a retry source.
    expect(retryModeSource(f.store, f.prior)).toBeNull()
  })
}

test('owned published retry adopts the retained branch when launch discovers its open PR', async () => {
  // In production `gh pr list --head <branch>` finds the owned PR and launch
  // links it on the launch-local row before the guard. The authority must be
  // read over the row as stored, or its unchanged-row check refuses every owned
  // retry GitHub reports (the consuming e2e surfaced exactly this).
  const f = await world(UNFINISHED_FIX)
  const seen: (number | null)[] = []
  const outcome = prepared(await f.launch(undefined, r => {
    seen.push(r.pr)
    return readPublishedRetryHandoff(f.store, () => true, r)
  }, PR))
  expect(seen).toEqual([null, null])
  expect(outcome.pinnedRun.pr).toBe(PR)
  expect(outcome.pinnedRun.base_sha).toBe(f.base)
  expect(retryModeSource(f.store, f.prior)).toBeNull()
})

test('the reproduced refusal: without the composed authority the same retry is refused as another lane', async () => {
  const f = await world(UNFINISHED_FIX)
  const before = await f.observe()
  expect(refusal(await f.launch(undefined, () => null))).toContain(WRONG_BASE)
  expect(await f.observe()).toEqual(before)
})

for (const unowned of ['no receipt', 'observed pr only', 'discovered receipt mismatch'] as const) {
  test(`an unowned publication keeps the wrong-base refusal: ${unowned}`, async () => {
    const f = await world(COMPLETED_BUILD, unowned === 'no receipt' ? { published: null }
      : unowned === 'observed pr only' ? { published: null, priorReceipt: null } : { published: PR + 1 })
    if (unowned === 'discovered receipt mismatch') f.prs.set(PR + 1, { ...f.prs.get(PR)!, number: PR + 1 })
    const before = await f.observe()
    expect(publishedRetryHandoff(f.store, f.retry)).toBeNull()
    expect(refusal(await f.launch())).toContain(WRONG_BASE)
    expect(await f.observe()).toEqual(before)
  })
}

const authorityFaults: Record<string, (f: Awaited<ReturnType<typeof world>>) => Promise<void> | void> = {
  'missing journal': f => rmSync(f.files.journal),
  'altered request journal': f => writeFileSync(f.files.journal, JSON.stringify({ request: { ...f.request, model_id: 'other' },
    provider: 'anthropic', placement: 'in-repl' })),
  'missing result': f => rmSync(f.files.result),
  'altered result head': async f => writeFileSync(f.files.result, (await Bun.file(f.files.result).text()).replaceAll(f.settled, f.base)),
  'blocked result': async f => writeFileSync(f.files.result, JSON.stringify({ ...JSON.parse(await Bun.file(f.files.result).text()),
    kind: 'blocked', on: 'stopped' })),
  'unarmed reservation': f => writeFileSync(f.files.reservation, JSON.stringify(f.request) + '\n'),
  'missing reservation': f => rmSync(f.files.reservation),
  'failed attempt outcome': async f => { await f.db.run(`UPDATE code_trident_attempts SET outcome = 'failed', ended_at = 9 WHERE run_id = ?`, [f.prior.id]) },
  'nonterminal predecessor': async f => {
    await f.db.run(`UPDATE code_trident_runs SET phase = 'task-build', slug = 'prior-live' WHERE id = ?`, [f.prior.id])
  },
  'predecessor completed as done': async f => { await f.store.update(f.prior.id, { phase: 'done' }) },
  'changed repository': async f => { await f.db.run('UPDATE code_trident_runs SET repo_path = ? WHERE id = ?', [join(f.dir, 'other'), f.prior.id]) },
  'changed branch': async f => { await f.store.update(f.prior.id, { branch: 'trident/another' }) },
  'changed card': async f => {
    const card = await f.board.create('project', { title: 'another card' })
    await f.board.attachRun('project', card.id, f.retry.id)
    await f.db.run('UPDATE work_board_items SET linked_run_id = NULL WHERE id = ?', [f.card.id])
  },
  'another live owner': async f => {
    await f.store.create({ slug: 'sibling', project_slug: 'project', repo_path: f.repo, task: 'sibling', branch: BRANCH, merge_mode: 'pr' })
  },
  'reservation held by another run': async f => { await f.store.reserveBranch({ repo_path: f.repo, branch: BRANCH, run_id: 'another-run', purpose: 'salvage' }) },
  'another unfinished predecessor worker': async f => {
    const key = { run_id: f.prior.id, step_id: `${f.prior.id}:review:1:head:${f.settled}`, attempt_id: 'dispatch' }
    await f.ledger.admit({ ...key, phase: 'review_rubric', task_id: `${f.prior.id}:task:0`, head_sha: f.settled, role: 'review',
      review_seat: null, provider: 'anthropic', requested_model: 'opus', resolved_model: 'opus', placement: 'in-repl', queued_at: 5 })
  },
  'host settlement witness refuses (live lease or invalid trailer)': f => f.setWitness(() => false),
}
for (const [fault, apply] of Object.entries(authorityFaults)) {
  test(`owned published retry refuses without mutation: ${fault}`, async () => {
    const f = await world(UNFINISHED_FIX)
    await apply(f)
    const before = await f.observe()
    const outcome = await f.launch()
    expect(refusal(outcome)).toContain(WRONG_BASE)
    expect(await f.observe()).toEqual(before)
  })
}

test('owned published retry refuses when the branch tip is not the settled head', async () => {
  const f = await world(UNFINISHED_FIX)
  await commit(f.worktree, 'foreign-after-settlement')
  expect(refusal(await f.launch())).toContain(WRONG_BASE)
})

for (const pr of ['closed', 'wrong branch', 'not contained', 'unreadable'] as const) {
  test(`owned published retry refuses an owned PR that is ${pr}`, async () => {
    const f = await world(UNFINISHED_FIX)
    if (pr === 'closed') f.prs.set(PR, { ...f.prs.get(PR)!, state: 'CLOSED' })
    if (pr === 'wrong branch') f.prs.set(PR, { ...f.prs.get(PR)!, headRefName: 'trident/elsewhere' })
    if (pr === 'not contained') f.prs.set(PR, { ...f.prs.get(PR)!, headRefOid: await git(f.dir, '-C', join(f.dir, 'other'), 'rev-parse', 'HEAD') })
    if (pr === 'unreadable') f.prs.delete(PR)
    const before = await f.observe()
    const reason = refusal(await f.launch())
    expect(reason).toContain(pr === 'unreadable' ? 'UNKNOWN authorises nothing' : WRONG_BASE)
    expect(await f.observe()).toEqual(before)
  })
}

for (const failure of ['exit 128', 'watchdog timeout'] as const) {
  test(`an unknown ancestry observation refuses as UNKNOWN: ${failure}`, async () => {
    const f = await world(UNFINISHED_FIX)
    f.faults.gitExit = {
      match: argv => argv.includes('--is-ancestor') && argv.at(-2) === f.base,
      result: failure === 'exit 128'
        ? { ok: false, stdout: '', stderr: 'fatal: bad object', exit_code: 128 }
        : { ok: false, stdout: '', stderr: '', exit_code: 124, timed_out: true },
    }
    const before = await f.observe()
    const reason = refusal(await f.launch())
    expect(reason).toContain('owned published retry could NOT be established')
    expect(reason).toContain('UNKNOWN authorises nothing')
    expect(await f.observe()).toEqual(before)
  })
}

test('an authority that changes between the first read and the post-observation re-read refuses', async () => {
  const f = await world(UNFINISHED_FIX)
  let reads = 0
  const outcome = await f.launch(undefined, run => {
    reads++
    const handoff = readPublishedRetryHandoff(f.store, () => true, run)
    return handoff && reads > 1 ? { ...handoff, settledHead: f.base } : handoff
  })
  expect(reads).toBe(2)
  expect(refusal(outcome)).toContain(WRONG_BASE)
})

// A retry refused at outer launch before its first worker (the incident's own
// refused retry, or a transient UNKNOWN refusal of this path) becomes the card's
// newest terminal attempt. It must not end the card's recovery.
async function afterRefusedRetry(f: Awaited<ReturnType<typeof world>>, patch: Partial<TridentRun> = {}) {
  const refused = f.retry
  expect(refusal(await f.launch(undefined, () => null))).toContain(WRONG_BASE)
  await f.store.update(refused.id, { phase: 'failed', failure_reason: 'refused at outer launch', base_sha: f.base, ...patch })
  await f.board.detachRun('project', refused.id, 'failed', { pr: null, pr_url: null })
  const retry = await f.store.create({ slug: 'owned-published-retry', project_slug: 'project', repo_path: f.repo,
    task: refused.task, branch: BRANCH, merge_mode: 'pr', execution_strategy: 'single', published_pr: PR })
  await f.board.attachRun('project', f.card.id, retry.id)
  return { refused: f.store.get(refused.id)!, retry: f.store.get(retry.id)! }
}

for (const [name, shape] of [['unfinished fix', UNFINISHED_FIX], ['completed build', COMPLETED_BUILD]] as const) {
  test(`an intermediate retry refused before its first worker does not end recovery: ${name}`, async () => {
    const f = await world(shape)
    const { refused, retry } = await afterRefusedRetry(f)
    const handoff = publishedRetryHandoff(f.store, retry)
    expect(handoff?.prior.id).toBe(f.prior.id)
    expect(handoff?.settledHead).toBe(f.settled)
    const before = await f.observe()
    const outcome = prepared(await f.launch(retry))
    expect(outcome.pinnedRun.base_sha).toBe(f.base)
    expect(await f.observe()).toEqual(before)
    // The passed-over attempt is read, never rewritten.
    expect(f.store.get(refused.id)).toEqual(refused)
  })
}

const intermediateFaults: Record<string, (f: Awaited<ReturnType<typeof world>>, refused: TridentRun) => Promise<unknown>> = {
  'it dispatched a worker': (f, refused) => f.ledger.admit({ run_id: refused.id, step_id: `${refused.id}:build:0`,
    attempt_id: 'dispatch', phase: 'build', task_id: `${refused.id}:task:0`, head_sha: f.settled, role: 'build',
    review_seat: null, provider: 'anthropic', requested_model: 'opus', resolved_model: 'opus', placement: 'in-repl', queued_at: 6 }),
  'it carries another receipt': (f, refused) => f.store.update(refused.id, { published_pr: PR + 1 }),
  'it ran on another branch': (f, refused) => f.store.update(refused.id, { branch: 'trident/elsewhere' }),
  'it was seeded from a checkpoint': (f, refused) =>
    f.store.recordStageEvent(refused.id, 'build-retry-source', JSON.stringify({ priorRunId: f.prior.id })),
  'it holds an inner checkpoint': (f, refused) => f.store.update(refused.id, { inner_checkpoint: 'forge-done' }),
}
for (const [fault, apply] of Object.entries(intermediateFaults)) {
  test(`a newer card attempt that is not provably a refused retry ends the authority: ${fault}`, async () => {
    const f = await world(UNFINISHED_FIX)
    const { refused, retry } = await afterRefusedRetry(f)
    await apply(f, refused)
    expect(publishedRetryHandoff(f.store, f.store.get(retry.id)!)).toBeNull()
    expect(refusal(await f.launch(f.store.get(retry.id)!))).toContain(WRONG_BASE)
  })
}

test("outer launch's tick snapshot may lag the row in fields the authority does not read", async () => {
  // Production hands prepareLaunch the row the tick listed at the start of its
  // sweep; a heartbeat-style write since then must not refuse an owned retry.
  const f = await world(UNFINISHED_FIX)
  const stored = f.store.get(f.retry.id)!
  prepared(await f.launch({ ...stored, last_advanced_at: '2000-01-01T00:00:00.000Z', round: stored.round + 1 }))
})

test("outer launch's tick snapshot that disagrees on an authority field refuses", async () => {
  const f = await world(UNFINISHED_FIX)
  await f.store.update(f.retry.id, { published_pr: null })
  const before = await f.observe()
  expect(refusal(await f.launch({ ...f.store.get(f.retry.id)!, published_pr: PR }))).toContain(WRONG_BASE)
  expect(await f.observe()).toEqual(before)
})

test('seeded or recovery launches never consult the published retry authority', async () => {
  const f = await world(COMPLETED_BUILD)
  await f.store.recordStageEvent(f.retry.id, 'build-retry-source', JSON.stringify({ priorRunId: f.prior.id }))
  expect(publishedRetryHandoff(f.store, f.retry)).toBeNull()
})

// ---------------------------------------------------------------------------
// Preparation: the retained linked checkout is handed off through the existing
// worktree lifecycle while this run holds the branch reservation (#1476).
// ---------------------------------------------------------------------------

type World = Awaited<ReturnType<typeof world>>
/** A world whose retry has passed outer launch: its row carries the predecessor's base pin. */
async function launched(shape: Shape = UNFINISHED_FIX, options: Parameters<typeof world>[1] = {}): Promise<World> {
  const f = await world(shape, options)
  await f.store.update(f.retry.id, { base_sha: f.base, worktree: join(f.repo, '.trident-worktrees', 'retry') })
  return f
}
/** Everything a refused hand-off must leave exactly as it was. */
async function snapshot(f: World) {
  const linked = existsSync(f.worktree)
  return {
    refs: await git(f.repo, '-C', f.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: await git(f.repo, '-C', f.repo, 'worktree', 'list', '--porcelain'),
    holder: linked ? await git(f.worktree, '-C', f.worktree, 'status', '--porcelain', '--untracked-files=all') : null,
    prior: f.store.get(f.prior.id), events: f.store.stageEvents(f.prior.id), attempts: f.store.attempts(f.prior.id),
    files: Object.fromEntries(Object.entries(f.files).map(([key, path]) => [key, readFileSync(path, 'utf8')])),
    reservations: f.db.all('SELECT * FROM code_trident_branch_reservations'),
  }
}
const handOff = (f: World, settled: () => boolean = () => true,
  body: (outcome: RetainedCheckoutOutcome) => Promise<unknown> = async () => {}, store: TridentRunStore = f.store) => {
  let seen: RetainedCheckoutOutcome | null = null
  return withRetainedCheckoutHandoff({ store, settled, runId: f.retry.id, baseBranch: 'main', runHost: f.run_host },
    async outcome => { seen = outcome; await body(outcome); return seen! })
}
const destructive = (commands: string[][]) => commands.filter(argv => argv.includes('--force') || argv.includes('-f')
  || argv.includes('-B') || argv.includes('reset') || argv.includes('checkout') || argv.includes('-D')
  || argv.some(arg => arg.endsWith('worktree-cleanup.sh')))

for (const [name, shape] of [['completed accounting with a lost driver acknowledgement', COMPLETED_BUILD],
  ['unfinished accounting (ended_at and outcome null)', UNFINISHED_FIX],
  ['an explicitly unknown fix attempt', UNKNOWN_FIX]] as const) {
  test(`preparation hands off the predecessor's retained checkout and attaches the branch at the settled head: ${name}`, async () => {
    const f = await launched(shape)
    const before = await snapshot(f)
    const target = f.store.get(f.retry.id)!.worktree!
    let heldDuringBody: unknown[] = []
    const outcome = await handOff(f, () => true, async outcome => {
      heldDuringBody = f.db.all('SELECT run_id, purpose FROM code_trident_branch_reservations')
      if (outcome.verdict === 'handed-off') await git(f.repo, '-C', f.repo, 'worktree', 'add', '-q', '--', target, BRANCH)
    })
    expect(outcome).toMatchObject({ verdict: 'handed-off', handoff: { settledHead: f.settled, priorBase: f.base } })
    // The add ran under this run's own reservation, which is released afterwards.
    expect(heldDuringBody).toEqual([{ run_id: f.retry.id, purpose: 'salvage' }])
    expect(f.db.all('SELECT * FROM code_trident_branch_reservations')).toEqual([])
    // The holder is gone; the branch and every commit are kept.
    expect(existsSync(f.worktree)).toBe(false)
    expect(await git(f.repo, '-C', f.repo, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(f.settled)
    await git(f.repo, '-C', f.repo, 'merge-base', '--is-ancestor', f.published, f.settled)
    expect(await git(target, '-C', target, 'rev-parse', 'HEAD')).toBe(f.settled)
    expect(await git(target, '-C', target, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`)
    // Predecessor rows, events, attempts and retained artifacts are unchanged.
    const after = await snapshot(f)
    expect(after.prior).toEqual(before.prior)
    expect(after.events).toEqual(before.events)
    expect(after.attempts).toEqual(before.attempts)
    expect(after.files).toEqual(before.files)
    expect(f.commands.some(argv => argv.includes('--force') || argv.includes('-B') || argv.includes('reset')
      || argv.includes('-D'))).toBe(false)
  })
}

// The predecessor's checkout can already be gone by preparation (released after
// outer launch). The same authority, settled-head and publication checks still
// apply; nothing is released, and the caller's attach is re-checked.
test('preparation with no remaining holder still requires the settled head and attaches it', async () => {
  const f = await launched()
  await git(f.repo, '-C', f.repo, 'worktree', 'remove', f.worktree)
  const target = f.store.get(f.retry.id)!.worktree!
  const start = f.commands.length
  const outcome = await handOff(f, () => true, async outcome => {
    if (outcome.verdict === 'handed-off') await git(f.repo, '-C', f.repo, 'worktree', 'add', '-q', '--', target, BRANCH)
  })
  expect(outcome).toMatchObject({ verdict: 'handed-off', handoff: { settledHead: f.settled } })
  expect(f.commands.slice(start).some(argv => argv.some(arg => arg.endsWith('worktree-cleanup.sh')))).toBe(false)
  expect(f.commands.slice(start).some(argv => argv[0] === 'gh' && argv[2] === 'view')).toBe(true)
  expect(await git(target, '-C', target, 'rev-parse', 'HEAD')).toBe(f.settled)
})

for (const [name, move] of [
  ['the branch rewound past the settled commit', (f: World) => git(f.repo, '-C', f.repo, 'update-ref', `refs/heads/${BRANCH}`, f.published)],
  ['the branch advanced past the settled commit', async (f: World) => {
    const tree = await git(f.repo, '-C', f.repo, 'rev-parse', `${f.settled}^{tree}`)
    const next = await git(f.repo, '-C', f.repo, 'commit-tree', tree, '-p', f.settled, '-m', 'after-settlement')
    await git(f.repo, '-C', f.repo, 'update-ref', `refs/heads/${BRANCH}`, next)
  }],
] as const) {
  test(`preparation with no remaining holder refuses a moved branch without mutation: ${name}`, async () => {
    const f = await launched()
    await git(f.repo, '-C', f.repo, 'worktree', 'remove', f.worktree)
    await move(f)
    const before = await snapshot(f)
    const start = f.commands.length
    let reached = false
    expect(await handOff(f, () => true, async () => { reached = true })).toEqual({ verdict: 'refused', detail: 'branch-moved' })
    expect(reached).toBe(true)
    expect(await snapshot(f)).toEqual(before)
    expect(destructive(f.commands.slice(start))).toEqual([])
  })
}

const checkoutRefusals: Record<string, { apply: (f: World) => Promise<unknown> | unknown; detail: RetainedCheckoutRefusal }> = {
  'a tracked modification': { apply: f => writeFileSync(join(f.worktree, 'seed'), 'edited\n'), detail: 'holder-dirty' },
  'an untracked file': { apply: f => writeFileSync(join(f.worktree, 'scratch.txt'), 'new\n'), detail: 'holder-dirty' },
  'a locked holder': { apply: f => git(f.repo, '-C', f.repo, 'worktree', 'lock', f.worktree), detail: 'holder-locked' },
  'a holder at a path other than the recorded worktree': {
    apply: async f => {
      await git(f.repo, '-C', f.repo, 'worktree', 'move', f.worktree, join(f.repo, '.trident-worktrees', 'elsewhere'))
    }, detail: 'holder-not-recorded-worktree' },
  'the main worktree checked out on the branch': {
    apply: async f => {
      await git(f.repo, '-C', f.repo, 'worktree', 'remove', f.worktree)
      await git(f.repo, '-C', f.repo, 'checkout', '-q', BRANCH)
    }, detail: 'main-worktree-holds-branch' },
  'a branch moved after settlement': { apply: f => commit(f.worktree, 'after-settlement'), detail: 'branch-moved' },
  'a base pin that is not the predecessor base': {
    apply: async f => f.store.update(f.retry.id, { base_sha: f.published }), detail: 'base-pin-changed' },
  'an owned PR that closed': { apply: f => f.prs.set(PR, { ...f.prs.get(PR)!, state: 'CLOSED' }), detail: 'publication-refused' },
  'a cleanup lifecycle that preserved the holder': {
    apply: f => { f.faults.gitExit = { match: argv => argv.some(arg => arg.endsWith('worktree-cleanup.sh')),
      result: { ok: false, exit_code: 3, stderr: '', stdout: `PRESERVED worktree ${f.worktree} reason=dirty\nRESULT preserved=1 removed=0\n` } } },
    detail: 'cleanup-preserved' },
}
for (const [name, { apply, detail }] of Object.entries(checkoutRefusals)) {
  test(`preparation refuses the retained checkout hand-off without mutation: ${name}`, async () => {
    const f = await launched()
    await apply(f)
    const before = await snapshot(f)
    const start = f.commands.length
    const outcome = await handOff(f)
    expect(outcome).toEqual({ verdict: 'refused', detail })
    expect(await snapshot(f)).toEqual(before)
    const ran = destructive(f.commands.slice(start))
    // Only the faulted lifecycle call may appear, and it was answered without running.
    expect(ran.every(argv => detail === 'cleanup-preserved' && argv.some(arg => arg.endsWith('worktree-cleanup.sh')))).toBe(true)
  })
}

for (const failure of ['exit 128', 'watchdog timeout'] as const) {
  test(`an unreadable worktree listing is UNKNOWN, not none: ${failure}`, async () => {
    const f = await launched()
    f.faults.gitExit = {
      match: argv => argv.includes('worktree') && argv.includes('list'),
      result: failure === 'exit 128'
        ? { ok: false, stdout: '', stderr: 'fatal: not a git repository', exit_code: 128 }
        : { ok: false, stdout: '', stderr: '', exit_code: 124, timed_out: true },
    }
    const before = await snapshot(f)
    expect(await handOff(f)).toEqual({ verdict: 'unknown', detail: 'worktree-list-unreadable' })
    expect(await snapshot(f)).toEqual(before)
  })
}

test('a cleanup answer that cannot be confirmed is UNKNOWN and never reaches the add', async () => {
  const f = await launched()
  f.faults.gitExit = { match: argv => argv.some(arg => arg.endsWith('worktree-cleanup.sh')),
    result: { ok: false, exit_code: 1, stderr: 'crashed', stdout: '' } }
  const before = await snapshot(f)
  expect(await handOff(f)).toEqual({ verdict: 'unknown', detail: 'cleanup-unconfirmed' })
  expect(await snapshot(f)).toEqual(before)
})

test('concurrent reservation acquisition between the authority read and the reservation refuses', async () => {
  const f = await launched()
  const racing = new Proxy(f.store, { get(target, key, receiver) {
    if (key === 'reserveBranch') return async (input: Parameters<TridentRunStore['reserveBranch']>[0]) => {
      await target.reserveBranch({ ...input, run_id: 'another-run' })
      return target.reserveBranch(input)
    }
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const outcome = await handOff(f, () => true, async () => {}, racing)
  expect(outcome).toEqual({ verdict: 'refused', detail: 'reservation-unavailable' })
  expect(existsSync(f.worktree)).toBe(true)
  // The other run's reservation is not ours to release.
  expect(f.db.all('SELECT run_id FROM code_trident_branch_reservations')).toEqual([{ run_id: 'another-run' }])
})

test('authority that changes under the reservation refuses before any observation', async () => {
  const f = await launched()
  let reads = 0
  const before = await snapshot(f)
  expect(await handOff(f, () => ++reads === 1)).toEqual({ verdict: 'refused', detail: 'authority-changed' })
  expect(await snapshot(f)).toEqual(before)
})

test('authority that changes after the Git observations refuses before the lifecycle runs', async () => {
  const f = await launched()
  let reads = 0
  const before = await snapshot(f)
  expect(await handOff(f, () => ++reads < 3)).toEqual({ verdict: 'refused', detail: 'observation-changed' })
  expect(reads).toBe(3)
  expect(await snapshot(f)).toEqual(before)
})

for (const [name, setup] of [
  ['an unowned retry (no publication receipt)', (f: World) => f],
  ['a reservation already held by another run', async (f: World) => {
    await f.store.reserveBranch({ repo_path: f.repo, branch: BRANCH, run_id: 'another-run', purpose: 'salvage' }) }],
] as const) {
  test(`no owned authority means no hand-off and the existing add refusal: ${name}`, async () => {
    const f = name.startsWith('an unowned') ? await launched(COMPLETED_BUILD, { published: null }) : await launched()
    await setup(f)
    const before = await snapshot(f)
    const start = f.commands.length
    expect(await handOff(f)).toEqual({ verdict: 'none' })
    expect(await snapshot(f)).toEqual(before)
    expect(f.commands.slice(start)).toEqual([])
    // The existing add still refuses while the predecessor's checkout holds the branch.
    const added = await spawnCapture(['git', '-C', f.repo, 'worktree', 'add', '--', f.store.get(f.retry.id)!.worktree!, BRANCH], f.repo)
    expect(added.ok).toBe(false)
  })
}

test('a host settlement witness that refuses yields no hand-off', async () => {
  const f = await launched()
  const before = await snapshot(f)
  expect(await handOff(f, () => false)).toEqual({ verdict: 'none' })
  expect(await snapshot(f)).toEqual(before)
})
