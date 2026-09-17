import { honourDiffOutput } from './testing/diff-output-host.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import * as hostModule from './project-build-host.ts'
import {
  createProjectLauncher,
  projectBuildDriverReservation,
  projectBuildDriverReservationFromPriorGateway,
  projectBuildMeasuredUnknown,
  projectBuildPending,
  projectBuildResult,
} from './project-launcher.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { terminalRunDisposition } from './run-disposition.ts'
import { parseInnerResult, type InnerLoopInput } from './inner-loop.ts'
import type { ProjectBuildOutcome } from './project-build-host.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const unknown: ProjectBuildOutcome = { kind: 'unknown', phase: 'build', step_id: 'step-7', detail: 'Transport uncertain', cleanup: { kind: 'preserved', detail: 'live branch' } }
const approvedButUnverified: ProjectBuildOutcome = { kind: 'unknown', phase: 'review', step_id: 'run:review:1',
  detail: 'Review readiness deferred: Review PR mergeability is not established; budget exhausted. Review worker reported APPROVE; host receipt not obtained.',
  cleanup: { kind: 'preserved', detail: 'live branch' } }
const merged: ProjectBuildOutcome = { kind: 'merged', snapshot: { head: 'b'.repeat(40), diff: 'diff', pr: { number: 12, head: 'b'.repeat(40), state: 'MERGED' } }, cleanup: { kind: 'cleaned', detail: '' } }

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'project-launcher-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanup.push(() => db.close())
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'launch', project_slug: 'project', repo_path: dir, task: 'Build' })
  await store.update(row.id, { branch: 'change', worktree: join(dir, 'work'), base_sha: 'a'.repeat(40), subagent_run_id: 'worker-7', subagent_status: 'running' })
  const input: InnerLoopInput = { run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'project.db'), max_rounds: 3 }
  let complete!: (value: ProjectBuildOutcome) => void
  const pending = new Promise<ProjectBuildOutcome>(resolve => { complete = resolve })
  let starts = 0
  const construct = spyOn(hostModule, 'createProjectBuildHost').mockImplementation(async () => ({ runners: {}, workers: {} as never, deps: {} as never,
    run: async () => { starts++; return pending } }))
  cleanup.push(() => construct.mockRestore())
  const errors: unknown[] = []
  const options = { store, prepare: async () => ({} as hostModule.ProjectBuildHostOptions), onError: (e: unknown) => { errors.push(e) } }
  return { store, input, complete, errors, options, starts: () => starts, construct }
}
async function settle() { for (let i = 0; i < 5; i++) await Bun.sleep(1) }

test('launch returns before completion and hands terminal result to the existing harvest', async () => {
  const f = await fixture()
  expect((await createProjectLauncher(f.options)(f.input)).status).toBe('fired')
  expect(f.starts()).toBe(1)
  expect(projectBuildPending(f.store.get(f.input.run.id)!.inner_result)).toBe(true)
  f.complete(merged)
  await settle()
  const saved = f.store.get(f.input.run.id)!
  expect(parseInnerResult(saved.inner_result)?.pr_merged).toBe(true)
  expect(projectBuildPending(saved.inner_result)).toBe(false)
  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('must not re-fire') }, db_path: f.input.db_path,
    base_branch: 'main', run_host: honourDiffOutput(async () => { throw Error('must not merge again') }) })
  expect((await orch.step(saved)).run.phase).toBe('done')
  expect(f.errors).toEqual([])
})

/**
 * THE PARK, AND WHY IT IS A FAILURE RATHER THAN A WAIT.
 *
 * This case used to assert `waiting: true, changed: false` — it PINNED the park.
 * The reasoning was that a measured `unknown` is "preserved for reconciliation",
 * but nothing reconciles it, and this test itself proves the three doors are shut:
 * the launcher refuses to re-fire over a pending row (asserted below), the only
 * key that can rewrite `inner_result` is the reservation string no reader holds
 * any more (`store.ts:1044`), and the `max_inflight_ms` reaper is never reached
 * because the pending short-circuit is checked ahead of it.
 *
 * So a driver that measured and could not find out made its run IMMORTAL, and
 * silently: the outcome write moves neither `last_advanced_at` nor the stage
 * events, so the row looks exactly like one whose driver never returned. Two live
 * acceptance runs parked in `forge-init` on this, each after its plan dispatch
 * reported `unknown` at the worker wall.
 *
 * A settled `unknown` now FAILS VISIBLY. The reservation case — a promise this
 * gateway really is still running — is the next case, and still waits.
 */
