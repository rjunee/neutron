import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodegenInputError, CodegenOrchestrator, type CodegenRunner } from '@neutronai/codegen-core'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { buildTridentTerminator } from '@neutronai/trident/terminate.ts'
import { routeCodegenCancel, type UnifiedCancelResult } from '../codegen-cancel-router.ts'
import { buildCoresBackendFactories } from '../boot-cores-factories.ts'
import { openMigratedDatabaseAt } from '../../tests/support/migrated-db.ts'

let tmp: string
let db: ProjectDb
let trident: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'unified-cancel-'))
  const path = join(tmp, 'project.db')
  const raw = openMigratedDatabaseAt(path)
  raw.close()
  db = ProjectDb.open(path)
  trident = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * The bare terminator these cases mean: phase-only, no observers.
 *
 * Spelled out at every call because `routeCodegenCancel` no longer defaults it.
 * That default was the defect — it fabricated an observer-less terminator, so a
 * cancel returned `cancelled: true` while the board never reconciled and no
 * `projects_changed` reached the rail, and no unit test could tell (each builds
 * its own terminator anyway). Making it explicit here is the cost of making a
 * missing production thread a typecheck failure.
 */
function bare(): ReturnType<typeof buildTridentTerminator> {
  return buildTridentTerminator({ store: trident })
}

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
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    const result = await router.cancel({ task_id: run.id }) as UnifiedCancelResult

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
    expect(trident.get(run.id)).toMatchObject({ phase: 'stopped', failure_reason: 'cancelled via codegen_cancel' })
  })

  test('MUTATION: suppressing all terminal observers skips project-board reconciliation', async () => {
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
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    const result = await router.cancel({ task_id: run.id }) as UnifiedCancelResult

    expect(result).toMatchObject({
      cancelled: false, dispatch_path: 'trident', phase: 'failed',
      reason: 'workflow crashed', already_terminal: true,
    })
  })

  test('MUTATION: bypassing the legacy tracker regresses the cancel path that already worked', async () => {
    const old = legacy()
    const { task_id } = await old.dispatch({ task: 'legacy build' })
    const router = routeCodegenCancel(old, trident, 'p', bare())

    const result = await router.cancel({ task_id }) as UnifiedCancelResult

    expect(result).toMatchObject({ cancelled: true, prior_status: 'pending', dispatch_path: 'legacy_codegen' })
    expect(old.status({ task_id }).status).toBe('cancelled')
  })

  test('MUTATION: exact-only lookup rejects the displayed id prefix and this test fails', async () => {
    const run = await trident.create({
      id: '12345678-full-run-id', slug: 'prefix-run', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    const result = await router.cancel({ task_id: run.id.slice(0, 8) })

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
  })

  test('MUTATION: owner-scoped lookup cannot read a project-board run and this test fails', async () => {
    const run = await trident.create({
      id: 'project-board-run', slug: 'project-run', project_slug: 'bare-project-id', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'owner-handle', bare())

    expect(await router.status({ task_id: run.id })).toMatchObject({ run_id: run.id, phase: 'forge-init' })
    expect(await router.fetch({ task_id: run.id })).toMatchObject({ run_id: run.id, phase: 'forge-init' })
    expect(await router.cancel({ task_id: run.id })).toMatchObject({ cancelled: true, phase: 'stopped' })
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })

  test('MUTATION: blank cancel references must not prefix-match the only live run', async () => {
    const run = await trident.create({
      id: 'blank-reference-target', slug: 'blank-target', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    await expect(router.cancel({ task_id: '' })).rejects.toThrow('must be a non-empty string')
    expect(trident.get(run.id)?.phase).toBe('forge-init')
  })

  test('MUTATION: dereferencing malformed tool payloads leaks native TypeErrors', async () => {
    const run = await trident.create({
      id: 'malformed-input-target', slug: 'malformed-target', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    await expect(router.status(null as never)).rejects.toBeInstanceOf(CodegenInputError)
    await expect(router.fetch({} as never)).rejects.toBeInstanceOf(CodegenInputError)
    await expect(router.cancel({ task_id: 7 } as never)).rejects.toBeInstanceOf(CodegenInputError)
    expect(trident.get(run.id)?.phase).toBe('forge-init')
  })

  test('MUTATION: ambiguous shorthand must not select a run by recency', async () => {
    await trident.create({ id: '12345678-one', slug: 'shared', project_slug: 'one', repo_path: '/repo', task: 'one' })
    await trident.create({ id: '12345678-two', slug: 'shared', project_slug: 'two', repo_path: '/repo', task: 'two' })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    // The message moved from the STORE's wording to the Code-Gen tool contract's
    // (see the ambiguity describe below): the raw `TridentRunReferenceAmbiguousError`
    // used to escape the MCP boundary as an internal error. What this case actually
    // guards is unchanged and is the two phase assertions underneath — an ambiguous
    // prefix must not pick a run by recency.
    await expect(router.cancel({ task_id: '12345678' })).rejects.toThrow('more of the id')
    expect(trident.get('12345678-one')?.phase).toBe('forge-init')
    expect(trident.get('12345678-two')?.phase).toBe('forge-init')
  })

  test('MUTATION: cancel-only routing leaves status and fetch reporting a live Trident run as unknown', async () => {
    const run = await trident.create({
      id: 'trident-readable', slug: 'readable', project_slug: 'p', repo_path: '/repo', task: 'build widget',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    expect(await router.status({ task_id: run.slug })).toMatchObject({
      status: 'forge-init', dispatch_path: 'trident', run_id: run.id, already_terminal: false,
    })
    expect(await router.fetch({ task_id: run.id.slice(0, 8) })).toMatchObject({
      phase: 'forge-init', dispatch_path: 'trident',
    })
    expect(await router.fetch({ task_id: run.id })).not.toHaveProperty('summary')
  })

  test('MUTATION: deleting production factory routing leaves the installed Code-Gen backend unable to reach Trident', async () => {
    const run = await trident.create({
      id: 'production-wired-run', slug: 'wired', project_slug: 'bare-project-id', repo_path: '/repo', task: 'build',
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
    const backend = await factories.codegen_core!({ project_slug: 'owner-handle' } as never) as {
      orchestrator: { cancel(input: { task_id: string }): Promise<UnifiedCancelResult> }
    }

    const result = await backend.orchestrator.cancel({ task_id: run.id.slice(0, 8) })

    expect(result).toMatchObject({ cancelled: true, dispatch_path: 'trident', phase: 'stopped' })
    expect(transitions).toEqual([run.id])
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })
})

describe('an ambiguous prefix is a bad ARGUMENT, not an internal error', () => {
  test('two runs matching one prefix → CodegenInputError, not the store class', async () => {
    // `resolveReference` throws `TridentRunReferenceAmbiguousError`, which is
    // foreign to the Code-Gen tool surface: the MCP guard maps the Core's own
    // error types to structured tool failures and lets anything else escape as a
    // raw internal error. So the owner typing an ambiguous prefix got a
    // stack-shaped failure instead of being told to type more of the id.
    await trident.create({
      id: 'ambig-aaaa-1', slug: 'amb1', project_slug: 'p', repo_path: '/repo', task: 'one',
    })
    await trident.create({
      id: 'ambig-aaaa-2', slug: 'amb2', project_slug: 'p', repo_path: '/repo', task: 'two',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    await expect(router.cancel({ task_id: 'ambig-aaaa' })).rejects.toBeInstanceOf(CodegenInputError)
  })

  test('the message says what to DO about it, and names the prefix', async () => {
    await trident.create({
      id: 'dup-bbbb-1', slug: 'dup1', project_slug: 'p', repo_path: '/repo', task: 'one',
    })
    await trident.create({
      id: 'dup-bbbb-2', slug: 'dup2', project_slug: 'p', repo_path: '/repo', task: 'two',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    const err = await router.cancel({ task_id: 'dup-bbbb' }).catch((e: unknown) => e)
    expect(String((err as Error).message)).toContain('more of the id')
    expect(String((err as Error).message)).toContain('dup-bbbb')
  })

  test('an UNAMBIGUOUS prefix still resolves — the translation is not a blanket catch', async () => {
    // Guards against "fix" by swallowing: if the try/catch caught everything, or
    // the predicate matched too widely, a good prefix would fail too.
    const run = await trident.create({
      id: 'unique-cccc-1', slug: 'uniq', project_slug: 'p', repo_path: '/repo', task: 'one',
    })
    const router = routeCodegenCancel(legacy(), trident, 'p', bare())

    expect(await router.cancel({ task_id: 'unique-cccc' })).toMatchObject({
      cancelled: true, dispatch_path: 'trident', phase: 'stopped',
    })
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })
})
