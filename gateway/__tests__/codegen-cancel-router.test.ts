import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { CodegenOrchestrator, type CodegenRunner } from '@neutronai/codegen-core'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { buildTridentTerminator } from '@neutronai/trident/terminate.ts'
import { routeCodegenCancel, type UnifiedCancelResult } from '../codegen-cancel-router.ts'
import { buildCoresBackendFactories } from '../boot-cores-factories.ts'

let tmp: string
let db: ProjectDb
let trident: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'unified-cancel-'))
  const path = join(tmp, 'project.db')
  const raw = new Database(path, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(path)
  trident = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function legacy(): CodegenOrchestrator {
  const runner: CodegenRunner = {
    run: async () => ({ pr_number: 1, branch: 'legacy', worktree: '/tmp', summary: 'done' }),
  }
  return new CodegenOrchestrator({
    runner,
    schedule_kickoff: () => {},
  })
}

describe('one codegen_cancel surface routes both dispatch paths', () => {
  test('MUTATION: removing the Trident termination leaves a live run and this test fails', async () => {
    const run = await trident.create({
      id: 'trident-live', slug: 'live', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p')

    const result = await router.cancel({ task_id: run.id }) as UnifiedCancelResult

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
    expect(trident.get(run.id)).toMatchObject({ phase: 'stopped', failure_reason: 'cancelled via codegen_cancel' })
  })

  test('MUTATION: dropping the production terminator skips terminal observers and transition fans', async () => {
    const run = await trident.create({
      id: 'trident-observed', slug: 'observed', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const calls: string[] = []
    const terminator = buildTridentTerminator({
      store: trident,
      onTransition: { onTransition: async () => { calls.push('transition') } },
      observer: { onTerminal: async () => { calls.push('terminal') } },
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', terminator)

    await router.cancel({ task_id: run.id })

    expect(calls).toEqual(['transition', 'terminal'])
  })

  test('MUTATION: treating an already-terminal Trident run as unknown restores the false alarm', async () => {
    const run = await trident.create({
      id: 'trident-crashed', slug: 'crashed', project_slug: 'p', repo_path: '/repo', task: 'build',
      phase: 'failed',
    })
    await trident.update(run.id, { failure_reason: 'workflow crashed' })
    const router = routeCodegenCancel(legacy(), trident, 'p')

    const result = await router.cancel({ task_id: run.id }) as UnifiedCancelResult

    expect(result).toMatchObject({
      cancelled: false, dispatch_path: 'trident', phase: 'failed',
      reason: 'workflow crashed', already_terminal: true,
    })
  })

  test('MUTATION: bypassing the legacy tracker regresses the cancel path that already worked', async () => {
    const old = legacy()
    const { task_id } = await old.dispatch({ task: 'legacy build' })
    const router = routeCodegenCancel(old, trident, 'p')

    const result = await router.cancel({ task_id }) as UnifiedCancelResult

    expect(result).toMatchObject({ cancelled: true, prior_status: 'pending', dispatch_path: 'legacy_codegen' })
    expect(old.status({ task_id }).status).toBe('cancelled')
  })

  test('MUTATION: exact-only lookup rejects the displayed id prefix and this test fails', async () => {
    const run = await trident.create({
      id: '12345678-full-run-id', slug: 'prefix-run', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p')

    const result = await router.cancel({ task_id: run.id.slice(0, 8) })

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
  })

  test('MUTATION: unscoped lookup can cancel another project and this test fails', async () => {
    const run = await trident.create({
      id: 'other-project-run', slug: 'foreign', project_slug: 'other', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p')

    await expect(router.cancel({ task_id: run.id })).rejects.toBeInstanceOf(Error)
    expect(trident.get(run.id)?.phase).toBe('forge-init')
  })

  test('MUTATION: cancel-only routing leaves status and fetch reporting a live Trident run as unknown', async () => {
    const run = await trident.create({
      id: 'trident-readable', slug: 'readable', project_slug: 'p', repo_path: '/repo', task: 'build widget',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p')

    expect(router.status({ task_id: run.slug })).toMatchObject({
      status: 'forge-init', dispatch_path: 'trident', run_id: run.id, already_terminal: false,
    })
    expect(router.fetch({ task_id: run.id.slice(0, 8) })).toMatchObject({
      phase: 'forge-init', dispatch_path: 'trident', summary: 'build widget',
    })
  })

  test('MUTATION: deleting production factory routing leaves the installed Code-Gen backend unable to reach Trident', async () => {
    const run = await trident.create({
      id: 'production-wired-run', slug: 'wired', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const transitions: string[] = []
    const factories = await buildCoresBackendFactories({
      projectDb: db,
      owner_home: tmp,
      emailResolver: {} as never,
      tridentTerminator: {
        terminate: async (id, phase, opts) => {
          transitions.push(id)
          return buildTridentTerminator({ store: trident }).terminate(id, phase, opts)
        },
      },
    })
    const backend = await factories.codegen_core!({ project_slug: 'p' } as never) as {
      orchestrator: { cancel(input: { task_id: string }): Promise<UnifiedCancelResult> }
    }

    const result = await backend.orchestrator.cancel({ task_id: run.id.slice(0, 8) })

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
    expect(transitions).toEqual([run.id])
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })
})