test('an unverified worker APPROVE still ends REVIEW_NOT_RUN and is not classified approved', async () => {
  // The criterion names THIS path specifically: the review worker claimed APPROVE, the
  // host never obtained its receipt, and the claim survives only in the detail. The
  // verdict column must still say no host-verified review happened, because
  // `run-disposition.ts:193` maps ANY terminal APPROVE to `approved` — which would drop
  // this row out of failure analytics and report a dead build as an approved one.
  const f = await fixture()
  await createProjectLauncher(f.options)(f.input)
  f.complete(approvedButUnverified)
  await settle()
  const run = f.store.get(f.input.run.id)!
  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('must not re-fire') }, db_path: f.input.db_path,
    base_branch: 'main', run_host: honourDiffOutput(async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' })),
    observe_run_worker: async () => ({ state: 'blocked', detail: 'prompt', observed_at: new Date().toISOString(), screen: 'prompt' }) })
  const out = await orch.step(run)
  expect(out.run.phase).toBe('failed')
  // The claim is visible...
  expect(out.run.failure_reason).toContain('Review worker reported APPROVE; host receipt not obtained')
  // ...and the verdict still refuses to assert it.
  expect(out.run.inner_verdict).toBe('REVIEW_NOT_RUN')
  expect(terminalRunDisposition(out.run)).not.toBe('approved')
})

test('a settled driver unknown fails the run instead of parking it forever', async () => {
  const f = await fixture()
  await createProjectLauncher(f.options)(f.input)
  f.complete(unknown)
  await settle()
  const run = f.store.get(f.input.run.id)!
  expect(JSON.parse(run.inner_result!).projectBuild).toEqual(unknown)
  // Still `pending`, and still not a PRIOR gateway's promise: the fact that
  // separates it from a live driver is the absence of a reservation, not the kind.
  expect(projectBuildPending(run.inner_result)).toBe(true)
  expect(projectBuildDriverReservationFromPriorGateway(run.inner_result)).toBe(false)
  expect(projectBuildMeasuredUnknown(run.inner_result)).toBe('Transport uncertain')
  // The driver settling is now OBSERVABLE. Without this event the wall firing and
  // the wall never firing are the same row.
  expect(f.store.stageEvents(f.input.run.id).map(event => event.stage)).toContain('build-driver-settled')
  expect(JSON.parse(f.store.stageEvents(f.input.run.id).find(event => event.stage === 'build-driver-settled')!.meta!))
    .toEqual({ kind: 'unknown', detail: 'Transport uncertain' })

  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('must not re-fire') }, db_path: f.input.db_path,
    base_branch: 'main', run_host: honourDiffOutput(async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' })),
    observe_run_worker: async () => ({ state: 'blocked', detail: 'prompt', observed_at: new Date().toISOString(), screen: 'prompt' }) })
  const out = await orch.step(run)
  expect(out.waiting).toBe(false)
  expect(out.changed).toBe(true)
  expect(out.run.phase).toBe('failed')
  // The driver's own cause survives onto the row, so the stop is diagnosable.
  expect(out.run.failure_reason).toContain('Transport uncertain')
  // THE VERDICT COLUMN MUST NOT SAY APPROVED FOR A RUN THAT FAILED.
  // `run-disposition.ts:193` maps ANY terminal APPROVE to `approved`, which drops the
  // row out of failure analytics and narrates a dead build to the owner as an approved
  // one. Cross-model arbitration reverted an earlier change for exactly this, and the
  // property was left unpinned: mutating `orchestrator.ts` REVIEW_NOT_RUN -> APPROVE
  // kept this file green.
  expect(out.run.inner_verdict).toBe('REVIEW_NOT_RUN')
  expect(terminalRunDisposition(out.run)).not.toBe('approved')
  // And the reason the park was fatal rather than merely slow: nothing re-fires
  // over a pending row, so a run left waiting here can never be restarted either.
  expect(await createProjectLauncher(f.options)(f.input)).toEqual({ status: 'unconfirmed', error: 'Existing project build requires reconciliation' })
  expect(f.starts()).toBe(1)
})

