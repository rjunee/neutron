import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { createProjectSuiteReceipts, SUITE_IDENTITY_COMPONENTS, type SuiteIdentityComponents } from './project-suite-receipt.ts'
import { readBuildRetrySource } from './build-mode-state.ts'
import type { ReviewSuiteSource, SuiteObservation } from './gates/review-suite.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const changed of ['none', 'red', 'head', 'round', 'strategy', 'scope', 'identity', 'environment', 'unknown', 'throws', 'terminal', 'owner', 'independent-owner'] as const)
test(`concurrent suite acquisition drains and remeasures ${changed}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-concurrent-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const run = await store.create({ slug: 'suite', project_slug: 'fixture', repo_path: dir, task: 'test' })
  const snapshot = { head: 'a'.repeat(40), diff: '+code', pr: null }
  let identity = 'before', portableIdentity = 'c'.repeat(64), calls = 0, active = 0
  let release!: () => void, started!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const receipts = createProjectSuiteReceipts({ store, run, identity: async () => ({ identity, portableIdentity }) })
  const source = (strategy: string, scope: SuiteObservation['scope'], runId = run.id): ReviewSuiteSource => ({ observe: async (subject, round) => {
    const call = ++calls
    active++
    try {
      expect(active).toBe(changed === 'independent-owner' ? call : 1)
      if (call === 1) { started(); await hold }
      if (call === 1 && changed === 'throws') throw Error('first acquisition failed')
      if (call === 1 && changed === 'unknown') return { kind: 'unknown', detail: 'first acquisition unavailable' }
      return { kind: 'known', runId, head: subject.head, round, strategy, scope,
        report: { hostExitCode: changed === 'red' ? 1 : 0 } }
    } finally { active-- }
  } })
  const first = receipts.observe(source('bun test', 'full-suite'), snapshot, 1, 'bun test', 'full-suite')
    .catch(error => ({ kind: 'unknown' as const, detail: String(error) }))
  await entered
  if (changed === 'identity') identity = 'after'
  if (changed === 'environment') portableIdentity = 'd'.repeat(64)
  if (changed === 'terminal') await store.update(run.id, { phase: 'stopped' })
  if (changed === 'owner') await store.update(run.id, { branch: 'another-owner' })
  const strategy = changed === 'strategy' ? 'bash scripts/run-tests.sh' : 'bun test'
  const scope = changed === 'scope' ? 'subset' : 'full-suite'
  const secondRun = changed === 'independent-owner'
    ? await store.create({ slug: 'other', project_slug: 'other', repo_path: dir, task: 'test' }) : run
  const secondReceipts = changed === 'independent-owner'
    ? createProjectSuiteReceipts({ store, run: secondRun, identity: async () => ({ identity, portableIdentity }) }) : receipts
  const second = secondReceipts.observe(source(strategy, scope, secondRun.id),
    changed === 'head' ? { ...snapshot, head: 'b'.repeat(40) } : snapshot,
    changed === 'round' ? 2 : 1, strategy, scope)
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(changed === 'independent-owner' ? 2 : 1)
  } finally { release(); await first }
  expect(await second).toMatchObject({ kind: changed === 'terminal' || changed === 'owner' ? 'unknown' : 'known' })
  expect(calls).toBe(['none', 'red', 'terminal', 'owner'].includes(changed) ? 1 : 2)
  expect(active).toBe(0)
})

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

for (const fault of ['none', 'legacy', 'red', 'subset', 'inputs', 'head', 'strategy', 'invalidated', 'unrelated', 'adopted', 'racing-source', 'atomic-source'] as const)
test(`portable suite adoption preserves predecessor authority: ${fault}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'suite-predecessor-'))
  const path = join(dir, 'project.db')
  seedMigratedDb(path)
  const db = ProjectDb.open(path)
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const common = { slug: 'suite', project_slug: 'fixture', repo_path: dir, task: 'test', branch: 'change', execution_strategy: 'single' as const }
  const first = await store.create(common)
  const head = 'a'.repeat(40), base = 'b'.repeat(40), portableIdentity = 'c'.repeat(64)
  await store.update(first.id, { base_sha: base, worktree: join(dir, 'first') })
  const prior = store.get(first.id)!
  const snapshot = { head, diff: '+code', pr: null }
  const sourceReceipt = { kind: 'known' as const, runId: first.id, head, round: 1,
    strategy: 'bun test', scope: 'full-suite' as const, report: { hostExitCode: 0 } }
  await createProjectSuiteReceipts({ store, run: prior, identity: async () => ({ identity: 'first', portableIdentity }) })
    .observe({ observe: async () => sourceReceipt }, snapshot, 1, 'bun test', 'full-suite')
  const original = store.stageEvents(first.id).filter(e => e.stage === 'build-suite-receipt').at(-1)!
  const altered = JSON.parse(original.meta!)
  if (fault === 'legacy') altered.version = 1
  if (fault === 'red') altered.receipt.report.hostExitCode = 1
  if (fault === 'subset') altered.receipt.scope = 'subset'
  if (fault === 'inputs') altered.portableIdentity = 'd'.repeat(64)
  if (fault === 'head') altered.receipt.head = 'd'.repeat(40)
  if (fault === 'strategy') altered.receipt.strategy = 'partial test'
  if (fault === 'invalidated') delete altered.receipt
  if (fault === 'adopted') altered.adoptedFrom = { runId: 'older', eventId: 1, round: 1 }
  await store.recordStageEvent(first.id, 'build-suite-receipt', JSON.stringify(altered))
  await store.recordStageEvent(first.id, 'build-mode-state', JSON.stringify({ runId: first.id,
    projectSlug: prior.project_slug, repo: dir, branch: prior.branch, base, worktree: prior.worktree,
    mergeMode: prior.merge_mode, iteration: 0,
    checkpoint: { head, stage: 'built', round: 1, replansUsed: 0, findings: [], previousFindings: [] } }))
  const mode = store.stageEvents(first.id).filter(e => e.stage === 'build-mode-state').at(-1)!
  await store.update(first.id, { phase: 'failed', worktree: null })
  const next = await store.create(common)
  await store.update(next.id, { base_sha: base, worktree: join(dir, 'second'), inner_checkpoint_head: head })
  await store.recordStageEvent(next.id, 'build-retry-source', JSON.stringify({ runId: next.id,
    priorRunId: fault === 'unrelated' ? 'absent' : first.id, eventId: mode.id, head }))
  const run = store.get(next.id)!
  if (fault === 'atomic-source') {
    const append = store.appendSuiteReceipt.bind(store)
    store.appendSuiteReceipt = async (...args) => {
      if (args[3]) await store.recordStageEvent(first.id, 'build-suite-receipt', JSON.stringify({ version: 2 }))
      return append(...args)
    }
  }
  if (fault !== 'unrelated') expect(readBuildRetrySource(store, run)?.prior.id).toBe(first.id)
  let paid = 0, measurements = 0
  const receipts = createProjectSuiteReceipts({ store, run, identity: async () => {
    if (++measurements === 2 && fault === 'racing-source') {
      await store.recordStageEvent(first.id, 'build-suite-receipt', JSON.stringify({ version: 2 }))
    }
    return { identity: 'second', portableIdentity }
  } })
  const result = await receipts.observe({ observe: async () => { paid++; return { ...sourceReceipt, runId: next.id } } },
    snapshot, 1, 'bun test', 'full-suite')
  if (fault === 'atomic-source') {
    expect(result).toMatchObject({ kind: 'unknown' })
    expect(paid).toBe(0)
    expect(store.stageEvents(next.id).filter(e => e.stage === 'build-suite-receipt')).toHaveLength(0)
    return
  }
  expect(result).toMatchObject({ kind: 'known', runId: next.id, report: { hostExitCode: 0 } })
  expect(paid).toBe(fault === 'none' ? 0 : 1)
  const saved = JSON.parse(store.stageEvents(next.id).filter(e => e.stage === 'build-suite-receipt').at(-1)!.meta!)
  if (fault === 'none') expect(saved.adoptedFrom).toMatchObject({ runId: first.id, round: 1 })
  else expect(saved.adoptedFrom).toBeUndefined()
  if (fault === 'none') {
    const source = { observe: async () => { paid++; return { ...sourceReceipt, runId: next.id } } }
    // Reconstruction retains adoption only while its measured environment still
    // agrees; the strict destination inode identity alone is insufficient.
    await receipts.observe(source, snapshot, 1, 'bun test', 'full-suite')
    expect(paid).toBe(0)
    const changed = createProjectSuiteReceipts({ store, run,
      identity: async () => ({ identity: 'second', portableIdentity: 'e'.repeat(64) }) })
    await changed.observe(source, snapshot, 1, 'bun test', 'full-suite')
    expect(paid).toBe(1)
  }
})
