import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import type { PublishedRetryHandoff } from '@neutronai/trident/published-retry-handoff.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { publishedRetrySettlement } from '../published-retry-settlement.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const HEAD = 'c'.repeat(40)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'published-retry-settlement-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const prior = { id: 'prior-run', strategy_source: 'planner' } as TridentRun
  const step = 'prior-run:fix:1'
  const request = { run_id: prior.id, step_id: step, role: 'fix', model_id: 'opus', effort: 'high', cwd: join(dir, 'work'),
    writable: true, network: true, tools: 'edit-and-run', thread: null, budget: { wall_ms: 1 },
    brief: { path: join(dir, 'fix.brief'), integrity: 'brief' }, needs_approval_decision: false,
    result: { schema: 'project-build', path: join(dir, 'fix.result') } } as unknown as BoundedWorkRequest
  const result = (payload: Record<string, unknown>) => JSON.stringify({ schema: 'project-build', run_id: prior.id, step_id: step,
    kind: 'completed', result: { head: HEAD, diff: 'diff', pr: { number: 7, head: HEAD, state: 'OPEN' }, payload } })
  const valid = { worktreePath: request.cwd, branch: 'trident/branch', commitSha: HEAD, prNumber: 7, diffFile: 'diff',
    testsPassed: false, mutationClaim: null, suiteOutcome: 'deferred' }
  writeFileSync(request.result.path, result(valid))
  const handoff = { prior, item_id: 'card', priorBase: 'b'.repeat(40), settledHead: HEAD, holderWorktree: request.cwd,
    stepId: step, role: 'fix', request, resultPath: request.result.path } as PublishedRetryHandoff
  const leases: AdmissionLeaseRow[] = []
  const settled = publishedRetrySettlement({ admission: { listLeases: () => leases }, runs: { get: () => prior } })
  return { handoff, leases, settled, request, result, valid }
}
const lease = (workRef: string) => ({ workRef, reason: 'liveChild', producer: 'native', token: 't' }) as unknown as AdmissionLeaseRow

test('the live trailer validator and an empty lease census settle the original result', () => {
  const f = fixture()
  expect(f.settled(f.handoff)).toBe(true)
})

for (const [name, change] of [
  ['a build lease naming the predecessor', (f: ReturnType<typeof fixture>) => { f.leases.push(lease('prior-run')) }],
  ['a native child lease naming the predecessor step', (f: ReturnType<typeof fixture>) => { f.leases.push(lease(JSON.stringify(['prior-run', 'prior-run:fix:1']))) }],
  ['an unparseable lease reference mentioning the predecessor', (f: ReturnType<typeof fixture>) => { f.leases.push(lease('queued:prior-run')) }],
  ['a result the host validator rejects', (f: ReturnType<typeof fixture>) => { writeFileSync(f.request.result.path, f.result({ ...f.valid, commitSha: 7 })) }],
  ['a result for another step', (f: ReturnType<typeof fixture>) => { writeFileSync(f.request.result.path, f.result(f.valid).replace('prior-run:fix:1', 'prior-run:fix:2')) }],
  ['a missing result', (f: ReturnType<typeof fixture>) => { rmSync(f.request.result.path) }],
] as const) {
  test(`host settlement refuses ${name}`, () => {
    const f = fixture()
    change(f)
    expect(f.settled(f.handoff)).toBe(false)
  })
}

test('an unrelated lease does not hold the predecessor', () => {
  const f = fixture()
  f.leases.push(lease('another-run'))
  expect(f.settled(f.handoff)).toBe(true)
})

test('production composes ONE settlement witness into both outer launch and project preparation', async () => {
  const source = await Bun.file(new URL('../../composer.ts', import.meta.url)).text()
  expect(source.match(/publishedRetrySettlement\(/g)).toHaveLength(1)
  expect(source).toContain('const publishedRetrySettled = publishedRetrySettlement({ admission: projectAdmission, runs: new TridentRunStore(db) })')
  expect(source).toContain('published_retry_settled: publishedRetrySettled,')
  const call = source.slice(source.indexOf('return prepareProjectBuild(input, {'))
  expect(call.slice(0, call.indexOf('}, signal)'))).toMatch(/\n\s+publishedRetrySettled,\n/)
})
