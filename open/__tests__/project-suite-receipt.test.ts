import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { createProjectSuiteReceipts } from '@neutronai/trident/project-suite-receipt.ts'
import type { BuildSnapshot } from '@neutronai/trident/build-run.ts'
import type { ReviewSuiteSource, SuiteObservation } from '@neutronai/trident/gates/review-suite.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { projectSuiteIdentity } from '../wiring/project-build-dependencies.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** A declared workspace with node_modules/@scope/pkg -> ../../pkg and a
 * third-party package, committed clean, beside a real migrated run store. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'suite-receipt-'))
  const root = join(dir, 'work')
  await mkdir(root)
  const git = async (...args: string[]) => {
    const result = await spawnCapture(['git', ...args], root)
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['pkg'] }))
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  await mkdir(join(root, 'pkg'))
  await writeFile(join(root, 'pkg', 'package.json'), JSON.stringify({ name: '@scope/pkg', main: 'index.js' }))
  await writeFile(join(root, 'pkg', 'index.js'), 'module.exports = "first party"\n')
  await mkdir(join(root, 'node_modules', '@scope'), { recursive: true })
  await symlink('../../pkg', join(root, 'node_modules', '@scope', 'pkg'))
  await mkdir(join(root, 'node_modules', 'third'))
  await writeFile(join(root, 'node_modules', 'third', 'package.json'), '{"name":"third","main":"index.js"}')
  await writeFile(join(root, 'node_modules', 'third', 'index.js'), 'module.exports = 1\n')
  await git('add', '.')
  await git('commit', '-qm', 'workspace')
  const head = await git('rev-parse', 'HEAD')
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const created = await store.create({ slug: 'build', project_slug: 'project', repo_path: dir, task: 'Build' })
  await store.update(created.id, { branch: 'change', worktree: root, base_sha: head })
  const run = store.get(created.id)!
  const snapshot: BuildSnapshot = { head, diff: '', pr: null }
  const green: SuiteObservation = { kind: 'known', runId: run.id, head, round: 1, strategy: 'bun test',
    scope: 'full-suite', report: { hostExitCode: 0 } }
  const events = () => store.stageEvents(run.id).filter(event => event.stage === 'build-suite-receipt')
    .map(event => JSON.parse(event.meta ?? 'null'))
  const receipts = (identity: (snapshot: BuildSnapshot) => Promise<string | null>) =>
    createProjectSuiteReceipts({ store, run, identity })
  return { root, store, run, snapshot, green, events, receipts }
}

const counted = (observe: ReviewSuiteSource['observe']) => {
  const source = { calls: 0, async observe(snapshot: BuildSnapshot, round: number) { source.calls++; return observe(snapshot, round) } }
  return source
}

test('a green suite that scratches a workspace directory is saved and reused', async () => {
  const f = await fixture()
  // Positive control: the real identity measures this fixture.
  expect(await projectSuiteIdentity(f.root, f.snapshot.head)).toMatch(/^[a-f0-9]{64}$/)
  const receipts = f.receipts(snapshot => projectSuiteIdentity(f.root, snapshot.head))
  const source = counted(async () => {
    const scratch = join(f.root, 'pkg', 'scratch.tmp')
    await writeFile(scratch, 'temporary')
    await rm(scratch)
    const future = new Date(Date.now() + 5000)
    await utimes(join(f.root, 'pkg'), future, future)
    return f.green
  })
  expect(await receipts.observe(source, f.snapshot, 1, 'bun test', 'full-suite')).toEqual(f.green)
  const saved = f.events().at(-1)
  expect(saved.identity).toMatch(/^[a-f0-9]{64}$/)
  expect(saved.receipt).toEqual(f.green)
  const refused = counted(async () => { throw new Error('a saved receipt must not re-run the suite') })
  expect(await receipts.observe(refused, f.snapshot, 1, 'bun test', 'full-suite')).toEqual(f.green)
  expect(source.calls + refused.calls).toBe(1)
})

test('a suite that changes installed dependencies settles unknown and saves nothing', async () => {
  const f = await fixture()
  const receipts = f.receipts(snapshot => projectSuiteIdentity(f.root, snapshot.head))
  const source = counted(async () => {
    await writeFile(join(f.root, 'node_modules', 'third', 'index.js'), 'module.exports = 2\n')
    return f.green
  })
  expect(await receipts.observe(source, f.snapshot, 1, 'bun test', 'full-suite'))
    .toEqual({ kind: 'unknown', detail: 'Suite inputs changed during host observation' })
  expect(f.events().at(-1).receipt).toBeUndefined()
  expect(f.events().some(event => event.receipt)).toBe(false)
})

test('an unknown-before observation is consumed once and never saved as proof', async () => {
  const f = await fixture()
  const receipts = f.receipts(async () => null)
  const source = counted(async () => f.green)
  expect(await receipts.observe(source, f.snapshot, 1, 'bun test', 'full-suite')).toEqual(f.green)
  expect(f.events().some(event => event.receipt || event.identity)).toBe(false)
  expect(await receipts.observe(source, f.snapshot, 1, 'bun test', 'full-suite')).toEqual(f.green)
  expect(source.calls).toBe(2)
})
