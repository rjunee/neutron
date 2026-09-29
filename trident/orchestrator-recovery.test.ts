import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { createProductionHostEffects } from './production-host-effects.ts'
import { fixtureDispatchAdmission } from './__tests__/dispatch-admission-fixture.ts'
import { dispatchBoardBoundBuild, dispatchOrchestratorRecovery } from './board-dispatch.ts'
import { rejectedRecoverySource, readOrchestratorRecovery } from './orchestrator-recovery.ts'
import { retryModeSource } from './build-mode-state.ts'
import type { HostCommandResult } from './git-mode.ts'
import { mintProjectChatOrchestratorAuthority } from '@neutronai/tools/orchestrator-authority.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40)
const TASK = 'Implement the specified behavior with regression tests and preserve the completed dependent task sequence'
const plan = { strategy: 'task_sequence' as const, rationale: 'Dependent implementation tasks',
  implementationPlan: '- [ ] terminal task', topTask: '- [ ] terminal task',
  executionSpec: 'Complete the specified terminal implementation.', complexity: 'reasoning', remainingTasks: 0 }
const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-recovery-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  let stamp = Date.UTC(2026, 0, 1)
  const store = new TridentRunStore(db, () => new Date(stamp += 1000).toISOString())
  const board = new WorkBoardStore(db)
  const card = await board.create('project', { title: TASK, design_doc_ref: 'neutron-docs:plan' })
  const prior = await store.create({ slug: 'original', task: TASK, project_slug: 'project', repo_path: dir,
    branch: 'trident/original', merge_mode: 'pr', execution_strategy: 'task_sequence',
    strategy_plan: JSON.stringify(plan), strategy_rationale: plan.rationale, strategy_source: 'planner',
    task_iteration: 2, max_task_iterations: 8, max_rounds: 5 })
  await board.attachRun('project', card.id, prior.id)
  await store.update(prior.id, { worktree: join(dir, 'work'), base_sha: BASE, published_pr: 7, pr: 7 })
  const progress = { findings: ['missing nomination'], blockingCount: 1 }
  const source = createProductionHostEffects({ store, runId: prior.id, projectSlug: 'project', repo: dir,
    worktree: join(dir, 'work'), branch: prior.branch!, baseBranch: 'main', ciWorkflow: 'CI', runHost: async () => ok(),
    publication: async () => ({ title: TASK, bodyFile: join(dir, 'body') }) })
  await source.modes.saveCheckpoint({ head: HEAD, stage: 'rejected', round: 2, replansUsed: 0,
    findings: [{ kind: 'code', actionable: true, text: 'missing nomination' }], previousFindings: ['earlier'],
    previousReview: progress, reviewBaseline: 'required', remainingTasks: 0,
    reviewStop: { trigger: 'no-progress', round: 2, previous: { findings: ['earlier'], blockingCount: 1 }, current: progress } })
  await store.update(prior.id, { phase: 'failed' })
  await board.detachRun('project', prior.id, 'blocked', { pr: 7, pr_url: null, execution_strategy: 'task_sequence', task_iteration: 2, max_task_iterations: 8 })
  const latest = store.stageEvents(prior.id).filter(e => e.stage === 'build-mode-state').at(-1)!
  const request = { board_item_id: card.id, source_run_id: prior.id, source_event_id: latest.id,
    expected_head: HEAD, expected_base: BASE, published_pr: 7, direction: 'Repair the missing semantic mutation nomination and obtain fresh review.' }
  const facts = { project_scope: 'project', project_id: 'project-id', call_id: 'decision', chat_id: 'chat',
    session_id: 'session', thread_id: 'thread', generation: 'generation', lease_id: 'lease' }
  const invocation = (assertCurrent = () => {}) => ({ project_id: facts.project_id, call_id: facts.call_id,
    authority: mintProjectChatOrchestratorAuthority({ facts, toolName: 'work_board_replan_build', args: request, assertCurrent }) })
  const calls: string[][] = []
  let remoteHead = HEAD
  const deps = { store, board, project_slug: 'project', repo_path: dir, projectAdmission: fixtureDispatchAdmission(db),
    resolveBuildRepo: async () => dir, resolveMergeMode: async () => 'pr' as const,
    landedProbe: async () => null, branchHolderProbe: async () => null,
    hostRunner: async (argv: string[]) => {
      calls.push(argv)
      if (argv.includes('get-url')) return ok('https://github.com/example/widget.git')
      if (argv.includes('symbolic-ref')) return ok('origin/main')
      if (argv[0] === 'gh') return ok(JSON.stringify({ number: 7, url: 'https://github.com/example/widget/pull/7', state: 'OPEN', headRefOid: remoteHead,
        headRefName: prior.branch, baseRefName: 'main', isCrossRepository: false }))
      if (argv.includes('ls-remote')) return ok(`${remoteHead}\trefs/heads/${prior.branch}\n`)
      return ok()
    } }
  return { dir, db, store, board, card, prior, request, invocation, deps, calls, setHead: (head: string) => { remoteHead = head } }
}

