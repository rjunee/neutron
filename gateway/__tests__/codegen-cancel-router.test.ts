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
    const router = routeCodegenCancel(legacy(), trident)

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
    const router = routeCodegenCancel(legacy(), trident, terminator)

    await router.cancel({ task_id: run.id })

    expect(calls).toEqual(['transition', 'terminal'])
  })

  test('MUTATION: treating an already-terminal Trident run as unknown restores the false alarm', async () => {
    const run = await trident.create({
      id: 'trident-crashed', slug: 'crashed', project_slug: 'p', repo_path: '/repo', task: 'build',
      phase: 'failed',
    })
    await trident.update(run.id, { failure_reason: 'workflow crashed' })
    const router = routeCodegenCancel(legacy(), trident)

    const result = await router.cancel({ task_id: run.id }) as UnifiedCancelResult

    expect(result).toMatchObject({
      cancelled: false, dispatch_path: 'trident', phase: 'failed',
      reason: 'workflow crashed', already_terminal: true,
    })
  })

  test('MUTATION: bypassing the legacy tracker regresses the cancel path that already worked', async () => {
    const old = legacy()
    const { task_id } = await old.dispatch({ task: 'legacy build' })
    const router = routeCodegenCancel(old, trident)

    const result = await router.cancel({ task_id }) as UnifiedCancelResult

    expect(result).toMatchObject({ cancelled: true, prior_status: 'pending', dispatch_path: 'legacy_codegen' })
    expect(old.status({ task_id }).status).toBe('cancelled')
  })
})
