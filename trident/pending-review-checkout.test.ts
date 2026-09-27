import { expect, test } from 'bun:test'
import { pendingReviewCheckoutHead } from './pending-review-checkout.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

function fixture() {
  const head = 'b'.repeat(40)
  const run = { id: 'run', branch: 'change', base_sha: 'a'.repeat(40), repo_path: '/repo',
    project_slug: 'project', worktree: '/repo/work', merge_mode: 'pr', phase: 'task-build',
    pr: 7, published_pr: 7 } as TridentRun
  const checkpoint = { head, stage: 'built', round: 1, replansUsed: 0, findings: [], previousFindings: [],
    pending: { phase: 'review', step_id: `run:review:1:head:${head}`, recovery: {
      request: { run_id: 'run', step_id: `run:review:1:head:${head}`, role: 'review', writable: false },
      snapshot: { head, diff: '+change', pr: { number: 7, head, state: 'OPEN' } },
    } } }
  const state = { runId: run.id, branch: run.branch, base: run.base_sha, repo: run.repo_path,
    projectSlug: run.project_slug, worktree: run.worktree, mergeMode: run.merge_mode, iteration: 0, checkpoint }
  const events = [{ stage: 'build-mode-state', meta: JSON.stringify(state) }]
  const store = { stageEvents: () => events } as unknown as Pick<TridentRunStore, 'stageEvents'>
  const pr: Record<string, unknown> = { number: 7, headRefOid: head, state: 'OPEN', headRefName: 'change',
    baseRefName: 'main', isCrossRepository: false }
  let calls = 0
  const host = async (argv: string[], cwd?: string) => {
    calls++
    expect(argv.slice(0, 4)).toEqual(['gh', 'pr', 'view', '7'])
    expect(cwd).toBe('/repo')
    return { ok: true, exit_code: 0, stdout: JSON.stringify(pr), stderr: '' }
  }
  return { run, state, checkpoint, events, pr, save: () => { events[0]!.meta = JSON.stringify(state) },
    calls: () => calls, recover: () => pendingReviewCheckoutHead(store, run, 'main', host) }
}

test('pending review selects only the exact owned published input', async () => {
  const f = fixture()
  expect(await f.recover()).toBe(f.checkpoint.head)
  expect(f.calls()).toBe(1)
})

for (const phase of ['fresh', 'plan', 'build', 'fix']) test(`checkout recovery leaves ${phase} preparation unchanged`, async () => {
  const f = fixture()
  if (phase === 'fresh') f.events.length = 0
  else { f.checkpoint.pending.phase = phase; f.save() }
  expect(await f.recover()).toBeNull()
  expect(f.calls()).toBe(0)
})

for (const changed of ['number', 'headRefOid', 'state', 'headRefName', 'baseRefName', 'isCrossRepository']) {
  test(`pending review refuses changed PR ${changed}`, async () => {
    const f = fixture()
    f.pr[changed] = changed === 'number' ? 8 : changed === 'isCrossRepository' ? true : 'changed'
    await expect(f.recover()).rejects.toThrow('no longer matches')
  })
}

for (const changed of ['owner', 'terminal', 'checkpoint', 'snapshot', 'request', 'latest']) {
  test(`pending review refuses invalid ${changed} evidence without PR observation`, async () => {
    const f = fixture()
    if (changed === 'owner') f.run.published_pr = null
    if (changed === 'terminal') f.run.phase = 'failed'
    if (changed === 'checkpoint') f.state.runId = 'foreign'
    if (changed === 'snapshot') f.checkpoint.pending.recovery.snapshot.head = 'c'.repeat(40)
    if (changed === 'request') f.checkpoint.pending.recovery.request.writable = true
    f.save()
    if (changed === 'latest') f.events.push({ stage: 'build-mode-state', meta: '{' })
    await expect(f.recover()).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
}
