import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { seedProject } from './wiring/__tests__/project-admission-fixture.ts'
import { ProjectAdmission } from './project-admission.ts'
import { reconcileBuildLeases } from './project-admission-reconcile.ts'

const OWNER_SLUG = 'owner'
const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'admission-reconcile-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const open = (bootId = 'boot-a') => {
    const db = ProjectDb.open(path)
    cleanup.push(() => db.close())
    const admission = new ProjectAdmission({ db, ownerHandle: 'owner-a', bootId })
    const runs = new TridentRunStore(db)
    return { db, admission, runs }
  }
  return { ...open(), open }
}

/** The composer's mapping: the owner slug is General, anything else a project id. */
const projectIdForRun = (run: TridentRun): string | null => (run.project_slug === OWNER_SLUG ? null : run.project_slug)

async function makeRun(runs: TridentRunStore, slug: string, project_slug = OWNER_SLUG): Promise<TridentRun> {
  return runs.create({ slug, project_slug, repo_path: `/repo/${slug}`, task: `task ${slug}` })
}

const buildLeases = (admission: ProjectAdmission): Array<[string | null, string]> =>
  admission.listLeases('build').map((l) => [l.scope.projectId, l.workRef])

test('reconcile releases a terminal or missing run, keeps a live run, and re-leases an unleased live run', async () => {
  const { db, admission, runs } = fixture()
  seedProject(db, 'alpha')
  const terminal = await makeRun(runs, 'terminal')
  const live = await makeRun(runs, 'live')
  const unleased = await makeRun(runs, 'unleased', 'alpha')
  await admission.admit(null, 'build', 'work-board', terminal.id)
  await admission.admit(null, 'build', 'work-board', live.id)
  await admission.admit(null, 'build', 'work-board', 'run-that-no-longer-exists')
  // A non-build lease is not this reconciler's to touch.
  await admission.admit(null, 'conversation', 'chat', terminal.id)
  await runs.update(terminal.id, { phase: 'failed' })

  const result = await reconcileBuildLeases({ admission, runs, projectIdForRun })

  expect(result).toEqual({ released: 2, kept: 1, children_kept: 0, leased: 1, unleased_fenced: 0, unleased_unknown: 0 })
  expect(buildLeases(admission)).toEqual([[null, live.id], ['alpha', unleased.id]])
  expect(admission.listLeases('conversation').map((l) => l.workRef)).toEqual([terminal.id])

  // Idempotent: a second pass finds everything already consistent.
  expect(await reconcileBuildLeases({ admission, runs, projectIdForRun }))
    .toEqual({ released: 0, kept: 2, children_kept: 0, leased: 0, unleased_fenced: 0, unleased_unknown: 0 })
})

test('a FENCED scope is not re-leased — the live run is counted and logged at warn', async () => {
  const { admission, runs } = fixture()
  const live = await makeRun(runs, 'live-under-fence')
  await admission.maintenance.register(admission.scopeFor(null))
  const fence = await admission.maintenance.beginMaintenance(admission.scopeFor(null))
  expect(fence).not.toBeNull()

  const warns = spyOn(console, 'warn').mockImplementation(() => {})
  let result
  try {
    result = await reconcileBuildLeases({ admission, runs, projectIdForRun })
    const emitted = warns.mock.calls.flat().join(' ')
    expect(emitted).toContain('admission_reconcile_unleased_live_run')
    expect(emitted).toContain(live.id)
  } finally {
    warns.mockRestore()
  }
  expect(result).toEqual({ released: 0, kept: 0, children_kept: 0, leased: 0, unleased_fenced: 1, unleased_unknown: 0 })
  expect(buildLeases(admission)).toEqual([])

  // Opposite control: the same run in the same scope IS re-leased once it reopens.
  expect(await admission.maintenance.abandon(fence!)).toBe(true)
  expect((await reconcileBuildLeases({ admission, runs, projectIdForRun })).leased).toBe(1)
  expect(buildLeases(admission)).toEqual([[null, live.id]])
})

test('a live run in a scope that is not a live project is counted as unknown, never leased', async () => {
  const { admission, runs } = fixture()
  await makeRun(runs, 'orphan', 'deleted-project')
  const warns = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await reconcileBuildLeases({ admission, runs, projectIdForRun }))
      .toEqual({ released: 0, kept: 0, children_kept: 0, leased: 0, unleased_fenced: 0, unleased_unknown: 1 })
  } finally {
    warns.mockRestore()
  }
  expect(buildLeases(admission)).toEqual([])
})

test('RESTART: leases written through one connection are reconciled through a second on the same file', async () => {
  const first = fixture()
  const done = await makeRun(first.runs, 'done-before-crash')
  const running = await makeRun(first.runs, 'running-across-crash')
  await first.admission.admit(null, 'build', 'work-board', done.id)
  await first.admission.admit(null, 'build', 'work-board', running.id)
  // The run terminalized, but the process "died" before its terminal observer released.
  await first.runs.update(done.id, { phase: 'done' })

  const second = first.open('boot-b')
  expect(buildLeases(second.admission)).toEqual([[null, done.id], [null, running.id]])
  const result = await reconcileBuildLeases({ admission: second.admission, runs: second.runs, projectIdForRun })
  expect(result).toEqual({ released: 1, kept: 1, children_kept: 0, leased: 0, unleased_fenced: 0, unleased_unknown: 0 })
  expect(buildLeases(second.admission)).toEqual([[null, running.id]])
  // The survivor keeps the PRODUCER of the boot that admitted it — reconcile does not re-stamp live work.
  expect(second.admission.listLeases('build')[0]!.producer).toBe('work-board:boot-a')
})

test('reconcile releases a terminal run\'s child lease, keeps a live run\'s, and never re-leases a child (#1237)', async () => {
  const first = fixture()
  const done = await makeRun(first.runs, 'done-with-child')
  const live = await makeRun(first.runs, 'live-with-child')
  for (const run of [done, live]) {
    await first.admission.forDispatch(null, 'work-board').admit(run.id)
    expect((await first.admission.forNativeChild(null).admit(run.id, 'build:0')).status).toBe('admitted')
  }
  // A child lease whose run row is gone entirely.
  expect((await first.admission.forNativeChild(null).admit('vanished-run', 'plan:0')).status).toBe('admitted')
  await first.runs.update(done.id, { phase: 'failed' })

  // Through a second connection: the terminal observer's release was "lost".
  const second = first.open('boot-b')
  const result = await reconcileBuildLeases({ admission: second.admission, runs: second.runs, projectIdForRun })
  expect(result).toEqual({ released: 3, kept: 1, children_kept: 1, leased: 0, unleased_fenced: 0, unleased_unknown: 0 })
  expect(second.admission.listLeases().map((l) => [l.reason, l.workRef]))
    .toEqual([['build', live.id], ['liveChild', live.id]])

  // Never re-leased: a live run whose child lease is gone gets no new child row.
  await second.admission.releaseBuild(null, live.id)
  const again = await reconcileBuildLeases({ admission: second.admission, runs: second.runs, projectIdForRun })
  expect(again).toMatchObject({ leased: 1, children_kept: 0 })
  expect(second.admission.listLeases('liveChild')).toEqual([])
})