test('a live reservation from this gateway still waits rather than being reaped', async () => {
  const f = await fixture()
  // Fired, reserved, and the driver promise deliberately left unresolved.
  expect((await createProjectLauncher(f.options)(f.input)).status).toBe('fired')
  const run = f.store.get(f.input.run.id)!
  expect(projectBuildPending(run.inner_result)).toBe(true)
  // A reservation is present, so this is NOT the settled-unknown shape.
  expect(projectBuildMeasuredUnknown(run.inner_result)).toBeNull()
  expect(projectBuildDriverReservationFromPriorGateway(run.inner_result)).toBe(false)
  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('must not re-fire') }, db_path: f.input.db_path,
    base_branch: 'main', run_host: honourDiffOutput(async () => { throw Error('must not reap') }),
    observe_run_worker: async () => ({ state: 'blocked', detail: 'prompt', observed_at: new Date().toISOString(), screen: 'prompt' }) })
  const out = await orch.step(run)
  expect(out.waiting).toBe(true)
  expect(out.changed).toBe(false)
  expect(out.run.subagent_run_id).toBe('worker-7')
  expect(out.run.inner_result).toBe(run.inner_result)
})

test('competing launchers reserve once and stopped rows reject both reservation and completion', async () => {
  const f = await fixture()
  const results = await Promise.all([createProjectLauncher(f.options)(f.input), createProjectLauncher(f.options)(f.input)])
  expect(results.map(r => r.status).sort()).toEqual(['fired', 'unconfirmed'])
  expect(f.starts()).toBe(1)
  const reserved = f.store.get(f.input.run.id)!.inner_result
  expect(await f.store.compareProjectBuildResult(f.input.run.id, 'wrong', 'overwrite')).toBe(false)
  await f.store.update(f.input.run.id, { phase: 'stopped' })
  expect(await f.store.compareProjectBuildResult(f.input.run.id, reserved, 'overwrite')).toBe(false)
  f.complete(merged)
  await settle()
  expect(f.store.get(f.input.run.id)!.inner_result).toBe(reserved)
  expect(f.errors).toHaveLength(1)
})

test('unconfirmable construction times out then settles; construction failure is failed', async () => {
  const f = await fixture()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const launch = createProjectLauncher({ ...f.options, settleMs: 1, prepare: async () => { await wait; return {} as hostModule.ProjectBuildHostOptions } })
  const result = await launch(f.input)
  expect(result.status).toBe('unconfirmed')
  expect(f.starts()).toBe(0)
  expect(result.turn_cancelled).toBe(false)
  release()
  expect((await result.settled)?.status).toBe('fired')
  f.complete(unknown)
  await settle()
  const bad = createProjectLauncher({ ...f.options, prepare: async () => { throw Error('broken configuration') } })
  await f.store.update(f.input.run.id, { inner_result: null })
  expect(await bad(f.input)).toEqual({ status: 'failed', error: 'Error: broken configuration' })
  expect(parseInnerResult(f.store.get(f.input.run.id)!.inner_result)?.checkpoint).toBe('inner-error')
})

