import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { createProjectSuiteReceipts, SUITE_IDENTITY_COMPONENTS, type SuiteIdentityComponents } from './project-suite-receipt.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const after of ['unchanged', 'changed', 'unavailable', 'throws'] as const) {
  for (const exit of [0, 1]) test(`suite observation retains exit ${exit} with ${after} identity`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suite-receipt-'))
    const path = join(dir, 'project.db')
    seedMigratedDb(path)
    const db = ProjectDb.open(path)
    cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'suite', project_slug: 'fixture', repo_path: dir, task: 'test' })
    const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
    let calls = 0, identityCalls = 0
    const receipts = createProjectSuiteReceipts({ store, run, identity: async () => {
      identityCalls++
      if (identityCalls !== 2 || after === 'unchanged') return { identity: 'before' }
      if (after === 'throws') throw Error('private filesystem error must not be retained')
      return after === 'changed' ? { identity: 'after' } : null
    } })
    const source = { observe: async () => {
      calls++
      return { kind: 'known' as const, runId: run.id, head: snapshot.head, round: 1,
        strategy: 'bun test', scope: 'full-suite' as const, report: { hostExitCode: exit } }
    } }
    const observe = () => receipts.observe(source, snapshot, 1, 'bun test', 'full-suite')
    const result = await observe()
    if (after === 'unchanged') expect(result).toMatchObject({ kind: 'known', report: { hostExitCode: exit } })
    else expect(result).toEqual({ kind: 'unknown', detail: after === 'changed'
      ? 'Suite inputs changed during host observation' : 'Suite input identity is unavailable after host observation' })
    const meta = JSON.parse(store.stageEvents(run.id).filter(event => event.stage === 'build-suite-receipt').at(-1)!.meta!)
    expect(meta.observation).toEqual({
      before: { identity: 'before', components: null, at: expect.any(String) },
      after: { identity: after === 'unchanged' ? 'before' : after === 'changed' ? 'after' : null, components: null, at: expect.any(String) },
      delta: { kind: 'unavailable' },
      hostExitCode: exit,
    })
    if (after === 'unchanged') {
      expect(meta.receipt.report.hostExitCode).toBe(exit)
    } else {
      expect(meta).not.toHaveProperty('receipt')
      expect(meta).not.toHaveProperty('identity')
    }
    // The diagnostic event cannot be reused as proof, even when inputs recover.
    expect(await observe()).toMatchObject({ kind: 'known', report: { hostExitCode: exit } })
    expect(calls).toBe(after === 'unchanged' ? 1 : 2)
  })
}

for (const changed of [...SUITE_IDENTITY_COMPONENTS, 'none', 'malformed'] as const)
test(`suite refusal retains safe component delta for ${changed} and still requires fresh proof`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-component-receipt-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const run = await store.create({ slug: 'suite', project_slug: 'fixture', repo_path: dir, task: 'test' })
  const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
  const components = Object.fromEntries(SUITE_IDENTITY_COMPONENTS.map(key => [key, 'a'.repeat(64)])) as SuiteIdentityComponents
  let calls = 0, changedInputs = false
  const receipts = createProjectSuiteReceipts({ store, run, identity: async () => ({
    identity: changedInputs && changed !== 'none' ? 'b'.repeat(64) : 'a'.repeat(64),
    components: { ...components, ...(changedInputs && changed !== 'none'
      ? { [changed === 'malformed' ? 'installed' : changed]: changed === 'malformed' ? '/private/probe-secret' : 'b'.repeat(64) } : {}),
      ...{ untrusted: '/private/probe-secret' } },
  }) })
  const observe = () => receipts.observe({ observe: async () => {
    calls++
    changedInputs = true
    return { kind: 'known', runId: run.id, head: snapshot.head, round: 1,
      strategy: 'bun test', scope: 'full-suite', report: { hostExitCode: 0 } }
  } }, snapshot, 1, 'bun test', 'full-suite')
  expect(await observe()).toMatchObject({ kind: changed === 'none' ? 'known' : 'unknown' })
  const meta = JSON.parse(store.stageEvents(run.id).filter(event => event.stage === 'build-suite-receipt').at(-1)!.meta!)
  expect(meta.observation.delta).toEqual(changed === 'malformed' ? { kind: 'unavailable' }
    : { kind: 'known', changed: changed === 'none' ? [] : [changed] })
  expect(meta.observation.hostExitCode).toBe(0)
  expect(JSON.stringify(meta.observation)).not.toContain('/private/probe-secret')
  expect(JSON.stringify(meta.observation)).not.toContain('untrusted')
  if (changed !== 'none') expect(meta).not.toHaveProperty('receipt')
  expect(await observe()).toMatchObject({ kind: 'known' })
  expect(calls).toBe(changed === 'none' ? 1 : 2)
})