test('explicit recovery imports a rejected source once without widening ordinary retry', async () => {
  const f = await fixture()
  expect(retryModeSource(f.store, f.store.get(f.prior.id)!)).toBeNull()
  expect((await dispatchBoardBoundBuild({ task: TASK, board_item_id: f.card.id }, f.deps)).ok).toBe(false)
  const original = f.store.stageEvents(f.prior.id)
  const result = await dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(result.run).toMatchObject({ task_iteration: 2, max_task_iterations: 8, round: 3, published_pr: 7, base_sha: BASE })
  expect(readOrchestratorRecovery(f.store, result.run)).toMatchObject({ iteration: 2, checkpoint: {
    head: HEAD, stage: 'built', round: 3, replansUsed: 1, previousReview: { findings: ['missing nomination'], blockingCount: 1 },
    orchestratorReplan: { direction: f.request.direction } } })
  expect(f.store.stageEvents(f.prior.id)).toEqual(original)
  expect((await dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps)).ok).toBe(false)
  expect(f.store.listNonTerminal()).toHaveLength(1)
})

test('same-card terminal history permits only a later headless preparation failure', async () => {
  const f = await fixture()
  const later = await f.store.create({ slug: 'changed-task', task: 'Different repair wording', project_slug: 'project',
    repo_path: f.dir, branch: 'trident/changed-task', execution_strategy: 'task_sequence', task_iteration: 2, max_task_iterations: 8 })
  await f.board.attachRun('project', f.card.id, later.id)
  await f.store.update(later.id, { phase: 'failed' })
  await f.board.detachRun('project', later.id, 'failed')
  expect(rejectedRecoverySource(f.store, 'project', f.request).prior.id).toBe(f.prior.id)
  expect((await dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps)).ok).toBe(true)
})

test('recovery revalidates the exact live owner invocation after remote evidence awaits', async () => {
  const f = await fixture()
  let current = true
  const invocation = f.invocation(() => { if (!current) throw new Error('Owner lease ended') })
  const result = await dispatchOrchestratorRecovery(f.request, invocation, { ...f.deps,
    hostRunner: async argv => { const result = await f.deps.hostRunner(argv); current = false; return result } })
  expect(result.ok).toBe(false)
  expect(f.store.listNonTerminal()).toHaveLength(0)
  expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM code_trident_orchestrator_recoveries')?.count).toBe(0)
  expect(f.board.get('project', f.card.id)?.status).toBe('blocked')
})

test('structural authorization clone cannot alter a card or claim a source', async () => {
  const f = await fixture()
  const before = f.board.get('project', f.card.id)
  const proof = f.invocation()
  const result = await dispatchOrchestratorRecovery(f.request, { ...proof, authority: { ...proof.authority } }, f.deps)
  expect(result.ok).toBe(false)
  expect(f.board.get('project', f.card.id)).toEqual(before)
  expect(f.store.listNonTerminal()).toHaveLength(0)
})

test('parallel exact recovery decisions admit only one successor and do not overwrite its binding', async () => {
  const f = await fixture()
  const results = await Promise.all([dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps),
    dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps)])
  expect(results.filter(r => r.ok)).toHaveLength(1)
  const live = f.store.listNonTerminal()
  expect(live).toHaveLength(1)
  expect(f.board.get('project', f.card.id)).toMatchObject({ linked_run_id: live[0]!.id, status: 'in_progress', recovery_refusal: null })
  expect(f.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM code_trident_orchestrator_recoveries')?.count).toBe(1)
})

test('a newer substantive same-card attempt vetoes recovery of the older rejected source', async () => {
  const f = await fixture()
  const later = await f.store.create({ slug: 'newer', task: TASK, project_slug: 'project',
    repo_path: f.dir, branch: 'trident/newer', execution_strategy: 'task_sequence' })
  await f.board.attachRun('project', f.card.id, later.id)
  await f.store.update(later.id, { phase: 'failed', published_pr: 8 })
  await f.board.detachRun('project', later.id, 'blocked')
  const result = await dispatchOrchestratorRecovery(f.request, f.invocation(), f.deps)
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('later attempt supersedes') })
  expect(f.board.get('project', f.card.id)?.linked_run_id).toBe(later.id)
  expect(f.store.listNonTerminal()).toHaveLength(0)
})

for (const fault of ['moved-head', 'wrong-event', 'wrong-card', 'wrong-pr', 'exhausted-review', 'exhausted-task'] as const)
test(`recovery refuses ${fault}, preserves the binding and records its reason`, async () => {
  const f = await fixture()
  if (fault === 'moved-head') f.setHead('c'.repeat(40))
  if (fault === 'wrong-event') f.request.source_event_id++
  if (fault === 'wrong-card') f.request.board_item_id = (await f.board.create('project', { title: TASK })).id
  if (fault === 'wrong-pr') f.request.published_pr++
  const deps = { ...f.deps, ...(fault === 'exhausted-review' ? { max_rounds: 2 } : {}),
    ...(fault === 'exhausted-task' ? { max_task_iterations: 2 } : {}) }
  const before = f.board.get('project', f.request.board_item_id)!
  const result = await dispatchOrchestratorRecovery(f.request, f.invocation(), deps)
  expect(result.ok).toBe(false)
  const card = f.board.get('project', before.id)!
  expect(card.linked_run_id).toBe(before.linked_run_id)
  expect(card.status).toBe('blocked')
  expect(card.recovery_refusal).toBeTruthy()
  expect(f.store.listNonTerminal()).toHaveLength(0)
})