test('a rejecting driver settles as inner-error rather than stranding the reservation forever', async () => {
  const f = await fixture()
  f.construct.mockImplementation(async () => ({ runners: {}, workers: {} as never, deps: {} as never,
    run: async () => { throw Error('transport exploded') } }))
  expect(await createProjectLauncher(f.options)(f.input)).toEqual({ status: 'fired', error: null })
  await settle()
  const run = f.store.get(f.input.run.id)!
  // The reservation is GONE: a thrown error is not the driver's measured `unknown`.
  expect(projectBuildPending(run.inner_result)).toBe(false)
  expect(parseInnerResult(run.inner_result)?.checkpoint).toBe('inner-error')
  expect(parseInnerResult(run.inner_result)?.ok).toBe(false)
  // ...and the error is still reported, not swallowed by the settlement write.
  expect(f.errors.map(String)).toEqual(['Error: transport exploded'])
  // The harvest can now see it. Left pending, `step()` short-circuits ahead of the
  // in-flight ceiling and the run is immortal.
  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('must not re-fire') }, db_path: f.input.db_path,
    base_branch: 'main', run_host: honourDiffOutput(async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' })),
    observe_run_worker: async () => ({ state: 'unknown' as const, detail: 'gone', observed_at: new Date().toISOString(), screen: '' }) })
  const out = await orch.step(run)
  expect(out.waiting).toBe(false)
  expect(out.changed).toBe(true)
})

test('result mappings retain driver causes and wave/Ralph handoffs', async () => {
  const f = await fixture()
  for (const raw of [null, '', '{', 'null', '{}', '{"projectBuild":{"kind":"merged"}}']) expect(projectBuildPending(raw)).toBe(false)
  const deadDriverReservation = JSON.stringify({
    projectBuild: { kind: 'unknown', phase: 'plan', step_id: null, detail: 'awaiting outcome' },
    projectBuildReservation: { kind: 'in-process-driver', gateway_session: 'prior-gateway' },
  })
  // Both are `unknown`, but only the reservation identifies a promise that the
  // previous gateway owned and therefore may reconcile after it exits.
  expect(projectBuildPending(deadDriverReservation)).toBe(true)
  expect(projectBuildDriverReservation(deadDriverReservation)).toBe(deadDriverReservation)
  const blocked = parseInnerResult(projectBuildResult({ kind: 'blocked', phase: 'review', on: 'missing source', recipient: 'orchestrator', cleanup: merged.cleanup }, f.input))!
  expect(blocked.ok).toBe(false)
  expect(blocked.terminal_cause).toBe('missing source')
  const built = parseInnerResult(projectBuildResult({ kind: 'built', cause: 'wave-member-built', snapshot: merged.snapshot, cleanup: merged.cleanup }, f.input))!
  expect(built.built).toBe(true)
  expect(built.checkpoint).toBe('wave-member-built')
  expect(built.commit_sha).toBe(merged.snapshot.head)
  const next = parseInnerResult(projectBuildResult({ kind: 'continued', cause: 'ralph-task-built', remainingTasks: 2, snapshot: merged.snapshot, cleanup: merged.cleanup }, f.input))!
  expect(next.publish_requested).toBe(true)
  expect(next.checkpoint).toBe('ralph-task-built')
  expect(next.remaining_tasks).toBe(2)
  // #990 — the PR-number domain check lives in the HARVEST PARSER, so it only
  // still applies if the driver's own terminal outcome reaches `inner_result` in
  // the shape `parseInnerResult` reads. Round-trip the merged outcome to pin that.
  const done = parseInnerResult(projectBuildResult(merged, f.input))!
  expect(done.ok).toBe(true)
  expect(done.pr_merged).toBe(true)
  expect(done.verdict).toBe('APPROVE')
  // The three fields the merged harvest path actually consumes (`orchestrator.ts:4200-4212`
  // reads `pr_number`, `branch` and `checkpoint`; it does NOT read `commit_sha`, which
  // `parseInnerResult` only decodes under `built === true`).
  expect(done.checkpoint).toBe('merged')
  expect(done.pr_number).toBe(12)
  expect(done.branch).toBe('change')
  // ...and the sentinel is still mapped to null rather than decoded as PR 0, which
  // is the exact defect the domain check exists to stop (`inner-loop.ts:872`).
  const noPr = parseInnerResult(projectBuildResult({ ...merged, snapshot: { ...merged.snapshot, pr: null } },
    { ...f.input, run: { ...f.input.run, pr: 0 } }))!
  expect(noPr.pr_number).toBeNull()
})
