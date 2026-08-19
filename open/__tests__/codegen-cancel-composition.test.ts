/**
 * `codegen_cancel` → Trident: the COMPOSITION path, which was the untested half.
 *
 * The review's remaining blocker on this branch was that the production observer
 * composition for a tool-initiated Trident cancel had no coverage — "both the
 * composer bind and the mountOpenCores path". The factory hop was already covered
 * behaviourally (`gateway/__tests__/codegen-cancel-router.test.ts`, the
 * "deleting production factory routing" case, which records the threaded
 * terminator being called). The two hops NOT covered were the ones on either side
 * of it:
 *
 *   composer's shim → mountOpenCores → buildCoresBackendFactories → routeCodegenCancel
 *                     ^^^^^^^^^^^^^^ untested pass-through
 *   ^^^^^^^^^^^^^^^^ untested bind
 *
 * WHY THE GAP MATTERED, precisely. `routeCodegenCancel` used to DEFAULT its
 * terminator to `buildTridentTerminator({ store: trident })` — a terminator with no
 * observer and no `onTransition`. So if either hop broke, a cancel still flipped the
 * phase and still returned `cancelled: true`, while the Work Board never reconciled,
 * the skill-forge hook never ran, and no `projects_changed` reached the rail. A
 * working-looking cancel with half its effects missing, and nothing red.
 *
 * That default is now GONE — the parameter is required — so a missing thread is a
 * typecheck failure rather than a silent degrade, and the one legitimate
 * no-observers caller fabricates it explicitly and logs
 * `codegen_cancel_terminator_unwired`. This file covers what remains: the
 * pass-through, behaviourally, and the composer's bind, at the strongest level a
 * test can reach it.
 *
 * The source assertions read `expect(SRC.includes(x)).toBe(true)` rather than
 * `expect(SRC).toContain(x)` DELIBERATELY: a failing `toContain` on a whole-file
 * string prints the entire file. Measured at 335 KB when one of these mutated red,
 * which buries the one line that matters.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { buildTridentTerminator, type TridentTerminator } from '@neutronai/trident/terminate.ts'
import { mountOpenCores } from '@neutronai/gateway/cores/mount-open-cores.ts'

const OWNER = asOwnerHandle('codegen-cancel-composition')
const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSER_SRC = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function bench(): { db: ProjectDb; owner_home: string; trident: TridentRunStore; mountArgs: Record<string, unknown> } {
  const owner_home = mkdtempSync(join(tmpdir(), 'codegen-cancel-comp-'))
  cleanups.push(() => rmSync(owner_home, { recursive: true, force: true }))
  const dbPath = join(owner_home, 'owner.db')
  seedMigratedDb(dbPath)
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  const secretsStore = new SecretsStore({ data_dir: owner_home, db })
  return {
    db,
    owner_home,
    trident: new TridentRunStore(db),
    mountArgs: {
      projectDb: db,
      owner_home,
      project_slug: OWNER,
      secretsStore,
      projectCredentialStore: new ProjectCredentialStore(db, { crypto: secretsStore }),
      projectAccountSelectionStore: new ProjectAccountSelectionStore(db),
      env: {},
      substrate: null,
    },
  }
}

describe('mountOpenCores threads the terminator through to the Code-Gen backend', () => {
  test('a cancel through the MOUNTED backend reaches the terminator the caller supplied', async () => {
    // THE PASS-THROUGH, behaviourally. `mountOpenCores` forwards
    // `tridentTerminator` into `buildCoresBackendFactories`; delete that forward
    // and the required parameter is satisfied by the factory's own fabricated
    // fallback, so the cancel still succeeds and only the OBSERVERS go missing.
    // The recorder is what distinguishes those two worlds.
    const { db, trident, mountArgs } = bench()
    const run = await trident.create({
      id: 'mounted-cancel-run',
      slug: 'mounted',
      project_slug: 'p',
      repo_path: '/repo',
      task: 'build',
    })
    const reached: string[] = []
    const mounted = await mountOpenCores({
      ...mountArgs,
      tridentTerminator: {
        terminate: async (id, phase, opts) => {
          reached.push(id)
          return buildTridentTerminator({ store: new TridentRunStore(db) }).terminate(id, phase, opts)
        },
      } satisfies TridentTerminator,
    } as never)
    cleanups.push(() => mounted.cleanup())

    const backend = (await mounted.backends['codegen_core']!({ project_slug: OWNER } as never)) as {
      orchestrator: { cancel(input: { task_id: string }): Promise<{ cancelled: boolean }> }
    }
    const result = await backend.orchestrator.cancel({ task_id: run.id })

    expect(result).toMatchObject({ cancelled: true })
    // The SUPPLIED terminator ran — not one the factory conjured for itself.
    expect(reached).toEqual([run.id])
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })

  test('with NO terminator threaded the backend still composes, and still cancels', async () => {
    // The graceful shape has to stay graceful: a boot that threads nothing (tests,
    // legacy) must not fail to install, and its cancel must still stop the run.
    // What it loses — the observers — is why the fallback is logged rather than
    // silent, and why the parameter is no longer defaulted inside the router.
    const { trident, mountArgs } = bench()
    const run = await trident.create({
      id: 'unwired-cancel-run',
      slug: 'unwired',
      project_slug: 'p',
      repo_path: '/repo',
      task: 'build',
    })
    const mounted = await mountOpenCores(mountArgs as never)
    cleanups.push(() => mounted.cleanup())

    const backend = (await mounted.backends['codegen_core']!({ project_slug: OWNER } as never)) as {
      orchestrator: { cancel(input: { task_id: string }): Promise<{ cancelled: boolean }> }
    }

    expect(await backend.orchestrator.cancel({ task_id: run.id })).toMatchObject({ cancelled: true })
    expect(trident.get(run.id)?.phase).toBe('stopped')
  })
})

describe('the composer binds a codegen terminator of its own', () => {
  // SOURCE-SCOPED, and labelled weaker on purpose — the honest-coverage precedent
  // (#128). The bind lives inside `buildOpenGraphComposer`'s body; reaching it
  // behaviourally means booting the whole composition AND installing the Code-Gen
  // Core so its MCP tool exists, which no test here does. The pass-through above
  // is the behavioural half; these three assertions cover the wiring the closure
  // can only be read for.
  test('the holder is a SEPARATE seam from the board terminator', () => {
    // One holder for two consumers would mean the board's DELETE path and the
    // tool's cancel path could never carry different observer chains.
    expect(COMPOSER_SRC.includes("late<TridentTerminator>('codegen_terminator')")).toBe(true)
    expect(COMPOSER_SRC.includes("late<TridentTerminator>('board_terminator')")).toBe(true)
  })

  test('it is BOUND, not merely declared', () => {
    // The persona-gen shape: declared, threaded, never bound. An unbound holder
    // makes the shim throw on every cancel.
    expect(COMPOSER_SRC.includes('codegenTerminatorHolder.bind(')).toBe(true)
  })

  test('the unbound error names THIS holder, not its sibling', () => {
    // It said "board terminator is not bound" — the sibling's name — which sends a
    // reader to the wrong bind. A one-word defect, and the kind that costs an hour
    // at 3am.
    expect(COMPOSER_SRC.includes("throw new Error('codegen terminator is not bound')")).toBe(true)
    expect(COMPOSER_SRC.includes("throw new Error('board terminator is not bound')")).toBe(false)
  })
})
